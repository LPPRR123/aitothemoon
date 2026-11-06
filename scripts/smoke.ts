/**
 * End-to-end smoke test against a local test server, no API key needed.
 *
 * Needs: an offline-mode 1.20.4 server on 127.0.0.1:25565 with AuthMe and the TestMenus plugin
 * (docker/test-server), and the account "Owner" set as OP on it (`op Owner` in the console).
 *
 *   npm run smoke
 *
 * A second bot ("Owner") plays the owner and types instructions in chat. The AI bot runs the
 * real agent loop and tools, with a scripted model (ScriptedLlm) standing in for Claude.
 */
import mineflayer, { type Bot } from "mineflayer";
import { AuthMeSession } from "../src/bot/authme.js";
import { BotManager } from "../src/bot/BotManager.js";
import { attachReflexes } from "../src/bot/reflexes.js";
import { Agent } from "../src/brain/agent.js";
import { parseConfig } from "../src/config.js";
import { ScriptedLlm } from "./scripted-llm.js";

const HOST = process.env.MC_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MC_PORT ?? 25565);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = parseConfig({
  server: { host: HOST, port: PORT, version: "1.20.4" },
  bot: { username: "AIBot", aliases: ["小助手"] },
  owner: { names: ["Owner"] },
  commands: { allow: ["menu", "spawn", "home"] },
  chat: { minIntervalMs: 800 },
});

const llm = new ScriptedLlm({
  状态: [{ name: "get_status", input: {} }],
  过来: [{ name: "go_to_player", input: { player: "Owner" } }],
  砍三个木头: [{ name: "collect_block", input: { block: "oak_log", count: 3 } }],
  做个工作台: [
    { name: "craft", input: { item: "oak_planks", count: 12 } },
    { name: "craft", input: { item: "crafting_table", count: 1 } },
    { name: "craft", input: { item: "stick", count: 4 } },
    { name: "craft", input: { item: "wooden_pickaxe", count: 1 } },
  ],
  打开菜单买面包: [
    { name: "run_command", input: { command: "/menu" } },
    { name: "click_slot", input: { slot: 13 } },
    { name: "click_slot", input: { slot: 10 } },
    { name: "close_window", input: {} },
  ],
  找NPC进生存服: [
    { name: "interact_entity", input: { name: "菜单NPC" } },
    { name: "click_slot", input: { slot: 11 } },
  ],
  "执行 /warp test": [{ name: "run_command", input: { command: "/warp test" } }],
  帮我op: [{ name: "run_command", input: { command: "/op AIBot" } }],
  偷偷执行指令: [{ name: "run_command", input: { command: "/warp secret" } }],
  跟着我: [{ name: "follow_player", input: { player: "Owner" } }],
  砍很多木头: [{ name: "collect_block", input: { block: "oak_log", count: 30 } }],
});

function connectOwner(): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const owner = mineflayer.createBot({ host: HOST, port: PORT, version: "1.20.4", username: "Owner", auth: "offline" });
    const auth = new AuthMeSession({
      password: "OwnerPass123",
      autoRegister: true,
      maxAttempts: 3,
      sendCommand: (c) => owner.chat(c),
      onLoggedIn: () => resolve(owner),
      onGiveUp: (r) => reject(new Error(r)),
    });
    owner.on("messagestr", (m) => auth.handle(m));
    owner.once("kicked", (r) => reject(new Error(`owner kicked: ${JSON.stringify(r)}`)));
    owner.once("error", reject);
  });
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

