/**
 * Survival actions: smelting, chests, placing blocks, fighting mobs, sleeping, villager trading,
 * eating. The approach follows Mindcraft's skills (https://github.com/mindcraft-bots/mindcraft,
 * MIT License, Copyright (c) 2024 Kolby Nottingham; see THIRD_PARTY_NOTICES.md), rewritten for
 * this project's tool format, prechecks and safety rules: never attack players, never break an
 * existing block to place one, and chest steps remember which chest they used.
 */
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { z } from "zod";
import { findPlaceSpot } from "./gather.js";
import { walkNear } from "./movement.js";
import { ActionError, defineAction, type ActionContext } from "./types.js";
import { findInventoryItem, guarded, sleep, throwIfAborted } from "./util.js";

// ---------------------------------------------------------------- helpers

const CHEST_BLOCKS = new Set(["chest", "trapped_chest", "barrel"]);

function blockIdsWhere(bot: Bot, test: (name: string) => boolean): number[] {
  return Object.values(bot.registry.blocksByName).filter((b) => test(b.name)).map((b) => b.id);
}

function totalCount(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

/** A chest at the given coordinates, or the nearest one within 32 blocks. */
function findChest(bot: Bot, at?: { x?: number; y?: number; z?: number }): Block | null {
  if (at && at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    const b = bot.blockAt(new Vec3(at.x, at.y, at.z));
    return b && CHEST_BLOCKS.has(b.name) ? b : null;
  }
  return bot.findBlock({ matching: blockIdsWhere(bot, (n) => CHEST_BLOCKS.has(n)), maxDistance: 32 });
}

async function openChest(ctx: ActionContext, chest: Block) {
  await walkNear(ctx, chest.position, 3, "走到箱子旁边");
  await ctx.bot.lookAt(chest.position.offset(0.5, 0.5, 0.5), true);
  const win = await ctx.bot.openContainer(chest);
  await sleep(300, ctx.signal); // let the contents arrive (same race as crafting tables)
  return win;
}

function chestMeta(chest: Block) {
  return { chestAt: { x: chest.position.x, y: chest.position.y, z: chest.position.z } };
}

const chestCoords = {
  x: z.number().int().optional().describe("箱子坐标；不填就用附近最近的箱子"),
  y: z.number().int().optional(),
  z: z.number().int().optional(),
};

/** Best weapon in the inventory (by rough attack damage), or null. */
function bestWeapon(bot: Bot): Item | null {
  const order = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
  const score = (n: string) => {
    const kind = n.endsWith("_sword") ? 10 : n.endsWith("_axe") ? 8 : -1;
    if (kind < 0) return -1;
    const tier = order.findIndex((t) => n.startsWith(t));
    return kind + (tier < 0 ? 0 : order.length - tier);
  };
  return bot.inventory.items().filter((i) => score(i.name) >= 0).sort((a, b) => score(b.name) - score(a.name))[0] ?? null;
}

function nearestMob(bot: Bot, mob: string, radius = 24): Entity | undefined {
  const name = mob.toLowerCase().replace(/^minecraft:/, "");
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.type !== "player" && e.name === name && e.position.distanceTo(bot.entity.position) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

function nearestVillager(bot: Bot, name?: string): Entity | undefined {
  const want = name?.replace(/\s+/g, "").toLowerCase();
  return Object.values(bot.entities)
    .filter((e) => e.name === "villager" && e.position.distanceTo(bot.entity.position) <= 32)
    .filter((e) => !want || (e.getCustomName?.()?.toString() ?? "").replace(/\s+/g, "").toLowerCase().includes(want))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

/** Fuel items and how many items each one smelts. */
const FUEL: Array<[(n: string) => boolean, number]> = [
  [(n) => n === "coal_block", 80],
  [(n) => n === "lava_bucket", 100],
  [(n) => n === "blaze_rod", 12],
  [(n) => n === "coal" || n === "charcoal", 8],
  [(n) => n.endsWith("_log") || n.endsWith("_planks"), 1.5],
  [(n) => n === "stick", 0.5],
];

function pickFuel(bot: Bot, exclude: string): { item: Item; perItem: number } | null {
  for (const [test, perItem] of FUEL) {
    const item = bot.inventory.items().find((i) => test(i.name) && i.name !== exclude);
    if (item) return { item, perItem };
  }
  return null;
}

function itemId(bot: Bot, name: string): number {
  const info = bot.registry.itemsByName[name.toLowerCase().replace(/^minecraft:/, "")];
  if (!info) throw new ActionError(`不认识物品 "${name}"，请用英文 ID`);
  return info.id;
}

// ---------------------------------------------------------------- smelting

export const smeltItem = defineAction({
  name: "smelt_item",
  description:
    "用熔炉烧东西（例如 raw_iron→铁锭、beef→牛排、sand→玻璃、cobblestone→石头、oak_log→木炭）。附近没有熔炉会从背包里放一个。燃料自动用煤、木炭、木头等。每个大约 10 秒。",
  risk: "medium",
  schema: z.object({ item: z.string(), count: z.number().int().min(1).max(64).default(1) }),
  precheck(ctx, { item }) {
    const { bot } = ctx;
    if (!findInventoryItem(bot, item)) return `背包里没有 ${item}`;
    const furnace = bot.findBlock({ matching: blockIdsWhere(bot, (n) => n === "furnace"), maxDistance: 32 });
    if (!furnace && totalCount(bot, "furnace") === 0) return "附近没有熔炉，背包里也没有";
    return null;
  },
  async run(ctx, { item, count }) {
    const { bot } = ctx;
    const name = item.toLowerCase().replace(/^minecraft:/, "");
    const inputId = itemId(bot, name);
    const have = totalCount(bot, name);
    if (have === 0) throw new ActionError(`背包里没有 ${name}`);
    const n = Math.min(count, have);

    const furnaceIds = blockIdsWhere(bot, (b) => b === "furnace");
    let furnaceBlock = bot.findBlock({ matching: furnaceIds, maxDistance: 32 });
    let placed = false;
    if (!furnaceBlock) {
      const furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
      if (!furnaceItem) throw new ActionError("附近没有熔炉，背包里也没有。可以先合成一个 furnace（8 个圆石）");
      const spot = findPlaceSpot(bot);
      if (!spot) throw new ActionError("想放熔炉但身边没有空位");
      await bot.equip(furnaceItem, "hand");
      await bot.placeBlock(spot, new Vec3(0, 1, 0));
      furnaceBlock = bot.findBlock({ matching: furnaceIds, maxDistance: 6 });
      if (!furnaceBlock) throw new ActionError("放置熔炉失败");
      placed = true;
    }
    await walkNear(ctx, furnaceBlock.position, 3, "走到熔炉旁边");
    await bot.lookAt(furnaceBlock.position.offset(0.5, 0.5, 0.5), true);
    const furnace = await bot.openFurnace(furnaceBlock);
    let got = 0;
    let outputName = "";
    try {
      await sleep(300, ctx.signal);
      const busy = furnace.inputItem();
      if (busy && busy.type !== inputId && busy.count > 0) throw new ActionError(`这个熔炉正在烧 ${busy.name}，先等它烧完`);
      if (!furnace.fuelItem()) {
        const fuel = pickFuel(bot, name);
        if (!fuel) throw new ActionError("没有燃料（煤、木炭、木头都行）");
        const need = Math.min(fuel.item.count, Math.ceil(n / fuel.perItem));
        await furnace.putFuel(fuel.item.type, null, need);
      }
      await furnace.putInput(inputId, null, n);
      let lastProgress = Date.now();
      const deadline = Date.now() + n * 12_000 + 20_000;
      while (got < n && Date.now() < deadline) {
        throwIfAborted(ctx.signal);
        await sleep(1_000, ctx.signal);
        const out = furnace.outputItem();
        if (out) {
          const taken = await furnace.takeOutput();
          if (taken) {
            got += taken.count;
            outputName = taken.name;
            lastProgress = Date.now();
          }
        }
        if (Date.now() - lastProgress > 13_000) break; // nothing came out for a while: out of fuel?
      }
    } finally {
      if (furnace.inputItem()) await furnace.takeInput().catch(() => {});
      if (furnace.fuelItem()) await furnace.takeFuel().catch(() => {});
      furnace.close();
    }
    if (got === 0) throw new ActionError(`没有烧出东西：${name} 可能不能烧，或者燃料不够`);
    return {
      text: `烧好了 ${outputName}×${got}${got < n ? `（想烧 ${n} 个）` : ""}${placed ? "，熔炉留在原地" : ""}`,
      meta: { gained: outputName },
    };
  },
});

// ---------------------------------------------------------------- chests

export const viewChest = defineAction({
  name: "view_chest",
  description: "看箱子里有什么（附近最近的箱子，或者给坐标）。",
  risk: "low",
  schema: z.object(chestCoords),
  precheck(ctx, at) {
    return findChest(ctx.bot, at) ? null : at.x !== undefined ? "那个位置没有箱子" : "附近 32 格内没有箱子";
  },
  async run(ctx, at) {
    const chest = findChest(ctx.bot, at);
    if (!chest) throw new ActionError("附近 32 格内没有箱子");
    const win = await openChest(ctx, chest);
    const counts = new Map<string, number>();
    for (const i of win.containerItems()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    win.close();
    const list = [...counts].map(([n, c]) => `${n}×${c}`).join(", ");
    return { text: `箱子 ${chest.position.toString()} 里：${list || "空的"}`, meta: chestMeta(chest) };
  },
});

export const putInChest = defineAction({
  name: "put_in_chest",
  description: "把背包里的东西放进箱子（附近最近的箱子，或者给坐标）。count 不填就放全部。",
  risk: "medium",
  schema: z.object({ item: z.string(), count: z.number().int().min(1).optional(), ...chestCoords }),
  precheck(ctx, { item, ...at }) {
    if (!findInventoryItem(ctx.bot, item)) return `背包里没有 ${item}`;
    return findChest(ctx.bot, at) ? null : at.x !== undefined ? "那个位置没有箱子" : "附近 32 格内没有箱子";
  },
  async run(ctx, { item, count, ...at }) {
    const { bot } = ctx;
    const found = findInventoryItem(bot, item);
    if (!found) throw new ActionError(`背包里没有 ${item}`);
    const chest = findChest(bot, at);
    if (!chest) throw new ActionError("附近 32 格内没有箱子");
    const n = Math.min(count ?? totalCount(bot, found.name), totalCount(bot, found.name));
    const win = await openChest(ctx, chest);
    try {
      await win.deposit(found.type, null, n);
    } catch (err) {
      throw new ActionError(`放不进去：${(err as Error).message}（箱子可能满了）`);
    } finally {
      win.close();
    }
    return { text: `把 ${found.name}×${n} 放进了箱子 ${chest.position.toString()}`, meta: chestMeta(chest) };
  },
});

export const takeFromChest = defineAction({
  name: "take_from_chest",
  description: "从箱子里拿东西（附近最近的箱子，或者给坐标）。count 不填就拿全部。",
  risk: "medium",
  schema: z.object({ item: z.string(), count: z.number().int().min(1).optional(), ...chestCoords }),
  precheck(ctx, { item: _item, ...at }) {
    return findChest(ctx.bot, at) ? null : at.x !== undefined ? "那个位置没有箱子" : "附近 32 格内没有箱子";
  },
  async run(ctx, { item, count, ...at }) {
    const { bot } = ctx;
    const id = itemId(bot, item);
    const chest = findChest(bot, at);
    if (!chest) throw new ActionError("附近 32 格内没有箱子");
    const win = await openChest(ctx, chest);
    let n = 0;
    try {
      const available = win.containerItems().filter((i) => i.type === id).reduce((s, i) => s + i.count, 0);
      if (available === 0) throw new ActionError(`箱子里没有 ${item}`);
      n = Math.min(count ?? available, available);
      await win.withdraw(id, null, n);
    } finally {
      win.close();
    }
    return { text: `从箱子 ${chest.position.toString()} 拿了 ${item}×${n}`, meta: { ...chestMeta(chest), gained: item } };
  },
});

// ---------------------------------------------------------------- placing blocks

const EMPTY = new Set(["air", "cave_air", "short_grass", "grass", "tall_grass", "fern", "dead_bush", "snow", "water"]);
const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

export const placeBlock = defineAction({
  name: "place_block",
  description: "从背包里拿一个方块放到指定坐标；不给坐标就放在自己身边。目标位置已经有方块时不会把它挖掉。",
  risk: "medium",
  schema: z.object({
    block: z.string(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    z: z.number().int().optional(),
  }),
  precheck(ctx, { block }) {
    return findInventoryItem(ctx.bot, block) ? null : `背包里没有 ${block}`;
  },
  async run(ctx, { block, x, y, z: zc }) {
    const { bot } = ctx;
    const item = findInventoryItem(bot, block);
    if (!item) throw new ActionError(`背包里没有 ${block}`);
    let target: Vec3;
    if (x !== undefined && y !== undefined && zc !== undefined) {
      target = new Vec3(x, y, zc);
    } else {
      const spot = findPlaceSpot(bot);
      if (!spot) throw new ActionError("身边没有能放方块的空位");
      target = spot.position.offset(0, 1, 0);
    }
    const current = bot.blockAt(target);
    if (!current) throw new ActionError("那个位置太远了，看不到");
    if (!EMPTY.has(current.name)) throw new ActionError(`那里已经有 ${current.name} 了，不会把它挖掉`);
    // Something solid next to the target to place against.
    let against: Block | null = null;
    let face: Vec3 | null = null;
    for (const f of FACES) {
      const b = bot.blockAt(target.plus(f));
      if (b && b.boundingBox === "block") {
        against = b;
        face = f.scaled(-1);
        break;
      }
    }
    if (!against || !face) throw new ActionError("那个位置旁边没有能贴着放的方块（不能悬空放）");
    await walkNear(ctx, target, 3, "走到放方块的地方");
    const feet = bot.entity.position.floored();
    if (feet.equals(target) || feet.offset(0, 1, 0).equals(target)) throw new ActionError("自己站在那个位置上，先让开");
    await bot.equip(item, "hand");
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
    try {
      await bot.placeBlock(against, face);
    } catch (err) {
      // placeBlock sometimes times out waiting for the update even though it worked
      if (bot.blockAt(target)?.name !== item.name) throw new ActionError(`放置失败：${(err as Error).message}`);
    }
    return `在 ${target.toString()} 放了 ${item.name}`;
  },
});

// ---------------------------------------------------------------- fighting

export const attackMob = defineAction({
  name: "attack_mob",
  description:
    "攻击附近（24 格内）的某种生物直到打死，然后捡起掉落物。mob 用英文 ID（zombie、skeleton、spider、cow、pig、chicken…）。不会攻击玩家。",
  risk: "medium",
  schema: z.object({ mob: z.string(), count: z.number().int().min(1).max(10).default(1) }),
  precheck(ctx, { mob }) {
    if (["player", "villager"].includes(mob.toLowerCase())) return "不攻击玩家和村民";
    return nearestMob(ctx.bot, mob) ? null : `附近 24 格内没有 ${mob}`;
  },
  async run(ctx, { mob, count }) {
    const { bot } = ctx;
    if (["player", "villager"].includes(mob.toLowerCase())) throw new ActionError("不攻击玩家和村民");
    const weapon = bestWeapon(bot);
    if (weapon) await bot.equip(weapon, "hand");
    let killed = 0;
    for (let k = 0; k < count; k++) {
      const target = nearestMob(bot, mob);
      if (!target) break;
      const deadline = Date.now() + 45_000;
      while (bot.entities[target.id] && target.isValid !== false && Date.now() < deadline) {
        throwIfAborted(ctx.signal);
        const d = bot.entity.position.distanceTo(target.position);
        if (d > 3) {
          await guarded(walkNear(ctx, target.position, 2, "追上目标", 8_000), {
            signal: ctx.signal,
            timeoutMs: 10_000,
            cancel: () => bot.pathfinder.stop(),
            what: "追击",
          }).catch((err) => {
            if (ctx.signal.aborted) throw err;
          });
          continue;
        }
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
        bot.attack(target);
        await sleep(650, ctx.signal); // attack cooldown
      }
      if (bot.entities[target.id]) break; // could not finish it in time
      killed++;
      // Pick up what it dropped.
      const drops = Object.values(bot.entities).filter((e) => e.name === "item" && e.position.distanceTo(target.position) < 6);
      for (const d of drops) await walkNear(ctx, d.position, 0.5, "捡掉落物", 8_000).catch(() => {});
    }
    if (killed === 0) throw new ActionError(`没打死 ${mob}`);
    return `打死了 ${mob}×${killed}`;
  },
});

// ---------------------------------------------------------------- sleeping, eating

export const sleepInBed = defineAction({
  name: "sleep",
  description: "去附近（32 格内）的床上睡觉。只能在晚上或雷雨天睡。躺下后就返回，天亮会自己起床；说\"停\"也会起来。",
  risk: "low",
  schema: z.object({}),
  precheck(ctx) {
    return ctx.bot.findBlock({ matching: blockIdsWhere(ctx.bot, (n) => n.endsWith("_bed")), maxDistance: 32 }) ? null : "附近 32 格内没有床";
  },
  async run(ctx) {
    const { bot } = ctx;
    const bed = bot.findBlock({ matching: blockIdsWhere(bot, (n) => n.endsWith("_bed")), maxDistance: 32 });
    if (!bed) throw new ActionError("附近 32 格内没有床");
    await walkNear(ctx, bed.position, 2, "走到床边");
    try {
      await bot.sleep(bed);
    } catch (err) {
      throw new ActionError(`睡不了：${(err as Error).message}`);
    }
    return "躺下睡觉了";
  },
});

export const eat = defineAction({
  name: "eat",
  description: "吃东西。不指定就自动挑背包里最好的食物（不吃腐肉、毒马铃薯这类）。",
  risk: "low",
  schema: z.object({ item: z.string().optional() }),
  precheck(ctx, { item }) {
    if (item) return findInventoryItem(ctx.bot, item) ? null : `背包里没有 ${item}`;
    return bestFood(ctx.bot) ? null : "背包里没有能吃的东西";
  },
  async run(ctx, { item }) {
    const { bot } = ctx;
    const food = item ? findInventoryItem(bot, item) : bestFood(bot);
    if (!food) throw new ActionError(item ? `背包里没有 ${item}` : "背包里没有能吃的东西");
    if (bot.food >= 20 && food.name !== "golden_apple") throw new ActionError("现在不饿，吃不下");
    await bot.equip(food, "hand");
    await bot.consume();
    return `吃了 ${food.name}，饥饿值 ${Math.round(bot.food)}/20`;
  },
});

const BAD_FOOD = new Set(["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "suspicious_stew", "chorus_fruit"]);
function bestFood(bot: Bot): Item | undefined {
  const foods = bot.registry.foodsByName;
  return bot.inventory
    .items()
    .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
    .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0];
}

// ---------------------------------------------------------------- villagers

function describeTradeItem(i: Item | null | undefined): string {
  return i?.name ? `${i.name}×${i.count}` : "";
}

/** The second price item, only if the trade really has one (Mineflayer fills an empty placeholder). */
function secondInput(t: { hasItem2: boolean; inputItem2: Item | null }): Item | null {
  return t.hasItem2 && t.inputItem2?.name ? t.inputItem2 : null;
}

async function openNearestVillager(ctx: ActionContext, name?: string) {
  const v = nearestVillager(ctx.bot, name);
  if (!v) throw new ActionError(name ? `附近没有叫"${name}"的村民` : "附近 32 格内没有村民");
  await walkNear(ctx, v.position, 2.5, "走到村民旁边");
  try {
    const win = await ctx.bot.openVillager(v);
    await sleep(300, ctx.signal);
    return win;
  } catch (err) {
    throw new ActionError(`打不开交易界面：${(err as Error).message}（村民可能在睡觉、是小孩或者没有职业）`);
  }
}

export const villagerTrades = defineAction({
  name: "villager_trades",
  description: "查看附近村民卖什么（交易列表，带编号）。",
  risk: "low",
  schema: z.object({ name: z.string().optional().describe("村民头上的名字，不填就找最近的") }),
  precheck(ctx, { name }) {
    return nearestVillager(ctx.bot, name) ? null : "附近 32 格内没有村民";
  },
  async run(ctx, { name }) {
    const win = await openNearestVillager(ctx, name);
    const trades = win.trades ?? [];
    win.close();
    if (!trades.length) throw new ActionError("这个村民没有交易（可能是小孩、在睡觉或没职业）");
    return trades
      .map((t, i) => {
        const pay = [describeTradeItem(t.inputItem1), describeTradeItem(secondInput(t))].filter(Boolean).join(" + ");
        const left = t.maximumNbTradeUses - t.nbTradeUses;
        return `${i + 1}: ${pay} → ${describeTradeItem(t.outputItem)}${t.tradeDisabled || left <= 0 ? "（暂时卖完）" : `（还能换 ${left} 次）`}`;
      })
      .join("\n");
  },
});

export const tradeWithVillager = defineAction({
  name: "trade_with_villager",
  description: "和附近村民交易：index 是 villager_trades 列表里的编号，times 是交易次数。",
  risk: "medium",
  schema: z.object({
    index: z.number().int().min(1),
    times: z.number().int().min(1).max(12).default(1),
    name: z.string().optional(),
  }),
  precheck(ctx, { name }) {
    return nearestVillager(ctx.bot, name) ? null : "附近 32 格内没有村民";
  },
  async run(ctx, { index, times, name }) {
    const { bot } = ctx;
    const win = await openNearestVillager(ctx, name);
    try {
      const trade = win.trades?.[index - 1];
      if (!trade) throw new ActionError(`没有第 ${index} 个交易（一共 ${win.trades?.length ?? 0} 个）`);
      const left = trade.maximumNbTradeUses - trade.nbTradeUses;
      if (trade.tradeDisabled || left <= 0) throw new ActionError("这个交易暂时卖完了");
      const n = Math.min(times, left);
      const second = secondInput(trade);
      const enough = (i: Item | null) => !i || totalCount(bot, i.name) >= i.count * n;
      if (!enough(trade.inputItem1) || !enough(second)) {
        throw new ActionError(`材料不够交易 ${n} 次：需要 ${[describeTradeItem(trade.inputItem1), describeTradeItem(second)].filter(Boolean).join(" + ")} ×${n}`);
      }
      await bot.trade(win, index - 1, n);
      return { text: `交易了 ${n} 次：得到 ${trade.outputItem.name}×${trade.outputItem.count * n}`, meta: { gained: trade.outputItem.name } };
    } finally {
      win.close();
    }
  },
});

export const survivalActions = [
  smeltItem, viewChest, putInChest, takeFromChest, placeBlock, attackMob, sleepInBed, eat, villagerTrades, tradeWithVillager,
];
