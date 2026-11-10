/**
 * Turns exported columns into numbers, and checks them against targets.yaml.
 * Everything here is a pure function of its arguments so it can be unit tested with small grids.
 *
 * Words used below:
 *   land    = a column with no water on top of it
 *   surface = the ground height, or the water level when there is water
 *   slope   = the largest surface height difference between a column and its 4 neighbours
 */
import { NO_WATER } from "./data.js";

export interface Grid {
  size: number;
  x0: number;
  z0: number;
  seaLevel: number;
  groundY: Int16Array;
  waterY: Int16Array;
  biome: Uint16Array;
  biomes: string[];
}

export interface MetricsOptions {
  groups: Record<string, string[]>;
  regions: Record<string, { x: [number, number]; z: [number, number] }>;
  corridors: Record<string, { points: [number, number][]; width: number }>;
  oceanBiomes: Set<string>;
  riverBiomes: Set<string>;
  /** Largest height difference allowed inside the "largest flat square". */
  maxRelief: number;
}

export interface HeightStats {
  min: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
  mean: number;
}

export interface AreaStats {
  columns: number;
  land_share: number;
  water_share: number;
  ocean_share: number;
  river_share: number;
  /** Shares of land columns by slope: <=1, 2-3, >=4. */
  flat_share: number;
  steep_share: number;
  cliff_share: number;
  land_height: HeightStats;
  /** Highest land minus lowest land. */
  relief: number;
  biome_share: Record<string, number>;
  group_share: Record<string, number>;
  top_biome: string;
}

export interface CorridorStats {
  length: number;
  max_step: number;
  total_climb: number;
  total_descent: number;
  relief: number;
  water_share: number;
  longest_steep_run: number;
  max_cross_relief: number;
}

export interface Metrics extends AreaStats {
  land_height_histogram: Record<string, number>;
  largest_flat_square: { size: number; x: number; z: number; y: number };
  largest_landmass_share: number;
  regions: Record<string, AreaStats>;
  corridors: Record<string, CorridorStats>;
  points: {
    highest: { x: number; y: number; z: number };
    steepest: { x: number; y: number; z: number; slope: number };
  };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function surfaceHeights(g: Grid): Int16Array {
  const out = new Int16Array(g.groundY.length);
  for (let i = 0; i < out.length; i++) out[i] = g.waterY[i] === NO_WATER ? g.groundY[i]! : g.waterY[i]!;
  return out;
}

export function slopes(size: number, surf: Int16Array): Uint8Array {
  const out = new Uint8Array(surf.length);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x;
      const h = surf[i]!;
      let m = 0;
      if (x > 0) m = Math.max(m, Math.abs(h - surf[i - 1]!));
      if (x < size - 1) m = Math.max(m, Math.abs(h - surf[i + 1]!));
      if (z > 0) m = Math.max(m, Math.abs(h - surf[i - size]!));
      if (z < size - 1) m = Math.max(m, Math.abs(h - surf[i + size]!));
      out[i] = Math.min(255, m);
    }
  }
  return out;
}

interface Rect {
  xa: number;
  xb: number;
  za: number;
  zb: number;
}

