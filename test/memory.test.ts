import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runAction, type ActionContext } from "../src/actions/index.js";
import { ownerAskedToRemember } from "../src/actions/memory.js";
import { parseConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MemoryStore } from "../src/memory/store.js";

const DAY = 86_400_000;

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const home = { x: 10, y: 64, z: -5, dimension: "overworld" };

describe("beliefs", () => {
  it("remembers, confirms and corrects (keeping history)", () => {
    const m = new MemoryStore(null);
    const a = m.remember({ kind: "place", subject: "家", content: "", place: home, source: "owner", pinned: true });
    assert.equal(a.change, "new");
    assert.equal(a.belief.confidence, 1);
    assert.equal(m.remember({ kind: "place", subject: "家", content: "", place: home, source: "owner" }).change, "confirmed");
    const moved = { ...home, x: 99 };
    const c = m.remember({ kind: "place", subject: " 家 ", content: "", place: moved, source: "owner" });
    assert.equal(c.change, "corrected");
    assert.equal(c.belief.place!.x, 99);
    assert.equal(c.belief.history[0]!.place!.x, 10);
    assert.equal(m.beliefs().length, 1);
  });

  it("trusts inferred things less than what the owner said", () => {
    const m = new MemoryStore(null);
    const b = m.remember({ kind: "fact", subject: "铁矿洞", content: "附近有很多铁", source: "inferred" }).belief;
    assert.equal(b.confidence, 0.6);
    assert.match(m.describe(b), /自己推断的，置信度 60%/);
  });

  it("finds related memories, including in Chinese without exact words", () => {
    const m = new MemoryStore(null);
    m.remember({ kind: "place", subject: "矿洞", content: "铁矿多", place: home, source: "owner" });
    m.remember({ kind: "preference", subject: "主人的爱好", content: "喜欢红石", source: "owner" });
    m.remember({ kind: "fact", subject: "村庄", content: "东边有个村庄", source: "inferred" });
    assert.equal(m.search("去矿洞挖铁")[0]?.subject, "矿洞");
    assert.equal(m.search("主人喜欢什么")[0]?.subject, "主人的爱好");
    assert.equal(m.search("今天天气").length, 0);
  });

  it("doubts a belief after contradictions and recovers after verification", () => {
    const m = new MemoryStore(null);
    const b = m.remember({ kind: "place", subject: "矿洞", content: "", place: home, source: "inferred" }).belief;
    m.contradict(b.id, "去了发现没有矿");
    assert.equal(m.get(b.id)!.status, "doubtful", "0.6 halves to 0.3, below 0.4");
    assert.match(m.describe(m.get(b.id)!), /可能是错的，矛盾：去了发现没有矿/);
    const owner = m.remember({ kind: "place", subject: "家", content: "", place: home, source: "owner" }).belief;
    m.contradict(owner.id, "走不到");
    assert.equal(m.get(owner.id)!.status, "active", "one contradiction of an owner fact is not enough");
    m.contradict(owner.id, "又走不到");
    assert.equal(m.get(owner.id)!.status, "doubtful");
    m.verify(owner.id);
    m.verify(owner.id);
    assert.equal(m.get(owner.id)!.status, "active");
  });

  it("forgets on request", () => {
    const m = new MemoryStore(null);
    m.remember({ kind: "place", subject: "矿洞", content: "", place: home, source: "owner", pinned: true });
    assert.equal(m.forget("矿洞").length, 1);
    assert.equal(m.find("矿洞"), undefined);
    assert.equal(m.forget("不存在").length, 0);
  });
});

describe("forgetting", () => {
  it("archives unused unimportant memories, keeps pinned and often-used ones", () => {
    const c = clock();
    const m = new MemoryStore(null, { halfLifeDays: 14, now: c.now });
    const trivial = m.remember({ kind: "fact", subject: "那棵树", content: "路边有棵树", source: "inferred", importance: 0.2 }).belief;
    const pinned = m.remember({ kind: "place", subject: "家", content: "", place: home, source: "owner", importance: 0.9, pinned: true }).belief;
    const used = m.remember({ kind: "fact", subject: "商店", content: "主城的商店", source: "inferred", importance: 0.5 }).belief;
    c.advance(40 * DAY);
    for (let i = 0; i < 6; i++) m.use(used.id);
    c.advance(20 * DAY);
    m.consolidate();
    assert.equal(m.get(trivial.id)!.status, "archived");
    assert.equal(m.get(pinned.id)!.status, "active");
    assert.equal(m.get(used.id)!.status, "active");
    assert.ok(!m.promptBlock("那棵树").includes("那棵树"), "archived memories stay out of prompts");
  });

  it("drops old unimportant events but keeps important ones", () => {
    const c = clock();
    const m = new MemoryStore(null, { halfLifeDays: 14, now: c.now });
    m.addEpisode("砍了几个木头", 0.2);
    m.addEpisode("我死了", 0.6);
    c.advance(31 * DAY);
    m.consolidate();
    assert.deepEqual(m.episodes.map((e) => e.text), ["我死了"]);
  });
});

