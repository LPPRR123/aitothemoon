/** Reads what the WgExport plugin wrote for one run. */
import fs from "node:fs";
import path from "node:path";

export const NO_WATER = -32768;

export interface RunMeta {
  seed: string;
  size: number;
  x0: number;
  z0: number;
  minY: number;
  maxY: number;
  seaLevel: number;
  minecraft: string;
  server: string;
  chunks: number;
  chunky: boolean;
  generateMs: number;
  exportMs: number;
  datapacks: string[];
  sections: { name: string; axis: "x" | "z"; at: number }[];
}

export interface SectionData {
  name: string;
  axis: "x" | "z";
  at: number;
  /** size * height block indexes: for each column along the line, y = minY .. maxY-1. */
  data: Uint16Array;
}

export interface RunData {
  meta: RunMeta;
  blocks: { id: string; color?: string }[];
  biomes: string[];
  size: number;
  /** One value per column, rows along z then x: index = (z - z0) * size + (x - x0). */
  groundY: Int16Array;
  waterY: Int16Array;
  topBlock: Uint16Array;
  groundBlock: Uint16Array;
  biome: Uint16Array;
  sections: SectionData[];
}

/**
 * The sea level this run really used. In 1.20.4 the server API always answers 63, whatever the
 * data pack says, so read it from the run's copy of the data pack and fall back to what was exported.
 */
function seaLevelOf(dir: string, exported: number): number {
  const file = path.join(dir, "datapack", "data", "minecraft", "worldgen", "noise_settings", "overworld.json");
  try {
    const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { sea_level?: unknown }).sea_level;
    return typeof v === "number" ? v : exported;
  } catch {
    return exported;
  }
}

export function loadRun(dir: string): RunData {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as RunMeta;
  const palette = JSON.parse(fs.readFileSync(path.join(dir, "palette.json"), "utf8")) as {
    blocks: { id: string; color?: string }[];
    biomes: string[];
  };
  meta.seaLevel = seaLevelOf(dir, meta.seaLevel);
  const size = meta.size;
  const n = size * size;
  const buf = fs.readFileSync(path.join(dir, "columns.bin"));
  if (buf.length !== n * 10) throw new Error(`columns.bin 大小不对：应该是 ${n * 10} 字节，实际 ${buf.length}`);
  const groundY = new Int16Array(n);
  const waterY = new Int16Array(n);
  const topBlock = new Uint16Array(n);
  const groundBlock = new Uint16Array(n);
  const biome = new Uint16Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 10) {
    groundY[i] = buf.readInt16LE(o);
    waterY[i] = buf.readInt16LE(o + 2);
    topBlock[i] = buf.readUInt16LE(o + 4);
    groundBlock[i] = buf.readUInt16LE(o + 6);
    biome[i] = buf.readUInt16LE(o + 8);
  }
  const height = meta.maxY - meta.minY;
  const sections: SectionData[] = meta.sections.map((s) => {
    const b = fs.readFileSync(path.join(dir, "sections", `${s.name}.bin`));
    if (b.length !== size * height * 2) throw new Error(`剖面 ${s.name} 大小不对`);
    const data = new Uint16Array(size * height);
    for (let i = 0; i < data.length; i++) data[i] = b.readUInt16LE(i * 2);
    return { ...s, data };
  });
  return { meta, blocks: palette.blocks, biomes: palette.biomes, size, groundY, waterY, topBlock, groundBlock, biome, sections };
}
