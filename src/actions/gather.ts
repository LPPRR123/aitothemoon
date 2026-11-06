import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { Vec3 } from "vec3";
import { z } from "zod";
import { ActionError, defineAction, type ActionContext } from "./types.js";
import { guarded, sleep, throwIfAborted, waitFor, waitForWindow } from "./util.js";
import { travelMovements } from "./movement.js";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;

const BLOCK_ALIASES: Record<string, (name: string) => boolean> = {
  log: (n) => n.endsWith("_log") && !n.startsWith("stripped_"),
  logs: (n) => n.endsWith("_log") && !n.startsWith("stripped_"),
  wood: (n) => n.endsWith("_log") && !n.startsWith("stripped_"),
  planks: (n) => n.endsWith("_planks"),
  ore: (n) => n.endsWith("_ore"),
  leaves: (n) => n.endsWith("_leaves"),
};

/** Resolve a block name or category ("oak_log", "log", "iron_ore", "ore") to block ids. */
export function resolveBlockIds(bot: Bot, query: string): { ids: number[]; names: string[] } {
  const q = query.toLowerCase().trim().replace(/^minecraft:/, "");
  const all = Object.values(bot.registry.blocksByName);
  const pick = (test: (n: string) => boolean) => all.filter((b) => test(b.name));
  let found = bot.registry.blocksByName[q] ? [bot.registry.blocksByName[q]!] : [];
  if (!found.length && BLOCK_ALIASES[q]) found = pick(BLOCK_ALIASES[q]!);
  if (!found.length) found = pick((n) => n.endsWith(`_${q}`));
  if (!found.length) found = pick((n) => n.includes(q));
  return { ids: found.map((b) => b.id), names: found.map((b) => b.name) };
}

function countItems(bot: Bot): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
}

function inventoryDelta(before: Map<string, number>, after: Map<string, number>): string {
  const parts: string[] = [];
  for (const [name, n] of after) {
    const d = n - (before.get(name) ?? 0);
    if (d > 0) parts.push(`${name}+${d}`);
  }
  return parts.length ? parts.join(", ") : "没有新物品";
}

export const collectBlock = defineAction({
  name: "collect_block",
  description:
    "在附近（64 格内）寻找并挖掘指定方块，捡起掉落物。block 用英文 ID（如 oak_log、stone、iron_ore），也可以用类别 log / ore / planks。",
  risk: "medium",
  schema: z.object({
    block: z.string(),
    count: z.number().int().min(1).max(64).default(1),
  }),
  async run(ctx, { block, count }) {
    const { bot } = ctx;
    const { ids, names } = resolveBlockIds(bot, block);
    if (!ids.length) throw new ActionError(`不认识方块 "${block}"，请用英文 ID，例如 oak_log`);
    const before = countItems(bot);
    let mined = 0;
    const started = Date.now();
    while (mined < count) {
      throwIfAborted(ctx.signal);
      if (Date.now() - started > 300_000) break;
      const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: Math.min(count - mined, 6) });
      const targets = positions.map((p) => bot.blockAt(p)).filter((b): b is Block => !!b);
      if (!targets.length) break;
      try {
        await guarded(bot.collectBlock.collect(targets, { ignoreNoPath: true }), {
          signal: ctx.signal,
          timeoutMs: 120_000,
          cancel: () => bot.collectBlock.cancelTask().catch(() => {}),
          what: "挖掘",
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warn(`挖掘出错：${(err as Error).message}`);
      }
      const brokenNow = targets.filter((t) => !ids.includes(bot.blockAt(t.position)?.type ?? -1)).length;
      if (brokenNow === 0) break; // nothing reachable
      mined += brokenNow;
    }
    const delta = inventoryDelta(before, countItems(bot));
    if (mined === 0) {
      throw new ActionError(`附近 64 格内没有找到能挖到的 ${names.slice(0, 3).join("/")}`);
    }
    return `挖掉了 ${mined} 个方块（目标 ${count}），背包变化：${delta}`;
  },
});

