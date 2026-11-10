/** Starting the Paper test server, preparing a fresh world for it, and reading its errors. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACK_NAME, SERVER_DIR, SERVER_PORT } from "./lib.js";

export const JOB_FILE = path.join(SERVER_DIR, "wgexport-job.json");
const WORLD = path.join(SERVER_DIR, "world");

export function assertServerReady(): void {
  if (!fs.existsSync(path.join(SERVER_DIR, "paper.jar"))) {
    throw new Error(`找不到 ${SERVER_DIR}/paper.jar。先运行 npm run worldgen:setup。`);
  }
  const jar = path.join("tools", "wgexport", "WgExport.jar");
  if (!fs.existsSync(jar)) throw new Error(`找不到 ${jar}。运行 npm run worldgen:build-plugin。`);
  fs.mkdirSync(path.join(SERVER_DIR, "plugins"), { recursive: true });
  fs.copyFileSync(jar, path.join(SERVER_DIR, "plugins", "WgExport.jar"));
}

export function writeServerProperties(seed: string, opts: { whitelist: boolean }): void {
  const lines = [
    "# 由 scripts/worldgen 生成，每轮都会重写",
    "online-mode=false",
    `server-port=${SERVER_PORT}`,
    "server-ip=127.0.0.1",
    "level-name=world",
    "level-type=minecraft\\:normal",
    `level-seed=${seed}`,
    "generate-structures=true",
    "allow-nether=false",
    "spawn-monsters=false",
    "spawn-protection=0",
    "gamemode=creative",
    "difficulty=peaceful",
    "view-distance=10",
    "simulation-distance=4",
    "max-players=4",
    `white-list=${opts.whitelist}`,
    "enforce-secure-profile=false",
    "motd=aitothemoon worldgen test",
    "",
  ];
  fs.writeFileSync(path.join(SERVER_DIR, "server.properties"), lines.join("\n"));
}

/**
 * Deletes the old world and puts the data pack where a new world will pick it up.
 * World generation settings are fixed when the world is created, so the pack has to be there first.
 */
export function prepareWorld(datapackDir: string, seed: string, opts: { whitelist: boolean }): void {
  for (const w of ["world", "world_nether", "world_the_end"]) {
    fs.rmSync(path.join(SERVER_DIR, w), { recursive: true, force: true });
  }
  const dest = path.join(WORLD, "datapacks", PACK_NAME);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(datapackDir, dest, { recursive: true });
  writeServerProperties(seed, opts);
  fs.writeFileSync(path.join(SERVER_DIR, "eula.txt"), "eula=true\n");
}

export interface Job {
  size: number;
  cx: number;
  cz: number;
  outDir: string;
  sections: { name: string; axis: "x" | "z"; at: number }[];
  export: boolean;
  stopWhenDone: boolean;
  useChunky?: boolean;
}

export function writeJob(job: Job): void {
  fs.writeFileSync(JOB_FILE, JSON.stringify(job, null, 2));
}

export function startServer(opts: { logFile?: string; interactive?: boolean }): ChildProcess {
  const java = process.env.JAVA ?? "java";
  const mem = process.env.WG_XMX ?? "4G";
  const child = spawn(java, [`-Xmx${mem}`, "-jar", "paper.jar", "--nogui"], {
    cwd: SERVER_DIR,
    stdio: opts.interactive ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  const log = opts.logFile ? fs.createWriteStream(opts.logFile) : null;
  child.stdout!.on("data", (b: Buffer) => {
    log?.write(b);
    if (opts.interactive) process.stdout.write(b);
  });
  child.stderr!.on("data", (b: Buffer) => {
    log?.write(b);
    if (opts.interactive) process.stderr.write(b);
  });
  child.on("close", () => log?.end());
  return child;
}

/**
 * Minecraft 1.20.4 refuses to load the world when a data pack has any error in a worldgen file
 * (and still exits with code 0). This pulls the useful lines out of the log: which registry,
 * which file, and the reason, without the Java stack frames.
 */
export function extractDatapackErrors(log: string): string[] {
  const lines = log.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("Registry loading errors") || l.includes("Failed to load datapacks"));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start; i < lines.length && out.length < 60; i++) {
    const l = lines[i]!;
    if (/^\s+at /.test(l) || /^\s*\.\.\. \d+ more/.test(l) || !l.trim()) continue;
    if (l.includes("Failed to load registries due to above errors")) continue;
    out.push(l.replace(/^\[[\d:]+ (ERROR|WARN)\]: /, ""));
    if (l.includes("Failed to load datapacks")) break;
  }
  return out;
}

/** How many worker threads Paper should use to generate chunks. */
export function workerThreads(): number {
  return Math.max(2, Math.min(16, os.availableParallelism()));
}
