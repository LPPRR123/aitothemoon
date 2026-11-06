/**
 * Sets up a local Paper 1.20.4 test server in ./test-server (Windows, macOS, Linux):
 * Paper + AuthMe + the TestMenus plugin (a /menu command and a right-click NPC menu).
 *
 *   npm run test-server:setup
 *   cd test-server && java -Xmx2G -jar paper.jar --nogui
 *
 * Requires Java 17 or newer. Then in the server console: `op <your name>` after you log in.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = "test-server";
const VERSION = "1.20.4";
const AUTHME_URL = "https://github.com/AuthMe/AuthMeReloaded/releases/download/5.6.0/AuthMe-5.6.0.jar";

async function download(url: string, dest: string, sha256?: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`校验失败：${url}`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`已下载 ${path.basename(dest)}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
}

async function main() {
  fs.mkdirSync(path.join(DIR, "plugins"), { recursive: true });

  const meta = (await (
    await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${VERSION}/builds/latest`)
  ).json()) as { id: number; downloads: Record<string, { url: string; checksums: { sha256: string } }> };
  const server = meta.downloads["server:default"];
  if (!server) throw new Error("PaperMC 接口没有返回下载地址");
  await download(server.url, path.join(DIR, "paper.jar"), server.checksums.sha256);
  await download(AUTHME_URL, path.join(DIR, "plugins", "AuthMe-5.6.0.jar"));
  fs.copyFileSync(path.join("tools", "testmenus", "TestMenus.jar"), path.join(DIR, "plugins", "TestMenus.jar"));

  fs.writeFileSync(path.join(DIR, "eula.txt"), "eula=true\n");
  if (!fs.existsSync(path.join(DIR, "server.properties"))) {
    fs.writeFileSync(
      path.join(DIR, "server.properties"),
      [
        "online-mode=false",
        "server-port=25565",
        "gamemode=survival",
        "difficulty=easy",
        "spawn-protection=0",
        "level-type=minecraft\\:flat",
        "generate-structures=false",
        "spawn-monsters=false",
        "view-distance=6",
        "motd=aitothemoon test server",
        "enforce-secure-profile=false",
        "",
      ].join("\n"),
    );
  }
  console.log(`\n测试服已就绪（Paper ${VERSION} build ${meta.id} + AuthMe + TestMenus）。启动：`);
  console.log(`  cd ${DIR}`);
  console.log("  java -Xmx2G -jar paper.jar --nogui");
  console.log("\n进服后先 /register 注册登录，然后在服务器控制台输入 op <你的名字>。");
  console.log("测试菜单：/menu 打开菜单；/spawnnpc 菜单NPC 生成一个右键打开菜单的 NPC。");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
