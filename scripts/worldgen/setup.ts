/**
 * Prepares everything the worldgen loop needs (Windows, macOS, Linux):
 *   worldgen-server/   Paper 1.20.4 + Chunky (when it can be downloaded) + the WgExport plugin
 *   worldgen/vanilla/  the vanilla 1.20.4 worldgen JSON files, as a read-only reference
 *
 *   npm run worldgen:setup
 *
 * Requires Java 17 or newer. Safe to run again: files that are already there are kept.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATAPACK_DIR, MC_VERSION, PACK_FORMAT, SERVER_DIR, VANILLA_DIR } from "./lib.js";
import { JOB_FILE, startServer, workerThreads, writeServerProperties } from "./server.js";

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadPaper(): Promise<void> {
  const dest = path.join(SERVER_DIR, "paper.jar");
  if (fs.existsSync(dest)) return console.log("paper.jar 已经有了，跳过下载");
  const meta = JSON.parse(
    (await fetchBuffer(`https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds/latest`)).toString(),
  ) as { id: number; downloads: Record<string, { url: string; checksums: { sha256: string } }> };
  const server = meta.downloads["server:default"];
  if (!server) throw new Error("PaperMC 接口没有返回下载地址");
  const buf = await fetchBuffer(server.url);
  if (createHash("sha256").update(buf).digest("hex") !== server.checksums.sha256) throw new Error("paper.jar 校验失败");
  fs.writeFileSync(dest, buf);
  console.log(`已下载 Paper ${MC_VERSION} build ${meta.id}`);
}

/**
 * Chunky makes generation faster but is optional: without it the WgExport plugin generates the
 * chunks itself through Paper, and the result is the same. So a failed download is only a note.
 */
async function downloadChunky(): Promise<void> {
  const plugins = path.join(SERVER_DIR, "plugins");
  if (fs.readdirSync(plugins).some((f) => /^chunky.*\.jar$/i.test(f))) return console.log("Chunky 已经有了，跳过下载");
  try {
    const url = `https://api.modrinth.com/v2/project/chunky/version?game_versions=${encodeURIComponent(JSON.stringify([MC_VERSION]))}`;
    const versions = JSON.parse((await fetchBuffer(url)).toString()) as {
      version_number: string;
      loaders: string[];
      files: { url: string; filename: string; primary: boolean; hashes: { sha512: string } }[];
    }[];
    const v = versions.find((x) => x.loaders.some((l) => ["paper", "bukkit", "spigot"].includes(l)));
    const file = v?.files.find((f) => f.primary) ?? v?.files[0];
    if (!v || !file) throw new Error(`Modrinth 上没有找到支持 ${MC_VERSION} 的 Chunky`);
    const buf = await fetchBuffer(file.url);
    if (createHash("sha512").update(buf).digest("hex") !== file.hashes.sha512) throw new Error("Chunky 校验失败");
    fs.writeFileSync(path.join(plugins, file.filename), buf);
    console.log(`已下载 Chunky ${v.version_number}`);
  } catch (e) {
    console.log(`没能下载 Chunky（${(e as Error).message}）。`);
    console.log("  不影响使用：没有 Chunky 时由导出插件自己生成区块。想用的话，手动把支持 1.20.4 的 Chunky jar 放进 worldgen-server/plugins/。");
  }
}

