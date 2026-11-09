import { z } from "zod";
import { getAction } from "../actions/index.js";
import type { RiskLevel } from "../actions/types.js";
import { normalizeName } from "../bot/text.js";
import type { LlmClient } from "../brain/llm.js";
import type { Config } from "../config.js";
import { checkCommand } from "../safety/commands.js";
import { DIMENSION_TOOLS, POST_WINDOW_TOOLS, PRE_WINDOW_TOOLS, TELEPORT_TOOLS, type StepCheck } from "./checks.js";
import type { Strategy } from "./library.js";
import { compileTrigger, instantiate, matchTrigger, type ParamSpec, type StrategyStep } from "./matcher.js";

/** One tool call the model made while solving a task. */
export interface TraceEntry {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  text: string;
  meta?: Record<string, unknown>;
  /** Title of the open window right before / after this call (null = none open). Recorded by code. */
  preWindow?: string | null;
  postWindow?: string | null;
  /** Dimension before the call, whether the call teleported the bot, and what it was holding. */
  preDimension?: string;
  moved?: boolean;
  preHeld?: string | null;
}

/**
 * Tools a strategy never replays: ones that only look at things, and memory tools (replaying a
 * fixed "remember X" makes no sense). A task made only of these is not worth learning.
 */
export const READ_ONLY_TOOLS = new Set([
  "get_status", "read_window", "list_server_commands",
  "remember", "recall", "forget", "doubt",
]);

const CompiledSchema = z.strictObject({
  reusable: z.boolean(),
  reason: z.string(),
  name: z.string(),
  triggers: z.array(z.string()),
  params: z.array(
    z.strictObject({
      name: z.string(),
      type: z.enum(["number", "coord", "player", "word"]),
      values: z.array(z.strictObject({ word: z.string(), value: z.string() })),
    }),
  ),
  steps: z.array(z.strictObject({ tool: z.string(), input_json: z.string() })),
  reply: z.string(),
});
export type CompiledStrategy = z.infer<typeof CompiledSchema>;

function outputSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(CompiledSchema) as Record<string, unknown>;
  return schema;
}

const COMPILER_SYSTEM = `你负责把 Minecraft 助手刚刚成功完成的一次任务，整理成一条以后可以直接重复执行的"策略"，这样同类请求就不用再调用 AI。

判断 reusable：
- 只有"主人以后很可能再这样说、而且做法固定"的请求才可复用，例如砍几个木头、合成某物、打开某个菜单买东西、去某个地方。
- 闲聊、问问题、需要根据当时情况回答的请求（例如"你背包里有什么""现在几点"）不可复用，reusable=false 并写明 reason。

如果可复用：
- name：一句很短的中文名字，例如"砍原木"。
- triggers：3 到 6 种主人可能的中文说法，用 {参数名} 表示会变化的部分。不要包含机器人的名字，不要加"帮我""请"之类的客套词（系统会自动忽略）。每种说法都必须有至少两个固定的字。
- params：只把主人原话里出现、而且下次会变的东西做成参数。type 只能是 number（数量）、coord（坐标数字）、player（玩家名）、word（物品/方块/地点等词）。word 参数必须在 values 里列出主人可能说的词和对应的工具参数值（例如 木头→oak_log、原木→oak_log、橡木→oak_log），只列你确定正确的。number/coord/player 的 values 为空数组。
- steps：按顺序列出这次实际成功执行过的工具调用（失败的不要），只读的 get_status/read_window/list_server_commands 可以省略。input_json 是工具参数的 JSON 字符串，会变化的值写成 "{参数名}"，主人的名字写成 "{owner}"。
- 点菜单时用 click_slot 的 name 参数（按钮上显示的文字，例如 {"name":"商店"}），不要用格子编号，这样菜单换了位置也能用。
- reply：完成后对主人说的一句短话，可以用 {参数名} 和 {result}（最后一步结果的第一行）。`;

