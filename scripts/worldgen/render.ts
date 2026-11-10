/** Draws the exported data: top-down maps, cross sections, an annotated overview, and a height diff. */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { NO_WATER, type RunData, type SectionData } from "./data.js";
import { slopes, surfaceHeights, type Metrics } from "./metrics.js";
import type { Targets } from "./lib.js";

type RGB = [number, number, number];

export class Img {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill: RGB = [255, 255, 255]) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.set(i % w, Math.floor(i / w), fill);
  }
  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = 255;
  }
  get(x: number, y: number): RGB {
    const o = (y * this.w + x) * 4;
    return [this.data[o]!, this.data[o + 1]!, this.data[o + 2]!];
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, dash = 0): void {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let t = 0; t <= steps; t++) {
      if (dash && Math.floor(t / dash) % 2 === 1) continue;
      this.set(Math.round(x0 + ((x1 - x0) * t) / steps), Math.round(y0 + ((y1 - y0) * t) / steps), c);
    }
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    this.line(x0, y0, x1, y0, c);
    this.line(x1, y0, x1, y1, c);
    this.line(x1, y1, x0, y1, c);
    this.line(x0, y1, x0, y0, c);
  }
  fill(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  /** Copies src in, shrinking it by an integer factor (averaging). */
  blit(src: Img, dx: number, dy: number, shrink = 1): void {
    const w = Math.floor(src.w / shrink), h = Math.floor(src.h / shrink);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let yy = 0; yy < shrink; yy++) {
          for (let xx = 0; xx < shrink; xx++) {
            const o = ((y * shrink + yy) * src.w + x * shrink + xx) * 4;
            r += src.data[o]!; g += src.data[o + 1]!; b += src.data[o + 2]!;
          }
        }
        const k = shrink * shrink;
        this.set(dx + x, dy + y, [Math.round(r / k), Math.round(g / k), Math.round(b / k)]);
      }
    }
  }
  /** Tiny built-in 3x5 font: digits, capitals and a few signs. Other characters are skipped. */
  text(x: number, y: number, s: string, c: RGB, scale = 2, bg?: RGB): void {
    const str = s.toUpperCase();
    if (bg) this.fill(x - 1, y - 1, str.length * 4 * scale + 1, 5 * scale + 2, bg);
    for (let i = 0; i < str.length; i++) {
      const glyph = FONT[str[i]!];
      if (!glyph) continue;
      for (let r = 0; r < 5; r++)
        for (let col = 0; col < 3; col++)
          if (glyph[r]![col] === "1") this.fill(x + (i * 4 + col) * scale, y + r * scale, scale, scale, c);
    }
  }
  save(file: string): void {
    const png = new PNG({ width: this.w, height: this.h });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2, inputHasAlpha: true }));
  }
}

const FONT: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
    "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
    "8": "111101111101111", "9": "111101111001111",
    A: "111101111101101", B: "110101110101110", C: "111100100100111", D: "110101101101110",
    E: "111100111100111", F: "111100111100100", G: "111100101101111", H: "101101111101101",
    I: "111010010010111", J: "001001001101111", K: "101101110101101", L: "100100100100111",
    M: "101111111101101", N: "110101101101101", O: "111101101101111", P: "111101111100100",
    Q: "111101101111001", R: "111101110101101", S: "011100010001110", T: "111010010010010",
    U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    "-": "000000111000000", ".": "000000000000010", ":": "000010000010000", _: "000000000000111",
    "/": "001001010100100", "=": "000111000111000", "#": "101111101111101", "+": "000010111010000",
  }).map(([k, v]) => [k, [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9), v.slice(9, 12), v.slice(12, 15)]]),
);

