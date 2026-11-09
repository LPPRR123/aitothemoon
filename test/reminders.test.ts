import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDue, isGameNight, parseReminder } from "../src/memory/reminders.js";
import { MemoryStore } from "../src/memory/store.js";

const NOW = new Date(2026, 10, 9, 14, 30).getTime();

describe("reminder parsing (no model call)", () => {
  it("understands relative times", () => {
    assert.deepEqual(parseReminder("5分钟后提醒我关熔炉", NOW), { due: { type: "time", at: NOW + 5 * 60_000 }, repeat: false, text: "关熔炉" });
    assert.equal((parseReminder("过半小时提醒我收菜", NOW)!.due as { at: number }).at, NOW + 30 * 60_000);
    assert.equal((parseReminder("两个小时后提醒我下线", NOW)!.due as { at: number }).at, NOW + 2 * 3_600_000);
    assert.equal((parseReminder("十秒后提醒我看一下", NOW)!.due as { at: number }).at, NOW + 10_000);
  });
  it("understands tomorrow", () => {
    const r = parseReminder("明天晚上提醒我打 boss", NOW)!;
    const d = new Date((r.due as { at: number }).at);
    assert.deepEqual([d.getDate(), d.getHours()], [10, 20]);
    assert.equal(r.text, "打boss");
  });
  it("understands game night/day, once or every day", () => {
    assert.deepEqual(parseReminder("天黑了提醒我回家", NOW), { due: { type: "night" }, repeat: false, text: "回家" });
    assert.deepEqual(parseReminder("每天晚上提醒我睡觉", NOW), { due: { type: "night" }, repeat: true, text: "睡觉" });
    assert.deepEqual(parseReminder("天亮提醒我出门", NOW), { due: { type: "day" }, repeat: false, text: "出门" });
  });
  it("leaves unusual wording to the model", () => {
    assert.equal(parseReminder("等我挖完矿记得提醒我吃饭", NOW), null);
    assert.equal(parseReminder("帮我砍木头", NOW), null);
  });
  it("describes when", () => {
    assert.equal(describeDue({ type: "time", at: NOW + 5 * 60_000 }, false, NOW), "5 分钟后");
    assert.equal(describeDue({ type: "night" }, true, NOW), "每天游戏里天黑时");
    assert.ok(isGameNight(18_000) && !isGameNight(6_000));
  });
});

describe("reminder delivery", () => {
  it("fires timed reminders when due, waiting for the owner to be online", () => {
    let t = NOW;
    const m = new MemoryStore(null, { halfLifeDays: 14, now: () => t });
    m.addReminder({ owner: "Steve", text: "关熔炉", due: { type: "time", at: NOW + 60_000 }, repeat: false });
    const day = { isNight: false, day: 1 };
    assert.equal(m.takeDueReminders(day, () => true).length, 0);
    t += 61_000;
    assert.equal(m.takeDueReminders(day, () => false).length, 0, "owner offline: keep waiting");
    assert.deepEqual(m.takeDueReminders(day, () => true).map((r) => r.text), ["关熔炉"]);
    assert.equal(m.takeDueReminders(day, () => true).length, 0, "only once");
    assert.equal(m.reminders().length, 0);
  });
  it("fires night reminders once per night; repeating ones every night", () => {
    const m = new MemoryStore(null);
    m.addReminder({ owner: "Steve", text: "回家", due: { type: "night" }, repeat: false });
    m.addReminder({ owner: "Steve", text: "睡觉", due: { type: "night" }, repeat: true });
    const on = () => true;
    assert.equal(m.takeDueReminders({ isNight: false, day: 3 }, on).length, 0);
    assert.deepEqual(m.takeDueReminders({ isNight: true, day: 3 }, on).map((r) => r.text).sort(), ["回家", "睡觉"]);
    assert.equal(m.takeDueReminders({ isNight: true, day: 3 }, on).length, 0, "same night: not again");
    assert.deepEqual(m.takeDueReminders({ isNight: true, day: 4 }, on).map((r) => r.text), ["睡觉"]);
    assert.deepEqual(m.reminders().map((r) => r.text), ["睡觉"]);
  });
  it("can be listed and cancelled", () => {
    const m = new MemoryStore(null);
    const r = m.addReminder({ owner: "Steve", text: "收菜", due: { type: "day" }, repeat: true });
    assert.equal(m.reminders().length, 1);
    assert.ok(m.cancelReminder(r.id));
    assert.ok(!m.cancelReminder(r.id));
    assert.equal(m.reminders().length, 0);
  });
});

describe("retrieval", () => {
  const p = { x: 1, y: 64, z: 1, dimension: "overworld" };
  it("finds places by a close name, but not ambiguous ones", () => {
    const m = new MemoryStore(null);
    m.remember({ kind: "place", subject: "铁矿洞", content: "", place: p, source: "owner" });
    m.remember({ kind: "place", subject: "主城商店", content: "", place: p, source: "owner" });
    assert.equal(m.findPlace("铁矿")?.subject, "铁矿洞");
    assert.equal(m.findPlace("商店")?.subject, "主城商店");
    assert.equal(m.findPlace("钻石矿"), undefined);
    m.remember({ kind: "place", subject: "金矿洞", content: "", place: p, source: "owner" });
    assert.equal(m.findPlace("矿洞"), undefined, "铁矿洞 and 金矿洞 are equally close: ask instead");
  });
  it("shows an index of other memories so the model can look things up by meaning", () => {
    const m = new MemoryStore(null);
    m.remember({ kind: "fact", subject: "主城", content: "就是 /spawn 去的地方", source: "inferred" });
    m.remember({ kind: "fact", subject: "刷铁机", content: "在基地东边", source: "inferred" });
    const block = m.promptBlock("帮我弄点铁锭");
    assert.match(block, /记忆目录[\s\S]*主城/);
  });
  it("keeps only the last few versions of a belief", () => {
    const m = new MemoryStore(null);
    for (let i = 0; i < 9; i++) m.remember({ kind: "fact", subject: "菜单「商店」", content: `版本 ${i}`, source: "observed" });
    assert.equal(m.find("菜单「商店」")!.history.length, 5);
  });
});
