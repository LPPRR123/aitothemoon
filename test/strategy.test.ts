import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseConfig } from "../src/config.js";
import { gainedItems, normalizeTitle, sameWindow } from "../src/strategy/checks.js";
import { reviewStrategy, type CompiledStrategy, type TraceEntry } from "../src/strategy/compiler.js";
import { StrategyLibrary } from "../src/strategy/library.js";
import { fillReply, instantiate, matchTrigger, normalizeInstruction, parseNumber, type ParamSpec } from "../src/strategy/matcher.js";

const config = parseConfig({ owner: { names: ["Steve"] }, commands: { allow: ["menu", "home"] } });

const logParams: ParamSpec[] = [
  { name: "count", type: "number", values: [] },
  { name: "block", type: "word", values: [{ word: "木头", value: "oak_log" }, { word: "原木", value: "oak_log" }, { word: "白桦木", value: "birch_log" }] },
];

describe("matcher", () => {
  it("normalizes polite words and punctuation", () => {
    assert.equal(normalizeInstruction("帮我砍三个木头吧！"), "砍三个木头");
    assert.equal(normalizeInstruction("请你 去 100 64 -200 一下"), "去 100 64 -200");
  });
  it("parses Chinese numbers", () => {
    assert.equal(parseNumber("三"), 3);
    assert.equal(parseNumber("两"), 2);
    assert.equal(parseNumber("十二"), 12);
    assert.equal(parseNumber("二十"), 20);
    assert.equal(parseNumber("一百零五"), 105);
    assert.equal(parseNumber("64"), 64);
    assert.equal(parseNumber("几"), null);
  });
  it("matches triggers with params and a closed vocabulary", () => {
    const v = matchTrigger("帮我砍两个原木", "砍{count}个{block}", logParams);
    assert.deepEqual(v, { count: { value: 2, said: "两" }, block: { value: "oak_log", said: "原木" } });
    assert.equal(matchTrigger("砍两个钻石", "砍{count}个{block}", logParams), null, "unknown word = new situation");
    assert.equal(matchTrigger("砍个木头", "砍{count}个{block}", logParams), null);
    assert.equal(matchTrigger("砍100个木头", "砍{count}个{block}", logParams), null, "count limited to 64");
    const c = matchTrigger("去 10 64 -5", "去{x} {y} {z}", [
      { name: "x", type: "coord", values: [] },
      { name: "y", type: "coord", values: [] },
      { name: "z", type: "coord", values: [] },
    ]);
    assert.deepEqual(c && [c.x!.value, c.y!.value, c.z!.value], [10, 64, -5]);
  });
  it("fills steps and replies", () => {
    const values = matchTrigger("砍三个白桦木", "砍{count}个{block}", logParams)!;
    assert.deepEqual(instantiate({ block: "{block}", count: "{count}", to: "{owner}" }, values, "Steve"), {
      block: "birch_log",
      count: 3,
      to: "Steve",
    });
    assert.equal(fillReply("砍好了 {count} 个{block}，{result}", values, "Steve", "OK"), "砍好了 三 个白桦木，OK");
  });
});

const compiledLogs: CompiledStrategy = {
  reusable: true,
  reason: "",
  name: "砍原木",
  triggers: ["砍{count}个{block}", "去砍{count}个{block}"],
  params: logParams,
  steps: [{ tool: "collect_block", input_json: '{"block":"{block}","count":"{count}"}' }],
  reply: "砍好了 {count} 个{block}",
};
const traceLogs: TraceEntry[] = [
  { tool: "get_status", input: {}, ok: true, text: "..." },
  { tool: "collect_block", input: { block: "oak_log", count: 3 }, ok: true, text: "挖掉了 3 个方块" },
];