export function hex(c: string): RGB {
  const v = parseInt(c.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const toHex = (c: RGB) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const scaleC = (c: RGB, k: number): RGB => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
];
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function hashColor(name: string): RGB {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360, sat = 0.55, light = 0.5 + (((h >>> 9) % 20) - 10) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

const BIOME_COLORS: Record<string, string> = {
  ocean: "000070", deep_ocean: "000030", frozen_ocean: "7070d6", deep_frozen_ocean: "404090", cold_ocean: "202070",
  deep_cold_ocean: "202038", lukewarm_ocean: "000090", deep_lukewarm_ocean: "000040", warm_ocean: "0000ac",
  river: "0000ff", frozen_river: "a0a0ff", beach: "fade55", snowy_beach: "faf0c0", stony_shore: "a2a284",
  plains: "8db360", sunflower_plains: "b5db88", snowy_plains: "ffffff", ice_spikes: "b4dcdc", desert: "fa9418",
  swamp: "07f9b2", mangrove_swamp: "67352b", forest: "056621", flower_forest: "2d8e49", birch_forest: "307444",
  old_growth_birch_forest: "589c6c", dark_forest: "40511a", taiga: "0b6659", snowy_taiga: "31554a",
  old_growth_pine_taiga: "596651", old_growth_spruce_taiga: "818e79", jungle: "537b09", sparse_jungle: "628b17",
  bamboo_jungle: "768e14", savanna: "bdb25f", savanna_plateau: "a79d64", windswept_savanna: "e5da87",
  badlands: "d94515", eroded_badlands: "ff6d3d", wooded_badlands: "b09765", windswept_hills: "606060",
  windswept_gravelly_hills: "888888", windswept_forest: "507050", meadow: "60a445", cherry_grove: "f5a9cb",
  grove: "47726c", snowy_slopes: "c4c4c4", frozen_peaks: "a0b0d0", jagged_peaks: "dcdcc8", stony_peaks: "7b8f74",
  mushroom_fields: "ff00ff", dripstone_caves: "4e3012", lush_caves: "283c00", deep_dark: "031f29",
};

export function biomeColor(id: string): RGB {
  const c = id.startsWith("minecraft:") ? BIOME_COLORS[id.slice(10)] : undefined;
  return c ? hex(c) : hashColor(id);
}
export const biomeColorHex = (id: string) => toHex(biomeColor(id));

const HEIGHT_RAMP: [number, RGB][] = [
  [-40, hex("2f6b3a")], [0, hex("5a9e4b")], [30, hex("a8c66c")], [60, hex("e0d58a")], [100, hex("b08d57")],
  [150, hex("8c6b4f")], [200, hex("bdbdbd")], [256, hex("ffffff")],
];
function rampColor(v: number): RGB {
  if (v <= HEIGHT_RAMP[0]![0]) return HEIGHT_RAMP[0]![1];
  for (let i = 1; i < HEIGHT_RAMP.length; i++) {
    const [b, cb] = HEIGHT_RAMP[i]!;
    const [a, ca] = HEIGHT_RAMP[i - 1]!;
    if (v <= b) return mix(ca, cb, (v - a) / (b - a));
  }
  return HEIGHT_RAMP[HEIGHT_RAMP.length - 1]![1];
}
const waterColor = (depth: number): RGB => mix(hex("6fb7e9"), hex("1d3f8f"), Math.min(1, depth / 40));

export const SLOPE_COLORS = { flat: hex("8fce8f"), steep: hex("f2c14e"), cliff: hex("d7263d"), water: hex("9fb4c7") };

export function renderHeight(d: RunData): Img {
  const n = d.size, sea = d.meta.seaLevel;
  const surf = surfaceHeights({ ...d, x0: d.meta.x0, z0: d.meta.z0, seaLevel: sea });
  const img = new Img(n, n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const h = d.groundY[i]!;
      if (d.waterY[i] !== NO_WATER) {
        img.set(x, z, waterColor(d.waterY[i]! - h));
        continue;
      }
      const west = x > 0 ? surf[i - 1]! : h, north = z > 0 ? surf[i - n]! : h;
      let c = scaleC(rampColor(h - sea), Math.max(0.6, Math.min(1.3, 1 + 0.06 * (h - west + (h - north)))));
      const east = x < n - 1 ? surf[i + 1]! : h, south = z < n - 1 ? surf[i + n]! : h;
      const band = Math.floor(h / 16);
      if (band !== Math.floor(east / 16) || band !== Math.floor(south / 16)) c = scaleC(c, 0.72);
      img.set(x, z, c);
    }
  }
  return img;
}

export function renderBiome(d: RunData): Img {
  const n = d.size;
  const colors = d.biomes.map(biomeColor);
  const img = new Img(n, n);
  for (let i = 0; i < n * n; i++) img.set(i % n, Math.floor(i / n), colors[d.biome[i]!]!);
  return img;
}

function blockColors(d: RunData): RGB[] {
  return d.blocks.map((b) => {
    if (b.id === "minecraft:water" || b.id === "minecraft:bubble_column") return hex("3f76e4");
    if (b.id === "minecraft:lava") return hex("ff6a00");
    return b.color ? hex(b.color) : hashColor(b.id);
  });
}

/** Close to what an in-game map shows: block map colors, brighter on north-facing rises. */
export function renderSurface(d: RunData): Img {
  const n = d.size;
  const colors = blockColors(d);
  const surf = surfaceHeights({ ...d, x0: d.meta.x0, z0: d.meta.z0, seaLevel: d.meta.seaLevel });
  const img = new Img(n, n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const base = colors[d.topBlock[i]!]!;
      let k: number;
      if (d.waterY[i] !== NO_WATER) {
        const depth = d.waterY[i]! - d.groundY[i]!;
        k = depth < 4 ? 1 : depth < 9 ? 0.86 : 0.71;
      } else {
        const north = z > 0 ? surf[i - n]! : surf[i]!;
        k = surf[i]! > north ? 1 : surf[i]! === north ? 0.86 : 0.71;
      }
      img.set(x, z, scaleC(base, k));
    }
  }
  return img;
}