/** Find a spot next to the bot where a block can be placed on top of a solid block. */
function findPlaceSpot(bot: Bot): Block | null {
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2]]) {
    const below = bot.blockAt(base.offset(dx!, -1, dz!));
    const at = bot.blockAt(base.offset(dx!, 0, dz!));
    const above = bot.blockAt(base.offset(dx!, 1, dz!));
    if (below && below.boundingBox === "block" && at?.name === "air" && above?.name === "air") return below;
  }
  return null;
}

async function ensureCraftingTable(ctx: ActionContext): Promise<Block> {
  const { bot } = ctx;
  const tableId = bot.registry.blocksByName.crafting_table!.id;
  let table = bot.findBlock({ matching: tableId, maxDistance: 32 });
  if (!table) {
    const item = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!item) throw new ActionError("这个配方需要工作台：附近没有，背包里也没有。可以先合成一个 crafting_table。");
    const spot = findPlaceSpot(bot);
    if (!spot) throw new ActionError("想放工作台但身边没有空位");
    await bot.equip(item, "hand");
    await bot.placeBlock(spot, new Vec3(0, 1, 0));
    table = bot.findBlock({ matching: tableId, maxDistance: 6 });
    if (!table) throw new ActionError("放置工作台失败");
  }
  if (table.position.distanceTo(bot.entity.position) > 4) {
    bot.pathfinder.setMovements(travelMovements(bot, ctx.config));
    const p = table.position;
    await guarded(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), {
      signal: ctx.signal,
      timeoutMs: 60_000,
      cancel: () => bot.pathfinder.stop(),
      what: "走到工作台",
    });
  }
  return table;
}

/** Grid cells (window slot + ingredient) a recipe needs in a 3x3 crafting table window. */
function recipeCells(recipe: Recipe): Array<{ slot: number; id: number; metadata: number | null }> {
  const cells: Array<{ slot: number; id: number; metadata: number | null }> = [];
  if (recipe.inShape) {
    recipe.inShape.forEach((row, y) =>
      row.forEach((ing, x) => {
        if (ing.id !== -1) cells.push({ slot: 1 + x + 3 * y, id: ing.id, metadata: ing.metadata ?? null });
      }),
    );
  } else {
    (recipe.ingredients ?? []).forEach((ing, i) => cells.push({ slot: 1 + i, id: ing.id, metadata: ing.metadata ?? null }));
  }
  return cells;
}

/**
 * Craft once at a crafting table. Mineflayer's own craft() starts clicking the moment the
 * window opens; on 1.20.x the server's window-contents packet then arrives mid-sequence and
 * resets the client's idea of the cursor, so ingredients get put back and the craft silently
 * fails. Here we wait for the contents first and place every ingredient one step at a time.
 */
async function craftAtTable(ctx: ActionContext, recipe: Recipe, table: Block): Promise<void> {
  const { bot } = ctx;
  await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true);
  const opened = waitForWindow(bot, 3_000);
  await bot.activateBlock(table);
  const win = await opened;
  if (!win) throw new ActionError("打不开工作台");
  const pause = (ms = 80) => sleep(ms, ctx.signal);
  try {
    if (!String(win.type).startsWith("minecraft:crafting")) throw new ActionError(`打开的不是工作台（${win.type}）`);
    await pause(500); // let the server's window contents arrive before the first click
    for (const cell of recipeCells(recipe)) {
      const src = win.findInventoryItem(cell.id, cell.metadata, false);
      if (!src) throw new ActionError(`缺少材料 ${bot.registry.items[cell.id]?.name ?? cell.id}`);
      const from = src.slot;
      await bot.clickWindow(from, 0, 0); // pick up the stack
      await pause();
      await bot.clickWindow(cell.slot, 1, 0); // right click: drop one item into the grid
      await pause();
      if (win.selectedItem) {
        await bot.clickWindow(from, 0, 0); // put the rest back
        await pause();
      }
    }
    const ready = await waitFor(() => win.slots[0]?.type === recipe.result.id, 2_000);
    if (!ready) throw new ActionError("工作台里没有出现成品，配方可能没摆对");
    await bot.clickWindow(0, 0, 0); // take the result onto the cursor
    await pause(120);
    const empty = win.firstEmptyInventorySlot();
    if (empty === null) throw new ActionError("背包满了，放不下成品");
    await bot.clickWindow(empty, 0, 0);
    await pause(120);
  } finally {
    bot.closeWindow(win); // the server returns anything left in the grid
  }
}

