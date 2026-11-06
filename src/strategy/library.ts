import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { matchTrigger, type ParamSpec, type ParamValues, type StrategyStep } from "./matcher.js";

const log = createLogger("strategy");

/**
 * Lifecycle:
 *   pending   – learned, but uses a high-risk tool: waits for the owner to approve it
 *   probation – learned and reviewed; used directly, becomes active after a few successes
 *   active    – trusted
 *   disabled  – failed too often, or the owner said it was wrong; kept for the record
 */
export type StrategyStatus = "pending" | "probation" | "active" | "disabled";

const ParamSchema = z.object({
  name: z.string(),
  type: z.enum(["number", "coord", "player", "word"]),
  values: z.array(z.object({ word: z.string(), value: z.string() })).default([]),
});

export const StrategySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  triggers: z.array(z.string()).min(1),
  params: z.array(ParamSchema).default([]),
  steps: z.array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) })).min(1),
  reply: z.string().default("好了"),
  risk: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "probation", "active", "disabled"]),
  stats: z.object({
    uses: z.number().int().default(0),
    successes: z.number().int().default(0),
    failures: z.number().int().default(0),
    lastUsed: z.number().nullable().default(null),
    createdAt: z.number(),
  }),
  source: z.object({ instruction: z.string(), owner: z.string(), reason: z.string().default("") }),
  disabledReason: z.string().optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

const FileSchema = z.object({
  version: z.literal(1),
  nextId: z.number().int(),
  strategies: z.array(StrategySchema),
  totals: z
    .object({
      strategyRuns: z.number().int().default(0),
      strategyFailures: z.number().int().default(0),
      llmTasks: z.number().int().default(0),
      learned: z.number().int().default(0),
    })
    .prefault({}),
});
type FileData = z.infer<typeof FileSchema>;

export interface StrategyMatch {
  strategy: Strategy;
  values: ParamValues;
}

export interface LibraryOptions {
  /** Successes needed before a probation strategy becomes active. */
  promoteAfter: number;
}

function stepSignature(steps: StrategyStep[]): string {
  return JSON.stringify(steps.map((s) => [s.tool, Object.entries(s.input).sort(([a], [b]) => a.localeCompare(b))]));
}

/**
 * The learned-strategy database (a JSON file you can open and read). Most instructions are
 * answered from here without calling the model; the model is only asked about new situations.
 */
export class StrategyLibrary {
  private data: FileData;

  constructor(
    private readonly file: string | null,
    private readonly opts: LibraryOptions = { promoteAfter: 2 },
  ) {
    this.data = { version: 1, nextId: 1, strategies: [], totals: { strategyRuns: 0, strategyFailures: 0, llmTasks: 0, learned: 0 } };
    if (file && fs.existsSync(file)) {
      try {
        this.data = FileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
        log.info(`读取策略库：${this.usable().length} 个可用策略`);
      } catch (err) {
        const backup = `${file}.broken-${Date.now()}`;
        fs.copyFileSync(file, backup);
        log.error(`策略库文件损坏，已备份到 ${backup}，从空库开始`, err);
      }
    }
  }

  get all(): readonly Strategy[] {
    return this.data.strategies;
  }

  get totals(): Readonly<FileData["totals"]> {
    return this.data.totals;
  }

  usable(): Strategy[] {
    return this.data.strategies.filter((s) => s.status === "active" || s.status === "probation");
  }

  get(id: number): Strategy | undefined {
    return this.data.strategies.find((s) => s.id === id);
  }

  /** Best usable strategy for this instruction, or null if it is a new situation. */
  match(instruction: string): StrategyMatch | null {
    const hits: Array<StrategyMatch & { specificity: number }> = [];
    for (const strategy of this.usable()) {
      for (const trigger of strategy.triggers) {
        let values: ParamValues | null = null;
        try {
          values = matchTrigger(instruction, trigger, strategy.params as ParamSpec[]);
        } catch {
          continue;
        }
        if (values) {
          hits.push({ strategy, values, specificity: trigger.replace(/\{\w+\}/g, "").length });
          break;
        }
      }
    }
    hits.sort(
      (a, b) =>
        Number(b.strategy.status === "active") - Number(a.strategy.status === "active") ||
        b.strategy.stats.successes - a.strategy.stats.successes ||
        b.specificity - a.specificity,
    );
    return hits[0] ? { strategy: hits[0].strategy, values: hits[0].values } : null;
  }

  /**
   * Add a reviewed strategy. If one with the same steps already exists, merge the new ways of
   * saying it and new words into it instead (the library grows wider, not just longer).
   */
  add(candidate: Omit<Strategy, "id" | "stats" | "status"> & { status: "pending" | "probation" }): { strategy: Strategy; merged: boolean } {
    const sig = stepSignature(candidate.steps as StrategyStep[]);
    const same = this.data.strategies.find((s) => s.status !== "disabled" && stepSignature(s.steps as StrategyStep[]) === sig);
    if (same) {
      for (const t of candidate.triggers) if (!same.triggers.includes(t)) same.triggers.push(t);
      for (const p of candidate.params) {
        const existing = same.params.find((q) => q.name === p.name && q.type === p.type);
        if (!existing) same.params.push(p);
        else for (const v of p.values) if (!existing.values.some((w) => w.word === v.word)) existing.values.push(v);
      }
      this.save();
      return { strategy: same, merged: true };
    }
    const strategy: Strategy = {
      ...candidate,
      id: this.data.nextId++,
      stats: { uses: 0, successes: 0, failures: 0, lastUsed: null, createdAt: Date.now() },
    };
    this.data.strategies.push(strategy);
    this.data.totals.learned++;
    this.save();
    return { strategy, merged: false };
  }

  recordLlmTask(): void {
    this.data.totals.llmTasks++;
    this.save();
  }

  recordResult(id: number, ok: boolean): void {
    const s = this.get(id);
    if (!s) return;
    s.stats.uses++;
    s.stats.lastUsed = Date.now();
    this.data.totals.strategyRuns++;
    if (ok) {
      s.stats.successes++;
      if (s.status === "probation" && s.stats.successes >= this.opts.promoteAfter) {
        s.status = "active";
        log.info(`策略 #${s.id}「${s.name}」转正`);
      }
    } else {
      s.stats.failures++;
      this.data.totals.strategyFailures++;
      const rate = s.stats.successes / s.stats.uses;
      if (s.status === "probation" && s.stats.failures >= 2 && s.stats.successes === 0) {
        this.disable(id, "试用期连续失败");
      } else if (s.stats.uses >= 5 && rate < 0.5) {
        this.disable(id, `成功率太低（${Math.round(rate * 100)}%）`);
      }
    }
    this.save();
  }

  disable(id: number, reason: string): boolean {
    const s = this.get(id);
    if (!s || s.status === "disabled") return false;
    s.status = "disabled";
    s.disabledReason = reason;
    log.info(`停用策略 #${id}「${s.name}」：${reason}`);
    this.save();
    return true;
  }

  approve(id: number): boolean {
    const s = this.get(id);
    if (!s || s.status !== "pending") return false;
    s.status = "probation";
    this.save();
    return true;
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
