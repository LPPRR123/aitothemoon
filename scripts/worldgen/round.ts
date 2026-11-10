/**
 * Runs one round: fresh world with the data pack and a fixed seed -> generate -> export ->
 * pictures, numbers, report. Output goes to worldgen/runs/NNNN-sSEED/.
 *
 *   npm run worldgen:round                 use the seed in targets.yaml
 *   npm run worldgen:round -- --seed 42    another seed
 *   npm run worldgen:round -- --keep-world also keep a copy of the generated world
 *   npm run worldgen:round -- --force      skip the stage check and the human checkpoint (recorded)
 *
 * Exit code: 0 = ran and all checks passed, 1 = ran but checks failed, 2 = did not run or the server failed.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRun, type RunData } from "./data.js";
import {
  DATAPACK_DIR, FEEDBACK_FILE, PACK_FORMAT, PACK_NAME, RUNS_DIR, VANILLA_DIR,
  appendRound, feedbackHash, hashManifest, listFiles, loadTargets, manifestOf, parseArgs, readRounds, runDirName,
  type RoundRecord, type Targets,
} from "./lib.js";
import { computeMetrics, evaluateChecks, type CheckResult, type Metrics } from "./metrics.js";
import { renderAll } from "./render.js";
import { buildFailureReport, buildReport, type DatapackChanges } from "./report.js";
import { JOB_FILE, assertServerReady, extractDatapackErrors, prepareWorld, startServer, writeJob } from "./server.js";
import { resolveBiomeTag } from "./tags.js";

const TIMEOUT_MS = Number(process.env.WG_TIMEOUT_MIN ?? 15) * 60_000;

/** Thrown when a round is refused before the server starts. */
export class Refused extends Error {}

// ---- checks before the server starts ----

export function validateDatapack(dir: string): string[] {
  const problems: string[] = [];
  const mcmeta = path.join(dir, "pack.mcmeta");
  if (!fs.existsSync(mcmeta)) return [`${mcmeta} 不存在`];
  for (const f of listFiles(dir)) {
    if (!f.endsWith(".json") && f !== "pack.mcmeta") continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { pack?: { pack_format?: number } };
      if (f === "pack.mcmeta" && j.pack?.pack_format !== PACK_FORMAT) {
        problems.push(`pack.mcmeta：pack_format 应该是 ${PACK_FORMAT}（1.20.4），现在是 ${j.pack?.pack_format}`);
      }
    } catch (e) {
      problems.push(`${f}：不是合法的 JSON（${(e as Error).message}）。注意 JSON 里不能有注释和多余的逗号。`);
    }
  }
  return problems;
}

export function diffDatapack(before: Record<string, string>, now: Record<string, string>): DatapackChanges {
  return {
    added: Object.keys(now).filter((f) => !(f in before)).sort(),
    changed: Object.keys(now).filter((f) => f in before && before[f] !== now[f]).sort(),
    removed: Object.keys(before).filter((f) => !(f in now)).sort(),
  };
}

/** Which of this round's data pack changes fall outside what the current stage may touch. */
export function stageViolations(targets: Targets, changes: DatapackChanges, beforeDir: string, nowDir: string): string[] {
  const stage = targets.stages[String(targets.current_stage)];
  if (!stage) return [];
  const out: string[] = [];
  const readJson = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  for (const f of [...changes.added, ...changes.changed, ...changes.removed]) {
    if (f === "pack.mcmeta") continue;
    if (!stage.allow.some((prefix) => f === prefix || f.startsWith(prefix))) {
      out.push(`${f}：第 ${targets.current_stage} 阶段（${stage.name}）不能改这个文件`);
      continue;
    }
    const keys = stage.only_keys[f];
    if (!keys) continue;
    const a = readJson(path.join(beforeDir, f)), b = readJson(path.join(nowDir, f));
    if (!a || !b) {
      out.push(`${f}：第 ${targets.current_stage} 阶段只能改它里面的 ${keys.join("、")}，不能新增或删除整个文件`);
      continue;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !keys.includes(k)) {
        out.push(`${f}：第 ${targets.current_stage} 阶段只能改它里面的 ${keys.join("、")}，但 ${k} 也变了`);
      }
    }
  }
  return out;
}

/** Rounds on the main seed since the person last edited feedback.md. */
export function roundsSinceFeedback(rounds: RoundRecord[], currentFeedback: string): number {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!;
    if (r.kind !== "round" || !r.ok) continue;
    if (r.feedback !== currentFeedback) break;
    n++;
  }
  return n;
}

// ---- the round ----

export interface RoundOptions {
  seed?: string;
  kind: "round" | "verify";
  force: boolean;
  keepWorld: boolean;
}

