import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { componentToText, stripColors } from "./text.js";

/** Readable name for an inventory/window item, including its custom name if it has one. */
export function describeItem(bot: Bot, item: Item): { id: string; count: number; name: string; lore: string[] } {
  const custom = item.customName ? componentToText(bot, item.customName) : "";
  const rawLore = item.customLore;
  const loreList = Array.isArray(rawLore) ? rawLore : rawLore ? [rawLore] : [];
  const lore = loreList.map((l) => componentToText(bot, l)).filter((l) => l.trim());
  return { id: item.name, count: item.count, name: custom || item.displayName, lore };
}

/** Item ID -> total count in the bot's inventory. */
export function inventoryCounts(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

export function inventorySummary(bot: Bot): string {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  if (counts.size === 0) return "空";
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

/** Name shown above an entity: player name, custom name tag, or the mob type. */
export function entityLabel(e: Entity): string {
  if (e.type === "player" && e.username) return e.username;
  const custom = e.getCustomName?.();
  if (custom) return stripColors(custom.toString());
  return e.displayName ?? e.name ?? "unknown";
}

function hostile(e: Entity): boolean {
  return e.type === "hostile" || (e.kind ?? "").toLowerCase().includes("hostile");
}

export function nearbyEntities(bot: Bot, radius = 24, limit = 15): string[] {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= radius)
    .filter((e) => e.name !== "item" && e.name !== "experience_orb" && e.name !== "arrow")
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    .slice(0, limit)
    .map((e) => {
      const d = e.position.distanceTo(me).toFixed(1);
      const kind = e.type === "player" ? "玩家" : hostile(e) ? "敌对" : e.name ?? e.type;
      const custom = e.type !== "player" ? e.getCustomName?.() : null;
      const name = custom ? `"${stripColors(custom.toString())}"(${e.name})` : entityLabel(e);
      return `${name} [${kind}] 距离${d}`;
    });
}

const NOTABLE_BLOCKS: Array<[string, (name: string) => boolean]> = [
  ["原木", (n) => n.endsWith("_log") && !n.startsWith("stripped_")],
  ["工作台", (n) => n === "crafting_table"],
  ["箱子", (n) => n === "chest" || n === "barrel"],
  ["熔炉", (n) => n === "furnace"],
  ["床", (n) => n.endsWith("_bed")],
  ["矿石", (n) => n.endsWith("_ore")],
  ["水", (n) => n === "water"],
];

export function notableBlocks(bot: Bot, maxDistance = 32): string[] {
  const out: string[] = [];
  for (const [label, test] of NOTABLE_BLOCKS) {
    const ids = Object.values(bot.registry.blocksByName)
      .filter((b) => test(b.name))
      .map((b) => b.id);
    if (ids.length === 0) continue;
    const block = bot.findBlock({ matching: ids, maxDistance });
    if (block) {
      const d = block.position.distanceTo(bot.entity.position).toFixed(0);
      out.push(`${label}: ${block.name} @ ${block.position.toString()} 距离${d}`);
    }
  }
  return out;
}

/** Plain title of the open window, or null if no window is open. */
export function windowTitle(bot: Bot): string | null {
  const win = bot.currentWindow;
  if (!win) return null;
  return componentToText(bot, win.title) || String(win.type);
}

/** Contents of the currently open container/menu window, or null if none is open. */
export function describeWindow(bot: Bot): string | null {
  const win = bot.currentWindow;
  if (!win) return null;
  const title = componentToText(bot, win.title) || win.type;
  const lines: string[] = [`窗口「${title}」(类型 ${win.type}, 容器格子 0-${win.inventoryStart - 1})`];
  for (let slot = 0; slot < win.inventoryStart; slot++) {
    const item = win.slots[slot];
    if (!item) continue;
    const d = describeItem(bot, item);
    const lore = d.lore.length ? ` 说明: ${d.lore.join(" / ")}` : "";
    lines.push(`  格子${slot}: 「${d.name}」(${d.id}×${d.count})${lore}`);
  }
  if (lines.length === 1) lines.push("  （容器是空的）");
  return lines.join("\n");
}

export function selfStatus(bot: Bot): string {
  const p = bot.entity.position;
  const held = bot.heldItem ? `${bot.heldItem.name}×${bot.heldItem.count}` : "空手";
  const time = bot.time.timeOfDay;
  const dayNight = time < 12_500 || time > 23_500 ? "白天" : "夜晚";
  return [
    `位置 (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) 维度 ${bot.game.dimension}`,
    `生命 ${Math.round(bot.health)}/20 饥饿 ${Math.round(bot.food)}/20 手持 ${held} 模式 ${bot.game.gameMode} ${dayNight}${bot.isRaining ? " 下雨" : ""}`,
  ].join("\n");
}

/** A compact, text-only picture of the world for the model. */
export function observe(bot: Bot): string {
  const sections = [
    `【自身】\n${selfStatus(bot)}`,
    `【背包】${inventorySummary(bot)}`,
  ];
  const ents = nearbyEntities(bot);
  sections.push(`【附近实体】${ents.length ? "\n" + ents.map((e) => "  " + e).join("\n") : "无"}`);
  const blocks = notableBlocks(bot);
  sections.push(`【附近方块】${blocks.length ? "\n" + blocks.map((b) => "  " + b).join("\n") : "无特别方块"}`);
  const win = describeWindow(bot);
  if (win) sections.push(`【打开的窗口】\n${win}`);
  return sections.join("\n");
}
