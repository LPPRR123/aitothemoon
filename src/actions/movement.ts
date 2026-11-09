import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { z } from "zod";
import type { Config } from "../config.js";
import { ActionError, defineAction } from "./types.js";
import { guarded } from "./util.js";

const { Movements, goals } = pathfinderPkg;

/** Movement rules for walking around. Digging/placing is off unless enabled in config. */
export function travelMovements(bot: Bot, config: Config) {
  const m = new Movements(bot);
  m.canDig = config.movement.allowDig;
  if (!config.movement.allowPlace) {
    m.allow1by1towers = false;
    m.scafoldingBlocks = [];
  }
  m.allowSprinting = true;
  return m;
}

export function stopEverything(bot: Bot): void {
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
  bot.collectBlock?.cancelTask().catch(() => {});
  bot.stopDigging();
  bot.clearControlStates();
}

export function findPlayerEntity(bot: Bot, name: string) {
  const exact = bot.players[name]?.entity;
  if (exact) return exact;
  const lower = name.toLowerCase();
  const key = Object.keys(bot.players).find((n) => n.toLowerCase() === lower);
  return key ? bot.players[key]?.entity : undefined;
}

const PATH_TIMEOUT = 120_000;

export const goTo = defineAction({
  name: "go_to",
  description: "走到指定坐标附近。长距离会花一些时间；路线走不通时会返回错误。",
  risk: "low",
  schema: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    range: z.number().min(0).max(16).default(1).describe("离目标多近算到达，默认 1 格"),
  }),
  async run(ctx, { x, y, z, range }) {
    const { bot } = ctx;
    bot.pathfinder.setMovements(travelMovements(bot, ctx.config));
    await guarded(bot.pathfinder.goto(new goals.GoalNear(x, y, z, range)), {
      signal: ctx.signal,
      timeoutMs: PATH_TIMEOUT,
      cancel: () => bot.pathfinder.stop(),
      what: "寻路",
    });
    return `已到达 ${bot.entity.position.floored().toString()}`;
  },
});

export const goToPlayer = defineAction({
  name: "go_to_player",
  description: "走到某个玩家身边（对方需要在视野范围内，大约 100 格以内）。",
  risk: "low",
  schema: z.object({
    player: z.string().describe("玩家名"),
    distance: z.number().min(1).max(10).default(2),
  }),
  precheck(ctx, { player }) {
    return findPlayerEntity(ctx.bot, player) ? null : `看不到玩家 ${player}`;
  },
  async run(ctx, { player, distance }) {
    const { bot } = ctx;
    const target = findPlayerEntity(bot, player);
    if (!target) throw new ActionError(`看不到玩家 ${player}，可能离得太远或不在线。可以请主人给坐标，或用传送指令。`);
    bot.pathfinder.setMovements(travelMovements(bot, ctx.config));
    const p = target.position;
    await guarded(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, distance)), {
      signal: ctx.signal,
      timeoutMs: PATH_TIMEOUT,
      cancel: () => bot.pathfinder.stop(),
      what: "寻路",
    });
    return `已走到 ${player} 身边`;
  },
});

export const followPlayer = defineAction({
  name: "follow_player",
  description: "开始持续跟随某个玩家。这个动作会在后台一直进行，直到调用 stop 或开始别的移动。",
  risk: "low",
  schema: z.object({
    player: z.string(),
    distance: z.number().min(1).max(10).default(2),
  }),
  precheck(ctx, { player }) {
    return findPlayerEntity(ctx.bot, player) ? null : `看不到玩家 ${player}`;
  },
  async run(ctx, { player, distance }) {
    const { bot } = ctx;
    const target = findPlayerEntity(bot, player);
    if (!target) throw new ActionError(`看不到玩家 ${player}，没法跟随。`);
    bot.pathfinder.setMovements(travelMovements(bot, ctx.config));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true);
    return `开始跟随 ${player}（后台进行中，说"停"可以停下）`;
  },
});

export const stop = defineAction({
  name: "stop",
  description: "停止所有移动、跟随、挖掘。",
  risk: "low",
  schema: z.object({}),
  async run(ctx) {
    stopEverything(ctx.bot);
    return "已停止所有动作";
  },
});

export const movementActions = [goTo, goToPlayer, followPlayer, stop];
