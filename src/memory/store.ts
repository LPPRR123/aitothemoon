import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "../logger.js";

const log = createLogger("memory");

/**
 * Long-term memory. What the bot sees right now (inventory, nearby blocks) is *world state* and
 * is never stored here; this file holds *beliefs*: things it was told, inferred or remembered,
 * which can be out of date or simply wrong. Every belief therefore carries where it came from,
 * how confident the bot is, and how often it was confirmed or contradicted.
 */
export type BeliefKind = "place" | "fact" | "preference" | "rule";
export type BeliefSource = "owner" | "observed" | "inferred";

const PlaceSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), dimension: z.string() });
export type Place = z.infer<typeof PlaceSchema>;

const BeliefSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["place", "fact", "preference", "rule"]),
  subject: z.string(),
  content: z.string(),
  place: PlaceSchema.optional(),
  source: z.enum(["owner", "observed", "inferred"]),
  confidence: z.number(),
  importance: z.number(),
  /** Things the owner asked to remember are never forgotten automatically. */
  pinned: z.boolean(),
  status: z.enum(["active", "doubtful", "archived"]),
  createdAt: z.number(),
  lastUsed: z.number(),
  lastVerified: z.number().nullable(),
  uses: z.number().int(),
  verifications: z.number().int(),
  contradictions: z.number().int(),
  /** Earlier versions, kept when a belief is corrected or doubted. */
  history: z.array(z.object({ at: z.number(), content: z.string(), place: PlaceSchema.optional(), reason: z.string() })),
});
export type Belief = z.infer<typeof BeliefSchema>;

const EpisodeSchema = z.object({ time: z.number(), text: z.string(), importance: z.number() });
export type Episode = z.infer<typeof EpisodeSchema>;

const FileSchema = z.object({
  version: z.literal(1),
  nextId: z.number().int(),
  beliefs: z.array(BeliefSchema),
  episodes: z.array(EpisodeSchema),
});
type FileData = z.infer<typeof FileSchema>;

const DAY = 86_400_000;
const MAX_EPISODES = 300;

export interface MemoryOptions {
  /** Unused, unpinned memories lose half their "keep" score every this many days. */
  halfLifeDays: number;
  now?: () => number;
}

export interface RememberInput {
  kind: BeliefKind;
  subject: string;
  content: string;
  place?: Place;
  source: BeliefSource;
  importance?: number;
  pinned?: boolean;
}