export interface RoundResult {
  record: RoundRecord;
  dir: string;
  metrics?: Metrics;
  checks?: CheckResult[];
}

function waitForExit(child: ReturnType<typeof startServer>, timeoutMs: number): Promise<"exit" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve("exit");
    });
  });
}

/**
 * Numbers, pictures and report.md for a run that has already been exported.
 * `earlier` are the rounds before this one; the last successful one with the same seed is the comparison.
 */
export function analyzeRun(a: {
  dir: string;
  data: RunData;
  round: number;
  kind: "round" | "verify";
  seed: string;
  targets: Targets;
  earlier: RoundRecord[];
  changes?: DatapackChanges;
  forced: string[];
  totalSeconds: () => number;
}): { metrics: Metrics; checks: CheckResult[] } {
  const { dir, data, targets, seed } = a;
  const metrics = computeMetrics(
    { size: data.size, x0: data.meta.x0, z0: data.meta.z0, seaLevel: data.meta.seaLevel, groundY: data.groundY, waterY: data.waterY, biome: data.biome, biomes: data.biomes },
    {
      groups: targets.groups, regions: targets.regions, corridors: targets.corridors, maxRelief: targets.flat_square.max_relief,
      oceanBiomes: resolveBiomeTag("minecraft:is_ocean", VANILLA_DIR, path.join(dir, "datapack")),
      riverBiomes: resolveBiomeTag("minecraft:is_river", VANILLA_DIR, path.join(dir, "datapack")),
    },
  );
  const checks = evaluateChecks(metrics, targets.checks, targets.current_stage);
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify({ ...metrics, checks }, null, 2));

  const beforeRec = [...a.earlier].reverse().find(
    (r) => r.ok && r.seed === seed && fs.existsSync(path.join(RUNS_DIR, r.dir, "metrics.json")) && fs.existsSync(path.join(RUNS_DIR, r.dir, "columns.bin")),
  );
  const beforeDir = beforeRec ? path.join(RUNS_DIR, beforeRec.dir) : null;
  const beforeData = beforeDir ? loadRun(beforeDir) : undefined;
  const before = beforeRec && beforeDir
    ? { round: beforeRec.round, metrics: JSON.parse(fs.readFileSync(path.join(beforeDir, "metrics.json"), "utf8")) as Metrics }
    : undefined;
  const { labels, diff } = renderAll(dir, data, targets, metrics, beforeData);
  fs.writeFileSync(
    path.join(dir, "report.md"),
    buildReport({ round: a.round, kind: a.kind, seed, targets, data, metrics, checks, before, labels, diff, changes: a.changes, forced: a.forced, totalSeconds: a.totalSeconds() }),
  );
  return { metrics, checks };
}

