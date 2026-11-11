/**
 * 验证 /fkfriends import：把旧 FriendSystem 的数据导入 FKFriends。
 *
 * 前提：跨服测试环境（docs/HANDOFF.md 第 8 节），旧库导出已装进本机 MariaDB 的 friendsystem 库，
 * Spawn 的 config.yml 里 import.friendsystem 指向它；另有一份"应该导入多少"的独立核算 EXPECTED_JSON
 * （pairs = 好友对的两个离线 UUID，req = [发送人, 接收人]）。
 *
 *   NET_DIR=E:/AI_localtest/fkfriends-net OLD_SQL=E:/git/AI_workspace/friendsystem.sql EXPECTED_JSON=... npm run fkfriends-import-test
 *
 * 只读旧库，不改它。测试会清空本机的 fkfriends 库。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, ctx, problems, results, sleep, TestServer, writeReport } from "./lib/fkf-harness.js";

const NET = path.resolve(process.env.NET_DIR ?? "E:/AI_localtest/fkfriends-net");
const OLD_SQL = process.env.OLD_SQL ?? "E:/git/AI_workspace/friendsystem.sql";
const EXPECTED = JSON.parse(fs.readFileSync(process.env.EXPECTED_JSON!, "utf8")) as { pairs: [string, string][]; req: [string, string][] };
const SPAWN_CFG = path.join(NET, "spawn", "plugins", "FKFriends", "config.yml");

function sql(query: string, db = "fkfriends"): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(NET, "mariadb", "bin", "mariadb.exe"), ["--user=root", "--password=fkftest", "--port=3307", "--host=localhost", "--protocol=TCP", "-N", "-B", db, "-e", query]);
    let out = "";
    p.stdout.on("data", (b) => (out += b.toString("utf8")));
    p.stderr.on("data", (b) => (out += b.toString("utf8")));
    p.once("exit", (code) => (code === 0 ? resolve(out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"))) : reject(new Error(out))));
  });
}
const count = async (table: string) => Number((await sql(`SELECT COUNT(*) FROM fkf_${table}`))[0]?.[0] ?? -1);

function setSqlFile(file: string) {
  const t = fs.readFileSync(SPAWN_CFG, "utf8").replace(/(  friendsystem:\n(?:\s*#.*\n)*\s*sql-file: )"[^"]*"/, `$1"${file.replace(/\\/g, "/")}"`);
  fs.writeFileSync(SPAWN_CFG, t);
}

async function runImport(srv: TestServer, arg = ""): Promise<string> {
  const from = srv.lines.length;
  const t0 = Date.now();
  srv.console(`fkfriends import ${arg}`.trim());
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const hit = srv.lines.slice(from).filter((l) => /导入完成|导入失败|旧库键/.test(l));
    if (hit.some((l) => /导入失败/.test(l)) || hit.some((l) => /旧库键/.test(l))) {
      await sleep(300);
      return `${srv.lines.slice(from).filter((l) => /导入|旧库键/.test(l)).join(" / ")}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
    }
  }
  return "120 秒内没有结果";
}

async function compareWithExpected(label: string) {
  const pairs = await sql("SELECT lo, hi FROM fkf_friends");
  const got = new Set(pairs.map(([a, b]) => [a, b].sort().join("|")));
  const want = new Set(EXPECTED.pairs.map((p) => [...p].sort().join("|")));
  const missing = [...want].filter((x) => !got.has(x)).length;
  const extra = [...got].filter((x) => !want.has(x)).length;
  check(`${label}：好友关系逐对和独立核算一致`, missing === 0 && extra === 0, `核算 ${want.size} 对，库里 ${got.size} 对，缺 ${missing}，多 ${extra}`);
  const reqs = await sql("SELECT sender, target FROM fkf_requests");
  const gotR = new Set(reqs.map(([s, t]) => `${s}|${t}`));
  const wantR = new Set(EXPECTED.req.map(([s, t]) => `${s}|${t}`));
  const missR = [...wantR].filter((x) => !gotR.has(x)).length;
  const extraR = [...gotR].filter((x) => !wantR.has(x)).length;
  check(`${label}：好友申请逐条和独立核算一致（方向正确）`, missR === 0 && extraR === 0, `核算 ${wantR.size} 条，库里 ${gotR.size} 条，缺 ${missR}，多 ${extraR}`);
}

async function resetFk() {
  await sql("DROP DATABASE IF EXISTS fkfriends; CREATE DATABASE fkfriends CHARACTER SET utf8mb4;", "mysql");
}

async function main() {
  const oldBefore = await sql("SELECT (SELECT COUNT(*) FROM player),(SELECT COUNT(*) FROM friend),(SELECT COUNT(*) FROM request)", "friendsystem");
  await resetFk();
  setSqlFile("");
  const spawnSrv = new TestServer(path.join(NET, "spawn"), "Spawn");
  await spawnSrv.start();
  await spawnSrv.waitConsole();

  // ---------------------------------------------------------- 从 MySQL 导入
  ctx.section = "从旧 MySQL 库导入";
  ctx.step = "第一次导入";
  let r = await runImport(spawnSrv);
  check("/fkfriends import 完成", /导入完成/.test(r), r);
  const [players, friends, requests] = [await count("players"), await count("friends"), await count("requests")];
  check("玩家数 = 12252（12400 行，148 个非法名字跳过）", players === 12252, `fkf_players ${players}`);
  check("好友对数 = 4817（旧表每对存两行，9634 行合并）", friends === 4817, `fkf_friends ${friends}`);
  check(`申请数 = ${EXPECTED.req.length}（只导最近 3 天，且两人还不是好友）`, requests === EXPECTED.req.length, `fkf_requests ${requests}，导入提示：${r}`);
  await compareWithExpected("MySQL 导入");
  const sinceBad = await sql("SELECT COUNT(*) FROM fkf_friends WHERE since <= 0 OR since > UNIX_TIMESTAMP()*1000");
  check("成为好友的时间都带过来了（没有 0 或未来时间）", sinceBad[0]?.[0] === "0", `异常时间 ${sinceBad[0]?.[0]} 条`);
  const sample = await sql("SELECT name FROM fkf_players WHERE name_lower='viviana163'");
  check("名字大小写按旧库保存", sample[0]?.[0] === "Viviana163", sample[0]?.[0] ?? "没找到");

  ctx.step = "重复导入";
  r = await runImport(spawnSrv);
  check("不加 force 再导一次：拒绝", /之前已经导入过/.test(r), r);
  const removedPair = (await sql("SELECT lo, hi FROM fkf_friends LIMIT 1"))[0]!;
  await sql(`DELETE FROM fkf_friends WHERE lo='${removedPair[0]}' AND hi='${removedPair[1]}'`);
  r = await runImport(spawnSrv, "force");
  check("加 force 再导：成功，不会重复出好友关系、申请", /导入完成/.test(r) && (await count("friends")) === 4817 && (await count("players")) === 12252 && (await count("requests")) === EXPECTED.req.length, `${r}，好友 ${await count("friends")}，玩家 ${await count("players")}`);
  check("force 重导会把已删除的好友加回来（提示里说过）", (await sql(`SELECT COUNT(*) FROM fkf_friends WHERE lo='${removedPair[0]}' AND hi='${removedPair[1]}'`))[0]?.[0] === "1", "删掉的那一对又出现了");

  ctx.step = "旧库没被改";
  const oldAfter = await sql("SELECT (SELECT COUNT(*) FROM player),(SELECT COUNT(*) FROM friend),(SELECT COUNT(*) FROM request)", "friendsystem");
  check("旧库行数不变（只读）", JSON.stringify(oldBefore) === JSON.stringify(oldAfter), `${oldBefore[0]?.join("/")} → ${oldAfter[0]?.join("/")}`);
  await spawnSrv.stop();

  // ---------------------------------------------------------- 从 .sql 文件导入
  ctx.section = "从 .sql 导出文件导入";
  ctx.step = "sql-file";
  await resetFk();
  setSqlFile(OLD_SQL);
  await spawnSrv.start();
  await spawnSrv.waitConsole();
  r = await runImport(spawnSrv);
  check("sql-file 方式导入完成", /导入完成/.test(r), r);
  check("sql-file 方式数量一致", (await count("players")) === 12252 && (await count("friends")) === 4817 && (await count("requests")) === EXPECTED.req.length, `玩家 ${await count("players")} 好友 ${await count("friends")} 申请 ${await count("requests")}`);
  await compareWithExpected("sql-file 导入");
  setSqlFile("");

  // ---------------------------------------------------------- 申请的天数限制
  ctx.section = "申请只导 3 天";
  ctx.step = "查具体玩家";
  let info = await spawnSrv.consoleOut("fkfriends info Kirito_ue", 2000);
  check("2026-11-09 的申请（3 天内）导进来了", info.some((l) => /申请 收到\/发出: 1\//.test(l)), info.filter((l) => /申请/.test(l)).join(" "));
  info = await spawnSrv.consoleOut("fkfriends info wmdw", 2000);
  check("2026-11-07 的申请（超过 3 天）没导", info.some((l) => /申请 收到\/发出: 0\//.test(l)), info.filter((l) => /申请/.test(l)).join(" "));
  const oldest = (await sql("SELECT MIN(created) FROM fkf_requests"))[0]?.[0];
  check("库里最老的申请不超过 3 天", Number(oldest) >= Date.now() - 3 * 86_400_000, oldest ? new Date(Number(oldest)).toISOString() : "没有申请");

  ctx.section = "收尾";
  await spawnSrv.stop();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过，服务器异常/警告 ${problems.length} 处`);
  writeReport("fkfriends-import");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  writeReport("fkfriends-import");
  process.exit(1);
});