export function normalizeSubject(s: string): string {
  return s.replace(/[\s，。！？、,.!?"'“”‘’「」]/g, "").toLowerCase();
}

/** Character bigrams: a simple similarity that works for Chinese without a tokenizer. */
function bigrams(s: string): Set<string> {
  const t = normalizeSubject(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

const SOURCE_CONFIDENCE: Record<BeliefSource, number> = { owner: 1, observed: 0.9, inferred: 0.6 };
const SOURCE_LABEL: Record<BeliefSource, string> = { owner: "主人告诉的", observed: "亲眼看到的", inferred: "自己推断的" };

export function formatPlace(p: Place): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}${p.dimension === "overworld" ? "" : ` ${p.dimension}`})`;
}

export class MemoryStore {
  private data: FileData = { version: 1, nextId: 1, beliefs: [], episodes: [] };
  private readonly now: () => number;
  private writesSinceConsolidate = 0;

  constructor(
    private readonly file: string | null,
    private readonly opts: MemoryOptions = { halfLifeDays: 14 },
  ) {
    this.now = opts.now ?? Date.now;
    if (file && fs.existsSync(file)) {
      try {
        this.data = FileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (err) {
        const backup = `${file}.broken-${Date.now()}`;
        fs.copyFileSync(file, backup);
        log.error(`记忆文件损坏，已备份到 ${backup}，从空记忆开始`, err);
      }
    }
    this.consolidate();
    log.info(`读取记忆：${this.beliefs().length} 条认知，${this.data.episodes.length} 件事`);
  }

  /** Beliefs in use (not archived). */
  beliefs(kind?: BeliefKind): Belief[] {
    return this.data.beliefs.filter((b) => b.status !== "archived" && (!kind || b.kind === kind));
  }

  get archived(): Belief[] {
    return this.data.beliefs.filter((b) => b.status === "archived");
  }

  get episodes(): readonly Episode[] {
    return this.data.episodes;
  }

  find(subject: string, kind?: BeliefKind): Belief | undefined {
    const key = normalizeSubject(subject);
    return this.beliefs(kind).find((b) => normalizeSubject(b.subject) === key);
  }

  /**
   * Store a belief. The same subject again with different content is a *correction*: the old
   * version goes into history. The same content again counts as a confirmation.
   */
  remember(input: RememberInput): { belief: Belief; change: "new" | "corrected" | "confirmed" } {
    const now = this.now();
    const key = normalizeSubject(input.subject);
    const existing = this.data.beliefs.find((b) => normalizeSubject(b.subject) === key);
    const confidence = SOURCE_CONFIDENCE[input.source];
    if (existing) {
      const samePlace = JSON.stringify(existing.place ?? null) === JSON.stringify(input.place ?? null);
      if (existing.content === input.content && samePlace && existing.status !== "archived") {
        this.verify(existing.id);
        return { belief: existing, change: "confirmed" };
      }
      existing.history.push({ at: now, content: existing.content, place: existing.place, reason: "改正" });
      Object.assign(existing, {
        kind: input.kind,
        content: input.content,
        place: input.place,
        source: input.source,
        confidence,
        importance: Math.max(existing.importance, input.importance ?? 0.5),
        pinned: existing.pinned || !!input.pinned,
        status: "active",
        lastUsed: now,
        lastVerified: now,
        contradictions: 0,
      });
      this.save();
      return { belief: existing, change: "corrected" };
    }
    const belief: Belief = {
      id: this.data.nextId++,
      kind: input.kind,
      subject: input.subject.trim(),
      content: input.content,
      place: input.place,
      source: input.source,
      confidence,
      importance: input.importance ?? 0.5,
      pinned: !!input.pinned,
      status: "active",
      createdAt: now,
      lastUsed: now,
      lastVerified: now,
      uses: 0,
      verifications: 0,
      contradictions: 0,
      history: [],
    };
    this.data.beliefs.push(belief);
    this.save();
    return { belief, change: "new" };
  }

  /** Memories related to a piece of text, most relevant and trusted first. */
  search(query: string, limit = 6): Belief[] {
    const q = normalizeSubject(query);
    const qb = bigrams(query);
    const scored = this.beliefs()
      .map((b) => {
        const subj = normalizeSubject(b.subject);
        let score = 0;
        if (subj && (q.includes(subj) || subj.includes(q))) score += 2;
        const bb = bigrams(`${b.subject}${b.content}`);
        let overlap = 0;
        for (const g of qb) if (bb.has(g)) overlap++;
        score += qb.size ? overlap / qb.size : 0;
        return { b, score: score * (0.5 + b.confidence / 2) };
      })
      .filter((x) => x.score > 0.25)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.b);
  }

  /** Mark a belief as used (keeps it from being forgotten). */
  use(id: number): void {
    const b = this.get(id);
    if (!b) return;
    b.uses++;
    b.lastUsed = this.now();
    this.save();
  }

  /** Reality agreed with the belief. */
  verify(id: number): void {
    const b = this.get(id);
    if (!b) return;
    b.verifications++;
    b.confidence = Math.min(1, b.confidence + 0.15);
    b.lastVerified = this.now();
    b.lastUsed = this.now();
    if (b.status === "doubtful" && b.confidence >= 0.5) b.status = "active";
    this.save();
  }

  /**
   * Reality disagreed with the belief. One contradiction halves the confidence; a second one
   * (or very low confidence) marks it doubtful, so it is checked or asked about before use.
   */
  contradict(id: number, reason: string): Belief | undefined {
    const b = this.get(id);
    if (!b) return undefined;
    b.contradictions++;
    b.confidence = Math.round(b.confidence * 50) / 100;
    b.history.push({ at: this.now(), content: b.content, place: b.place, reason: `矛盾：${reason}` });
    if (b.contradictions >= 2 || b.confidence < 0.4) b.status = "doubtful";
    this.save();
    return b;
  }

  /** Delete memories by subject (owner request). Returns the removed ones. */
  forget(subject: string): Belief[] {
    const key = normalizeSubject(subject);
    const removed = this.data.beliefs.filter((b) => normalizeSubject(b.subject) === key);
    if (removed.length) {
      this.data.beliefs = this.data.beliefs.filter((b) => !removed.includes(b));
      this.save();
    }
    return removed;
  }

  addEpisode(text: string, importance = 0.3): void {
    this.data.episodes.push({ time: this.now(), text: text.slice(0, 200), importance });
    if (++this.writesSinceConsolidate >= 50) this.consolidate();
    this.save();
  }

  /** "Keep" score: important, recently used, often used and trusted memories stay. */
  retention(b: Belief): number {
    const days = (this.now() - b.lastUsed) / DAY;
    const recency = Math.pow(0.5, days / this.opts.halfLifeDays);
    return b.importance * recency * (1 + Math.log1p(b.uses)) * b.confidence;
  }

  /**
   * Forgetting. Unpinned beliefs with a low keep score are archived (kept in the file, left out
   * of prompts). Old unimportant events are dropped, and the event log is capped.
   */
  consolidate(): void {
    this.writesSinceConsolidate = 0;
    let archived = 0;
    for (const b of this.data.beliefs) {
      if (b.pinned || b.status === "archived") continue;
      if (this.retention(b) < 0.05) {
        b.status = "archived";
        archived++;
      }
    }
    const now = this.now();
    let eps = this.data.episodes.filter((e) => e.importance >= 0.5 || now - e.time < 30 * DAY);
    if (eps.length > MAX_EPISODES) {
      const keep = new Set(
        [...eps].sort((a, b) => b.importance - a.importance || b.time - a.time).slice(0, MAX_EPISODES),
      );
      eps = eps.filter((e) => keep.has(e));
    }
    const dropped = this.data.episodes.length - eps.length;
    this.data.episodes = eps;
    if (archived || dropped) {
      log.info(`整理记忆：归档 ${archived} 条认知，删除 ${dropped} 件旧事`);
      this.save();
    }
  }

  get(id: number): Belief | undefined {
    return this.data.beliefs.find((b) => b.id === id);
  }

  /** One line per belief, with where it came from and whether it may be wrong. */
  describe(b: Belief): string {
    const where = b.place ? ` ${formatPlace(b.place)}` : "";
    const notes: string[] = [SOURCE_LABEL[b.source]];
    if (b.status === "doubtful") {
      const last = [...b.history].reverse().find((h) => h.reason.startsWith("矛盾"));
      notes.push(`可能是错的${last ? `，${last.reason}` : ""}`);
    } else if (b.source !== "owner") {
      notes.push(`置信度 ${Math.round(b.confidence * 100)}%`);
    }
    const content = b.kind === "place" ? b.content || "地点" : b.content;
    return `${b.subject}：${content}${where}（${notes.join("，")}）`;
  }

  /**
   * Memory shown to the model with each new instruction: the owner's rules and preferences
   * always (behavior consistency), plus memories related to the instruction, known places and
   * recent events.
   */
  promptBlock(instruction: string): string {
    const shown = new Set<number>();
    const section = (title: string, items: Belief[]) => {
      const fresh = items.filter((b) => !shown.has(b.id));
      fresh.forEach((b) => shown.add(b.id));
      return fresh.length ? `【${title}】\n${fresh.map((b) => `- ${this.describe(b)}`).join("\n")}` : "";
    };
    const parts = [
      section("主人的规定（必须遵守）", this.beliefs("rule").slice(0, 10)),
      section("主人的偏好", this.beliefs("preference").slice(0, 5)),
      section("和这次指令有关的记忆", this.search(instruction, 6)),
      section("记得的地点", this.beliefs("place").slice(0, 8)),
    ];
    const recent = this.data.episodes.slice(-5);
    if (recent.length) {
      const fmt = (t: number) => {
        const mins = Math.round((this.now() - t) / 60_000);
        return mins < 60 ? `${mins}分钟前` : mins < 1440 ? `${Math.round(mins / 60)}小时前` : `${Math.round(mins / 1440)}天前`;
      };
      parts.push(`【最近发生的事】\n${recent.map((e) => `- ${fmt(e.time)}：${e.text}`).join("\n")}`);
    }
    return parts.filter(Boolean).join("\n");
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
