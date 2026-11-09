import { z } from "zod";
import { observe } from "../bot/perception.js";
import { findPlayerEntity } from "./movement.js";
import { ActionError, defineAction } from "./types.js";
import { findInventoryItem } from "./util.js";

type Slot = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

function armorSlot(name: string): Slot | null {
  if (name.endsWith("_helmet") || name === "turtle_helmet") return "head";
  if (name.endsWith("_chestplate") || name === "elytra") return "torso";
  if (name.endsWith("_leggings")) return "legs";
  if (name.endsWith("_boots")) return "feet";
  return null;
}

export const getStatus = defineAction({
  name: "get_status",
  description: "查看自己当前的状态：位置、生命、饥饿、背包、附近的玩家/生物/重要方块、打开的窗口。",
  risk: "low",
  schema: z.object({}),
  async run(ctx) {
    return observe(ctx.bot);
  },
});

export const equip = defineAction({
  name: "equip",
  description: "把背包里的物品拿到手上或穿上（盔甲会自动穿到对应位置）。",
  risk: "low",
  schema: z.object({
    item: z.string().describe("物品英文 ID，例如 iron_sword、diamond_helmet"),
    offhand: z.boolean().default(false).describe("放到副手"),
  }),
  precheck(ctx, { item }) {
    return findInventoryItem(ctx.bot, item) ? null : `背包里没有 ${item}`;
  },
  async run(ctx, { item, offhand }) {
    const found = findInventoryItem(ctx.bot, item);
    if (!found) throw new ActionError(`背包里没有 ${item}`);
    const slot: Slot = offhand ? "off-hand" : armorSlot(found.name) ?? "hand";
    await ctx.bot.equip(found, slot);
    return `已装备 ${found.name} 到 ${slot}`;
  },
});

export const giveItem = defineAction({
  name: "give_item",
  description: "把背包里的物品丢给附近的玩家（会先面向对方再丢出）。count 不填就丢全部。",
  risk: "high",
  schema: z.object({
    item: z.string(),
    count: z.number().int().min(1).optional(),
    player: z.string().optional().describe("丢给谁，默认是主人"),
  }),
  precheck(ctx, { item, player }) {
    if (!findInventoryItem(ctx.bot, item)) return `背包里没有 ${item}`;
    return findPlayerEntity(ctx.bot, player ?? ctx.owner) ? null : `看不到 ${player ?? ctx.owner}`;
  },
  async run(ctx, { item, count, player }) {
    const { bot } = ctx;
    const to = player ?? ctx.owner;
    if (to !== ctx.owner) throw new ActionError("只能把物品给主人。如需给别人，请主人自己操作。");
    const found = findInventoryItem(bot, item);
    if (!found) throw new ActionError(`背包里没有 ${item}`);
    const target = findPlayerEntity(bot, to);
    if (!target) throw new ActionError(`看不到 ${to}，先走到对方身边`);
    if (target.position.distanceTo(bot.entity.position) > 6) throw new ActionError(`${to} 离得太远，先用 go_to_player 走过去`);
    await bot.lookAt(target.position.offset(0, 1.2, 0), true);
    const total = bot.inventory.count(found.type, null);
    const n = Math.min(count ?? total, total);
    await bot.toss(found.type, null, n);
    return `已把 ${found.name}×${n} 丢给 ${to}`;
  },
});

export const inventoryActions = [getStatus, equip, giveItem];
