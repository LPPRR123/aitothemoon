/**
 * Building blocks for giant structures made from maths instead of by hand in game.
 *
 * A Volume is a box of blocks you fill with code. emitStructure() cuts it into pieces of at most
 * 48x48x48 (the size limit of a structure template), writes each piece as a .nbt file, and links the
 * pieces with jigsaw blocks so the game assembles them back into the full shape. It also writes the
 * template pools, the structure, its structure set and the biome tag that says where it may appear.
 *
 * Limits of the game to keep in mind (1.20.4): every piece must lie within 128 blocks of the base of
 * the start piece in each direction, and a piece can be at most 7 links away from the start piece.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const PIECE = 48;
const DATA_VERSION = 3700; // Minecraft 1.20.4

/** A box of blocks. Index 0 means "leave whatever the world has here". */
export class Volume {
  readonly data: Uint16Array;
  readonly palette: string[] = [""];
  private readonly ids = new Map<string, number>();
  constructor(readonly sx: number, readonly sy: number, readonly sz: number) {
    this.data = new Uint16Array(sx * sy * sz);
  }
  private id(state: string): number {
    let i = this.ids.get(state);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(state);
      this.ids.set(state, i);
    }
    return i;
  }
  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }
  /** Sets a block, e.g. "minecraft:amethyst_cluster[facing=up,waterlogged=false]". Outside the box: ignored. */
  set(x: number, y: number, z: number, state: string): void {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (this.inside(x, y, z)) this.data[(y * this.sz + z) * this.sx + x] = this.id(state);
  }
  get(x: number, y: number, z: number): string {
    return this.inside(x, y, z) ? this.palette[this.data[(y * this.sz + z) * this.sx + x]!]! : "";
  }
  isEmpty(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) === "";
  }
  count(): number {
    let n = 0;
    for (const v of this.data) if (v) n++;
    return n;
  }
}

/** Repeatable random numbers. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise between 0 and 1. `scale` is the size of its bumps in blocks. */
export function noise(x: number, y: number, z: number, scale: number, seed = 0): number {
  x /= scale; y /= scale; z /= scale;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const fx = s(x - x0), fy = s(y - y0), fz = s(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

// ---- a minimal NBT writer (only what a structure file needs) ----

class Nbt {
  private buf = Buffer.alloc(1 << 16);
  private len = 0;
  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const bigger = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(bigger, 0, 0, this.len);
    this.buf = bigger;
  }
  byte(v: number): this { this.need(1); this.buf.writeInt8(v, this.len); this.len += 1; return this; }
  int(v: number): this { this.need(4); this.buf.writeInt32BE(v, this.len); this.len += 4; return this; }
  str(s: string): this {
    const b = Buffer.from(s, "utf8");
    this.need(2 + b.length);
    this.buf.writeUInt16BE(b.length, this.len);
    b.copy(this.buf, this.len + 2);
    this.len += 2 + b.length;
    return this;
  }
  tag(type: number, name: string): this { return this.byte(type).str(name); }
  namedInt(name: string, v: number): this { return this.tag(3, name).int(v); }
  namedStr(name: string, v: string): this { return this.tag(8, name).str(v); }
  list(name: string, type: number, count: number): this { return this.tag(9, name).byte(count ? type : 0).int(count); }
  end(): this { return this.byte(0); }
  gzip(): Buffer { return zlib.gzipSync(this.buf.subarray(0, this.len)); }
}

function parseState(state: string): { name: string; props: [string, string][] } {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(state);
  if (!m) throw new Error(`bad block state: ${state}`);
  const props = (m[2] ?? "").split(",").filter(Boolean).map((p) => p.split("=") as [string, string]);
  return { name: m[1]!, props };
}

interface Cell { x: number; y: number; z: number; state: string; nbt?: Record<string, string> }

function writeTemplate(file: string, size: [number, number, number], cells: Cell[]): void {
  const palette: string[] = [];
  const index = new Map<string, number>();
  for (const c of cells) {
    if (!index.has(c.state)) {
      index.set(c.state, palette.length);
      palette.push(c.state);
    }
  }
  const n = new Nbt().tag(10, "");
  n.namedInt("DataVersion", DATA_VERSION);
  n.list("size", 3, 3).int(size[0]).int(size[1]).int(size[2]);
  n.list("palette", 10, palette.length);
  for (const p of palette) {
    const { name, props } = parseState(p);
    n.namedStr("Name", name);
    if (props.length) {
      n.tag(10, "Properties");
      for (const [k, v] of props) n.namedStr(k, v);
      n.end();
    }
    n.end();
  }
  n.list("blocks", 10, cells.length);
  for (const c of cells) {
    n.list("pos", 3, 3).int(c.x).int(c.y).int(c.z);
    n.namedInt("state", index.get(c.state)!);
    if (c.nbt) {
      n.tag(10, "nbt");
      for (const [k, v] of Object.entries(c.nbt)) n.namedStr(k, v);
      n.end();
    }
    n.end();
  }
  n.list("entities", 10, 0);
  n.end();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, n.gzip());
}

