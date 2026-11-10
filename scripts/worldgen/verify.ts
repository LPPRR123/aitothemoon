/**
 * Runs the same data pack on every seed in targets.yaml's verify_seeds and prints one table.
 * One good-looking seed can be luck; a stage only counts as done when the other seeds agree.
 *
 *   npm run worldgen:verify
 */
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR, loadTargets } from "./lib.js";
import { fmt, target } from "./report.js";
import { Refused, runRound, type RoundResult } from "./round.js";

async function main() {
  const targets = loadTargets();
  if (targets.verify_seeds.length === 0) {
    console.error("targets.yaml 里没有写 verify_seeds。");
    process.exit(2);
  }
  const results: RoundResult[] = [];
  for (const seed of targets.verify_seeds) {
    results.push(await runRound({ seed, kind: "verify", force: false, keepWorld: false }));
  }
  const checks = targets.checks.filter((c) => c.stage <= targets.current_stage);
  const L: string[] = [];
  L.push(`# 换种子验证（阶段 ${targets.current_stage}）`, "");
  L.push(`| 检查 | 目标 | ${results.map((r) => `种子 ${r.record.seed}`).join(" | ")} |`);
  L.push(`|---|---|${results.map(() => "---|").join("")}`);
  for (const c of checks) {
    const cells = results.map((r) => {
      const res = r.checks?.find((x) => x.name === c.name);
      if (!res) return "这一轮失败了";
      return `${fmt(c.metric, res.value)}${res.status === "pass" ? "" : " **✗**"}`;
    });
    L.push(`| ${c.name} | ${target(c)} | ${cells.join(" | ")} |`);
  }
  L.push("");
  for (const r of results) L.push(`- 种子 ${r.record.seed}：${r.record.ok ? (r.record.passed ? "通过" : `不通过（${r.record.failedChecks!.join("、")}）`) : `失败（${r.record.error}）`}，报告 ${path.join(r.dir, "report.md")}`);
  const allPass = results.every((r) => r.record.ok && r.record.passed);
  L.push("", allPass ? "**所有种子都通过。**" : "**有种子没通过，这个阶段还不能算完成。**", "");
  const out = path.join(RUNS_DIR, "verify-latest.md");
  fs.writeFileSync(out, L.join("\n"));
  console.log("\n" + L.join("\n"));
  console.log(`已写入 ${out}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Refused ? e.message : e);
  process.exit(2);
});
