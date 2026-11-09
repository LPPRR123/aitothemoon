import { ACTIONS, precheckAction, runAction, toolInputSchema, type ActionContext } from "../actions/index.js";
import { stopEverything } from "../actions/movement.js";
import type { BotManager } from "../bot/BotManager.js";
import type { ChatLine, IncomingChat } from "../bot/chat.js";
import { inventoryCounts, observe, windowTitle } from "../bot/perception.js";
import { waitFor } from "../actions/util.js";
import { describeWindowTitle, gainedItems, sameWindow, TELEPORT_DISTANCE } from "../strategy/checks.js";
import type { Config } from "../config.js";
import { createLogger } from "../logger.js";
import { describeApiError, type LlmClient, type MessageParam, type Tool, type ToolResultBlock, type ToolUseBlock } from "./llm.js";
import { buildInterjection, buildSystemPrompt, buildTaskPrompt } from "./prompts.js";
import { compileStrategy, READ_ONLY_TOOLS, reviewStrategy, type TraceEntry } from "../strategy/compiler.js";
import type { StrategyLibrary, StrategyMatch } from "../strategy/library.js";
import { fillReply, instantiate } from "../strategy/matcher.js";

const log = createLogger("agent");

interface Task {
  owner: string;
  whisper: boolean;
  /** Aborts the whole task (stop word, disconnect). */
  abort: AbortController;
  /** Aborts only the tool that is running right now (owner sent a new message). */
  toolAbort: AbortController | null;
  /** Owner messages that arrived while the task was running, not yet shown to the model. */
  pending: string[];
  /** Everything the owner said during this task. */
  ownerMessages: string[];
  /** Tool calls the model made, for learning a strategy afterwards. */
  trace: TraceEntry[];
  /** The owner changed the request midway; such a task is not learned. */
  interrupted: boolean;
}

export function isOwner(config: Config, username: string): boolean {
  const u = username.toLowerCase();
  return config.owner.names.some((n) => n.toLowerCase() === u);
}

function botNames(config: Config): string[] {
  return [config.bot.username, ...config.bot.aliases].filter(Boolean);
}

/** Is a public message addressed to the bot? Returns the message without the name, or null. */
export function addressedText(config: Config, message: string): string | null {
  const lower = message.toLowerCase();
  for (const name of botNames(config)) {
    const n = name.toLowerCase();
    const idx = lower.indexOf(n);
    if (idx < 0) continue;
    const stripped = (message.slice(0, idx) + message.slice(idx + n.length))
      .replace(/^[\s@,，:：、!！]+/, "")
      .replace(/[\s,，]+$/, "")
      .trim();
    return stripped || message;
  }
  return null;
}

export function isStopWord(config: Config, text: string): boolean {
  const t = text.trim().replace(/[!！。.~～]+$/, "").toLowerCase();
  return config.agent.stopWords.some((w) => w.toLowerCase() === t);
}

export function formatChatLines(lines: ChatLine[], config: Config): string {
  return lines
    .map((l) => {
      if (l.kind === "self") return `[我] ${l.text}`;
      if (l.kind === "server") return `[服务器] ${l.text}`;
      const who = l.username ?? "?";
      const role = isOwner(config, who) ? "主人" : "玩家";
      return `[${l.kind === "whisper" ? "私聊" : ""}${role} ${who}] ${l.text}`;
    })
    .join("\n");
}