// ---- cutting a volume into linked pieces ----

export interface StructureOptions {
  /** The data pack folder (the one that contains pack.mcmeta). */
  packDir: string;
  namespace: string;
  name: string;
  volume: Volume;
  /** Heights where the volume is cut, from 0 to volume.sy, each step at most 48. */
  yCuts: number[];
  /** Which piece (x, y, z index) the game places first. Everything else hangs off it. */
  start: [number, number, number];
  /** How far above the surface the bottom of the start piece sits. */
  startHeight: number;
  /** Biomes it may appear in. */
  biomes: string[];
  /** Average distance between two of these, and the minimum distance, in chunks. */
  spacing: number;
  separation: number;
  salt: number;
  /** Do not place within this many chunks of a structure from another set. */
  exclusion?: { otherSet: string; chunks: number };
}

const DIRS: { d: [number, number, number]; out: string; back: string }[] = [
  { d: [0, 1, 0], out: "up_north", back: "down_north" },
  { d: [0, -1, 0], out: "down_north", back: "up_north" },
  { d: [1, 0, 0], out: "east_up", back: "west_up" },
  { d: [-1, 0, 0], out: "west_up", back: "east_up" },
  { d: [0, 0, 1], out: "south_up", back: "north_up" },
  { d: [0, 0, -1], out: "north_up", back: "south_up" },
];

