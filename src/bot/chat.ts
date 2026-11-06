import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { splitMessage, stripColors } from "./text.js";

export interface IncomingChat {
  username: string;
  message: string;
  /** True for private messages (/msg, /tell, /w) sent to the bot. */
  whisper: boolean;
  time: number;
}

export interface ChatLine {
  /** "player" lines have a username; "server" lines are system messages (plugins, AuthMe, etc.). */
  kind: "player" | "whisper" | "server" | "self";
  username?: string;
  text: string;
  time: number;
}

/** Compile user-supplied patterns. Each must have named groups `user` and `msg`. */
export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    const re = new RegExp(p);
    if (!p.includes("?<user>") || !p.includes("?<msg>")) {
      throw new Error(`Chat pattern needs named groups "user" and "msg": ${p}`);
    }
    return re;
  });
}

export function matchPatterns(text: string, patterns: RegExp[]): { user: string; msg: string } | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.groups?.user && m.groups.msg !== undefined) {
      return { user: m.groups.user, msg: m.groups.msg.trim() };
    }
  }
  return null;
}

/**
 * Turns the different chat events Mineflayer emits into one stream of player messages,
 * keeps a short history for the AI, and drops duplicates (a message can arrive both as
 * a "chat" event and through a custom pattern).
 */
export class ChatListener extends EventEmitter<{ message: [IncomingChat]; line: [ChatLine] }> {
  readonly history: ChatLine[] = [];
  private recent = new Map<string, number>();

  constructor(
    private readonly historySize = 50,
    private readonly patterns: RegExp[] = [],
    private readonly whisperPatterns: RegExp[] = [],
  ) {
    super();
  }

  attach(bot: Bot): void {
    bot.on("chat", (username, message) => this.onPlayer(bot, username, message, false));
    bot.on("whisper", (username, message) => this.onPlayer(bot, username, message, true));
    bot.on("messagestr", (raw, position) => {
      if (position === "game_info") return; // action bar text
      const text = stripColors(raw).trim();
      if (!text) return;
      const w = matchPatterns(text, this.whisperPatterns);
      if (w) return this.onPlayer(bot, w.user, w.msg, true);
      const p = matchPatterns(text, this.patterns);
      if (p) return this.onPlayer(bot, p.user, p.msg, false);
      // Plain system message. Player chat that Mineflayer parsed is recorded in onPlayer instead.
      if (/^<[^>]+> /.test(text)) return;
      this.push({ kind: "server", text, time: Date.now() });
    });
  }

  /** Record a message the bot itself sent. */
  recordSelf(text: string): void {
    this.push({ kind: "self", text, time: Date.now() });
  }

  private onPlayer(bot: Bot, username: string, message: string, whisper: boolean): void {
    if (!username || username === bot.username) return;
    const text = stripColors(message).trim();
    if (!text) return;
    const key = `${username}|${text}`;
    const now = Date.now();
    const seen = this.recent.get(key);
    if (seen && now - seen < 1_000) return;
    this.recent.set(key, now);
    if (this.recent.size > 200) this.recent.clear();
    this.push({ kind: whisper ? "whisper" : "player", username, text, time: now });
    this.emit("message", { username, message: text, whisper, time: now });
  }

  private push(line: ChatLine): void {
    this.history.push(line);
    if (this.history.length > this.historySize) this.history.shift();
    this.emit("line", line);
  }
}

export interface ChatLimits {
  minIntervalMs: number;
  maxPerMinute: number;
  maxLength: number;
}

/**
 * Outgoing chat queue. Everything the bot says goes through here so it never floods
 * the server (many servers kick for spam).
 */
export class ChatSender {
  private queue: Array<{ text: string; done?: () => void }> = [];
  private sentTimes: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limits: ChatLimits,
    private readonly send: (text: string) => void,
    private readonly now: () => number = Date.now,
    private readonly maxQueue = 10,
  ) {}

  /** Queue a chat line or command. Returns false if the queue is full and the text was dropped. */
  say(text: string): boolean {
    return this.enqueue(text) !== null;
  }

  /** Queue a line and wait until it has actually been sent. Rejects if the queue is full. */
  sayAndWait(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.enqueue(text, resolve) === null) reject(new Error("聊天队列已满，消息没有发出"));
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    for (const item of this.queue) item.done?.();
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Milliseconds until the next message may be sent (0 = now). */
  nextDelay(): number {
    const now = this.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 60_000);
    const byInterval = this.lastSent + this.limits.minIntervalMs - now;
    const byMinute =
      this.sentTimes.length >= this.limits.maxPerMinute ? (this.sentTimes[0] ?? now) + 60_000 - now : 0;
    return Math.max(0, byInterval, byMinute);
  }

  private enqueue(text: string, done?: () => void): number | null {
    const parts = text.startsWith("/") ? [text.slice(0, 256)] : splitMessage(text, this.limits.maxLength);
    if (parts.length === 0) {
      done?.();
      return 0;
    }
    if (this.queue.length + parts.length > this.maxQueue) return null;
    parts.forEach((part, i) => this.queue.push({ text: part, done: i === parts.length - 1 ? done : undefined }));
    this.pump();
    return parts.length;
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0) return;
    const delay = this.nextDelay();
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.queue.shift();
      if (next !== undefined) {
        const now = this.now();
        this.lastSent = now;
        this.sentTimes.push(now);
        this.send(next.text);
        next.done?.();
      }
      this.pump();
    }, delay);
  }
}