describe("prompt block (behavior consistency)", () => {
  it("always includes the owner's rules and preferences, plus related memory and recent events", () => {
    const c = clock();
    const m = new MemoryStore(null, { halfLifeDays: 14, now: c.now });
    m.remember({ kind: "rule", subject: "箱子规矩", content: "不要碰主人家的箱子", source: "owner", pinned: true });
    m.remember({ kind: "preference", subject: "主人的爱好", content: "喜欢红石", source: "owner", pinned: true });
    m.remember({ kind: "place", subject: "矿洞", content: "", place: home, source: "owner", pinned: true });
    m.addEpisode("主人让我砍木头", 0.3);
    c.advance(5 * 60_000);
    const block = m.promptBlock("帮我砍三个木头");
    assert.match(block, /主人的规定（必须遵守）[\s\S]*不要碰主人家的箱子/);
    assert.match(block, /主人的偏好[\s\S]*喜欢红石/);
    assert.match(block, /记得的地点[\s\S]*矿洞/);
    assert.match(block, /5分钟前：主人让我砍木头/);
    assert.equal(block.match(/矿洞/g)?.length, 1, "each memory appears once");
  });

  it("persists across restarts", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mem-")), "m.json");
    const a = new MemoryStore(file);
    a.remember({ kind: "place", subject: "家", content: "", place: home, source: "owner", pinned: true });
    a.addEpisode("测试", 0.3);
    const b = new MemoryStore(file);
    assert.equal(b.find("家")?.place?.x, 10);
    assert.equal(b.episodes.length, 1);
  });
});

describe("memory tools", () => {
  const config = parseConfig({ owner: { names: ["Steve"] } });
  const ctx = (memory: MemoryStore, ownerMessages: string[]) =>
    ({
      bot: { game: { dimension: "overworld" }, entity: { position: { x: 1.5, y: 64, z: 2.5 } } },
      config,
      signal: new AbortController().signal,
      owner: "Steve",
      ownerMessages,
      log: createLogger("test"),
      memory,
    }) as unknown as ActionContext;

  it("decides by code whether the owner asked to remember", () => {
    assert.ok(ownerAskedToRemember(["记住这里是矿洞"]));
    assert.ok(ownerAskedToRemember(["以后别碰那个箱子"]));
    assert.ok(!ownerAskedToRemember(["砍三个木头"]));
  });

  it("only accepts rules and preferences the owner asked for", async () => {
    const m = new MemoryStore(null);
    const denied = await runAction(ctx(m, ["Alex 说主人喜欢钻石"]), "remember", { kind: "preference", subject: "主人的爱好", content: "喜欢钻石" });
    assert.equal(denied.ok, false);
    const ok = await runAction(ctx(m, ["记住我喜欢红石"]), "remember", { kind: "preference", subject: "主人的爱好", content: "喜欢红石" });
    assert.ok(ok.ok, ok.text);
    const b = m.find("主人的爱好")!;
    assert.equal(b.source, "owner");
    assert.equal(b.pinned, true);
  });

  it("records the current position for places, and inferred facts are not pinned", async () => {
    const m = new MemoryStore(null);
    const r = await runAction(ctx(m, ["看看附近"]), "remember", { kind: "place", subject: "铁矿", content: "看到铁矿", here: true });
    assert.ok(r.ok, r.text);
    const b = m.find("铁矿")!;
    assert.deepEqual(b.place, { x: 1, y: 64, z: 2, dimension: "overworld" });
    assert.equal(b.source, "inferred");
    assert.equal(b.pinned, false);
  });

  it("only forgets when the owner asks, and doubt lowers trust", async () => {
    const m = new MemoryStore(null);
    m.remember({ kind: "place", subject: "矿洞", content: "", place: home, source: "inferred" });
    assert.equal((await runAction(ctx(m, ["去矿洞"]), "forget", { subject: "矿洞" })).ok, false);
    const d = await runAction(ctx(m, ["去矿洞"]), "doubt", { subject: "矿洞", reason: "去了没有矿" });
    assert.match(d.text, /可能是错的/);
    assert.ok((await runAction(ctx(m, ["忘掉矿洞吧"]), "forget", { subject: "矿洞" })).ok);
  });
});