/** Stats for the columns xa..xb, za..zb (grid indexes, inclusive). */
export function areaStats(g: Grid, slope: Uint8Array, r: Rect, opts: MetricsOptions): AreaStats {
  const OFFSET = 512; // heights are between -512 and 511 for counting
  const hist = new Int32Array(1024);
  const biomeCount = new Int32Array(g.biomes.length);
  let columns = 0, land = 0, flat = 0, steep = 0, cliff = 0, sum = 0;
  let min = Infinity, max = -Infinity;
  for (let z = r.za; z <= r.zb; z++) {
    for (let x = r.xa; x <= r.xb; x++) {
      const i = z * g.size + x;
      columns++;
      biomeCount[g.biome[i]!]!++;
      if (g.waterY[i] !== NO_WATER) continue;
      land++;
      const h = g.groundY[i]!;
      hist[h + OFFSET]!++;
      sum += h;
      if (h < min) min = h;
      if (h > max) max = h;
      const s = slope[i]!;
      if (s <= 1) flat++;
      else if (s <= 3) steep++;
      else cliff++;
    }
  }
  const pct = (p: number): number => {
    if (land === 0) return 0;
    const want = Math.max(1, Math.ceil(p * land));
    let acc = 0;
    for (let h = 0; h < hist.length; h++) {
      acc += hist[h]!;
      if (acc >= want) return h - OFFSET;
    }
    return max;
  };
  const biome_share: Record<string, number> = {};
  let ocean = 0, river = 0, top = "", topCount = -1;
  const order = [...biomeCount.keys()].filter((b) => biomeCount[b]! > 0).sort((a, b) => biomeCount[b]! - biomeCount[a]!);
  for (const b of order) {
    const name = g.biomes[b]!;
    const c = biomeCount[b]!;
    biome_share[name] = round4(c / columns);
    if (opts.oceanBiomes.has(name)) ocean += c;
    if (opts.riverBiomes.has(name)) river += c;
    if (c > topCount) {
      topCount = c;
      top = name;
    }
  }
  const group_share: Record<string, number> = {};
  for (const [name, members] of Object.entries(opts.groups)) {
    const set = new Set(members);
    let c = 0;
    for (const b of order) if (set.has(g.biomes[b]!)) c += biomeCount[b]!;
    group_share[name] = round4(c / columns);
  }
  const share = (v: number) => (land === 0 ? 0 : round4(v / land));
  return {
    columns,
    land_share: round4(land / columns),
    water_share: round4((columns - land) / columns),
    ocean_share: round4(ocean / columns),
    river_share: round4(river / columns),
    flat_share: share(flat),
    steep_share: share(steep),
    cliff_share: share(cliff),
    land_height: {
      min: land ? min : 0,
      p5: pct(0.05),
      p25: pct(0.25),
      p50: pct(0.5),
      p75: pct(0.75),
      p95: pct(0.95),
      max: land ? max : 0,
      mean: land ? Math.round((sum / land) * 10) / 10 : 0,
    },
    relief: land ? max - min : 0,
    biome_share,
    group_share,
    top_biome: top,
  };
}

/** Sliding minimum (or maximum) over every k x k window. Result is (n-k+1) x (n-k+1). */
function windowExtreme(src: Int16Array, n: number, k: number, wantMax: boolean): Int16Array {
  const m = n - k + 1;
  const rows = new Int16Array(n * m);
  const dq = new Int32Array(n);
  const better = (a: number, b: number) => (wantMax ? a >= b : a <= b);
  for (let z = 0; z < n; z++) {
    let head = 0, tail = 0;
    for (let x = 0; x < n; x++) {
      const v = src[z * n + x]!;
      while (tail > head && better(v, src[z * n + dq[tail - 1]!]!)) tail--;
      dq[tail++] = x;
      if (dq[head]! <= x - k) head++;
      if (x >= k - 1) rows[z * m + (x - k + 1)] = src[z * n + dq[head]!]!;
    }
  }
  const out = new Int16Array(m * m);
  for (let x = 0; x < m; x++) {
    let head = 0, tail = 0;
    for (let z = 0; z < n; z++) {
      const v = rows[z * m + x]!;
      while (tail > head && better(v, rows[dq[tail - 1]! * m + x]!)) tail--;
      dq[tail++] = z;
      if (dq[head]! <= z - k) head++;
      if (z >= k - 1) out[(z - k + 1) * m + x] = rows[dq[head]! * m + x]!;
    }
  }
  return out;
}

/**
 * The biggest square where every column is land, at or above sea level, has slope <= 1,
 * and the whole square's height difference is at most maxRelief. Returns its side and centre.
 */
