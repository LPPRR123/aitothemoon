import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NO_WATER } from "../scripts/worldgen/data.js";
import type { RoundRecord, Targets } from "../scripts/worldgen/lib.js";
import {
  computeMetrics, corridorStats, evaluateChecks, largestFlatSquare, largestLandmassShare, metricValue, slopes, surfaceHeights,
  type Grid, type MetricsOptions,
} from "../scripts/worldgen/metrics.js";
import { diffDatapack, roundsSinceFeedback, stageViolations, validateDatapack } from "../scripts/worldgen/round.js";
import { extractDatapackErrors } from "../scripts/worldgen/server.js";
import { resolveBiomeTag } from "../scripts/worldgen/tags.js";

const SEA = 63;

/** A small world built from a function: height(x, z), optional water level, optional biome. */
function grid(size: number, f: (x: number, z: number) => { h: number; water?: number; biome?: string }): Grid {
  const groundY = new Int16Array(size * size), waterY = new Int16Array(size * size), biome = new Uint16Array(size * size);
  const biomes: string[] = [];
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const c = f(x, z);
      const i = z * size + x;
      groundY[i] = c.h;
      waterY[i] = c.water ?? NO_WATER;
      const name = c.biome ?? "minecraft:plains";
      if (!biomes.includes(name)) biomes.push(name);
      biome[i] = biomes.indexOf(name);
    }
  }
  return { size, x0: 0, z0: 0, seaLevel: SEA, groundY, waterY, biome, biomes };
}

const opts = (over: Partial<MetricsOptions> = {}): MetricsOptions => ({
  groups: {}, regions: {}, corridors: {}, maxRelief: 4,
  oceanBiomes: new Set(["minecraft:ocean"]), riverBiomes: new Set(["minecraft:river"]), ...over,
});

test("一块平地：全是平缓，没有水，最大平地就是整块", () => {
  const m = computeMetrics(grid(32, () => ({ h: 70 })), opts());
  assert.equal(m.flat_share, 1);
  assert.equal(m.cliff_share, 0);
  assert.equal(m.water_share, 0);
  assert.equal(m.largest_flat_square.size, 32);
  assert.equal(m.largest_landmass_share, 1);
  assert.deepEqual([m.land_height.min, m.land_height.p50, m.land_height.max], [70, 70, 70]);
  assert.deepEqual(m.land_height_histogram, { "64": 1 });
});

test("一道悬崖：只有悬崖两侧的两列算悬崖，最大平地在宽的那一侧", () => {
  // x < 20 的地方高 70，其余高 90
  const m = computeMetrics(grid(32, (x) => ({ h: x < 20 ? 70 : 90 })), opts());
  assert.equal(m.cliff_share, (2 * 32) / (32 * 32));
  assert.equal(m.flat_share, 1 - m.cliff_share);
  assert.equal(m.largest_flat_square.size, 19); // x = 0..18，第 19 列挨着悬崖
  assert.equal(m.relief, 20);
  assert.equal(m.points.highest.y, 90);
  assert.equal(m.points.steepest.slope, 20);
});

test("缓坡每格升 1：处处平缓，但整块高差限制了最大平地", () => {
  const g = grid(32, (x) => ({ h: 64 + x }));
  const slope = slopes(32, surfaceHeights(g));
  assert.equal(largestFlatSquare(g, slope, 4).size, 5); // 5 列宽，高差正好 4
  assert.equal(largestFlatSquare(g, slope, 100).size, 32);
});

test("一片海：海洋和水面占比、陆地被水分成两块", () => {
  // 中间 x = 10..19 是海，两边是陆地（左边 10 列，右边 12 列）
  const g = grid(32, (x) => (x >= 10 && x < 20 ? { h: 40, water: 62, biome: "minecraft:ocean" } : { h: 66 }));
  const m = computeMetrics(g, opts());
  assert.equal(m.water_share, 0.3125);
  assert.equal(m.ocean_share, 0.3125);
  assert.equal(m.land_share, 0.6875);
  assert.equal(largestLandmassShare(g), Math.round((12 / 22) * 10000) / 10000);
  assert.equal(m.largest_flat_square.size, 11); // 右边 12 列里，挨着海的那一列坡度是 4
  assert.equal(m.land_height.p50, 66); // 水下的地面不算陆地高度
});