describe("review", () => {
  const input = { instruction: "砍三个木头", owner: "Steve", trace: traceLogs };

  it("accepts a strategy that replays the successful steps", () => {
    const r = reviewStrategy(compiledLogs, input, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) {
      assert.equal(r.candidate.status, "probation");
      assert.equal(r.candidate.risk, "medium");
    }
  });
  it("rejects a strategy whose replay differs from what actually worked", () => {
    const wrong = { ...compiledLogs, steps: [{ tool: "collect_block", input_json: '{"block":"{block}","count":1}' }] };
    const r = reviewStrategy(wrong, input, config);
    assert.ok(!r.ok && /不一致/.test(r.reason));
  });
  it("rejects triggers that do not match the original words, or are too broad", () => {
    assert.ok(!reviewStrategy({ ...compiledLogs, triggers: ["挖{count}块{block}"] }, input, config).ok);
    assert.ok(!reviewStrategy({ ...compiledLogs, triggers: ["{block}"] }, input, config).ok);
  });
  it("rejects non-reusable and read-only tasks", () => {
    assert.ok(!reviewStrategy({ ...compiledLogs, reusable: false, reason: "闲聊" }, input, config).ok);
    const readOnly = { ...compiledLogs, triggers: ["砍{count}个{block}"], steps: [{ tool: "get_status", input_json: "{}" }] };
    assert.ok(!reviewStrategy(readOnly, input, config).ok);
  });
  it("holds high-risk strategies for approval", () => {
    const give: CompiledStrategy = {
      reusable: true,
      reason: "",
      name: "给我面包",
      triggers: ["给我面包", "把面包给我"],
      params: [],
      steps: [{ tool: "give_item", input_json: '{"item":"bread","player":"{owner}"}' }],
      reply: "给你了",
    };
    const r = reviewStrategy(give, { instruction: "给我面包", owner: "Steve", trace: [{ tool: "give_item", input: { item: "bread", player: "Steve" }, ok: true, text: "ok" }] }, config);
    assert.ok(r.ok && r.candidate.status === "pending" && r.candidate.risk === "high");
  });
  it("rejects commands outside the allow list", () => {
    const warp: CompiledStrategy = {
      reusable: true, reason: "", name: "去pvp", triggers: ["去pvp区", "传送到pvp"], params: [],
      steps: [{ tool: "run_command", input_json: '{"command":"/warp pvp"}' }], reply: "到了",
    };
    const r = reviewStrategy(warp, { instruction: "去pvp区", owner: "Steve", trace: [{ tool: "run_command", input: { command: "/warp pvp" }, ok: true, text: "" }] }, config);
    assert.ok(!r.ok && /允许列表/.test(r.reason));
  });
  it("accepts menu clicks learned by button text", () => {
    const menu: CompiledStrategy = {
      reusable: true, reason: "", name: "买面包", triggers: ["买面包", "去菜单买面包"], params: [],
      steps: [
        { tool: "run_command", input_json: '{"command":"/menu"}' },
        { tool: "click_slot", input_json: '{"name":"商店"}' },
        { tool: "click_slot", input_json: '{"name":"面包"}' },
        { tool: "close_window", input_json: "{}" },
      ],
      reply: "买好了",
    };
    const trace: TraceEntry[] = [
      { tool: "run_command", input: { command: "/menu" }, ok: true, text: "" },
      { tool: "click_slot", input: { slot: 13 }, ok: true, text: "", meta: { clickedName: "商店" } },
      { tool: "click_slot", input: { slot: 10 }, ok: true, text: "", meta: { clickedName: "面包 x5" } },
      { tool: "close_window", input: {}, ok: true, text: "" },
    ];
    const r = reviewStrategy(menu, { instruction: "买面包", owner: "Steve", trace }, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    const bad = trace.map((t) => (t.tool === "click_slot" && t.input.slot === 10 ? { ...t, meta: { clickedName: "橡木原木 x8" } } : t));
    assert.ok(!reviewStrategy(menu, { instruction: "买面包", owner: "Steve", trace: bad }, config).ok);
  });
});

describe("library", () => {
  const candidate = () => {
    const r = reviewStrategy(compiledLogs, { instruction: "砍三个木头", owner: "Steve", trace: traceLogs }, config);
    assert.ok(r.ok);
    return r.candidate;
  };

  it("matches, promotes after successes, and persists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "strat-")), "s.json");
    const lib = new StrategyLibrary(file, { promoteAfter: 2 });
    const { strategy } = lib.add(candidate());
    assert.ok(lib.match("帮我砍五个原木"));
    assert.equal(lib.match("今天天气不错"), null);
    lib.recordResult(strategy.id, true);
    assert.equal(lib.get(strategy.id)!.status, "probation");
    lib.recordResult(strategy.id, true);
    assert.equal(lib.get(strategy.id)!.status, "active");
    const again = new StrategyLibrary(file);
    assert.equal(again.get(strategy.id)!.status, "active");
    assert.equal(again.totals.strategyRuns, 2);
  });
  it("disables strategies that keep failing, and on request", () => {
    const lib = new StrategyLibrary(null);
    const a = lib.add(candidate()).strategy;
    lib.recordResult(a.id, false);
    lib.recordResult(a.id, false);
    assert.equal(lib.get(a.id)!.status, "disabled");
    assert.equal(lib.match("砍三个木头"), null);
  });
  it("merges a strategy with the same steps instead of duplicating it", () => {
    const lib = new StrategyLibrary(null);
    lib.add(candidate());
    const more = candidate();
    more.triggers = ["弄{count}个{block}"];
    more.params = [{ name: "block", type: "word", values: [{ word: "橡木", value: "oak_log" }] }, { name: "count", type: "number", values: [] }];
    const { merged, strategy } = lib.add(more);
    assert.ok(merged);
    assert.equal(lib.all.length, 1);
    assert.ok(strategy.triggers.includes("弄{count}个{block}"));
    assert.ok(lib.match("弄四个橡木"));
  });
});

