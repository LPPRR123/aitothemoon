import { createRequire } from "node:module";
import type { Bot } from "mineflayer";

interface ChatMessageLike {
  toString(): string;
}
interface ChatMessageCtor {
  new (message: object): ChatMessageLike;
  fromNotch(str: string): ChatMessageLike;
}
// prismarine-chat is CommonJS (`module.exports = loader`) but its typings declare a default export.
const require = createRequire(import.meta.url);
const chatLoader = require("prismarine-chat") as (registry: unknown) => ChatMessageCtor;
const nbt = require("prismarine-nbt") as { simplify(data: unknown): unknown };

/** Since 1.20.3 many text components arrive as NBT ({ type, value }) instead of JSON. */
function isNbt(value: unknown): value is { type: string; value: unknown } {
  return typeof value === "object" && value !== null && "type" in value && "value" in value;
}

/** Remove Minecraft formatting codes such as "§a" or "&c". */
export function stripColors(text: string): string {
  return text.replace(/[§&][0-9a-fk-orx]/gi, "");
}

/** Lowercase, strip colors and whitespace, for loose name matching. */
export function normalizeName(text: string): string {
  return stripColors(text).replace(/\s+/g, "").toLowerCase();
}

/**
 * Turn a raw text component (JSON string, as stored in item NBT and window titles)
 * into plain text. Falls back to the input with colors removed.
 */
export function componentToText(bot: Bot, raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object") {
    try {
      const ChatMessage = chatLoader(bot.registry);
      const json = isNbt(raw) ? nbt.simplify(raw) : raw;
      if (typeof json === "string") return stripColors(json);
      return stripColors(new ChatMessage(json as object).toString());
    } catch {
      return "";
    }
  }
  const str = String(raw);
  const trimmed = str.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const ChatMessage = chatLoader(bot.registry);
      return stripColors(ChatMessage.fromNotch(trimmed).toString());
    } catch {
      // not JSON after all
    }
  }
  return stripColors(str);
}

/** Split a long message at sentence-ish boundaries so each part fits in chat. */
export function splitMessage(text: string, maxLength: number): string[] {
  const clean = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!clean) return [];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const cut = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("，"),
      window.lastIndexOf(". "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    );
    const at = cut > maxLength / 3 ? cut + 1 : maxLength;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