test("低于海平面的陆地不算可建平地", () => {
  const g = grid(16, () => ({ h: 50 }));
  assert.equal(largestFlatSquare(g, slopes(16, surfaceHeights(g)), 4).size, 0);
});

test("群系占比、群系组、区域", () => {
  const g = grid(20, (_x, z) => ({ h: 70, biome: z < 5 ? "minecraft:frozen_peaks" : "minecraft:plains" }));
  const m = computeMetrics(g, opts({ groups: { 雪山: ["minecraft:frozen_peaks", "minecraft:grove"] }, regions: { north: { x: [0, 20], z: [0, 10] } } }));
  assert.equal(m.biome_share["minecraft:frozen_peaks"], 0.25);
  assert.equal(m.group_share["雪山"], 0.25);
  assert.equal(m.top_biome, "minecraft:plains");
  assert.equal(m.regions["north"]!.columns, 200);
  assert.equal(m.regions["north"]!.group_share["雪山"], 0.5);
  assert.equal(metricValue(m, "regions.north.group_share.雪山"), 0.5);
  assert.equal(metricValue(m, "biome_share.minecraft:plains"), 0.75);
  assert.equal(metricValue(m, "biome_share.minecraft:desert"), 0); // 没出现的群系算 0
  assert.equal(metricValue(m, "no_such_metric"), null);
});

test("道路：台阶、爬升、泡水", () => {
  // 沿 x 走：x < 10 高 70，x = 10..14 是水（水面 68），之后高 73
  const g = grid(32, (x) => (x < 10 ? { h: 70 } : x < 15 ? { h: 60, water: 68 } : { h: 73 }));
  const c = corridorStats(g, surfaceHeights(g), "路", { points: [[2, 16], [29, 16]], width: 3 });
  assert.equal(c.length, 28);
  assert.equal(c.max_step, 5); // 68 -> 73
  assert.equal(c.total_climb, 5);
  assert.equal(c.total_descent, 2); // 70 -> 68
  assert.equal(c.water_share, Math.round((5 / 28) * 10000) / 10000);
  assert.equal(c.max_cross_relief, 0);
  assert.throws(() => corridorStats(g, surfaceHeights(g), "路", { points: [[0, 0], [40, 0]], width: 1 }), /区域外面/);
});

test("检查：通过、不通过、还没到阶段、找不到指标", () => {
  const m = { flat_share: 0.5, land_height: { p95: 100 } };
  const r = evaluateChecks(m, [
    { name: "a", metric: "flat_share", min: 0.35, max: 0.65, stage: 1 },
    { name: "b", metric: "land_height.p95", min: 120, stage: 1 },
    { name: "c", metric: "land_height.p95", min: 120, stage: 3 },
    { name: "d", metric: "nope", min: 1, stage: 1 },
  ], 1);
  assert.deepEqual(r.map((x) => x.status), ["pass", "fail", "later", "missing"]);
});

