/** Builds report.md for one run: pass/fail, the checks table, changes since the last run, places to visit. */
import { NO_WATER, type RunData } from "./data.js";
import type { CheckResult, Metrics } from "./metrics.js";
import { metricValue } from "./metrics.js";
import type { OverviewLabels } from "./render.js";
import { biomeColorHex } from "./render.js";
import type { Targets } from "./lib.js";

export interface Place {
  name: string;
  x: number;
  y: number;
  z: number;
}

/** Spots a person should look at in game, with a height that puts them standing on the surface. */
export function placesToVisit(d: RunData, metrics: Metrics, targets: Targets): Place[] {
  const n = d.size;
  const standAt = (x: number, z: number): Place["y"] => {
    const gx = Math.max(0, Math.min(n - 1, Math.round(x) - d.meta.x0));
    const gz = Math.max(0, Math.min(n - 1, Math.round(z) - d.meta.z0));
    const i = gz * n + gx;
    return (d.waterY[i] !== NO_WATER ? d.waterY[i]! : d.groundY[i]!) + 2;
  };
  const out: Place[] = [];
  const add = (name: string, x: number, z: number) => out.push({ name, x: Math.round(x), y: standAt(x, z), z: Math.round(z) });
  const f = metrics.largest_flat_square;
  if (f.size > 0) add(`最大可建平地中心（${f.size}×${f.size}）`, f.x, f.z);
  add(`最高点（y=${metrics.points.highest.y}）`, metrics.points.highest.x, metrics.points.highest.z);
  add(`最陡的地方（相邻高差 ${metrics.points.steepest.slope}）`, metrics.points.steepest.x, metrics.points.steepest.z);
  for (const [name, r] of Object.entries(targets.regions)) add(`区域「${name}」中心`, (r.x[0] + r.x[1]) / 2, (r.z[0] + r.z[1]) / 2);
  for (const [name, c] of Object.entries(targets.corridors)) {
    const first = c.points[0]!, last = c.points[c.points.length - 1]!;
    add(`道路「${name}」起点`, first[0], first[1]);
    add(`道路「${name}」终点`, last[0], last[1]);
  }
  const cx = d.meta.x0 + n / 2, cz = d.meta.z0 + n / 2;
  for (const s of d.meta.sections) add(`剖面 ${s.name} 中点`, s.axis === "x" ? cx : s.at, s.axis === "x" ? s.at : cz);
  return out;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const SHARE = /share$/;
export const fmt = (metric: string, v: number | null): string => {
  if (v === null) return "—";
  const last = metric.split(".");
  const isShare = SHARE.test(last[last.length - 1]!) || last.includes("biome_share") || last.includes("group_share");
  return isShare ? pct(v) : String(v);
};
const delta = (metric: string, now: number | null, before: number | null): string => {
  if (now === null || before === null) return "";
  const d = now - before;
  const last = metric.split(".");
  const isShare = SHARE.test(last[last.length - 1]!) || last.includes("biome_share") || last.includes("group_share");
  // shares are shown to 0.1 of a percentage point; anything smaller is run-to-run noise
  if (Math.abs(d) < (isShare ? 0.0005 : 1e-9)) return "不变";
  return (d > 0 ? "+" : "−") + (isShare ? `${(Math.abs(d) * 100).toFixed(1)} 个百分点` : String(Math.round(Math.abs(d) * 100) / 100));
};
export const target = (c: { min?: number; max?: number; metric: string }): string => {
  const f = (v: number) => fmt(c.metric, v);
  if (c.min !== undefined && c.max !== undefined) return `${f(c.min)} – ${f(c.max)}`;
  if (c.min !== undefined) return `≥ ${f(c.min)}`;
  if (c.max !== undefined) return `≤ ${f(c.max)}`;
  return "";
};
const STATUS: Record<CheckResult["status"], string> = { pass: "通过", fail: "**不通过**", later: "还没到这个阶段", missing: "**找不到这个指标**" };

const KEY_METRICS: [string, string][] = [
  ["ocean_share", "海洋群系占比"],
  ["water_share", "水面占比（海、河、湖）"],
  ["river_share", "河流群系占比"],
  ["flat_share", "陆地里平缓的比例（相邻高差 ≤ 1）"],
  ["steep_share", "陆地里陡坡的比例（相邻高差 2–3）"],
  ["cliff_share", "陆地里悬崖的比例（相邻高差 ≥ 4）"],
  ["land_height.p5", "陆地高度：低的 5%"],
  ["land_height.p50", "陆地高度：中位数"],
  ["land_height.p95", "陆地高度：高的 5%"],
  ["land_height.max", "陆地高度：最高"],
  ["largest_flat_square.size", "最大可建平地的边长"],
  ["largest_landmass_share", "最大一块陆地占全部陆地"],
];

export interface DatapackChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface ReportInput {
  round: number;
  kind: "round" | "verify";
  seed: string;
  targets: Targets;
  data: RunData;
  metrics: Metrics;
  checks: CheckResult[];
  before?: { round: number; metrics: Metrics };
  labels: OverviewLabels;
  diff?: { changedShare: number; meanAbs: number };
  changes?: DatapackChanges;
  forced: string[];
  totalSeconds: number;
}

export function buildReport(r: ReportInput): string {
  const { targets: t, metrics: m, data: d } = r;
  const stage = t.stages[String(t.current_stage)];
  const failed = r.checks.filter((c) => c.status === "fail" || c.status === "missing");
  const L: string[] = [];
  L.push(`# 第 ${r.round} 轮${r.kind === "verify" ? "（换种子验证）" : ""} · 种子 ${r.seed}`);
  L.push("");
  L.push(failed.length === 0 ? "**结论：当前阶段的检查全部通过。**" : `**结论：不通过，${failed.length} 项没达标：${failed.map((c) => c.name).join("、")}。**`);
  L.push("");
  L.push(`- 当前阶段：${t.current_stage}${stage ? `（${stage.name}）` : ""}`);
  L.push(`- 区域：${d.size}×${d.size}，x ${d.meta.x0} 到 ${d.meta.x0 + d.size - 1}，z ${d.meta.z0} 到 ${d.meta.z0 + d.size - 1}；海平面 y=${d.meta.seaLevel}`);
  L.push(`- 用时：共 ${r.totalSeconds} 秒，其中生成 ${Math.round(d.meta.generateMs / 1000)} 秒（${d.meta.chunky ? "Chunky" : "Paper 自带的异步加载，没装 Chunky"}）`);
  if (r.forced.length) L.push(`- **这一轮用 --force 跳过了：${r.forced.join("、")}**`);
  L.push("");

  L.push("## 验收");
  L.push("");
  L.push(`| 检查 | 指标 | 目标 | 本轮 | ${r.before ? `第 ${r.before.round} 轮 | 变化 | ` : ""}结果 |`);
  L.push(`|---|---|---|---|${r.before ? "---|---|" : ""}---|`);
  for (const c of r.checks) {
    const prev = r.before ? metricValue(r.before.metrics, c.metric) : null;
    const mid = r.before ? `${fmt(c.metric, prev)} | ${delta(c.metric, c.value, prev)} | ` : "";
    L.push(`| ${c.name} | \`${c.metric}\` | ${target(c)} | ${fmt(c.metric, c.value)} | ${mid}${STATUS[c.status]} |`);
  }
  if (r.checks.length === 0) L.push("| （targets.yaml 里还没有写检查） | | | | |");
  L.push("");

  L.push("## 关键数字");
  L.push("");
  L.push(`| 数字 | 本轮 | ${r.before ? `第 ${r.before.round} 轮 | 变化 |` : ""}`);
  L.push(`|---|---|${r.before ? "---|---|" : ""}`);
  for (const [key, label] of KEY_METRICS) {
    const now = metricValue(m, key);
    const prev = r.before ? metricValue(r.before.metrics, key) : null;
    L.push(`| ${label} | ${fmt(key, now)} | ${r.before ? `${fmt(key, prev)} | ${delta(key, now, prev)} |` : ""}`);
  }
  L.push("");
  if (r.diff) {
    L.push(`和第 ${r.before!.round} 轮比：${pct(r.diff.changedShare)} 的位置地表高度变了，平均变化 ${r.diff.meanAbs.toFixed(2)} 格（见 diff-height.png：红色变高，蓝色变低）。`);
    L.push("");
  }

  L.push("## 陆地高度分布");
  L.push("");
  L.push("```");
  for (const [bin, share] of Object.entries(m.land_height_histogram)) {
    const lo = Number(bin);
    L.push(`y ${String(lo).padStart(4)} – ${String(lo + 15).padEnd(4)} ${"█".repeat(Math.round(share * 100))} ${pct(share)}`);
  }
  L.push("```");
  L.push("");

  L.push("## 群系占比");
  L.push("");
  L.push(`| 群系 | 占比 | ${r.before ? "变化 | " : ""}biome.png 里的颜色 |`);
  L.push(`|---|---|${r.before ? "---|" : ""}---|`);
  const biomes = Object.entries(m.biome_share);
  for (const [name, share] of biomes.slice(0, 20)) {
    const d2 = r.before ? `${delta("biome_share.x", share, r.before.metrics.biome_share[name] ?? 0)} | ` : "";
    L.push(`| ${name} | ${pct(share)} | ${d2}${biomeColorHex(name)} |`);
  }
  if (biomes.length > 20) L.push(`| 其余 ${biomes.length - 20} 个 | ${pct(biomes.slice(20).reduce((a, [, s]) => a + s, 0))} | ${r.before ? "| " : ""}|`);
  L.push("");
  if (Object.keys(m.group_share).length) {
    L.push(Object.entries(m.group_share).map(([g, s]) => `群系组「${g}」：${pct(s)}`).join("；") + "。");
    L.push("");
  }

  if (Object.keys(m.regions).length) {
    L.push("## 区域");
    L.push("");
    L.push("| 图上标记 | 区域 | 平缓 | 悬崖 | 水面 | 陆地高度（低 5% / 中位 / 高 5%） | 高差 | 最多的群系 |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const { label, name } of r.labels.regions) {
      const s = m.regions[name]!;
      L.push(`| ${label} | ${name} | ${pct(s.flat_share)} | ${pct(s.cliff_share)} | ${pct(s.water_share)} | ${s.land_height.p5} / ${s.land_height.p50} / ${s.land_height.p95} | ${s.relief} | ${s.top_biome} |`);
    }
    L.push("");
  }
  if (Object.keys(m.corridors).length) {
    L.push("## 道路");
    L.push("");
    L.push("| 图上标记 | 道路 | 长度 | 最大单格高差 | 总爬升 | 总下降 | 最长连续陡坡 | 路面横向最大高差 | 水面占比 |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const { label, name } of r.labels.corridors) {
      const s = m.corridors[name]!;
      L.push(`| ${label} | ${name} | ${s.length} | ${s.max_step} | ${s.total_climb} | ${s.total_descent} | ${s.longest_steep_run} | ${s.max_cross_relief} | ${pct(s.water_share)} |`);
    }
    L.push("");
  }

  L.push("## 值得进游戏看的地方");
  L.push("");
  for (const p of placesToVisit(d, m, t)) L.push(`- ${p.name}：\`/tp @s ${p.x} ${p.y} ${p.z}\``);
  L.push("");

  L.push("## 图");
  L.push("");
  L.push("- `overview.png`：四张图缩小后拼在一起，带坐标。白色虚线 = 剖面线，洋红方框 = 最大可建平地，黄色框 = 区域，青色线 = 道路。");
  L.push("- `height.png` 高度（越高越偏棕、白；每 16 格一条等高线；蓝色是水，越深越暗）");
  L.push("- `biome.png` 群系（颜色见上表）　`surface.png` 俯视地表（接近游戏里的地图）");
  L.push("- `slope.png` 坡度：绿 = 平缓，黄 = 陡坡，红 = 悬崖，灰蓝 = 水");
  for (const s of d.meta.sections) {
    L.push(`- \`section-${s.name}.png\`：${s.axis === "x" ? `z=${s.at}，沿 x 方向` : `x=${s.at}，沿 z 方向`}的剖面，纵向放大 2 倍，洋红虚线是海平面`);
  }
  if (r.diff) L.push("- `diff-height.png`：和上一轮的高度差");
  L.push("");

  if (r.changes) {
    const { added, changed, removed } = r.changes;
    L.push(`## 数据包和第 ${r.before?.round ?? "上"} 轮的差别`);
    L.push("");
    if (added.length + changed.length + removed.length === 0) L.push("没有差别。");
    for (const f of added) L.push(`- 新增 \`${f}\``);
    for (const f of changed) L.push(`- 修改 \`${f}\``);
    for (const f of removed) L.push(`- 删除 \`${f}\``);
    L.push("");
  }
  return L.join("\n");
}

export function buildFailureReport(round: number, seed: string, reason: string, lines: string[]): string {
  return [
    `# 第 ${round} 轮 · 种子 ${seed}`,
    "",
    `**结论：这一轮失败了，没有生成地形。${reason}**`,
    "",
    "## 服务端的报错",
    "",
    "```",
    ...(lines.length ? lines : ["（日志里没有找到明确的报错，完整日志见 server.log）"]),
    "```",
    "",
    "完整日志在同一个文件夹的 `server.log`。",
    "",
  ].join("\n");
}
