import "dotenv/config";
import { BotManager } from "./bot/BotManager.js";
import { attachReflexes } from "./bot/reflexes.js";
import { Agent } from "./brain/agent.js";
import { ClaudeClient } from "./brain/llm.js";
import { loadConfig, loadSecrets } from "./config.js";
import { createLogger } from "./logger.js";
import { StrategyLibrary } from "./strategy/library.js";
import { MemoryStore } from "./memory/store.js";

const log = createLogger("main");

function main(): void {
  const config = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
  const secrets = loadSecrets();
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn("没有设置 ANTHROPIC_API_KEY，机器人能进服但不能思考。请在 .env 里填写。");
  }

  const manager = new BotManager(config, secrets);
  const strategies = config.strategy.enabled
    ? new StrategyLibrary(config.strategy.file, { promoteAfter: config.strategy.promoteAfter })
    : null;
  const memory = config.memory.enabled
    ? new MemoryStore(config.memory.file, { halfLifeDays: config.memory.halfLifeDays })
    : null;
  const agent = new Agent(manager, config, new ClaudeClient(), strategies, memory);
  agent.attach();

  manager.on("ready", (bot) => {
    attachReflexes(bot, {
      busy: () => agent.busy,
      notify: (text) => {
        const owner = config.owner.names.find((n) => bot.players[n]);
        if (owner) manager.sender.say(`/msg ${owner} ${text}`);
      },
    });
    bot.on("death", () => {
      const p = bot.entity.position;
      memory?.remember({
        kind: "place",
        subject: "上次死亡的地方",
        content: "掉落的东西可能还在",
        place: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: String(bot.game.dimension) },
        source: "observed",
        importance: 0.4,
      });
      memory?.addEpisode(`我死了，位置 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`, 0.6);
    });
    const owner = config.owner.names.find((n) => bot.players[n]);
    if (owner) manager.sender.say(`/msg ${owner} 我上线了，有事叫我「${config.bot.username}」`);
  });

  const shutdown = () => {
    log.info("正在退出…");
    manager.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  manager.start();
}

try {
  main();
} catch (err) {
  log.error((err as Error).message);
  process.exit(1);
}