test("生物群系标签：内置的原版内容，数据包可以追加或替换", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-tags-"));
  try {
    const ocean = resolveBiomeTag("minecraft:is_ocean", path.join(dir, "none"), path.join(dir, "none"));
    assert.ok(ocean.has("minecraft:deep_ocean") && ocean.has("minecraft:warm_ocean"));
    assert.equal(ocean.size, 9);
    const tagDir = path.join(dir, "pack", "data", "minecraft", "tags", "worldgen", "biome");
    fs.mkdirSync(tagDir, { recursive: true });
    fs.writeFileSync(path.join(tagDir, "is_ocean.json"), JSON.stringify({ values: ["aitothemoon:deep_sea"] }));
    assert.equal(resolveBiomeTag("minecraft:is_ocean", path.join(dir, "none"), path.join(dir, "pack")).size, 10);
    fs.writeFileSync(path.join(tagDir, "is_ocean.json"), JSON.stringify({ replace: true, values: ["aitothemoon:deep_sea"] }));
    assert.deepEqual([...resolveBiomeTag("minecraft:is_ocean", path.join(dir, "none"), path.join(dir, "pack"))], ["aitothemoon:deep_sea"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("数据包检查：坏 JSON 和错的 pack_format 会被挡下", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-pack-"));
  try {
    assert.match(validateDatapack(dir)[0]!, /不存在/);
    fs.writeFileSync(path.join(dir, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 15, description: "" } }));
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "bad.json"), '{"a": 1,}');
    const problems = validateDatapack(dir);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes("pack_format")) && problems.some((p) => p.includes("bad.json")));
    fs.writeFileSync(path.join(dir, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 26, description: "" } }));
    fs.rmSync(path.join(dir, "data", "bad.json"));
    assert.deepEqual(validateDatapack(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("分层：只能改当前阶段允许的文件和字段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-stage-"));
  try {
    const ns = "data/minecraft/worldgen/noise_settings/overworld.json";
    const write = (root: string, rel: string, obj: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, root, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, root, rel), JSON.stringify(obj));
    };
    write("before", ns, { sea_level: 63, surface_rule: { a: 1 } });
    write("now", ns, { sea_level: 70, surface_rule: { a: 2 } });
    const stages = {
      "1": { name: "大地形", allow: ["data/minecraft/worldgen/noise_settings/"], only_keys: {} },
      "2": { name: "地表方块", allow: [ns], only_keys: { [ns]: ["surface_rule"] } },
    };
    const changes = { added: ["data/minecraft/worldgen/biome/plains.json"], changed: [ns], removed: [] };
    const at = (stage: number) => stageViolations({ current_stage: stage, stages } as unknown as Targets, changes, path.join(dir, "before"), path.join(dir, "now"));
    assert.equal(at(1).length, 1); // 群系文件不能改，地形文件可以
    assert.match(at(1)[0]!, /biome\/plains\.json/);
    assert.equal(at(2).length, 2); // 群系文件不能改；地形文件里 sea_level 不能改
    assert.ok(at(2).some((v) => v.includes("sea_level")));
    assert.deepEqual(diffDatapack({ a: "1", b: "1", c: "1" }, { a: "1", b: "2", d: "1" }), { added: ["d"], changed: ["b"], removed: ["c"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("人工把关：只数反馈没变之后、主种子上成功的轮数", () => {
  const rec = (over: Partial<RoundRecord>): RoundRecord => ({
    round: 1, kind: "round", dir: "", seed: "1", time: "", stage: 1, datapack: "", feedback: "A", ok: true, ...over,
  });
  const rounds = [rec({ feedback: "old" }), rec({}), rec({ kind: "verify" }), rec({ ok: false }), rec({})];
  assert.equal(roundsSinceFeedback(rounds, "A"), 2);
  assert.equal(roundsSinceFeedback(rounds, "B"), 0); // 反馈刚更新过
});

test("从服务端日志里取出数据包报错", () => {
  const log = [
    "[09:51:22 INFO]: Found new data pack file/aitothemoon-worldgen, loading it automatically",
    "[09:51:22 ERROR]: Registry loading errors:",
    "> Errors in registry minecraft:worldgen/noise_settings:",
    ">> Errors in element minecraft:overworld:",
    "java.lang.IllegalStateException: Failed to parse minecraft:worldgen/noise_settings/overworld.json from pack file/aitothemoon-worldgen",
    "\tat net.minecraft.resources.RegistryDataLoader.loadRegistryContents(RegistryDataLoader.java:195) ~[?:?]",
    'Caused by: java.lang.RuntimeException: Not a number: "high"',
    "\t... 14 more",
    "",
    "[09:51:22 WARN]: Failed to load datapacks, can't proceed with server load. You can either fix your datapacks or reset to vanilla with --safeMode",
    "java.util.concurrent.ExecutionException: java.lang.IllegalStateException: Failed to load registries due to above errors",
  ].join("\n");
  const lines = extractDatapackErrors(log);
  assert.equal(lines[0], "Registry loading errors:");
  assert.ok(lines.some((l) => l.includes('Not a number: "high"')));
  assert.ok(lines.some((l) => l.includes("overworld.json")));
  assert.ok(!lines.some((l) => /^\s+at /.test(l)));
  assert.deepEqual(extractDatapackErrors("[09:00:00 INFO]: Done (9.1s)!"), []);
});
