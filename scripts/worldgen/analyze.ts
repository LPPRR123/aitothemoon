/**
 * Recomputes the numbers, pictures and report of a round that already ran, without generating again.
 * Useful after changing regions, roads or checks in targets.yaml.
 *
 *   npm run worldgen:analyze               the latest round
 *   npm run worldgen:analyze -- --run 12   round 12
 */
import fs from "node:fs";
import path from "node:path";
import { loadRun } from "./data.js";
import { RUNS_DIR, loadTargets, manifestOf, parseArgs, readRounds } from "./lib.js";
import { analyzeRun, diffDatapack } from "./round.js";

const { values } = parseArgs(process.argv.slice(2));
const rounds = readRounds();
const ok = rounds.filter((r) => r.ok);
const rec = values.run ? ok.find((r) => r.round === Number(values.run)) : ok[ok.length - 1];
if (!rec) {
  console.error(values.run ? `找不到第 ${values.run} 轮（或者那一轮失败了）。` : "还没有跑成功过任何一轮。");
  process.exit(2);
}
const dir = path.join(RUNS_DIR, rec.dir);
if (!fs.existsSync(path.join(dir, "columns.bin"))) {
  console.error(`${dir} 里没有导出的数据，没法重新分析。`);
  process.exit(2);
}
const earlier = rounds.filter((r) => r.round < rec.round);
const prev = [...earlier].reverse().find((r) => r.ok && fs.existsSync(path.join(RUNS_DIR, r.dir, "datapack")));
const changes = prev ? diffDatapack(manifestOf(path.join(RUNS_DIR, prev.dir, "datapack")), manifestOf(path.join(dir, "datapack"))) : undefined;
const data = loadRun(dir);
const { checks } = analyzeRun({
  dir, data, round: rec.round, kind: rec.kind, seed: rec.seed, targets: loadTargets(), earlier, changes,
  forced: rec.forced ?? [], totalSeconds: () => Math.round((data.meta.generateMs + data.meta.exportMs) / 1000),
});
const failed = checks.filter((c) => c.status === "fail" || c.status === "missing").map((c) => c.name);
console.log(`已按现在的 targets.yaml 重新分析第 ${rec.round} 轮：${path.join(dir, "report.md")}`);
console.log(failed.length ? `没达标的检查：${failed.join("、")}` : "当前阶段的检查全部通过。");
