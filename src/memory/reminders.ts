import { parseNumber } from "../strategy/matcher.js";
import type { ReminderDue } from "./store.js";

export interface ParsedReminder {
  due: ReminderDue;
  repeat: boolean;
  text: string;
}

const UNIT_MS: Record<string, number> = { 秒: 1_000, 秒钟: 1_000, 分: 60_000, 分钟: 60_000, 小时: 3_600_000, 个小时: 3_600_000 };
const NUM = "(\\d+|[零一二两三四五六七八九十百]+|半)";
const PART_OF_DAY: Record<string, number> = { 早上: 8, 上午: 9, 中午: 12, 下午: 15, 晚上: 20 };

/**
 * Parse the common ways of asking for a reminder, without a model call:
 *   "5分钟后提醒我关熔炉" / "过半小时提醒我…" / "明天早上提醒我…"
 *   "天黑了提醒我回家" / "每天晚上提醒我…" (repeats every game night) / "天亮提醒我…"
 * Returns null for anything else (the model can still set it with the set_reminder tool).
 */
export function parseReminder(text: string, now: number): ParsedReminder | null {
  const t = text.replace(/[，。！!、\s]/g, "");
  let m = new RegExp(`^(?:过)?${NUM}(个小时|小时|分钟|分|秒钟|秒)(?:之?后|以后)?(?:再)?提醒我(.+)$`).exec(t);
  if (m) {
    const n = m[1] === "半" ? 0.5 : parseNumber(m[1]!);
    const unit = UNIT_MS[m[2]!];
    if (n === null || !unit || n <= 0) return null;
    return { due: { type: "time", at: now + n * unit }, repeat: false, text: m[3]! };
  }
  m = /^明天(早上|上午|中午|下午|晚上)?提醒我(.+)$/.exec(t);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(PART_OF_DAY[m[1] ?? "上午"] ?? 9, 0, 0, 0);
    return { due: { type: "time", at: d.getTime() }, repeat: false, text: m[2]! };
  }
  m = /^(每天|每次|每晚)(天黑|晚上|夜里)?(的时候|了)?提醒我(.+)$/.exec(t);
  if (m) return { due: { type: "night" }, repeat: true, text: m[4]! };
  m = /^(每天|每次)(天亮|早上|白天)(的时候|了)?提醒我(.+)$/.exec(t);
  if (m) return { due: { type: "day" }, repeat: true, text: m[4]! };
  m = /^(等)?(天黑|晚上|夜里|入夜)(的时候|了|以后)?提醒我(.+)$/.exec(t);
  if (m) return { due: { type: "night" }, repeat: false, text: m[4]! };
  m = /^(等)?(天亮|白天)(的时候|了|以后)?提醒我(.+)$/.exec(t);
  if (m) return { due: { type: "day" }, repeat: false, text: m[4]! };
  return null;
}

export function describeDue(due: ReminderDue, repeat: boolean, now: number): string {
  if (due.type === "night") return repeat ? "每天游戏里天黑时" : "游戏里天黑时";
  if (due.type === "day") return repeat ? "每天游戏里天亮时" : "游戏里天亮时";
  const secs = Math.max(0, Math.round((due.at - now) / 1_000));
  if (secs < 60) return secs <= 1 ? "马上" : `${secs} 秒后`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} 分钟后`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时后`;
  const d = new Date(due.at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}点`;
}

/** Game night, as Minecraft counts it (monsters spawn, beds work). */
export function isGameNight(timeOfDay: number): boolean {
  return timeOfDay >= 13_000 && timeOfDay < 23_000;
}