/** Starts the server once so Paper unpacks its libraries and writes its config files, then stops it. */
async function firstBoot(): Promise<void> {
  if (fs.existsSync(path.join(SERVER_DIR, "libraries")) && fs.existsSync(path.join(SERVER_DIR, "config", "paper-global.yml"))) return;
  console.log("第一次开服（让 Paper 解出库文件和配置）……");
  fs.writeFileSync(path.join(SERVER_DIR, "eula.txt"), "eula=true\n");
  writeServerProperties("0", { whitelist: true });
  fs.rmSync(JOB_FILE, { force: true });
  const child = startServer({ logFile: path.join(SERVER_DIR, "setup.log") });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("第一次开服超过 5 分钟没完成，看 worldgen-server/setup.log"));
    }, 300_000);
    let buf = "";
    child.stdout!.on("data", (b: Buffer) => {
      buf += b.toString();
      if (buf.includes("Done (")) {
        buf = "";
        child.stdin!.write("stop\n");
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`启动 java 失败：${e.message}。需要 Java 17 或更新的版本。`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!fs.existsSync(path.join(SERVER_DIR, "libraries"))) throw new Error("开服失败，看 worldgen-server/setup.log");
  for (const w of ["world", "world_nether", "world_the_end"]) fs.rmSync(path.join(SERVER_DIR, w), { recursive: true, force: true });
}

function tuneConfigs(): void {
  const bukkit = path.join(SERVER_DIR, "bukkit.yml");
  if (fs.existsSync(bukkit)) fs.writeFileSync(bukkit, fs.readFileSync(bukkit, "utf8").replace(/allow-end: true/, "allow-end: false"));
  const paper = path.join(SERVER_DIR, "config", "paper-global.yml");
  if (fs.existsSync(paper)) {
    // By default Paper only uses about half the cores for chunk generation.
    fs.writeFileSync(paper, fs.readFileSync(paper, "utf8").replace(/worker-threads: -?\d+/, `worker-threads: ${workerThreads()}`));
  }
}

function buildPluginIfMissing(): void {
  const jar = path.join("tools", "wgexport", "WgExport.jar");
  if (fs.existsSync(jar)) return;
  console.log("编译导出插件……");
  execFileSync(process.execPath, ["--import", "tsx", path.join("scripts", "worldgen", "build-plugin.ts")], { stdio: "inherit" });
}

/** Uses Mojang's own data generator (inside the vanilla jar Paper downloaded) to dump the vanilla worldgen files. */
function generateVanillaReference(): void {
  if (fs.existsSync(path.join(VANILLA_DIR, "data", "minecraft", "worldgen", "noise_settings", "overworld.json"))) {
    return console.log("worldgen/vanilla 已经有了，跳过");
  }
  const jar = path.resolve(SERVER_DIR, "cache", `mojang_${MC_VERSION}.jar`);
  if (!fs.existsSync(jar)) return console.log(`找不到 ${jar}，跳过生成原版参考文件`);
  console.log("生成原版参考文件……");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wg-vanilla-"));
  try {
    execFileSync(process.env.JAVA ?? "java", ["-DbundlerMainClass=net.minecraft.data.Main", "-jar", jar, "--server", "--reports", "--output", "out"], {
      cwd: tmp,
      stdio: "ignore",
    });
    const copy = (from: string, to: string) => {
      const src = path.join(tmp, "out", from);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(VANILLA_DIR, to), { recursive: true });
    };
    fs.rmSync(VANILLA_DIR, { recursive: true, force: true });
    copy("data/minecraft/worldgen", "data/minecraft/worldgen");
    copy("data/minecraft/tags/worldgen", "data/minecraft/tags/worldgen");
    copy("data/minecraft/dimension_type", "data/minecraft/dimension_type");
    copy("reports/biome_parameters", "reports/biome_parameters");
    console.log(`已写入 ${VANILLA_DIR}（只读参考，不进 git）`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ensureDatapack(): void {
  const mcmeta = path.join(DATAPACK_DIR, "pack.mcmeta");
  if (fs.existsSync(mcmeta)) return;
  fs.mkdirSync(DATAPACK_DIR, { recursive: true });
  fs.writeFileSync(mcmeta, JSON.stringify({ pack: { pack_format: PACK_FORMAT, description: "aitothemoon worldgen" } }, null, 2) + "\n");
  console.log(`已创建空数据包 ${DATAPACK_DIR}（空数据包 = 原版地形）`);
}

async function main() {
  fs.mkdirSync(path.join(SERVER_DIR, "plugins"), { recursive: true });
  await downloadPaper();
  await downloadChunky();
  await firstBoot();
  tuneConfigs();
  buildPluginIfMissing();
  generateVanillaReference();
  ensureDatapack();
  console.log("\n准备好了。跑第一轮：npm run worldgen:round");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
