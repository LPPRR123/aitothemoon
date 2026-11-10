/** Resolves biome tags such as #minecraft:is_ocean from the vanilla reference files plus the data pack. */
import fs from "node:fs";
import path from "node:path";

/** Used when worldgen/vanilla has not been generated. Same content as vanilla 1.20.4. */
const BUILTIN: Record<string, string[]> = {
  "minecraft:is_deep_ocean": [
    "minecraft:deep_frozen_ocean",
    "minecraft:deep_cold_ocean",
    "minecraft:deep_ocean",
    "minecraft:deep_lukewarm_ocean",
  ],
  "minecraft:is_ocean": [
    "#minecraft:is_deep_ocean",
    "minecraft:frozen_ocean",
    "minecraft:ocean",
    "minecraft:cold_ocean",
    "minecraft:lukewarm_ocean",
    "minecraft:warm_ocean",
  ],
  "minecraft:is_river": ["minecraft:river", "minecraft:frozen_river"],
};

type TagValue = string | { id: string; required?: boolean };

function readTagFile(root: string, tag: string): { replace: boolean; values: string[] } | null {
  const [ns, name] = tag.split(":") as [string, string];
  const file = path.join(root, "data", ns, "tags", "worldgen", "biome", `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { replace?: boolean; values?: TagValue[] };
    return { replace: j.replace === true, values: (j.values ?? []).map((v) => (typeof v === "string" ? v : v.id)) };
  } catch {
    return null;
  }
}

export function resolveBiomeTag(tag: string, vanillaDir: string, datapackDir: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(tag)) return out;
  seen.add(tag);
  let values = readTagFile(vanillaDir, tag)?.values ?? BUILTIN[tag] ?? [];
  const pack = readTagFile(datapackDir, tag);
  if (pack) values = pack.replace ? pack.values : [...values, ...pack.values];
  for (const v of values) {
    if (v.startsWith("#")) for (const b of resolveBiomeTag(v.slice(1), vanillaDir, datapackDir, seen)) out.add(b);
    else out.add(v);
  }
  return out;
}
