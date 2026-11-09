import { z } from "zod";
import { describeDue } from "../memory/reminders.js";
import { formatPlace, type BeliefKind } from "../memory/store.js";
import { ActionError, defineAction, type ActionContext } from "./types.js";

/** Did the owner, in this task, ask to remember something? Decided by code, not by the model. */
export function ownerAskedToRemember(messages: string[]): boolean {
  return messages.some((m) => /记住|记下|记一下|记得|别忘|以后|从今以后/.test(m));
}

function store(ctx: ActionContext) {
  if (!ctx.memory) throw new ActionError("记忆功能没有开启");
  return ctx.memory;
}

export const remember = defineAction({
  name: "remember",
  description:
    "把一条信息记进长期记忆。kind：place 地点、fact 事实、preference 主人的偏好、rule 主人定的规矩。subject 是一个短名字（例如 家、铁矿洞、主人的爱好、箱子规矩），同一个 subject 再记一次会覆盖旧的（算作改正）。地点用 here=true 记你现在的位置，或者给 x/y/z。",
  risk: "low",
  schema: z.object({
    kind: z.enum(["place", "fact", "preference", "rule"]),
    subject: z.string().min(1).max(30),
    content: z.string().max(200).default(""),
    here: z.boolean().default(false).describe("地点：记录你现在站的位置"),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
  }),
  async run(ctx, { kind, subject, content, here, x, y, z: zc }) {
    const memory = store(ctx);
    const fromOwner = ownerAskedToRemember(ctx.ownerMessages);
    if ((kind === "rule" || kind === "preference") && !fromOwner) {
      throw new ActionError("规矩和偏好只能在主人亲口要求记住时才记，别人说的不算");
    }
    let place;
    if (kind === "place") {
      const dimension = String(ctx.bot.game.dimension);
      if (here) {
        const p = ctx.bot.entity.position;
        place = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension };
      } else if (x !== undefined && y !== undefined && zc !== undefined) {
        place = { x, y, z: zc, dimension };
      } else {
        throw new ActionError("记地点需要 here=true 或者 x/y/z");
      }
    }
    const { belief, change } = memory.remember({
      kind: kind as BeliefKind,
      subject,
      content,
      place,
      source: fromOwner ? "owner" : "inferred",
      importance: kind === "rule" ? 1 : fromOwner ? 0.9 : 0.5,
      pinned: fromOwner,
    });
    const verb = change === "new" ? "记住了" : change === "corrected" ? "改正了" : "确认了";
    return `${verb}：${memory.describe(belief)}`;
  },
});

export const recall = defineAction({
  name: "recall",
  description: "在长期记忆里查找和某件事有关的信息（地点、事实、主人的偏好和规矩）。不确定某个东西在哪、主人以前说过什么时用。",
  risk: "low",
  schema: z.object({ query: z.string().min(1) }),
  async run(ctx, { query }) {
    const memory = store(ctx);
    const found = memory.search(query, 8);
    found.forEach((b) => memory.use(b.id));
    return found.length ? found.map((b) => `- ${memory.describe(b)}`).join("\n") : `没有关于"${query}"的记忆`;
  },
});

export const forget = defineAction({
  name: "forget",
  description: "删除一条记忆。只有主人明确要求忘掉时才能用。",
  risk: "medium",
  schema: z.object({ subject: z.string().min(1) }),
  async run(ctx, { subject }) {
    if (!ctx.ownerMessages.some((m) => /忘|删/.test(m))) throw new ActionError("只有主人要求时才能删除记忆");
    const removed = store(ctx).forget(subject);
    return removed.length ? `已忘掉：${subject}` : `没有叫"${subject}"的记忆`;
  },
});

export const doubt = defineAction({
  name: "doubt",
  description:
    "发现某条记忆和实际情况不符时调用（例如记住的地点去了发现不对、主人说的情况已经变了）。会降低这条记忆的可信度，多次不符会标记为可能是错的。如果你已经知道正确的信息，直接用 remember 改正。",
  risk: "low",
  schema: z.object({ subject: z.string().min(1), reason: z.string().min(1).max(100) }),
  async run(ctx, { subject, reason }) {
    const memory = store(ctx);
    const b = memory.find(subject);
    if (!b) throw new ActionError(`没有叫"${subject}"的记忆`);
    const after = memory.contradict(b.id, reason)!;
    return after.status === "doubtful"
      ? `已标记「${subject}」可能是错的（${reason}）。以后用之前要先验证或者问主人`
      : `已降低「${subject}」的可信度到 ${Math.round(after.confidence * 100)}%`;
  },
});

export const setReminder = defineAction({
  name: "set_reminder",
  description:
    "答应主人的提醒：到时间（minutes 分钟后），或者游戏里天黑/天亮时（when），私聊提醒主人。repeat=true 表示每天天黑/天亮都提醒。只有主人要求提醒时才用。",
  risk: "low",
  schema: z.object({
    what: z.string().min(1).max(100).describe("要提醒的内容，例如 关熔炉"),
    minutes: z.number().positive().max(60 * 24 * 7).optional(),
    when: z.enum(["night", "day"]).optional(),
    repeat: z.boolean().default(false),
  }),
  async run(ctx, { what, minutes, when, repeat }) {
    const memory = store(ctx);
    if (!ctx.ownerMessages.some((m) => /提醒|叫我|告诉我/.test(m))) throw new ActionError("只有主人要求提醒时才能设提醒");
    if (minutes === undefined && !when) throw new ActionError("需要 minutes 或 when");
    const due = when ? { type: when } : { type: "time" as const, at: Date.now() + minutes! * 60_000 };
    const r = memory.addReminder({ owner: ctx.owner, text: what, due, repeat: !!when && repeat });
    return `好的，提醒 #${r.id}：${what}（${describeDue(r.due, r.repeat, Date.now())}）`;
  },
});

export const memoryActions = [remember, recall, forget, doubt, setReminder];
export const MEMORY_TOOLS = new Set(memoryActions.map((a) => a.name));
export { formatPlace };
