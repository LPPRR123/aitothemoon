/**
 * The giant structures of the crystal grove, generated from maths:
 *   crystal_spire   a twisted crystal tower about 220 blocks tall, with two broken rings and floating shards
 *   sky_isles       a group of floating islands with a giant tree, hanging crystals and a waterfall
 *
 *   npm run worldgen:build-structures
 *
 * Writes into worldgen/datapack/data/aitothemoon/ (structures, template pools, structure, structure set, tag).
 */
import { DATAPACK_DIR } from "../lib.js";
import { Volume, emitStructure, noise, rng } from "./kit.js";

const NS = "aitothemoon";
const BIOMES = [`${NS}:crystal_grove`];
const AMETHYST = "minecraft:amethyst_block";
const CALCITE = "minecraft:calcite";
const BASALT = "minecraft:smooth_basalt";
const GLOW = "minecraft:pearlescent_froglight[axis=y]";
const LOG = "minecraft:birch_log[axis=y]";
const LEAF = "minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]";
const tip = (facing: string) => `minecraft:amethyst_cluster[facing=${facing},waterlogged=false]`;

/** A double pyramid standing on its point: the classic floating crystal. */
function crystal(v: Volume, cx: number, cy: number, cz: number, halfHeight: number, halfWidth: number, core = true): void {
  for (let dy = -halfHeight; dy <= halfHeight; dy++) {
    const w = halfWidth * (1 - Math.abs(dy) / halfHeight);
    for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) {
      for (let dz = -Math.ceil(w); dz <= Math.ceil(w); dz++) {
        if (Math.abs(dx) + Math.abs(dz) <= w * 1.25 && Math.max(Math.abs(dx), Math.abs(dz)) <= w) v.set(cx + dx, cy + dy, cz + dz, AMETHYST);
      }
    }
  }
  if (core) for (let dy = -1; dy <= 1; dy++) v.set(cx, cy + dy, cz, GLOW);
  v.set(cx, cy + halfHeight + 1, cz, tip("up"));
  v.set(cx, cy - halfHeight - 1, cz, tip("down"));
}

function ball(v: Volume, cx: number, cy: number, cz: number, r: number, state: (x: number, y: number, z: number) => string): void {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy + dz * dz <= r * r) v.set(cx + dx, cy + dy, cz + dz, state(cx + dx, cy + dy, cz + dz));
  }
}

