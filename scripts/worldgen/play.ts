/**
 * Regenerates the world of one round and keeps the server running so a person can walk around.
 *
 *   npm run worldgen:play                the latest round
 *   npm run worldgen:play -- --run 12    round 12
 *
 * Connect to 127.0.0.1:25566 with a 1.20.4 client. Type `stop` in this window to close the server.
 */
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR, SERVER_PORT, loadTargets, parseArgs, readRounds } from "./lib.js";
import { JOB_FILE, assertServerReady, prepareWorld, startServer, writeJob } from "./server.js";

const { values } = parseArgs(process.argv.slice(2));
const rounds = readRounds().filter((r) => r.ok);
const rec = values.run ? rounds.find((r) => r.round === Number(values.run)) : rounds[rounds.length - 1];
if (!rec) {
  console.error(values.run ? `找不到第 ${values.run} 轮（或者那一轮失败了）。` : "还没有跑成功过任何一轮。");
  process.exit(2);
}
const dir = path.join(RUNS_DIR, rec.dir);
const pack = path.join(dir, "datapack");
if (!fs.existsSync(pack)) {
  console.error(`${pack} 不存在，没法重现这一轮。`);
  process.exit(2);
}
const targets = loadTargets();
assertServerReady();
prepareWorld(pack, rec.seed, { whitelist: false });
writeJob({
  size: targets.area.size, cx: targets.area.center[0], cz: targets.area.center[1],
  outDir: path.resolve(dir, "play-out"), sections: [], export: false, stopWhenDone: false,
});

console.log(`正在用第 ${rec.round} 轮的数据包和种子 ${rec.seed} 重新生成世界。`);
console.log(`用 1.20.4 客户端连接 127.0.0.1:${SERVER_PORT}（只有本机能连）。进服就是创造模式；想飞着看可以先在本窗口输入 op <你的名字>，再在游戏里 /gamemode spectator。`);
const report = path.join(dir, "report.md");
if (fs.existsSync(report)) {
  const lines = fs.readFileSync(report, "utf8").split("\n").filter((l) => l.includes("/tp @s"));
  if (lines.length) console.log(`\n值得看的地方：\n${lines.join("\n")}`);
}
console.log("\n看完后在本窗口输入 stop 关服，然后把看到的问题写进 worldgen/feedback.md。\n");

const child = startServer({ interactive: true });
child.on("close", (code) => {
  fs.rmSync(JOB_FILE, { force: true });
  process.exit(code ?? 0);
});