export function renderSlope(d: RunData): Img {
  const n = d.size;
  const slope = slopes(n, surfaceHeights({ ...d, x0: d.meta.x0, z0: d.meta.z0, seaLevel: d.meta.seaLevel }));
  const img = new Img(n, n);
  for (let i = 0; i < n * n; i++) {
    const s = slope[i]!;
    const c = d.waterY[i] !== NO_WATER ? SLOPE_COLORS.water : s <= 1 ? SLOPE_COLORS.flat : s <= 3 ? SLOPE_COLORS.steep : SLOPE_COLORS.cliff;
    img.set(i % n, Math.floor(i / n), c);
  }
  return img;
}

/** Side view along one line: 1 block wide, 2 pixels tall per block, with a height scale on the left. */
export function renderSection(d: RunData, s: SectionData): Img {
  const n = d.size, minY = d.meta.minY, maxY = d.meta.maxY, height = maxY - minY;
  const V = 2, left = 44, bottom = 16;
  const colors = blockColors(d);
  const isAir = d.blocks.map((b) => b.id === "minecraft:air" || b.id === "minecraft:cave_air" || b.id === "minecraft:void_air");
  const sky = hex("cfe8ff"), cave = hex("26262b");
  const img = new Img(left + n, height * V + bottom);
  for (let a = 0; a < n; a++) {
    // Air above the ground is sky (also under trees); air below it is a cave.
    const col = s.axis === "x" ? (s.at - d.meta.z0) * n + a : a * n + (s.at - d.meta.x0);
    const top = d.groundY[col]! - minY;
    for (let y = 0; y < height; y++) {
      const b = s.data[a * height + y]!;
      const c = isAir[b] ? (y > top ? sky : cave) : colors[b]!;
      const py = (height - 1 - y) * V;
      for (let v = 0; v < V; v++) img.set(left + a, py + v, c);
    }
  }
  for (let y = Math.ceil(minY / 32) * 32; y < maxY; y += 32) {
    const py = (maxY - 1 - y) * V + 1;
    img.line(left - 5, py, left - 1, py, [0, 0, 0]);
    for (let x = left; x < left + n; x += 8) img.set(x, py, [90, 90, 90]);
    img.text(2, py - 4, String(y), [0, 0, 0]);
  }
  const seaPy = (maxY - 1 - d.meta.seaLevel) * V;
  img.line(left, seaPy, left + n - 1, seaPy, [200, 0, 120], 6);
  const start = s.axis === "x" ? d.meta.x0 : d.meta.z0;
  for (let w = Math.ceil(start / 100) * 100; w < start + n; w += 100) {
    const px = left + (w - start);
    img.line(px, height * V, px, height * V + 3, [0, 0, 0]);
    img.text(px - 8, height * V + 5, String(w), [0, 0, 0]);
  }
  return img;
}

