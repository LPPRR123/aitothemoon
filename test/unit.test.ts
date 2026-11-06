import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIONS, toolInputSchema } from "../src/actions/index.js";
import { AuthMeSession, classifyAuthMessage } from "../src/bot/authme.js";
import { ChatSender, compilePatterns, matchPatterns } from "../src/bot/chat.js";
import { splitMessage, stripColors } from "../src/bot/text.js";
import { addressedText, isOwner, isStopWord, toChatText } from "../src/brain/agent.js";
import { buildSystemPrompt } from "../src/brain/prompts.js";
import { parseConfig } from "../src/config.js";
import { checkCommand, commandName, commandsMentioned } from "../src/safety/commands.js";

const config = parseConfig({
  owner: { names: ["Steve"] },
  bot: { username: "AIBot", aliases: ["小助手"] },
  commands: { allow: ["home", "spawn", "menu"], deny: ["sell"] },
});

describe("config", () => {
  it("fills defaults", () => {
    assert.equal(config.server.version, "1.20.4");
    assert.equal(config.llm.model, "claude-opus-5-5");
    assert.equal(config.movement.allowDig, false);
    assert.ok(config.agent.stopWords.includes("停"));
  });
  it("requires an owner", () => {
    assert.throws(() => parseConfig({}), /owner/);
  });
});

describe("AuthMe detection", () => {
  it("recognises Chinese prompts", () => {
    assert.equal(classifyAuthMessage("[玩家系统] 请输入“/register <密码> <再输入一次以确定密码>”以注册"), "register");
    assert.equal(classifyAuthMessage("§8[§6玩家系统§8] §c请输入“/login <密码>”以登录"), "login");
    assert.equal(classifyAuthMessage("[玩家系统] 已成功登录！"), "success");
    assert.equal(classifyAuthMessage("[玩家系统] 错误的密码"), "wrong_password");
  });
  it("recognises English prompts", () => {
    assert.equal(classifyAuthMessage("Please, register to the server with the command: /register <password> <ConfirmPassword>"), "register");
    assert.equal(classifyAuthMessage("Please, login with the command: /login <password>"), "login");
    assert.equal(classifyAuthMessage("Successful login!"), "success");
  });
  it("ignores unrelated messages", () => {
    assert.equal(classifyAuthMessage("Steve joined the game"), null);
    assert.equal(classifyAuthMessage("type /login to win"), null);
  });

  it("logs in once per prompt burst and gives up after max attempts", () => {
    const sent: string[] = [];
    let gaveUp = "";
    const s = new AuthMeSession({
      password: "pw",
      autoRegister: true,
      maxAttempts: 2,
      sendCommand: (c) => sent.push(c),
      onLoggedIn: () => {},
      onGiveUp: (r) => (gaveUp = r),
    });
    s.handle("请输入“/login <密码>”以登录", 0);
    s.handle("请输入“/login <密码>”以登录", 1_000); // repeat within 4s: ignored
    s.handle("请输入“/login <密码>”以登录", 5_000);
    s.handle("请输入“/login <密码>”以登录", 10_000);
    assert.deepEqual(sent, ["/login pw", "/login pw"]);
    assert.match(gaveUp, /2 次/);
  });

  it("stops on wrong password", () => {
    const sent: string[] = [];
    let gaveUp = "";
    const s = new AuthMeSession({
      password: "pw", autoRegister: true, maxAttempts: 3,
      sendCommand: (c) => sent.push(c), onLoggedIn: () => {}, onGiveUp: (r) => (gaveUp = r),
    });
    s.handle("Please, login with the command: /login <password>", 0);
    s.handle("Wrong password!", 100);
    s.handle("Please, login with the command: /login <password>", 10_000);
    assert.equal(sent.length, 1);
    assert.match(gaveUp, /密码错误/);
  });
});

