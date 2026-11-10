/** Shared paths, the targets.yaml schema, and small helpers for the worldgen loop scripts. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const SERVER_DIR = "worldgen-server";
export const WG_DIR = "worldgen";
export const DATAPACK_DIR = path.join(WG_DIR, "datapack");
export const VANILLA_DIR = path.join(WG_DIR, "vanilla");
export const RUNS_DIR = path.join(WG_DIR, "runs");
export const TARGETS_FILE = path.join(WG_DIR, "targets.yaml");
export const FEEDBACK_FILE = path.join(WG_DIR, "feedback.md");
export const LOG_FILE = path.join(WG_DIR, "log.md");
export const ROUNDS_FILE = path.join(WG_DIR, "rounds.jsonl");

export const MC_VERSION = "1.20.4";
export const PACK_FORMAT = 26;
export const SERVER_PORT = 25566;
/** Folder name of the data pack inside world/datapacks; the server lists it as file/<name>. */
export const PACK_NAME = "aitothemoon-worldgen";

const range = z.tuple([z.number(), z.number()]);

const targetsSchema = z.object({
  goal: z.string().default(""),
  seed: z.union([z.number(), z.string()]).transform(String),
  verify_seeds: z.array(z.union([z.number(), z.string()]).transform(String)).default([]),
  area: z
    .object({ center: range.default([0, 0]), size: z.number().int().min(64).max(4096).default(1000) })
    .default({ center: [0, 0], size: 1000 }),
  current_stage: z.number().int().default(1),
  human_check_every: z.number().int().min(1).default(5),
  /** Block ids that never count as ground, on top of leaves, logs and plants. */
  not_ground: z.array(z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/)).default([]),
  flat_square: z.object({ max_relief: z.number().int().min(0).default(4) }).default({ max_relief: 4 }),
  stages: z
    .record(
      z.string(),
      z.object({
        name: z.string(),
        allow: z.array(z.string()),
        /** For a file, the only top-level JSON keys that may change in this stage. */
        only_keys: z.record(z.string(), z.array(z.string())).default({}),
      }),
    )
    .default({}),
  sections: z
    .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), axis: z.enum(["x", "z"]), at: z.number().int() }))
    .default([]),
  groups: z.record(z.string(), z.array(z.string())).default({}),
  regions: z.record(z.string(), z.object({ x: range, z: range })).default({}),
  corridors: z
    .record(z.string(), z.object({ points: z.array(range).min(2), width: z.number().int().min(1).default(5) }))
    .default({}),
  checks: z
    .array(
      z.object({
        name: z.string(),
        metric: z.string(),
        min: z.number().optional(),
        max: z.number().optional(),
        stage: z.number().int().default(1),
      }),
    )
    .default([]),
});

export type Targets = z.infer<typeof targetsSchema>;

export function loadTargets(file = TARGETS_FILE): Targets {
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}。先运行 npm run worldgen:setup。`);
  const parsed = targetsSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`${file} 写得不对：\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every file under dir, as forward-slash paths relative to dir, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort();
}

/** path -> sha256 for every file in a data pack folder. */
export function manifestOf(dir: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of listFiles(dir)) m[f] = sha256(fs.readFileSync(path.join(dir, f)));
  return m;
}

export function hashManifest(m: Record<string, string>): string {
  return sha256(Object.keys(m).sort().map((k) => `${k}\0${m[k]}`).join("\n")).slice(0, 16);
}

/** One line of worldgen/rounds.jsonl. Written by the scripts, never by hand. */
export interface RoundRecord {
  round: number;
  kind: "round" | "verify";
  dir: string;
  seed: string;
  time: string;
  stage: number;
  datapack: string;
  feedback: string;
  ok: boolean;
  passed?: boolean;
  failedChecks?: string[];
  forced?: string[];
  error?: string;
  metrics?: Record<string, number>;
}

export function readRounds(): RoundRecord[] {
  if (!fs.existsSync(ROUNDS_FILE)) return [];
  return fs
    .readFileSync(ROUNDS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RoundRecord);
}

export function appendRound(r: RoundRecord): void {
  fs.appendFileSync(ROUNDS_FILE, JSON.stringify(r) + "\n");
}

export function feedbackHash(): string {
  return fs.existsSync(FEEDBACK_FILE) ? sha256(fs.readFileSync(FEEDBACK_FILE)).slice(0, 16) : "none";
}

export function runDirName(round: number, seed: string): string {
  return `${String(round).padStart(4, "0")}-s${seed}`;
}

/** Simple --name value / --flag parser. */
export function parseArgs(argv: string[]): { flags: Set<string>; values: Record<string, string> } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[name] = next;
      i++;
    } else flags.add(name);
  }
  return { flags, values };
}