// ---------------------------------------------------------------------------------------------
// The spire. Heights below are "h" = blocks above the ground; the volume also has 30 blocks of
// root below the ground so the tower still stands on a slope.
// ---------------------------------------------------------------------------------------------
function buildSpire(): Volume {
  const ROOT = 30, TOP = 224, C = 72;
  const v = new Volume(144, ROOT + TOP, 144);
  const r = rng(7);
  const Y = (h: number) => ROOT + h;
  const SHAFT_TOP = 184;

  // Main shaft: six-sided, twisting as it rises, tapering to a point.
  for (let h = -ROOT; h <= SHAFT_TOP; h++) {
    const R = h < 0 ? 19 : 2 + 17 * Math.pow(1 - h / SHAFT_TOP, 0.75);
    const span = Math.ceil(R * 1.2);
    for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) {
      const d = Math.hypot(dx, dz), th = Math.atan2(dz, dx);
      const edge = R * (1 + 0.13 * Math.cos(6 * (th + h * 0.012)));
      if (d > edge) continue;
      let state = AMETHYST;
      if (d > edge - 1.3) {
        const crust = 10 + 14 * noise(dx + C, 0, dz + C, 9, 1); // the geode shell reaches higher in places
        if (h < crust) state = BASALT;
        else if (h < crust + 7) state = CALCITE;
        else if (Math.cos(3 * (th - h * 0.035)) > 0.965) state = GLOW; // three glowing veins spiralling up
        else if (h < 110 && noise(dx + C, h, dz + C, 6, 2) > 0.72) state = CALCITE;
      }
      v.set(C + dx, Y(h), C + dz, state);
    }
  }

  // Leaning shards bursting out of the base.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.5;
    const lean = 0.45 + r() * 0.5, length = 34 + r() * 44, thick = 4.5 + r() * 3;
    for (let t = 0; t <= length; t += 0.5) {
      const out = 9 + Math.sin(lean) * t, h = -6 + Math.cos(lean) * t;
      const rad = thick * (1 - t / length) + 0.4;
      ball(v, C + Math.cos(a) * out, Y(h), C + Math.sin(a) * out, rad, () => (t < 5 ? CALCITE : AMETHYST));
    }
  }

  // Two broken rings of floating shards, tilted different ways.
  const ring = (h: number, R: number, minor: number, tiltX: number, tiltZ: number, seed: number) => {
    for (let a = 0; a < Math.PI * 2; a += 0.012) {
      const n = noise(Math.cos(a) * 40, Math.sin(a) * 40, seed * 17.3, 9, seed);
      if (n < 0.42) continue; // gaps
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      const y = x * Math.sin(tiltZ) + z * Math.sin(tiltX);
      ball(v, C + x * Math.cos(tiltZ), Y(h + y), C + z * Math.cos(tiltX), minor * (0.35 + 1.3 * (n - 0.42) / 0.58), (bx, by, bz) => {
        const k = noise(bx, by, bz, 3, seed + 5);
        return k > 0.8 ? GLOW : k < 0.22 ? CALCITE : AMETHYST;
      });
    }
  };
  ring(150, 50, 3.4, 0.32, 0.0, 11);
  ring(96, 37, 2.6, 0.0, -0.45, 12);

  // Loose crystals drifting around the tower.
  for (let i = 0; i < 30; i++) {
    const a = r() * Math.PI * 2, dist = 24 + r() * 38, h = 34 + r() * 150;
    const hh = 4 + Math.floor(r() * 8);
    crystal(v, Math.round(C + Math.cos(a) * dist), Y(Math.round(h)), Math.round(C + Math.sin(a) * dist), hh, Math.max(1.5, hh / 2.6));
  }

  // The crown: one great crystal hanging above the tip, with four small ones around it.
  crystal(v, C, Y(206), C, 16, 6.5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    crystal(v, Math.round(C + Math.cos(a) * 14), Y(204 + (i % 2) * 5), Math.round(C + Math.sin(a) * 14), 6, 2.2);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// The floating islands. The volume starts 40 blocks above the ground.
// ---------------------------------------------------------------------------------------------
function buildIsles(): Volume {
  const v = new Volume(144, 128, 144);
  const r = rng(21);

  const island = (cx: number, top: number, cz: number, R: number, depth: number, seed: number, opts: { tree?: boolean; pond?: boolean }) => {
    const span = Math.ceil(R * 1.35);
    const surface = new Map<string, number>();
    for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) {
      const th = Math.atan2(dz, dx);
      const edge = R * (0.78 + 0.5 * noise(Math.cos(th) * 20 + cx, Math.sin(th) * 20 + cz, seed, 9, seed));
      const d = Math.hypot(dx, dz) / edge;
      if (d > 1) continue;
      const x = cx + dx, z = cz + dz;
      const ty = Math.round(top + 2.5 * noise(x, 0, z, 10, seed + 1) + (1 - d) * 2);
      const bottom = Math.round(ty - 2 - depth * Math.pow(1 - d, 0.8) * (0.55 + 0.9 * noise(x, 0, z, 6, seed + 2)));
      for (let y = bottom; y <= ty; y++) {
        const fromTop = ty - y, part = (ty - y) / Math.max(1, ty - bottom);
        let state = "minecraft:stone";
        if (fromTop === 0) state = "minecraft:grass_block[snowy=false]";
        else if (fromTop <= 3) state = "minecraft:dirt";
        else if (part > 0.82) state = AMETHYST;
        else if (part > 0.6) state = CALCITE;
        else if (noise(x, y, z, 5, seed + 3) > 0.7) state = CALCITE;
        v.set(x, y, z, state);
      }
      surface.set(`${x},${z}`, ty);
      // crystals hanging underneath
      if (noise(x * 3.1, 0, z * 3.1, 2, seed + 4) > 0.86) {
        const len = 2 + Math.floor(10 * noise(x, 7, z, 4, seed + 6));
        for (let i = 1; i <= len; i++) v.set(x, bottom - i, z, AMETHYST);
        v.set(x, bottom - len - 1, z, tip("down"));
      }
      // small crystals and flowers on top
      const deco = noise(x * 2.7, 3, z * 2.7, 2, seed + 8);
      if (deco > 0.9 && d < 0.85) {
        const len = 1 + Math.floor(5 * noise(x, 9, z, 3, seed + 9));
        for (let i = 1; i <= len; i++) v.set(x, ty + i, z, AMETHYST);
        v.set(x, ty + len + 1, z, tip("up"));
      } else if (deco < 0.08) v.set(x, ty + 1, z, "minecraft:allium");
    }

    if (opts.pond) {
      // A pond near the rim with a gap in the bank: the water pours over the edge.
      const pa = 0.9, px = Math.round(cx + Math.cos(pa) * R * 0.45), pz = Math.round(cz + Math.sin(pa) * R * 0.45);
      const level = (surface.get(`${px},${pz}`) ?? top) - 1;
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        if (dx * dx + dz * dz > 30 || !surface.has(`${px + dx},${pz + dz}`)) continue;
        for (let y = level + 6; y > level; y--) v.set(px + dx, y, pz + dz, "minecraft:air");
        v.set(px + dx, level, pz + dz, "minecraft:water[level=0]");
        v.set(px + dx, level - 1, pz + dz, dx * dx + dz * dz < 12 ? "minecraft:water[level=0]" : CALCITE);
        v.set(px + dx, level - 2, pz + dz, CALCITE);
      }
      for (let t = 0; t < R * 1.2; t++) {
        const x = Math.round(px + Math.cos(pa) * t), z = Math.round(pz + Math.sin(pa) * t);
        if (!surface.has(`${x},${z}`)) break;
        for (const [ox, oz] of [[0, 0], [Math.round(-Math.sin(pa)), Math.round(Math.cos(pa))]] as const) {
          for (let y = level + 5; y > level; y--) v.set(x + ox, y, z + oz, "minecraft:air");
          v.set(x + ox, level, z + oz, "minecraft:water[level=0]");
          v.set(x + ox, level - 1, z + oz, CALCITE);
        }
      }
    }

    if (opts.tree) {
      // A giant tree: thick white trunk, wide glowing crown, long hanging strands.
      const tx = Math.round(cx - R * 0.2), tz = Math.round(cz - R * 0.15);
      const ground = surface.get(`${tx},${tz}`) ?? top;
      const H = 30;
      for (let i = -2; i <= H; i++) {
        const w = i < 4 ? 2 : 1;
        for (let dx = -w; dx <= w; dx++) for (let dz = -w; dz <= w; dz++) {
          if (Math.abs(dx) + Math.abs(dz) <= w + 1) v.set(tx + dx, ground + i, tz + dz, LOG);
        }
      }
      const crownY = ground + H + 2;
      for (let dy = -7; dy <= 8; dy++) for (let dx = -15; dx <= 15; dx++) for (let dz = -15; dz <= 15; dz++) {
        const q = (dx * dx + dz * dz) / (14.5 * 14.5) + (dy * dy) / (dy > 0 ? 64 : 42);
        const x = tx + dx, y = crownY + dy, z = tz + dz;
        if (q > 0.75 + 0.35 * noise(x, y, z, 5, seed + 12) || v.get(x, y, z) === LOG) continue;
        v.set(x, y, z, noise(x * 1.9, y * 1.9, z * 1.9, 1.5, seed + 13) > 0.93 ? GLOW : LEAF);
      }
      for (let i = 0; i < 70; i++) {
        const a = r() * Math.PI * 2, d = 5 + r() * 9;
        const x = Math.round(tx + Math.cos(a) * d), z = Math.round(tz + Math.sin(a) * d);
        let y = crownY;
        while (y > crownY - 9 && v.get(x, y, z) !== "") y--;
        const len = 2 + Math.floor(r() * 9);
        for (let k = 0; k < len; k++) v.set(x, y - k, z, k === len - 1 && r() < 0.5 ? GLOW : LEAF);
      }
    }
  };

  // heights here are inside the volume: 0 = 40 blocks above the ground
  island(72, 62, 72, 27, 40, 31, { tree: true, pond: true });
  island(26, 40, 40, 11, 18, 32, {});
  island(118, 84, 34, 13, 20, 33, {});
  island(112, 30, 112, 14, 22, 34, {});
  island(30, 74, 114, 10, 16, 35, {});
  island(72, 26, 16, 7, 11, 36, {});
  // a few loose crystals between the islands
  for (let i = 0; i < 10; i++) {
    const x = 12 + Math.floor(r() * 120), y = 14 + Math.floor(r() * 90), z = 12 + Math.floor(r() * 120);
    let clear = true;
    for (let dy = -9; dy <= 9 && clear; dy++) for (let dx = -3; dx <= 3 && clear; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!v.isEmpty(x + dx, y + dy, z + dz)) { clear = false; break; }
    }
    if (clear) crystal(v, x, y, z, 4 + Math.floor(r() * 4), 2);
  }
  return v;
}

const spire = emitStructure({
  packDir: DATAPACK_DIR, namespace: NS, name: "crystal_spire", volume: buildSpire(),
  yCuts: [0, 30, 78, 126, 174, 222, 254], start: [1, 3, 1], startHeight: 96,
  biomes: BIOMES, spacing: 20, separation: 10, salt: 73110,
});
console.log(`crystal_spire：${spire.pieces} 块模板，${spire.blocks} 个方块`);
const isles = emitStructure({
  packDir: DATAPACK_DIR, namespace: NS, name: "sky_isles", volume: buildIsles(),
  yCuts: [0, 48, 96, 128], start: [1, 0, 1], startHeight: 40,
  biomes: BIOMES, spacing: 9, separation: 5, salt: 40519,
  // The game excludes around every spot where a spire COULD be (its placement grid), whether or not one
  // is there. 6 chunks keeps islands out of the tower's shaft and still leaves about 60% of spots usable.
  exclusion: { otherSet: `${NS}:crystal_spire`, chunks: 6 },
});
console.log(`sky_isles：${isles.pieces} 块模板，${isles.blocks} 个方块`);
