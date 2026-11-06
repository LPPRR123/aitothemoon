import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import pathfinderPkg from "mineflayer-pathfinder";
import { z } from "zod";
import { describeWindow, entityLabel } from "../bot/perception.js";
import { normalizeName } from "../bot/text.js";
import { checkCommand } from "../safety/commands.js";
import { travelMovements } from "./movement.js";
import { ActionError, defineAction } from "./types.js";
import { captureMessages, findInventoryItem, formatMessages, guarded, sleep, waitForWindow } from "./util.js";

const { goals } = pathfinderPkg;

function windowOrMessages(bot: Bot, messages: string[]): string {
  const win = describeWindow(bot);
  return win ? `${win}\n${formatMessages(messages)}` : `没有打开窗口。${formatMessages(messages)}`;
}

export const runCommand = defineAction({
  name: "run_command",
  description:
    "执行服务器指令（如 /spawn、/home、/menu）。会返回服务器回复的消息；如果指令打开了菜单，也会返回菜单内容。不在允许列表里的指令，只有主人亲口说出这条指令时才能执行。",
  risk: "medium",
  schema: z.object({
    command: z.string().describe("完整指令，例如 /home 或 /warp pvp"),
  }),
  async run(ctx, { command }) {
    const decision = checkCommand(command, ctx.config.commands, ctx.ownerMessages);
    if (!decision.ok) throw new ActionError(decision.reason);
    const { bot } = ctx;
    await ctx.sender.sayAndWait(`/${decision.command}`);
    const listen = captureMessages(bot, 2_000);
    const opened = waitForWindow(bot, 2_000);
    const [messages, win] = await Promise.all([listen, opened]);
    if (win) await sleep(300); // let the server fill the slots
    return `已执行 /${decision.command}\n${windowOrMessages(bot, messages)}`;
  },
});

