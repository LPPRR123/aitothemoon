import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import { stripColors } from "../bot/text.js";
import { ActionError } from "./types.js";

export class CancelledError extends ActionError {
  constructor() {
    super("任务已被主人取消");
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a promise with a timeout and cancellation. `cancel` is called on timeout or abort
 * so the underlying Mineflayer task (pathfinding, digging) really stops.
 */
export async function guarded<T>(
  work: Promise<T>,
  opts: { signal: AbortSignal; timeoutMs: number; cancel: () => void; what: string },
): Promise<T> {
  throwIfAborted(opts.signal);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopper = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      opts.cancel();
      reject(new ActionError(`${opts.what}超时（${Math.round(opts.timeoutMs / 1000)} 秒）`));
    }, opts.timeoutMs);
    onAbort = () => {
      opts.cancel();
      reject(new CancelledError());
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopper]);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);
    work.catch(() => {}); // the losing promise may reject later; don't crash on it
  }
}

/** Collect system/chat messages the server sends during the next `ms` milliseconds. */
export function captureMessages(bot: Bot, ms: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const onMsg = (raw: string, position: string) => {
      if (position === "game_info") return;
      const text = stripColors(raw).trim();
      if (text) lines.push(text);
    };
    bot.on("messagestr", onMsg);
    setTimeout(() => {
      bot.off("messagestr", onMsg);
      resolve(lines);
    }, ms);
  });
}

/** Wait for a window to open. Resolves null if nothing opens within `ms`. */
export function waitForWindow(bot: Bot, ms: number): Promise<Window | null> {
  return new Promise((resolve) => {
    const onOpen = (win: Window) => {
      clearTimeout(t);
      resolve(win);
    };
    const t = setTimeout(() => {
      bot.off("windowOpen", onOpen);
      resolve(null);
    }, ms);
    bot.once("windowOpen", onOpen);
  });
}

export function formatMessages(lines: string[]): string {
  return lines.length ? `服务器消息：${lines.slice(-6).join(" | ")}` : "服务器没有回复消息";
}

/** Find inventory item by exact id, or by a unique partial match. */
export function findInventoryItem(bot: Bot, query: string) {
  const q = query.toLowerCase().trim();
  const items = bot.inventory.items();
  return (
    items.find((i) => i.name === q) ??
    items.find((i) => i.name.endsWith(`_${q}`) || i.name.startsWith(`${q}_`)) ??
    items.find((i) => i.name.includes(q) || i.displayName.toLowerCase().includes(q))
  );
}

/** Poll until `cond` is true or the timeout passes. Returns whether the condition was met. */
export async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return cond();
}