export async function runRound(opts: RoundOptions): Promise<RoundResult> {
  const started = Date.now();
  const targets = loadTargets();
  const seed = opts.seed ?? targets.seed;
  const rounds = readRounds();
  const forced: string[] = [];

  const problems = validateDatapack(DATAPACK_DIR);
  if (problems.length) throw new Refused(`数据包有问题，没有开服：\n${problems.map((p) => "  - " + p).join("\n")}`);

  const manifest = manifestOf(DATAPACK_DIR);
  const previous = [...rounds].reverse().find((r) => r.ok && fs.existsSync(path.join(RUNS_DIR, r.dir, "datapack")));
  const previousDir = previous ? path.join(RUNS_DIR, previous.dir, "datapack") : null;
  const changes = previousDir ? diffDatapack(manifestOf(previousDir), manifest) : undefined;
  if (changes && previousDir) {
    const bad = stageViolations(targets, changes, previousDir, DATAPACK_DIR);
    if (bad.length) {
      if (!opts.force) {
        throw new Refused(
          `这一轮改了当前阶段不允许改的东西，没有开服：\n${bad.map((p) => "  - " + p).join("\n")}\n` +
            "把这些改动撤回去；如果确实该进入下一阶段，请人来改 targets.yaml 的 current_stage。",
        );
      }
      forced.push("阶段检查");
    }
  }

  const fb = feedbackHash();
  if (opts.kind === "round") {
    const since = roundsSinceFeedback(rounds, fb);
    if (since >= targets.human_check_every) {
      if (!opts.force) {
        const last = [...rounds].reverse().find((r) => r.kind === "round" && r.ok);
        throw new Refused(
          `已经连续跑了 ${since} 轮没有人工反馈，该请人进游戏看看了。\n` +
            `  1. npm run worldgen:play${last ? ` -- --run ${last.round}` : ""}   把最近一轮的世界开起来\n` +
            `  2. 进游戏走一圈（值得看的坐标在那一轮的 report.md 里）\n` +
            `  3. 把看到的问题写进 ${FEEDBACK_FILE}，然后再跑下一轮`,
        );
      }
      forced.push("人工把关");
    }
  }

  assertServerReady();
  const round = (rounds.length ? Math.max(...rounds.map((r) => r.round)) : 0) + 1;
  const dirName = runDirName(round, seed);
  const dir = path.join(RUNS_DIR, dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(DATAPACK_DIR, path.join(dir, "datapack"), { recursive: true });

  const base: RoundRecord = {
    round, kind: opts.kind, dir: dirName, seed, time: new Date().toISOString(), stage: targets.current_stage,
    datapack: hashManifest(manifest), feedback: fb, ok: false, ...(forced.length ? { forced } : {}),
  };
  const failRound = (reason: string, lines: string[]): RoundResult => {
    fs.writeFileSync(path.join(dir, "report.md"), buildFailureReport(round, seed, reason, lines));
    const record = { ...base, error: reason };
    appendRound(record);
    return { record, dir };
  };

  console.log(`第 ${round} 轮，种子 ${seed}：准备世界并开服……`);
  prepareWorld(DATAPACK_DIR, seed, { whitelist: true });
  writeJob({
    size: targets.area.size, cx: targets.area.center[0], cz: targets.area.center[1],
    outDir: path.resolve(dir), sections: targets.sections, export: true, stopWhenDone: true,
  });
  const logFile = path.join(dir, "server.log");
  const child = startServer({ logFile });
  let lastProgress = "";
  child.stdout!.on("data", (b: Buffer) => {
    const m = /\[WgExport\] (chunks|Chunky): (\d+\/\d+)/.exec(b.toString());
    if (m && m[2] !== lastProgress) {
      lastProgress = m[2]!;
      process.stdout.write(`\r  生成区块 ${lastProgress}   `);
    }
  });
  const how = await waitForExit(child, TIMEOUT_MS);
  if (lastProgress) process.stdout.write("\n");
  fs.rmSync(JOB_FILE, { force: true });

  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  if (how === "timeout") return failRound(`超过 ${TIMEOUT_MS / 60_000} 分钟没跑完，已强制结束。`, log.split(/\r?\n/).slice(-30));
  const dpErrors = extractDatapackErrors(log);
  if (dpErrors.length) return failRound("数据包有错，服务端拒绝加载。", dpErrors);
  const errFile = path.join(dir, "error.json");
  if (fs.existsSync(errFile)) return failRound("导出插件报错。", [fs.readFileSync(errFile, "utf8")]);
  if (!fs.existsSync(path.join(dir, "done.json"))) {
    return failRound("服务端退出了，但没有导出结果。", log.split(/\r?\n/).filter((l) => /ERROR|Exception|WARN/.test(l)).slice(-30));
  }

  const data = loadRun(dir);
  if (!data.meta.datapacks.includes(`file/${PACK_NAME}`)) {
    return failRound("服务端没有启用这个数据包，结果不能算数。", [`启用的数据包：${data.meta.datapacks.join(", ")}`]);
  }

  console.log("  算指标、画图……");
  const { metrics, checks } = analyzeRun({
    dir, data, round, kind: opts.kind, seed, targets, earlier: rounds, changes, forced,
    totalSeconds: () => Math.round((Date.now() - started) / 1000),
  });
  if (opts.keepWorld) fs.cpSync(path.join("worldgen-server", "world"), path.join(dir, "world"), { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, "latest.txt"), dirName + "\n");

  const failedChecks = checks.filter((c) => c.status === "fail" || c.status === "missing").map((c) => c.name);
  const record: RoundRecord = {
    ...base, ok: true, passed: failedChecks.length === 0, failedChecks,
    metrics: {
      ocean_share: metrics.ocean_share, water_share: metrics.water_share, flat_share: metrics.flat_share,
      cliff_share: metrics.cliff_share, height_p50: metrics.land_height.p50, height_p95: metrics.land_height.p95,
      flat_square: metrics.largest_flat_square.size,
    },
  };
  appendRound(record);
  return { record, dir, metrics, checks };
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  try {
    const r = await runRound({ seed: values.seed, kind: "round", force: flags.has("force"), keepWorld: flags.has("keep-world") });
    console.log(`\n报告：${path.join(r.dir, "report.md")}`);
    if (!r.record.ok) {
      console.log(`这一轮失败了：${r.record.error}`);
      process.exit(2);
    }
    if (r.record.passed) console.log("当前阶段的检查全部通过。");
    else console.log(`没达标的检查：${r.record.failedChecks!.join("、")}`);
    process.exit(r.record.passed ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Refused ? e.message : e);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