export const listServerCommands = defineAction({
  name: "list_server_commands",
  description: "通过 Tab 补全查看服务器上有哪些指令（只读，不执行）。prefix 可以过滤开头，例如 \"w\"。",
  risk: "low",
  schema: z.object({ prefix: z.string().default("") }),
  async run(ctx, { prefix }) {
    const list = await ctx.bot.tabComplete(`/${prefix.replace(/^\//, "")}`, true, false, 3_000);
    // Typed as string[], but some protocol versions return { match } objects.
    const raw = list as Array<string | { match: string }>;
    const names = [...new Set(raw.map((x) => (typeof x === "string" ? x : x.match).replace(/^\//, "")))]
      .filter((n) => !n.includes(":"))
      .sort();
    return names.length ? `可用指令（${names.length} 个）：${names.slice(0, 120).join(" ")}` : "没有获取到指令列表";
  },
});

export const readWindow = defineAction({
  name: "read_window",
  description: "查看当前打开的菜单/箱子/GUI 里每个格子的物品名称和说明文字。点击之前先用它看清楚。",
  risk: "low",
  schema: z.object({}),
  async run(ctx) {
    return describeWindow(ctx.bot) ?? "当前没有打开的窗口";
  },
});

export const clickSlot = defineAction({
  name: "click_slot",
  description:
    "点击当前打开窗口里的某个格子（服务器菜单的按钮就是格子里的物品）。返回点击后的窗口内容和服务器消息。多层菜单需要一层层点。",
  risk: "medium",
  schema: z.object({
    slot: z.number().int().min(0),
    button: z.enum(["left", "right"]).default("left"),
    shift: z.boolean().default(false).describe("是否按住 Shift 点击（快速转移物品）"),
  }),
  async run(ctx, { slot, button, shift }) {
    const { bot } = ctx;
    const win = bot.currentWindow;
    if (!win) throw new ActionError("当前没有打开的窗口，先打开菜单");
    if (slot >= win.slots.length) throw new ActionError(`格子 ${slot} 超出范围（0-${win.slots.length - 1}）`);
    const listen = captureMessages(bot, 1_200);
    await bot.clickWindow(slot, button === "left" ? 0 : 1, shift ? 1 : 0);
    const messages = await listen;
    return windowOrMessages(bot, messages);
  },
});

export const closeWindow = defineAction({
  name: "close_window",
  description: "关闭当前打开的窗口。",
  risk: "low",
  schema: z.object({}),
  async run(ctx) {
    const win = ctx.bot.currentWindow;
    if (!win) return "本来就没有打开的窗口";
    ctx.bot.closeWindow(win);
    return "已关闭窗口";
  },
});

/**
 * Find an entity by the name shown above it. Handles player-type NPCs (Citizens), mobs with
 * name tags, and hologram name tags (armor stands / text displays floating above the real NPC).
 */
export function findEntityByName(bot: Bot, query: string, radius = 48): Entity | null {
  const q = normalizeName(query);
  const me = bot.entity.position;
  const all = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position.distanceTo(me) <= radius);
  const labelOf = (e: Entity) => normalizeName(entityLabel(e));
  const matches = all.filter((e) => {
    const l = labelOf(e);
    return l === q || (q.length >= 2 && l.includes(q));
  });
  const holograms = new Set(["armor_stand", "text_display", "interaction", "area_effect_cloud"]);
  const resolved = matches.map((e) => {
    if (!holograms.has(e.name ?? "")) return e;
    // A floating name: pick the real entity standing right below it.
    const below = all
      .filter((o) => !holograms.has(o.name ?? "") && o !== e)
      .filter((o) => Math.hypot(o.position.x - e.position.x, o.position.z - e.position.z) < 1.5)
      .filter((o) => e.position.y - o.position.y >= -0.5 && e.position.y - o.position.y < 4)
      .sort((a, b) => a.position.distanceTo(e.position) - b.position.distanceTo(e.position))[0];
    return below ?? e;
  });
  resolved.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return resolved[0] ?? null;
}

export const interactEntity = defineAction({
  name: "interact_entity",
  description:
    "走到一个 NPC/生物/玩家旁边并点击它。name 填头顶显示的名字（部分匹配即可）。服务器 NPC 一般是右键打开菜单；少数 NPC 要左键。返回打开的菜单内容或服务器消息。",
  risk: "medium",
  schema: z.object({
    name: z.string(),
    click: z.enum(["right", "left"]).default("right"),
  }),
  async run(ctx, { name, click }) {
    const { bot } = ctx;
    const target = findEntityByName(bot, name);
    if (!target) throw new ActionError(`附近 48 格内没有找到名字包含"${name}"的实体`);
    if (target.position.distanceTo(bot.entity.position) > 3) {
      bot.pathfinder.setMovements(travelMovements(bot, ctx.config));
      const p = target.position;
      await guarded(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), {
        signal: ctx.signal,
        timeoutMs: 60_000,
        cancel: () => bot.pathfinder.stop(),
        what: "走到目标旁边",
      });
    }
    await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
    const listen = captureMessages(bot, 2_000);
    const opened = waitForWindow(bot, 2_000);
    if (click === "right") await bot.activateEntity(target);
    else bot.attack(target);
    const [messages, win] = await Promise.all([listen, opened]);
    if (win) await sleep(300);
    return `已${click === "right" ? "右键" : "左键"}点击「${entityLabel(target)}」\n${windowOrMessages(bot, messages)}`;
  },
});

export const useHeldItem = defineAction({
  name: "use_held_item",
  description: "右键使用手里的物品（例如右键指南针/钟打开服务器菜单）。可以先指定要拿到手上的物品。",
  risk: "medium",
  schema: z.object({ item: z.string().optional().describe("先拿到手上的物品 ID，不填就用当前手持物品") }),
  async run(ctx, { item }) {
    const { bot } = ctx;
    if (item) {
      const found = findInventoryItem(bot, item);
      if (!found) throw new ActionError(`背包里没有 ${item}`);
      await bot.equip(found, "hand");
    }
    const listen = captureMessages(bot, 2_000);
    const opened = waitForWindow(bot, 2_000);
    bot.activateItem();
    await sleep(150);
    bot.deactivateItem();
    const [messages, win] = await Promise.all([listen, opened]);
    if (win) await sleep(300);
    return windowOrMessages(bot, messages);
  },
});

export const interactActions = [runCommand, listServerCommands, readWindow, clickSlot, closeWindow, interactEntity, useHeldItem];