function buildCompilerPrompt(instruction: string, trace: TraceEntry[], reply: string): string {
  const lines = trace.map((t, i) => {
    const result = t.text.split("\n").slice(0, 4).join(" / ").slice(0, 300);
    return `${i + 1}. ${t.tool} ${JSON.stringify(t.input)} → ${t.ok ? "成功" : "失败"}：${result}`;
  });
  return `主人的原话：${instruction}\n\n执行过的工具调用：\n${lines.join("\n")}\n\n最后对主人说的话：${reply}`;
}

/** Ask the model once to turn a solved task into a reusable strategy. */
export async function compileStrategy(
  llm: LlmClient,
  config: Config,
  input: { instruction: string; trace: TraceEntry[]; reply: string },
  signal: AbortSignal,
): Promise<CompiledStrategy | null> {
  const response = await llm.create(
    {
      model: config.llm.model,
      max_tokens: 4_000,
      system: COMPILER_SYSTEM,
      messages: [{ role: "user", content: buildCompilerPrompt(input.instruction, input.trace, input.reply) }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: outputSchema() } },
    },
    signal,
  );
  if (response.stop_reason === "refusal") return null;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  return CompiledSchema.parse(JSON.parse(text));
}

export type ReviewResult =
  | { ok: true; candidate: Omit<Strategy, "id" | "stats" | "status"> & { status: "pending" | "probation" } }
  | { ok: false; reason: string };

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Normalize a tool input through the tool's schema so defaults don't make equal inputs differ. */
function canonical(tool: string, input: unknown): string | null {
  const action = getAction(tool);
  if (!action) return null;
  const parsed = action.schema.safeParse(input);
  return parsed.success ? JSON.stringify(parsed.data, Object.keys(parsed.data as object).sort()) : null;
}

function sameStep(step: StrategyStep, done: TraceEntry): boolean {
  if (step.tool !== done.tool) return false;
  // A menu click learned by button text matches the click that was made by slot number.
  if (step.tool === "click_slot" && typeof step.input.name === "string") {
    const clicked = typeof done.meta?.clickedName === "string" ? done.meta.clickedName : "";
    const button = (x: Record<string, unknown>) => `${x.button ?? "left"}|${x.shift ?? false}`;
    return (
      clicked !== "" &&
      normalizeName(clicked).includes(normalizeName(step.input.name)) &&
      button(step.input) === button(done.input)
    );
  }
  if (step.tool === "use_held_item" && typeof step.input.item === "string" && !done.input.item) {
    return done.preHeld === step.input.item;
  }
  return canonical(step.tool, step.input) === canonical(done.tool, done.input);
}

/**
 * Deterministic review of a compiled strategy. Nothing here trusts the model: the strategy
 * must replay the exact successful steps for the original instruction, use only known tools,
 * pass the command policy, and is held for the owner's approval if it uses a high-risk tool.
 */