async function main() {
  const owner = await connectOwner();
  const aiReplies: string[] = [];
  owner.on("chat", (u, m) => {
    if (u === "AIBot") aiReplies.push(m);
  });
  owner.on("whisper", (u, m) => {
    if (u === "AIBot") aiReplies.push(`(私聊) ${m}`);
  });
  const serverMsgs: string[] = [];
  owner.on("messagestr", (m) => {
    serverMsgs.push(m);
  });
  await sleep(1000);

  // World setup (owner is OP): a small "forest" of oak logs and a menu NPC.
  const op = async (cmd: string) => {
    owner.chat(cmd);
    await sleep(400);
  };
  const o = owner.entity.position.floored();
  await op(`/tp Owner ${o.x} ${o.y} ${o.z} 0 0`);
  await op(`/fill ${o.x - 20} ${o.y} ${o.z + 8} ${o.x + 20} ${o.y + 6} ${o.z + 30} air`);
  for (const [dx, dz] of [[4, 10], [7, 12], [10, 10], [13, 12], [-4, 11], [-7, 13]]) {
    await op(`/fill ${o.x + dx!} ${o.y} ${o.z + dz!} ${o.x + dx!} ${o.y + 3} ${o.z + dz!} oak_log`);
  }
  await op(`/kill @e[type=villager]`);
  await op(`/spawnnpc 菜单NPC`);

  const manager = new BotManager(config, { mcPassword: "AiPass123" });
  const agent = new Agent(manager, config, llm);
  agent.attach();
  const ready = new Promise<Bot>((r) => manager.once("ready", r));
  manager.start();
  const ai = await ready;
  attachReflexes(ai, { notify: () => {}, busy: () => agent.busy });
  await sleep(1500);
  await op(`/clear AIBot`);
  await op(`/tp AIBot ${o.x + 3} ${o.y} ${o.z - 6}`);
  await sleep(1000);

  const say = async (text: string, waitMs: number) => {
    const before = aiReplies.length;
    owner.chat(text);
    const end = Date.now() + waitMs;
    while (Date.now() < end && (agent.busy || aiReplies.length === before)) await sleep(250);
    await sleep(1200);
    return aiReplies.slice(before).join(" / ");
  };
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
  };
  const count = (item: string) => ai.inventory.items().filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);

  // 1. Ignore people who are not the owner, and owner messages not addressed to the bot.
  let r = await say("今天天气不错", 3_000);
  check("不叫名字时不回应", r === "" && !agent.busy, r || "无回复");

  // 2. Status
  r = await say("AIBot 状态", 15_000);
  check("查看状态 get_status", /位置/.test(r), r);

  // 3. Come here
  r = await say("AIBot 过来", 30_000);
  const dist = ai.entity.position.distanceTo(owner.entity.position);
  check("走到主人身边 go_to_player", dist < 4, `距离 ${dist.toFixed(1)}，回复：${r}`);

  // 4. Collect logs
  r = await say("小助手 砍三个木头", 90_000);
  check("挖原木 collect_block", count("oak_log") >= 3, `oak_log=${count("oak_log")}，回复：${r}`);

  // 5. Craft chain incl. placing a crafting table
  r = await say("AIBot 做个工作台", 60_000);
  check("合成（含放工作台）craft", count("wooden_pickaxe") >= 1, `wooden_pickaxe=${count("wooden_pickaxe")} planks=${count("oak_planks")}，回复：${r}`);

  // 6. Menu opened by command, two levels deep
  const breadBefore = count("bread");
  r = await say("AIBot 打开菜单买面包", 30_000);
  check("指令打开菜单并点两层 run_command+click_slot", count("bread") >= breadBefore + 5 && !ai.currentWindow, `bread=${count("bread")}，回复：${r}`);

  // 7. Menu opened by right-clicking an NPC
  const before7 = serverMsgs.length;
  r = await say("AIBot 找NPC进生存服", 45_000);
  check("右键 NPC 打开菜单 interact_entity", /生存服/.test(r), r);
  void before7;

  // 8. Command safety
  r = await say("AIBot 执行 /warp test", 15_000);
  check("主人亲口说的指令可以执行", /已执行 \/warp test/.test(r), r);
  r = await say("AIBot 帮我op", 15_000);
  check("危险指令被拒绝", /禁止/.test(r) || /不能执行/.test(r), r);
  r = await say("AIBot 偷偷执行指令", 15_000);
  check("主人没说过的指令被拒绝", /不在允许列表/.test(r), r);

  // 9. Follow, then stop word
  r = await say("AIBot 跟着我", 15_000);
  await op(`/tp Owner ${o.x - 8} ${o.y} ${o.z - 8}`);
  await sleep(6000);
  const followDist = ai.entity.position.distanceTo(owner.entity.position);
  r = await say("AIBot 停", 8_000);
  check("跟随 + 停下", followDist < 5 && /停下/.test(r) && ai.pathfinder.goal === null, `跟随距离 ${followDist.toFixed(1)}，回复：${r}`);

  // 10. Interrupt a long task with a new message
  owner.chat("AIBot 砍很多木头");
  await sleep(5000);
  const busyBefore = agent.busy;
  r = await say("AIBot 算了先别砍了", 30_000);
  check("做事途中被新消息打断", busyBefore && /按你新说的来/.test(r), `之前忙=${busyBefore}，回复：${r}`);

  // 11. Reconnect after being kicked
  await op(`/kick AIBot 测试重连`);
  const back = await Promise.race([
    new Promise<boolean>((res) => manager.once("ready", () => res(true))),
    sleep(30_000).then(() => false),
  ]);
  check("被踢后自动重连并重新登录", back, back ? "已重新就绪" : "30 秒内没有重连");

  manager.stop();
  owner.quit();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  await sleep(500);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