describe("command safety", () => {
  it("allows listed commands and blocks denied ones", () => {
    assert.deepEqual(checkCommand("/home", config.commands, []), { ok: true, command: "home" });
    assert.equal(checkCommand("/sell all", config.commands, []).ok, false);
    assert.equal(checkCommand("/op AIBot", config.commands, ["/op AIBot"]).ok, false, "built-in deny wins even if owner typed it");
    assert.equal(checkCommand("essentials:pay Bob 100", config.commands, []).ok, false);
  });
  it("allows unlisted commands only when the owner typed them", () => {
    assert.equal(checkCommand("/warp pvp", config.commands, ["去 pvp 区"]).ok, false);
    assert.equal(checkCommand("/warp pvp", config.commands, ["帮我执行 /warp pvp"]).ok, true);
    assert.equal(checkCommand("/warp pvp", config.commands, ["用“/warp”传送"]).ok, true);
  });
  it("parses command names", () => {
    assert.equal(commandName("/Essentials:Home  base"), "home");
    assert.deepEqual([...commandsMentioned(["先 /tpa Bob 再/home", "a/b 不是指令"])].sort(), ["home", "tpa"]);
  });
});

describe("chat", () => {
  it("matches custom chat formats", () => {
    const pats = compilePatterns(["^\\[(?<rank>[^\\]]+)\\] (?<user>\\w+) » (?<msg>.+)$"]);
    assert.deepEqual(matchPatterns("[VIP] Steve » 你好", pats), { user: "Steve", msg: "你好" });
    assert.equal(matchPatterns("random text", pats), null);
    assert.throws(() => compilePatterns(["^(\\w+): (.+)$"]), /named groups/);
  });

  it("rate-limits outgoing messages", async () => {
    let clock = 0;
    const sent: number[] = [];
    const s = new ChatSender({ minIntervalMs: 1_000, maxPerMinute: 3, maxLength: 100 }, () => sent.push(clock), () => clock);
    s.say("a");
    assert.equal(s.nextDelay(), 0);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 1);
    assert.equal(s.nextDelay(), 1_000);
    clock = 1_000;
    assert.equal(s.nextDelay(), 0);
    s.clear();
  });

  it("drops messages when the queue is full", () => {
    const s = new ChatSender({ minIntervalMs: 10_000, maxPerMinute: 1, maxLength: 100 }, () => {}, Date.now, 3);
    assert.equal(s.say("1"), true);
    assert.equal(s.say("2"), true);
    assert.equal(s.say("3"), true);
    assert.equal(s.say("4"), false);
    s.clear();
  });

  it("splits long messages and strips colors", () => {
    const parts = splitMessage("一二三四五。六七八九十。", 6);
    assert.ok(parts.every((p) => p.length <= 6));
    assert.equal(parts.join(""), "一二三四五。六七八九十。");
    assert.equal(stripColors("§a生存服&r!"), "生存服!");
  });
});

describe("agent addressing", () => {
  it("knows the owner", () => {
    assert.ok(isOwner(config, "steve"));
    assert.ok(!isOwner(config, "Alex"));
  });
  it("detects mentions and strips the name", () => {
    assert.equal(addressedText(config, "AIBot 过来"), "过来");
    assert.equal(addressedText(config, "@aibot，跟着我"), "跟着我");
    assert.equal(addressedText(config, "小助手：砍10个木头"), "砍10个木头");
    assert.equal(addressedText(config, "今天天气不错"), null);
  });
  it("detects stop words", () => {
    assert.ok(isStopWord(config, "停！"));
    assert.ok(isStopWord(config, "STOP"));
    assert.ok(!isStopWord(config, "停在那里等我"));
  });
  it("cleans model text for chat", () => {
    assert.equal(toChatText("**好的**\n- 已完成"), "好的 已完成");
    assert.equal(toChatText("缺少 oak_log 和 crafting_table"), "缺少 oak_log 和 crafting_table");
    assert.equal(toChatText("## 结果\n> 完成"), "结果 完成");
    assert.ok(toChatText("x".repeat(500)).length <= 200);
  });
});

describe("tools", () => {
  it("every action has a valid object schema and a unique name", () => {
    const names = new Set<string>();
    for (const a of ACTIONS) {
      const schema = toolInputSchema(a);
      assert.equal(schema.type, "object", a.name);
      assert.ok(!("$schema" in schema), a.name);
      assert.ok(!names.has(a.name), `duplicate ${a.name}`);
      names.add(a.name);
    }
    assert.ok(names.has("click_slot") && names.has("interact_entity") && names.has("run_command"));
  });
  it("system prompt is stable (cacheable)", () => {
    assert.equal(buildSystemPrompt(config), buildSystemPrompt(config));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(buildSystemPrompt(config)));
  });
});