export function largestFlatSquare(g: Grid, slope: Uint8Array, maxRelief: number): { size: number; x: number; z: number; y: number } {
  const n = g.size;
  // dp[i] = side of the biggest all-buildable square whose bottom-right corner is column i
  const dp = new Uint16Array(n * n);
  let best = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const ok = g.waterY[i] === NO_WATER && g.groundY[i]! >= g.seaLevel && slope[i]! <= 1;
      if (!ok) continue;
      const v = x === 0 || z === 0 ? 1 : 1 + Math.min(dp[i - 1]!, dp[i - n]!, dp[i - n - 1]!);
      dp[i] = v;
      if (v > best) best = v;
    }
  }
  if (best === 0) return { size: 0, x: 0, z: 0, y: 0 };
  const find = (k: number): { x: number; z: number } | null => {
    const m = n - k + 1;
    const lo = windowExtreme(g.groundY, n, k, false);
    const hi = windowExtreme(g.groundY, n, k, true);
    for (let z = 0; z < m; z++) {
      for (let x = 0; x < m; x++) {
        if (dp[(z + k - 1) * n + (x + k - 1)]! < k) continue;
        if (hi[z * m + x]! - lo[z * m + x]! <= maxRelief) return { x, z };
      }
    }
    return null;
  };
  // If a k-square works then so does every smaller one inside it, so binary search on k.
  let lo = 1, hi = best;
  let at = find(1)!;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const f = find(mid);
    if (f) {
      lo = mid;
      at = f;
    } else hi = mid - 1;
  }
  const cx = at.x + (lo >> 1), cz = at.z + (lo >> 1);
  return { size: lo, x: g.x0 + cx, z: g.z0 + cz, y: g.groundY[cz * n + cx]! };
}

/** Share of all land that belongs to the biggest connected piece of land (4-neighbour). */
export function largestLandmassShare(g: Grid): number {
  const n = g.size;
  const seen = new Uint8Array(n * n);
  const stack = new Int32Array(n * n);
  let land = 0, best = 0;
  for (let start = 0; start < n * n; start++) {
    if (g.waterY[start] !== NO_WATER) continue;
    land++;
    if (seen[start]) continue;
    let top = 0, count = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top]!;
      count++;
      const x = i % n;
      const push = (j: number) => {
        if (!seen[j] && g.waterY[j] === NO_WATER) {
          seen[j] = 1;
          stack[top++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < n - 1) push(i + 1);
      if (i >= n) push(i - n);
      if (i < n * (n - 1)) push(i + n);
    }
    if (count > best) best = count;
  }
  return land === 0 ? 0 : round4(best / land);
}

/** Walks a road (a polyline with a width) and measures how bumpy it is. */
export function corridorStats(
  g: Grid,
  surf: Int16Array,
  name: string,
  c: { points: [number, number][]; width: number },
): CorridorStats {
  const n = g.size;
  const half = Math.floor(c.width / 2);
  const heights: number[] = [];
  let cells = 0, wet = 0, maxCross = 0;
  let last: string | null = null;
  for (let s = 0; s + 1 < c.points.length; s++) {
    const [ax, az] = c.points[s]!;
    const [bx, bz] = c.points[s + 1]!;
    const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az), 1);
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const px = -(bz - az) / len, pz = (bx - ax) / len; // unit vector across the road
    for (let t = 0; t <= steps; t++) {
      const cx = ax + ((bx - ax) * t) / steps, cz = az + ((bz - az) * t) / steps;
      const key = `${Math.round(cx)},${Math.round(cz)}`;
      if (key === last) continue;
      last = key;
      const hs: number[] = [];
      for (let o = -half; o <= half; o++) {
        const gx = Math.round(cx + px * o) - g.x0, gz = Math.round(cz + pz * o) - g.z0;
        if (gx < 0 || gz < 0 || gx >= n || gz >= n) {
          throw new Error(`道路「${name}」有一部分在测试区域外面（${Math.round(cx + px * o)}, ${Math.round(cz + pz * o)}）`);
        }
        const i = gz * n + gx;
        hs.push(surf[i]!);
        cells++;
        if (g.waterY[i] !== NO_WATER) wet++;
      }
      hs.sort((a, b) => a - b);
      heights.push(hs[hs.length >> 1]!);
      maxCross = Math.max(maxCross, hs[hs.length - 1]! - hs[0]!);
    }
  }
  let maxStep = 0, climb = 0, descent = 0, run = 0, longest = 0;
  for (let i = 1; i < heights.length; i++) {
    const d = heights[i]! - heights[i - 1]!;
    maxStep = Math.max(maxStep, Math.abs(d));
    if (d > 0) climb += d;
    else descent -= d;
    run = Math.abs(d) >= 2 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    length: heights.length,
    max_step: maxStep,
    total_climb: climb,
    total_descent: descent,
    relief: Math.max(...heights) - Math.min(...heights),
    water_share: round4(wet / cells),
    longest_steep_run: longest,
    max_cross_relief: maxCross,
  };
}