/** Clean model text for in-game chat: no Markdown, single line, bounded length. */
export function toChatText(text: string, max = 200): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*|__|`/g, "") // bold/code markers; single "_" is kept (item IDs like oak_log)
    .replace(/^\s*(#+|>|[-•*])\s+/gm, "") // headings, quotes, list bullets
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Listens to the owner, runs one task at a time with Claude + tools, and reports back.
 * Each instruction starts a fresh conversation (append-only within the task), so history
 * never needs to be edited and the stable tools + system prompt prefix stays cached.
 */
export class Agent {
  private task: Task | null = null;
  private readonly tools: Tool[];
  private readonly system: string;
  /** Last learned strategy that ran, so "不对" right after it can switch it off. */
  private lastStrategyRun: { id: number; at: number } | null = null;

  constructor(
    private readonly manager: BotManager,
    private readonly config: Config,
    private readonly llm: LlmClient,
    private readonly strategies: StrategyLibrary | null = null,
  ) {
    this.system = buildSystemPrompt(config);
    this.tools = ACTIONS.map((a) => ({
      name: a.name,
      description: a.description,
      input_schema: toolInputSchema(a),
    }));
  }

  get busy(): boolean {
    return this.task !== null;
  }

  attach(): void {
    this.manager.chat.on("message", (m) => this.onMessage(m));
    this.manager.on("disconnected", () => this.cancel("连接断开"));
  }

  cancel(reason: string): void {
    if (!this.task) return;
    log.info(`取消当前任务：${reason}`);
    this.task.abort.abort();
  }

  /** Send a reply to the owner the same way they talked to us. */
  reply(owner: string, whisper: boolean, text: string): void {
    const msg = toChatText(text);
    if (!msg) return;
    log.info(`回复 ${owner}：${msg}`);
    this.manager.sender.say(whisper ? `/msg ${owner} ${msg}` : msg);
  }

  onMessage(m: IncomingChat): void {
    if (!isOwner(this.config, m.username) || !this.manager.ready) return;
    const text = m.whisper || this.config.agent.publicTrigger === "all" ? m.message : addressedText(this.config, m.message);
    if (text === null) return;

    if (isStopWord(this.config, text)) {
      this.cancel("主人说停");
      const bot = this.manager.bot;
      if (bot) stopEverything(bot);
      this.reply(m.username, m.whisper, "好的，停下了");
      return;
    }

    if (this.handleOwnerCommand(m.username, m.whisper, text)) return;

    if (this.task) {
      // Deliver it to the running task and interrupt the current action so the model can react.
      this.task.pending.push(text);
      this.task.ownerMessages.push(text);
      this.task.toolAbort?.abort();
      return;
    }
    void this.runTask(m.username, m.whisper, text);
  }

  async runTask(owner: string, whisper: boolean, message: string): Promise<void> {
    const task: Task = {
      owner,
      whisper,
      abort: new AbortController(),
      toolAbort: null,
      pending: [],
      ownerMessages: [message],
      trace: [],
      interrupted: false,
    };
    this.task = task;
    log.info(`新任务（${owner}）：${message}`);
    try {
      await this.handle(task, message);
    } catch (err) {
      if (!task.abort.signal.aborted) {
        log.error("任务出错", err);
        this.reply(owner, whisper, `出错了：${describeApiError(err)}`);
      }
    } finally {
      this.task = null;
    }
    // Messages that arrived after the last step start a new task.
    if (task.pending.length && !task.abort.signal.aborted) {
      void this.runTask(owner, whisper, task.pending.join(" "));
    }
  }

  /**
   * The hybrid decision: a learned strategy first (no model call); the model only for new
   * situations, or when a learned strategy fails; then learn from what the model did.
   */
  private async handle(task: Task, message: string): Promise<void> {
    let note: string | undefined;
    const hit = this.strategies?.match(message) ?? null;
    if (hit) {
      const outcome = await this.runStrategy(task, hit);
      if (outcome.ok) {
        this.reply(task.owner, task.whisper, outcome.reply);
        return;
      }
      if (task.abort.signal.aborted || outcome.interrupted) return;
      note = outcome.started
        ? `我先按以前学会的做法「${hit.strategy.name}」去做，但第 ${outcome.step} 步 ${outcome.tool} 出了问题：${outcome.error}。这次情况不一样，请你接手，完成主人的要求（注意前面的步骤已经做过了）。`
        : `我本来想按学过的做法「${hit.strategy.name}」去做，但开始前发现环境和学的时候不一样：${outcome.error}。请你根据现在的情况完成主人的要求。`;
    }

    this.strategies?.recordLlmTask();
    const botAtStart = this.manager.bot;
    const before = botAtStart ? inventoryCounts(botAtStart) : null;
    const final = await this.loop(task, message, note);
    if (!final || task.abort.signal.aborted) return;
    this.reply(task.owner, task.whisper, final);
    const gained = before && this.manager.bot === botAtStart ? gainedItems(before, inventoryCounts(botAtStart!)) : [];
    if (!task.interrupted) void this.learn(task, message, final, gained);
  }

  /**
   * Replay a learned strategy with environment checks. A mismatch before the first step means
   * "this is a different situation" (no penalty, the model takes over); a mismatch or failure
   * later counts against the strategy.
   */
  private async runStrategy(
    task: Task,
    hit: StrategyMatch,
  ): Promise<
    | { ok: true; reply: string }
    | { ok: false; interrupted: boolean; started: boolean; step: number; tool: string; error: string }
  > {
    const { strategy, values } = hit;
    log.info(`使用学过的策略 #${strategy.id}「${strategy.name}」（不调用 AI）`);
    const bot = this.manager.bot;
    const before = bot ? inventoryCounts(bot) : new Map<string, number>();
    let last = "";
    let started = false;
    const fail = (step: number, tool: string, error: string, penalize: boolean) => {
      if (penalize) this.strategies!.recordResult(strategy.id, false);
      const b = this.manager.bot;
      if (b?.currentWindow) b.closeWindow(b.currentWindow); // don't leave a stray menu open for the model
      log.info(`策略 #${strategy.id} 第 ${step} 步没有通过：${error}${penalize ? "" : "（环境不同，不算失败）"}`);
      return { ok: false as const, interrupted: false, started, step, tool, error };
    };

    for (let i = 0; i < strategy.steps.length; i++) {
      const step = strategy.steps[i]!;
      const current = this.manager.bot;
      if (!current) return { ok: false, interrupted: true, started, step: i + 1, tool: step.tool, error: "掉线了" };
      if (step.check?.preWindow !== undefined && !sameWindow(step.check.preWindow, windowTitle(current))) {
        const msg = `这一步应该在${describeWindowTitle(step.check.preWindow)}里做，现在是${describeWindowTitle(windowTitle(current))}`;
        return fail(i + 1, step.tool, msg, started);
      }
      if (step.check?.preDimension && step.check.preDimension !== String(current.game.dimension)) {
        const msg = `这一步是在 ${step.check.preDimension} 学的，现在在 ${current.game.dimension}`;
        return fail(i + 1, step.tool, msg, started);
      }
      const input = instantiate(step.input, values, task.owner);
      const blocked = precheckAction(this.actionContext(task, task.abort.signal), step.tool, input);
      if (blocked) return fail(i + 1, step.tool, blocked, started);
      const r = await this.executeStep(task, step.tool, input, false);
      if (task.abort.signal.aborted || r.interrupted) {
        return { ok: false, interrupted: true, started, step: i + 1, tool: step.tool, error: "被打断" };
      }
      if (!READ_ONLY_TOOLS.has(step.tool)) started = true;
      if (!r.ok) return fail(i + 1, step.tool, r.text.split("\n")[0] ?? "", true);
      if (step.check?.postWindow !== undefined && !sameWindow(step.check.postWindow, windowTitle(current))) {
        const msg = `做完这一步应该是${describeWindowTitle(step.check.postWindow)}，实际是${describeWindowTitle(windowTitle(current))}`;
        return fail(i + 1, step.tool, msg, true);
      }
      if (step.check?.postMoved && !r.moved) {
        return fail(i + 1, step.tool, `学的时候这一步会传送，这次没有传送（${r.text.split("\n").slice(-1)[0]?.slice(0, 60) ?? ""}）`, true);
      }
      last = r.text;
    }

    // Effect check: at least one of the items gained when this was learned must go up again.
    const expected = (strategy.expect?.gained ?? []).map((g) => String(instantiate(g, values, task.owner)));
    if (expected.length && this.manager.bot) {
      const b = this.manager.bot;
      const got = await waitFor(() => expected.some((item) => (inventoryCounts(b).get(item) ?? 0) > (before.get(item) ?? 0)), 2_500);
      if (!got) return fail(strategy.steps.length, "（结果检查）", `做完了，但背包里没有多出 ${expected.join("/")}`, true);
    }

    this.strategies!.recordResult(strategy.id, true);
    this.lastStrategyRun = { id: strategy.id, at: Date.now() };
    const result = (last.split("\n")[0] ?? "").slice(0, 80);
    return { ok: true, reply: fillReply(strategy.reply, values, task.owner, result) };
  }

  /** After the model solved something new: compile it into a strategy, review it, save it. */
  private async learn(task: Task, instruction: string, reply: string, gained: string[]): Promise<void> {
    if (!this.strategies || !this.config.strategy.learn) return;
    if (!task.trace.some((t) => t.ok && !READ_ONLY_TOOLS.has(t.tool))) return;
    try {
      const compiled = await compileStrategy(
        this.llm,
        this.config,
        { instruction, trace: task.trace, reply },
        AbortSignal.timeout(120_000),
      );
      if (!compiled) return;
      const review = reviewStrategy(compiled, { instruction, owner: task.owner, trace: task.trace, gained }, this.config);
      if (!review.ok) {
        log.info(`这次没有学成策略：${review.reason}`);
        return;
      }
      const { strategy, merged } = this.strategies.add(review.candidate);
      log.info(`${merged ? "并入" : "学会"}策略 #${strategy.id}「${strategy.name}」（${strategy.status}）`);
      if (merged) return;
      if (strategy.status === "pending") {
        this.reply(task.owner, task.whisper, `我学会了「${strategy.name}」，但它有需要你确认的操作，说"批准 ${strategy.id}"后我才会自动用`);
      } else {
        this.reply(task.owner, task.whisper, `记住了「${strategy.name}」的做法，下次不用再想`);
      }
    } catch (err) {
      log.warn("学习策略失败", err);
    }
  }

  /** Strategy management in chat. Deterministic, no model call. Returns true if handled. */
  private handleOwnerCommand(owner: string, whisper: boolean, text: string): boolean {
    const lib = this.strategies;
    if (!lib) return false;
    const t = text.trim();
    const say = (msg: string) => this.reply(owner, whisper, msg);

    if (/^(你)?(都)?学会了(什么|哪些|啥)$|^策略(列表)?$/.test(t)) {
      const list = lib.all.filter((s) => s.status !== "disabled");
      if (!list.length) return say("我还没学会固定的做法"), true;
      const label: Record<string, string> = { active: "", probation: "，试用中", pending: "，等你批准" };
      const items = list.slice(0, 8).map((s) => `#${s.id} ${s.name}（用过${s.stats.uses}次${label[s.status] ?? ""}）`);
      say(`我学会了 ${list.length} 个做法：${items.join(" ")}`);
      return true;
    }
    let m = /^(忘掉|忘记|删掉)(策略)?\s*#?(\d+)$/.exec(t);
    if (m) {
      const id = Number(m[3]);
      say(lib.disable(id, "主人要求忘掉") ? `好的，忘掉了 #${id}` : `没有可用的 #${id}`);
      return true;
    }
    m = /^批准(策略)?\s*#?(\d+)$/.exec(t);
    if (m) {
      const id = Number(m[2]);
      say(lib.approve(id) ? `好的，#${id} 以后可以自动用了` : `#${id} 不需要批准或者不存在`);
      return true;
    }
    if (/^(不对|错了|做错了|不是这样)$/.test(t) && this.lastStrategyRun && Date.now() - this.lastStrategyRun.at < 120_000) {
      const s = lib.get(this.lastStrategyRun.id);
      lib.disable(this.lastStrategyRun.id, "主人说做错了");
      this.lastStrategyRun = null;
      say(`好的，我把「${s?.name ?? "刚才"}」这个做法忘掉了，下次重新想`);
      return true;
    }
    if (/^(学习)?统计$/.test(t)) {
      const x = lib.totals;
      const direct = x.strategyRuns - x.strategyFailures;
      const total = direct + x.llmTasks;
      const pct = total ? Math.round((direct / total) * 100) : 0;
      say(`学会 ${lib.usable().length} 个做法；直接按学过的做法完成 ${direct} 次，调用 AI ${x.llmTasks} 次（不用 AI 的比例 ${pct}%）`);
      return true;
    }
    return false;
  }

  private async loop(task: Task, message: string, note?: string): Promise<string> {
    const bot = this.manager.bot;
    if (!bot) return "我还没连上服务器";
    const recent = this.manager.chat.history.slice(-this.config.agent.recentChatLines);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: buildTaskPrompt({
          owner: task.owner,
          message,
          whisper: task.whisper,
          recentChat: formatChatLines(recent, this.config),
          observation: observe(bot),
          note,
        }),
      },
    ];

    for (let turn = 0; turn < this.config.llm.maxTurnsPerTask; turn++) {
      const response = await this.llm.create(
        {
          model: this.config.llm.model,
          max_tokens: this.config.llm.maxTokens,
          system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
          tools: this.tools,
          messages,
          output_config: { effort: this.config.llm.effort },
          cache_control: { type: "ephemeral" },
        },
        task.abort.signal,
      );
      log.debug(
        `第 ${turn + 1} 轮 stop=${response.stop_reason} 输入=${response.usage.input_tokens} 缓存读=${response.usage.cache_read_input_tokens ?? 0}`,
      );

      if (response.stop_reason === "refusal") return "这个请求我没法处理";
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        return response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join(" ");
      }

      const results: ToolResultBlock[] = [];
      for (const use of toolUses) {
        const r = await this.executeStep(task, use.name, use.input, true);
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.text, is_error: !r.ok });
      }
      const content: Array<ToolResultBlock | { type: "text"; text: string }> = [...results];
      if (task.pending.length) {
        task.interrupted = true;
        content.push({ type: "text", text: buildInterjection(task.owner, task.pending.splice(0)) });
      }
      messages.push({ role: "user", content });
    }
    return "这件事步骤太多了，我先停下，你可以换个说法再告诉我";
  }

  private actionContext(task: Task, signal: AbortSignal): ActionContext {
    return {
      bot: this.manager.bot!,
      config: this.config,
      signal,
      sender: this.manager.sender,
      chat: this.manager.chat,
      owner: task.owner,
      ownerMessages: task.ownerMessages,
      log,
    };
  }

  /** Run one tool for the current task. `record` adds it to the trace the strategy learner reads. */
  private async executeStep(
    task: Task,
    tool: string,
    input: unknown,
    record: boolean,
  ): Promise<{ ok: boolean; text: string; interrupted: boolean; moved: boolean }> {
    const bot = this.manager.bot;
    if (task.abort.signal.aborted || !bot) return { ok: false, text: "任务已取消，没有执行", interrupted: true, moved: false };
    const toolAbort = new AbortController();
    task.toolAbort = toolAbort;
    const signal = AbortSignal.any([task.abort.signal, toolAbort.signal]);
    log.info(`调用 ${tool} ${JSON.stringify(input)}`);
    const preWindow = windowTitle(bot);
    const preDimension = String(bot.game.dimension);
    const prePos = bot.entity.position.clone();
    const preHeld = bot.heldItem?.name ?? null;
    // Teleports arrive as a server-forced position update; walking never triggers one.
    let forced = 0;
    const onForced = () => {
      forced++;
    };
    bot.on("forcedMove", onForced);
    const result = await runAction(this.actionContext(task, signal), tool, input);
    task.toolAbort = null;
    bot.off("forcedMove", onForced);
    const dimensionChanged = String(bot.game.dimension) !== preDimension;
    const moved = dimensionChanged || (forced > 0 && bot.entity.position.distanceTo(prePos) > TELEPORT_DISTANCE);
    const interrupted = toolAbort.signal.aborted && !task.abort.signal.aborted;
    let text = result.text;
    if (interrupted) {
      stopEverything(bot);
      task.interrupted = true;
      text = `这个动作被主人的新消息打断了（${result.text}）`;
    }
    if (record) {
      task.trace.push({
        tool,
        input: (input ?? {}) as Record<string, unknown>,
        ok: result.ok && !interrupted,
        text,
        meta: result.meta,
        preWindow,
        postWindow: windowTitle(bot),
        preDimension,
        moved,
        preHeld,
      });
    }
    log.info(`结果 ${tool}：${text.split("\n")[0]}`);
    return { ok: result.ok && !interrupted, text, interrupted, moved };
  }
}
