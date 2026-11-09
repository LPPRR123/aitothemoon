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
import { MemoryStore } from "../src/memory/store.js";
import { StrategyLibrary } from "../src/strategy/library.js";
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
  砍两个木头: [], // only reached when the learned strategy fails: the model just answers
  回家: [{ name: "run_command", input: { command: "/home" } }],
  回家吧: [], // reached when the learned /home strategy does not teleport (cooldown)
  记住我喜欢红石: [{ name: "remember", input: { kind: "preference", subject: "主人的爱好", content: "喜欢红石" } }],
  矿洞那里没有矿: [
    { name: "doubt", input: { subject: "矿洞", reason: "去了发现没有矿" } },
    { name: "doubt", input: { subject: "矿洞", reason: "再去还是没有矿" } },
  ],
  去矿洞: [], // reached when the remembered place is doubtful: the model is asked instead
}, {
  // What the model returns when asked to turn a solved task into a reusable strategy.
  砍三个木头: {
    reusable: true, reason: "", name: "砍原木",
    triggers: ["砍{count}个{block}", "去砍{count}个{block}", "挖{count}个{block}"],
    params: [
      { name: "count", type: "number", values: [] },
      { name: "block", type: "word", values: [{ word: "木头", value: "oak_log" }, { word: "原木", value: "oak_log" }, { word: "橡木", value: "oak_log" }] },
    ],
    steps: [{ tool: "collect_block", input_json: '{"block":"{block}","count":"{count}"}' }],
    reply: "砍好了{count}个{block}",
  },
  回家: {
    reusable: true, reason: "", name: "回家",
    triggers: ["回家", "传送回家", "回家吧"], params: [],
    steps: [{ tool: "run_command", input_json: '{"command":"/home"}' }],
    reply: "到家了",
  },
  打开菜单买面包: {
    reusable: true, reason: "", name: "菜单买面包",
    triggers: ["打开菜单买面包", "去菜单买面包", "买面包"],
    params: [],
    steps: [
      { tool: "run_command", input_json: '{"command":"/menu"}' },
      { tool: "click_slot", input_json: '{"name":"商店"}' },
      { tool: "click_slot", input_json: '{"name":"面包"}' },
      { tool: "close_window", input_json: "{}" },
    ],
    reply: "面包买好了",
  },
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
  const library = new StrategyLibrary(null, { promoteAfter: 2 });
  const memory = new MemoryStore(null);
  const agent = new Agent(manager, config, llm, library, memory);
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

  const waitLearned = async (n: number) => {
    const end = Date.now() + 10_000;
    while (Date.now() < end && library.all.length < n) await sleep(200);
    await sleep(2500); // let the "记住了…" reply arrive before the next instruction
    return library.all.length >= n;
  };
  const learnedLogs = await waitLearned(1);
  check("AI 完成新任务后学成策略", learnedLogs && library.all[0]?.name === "砍原木", library.all.map((x) => x.name).join(",") || "没有学到");

  // 4b. Same kind of request, new words and number: answered from the strategy, no model call
  let requests = llm.taskRequests;
  const logsBefore = count("oak_log");
  r = await say("AIBot 帮我挖两个原木", 60_000);
  check("类似指令直接用策略，不调用 AI", llm.taskRequests === requests && count("oak_log") >= logsBefore + 2, `AI 请求 ${llm.taskRequests - requests} 次，oak_log +${count("oak_log") - logsBefore}，回复：${r}`);

  // 5. Craft chain incl. placing a crafting table
  r = await say("AIBot 做个工作台", 60_000);
  check("合成（含放工作台）craft", count("wooden_pickaxe") >= 1, `wooden_pickaxe=${count("wooden_pickaxe")} planks=${count("oak_planks")}，回复：${r}`);

  // 6. Menu opened by command, two levels deep
  const breadBefore = count("bread");
  r = await say("AIBot 打开菜单买面包", 30_000);
  check("指令打开菜单并点两层 run_command+click_slot", count("bread") >= breadBefore + 5 && !ai.currentWindow, `bread=${count("bread")}，回复：${r}`);

  const learnedMenu = await waitLearned(2);
  requests = llm.taskRequests;
  const bread2 = count("bread");
  r = await say("AIBot 去菜单买面包", 30_000);
  check("学会的菜单策略（按按钮文字点击）", learnedMenu && llm.taskRequests === requests && count("bread") >= bread2 + 5, `AI 请求 ${llm.taskRequests - requests} 次，bread=${count("bread")}，回复：${r}`);
  // Environment check: the server "changes its menu"; the learned strategy must notice and hand over.
  await op("/menutitle 活动菜单");
  requests = llm.taskRequests;
  const bread3 = count("bread");
  r = await say("AIBot 去菜单买面包", 30_000);
  check(
    "菜单变了：环境检查发现不同，交给 AI",
    llm.taskRequests === requests + 1 && llm.lastTaskHadNote && count("bread") === bread3 && !ai.currentWindow,
    `AI 请求 ${llm.taskRequests - requests} 次，带说明=${llm.lastTaskHadNote}，bread 变化 ${count("bread") - bread3}，菜单已关=${!ai.currentWindow}，回复：${r}`,
  );
  await op("/menutitle 服务器菜单");
  r = await say("AIBot 不对", 8_000);
  check("说\"不对\"会忘掉刚用的策略", /忘掉/.test(r) && library.all.find((x) => x.name === "菜单买面包")?.status === "disabled", r);
  r = await say("AIBot 学会了什么", 8_000);
  check("查看学会的策略", /砍原木/.test(r) && !/菜单买面包/.test(r), r);

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

  // 10b. A learned strategy fails (no trees left) -> falls back to the model with a note
  await op(`/tp AIBot ${o.x + 600} ${o.y} ${o.z + 600}`); // fresh flat land: no trees within 64 blocks
  await sleep(3000);
  requests = llm.taskRequests;
  const logStrategy = library.all.find((x) => x.name === "砍原木")!;
  const failuresBefore = logStrategy.stats.failures;
  r = await say("AIBot 砍两个木头", 60_000);
  check(
    "附近没树：预检发现环境不同，交给 AI，不扣策略分",
    llm.taskRequests > requests && llm.lastTaskHadNote && logStrategy.stats.failures === failuresBefore && logStrategy.status !== "disabled",
    `AI 请求 ${llm.taskRequests - requests} 次，带说明=${llm.lastTaskHadNote}，失败次数 ${failuresBefore}→${logStrategy.stats.failures}，回复：${r}`,
  );

  // Teleport check: learn "回家" (/home), reuse it, then a cooldown makes /home not teleport.
  const home = () => ai.entity.position.distanceTo(ai.spawnPoint.offset(40, 0, 40)) < 6;
  r = await say("AIBot 回家", 20_000);
  const learnedHome = await waitLearned(3);
  check("学会传送类策略（记录了会传送）", learnedHome && home() && library.all.find((x) => x.name === "回家")?.steps[0]?.check?.postMoved === true, `到家=${home()}，回复：${r}`);
  await op(`/tp AIBot ${o.x} ${o.y} ${o.z - 4}`);
  await sleep(1500);
  requests = llm.taskRequests;
  r = await say("AIBot 传送回家", 20_000);
  check("传送策略直接复用", llm.taskRequests === requests && home(), `AI 请求 ${llm.taskRequests - requests} 次，到家=${home()}，回复：${r}`);
  await op(`/tp AIBot ${o.x} ${o.y} ${o.z - 4}`);
  await op("/testcooldown on");
  await sleep(1500);
  requests = llm.taskRequests;
  r = await say("AIBot 回家吧", 20_000);
  check("传送冷却：检查发现没传送，交给 AI", llm.taskRequests === requests + 1 && llm.lastTaskHadNote && !home(), `AI 请求 ${llm.taskRequests - requests} 次，带说明=${llm.lastTaskHadNote}，到家=${home()}，回复：${r}`);
  await op("/testcooldown off");
  r = await say("AIBot 统计", 8_000);
  check("学习统计", /直接按学过的做法完成 [1-9]/.test(r), r);

  // 12. Long-term memory
  const ownerPos = owner.entity.position.clone();
  r = await say("AIBot 记住这里是基地", 8_000);
  const base = memory.find("基地");
  check("记住地点（不调用 AI）", !!base?.place && base.pinned && Math.hypot(base.place.x - ownerPos.x, base.place.z - ownerPos.z) < 2, r);
  await op(`/tp AIBot ${o.x - 30} ${o.y} ${o.z - 8}`);
  await sleep(1500);
  requests = llm.taskRequests;
  r = await say("AIBot 去基地", 60_000);
  const atBase = base?.place ? Math.hypot(ai.entity.position.x - base.place.x, ai.entity.position.z - base.place.z) < 3.5 : false;
  check("去记得的地点（不调用 AI，到达后记忆更可信）", llm.taskRequests === requests && atBase && (memory.find("基地")?.verifications ?? 0) >= 1, `AI 请求 ${llm.taskRequests - requests} 次，到达=${atBase}，回复：${r}`);
  r = await say("AIBot 你记得哪些地方", 8_000);
  check("列出记得的地点", /基地/.test(r), r);

  r = await say("AIBot 记住我喜欢红石", 15_000);
  const pref = memory.find("主人的爱好");
  check("Claude 记下主人的偏好（主人亲口说的，永不自动遗忘）", pref?.content === "喜欢红石" && pref.source === "owner" && pref.pinned, r);

  r = await say("AIBot 记住这里是矿洞", 8_000);
  r = await say("AIBot 矿洞那里没有矿", 15_000);
  check(
    "之后的任务都带着记忆（偏好、地点）",
    /喜欢红石/.test(llm.lastTaskPrompt) && /基地/.test(llm.lastTaskPrompt) && /<memory>/.test(llm.lastTaskPrompt),
    llm.lastTaskPrompt.match(/<memory>[\s\S]*?<\/memory>/)?.[0].replace(/\n/g, " ").slice(0, 200) ?? "没有 memory",
  );
  check("两次不符后记忆变成\"可能是错的\"", memory.find("矿洞")?.status === "doubtful", `状态=${memory.find("矿洞")?.status}，回复：${r}`);
  requests = llm.taskRequests;
  r = await say("AIBot 去矿洞", 20_000);
  check("可能错的地点不盲目去，交给 AI 先确认", llm.taskRequests === requests + 1 && /可能是错的/.test(llm.lastTaskPrompt), `AI 请求 ${llm.taskRequests - requests} 次，回复：${r}`);
  r = await say("AIBot 忘掉矿洞", 8_000);
  const r2 = await say("AIBot 你记得哪些地方", 8_000);
  check("忘掉记忆", /忘掉了/.test(r) && !memory.find("矿洞") && !/矿洞/.test(r2), `${r} / ${r2}`);

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
