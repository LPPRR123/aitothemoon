import type { StepCheck } from "./checks.js";

/**
 * Deterministic matching of owner instructions against learned strategies. No model calls:
 * this is the part that answers the common cases cheaply and instantly.
 */

export type ParamType = "number" | "coord" | "player" | "word";

export interface ParamSpec {
  name: string;
  type: ParamType;
  /** For "word" params: the words the owner may say, and the value used in tool inputs. */
  values: Array<{ word: string; value: string }>;
}

export interface StrategyStep {
  tool: string;
  /** Tool input. A string "{name}" is replaced by the param value; "{owner}" by the owner name. */
  input: Record<string, unknown>;
  /** Environment recorded around this step when it was learned (see checks.ts). */
  check?: StepCheck;
}

const PREFIXES = /^(请你?|麻烦你?|帮我|帮忙|你能不能|能不能|可以|你)+/;
const SUFFIXES = /(吧|一下|呗|啊|呀|哦|嘛|好吗|好不好|谢谢)+$/;

/** Normalize an instruction (or a trigger) so small wording differences don't matter. */
export function normalizeInstruction(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[，。！？、!?~～…,.;；:：“”"'‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(PREFIXES, "").replace(SUFFIXES, "").trim();
    if (t === before) break;
  }
  return t;
}

const DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Parse "12", "十二", "二十", "两", "一百零五" into a number. */
export function parseNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^[零一二两三四五六七八九十百]+$/.test(text)) return null;
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = DIGITS[ch] ?? 0;
    }
  }
  return total + current;
}

const GROUP: Record<ParamType, string> = {
  number: "(\\d+|[零一二两三四五六七八九十百]+)",
  coord: "(-?\\d+(?:\\.\\d+)?)",
  player: "([a-z0-9_]{1,16})",
  word: "(.+?)",
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompiledTrigger {
  regex: RegExp;
  params: string[];
  /** Number of literal characters; more literal text = more specific trigger. */
  literalLength: number;
}

/** Turn "砍{count}个{block}" into an anchored regex with one group per param. */
export function compileTrigger(trigger: string, specs: ParamSpec[]): CompiledTrigger {
  const byName = new Map(specs.map((p) => [p.name, p]));
  const norm = normalizeInstruction(trigger.replace(/\{(\w+)\}/g, " \u0000$1\u0000 "));
  const parts = norm.split(/\u0000/);
  let source = "^";
  const params: string[] = [];
  let literalLength = 0;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const spec = byName.get(part);
      if (!spec) throw new Error(`触发语里的参数 {${part}} 没有定义`);
      params.push(part);
      source += `\\s*${GROUP[spec.type]}\\s*`;
    } else {
      const lit = part.trim();
      literalLength += lit.replace(/\s/g, "").length;
      source += lit
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegex)
        .join("\\s*");
    }
  });
  source += "$";
  return { regex: new RegExp(source), params, literalLength };
}

export type ParamValues = Record<string, { value: string | number; said: string }>;

/** Try one trigger. Returns param values, or null if it doesn't match or a word is unknown. */
export function matchTrigger(instruction: string, trigger: string, specs: ParamSpec[]): ParamValues | null {
  const compiled = compileTrigger(trigger, specs);
  const m = compiled.regex.exec(normalizeInstruction(instruction));
  if (!m) return null;
  const out: ParamValues = {};
  for (let i = 0; i < compiled.params.length; i++) {
    const name = compiled.params[i]!;
    const spec = specs.find((s) => s.name === name)!;
    const raw = (m[i + 1] ?? "").trim();
    if (spec.type === "number") {
      const n = parseNumber(raw);
      if (n === null || n <= 0 || n > 64) return null;
      out[name] = { value: n, said: raw };
    } else if (spec.type === "coord") {
      out[name] = { value: Number(raw), said: raw };
    } else if (spec.type === "player") {
      out[name] = { value: raw, said: raw };
    } else {
      // Closed vocabulary: an unknown word means "new situation", so the model handles it.
      const hit = spec.values.find((v) => normalizeInstruction(v.word) === raw);
      if (!hit) return null;
      out[name] = { value: hit.value, said: raw };
    }
  }
  return out;
}

/** Fill "{name}" placeholders in tool inputs. A string that is exactly "{name}" keeps the value's type. */
export function instantiate(input: unknown, values: ParamValues, owner: string): unknown {
  if (typeof input === "string") {
    const exact = /^\{(\w+)\}$/.exec(input);
    if (exact) {
      if (exact[1] === "owner") return owner;
      const v = values[exact[1]!];
      if (v) return v.value;
    }
    return input.replace(/\{(\w+)\}/g, (all, name: string) =>
      name === "owner" ? owner : values[name] ? String(values[name]!.value) : all,
    );
  }
  if (Array.isArray(input)) return input.map((x) => instantiate(x, values, owner));
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, instantiate(v, values, owner)]));
  }
  return input;
}

/** Fill a reply template. Params show what the owner said ("原木"), not the internal ID. */
export function fillReply(template: string, values: ParamValues, owner: string, result: string): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => {
    if (name === "owner") return owner;
    if (name === "result") return result;
    return values[name]?.said ?? all;
  });
}
