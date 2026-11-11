/**
 * FKFriends 跨服测试：BungeeCord + Login（AuthMe）+ Spawn + FKCS 两个装了 FKFriends 的子服，
 * 共用 MariaDB 和 Redis。脚本自己启动/停止 Bungee 和三个子服；Redis、MariaDB 没在跑就顺带启动。
 *
 *   NET_DIR=E:/AI_localtest/fkfriends-net npm run fkfriends-net-test
 *
 * 目录结构见 docs/FKFRIENDS-TEST.md。
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { check, ctx, findItem, names, Player, problems, results, sleep, TestServer, writeReport } from "./lib/fkf-harness.js";

const NET = path.resolve(process.env.NET_DIR ?? "E:/AI_localtest/fkfriends-net");
const PROXY_PORT = 25577;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

async function ensureBackends() {
  if (!(await portOpen(6380))) {
    spawn(path.join(NET, "redis", "redis-server.exe"), ["--port", "6380", "--bind", "127.0.0.1", "--save", ""], { detached: true, stdio: "ignore" }).unref();
  }
  if (!(await portOpen(3307))) {
    spawn(path.join(NET, "mariadb", "bin", "mariadbd.exe"), [`--defaults-file=${path.join(NET, "mariadb", "data", "my.ini")}`, "--console"], { detached: true, stdio: "ignore" }).unref();
  }
  for (let i = 0; i < 20 && !((await portOpen(6380)) && (await portOpen(3307))); i++) await sleep(1000);
}

/** 清空 FKFriends 的表和 Redis，从空数据开始 */
async function resetData() {
  await new Promise<void>((resolve) => {
    const p = spawn(path.join(NET, "mariadb", "bin", "mariadb.exe"), ["--user=root", "--password=fkftest", "--port=3307", "--host=localhost", "--protocol=TCP", "-e", "DROP DATABASE IF EXISTS fkfriends; CREATE DATABASE fkfriends CHARACTER SET utf8mb4;"]);
    p.once("exit", () => resolve());
  });
  await new Promise<void>((resolve) => {
    const p = spawn(path.join(NET, "redis", "redis-cli.exe"), ["-p", "6380", "FLUSHALL"]);
    p.once("exit", () => resolve());
  });
}