export function reviewStrategy(
  compiled: CompiledStrategy,
  input: { instruction: string; owner: string; trace: TraceEntry[]; gained?: string[] },
  config: Config,
): ReviewResult {
  if (!compiled.reusable) return { ok: false, reason: `不可复用：${compiled.reason}` };
  if (!compiled.name.trim()) return { ok: false, reason: "没有名字" };
  if (compiled.triggers.length < 1 || compiled.triggers.length > 8) return { ok: false, reason: "触发说法数量不对" };
  if (compiled.steps.length < 1 || compiled.steps.length > 20) return { ok: false, reason: "步骤数量不对" };

  const names = new Set<string>();
  for (const p of compiled.params) {
    if (!/^\w+$/.test(p.name) || p.name === "owner" || p.name === "result") return { ok: false, reason: `参数名不合法：${p.name}` };
    if (names.has(p.name)) return { ok: false, reason: `参数重复：${p.name}` };
    names.add(p.name);
    if (p.type === "word" && p.values.length === 0) return { ok: false, reason: `词语参数 ${p.name} 没有列出可选的词` };
  }
  const params = compiled.params as ParamSpec[];
  for (const t of compiled.triggers) {
    try {
      if (compileTrigger(t, params).literalLength < 2) return { ok: false, reason: `触发说法太宽泛：${t}` };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  const steps: StrategyStep[] = [];
  for (const s of compiled.steps.filter((x) => !["remember", "recall", "forget", "doubt"].includes(x.tool))) {
    if (!getAction(s.tool)) return { ok: false, reason: `没有这个工具：${s.tool}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.input_json);
    } catch {
      return { ok: false, reason: `步骤参数不是合法 JSON：${s.input_json}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "步骤参数必须是对象" };
    steps.push({ tool: s.tool, input: parsed as Record<string, unknown> });
  }
  const acting = steps.filter((s) => !READ_ONLY_TOOLS.has(s.tool));
  if (acting.length === 0) return { ok: false, reason: "只有查看类的步骤，不值得学" };

  // Replay check: the strategy, applied to the original words, must give exactly the steps that worked.
  const values = compiled.triggers
    .map((t) => matchTrigger(input.instruction, t, params))
    .find((v) => v !== null);
  if (!values) return { ok: false, reason: "任何一种触发说法都匹配不到主人的原话" };
  const replay = acting.map((s) => ({ tool: s.tool, input: instantiate(s.input, values, input.owner) as Record<string, unknown> }));
  const done = input.trace.filter((t) => t.ok && !READ_ONLY_TOOLS.has(t.tool));
  if (replay.length !== done.length || !replay.every((s, i) => sameStep(s, done[i]!))) {
    return { ok: false, reason: "按这条策略重放，得到的步骤和这次实际成功的步骤不一致" };
  }
  for (const s of replay) {
    const action = getAction(s.tool)!;
    if (!action.schema.safeParse(s.input).success) return { ok: false, reason: `步骤 ${s.tool} 的参数不符合要求` };
    if (s.tool === "run_command") {
      const decision = checkCommand(String(s.input.command ?? ""), config.commands, [input.instruction]);
      if (!decision.ok) return { ok: false, reason: decision.reason };
    }
  }

  // Environment checks (muscle-mem style): copy what code observed around each successful step.
  acting.forEach((step, i) => {
    const seen = done[i]!;
    const check: StepCheck = {};
    if (PRE_WINDOW_TOOLS.has(step.tool) && seen.preWindow !== undefined) check.preWindow = seen.preWindow;
    if (POST_WINDOW_TOOLS.has(step.tool) && seen.postWindow !== undefined) check.postWindow = seen.postWindow;
    if (DIMENSION_TOOLS.has(step.tool) && seen.preDimension) check.preDimension = seen.preDimension;
    if (TELEPORT_TOOLS.has(step.tool) && seen.moved) check.postMoved = true;
    if (Object.keys(check).length) step.check = check;
    // Right-clicking "whatever is in hand" only works if the same thing is in hand: make the
    // strategy take it out first (like clicking menu buttons by name instead of slot number).
    if (step.tool === "use_held_item" && !step.input.item && seen.preHeld) step.input = { ...step.input, item: seen.preHeld };
  });
  // Expected effect: items that went up during the task. A value that came from a param becomes
  // "{param}", so "砍三个白桦木" later expects birch_log, not oak_log.
  const gained = [...new Set((input.gained ?? []).map((item) => {
    const p = Object.entries(values).find(([, v]) => String(v.value) === item);
    return p ? `{${p[0]}}` : item;
  }))];

  const risk = steps
    .map((s) => getAction(s.tool)!.risk)
    .reduce<RiskLevel>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), "low");
  return {
    ok: true,
    candidate: {
      name: compiled.name.trim(),
      triggers: compiled.triggers,
      params,
      steps,
      ...(gained.length ? { expect: { gained } } : {}),
      reply: compiled.reply || "好了",
      risk,
      status: risk === "high" ? "pending" : "probation",
      source: { instruction: input.instruction, owner: input.owner, reason: compiled.reason },
    },
  };
}