/** Height change against an earlier run of the same seed: red = higher now, blue = lower, white = same. */
export function renderHeightDiff(now: RunData, before: RunData): { img: Img; changedShare: number; meanAbs: number } {
  const n = now.size;
  const a = surfaceHeights({ ...now, x0: now.meta.x0, z0: now.meta.z0, seaLevel: now.meta.seaLevel });
  const b = surfaceHeights({ ...before, x0: before.meta.x0, z0: before.meta.z0, seaLevel: before.meta.seaLevel });
  const img = new Img(n, n);
  let changed = 0, sum = 0;
  for (let i = 0; i < n * n; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) changed++;
    sum += Math.abs(diff);
    const t = Math.min(1, Math.abs(diff) / 32);
    const c: RGB = diff === 0 ? [255, 255, 255] : diff > 0 ? mix([255, 205, 205], [170, 0, 0], t) : mix([205, 215, 255], [0, 20, 170], t);
    img.set(i % n, Math.floor(i / n), c);
  }
  return { img, changedShare: changed / (n * n), meanAbs: sum / (n * n) };
}

export interface OverviewLabels {
  regions: { label: string; name: string }[];
  corridors: { label: string; name: string }[];
}

/**
 * The four maps side by side at reduced size with coordinates on the edges, plus markings:
 * white dashed = cross sections, magenta box = largest flat square, yellow = regions, cyan = roads.
 */