async function main() {
  await ensureBackends();
  await resetData();
  const spawnSrv = new TestServer(path.join(NET, "spawn"), "Spawn", undefined);
  const fkcsSrv = new TestServer(path.join(NET, "fkcs"), "FKCS");
  const loginSrv = new TestServer(path.join(NET, "login"), "Login");
  const bungee = new TestServer(
    path.join(NET, "bungee"),
    "Bungee",
    ["-Xmx512M", "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-jar", "BungeeCord.jar"],
    /Listening on \/127\.0\.0\.1:25577/,
  );
  await Promise.all([spawnSrv.start(), fkcsSrv.start(), loginSrv.start()]);
  await bungee.start();
  for (const s of [spawnSrv, fkcsSrv, loginSrv]) await s.waitConsole();

  ctx.section = "启动";
  ctx.step = "检查连接";
  const fkfLines = (s: TestServer) => s.lines.filter((l) => /FKFriends/.test(l));
  check("Bungee 端插件启用并连上 Redis", bungee.lines.some((l) => /FKFriends-Bungee/.test(l)) && !bungee.lines.some((l) => /FKFriends-Bungee[\s\S]*(Exception|无法连接)/.test(l)), bungee.lines.filter((l) => /FKFriends/i.test(l)).slice(0, 4).join(" / "));
  for (const s of [spawnSrv, fkcsSrv]) {
    check(`${s.label} 插件启用（MySQL + Redis）`, fkfLines(s).some((l) => /已启用/.test(l)), fkfLines(s).filter((l) => /已启用|Redis|MYSQL|错误/i.test(l)).join(" / "));
  }

  const P = (n: string) => new Player(n, "127.0.0.1", PROXY_PORT);
  const A = P("Alice"), B = P("Bob"), C = P("Carol"), D = P("Dave");
  const where = async (p: Player) => {
    const out = await bungee.consoleOut(`find ${p.name}`, 1000);
    return out.find((l) => /is online at/i.test(l))?.match(/online at (\S+)/i)?.[1] ?? out.join(" ");
  };
  const goto = async (p: Player, server: string) => {
    bungee.console(`send ${p.name} ${server}`);
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if ((await where(p)) === server) break;
    }
    await sleep(2500); // 子服加载好友数据
  };

  ctx.section = "跨服流程";
  ctx.step = "登录后送到 Spawn";
  for (const p of [A, B, C]) await p.join();
  await sleep(3000);
  const locs = await Promise.all([A, B, C].map(where));
  check("AuthMe 登录后自动送到 Spawn", locs.every((x) => x === "Spawn"), locs.join(", "));
  for (const s of [spawnSrv, fkcsSrv]) for (const p of [A, B, C, D]) s.console(`op ${p.name}`);

  let st = await spawnSrv.consoleOut("fkfriends status", 3000);
  check("Spawn /fkfriends status：Redis 已连接、本服 Spawn、Bungee 上报", st.some((l) => /Redis 已连接/.test(l) && /本服 Spawn/.test(l) && /Bungee/.test(l)), st.filter((l) => /模式/.test(l)).join(" "));

  ctx.step = "Bob 去 FKCS";
  await goto(B, "FKCS");
  check("Bungee send 切到 FKCS", (await where(B)) === "FKCS", await where(B));
  st = await fkcsSrv.consoleOut("fkfriends status");
  check("FKCS /fkfriends status", st.some((l) => /Redis 已连接/.test(l) && /本服 FKCS/.test(l)), st.filter((l) => /模式/.test(l)).join(" "));

  ctx.step = "跨服申请";
  let ib = B.mark();
  let r = await A.cmd("/friend add Bob", 2500);
  check("跨服发申请：发起人确认", /已向 Bob 发送好友申请/.test(r), r);
  check("跨服发申请：另一个子服的对方收到通知（带按钮）", /Alice 想加你为好友/.test(B.since(ib).join()) && /\/friend accept Alice/.test(B.sinceJson(ib).join()), B.since(ib).join(" | "));

  ctx.step = "跨服接受";
  let ia = A.mark();
  r = await B.cmd("/friend accept Alice", 2500);
  check("跨服接受：双方都收到成为好友", /你和 Alice 成为了好友/.test(r) && /Bob 接受了你的好友申请/.test(A.since(ia).join()), `${r} || Alice: ${A.since(ia).join(" | ")}`);

  ctx.step = "跨服在线状态";
  let m = await A.openMenu("/friend");
  const bobEntry = findItem(m, /^Bob/);
  check("好友列表显示 Bob 在线 · 生存一区", !!bobEntry?.lore.some((l) => /在线.*生存一区/.test(l)), bobEntry?.lore.join(" / ") ?? names(m));
  A.close();

  ctx.step = "跨服私聊";
  ib = B.mark();
  r = await A.cmd("/fm Bob 跨服你好", 2500);
  check("跨服 /fm：对方收到", /你 → Bob: 跨服你好/.test(r) && /Alice → 你: 跨服你好/.test(B.since(ib).join()), `${r} || Bob: ${B.since(ib).join(" | ")}`);

  ctx.step = "跨服齿轮";
  ib = B.mark();
  r = await A.cmd("/flower Bob 2", 2500);
  check("跨服送齿轮：对方收到", /你送给 Bob 2个齿轮/.test(r) && /Alice 送给你 2个齿轮/.test(B.since(ib).join()), `${r} || Bob: ${B.since(ib).join(" | ")}`);

  ctx.step = "跨服备注";
  r = await A.cmd("/friend note Bob 远方的Bob", 2000);
  check("跨服好友设备注", /备注设为 远方的Bob/.test(r), r);

  ctx.step = "跨服 /friend join";
  ib = B.mark();
  A.bot.chat("/friend join Bob");
  let arrived = false;
  for (let i = 0; i < 30 && !arrived; i++) {
    await sleep(500);
    arrived = (await where(A)) === "FKCS";
  }
  await sleep(4000);
  const aMsgs = A.since(0).slice(-8).join(" | ");
  const dist = A.bot.entity && B.bot.entity ? A.bot.entity.position.distanceTo(B.bot.entity.position) : -1;
  check("跨服 /friend join：先切到 Bob 的子服", arrived, `${await where(A)}，${aMsgs}`);
  check("跨服 /friend join：到达后传到 Bob 身边", arrived && dist >= 0 && dist < 3 && /Carol|Bob 传送|已传送到 Bob/.test(aMsgs + B.since(ib).join()), `距离 ${dist.toFixed(1)}，Alice: ${aMsgs} || Bob: ${B.since(ib).join(" | ")}`);

  ctx.step = "同子服内 join 冷却";
  r = await A.cmd("/friend join Bob", 1500);
  check("跨服传送后冷却生效", /传送冷却中|已传送/.test(r), r);

  ctx.step = "登录服不算在线";
  await goto(A, "Spawn");
  await D.join(); // 先来过一次，名字进库
  await D.quit();
  await sleep(2000);
  r = await A.cmd("/friend add Dave", 2000);
  check("给离线的 Dave 发申请", /已向 Dave 发送好友申请/.test(r), r);
  await D.join();
  await sleep(4000);
  r = await D.cmd("/friend accept Alice", 2500);
  check("Dave 接受（离线时收到的申请）", /你和 Alice 成为了好友/.test(r), r);
  await D.quit();
  await sleep(2000);
  ia = A.mark();
  const D2 = P("Dave");
  await D2.joinNoAuth(); // 停在 Login 不登录
  await sleep(6000);
  const preLogin = A.since(ia).join(" | ");
  m = await A.openMenu("/friend");
  const daveEntry = findItem(m, /^Dave/);
  A.close();
  check("Dave 停在登录服没登录：Alice 不会收到上线提醒", !/Dave 上线了/.test(preLogin), preLogin || "没收到");
  check("Dave 停在登录服没登录：好友列表显示离线", !!daveEntry?.lore.some((l) => /离线/.test(l)), daveEntry?.lore.join(" / ") ?? names(m));
  D2.bot.chat("/login DavePass123");
  await sleep(8000);
  const postLogin = A.since(ia).join(" | ");
  check("Dave 登录进入 Spawn 后 Alice 收到上线提醒", /你的好友 Dave 上线了/.test(postLogin), postLogin || "没收到");
  await D2.quit();

  ctx.step = "跨服删除";
  ia = A.mark();
  r = await B.cmd("/friend remove Alice", 2500);
  check("跨服删除：双方同步", /已删除好友 Alice/.test(r) && /Bob 已将你从好友列表中移除/.test(A.since(ia).join()), `${r} || Alice: ${A.since(ia).join(" | ")}`);
  r = await A.cmd("/fm Bob 还在吗", 1500);
  check("跨服删除后 Alice 缓存同步（不能私聊）", /只能给好友发私聊/.test(r), r);

  ctx.step = "跨服拉黑";
  r = await B.cmd("/friend block Alice", 2000);
  r = await A.cmd("/friend add Bob", 2500);
  check("被另一个子服的人拉黑后申请被拒", /对方暂不接受好友申请|已经向 Bob/.test(r), r);
  await B.cmd("/friend unblock Alice", 1500);

  ctx.step = "快速切服";
  ib = A.mark();
  await A.cmd("/friend add Carol", 2000);
  await C.cmd("/friend accept Alice", 2500);
  for (const s of ["FKCS", "Spawn", "FKCS", "Spawn", "FKCS"]) {
    bungee.console(`send Carol ${s}`);
    await sleep(1200);
  }
  await sleep(6000);
  const cNow = await where(C);
  m = await A.openMenu("/friend");
  const carolEntry = findItem(m, /^Carol/);
  A.close();
  check("快速来回切服后，好友列表显示的子服正确", cNow === "FKCS" && !!carolEntry?.lore.some((l) => /在线.*生存一区/.test(l)), `Carol 实际在 ${cNow}，列表：${carolEntry?.lore.join(" / ") ?? names(m)}`);
  const strayOffline = A.since(ib).filter((x) => /Carol 下线了/.test(x));
  check("快速切服不会误发「下线了」", strayOffline.length === 0, strayOffline.join(" | ") || "没有误报");

  ctx.step = "真正下线";
  ia = A.mark();
  await C.quit();
  await sleep(4000);
  check("好友真正离开整个服务器才提示下线", /你的好友 Carol 下线了/.test(A.since(ia).join()), A.since(ia).join(" | ") || "没收到");

  ctx.section = "收尾";
  for (const p of [A, B]) await p.quit();
  bungee.console("end");
  await sleep(3000);
  await Promise.all([spawnSrv.stop(), fkcsSrv.stop(), loginSrv.stop()]);
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过，服务器异常/警告 ${problems.length} 处`);
  writeReport("fkfriends-net");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  writeReport("fkfriends-net");
  process.exit(1);
});