export const craft = defineAction({
  name: "craft",
  description:
    "合成物品。item 用英文 ID（如 oak_planks、stick、crafting_table、wooden_pickaxe）。需要工作台的配方会自动使用附近的工作台，或从背包里放一个。",
  risk: "low",
  schema: z.object({
    item: z.string(),
    count: z.number().int().min(1).max(64).default(1).describe("想得到的物品数量"),
  }),
  async run(ctx, { item, count }) {
    const { bot } = ctx;
    const name = item.toLowerCase().replace(/^minecraft:/, "");
    const info = bot.registry.itemsByName[name];
    if (!info) throw new ActionError(`不认识物品 "${item}"，请用英文 ID`);
    let table: Block | null = null;
    let recipe = bot.recipesFor(info.id, null, 1, null)[0];
    if (!recipe) {
      const needsTable = bot.recipesAll(info.id, null, true).length > 0;
      if (!needsTable && bot.recipesAll(info.id, null, null).length === 0) {
        throw new ActionError(`${name} 没有合成配方（可能需要熔炼或其他方式获得）`);
      }
      if (needsTable) {
        table = await ensureCraftingTable(ctx);
        recipe = bot.recipesFor(info.id, null, 1, table)[0];
      }
    }
    if (!recipe) {
      const any = bot.recipesAll(info.id, null, table ?? true)[0] ?? bot.recipesAll(info.id, null, null)[0];
      const needs = any
        ? any.delta
            .filter((d) => d.count < 0)
            .map((d) => `${bot.registry.items[d.id]?.name ?? d.id}×${-d.count}`)
            .join(", ")
        : "未知";
      throw new ActionError(`材料不够，无法合成 ${name}。一次合成需要：${needs}`);
    }
    const perCraft = recipe.result.count;
    const times = Math.ceil(count / perCraft);
    const have = () => bot.inventory.count(info.id, null);
    const before = have();
    // Craft one at a time and wait for the server to confirm each result: Mineflayer's
    // multi-count craft() runs ahead of the server on 1.20.x and loses crafts silently.
    for (let i = 0; i < times; i++) {
      throwIfAborted(ctx.signal);
      const next = bot.recipesFor(info.id, null, 1, table)[0];
      if (!next) break; // out of materials
      const start = have();
      // Inventory (2x2) crafts go through Mineflayer; table crafts use the careful path above.
      if (table) await craftAtTable(ctx, next, table);
      else await bot.craft(next, 1, undefined);
      const confirmed = await waitFor(() => have() >= start + perCraft, 3_000);
      if (!confirmed) {
        ctx.log.warn(`合成 ${name} 第 ${i + 1} 次没有得到服务器确认，停止`);
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const made = have() - before;
    ctx.log.debug(`craft ${name}: times=${times} perCraft=${perCraft} table=${table ? "yes" : "no"} made=${made}`);
    if (made === 0) throw new ActionError(`合成 ${name} 失败，服务器没有给出成品，可以再试一次`);
    return `合成了 ${name}×${made}${made < count ? `（想要 ${count}，材料只够这么多）` : ""}`;
  },
});

export const gatherActions = [collectBlock, craft];
