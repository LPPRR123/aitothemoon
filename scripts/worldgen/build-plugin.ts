/**
 * Compiles tools/wgexport into tools/wgexport/WgExport.jar.
 * Needs a JDK 17+ (javac, jar) and worldgen-server/ prepared by `npm run worldgen:setup`
 * (the Paper API jar is taken from worldgen-server/libraries).
 *
 *   npm run worldgen:build-plugin
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SERVER_DIR } from "./lib.js";

function findJars(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findJars(p, out);
    else if (e.name.endsWith(".jar")) out.push(p);
  }
  return out;
}

const libs = path.join(SERVER_DIR, "libraries");
if (!fs.existsSync(libs)) {
  console.error(`找不到 ${libs}。先运行 npm run worldgen:setup（它会开一次服，把 Paper 的库解出来）。`);
  process.exit(1);
}
const src = path.join("tools", "wgexport");
const build = fs.mkdtempSync(path.join(os.tmpdir(), "wgexport-"));
try {
  execFileSync(
    "javac",
    ["--release", "17", "-proc:none", "-nowarn", "-cp", findJars(libs).join(path.delimiter), "-d", build,
      path.join(src, "src", "dev", "aitothemoon", "wgexport", "WgExport.java")],
    { stdio: "inherit" },
  );
  fs.copyFileSync(path.join(src, "plugin.yml"), path.join(build, "plugin.yml"));
  const jar = path.resolve(src, "WgExport.jar");
  execFileSync("jar", ["cf", jar, "plugin.yml", "dev"], { cwd: build, stdio: "inherit" });
  console.log(`已生成 ${path.relative(".", jar)}`);
} finally {
  fs.rmSync(build, { recursive: true, force: true });
}