export function emitStructure(o: StructureOptions): { pieces: number; blocks: number } {
  const v = o.volume;
  if (v.sx % PIECE || v.sz % PIECE) throw new Error("volume width and depth must be multiples of 48");
  const nx = v.sx / PIECE, nz = v.sz / PIECE, ny = o.yCuts.length - 1;
  if (o.yCuts[0] !== 0 || o.yCuts[ny] !== v.sy) throw new Error("yCuts must run from 0 to the volume height");
  const key = (p: number[]) => `${p[0]}_${p[1]}_${p[2]}`;
  const origin = (p: number[]): [number, number, number] => [p[0]! * PIECE, o.yCuts[p[1]!]!, p[2]! * PIECE];
  const size = (p: number[]): [number, number, number] => [PIECE, o.yCuts[p[1]! + 1]! - o.yCuts[p[1]!]!, PIECE];
  const nonEmpty = (p: number[]): boolean => {
    const [ox, oy, oz] = origin(p), [sx, sy, sz] = size(p);
    for (let y = oy; y < oy + sy; y++) for (let z = oz; z < oz + sz; z++) for (let x = ox; x < ox + sx; x++) {
      if (!v.isEmpty(x, y, z)) return true;
    }
    return false;
  };

  // Walk outwards from the start piece; each piece remembers the neighbour it was reached from.
  const parent = new Map<string, { from: number[]; dir: number } | null>();
  const depth = new Map<string, number>();
  const order: number[][] = [o.start];
  parent.set(key(o.start), null);
  depth.set(key(o.start), 0);
  for (let i = 0; i < order.length; i++) {
    const p = order[i]!;
    DIRS.forEach((dir, di) => {
      const q = [p[0]! + dir.d[0], p[1]! + dir.d[1], p[2]! + dir.d[2]];
      if (q[0]! < 0 || q[1]! < 0 || q[2]! < 0 || q[0]! >= nx || q[1]! >= ny || q[2]! >= nz || parent.has(key(q))) return;
      parent.set(key(q), { from: p, dir: di });
      depth.set(key(q), depth.get(key(p))! + 1);
      order.push(q);
    });
  }
  // Keep pieces that contain something, plus the empty ones needed to reach them.
  const keep = new Set<string>([key(o.start)]);
  for (const p of order) {
    if (!nonEmpty(p)) continue;
    for (let q: number[] | undefined = p; q && !keep.has(key(q)); q = parent.get(key(q))?.from) keep.add(key(q));
    keep.add(key(p));
  }
  const kept = order.filter((p) => keep.has(key(p)));
  const deepest = Math.max(...kept.map((p) => depth.get(key(p))!));
  if (deepest > 7) throw new Error(`${o.name}: a piece is ${deepest} links from the start piece; the game allows 7`);
  const base = o.yCuts[o.start[1]]!;
  if (base - 0 > 127 || v.sy - base > 128) throw new Error(`${o.name}: pieces must stay within 128 blocks of the start piece's base`);

  const id = (p: number[]) => `${o.namespace}:${o.name}/${key(p)}`;
  const jigsaws = new Map<string, Cell[]>(kept.map((p) => [key(p), []]));
  const used = new Set<string>();
  for (const child of kept) {
    const link = parent.get(key(child));
    if (!link) continue;
    const par = link.from, dir = DIRS[link.dir]!;
    const [pox, poy, poz] = origin(par), [psx, psy, psz] = size(par);
    // Cells on the parent's face that touches the child, as world positions inside the volume.
    const axis = dir.d.findIndex((c) => c !== 0);
    const face: [number, number, number][] = [];
    const lim = [psx, psy, psz], org = [pox, poy, poz];
    const a = (axis + 1) % 3, b = (axis + 2) % 3;
    for (let i = 0; i < lim[a]!; i++) for (let j = 0; j < lim[b]!; j++) {
      const c: [number, number, number] = [0, 0, 0];
      c[axis] = org[axis]! + (dir.d[axis]! > 0 ? lim[axis]! - 1 : 0);
      c[a] = org[a]! + i;
      c[b] = org[b]! + j;
      face.push(c);
    }
    const mid = [org[a]! + lim[a]! / 2, org[b]! + lim[b]! / 2];
    const score = (c: [number, number, number]) => {
      const here = !v.isEmpty(c[0], c[1], c[2]), there = !v.isEmpty(c[0] + dir.d[0], c[1] + dir.d[1], c[2] + dir.d[2]);
      // prefer a spot that is solid on both sides (the jigsaw turns back into that block), then the middle
      return (here && there ? 0 : here || there ? 1e6 : 2e6) + Math.abs(c[a]! - mid[0]!) + Math.abs(c[b]! - mid[1]!);
    };
    const free = face.filter((c) => !used.has(c.join(",")) && !used.has([c[0] + dir.d[0], c[1] + dir.d[1], c[2] + dir.d[2]].join(",")));
    free.sort((p1, p2) => score(p1) - score(p2));
    const pc = free[0]!;
    const cc: [number, number, number] = [pc[0] + dir.d[0], pc[1] + dir.d[1], pc[2] + dir.d[2]];
    used.add(pc.join(","));
    used.add(cc.join(","));
    const conn = `${o.namespace}:${o.name}/link_${key(child)}`;
    const [cox, coy, coz] = origin(child);
    jigsaws.get(key(par))!.push({
      x: pc[0] - pox, y: pc[1] - poy, z: pc[2] - poz, state: `minecraft:jigsaw[orientation=${dir.out}]`,
      nbt: { id: "minecraft:jigsaw", name: "minecraft:empty", target: conn, pool: id(child), joint: "aligned", final_state: v.get(pc[0], pc[1], pc[2]) || "minecraft:air" },
    });
    jigsaws.get(key(child))!.push({
      x: cc[0] - cox, y: cc[1] - coy, z: cc[2] - coz, state: `minecraft:jigsaw[orientation=${dir.back}]`,
      nbt: { id: "minecraft:jigsaw", name: conn, target: "minecraft:empty", pool: "minecraft:empty", joint: "aligned", final_state: v.get(cc[0], cc[1], cc[2]) || "minecraft:air" },
    });
  }

  const dataDir = path.join(o.packDir, "data", o.namespace);
  fs.rmSync(path.join(dataDir, "structures", o.name), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, "worldgen", "template_pool", o.name), { recursive: true, force: true });
  const writeJson = (rel: string, obj: unknown) => {
    const f = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
  };
  for (const p of kept) {
    const [ox, oy, oz] = origin(p), [sx, sy, sz] = size(p);
    const special = new Map(jigsaws.get(key(p))!.map((c) => [`${c.x},${c.y},${c.z}`, c]));
    const cells: Cell[] = [...special.values()];
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const state = v.get(ox + x, oy + y, oz + z);
      if (state && !special.has(`${x},${y},${z}`)) cells.push({ x, y, z, state });
    }
    writeTemplate(path.join(dataDir, "structures", o.name, `${key(p)}.nbt`), [sx, sy, sz], cells);
    writeJson(`worldgen/template_pool/${o.name}/${key(p)}.json`, {
      fallback: "minecraft:empty",
      elements: [{ weight: 1, element: { element_type: "minecraft:single_pool_element", location: id(p), processors: "minecraft:empty", projection: "rigid" } }],
    });
  }
  writeJson(`tags/worldgen/biome/has_structure/${o.name}.json`, { replace: false, values: o.biomes });
  writeJson(`worldgen/structure/${o.name}.json`, {
    type: "minecraft:jigsaw",
    biomes: `#${o.namespace}:has_structure/${o.name}`,
    step: "surface_structures",
    spawn_overrides: {},
    terrain_adaptation: "none",
    start_pool: id(o.start),
    size: 7,
    start_height: { absolute: o.startHeight },
    project_start_to_heightmap: "WORLD_SURFACE_WG",
    max_distance_from_center: 128,
    use_expansion_hack: false,
  });
  writeJson(`worldgen/structure_set/${o.name}.json`, {
    structures: [{ structure: `${o.namespace}:${o.name}`, weight: 1 }],
    placement: {
      type: "minecraft:random_spread", spacing: o.spacing, separation: o.separation, salt: o.salt,
      ...(o.exclusion ? { exclusion_zone: { other_set: o.exclusion.otherSet, chunk_count: o.exclusion.chunks } } : {}),
    },
  });
  return { pieces: kept.length, blocks: v.count() };
}