describe("environment checks", () => {
  it("compares window titles loosely", () => {
    assert.ok(sameWindow("商店 第2页 余额:150", "§8商店 第3页 余额:20"));
    assert.ok(!sameWindow("服务器菜单", "活动菜单"));
    assert.ok(sameWindow(null, null));
    assert.ok(!sameWindow(null, "服务器菜单"));
    assert.equal(normalizeTitle(null), null);
  });
  it("finds gained items", () => {
    const before = new Map([["oak_log", 2], ["dirt", 5]]);
    const after = new Map([["oak_log", 5], ["dirt", 4], ["oak_sapling", 1]]);
    assert.deepEqual(gainedItems(before, after).sort(), ["oak_log", "oak_sapling"]);
  });
  it("attaches recorded windows and expected gains to a learned strategy", () => {
    const menu: CompiledStrategy = {
      reusable: true, reason: "", name: "买面包", triggers: ["买面包", "去菜单买面包"], params: [],
      steps: [
        { tool: "run_command", input_json: '{"command":"/menu"}' },
        { tool: "click_slot", input_json: '{"name":"商店"}' },
        { tool: "click_slot", input_json: '{"name":"面包"}' },
        { tool: "close_window", input_json: "{}" },
      ],
      reply: "买好了",
    };
    const trace: TraceEntry[] = [
      { tool: "run_command", input: { command: "/menu" }, ok: true, text: "", preWindow: null, postWindow: "服务器菜单" },
      { tool: "click_slot", input: { slot: 13 }, ok: true, text: "", meta: { clickedName: "商店" }, preWindow: "服务器菜单", postWindow: "商店" },
      { tool: "click_slot", input: { slot: 10 }, ok: true, text: "", meta: { clickedName: "面包 x5" }, preWindow: "商店", postWindow: "商店" },
      { tool: "close_window", input: {}, ok: true, text: "", preWindow: "商店", postWindow: null },
    ];
    const r = reviewStrategy(menu, { instruction: "买面包", owner: "Steve", trace, gained: ["bread"] }, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    const checks = r.candidate.steps.map((st) => st.check);
    assert.deepEqual(checks[0], { postWindow: "服务器菜单" }, "commands check what they opened, not what was open before");
    assert.deepEqual(checks[1], { preWindow: "服务器菜单", postWindow: "商店" });
    assert.deepEqual(checks[3], { preWindow: "商店" });
    assert.deepEqual(r.candidate.expect, { gained: ["bread"] });
  });
  it("turns gained items that came from a param into a template", () => {
    const r = reviewStrategy(compiledLogs, { instruction: "砍三个木头", owner: "Steve", trace: traceLogs, gained: ["oak_log", "oak_sapling"] }, config);
    assert.ok(r.ok && r.candidate.expect);
    if (r.ok) assert.deepEqual(r.candidate.expect!.gained.sort(), ["oak_sapling", "{block}"].sort());
  });
});

describe("position and held-item checks", () => {
  it("records the dimension for location-bound steps and teleports for commands", () => {
    const home: CompiledStrategy = {
      reusable: true, reason: "", name: "回家", triggers: ["回家", "传送回家"], params: [],
      steps: [{ tool: "run_command", input_json: '{"command":"/home"}' }], reply: "到家了",
    };
    const trace: TraceEntry[] = [
      { tool: "run_command", input: { command: "/home" }, ok: true, text: "", preWindow: null, postWindow: null, preDimension: "overworld", moved: true },
    ];
    const r = reviewStrategy(home, { instruction: "回家", owner: "Steve", trace }, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) assert.deepEqual(r.candidate.steps[0]!.check, { postWindow: null, postMoved: true });

    const logs = reviewStrategy(compiledLogs, {
      instruction: "砍三个木头", owner: "Steve",
      trace: traceLogs.map((t) => ({ ...t, preDimension: "overworld", moved: false })),
    }, config);
    assert.ok(logs.ok);
    if (logs.ok) assert.deepEqual(logs.candidate.steps[0]!.check, { preDimension: "overworld" });
  });
  it("makes a bare right-click take out the item that was in hand", () => {
    const compass: CompiledStrategy = {
      reusable: true, reason: "", name: "指南针菜单", triggers: ["用指南针开菜单", "打开指南针菜单"], params: [],
      steps: [{ tool: "use_held_item", input_json: "{}" }], reply: "打开了",
    };
    const trace: TraceEntry[] = [
      { tool: "use_held_item", input: {}, ok: true, text: "", preWindow: null, postWindow: "服务器菜单", preHeld: "compass" },
    ];
    const r = reviewStrategy(compass, { instruction: "用指南针开菜单", owner: "Steve", trace }, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) assert.deepEqual(r.candidate.steps[0]!.input, { item: "compass" });
    // A model that already wrote the item explicitly is accepted too.
    const explicit = { ...compass, steps: [{ tool: "use_held_item", input_json: '{"item":"compass"}' }] };
    assert.ok(reviewStrategy(explicit, { instruction: "用指南针开菜单", owner: "Steve", trace }, config).ok);
    const wrongItem = { ...compass, steps: [{ tool: "use_held_item", input_json: '{"item":"clock"}' }] };
    assert.ok(!reviewStrategy(wrongItem, { instruction: "用指南针开菜单", owner: "Steve", trace }, config).ok);
  });
});

describe("survival actions in strategies", () => {
  it("pins the chest a strategy was learned with", () => {
    const put: CompiledStrategy = {
      reusable: true, reason: "", name: "放泥土", triggers: ["把泥土放进箱子", "泥土放箱子"], params: [],
      steps: [{ tool: "put_in_chest", input_json: '{"item":"dirt"}' }], reply: "放好了",
    };
    const trace: TraceEntry[] = [
      { tool: "put_in_chest", input: { item: "dirt" }, ok: true, text: "", meta: { chestAt: { x: 5, y: 64, z: -3 } }, preDimension: "overworld" },
    ];
    const r = reviewStrategy(put, { instruction: "把泥土放进箱子", owner: "Steve", trace }, config);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) {
      assert.deepEqual(r.candidate.steps[0]!.input, { item: "dirt", x: 5, y: 64, z: -3 });
      assert.deepEqual(r.candidate.steps[0]!.check, { preDimension: "overworld" });
    }
    const otherChest = { ...put, steps: [{ tool: "put_in_chest", input_json: '{"item":"dirt","x":9,"y":64,"z":9}' }] };
    assert.ok(!reviewStrategy(otherChest, { instruction: "把泥土放进箱子", owner: "Steve", trace }, config).ok);
  });
  it("does not expect fixed loot from fighting", () => {
    const fight: CompiledStrategy = {
      reusable: true, reason: "", name: "杀牛", triggers: ["杀一头牛", "去杀牛"], params: [],
      steps: [{ tool: "attack_mob", input_json: '{"mob":"cow"}' }], reply: "杀了",
    };
    const trace: TraceEntry[] = [{ tool: "attack_mob", input: { mob: "cow" }, ok: true, text: "" }];
    const r = reviewStrategy(fight, { instruction: "杀一头牛", owner: "Steve", trace, gained: ["beef", "leather"] }, config);
    assert.ok(r.ok && r.candidate.expect === undefined);
  });
});