export function renderOverview(
  d: RunData,
  maps: { height: Img; biome: Img; surface: Img; slope: Img },
  targets: Targets,
  metrics: Metrics,
): { img: Img; labels: OverviewLabels } {
  const n = d.size;
  const shrink = n > 600 ? 2 : 1;
  const p = Math.floor(n / shrink);
  const left = 44, top = 30, gap = 12;
  const img = new Img(left + p * 2 + gap + 8, top * 2 + p * 2 + gap);
  const labels: OverviewLabels = {
    regions: Object.keys(targets.regions).map((name, i) => ({ label: `R${i + 1}`, name })),
    corridors: Object.keys(targets.corridors).map((name, i) => ({ label: `C${i + 1}`, name })),
  };
  const panels: [string, Img][] = [["HEIGHT", maps.height], ["BIOME", maps.biome], ["SURFACE", maps.surface], ["SLOPE", maps.slope]];
  panels.forEach(([title, map], idx) => {
    const ox = left + (idx % 2) * (p + gap), oy = top + Math.floor(idx / 2) * (p + top);
    img.blit(map, ox, oy, shrink);
    img.text(ox, oy - 26, title, [0, 0, 0]);
    const px = (wx: number) => ox + (wx - d.meta.x0) / shrink;
    const pz = (wz: number) => oy + (wz - d.meta.z0) / shrink;
    for (let w = Math.ceil(d.meta.x0 / 100) * 100; w < d.meta.x0 + n; w += 100) {
      img.line(px(w), oy - 4, px(w), oy - 1, [0, 0, 0]);
      if (w % 200 === 0) img.text(Math.round(px(w)) - 8, oy - 15, String(w), [0, 0, 0]);
    }
    if (idx % 2 === 0) {
      for (let w = Math.ceil(d.meta.z0 / 100) * 100; w < d.meta.z0 + n; w += 100) {
        img.line(ox - 4, pz(w), ox - 1, pz(w), [0, 0, 0]);
        if (w % 200 === 0) img.text(2, Math.round(pz(w)) - 4, String(w), [0, 0, 0]);
      }
    }
    const white: RGB = [255, 255, 255], black: RGB = [0, 0, 0];
    for (const s of d.meta.sections) {
      if (s.axis === "x") {
        img.line(ox, pz(s.at), ox + p - 1, pz(s.at), white, 5);
        img.text(ox + p - s.name.length * 8 - 3, Math.round(pz(s.at)) + 3, s.name, white, 2, black);
      } else {
        img.line(px(s.at), oy, px(s.at), oy + p - 1, white, 5);
        img.text(Math.round(px(s.at)) + 3, oy + 3, s.name, white, 2, black);
      }
    }
    Object.values(targets.regions).forEach((r, i) => {
      img.rect(px(r.x[0]), pz(r.z[0]), px(r.x[1]) - 1, pz(r.z[1]) - 1, [255, 230, 0]);
      img.text(Math.round(px(r.x[0])) + 3, Math.round(pz(r.z[0])) + 3, labels.regions[i]!.label, [255, 230, 0], 2, black);
    });
    Object.values(targets.corridors).forEach((c, i) => {
      for (let s = 0; s + 1 < c.points.length; s++) {
        const [ax, az] = c.points[s]!, [bx, bz] = c.points[s + 1]!;
        img.line(px(ax), pz(az), px(bx), pz(bz), [0, 240, 255]);
      }
      const [fx, fz] = c.points[0]!;
      img.text(Math.round(px(fx)) + 3, Math.round(pz(fz)) - 13, labels.corridors[i]!.label, [0, 240, 255], 2, black);
    });
    const f = metrics.largest_flat_square;
    if (f.size > 0) {
      const half = f.size >> 1;
      const x0 = px(f.x - half), z0 = pz(f.z - half), x1 = px(f.x - half + f.size) - 1, z1 = pz(f.z - half + f.size) - 1;
      img.rect(x0, z0, x1, z1, [255, 0, 255]);
      img.rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, [255, 0, 255]);
    }
  });
  return { img, labels };
}

/** Writes every image for a run. Returns what the report needs to describe them. */
export function renderAll(
  dir: string,
  d: RunData,
  targets: Targets,
  metrics: Metrics,
  before?: RunData,
): { labels: OverviewLabels; diff?: { changedShare: number; meanAbs: number } } {
  const maps = { height: renderHeight(d), biome: renderBiome(d), surface: renderSurface(d), slope: renderSlope(d) };
  maps.height.save(path.join(dir, "height.png"));
  maps.biome.save(path.join(dir, "biome.png"));
  maps.surface.save(path.join(dir, "surface.png"));
  maps.slope.save(path.join(dir, "slope.png"));
  for (const s of d.sections) renderSection(d, s).save(path.join(dir, `section-${s.name}.png`));
  const { img, labels } = renderOverview(d, maps, targets, metrics);
  img.save(path.join(dir, "overview.png"));
  let diff: { changedShare: number; meanAbs: number } | undefined;
  if (before && before.size === d.size && before.meta.x0 === d.meta.x0 && before.meta.z0 === d.meta.z0) {
    const r = renderHeightDiff(d, before);
    r.img.save(path.join(dir, "diff-height.png"));
    diff = { changedShare: r.changedShare, meanAbs: r.meanAbs };
  }
  return { labels, diff };
}