export function computeMetrics(g: Grid, opts: MetricsOptions): Metrics {
  const n = g.size;
  const surf = surfaceHeights(g);
  const slope = slopes(n, surf);
  const all = areaStats(g, slope, { xa: 0, xb: n - 1, za: 0, zb: n - 1 }, opts);

  const land_height_histogram: Record<string, number> = {};
  const bins = new Map<number, number>();
  let land = 0, hi = 0, st = 0;
  for (let i = 0; i < n * n; i++) {
    if (g.waterY[i] !== NO_WATER) continue;
    land++;
    const b = Math.floor(g.groundY[i]! / 16) * 16;
    bins.set(b, (bins.get(b) ?? 0) + 1);
    if (g.groundY[i]! > g.groundY[hi]! || g.waterY[hi] !== NO_WATER) hi = i;
    if (slope[i]! > slope[st]! || g.waterY[st] !== NO_WATER) st = i;
  }
  for (const b of [...bins.keys()].sort((a, c) => a - c)) land_height_histogram[String(b)] = round4(bins.get(b)! / land);

  const regions: Record<string, AreaStats> = {};
  for (const [name, r] of Object.entries(opts.regions)) {
    const xa = Math.min(r.x[0], r.x[1]) - g.x0, xb = Math.max(r.x[0], r.x[1]) - g.x0;
    const za = Math.min(r.z[0], r.z[1]) - g.z0, zb = Math.max(r.z[0], r.z[1]) - g.z0;
    if (xa < 0 || za < 0 || xb > n || zb > n) throw new Error(`区域「${name}」超出了测试区域`);
    // the upper bound of a range is exclusive, like the area itself
    regions[name] = areaStats(g, slope, { xa, xb: Math.min(xb, n) - 1, za, zb: Math.min(zb, n) - 1 }, opts);
  }
  const corridors: Record<string, CorridorStats> = {};
  for (const [name, c] of Object.entries(opts.corridors)) corridors[name] = corridorStats(g, surf, name, c);

  const at = (i: number) => ({ x: g.x0 + (i % n), y: g.groundY[i]!, z: g.z0 + Math.floor(i / n) });
  return {
    ...all,
    land_height_histogram,
    largest_flat_square: largestFlatSquare(g, slope, opts.maxRelief),
    largest_landmass_share: largestLandmassShare(g),
    regions,
    corridors,
    points: { highest: at(hi), steepest: { ...at(st), slope: slope[st]! } },
  };
}

// ---- checks ----

export interface CheckSpec {
  name: string;
  metric: string;
  min?: number;
  max?: number;
  stage: number;
}

export interface CheckResult extends CheckSpec {
  value: number | null;
  /** pass / fail / later (its stage has not started) / missing (no such metric) */
  status: "pass" | "fail" | "later" | "missing";
}

/** Looks up "regions.north.group_share.雪山" style paths. A biome share that is absent counts as 0. */
export function metricValue(metrics: unknown, pathStr: string): number | null {
  const parts = pathStr.split(".");
  let cur: unknown = metrics;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== "object") return null;
    const obj = cur as Record<string, unknown>;
    // keys may themselves contain dots; try the longest match first
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join(".");
      if (key in obj) {
        cur = obj[key];
        i = j - 1;
        found = true;
        break;
      }
    }
    if (!found) {
      const parent = parts[i - 1];
      return parent === "biome_share" || parent === "group_share" ? 0 : null;
    }
  }
  return typeof cur === "number" ? cur : null;
}

export function evaluateChecks(metrics: unknown, checks: CheckSpec[], currentStage: number): CheckResult[] {
  return checks.map((c) => {
    const value = metricValue(metrics, c.metric);
    let status: CheckResult["status"];
    if (value === null) status = "missing";
    else if (c.stage > currentStage) status = "later";
    else status = (c.min === undefined || value >= c.min) && (c.max === undefined || value <= c.max) ? "pass" : "fail";
    return { ...c, value, status };
  });
}
