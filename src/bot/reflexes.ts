import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import pathfinderPkg from "mineflayer-pathfinder";
import { createLogger } from "../logger.js";

const { goals } = pathfinderPkg;
const log = createLogger("reflex");

/** Foods the bot never eats on its own (harmful or wasteful). */
const AVOID_FOOD = new Set([
  "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "suspicious_stew",
  "chorus_fruit", "golden_apple", "enchanted_golden_apple",
]);

export interface ReflexHooks {
  /** Tell the owner something important happened (death, low health). */
  notify: (text: string) => void;
  /** True while the AI is running a task; reflexes stay quieter then. */
  busy: () => boolean;
}

/**
 * Fast survival behaviors that never wait for the AI: eat when hungry, run from danger when
 * badly hurt, report deaths. (Respawning is handled by Mineflayer itself.)
 */
export function attachReflexes(bot: Bot, hooks: ReflexHooks): void {
  let eating = false;
  let lastFlee = 0;

  const tryEat = async () => {
    if (eating || bot.food >= 15 || bot.currentWindow || bot.targetDigBlock) return;
    const foods = bot.registry.foodsByName;
    const candidates = bot.inventory
      .items()
      .filter((i) => foods[i.name] && !AVOID_FOOD.has(i.name))
      .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0));
    const food = candidates[0];
    if (!food) return;
    eating = true;
    const previous = bot.heldItem;
    try {
      await bot.equip(food, "hand");
      await bot.consume();
      log.info(`吃了 ${food.name}，饥饿值 ${bot.food}`);
      if (previous && previous.name !== food.name) {
        const again = bot.inventory.items().find((i) => i.name === previous.name);
        if (again) await bot.equip(again, "hand");
      }
    } catch (err) {
      log.debug("吃东西失败", err);
    } finally {
      eating = false;
    }
  };

  const nearestHostile = (radius: number): Entity | undefined =>
    Object.values(bot.entities)
      .filter((e) => e.type === "hostile" && e.position.distanceTo(bot.entity.position) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];

  bot.on("health", () => {
    void tryEat();
    const now = Date.now();
    if (bot.health <= 6 && now - lastFlee > 10_000) {
      const threat = nearestHostile(10);
      if (threat) {
        lastFlee = now;
        log.warn(`生命值 ${Math.round(bot.health)}，逃离 ${threat.name}`);
        hooks.notify(`我快没血了（${Math.round(bot.health)}/20），正在躲开 ${threat.name}`);
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 16)), true);
        setTimeout(() => {
          if (bot.pathfinder.goal instanceof goals.GoalInvert) bot.pathfinder.setGoal(null);
        }, 6_000);
      }
    }
  });

  bot.on("death", () => {
    const p = bot.entity.position.floored();
    log.warn(`死亡于 ${p.toString()}`);
    hooks.notify(`我死了，位置 ${p.x} ${p.y} ${p.z}，已自动复活`);
  });

  // Check hunger periodically too: the health event does not fire while nothing changes.
  const timer = setInterval(() => void tryEat(), 10_000);
  bot.once("end", () => clearInterval(timer));
}
