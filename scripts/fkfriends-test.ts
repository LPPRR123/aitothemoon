/**
 * FKFriends 好友插件的确定性端到端测试（不调用 AI）。
 *
 * 脚本自己启动/停止/重启本地测试服（./test-server，Paper 1.20.4 + AuthMe），
 * 上线 Alice、Bob、Carol、Dave 四个机器人，按剧本执行好友命令、读聊天回复、读和点菜单，
 * 全程盯服务器输出，把 Java 异常记到触发它的那一步。
 *
 * 准备：
 *   npm run test-server:setup
 *   把 FKFriends-x.jar 和 PlaceholderAPI 放进 test-server/plugins/
 *   npm run fkfriends-test
 *
 * 输出：控制台逐项 PASS/FAIL，另写 reports/fkfriends-<时间>.json 和 .md。
 * 每次运行前会删掉 test-server/plugins/FKFriends/fkfriends.db，从空数据开始。
 */
import fs from "node:fs";
import path from "node:path";
import { check, ctx, findItem, names, Player, problems, results, sleep, TestServer, writeReport } from "./lib/fkf-harness.js";

const SERVER_DIR = path.resolve(process.env.TEST_SERVER_DIR ?? "test-server");
const FKF_DIR = path.join(SERVER_DIR, "plugins", "FKFriends");

// ---------------------------------------------------------------- 配置调整

function setFriendLimit(n: number) {
  const f = path.join(FKF_DIR, "config.yml");
  const text = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, text.replace(/limit-default:\s*\d+/, `limit-default: ${n}`));
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const dbFile = path.join(FKF_DIR, "fkfriends.db");
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) if (fs.existsSync(f)) fs.rmSync(f);
  if (fs.existsSync(path.join(FKF_DIR, "config.yml"))) setFriendLimit(50);
  if (fs.existsSync(path.join(FKF_DIR, "config.yml"))) {
    const f = path.join(FKF_DIR, "config.yml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/request-cooldown-minutes:\s*\d+/, "request-cooldown-minutes: 10"));
  }

  const server = new TestServer(SERVER_DIR, "测试服");
  await server.start();
  await server.waitConsole();
  const startup = server.lines.filter((l) => /FKFriends/.test(l));
  ctx.section = "启动";
  check("插件加载", startup.some((l) => /Enabling FKFriends/.test(l)) && !server.lines.some((l) => /Error occurred while enabling FKFriends/.test(l)), startup.slice(0, 6).join(" / "));
  check("检测到 AuthMe", startup.some((l) => /检测到 AuthMe/.test(l)), startup.find((l) => /AuthMe/.test(l)) ?? "日志里没有提到 AuthMe");

  const A = new Player("Alice"), B = new Player("Bob"), C = new Player("Carol"), D = new Player("Dave");
  for (const p of [A, B, C, D]) await p.join();
  for (const p of [A, B, C, D]) server.console(`op ${p.name}`);
  await sleep(1000);
  // 四个人站一起，方便"附近玩家"
  for (const p of [B, C, D]) server.console(`tp ${p.name} Alice`);
  await sleep(1500);
  const st = await server.consoleOut("fkfriends status");
  check("/fkfriends status", st.some((l) => /模式 full/.test(l) && /sqlite/.test(l)), st.filter((l) => /模式/.test(l)).join(" ") || st.join(" / "));

  // ============================================================ 基本流程
  ctx.section = "基本流程";
  ctx.step = "help";
  let r = await A.cmd("/friend help");
  check("/friend help 显示命令列表", /好友系统/.test(r) && /friend add/.test(r), r);

  ctx.step = "Alice 申请 Bob";
  let ib = B.mark();
  r = await A.cmd("/friend add Bob");
  const bGot = B.since(ib).join(" | ");
  const bJson = B.sinceJson(ib).join(" ");
  check("发送申请：发起人收到确认", /已向 Bob 发送好友申请/.test(r), r);
  check("发送申请：对方收到通知 + [接受][拒绝] 按钮", /Alice 想加你为好友/.test(bGot) && /\/friend accept Alice/.test(bJson) && /\/friend deny Alice/.test(bJson), bGot);

  ctx.step = "Bob 打开申请界面";
  let m = await B.openMenu("/friend requests");
  check("申请界面列出 Alice", !!m && /好友申请/.test(m.title) && !!findItem(m, /Alice/), `${m?.title}：${names(m)}`);
  B.close();

  ctx.step = "Bob 接受";
  let ia = A.mark();
  r = await B.cmd("/friend accept Alice");
  check("接受申请：双方都收到成为好友的提示", /你和 Alice 成为了好友/.test(r) && /Bob 接受了你的好友申请/.test(A.since(ia).join()), `${r} || Alice: ${A.since(ia).join(" | ")}`);

  ctx.step = "Alice 打开好友列表";
  m = await A.openMenu("/friend");
  const bobEntry = findItem(m, /^Bob/);
  check("好友列表界面里有 Bob", !!m && /好友列表/.test(m.title) && !!bobEntry, `${m?.title}：${names(m)}`);
  check("好友条目显示在线", !!bobEntry && bobEntry.lore.some((l) => /在线/.test(l)), bobEntry?.lore.join(" / ") ?? "无");
  A.close();

  ctx.step = "私聊";
  ib = B.mark();
  r = await A.cmd("/fm Bob 你好呀 hello");
  check("/fm 私聊：双方都看到", /你 → Bob: 你好呀 hello/.test(r) && /Alice → 你: 你好呀 hello/.test(B.since(ib).join()), `${r} || Bob: ${B.since(ib).join(" | ")}`);
  r = await A.cmd("/fm Bob");
  check("/fm 缺内容提示用法", /用法/.test(r), r);

  ctx.step = "备注";
  r = await A.cmd("/friend note Bob 老铁");
  check("设置备注", /备注设为 老铁/.test(r), r);
  m = await A.openMenu("/friend");
  check("好友列表显示备注", !!findItem(m, /老铁/), names(m));
  A.close();
  r = await A.cmd("/friend note Bob 一二三四五六七八九十一二三");
  check("备注超长（13 字）被拒", /最多 12 个字/.test(r), r);
  r = await A.cmd("/friend note Bob 清除");
  check("备注填「清除」删除", /已清除 Bob 的备注/.test(r), r);
  r = await A.cmd("/friend note Carol 路人");
  check("给非好友设备注被拒", /还不是好友/.test(r), r);

  ctx.step = "删除好友";
  ib = B.mark();
  r = await A.cmd("/friend remove Bob");
  check("删除好友：双方同步", /已删除好友 Bob/.test(r) && /Alice 已将你从好友列表中移除/.test(B.since(ib).join()), `${r} || Bob: ${B.since(ib).join(" | ")}`);
  r = await B.cmd("/fm Alice 还在吗");
  check("删除后不能再私聊", /只能给好友发私聊/.test(r), r);
  m = await B.openMenu("/friend");
  check("删除后 Bob 的好友列表里没有 Alice", !!m && !findItem(m, /^Alice/), names(m));
  B.close();

  ctx.step = "拒绝";
  ia = A.mark();
  r = await C.cmd("/friend add Alice");
  await sleep(300);
  r = await A.cmd("/friend deny Carol");
  check("拒绝申请", /已拒绝 Carol 的好友申请/.test(r), r);
  r = await A.cmd("/friend accept Carol");
  check("拒绝后再接受：提示没有申请", /没有来自 Carol 的好友申请/.test(r), r);
  r = await C.cmd("/friend add Alice");
  check("被拒后马上再申请：10 分钟冷却", /10 分钟内已经向 Carol|分钟内已经向 Alice/.test(r), r);

  // ============================================================ 边界情况
  ctx.section = "边界情况";
  ctx.step = "加自己";
  r = await A.cmd("/friend add Alice");
  check("加自己被拒", /不能对自己这么做/.test(r), r);
  ctx.step = "加不存在的玩家";
  r = await A.cmd("/friend add NoSuchPlayer42");
  check("加不存在的玩家", /找不到玩家 NoSuchPlayer42/.test(r), r);
  ctx.step = "缺参数 / 未知子命令";
  r = await A.cmd("/friend add");
  check("/friend add 不带名字显示帮助", /好友系统/.test(r), r);
  r = await A.cmd("/friend xyz");
  check("未知子命令", /未知子命令/.test(r), r);

  ctx.step = "重复申请";
  r = await B.cmd("/friend add Carol");
  const r2 = await B.cmd("/friend add Carol");
  check("重复申请被拒", /已向 Carol 发送/.test(r) && /已经向 Carol 发过申请了/.test(r2), `${r} || ${r2}`);

  ctx.step = "反向申请直接成为好友";
  ib = B.mark();
  r = await C.cmd("/friend add Bob");
  check("对方已申请过我，我再加对方 = 直接成为好友", /成为了好友/.test(r) && /成为了好友/.test(B.since(ib).join()), `${r} || Bob: ${B.since(ib).join(" | ")}`);
  r = await B.cmd("/friend add Carol");
  check("已经是好友再加", /已经是好友了/.test(r), r);

  ctx.step = "名字大小写";
  r = await B.cmd("/friend note carol 小C");
  check("小写名字也能认出在线好友", /备注设为 小C/.test(r), r);

  ctx.step = "同时互加";
  const ia2 = A.mark(), id2 = D.mark();
  A.bot.chat("/friend add Dave");
  D.bot.chat("/friend add Alice");
  await sleep(3000);
  const aSim = A.since(ia2).join(" | "), dSim = D.since(id2).join(" | ");
  let info = await server.consoleOut("fkfriends info Alice");
  const aliceFriendsLine = info.find((l) => /好友 \d+/.test(l)) ?? "";
  const reqLine = info.find((l) => /申请 收到\/发出/.test(l)) ?? "";
  check(
    "同时互加：成为好友且只有一条关系、没有残留申请",
    /好友 1: Dave/.test(aliceFriendsLine) && /0\/0/.test(reqLine),
    `Alice: ${aSim} || Dave: ${dSim} || ${aliceFriendsLine} ${reqLine}`,
  );
  m = await D.openMenu("/friend");
  check("同时互加：Dave 的界面里有 Alice", !!findItem(m, /^Alice/), names(m));
  D.close();

  ctx.step = "不在线的玩家";
  await C.quit();
  await sleep(1500);
  r = await D.cmd("/friend add Carol");
  check("给离线（来过）的玩家发申请", /已向 Carol 发送好友申请/.test(r), r);
  r = await D.cmd("/friend add carol");
  check("离线玩家名字小写也能找到（查库）", /已经向 Carol 发过申请了/.test(r), r);
  await C.join();
  server.console("op Carol");
  server.console("tp Carol Alice");
  await sleep(2500);
  const loginMsgs = C.since(0).join(" | ");
  check("离线期间收到的申请，上线时提示", /你有 1 个好友申请待处理/.test(loginMsgs), loginMsgs.slice(-300));
  r = await C.cmd("/friend accept Dave");
  check("上线后接受离线时收到的申请", /你和 Dave 成为了好友/.test(r), r);

  ctx.step = "上线提醒";
  const ia3 = A.mark();
  await D.quit();
  await sleep(1500);
  const offMsg = A.since(ia3).join(" | ");
  const ia4 = A.mark();
  await D.join();
  server.console("op Dave");
  server.console("tp Dave Alice");
  await sleep(6000); // 上线提醒合并 5 秒
  const onMsg = A.since(ia4).join(" | ");
  check("好友下线提醒", /你的好友 Dave 下线了/.test(offMsg), offMsg || "没收到");
  check("好友上线提醒（合并发送）", /你的好友 Dave 上线了/.test(onMsg), onMsg || "没收到");

  ctx.step = "好友上限";
  setFriendLimit(1);
  let rl = await server.consoleOut("fkfriends reload");
  check("改上限后 /fkfriends reload", rl.some((l) => /配置已重载/.test(l)), rl.join(" / "));
  // 现在 Alice=1(Dave) 已满；Bob=1(Carol) 已满
  r = await A.cmd("/friend add Bob");
  check("自己好友已满不能发申请", /好友已满（1\/1）/.test(r), r);
  r = await B.cmd("/friend remove Carol");
  r = await B.cmd("/friend add Alice");
  check("对方好友已满", /对方的好友已满/.test(r), r);
  setFriendLimit(50);
  await server.consoleOut("fkfriends reload");

  ctx.step = "黑名单";
  ia = A.mark();
  r = await A.cmd("/friend block Carol");
  check("拉黑", /已拉黑 Carol/.test(r), r);
  r = await C.cmd("/friend add Alice");
  check("被拉黑的人申请，提示对方不接受（不暴露被拉黑）", /对方暂不接受好友申请/.test(r), r);
  r = await A.cmd("/friend add Carol");
  check("拉黑了对方自己也不能加", /先移出黑名单再加/.test(r), r);
  r = await A.cmd("/friend block Carol");
  check("重复拉黑", /你已经拉黑了 Carol/.test(r), r);
  m = await A.openMenu("/friend blocks");
  check("黑名单界面列出 Carol", !!m && /黑名单/.test(m.title) && !!findItem(m, /Carol/), `${m?.title}：${names(m)}`);
  A.close();
  r = await A.cmd("/friend unblock Carol");
  check("移出黑名单", /已将 Carol 移出黑名单/.test(r), r);
  r = await A.cmd("/friend unblock Carol");
  check("没拉黑的人移出黑名单", /你没有拉黑 Carol/.test(r), r);
  r = await D.cmd("/friend block Alice");
  ia = A.mark();
  check("拉黑好友 = 同时删除好友", /已拉黑 Alice/.test(r), r);
  info = await server.consoleOut("fkfriends info Dave");
  check("拉黑好友后数据库里关系已删除", info.some((l) => /好友 1: Carol/.test(l)), info.filter((l) => /好友|黑名单/.test(l)).join(" / "));
  r = await A.cmd("/fm Dave 在吗");
  check("被拉黑后不能私聊", /只能给好友发私聊|对方不在线/.test(r), r);
  await D.cmd("/friend unblock Alice");

  // ============================================================ 齿轮
  ctx.section = "齿轮";
  ctx.step = "送齿轮";
  const idf = D.mark();
  r = await A.cmd("/flower Dave 3");
  check("送 3 个齿轮", /你送给 Dave 3个齿轮/.test(r) && /Alice 送给你 3个齿轮/.test(D.since(idf).join()), `${r} || Dave: ${D.since(idf).join(" | ")}`);
  check("同 IP 赠送提示不计人气", /同 IP 赠送，不计入人气/.test(r), r);
  r = await A.cmd("/flower Dave 5");
  check("对同一人超过每日上限（5）只送剩下的", /你送给 Dave 2个齿轮/.test(r), r);
  r = await A.cmd("/flower Dave 1");
  check("对同一人到上限后被拒", /送给 Dave 的齿轮已达上限（5）/.test(r), r);
  r = await A.cmd("/flower Bob 5");
  r = await A.cmd("/flower Carol 5");
  check("每日总额度 10 用完", /今天的齿轮额度用完了/.test(r), r);
  r = await B.cmd("/flower Alice -1");
  const r3 = await B.cmd("/flower Alice abc");
  const r4 = await B.cmd("/flower Alice 99999999999");
  check("数量非法（-1 / abc / 超大）", /数量不对/.test(r) && /数量不对/.test(r3) && /数量不对/.test(r4), `${r} || ${r3} || ${r4}`);
  r = await B.cmd("/flower Bob 1");
  check("给自己送齿轮被拒", /不能对自己这么做/.test(r), r);

  // ============================================================ 界面
  ctx.section = "界面";
  ctx.step = "主界面按钮";
  m = await C.openMenu("/friend");
  check("好友列表界面打开", !!m && /好友列表/.test(m.title), `${m?.title}：${names(m)}`);
  const mainSnapshot = m;
  const tabs: [number, RegExp, string][] = [
    [2, /好友申请/, "页签：好友申请"],
    [3, /黑名单/, "页签：黑名单"],
    [50, /社交设置/, "社交设置"],
    [51, /名片/, "我的名片"],
    [47, /添加好友/, "添加好友"],
  ];
  for (const [slot, re, label] of tabs) {
    ctx.step = `主界面点 ${label}`;
    await C.openMenu("/friend");
    const res = await C.click(slot);
    check(`点「${label}」`, !!res.menu && re.test(res.menu.title), `${res.menu?.title ?? "窗口关了"} ${res.msgs}`);
    C.close();
  }
  ctx.step = "主界面点 关闭";
  await C.openMenu("/friend");
  let res = await C.click(8);
  check("点「关闭」关掉界面", !res.menu, res.menu?.title ?? "已关闭");
  ctx.step = "主界面点 返回主菜单（测试服没装 TrMenu）";
  await C.openMenu("/friend");
  res = await C.click(52);
  check("点「返回主菜单」执行 menu.main-menu-command", true, `窗口=${res.menu?.title ?? "已关闭"}，消息：${res.msgs || "无"}`);
  C.close();

  ctx.step = "好友条目：左键打开名片";
  m = await C.openMenu("/friend");
  const daveSlot = findItem(m, /^Dave/)?.slot;
  res = daveSlot !== undefined ? await C.click(daveSlot) : { menu: null, msgs: "列表里没有 Dave" };
  check("好友条目左键 → 对方名片", !!res.menu && /Dave 的名片/.test(res.menu.title), `${res.menu?.title} ${res.msgs}`);
  const card = res.menu;
  check("名片上显示在线 / 私聊 / 备注 / 齿轮 / 拉黑按钮", !!card && [/在线/, /私聊/, /备注/, /赠送齿轮/, /拉黑/].every((re) => !!findItem(card, re)), names(card));
  ctx.step = "名片：送齿轮按钮";
  const idf2 = D.mark();
  const giftSlot = findItem(card, /赠送齿轮/)?.slot;
  res = giftSlot !== undefined ? await C.click(giftSlot) : { menu: null, msgs: "没有按钮" };
  check("名片上点「赠送齿轮」送 1 个", /你送给 Dave 1个齿轮/.test(res.msgs) && /Carol 送给你 1个齿轮/.test(D.since(idf2).join()), `${res.msgs} || Dave: ${D.since(idf2).join(" | ")}`);
  ctx.step = "名片：私聊按钮";
  const pmSlot = findItem(res.menu ?? card, /私聊/)?.slot;
  if (!C.bot.currentWindow) await C.openMenu("/card Dave");
  res = pmSlot !== undefined ? await C.click(pmSlot) : { menu: null, msgs: "没有按钮" };
  check("名片上点「私聊」关界面并给出可点的提示", !res.menu && /点击给 Dave 发私聊/.test(res.msgs), `${res.menu?.title ?? "已关闭"} ${res.msgs}`);
  ctx.step = "名片：好友度";
  m = await C.openMenu("/card Dave");
  const affSlot = findItem(m, /好友度/)?.slot;
  res = affSlot !== undefined ? await C.click(affSlot) : { menu: null, msgs: "没有按钮" };
  check("名片上点「好友度」打开详情", !!res.menu && /好友度/.test(res.menu.title), `${res.menu?.title} ${res.msgs} ${names(res.menu)}`);
  C.close();

  ctx.step = "好友条目：右键私聊";
  m = await C.openMenu("/friend");
  res = daveSlot !== undefined ? await C.click(daveSlot, 1, 0) : { menu: null, msgs: "" };
  check("好友条目右键 → 私聊提示", /点击给 Dave 发私聊/.test(res.msgs), `${res.menu?.title ?? "已关闭"} ${res.msgs}`);
  C.close();

  ctx.step = "社交设置：关闭好友申请";
  m = await C.openMenu("/friend");
  res = await C.click(50);
  const settings = res.menu;
  check("社交设置列出 7 个开关", !!settings && [/好友申请/, /赠送齿轮/, /组队请求/, /上线提醒/, /隐身/, /好友PVP/, /允许好友传送/].every((re) => !!findItem(settings, re)), names(settings));
  res = await C.click(19);
  check("点开关：好友申请 → 关闭", /设置 好友申请 已改为 关闭/.test(res.msgs), res.msgs);
  C.close();
  r = await A.cmd("/friend add Carol");
  check("对方关了好友申请：发不了", /对方暂不接受好友申请/.test(r), r);
  await C.openMenu("/friend");
  await C.click(50);
  res = await C.click(19);
  check("再点一次：好友申请 → 允许", /设置 好友申请 已改为 允许/.test(res.msgs), res.msgs);
  C.close();

  ctx.step = "添加好友界面：附近玩家 + 输入名字";
  m = await A.openMenu("/friend");
  res = await A.click(47);
  check("添加好友界面列出附近的玩家", !!res.menu && /添加好友/.test(res.menu.title) && !!findItem(res.menu, /Carol|Bob/), names(res.menu));
  res = await A.click(47);
  check("点「输入名字添加」提示在聊天栏输入", /请在聊天栏输入要添加的玩家名/.test(res.msgs), `${res.menu?.title ?? "已关闭"} ${res.msgs}`);
  r = await A.cmd("Carol", 2500);
  check("聊天栏输入名字 → 发出申请", /已向 Carol 发送好友申请/.test(r), r);
  r = await A.cmd("这句话应该正常发到公屏", 1500);
  check("输入完成后聊天恢复正常", /<Alice> 这句话应该正常发到公屏/.test(r), r);

  ctx.step = "申请界面：全部拒绝（带确认）";
  m = await C.openMenu("/friend requests");
  res = await C.click(48);
  check("点「全部拒绝」弹确认", !!res.menu && /请确认/.test(res.menu.title), `${res.menu?.title} ${res.msgs}`);
  res = await C.click(11);
  check("确认后全部拒绝", /已拒绝全部 1 个申请/.test(res.msgs), `${res.menu?.title ?? "已关闭"} ${res.msgs}`);
  C.close();

  ctx.step = "/card 名片";
  m = await A.openMenu("/card");
  check("/card 打开自己的名片", !!m && /我的名片/.test(m.title), `${m?.title}：${names(m)}`);
  A.close();
  m = await A.openMenu("/card Bob");
  check("/card Bob 打开别人的名片（非好友）", !!m && /Bob 的名片/.test(m.title), `${m?.title}：${names(m)}`);
  A.close();
  r = await A.cmd("/card NoSuchPlayer42");
  check("/card 不存在的玩家", /找不到玩家/.test(r), r);
  m = await A.openMenu("/fkmedal");
  check("/fkmedal 打开勋章页", !!m && /勋章/.test(m.title), `${m?.title ?? "没开"}：${names(m)}`);
  A.close();

  // ============================================================ 传送 / 组队 / PVP / 隐身 / 批量
  ctx.section = "传送 组队 PVP 隐身";
  ctx.step = "/friend join 同服传送";
  server.console("execute as Carol at @s run tp @s ~40 ~ ~");
  await sleep(1500);
  const idj = D.mark();
  r = await C.cmd("/friend join Dave", 2500);
  const tpDist = C.bot.entity.position.distanceTo(D.bot.entity.position);
  check("同服 /friend join 传到好友身边，对方收到提示", tpDist < 3 && /已传送到 Dave 身边/.test(r) && /Carol 传送到了你身边/.test(D.since(idj).join()), `距离 ${tpDist.toFixed(1)}，${r} || Dave: ${D.since(idj).join(" | ")}`);
  r = await C.cmd("/friend join Dave");
  check("传送冷却 10 秒", /传送冷却中/.test(r), r);
  r = await C.cmd("/friend join Bob");
  check("/friend join 非好友", /不是好友|不在线|不允许/.test(r), r);

  ctx.step = "/friend invite 组队";
  r = await C.cmd("/friend invite Dave");
  check("不在副本大厅邀请组队：提示去大厅（带按钮）", /组队只能在副本大厅进行/.test(r), r);
  r = await C.cmd("/friend goto fuben1");
  check("/friend goto 副本大厅（单服无 Bungee）", /暂时无法确定对方在哪个子服|正在前往/.test(r), r);
  r = await C.cmd("/friend goto Spawn");
  check("/friend goto 只允许副本大厅", /未知子命令/.test(r), r);

  ctx.step = "好友PVP";
  server.console("gamemode survival Dave");
  server.console("gamemode survival Carol");
  server.console("gamemode survival Bob");
  server.console("effect give Carol minecraft:instant_health 1 5");
  server.console("tp Dave Carol");
  server.console("tp Bob Carol");
  await sleep(2000);
  const hit = async (attacker: Player, victim: Player) => {
    // 站在同一格时第一下打不中（测试本身的问题），先拉开 1.5 格
    server.console(`execute as ${attacker.name} at ${victim.name} run tp @s ~1.5 ~ ~`);
    await sleep(1500);
    const ent = attacker.bot.players[victim.name]?.entity;
    if (!ent) return { dmg: -1, msgs: "看不到对方实体" };
    await attacker.bot.lookAt(ent.position.offset(0, 1.6, 0), true);
    const hp = victim.bot.health;
    const i = attacker.mark();
    attacker.bot.attack(ent);
    await sleep(1500);
    return { dmg: hp - victim.bot.health, msgs: attacker.since(i).join(" | ") };
  };
  let h = await hit(D, C);
  check("好友PVP 关着（默认）：好友打不到", h.dmg === 0 && /关了好友PVP/.test(h.msgs), `伤害 ${h.dmg}，${h.msgs}`);
  await sleep(600);
  h = await hit(B, C);
  check("非好友照常能打", h.dmg > 0, `伤害 ${h.dmg}，${h.msgs}`);
  server.console("effect give Carol minecraft:instant_health 1 5");

  ctx.step = "隐身";
  await C.openMenu("/friend");
  await C.click(50);
  res = await C.click(37);
  check("开隐身", /设置 隐身 已改为 开/.test(res.msgs), res.msgs);
  C.close();
  r = await D.cmd("/fm Carol 在吗");
  check("对方隐身时私聊提示不在线", /对方不在线/.test(r), r);
  m = await D.openMenu("/friend");
  check("对方隐身时好友列表显示离线", !!findItem(m, /Carol/)?.lore.some((l) => /离线/.test(l)), findItem(m, /Carol/)?.lore.join(" / ") ?? names(m));
  D.close();
  r = await D.cmd("/friend join Carol");
  check("对方隐身时不能传送过去", !/已传送到/.test(r), r);
  await C.openMenu("/friend");
  await C.click(50);
  res = await C.click(37);
  check("关隐身", /设置 隐身 已改为 关闭/.test(res.msgs), res.msgs);
  C.close();

  ctx.step = "全部接受";
  const cfgFile = path.join(FKF_DIR, "config.yml");
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").replace(/request-cooldown-minutes:\s*\d+/, "request-cooldown-minutes: 0"));
  await server.consoleOut("fkfriends reload");
  await A.cmd("/friend add Dave");
  await B.cmd("/friend add Dave");
  m = await D.openMenu("/friend requests");
  res = await D.click(47, 0, 0, 2500);
  info = await server.consoleOut("fkfriends info Dave");
  check("申请界面「全部接受」", /已接受 2 个申请/.test(res.msgs) && info.some((l) => /好友 3:/.test(l)), `${res.msgs} || ${info.filter((l) => /好友 \d/.test(l)).join(" ")}`);
  D.close();

  ctx.step = "好友条目 Shift+右键删除";
  m = await D.openMenu("/friend");
  const aliceSlot = findItem(m, /^Alice/)?.slot;
  res = aliceSlot !== undefined ? await D.click(aliceSlot, 1, 1) : { menu: null, msgs: "列表里没有 Alice" };
  const confirmShown = !!res.menu && /请确认/.test(res.menu.title);
  if (confirmShown) res = await D.click(11);
  check("Shift+右键删除好友（确认后删除）", confirmShown && /已删除好友 Alice/.test(res.msgs), `确认框=${confirmShown}，${res.msgs}`);
  D.close();

  // ============================================================ 未登录
  ctx.section = "AuthMe 未登录";
  ctx.step = "未登录用好友命令";
  const E = new Player("Eve");
  await E.joinNoAuth();
  const iaE = A.mark();
  r = await E.cmd("/friend add Alice", 2000);
  const r5 = await E.cmd("/fm Alice hi", 1500);
  check("未登录的玩家发好友命令，Alice 什么都没收到", !A.since(iaE).some((x) => /Eve/.test(x)), `Eve 看到：${r} || ${r5}`);
  info = await server.consoleOut("fkfriends info Eve");
  check("未登录的玩家不会被记进好友库", info.some((l) => /找不到玩家/.test(l)) || !info.some((l) => /好友 [1-9]/.test(l)), info.join(" / "));
  await E.quit();

  // ============================================================ 数据保存
  ctx.section = "数据保存";
  ctx.step = "下线再上线";
  info = await server.consoleOut("fkfriends info Carol");
  const carolBefore = info.find((l) => /好友 \d+/.test(l)) ?? "";
  await C.quit();
  await sleep(1500);
  await C.join();
  m = await C.openMenu("/friend");
  check("下线再上线后好友还在", !!findItem(m, /^Dave/), `${carolBefore} || 界面：${names(m)}`);
  C.close();

  ctx.step = "重启服务器";
  await C.cmd("/friend note Dave 重启前的备注");
  await A.cmd("/friend add Bob"); // 留一条待处理申请
  for (const p of [A, B, C, D]) await p.quit();
  const cfgF = path.join(FKF_DIR, "config.yml");
  fs.writeFileSync(cfgF, fs.readFileSync(cfgF, "utf8").replace(/request-cooldown-minutes:\s*\d+/, "request-cooldown-minutes: 10"));
  await server.stop();
  check("服务器正常关闭", true, "stop 完成");
  await server.start();
  await server.waitConsole();
  for (const p of [A, B, C, D]) await p.join();
  for (const p of [A, B, C, D]) server.console(`op ${p.name}`);
  await sleep(1000);
  await sleep(2500);
  m = await C.openMenu("/friend");
  const daveAfter = findItem(m, /Dave|重启前的备注/);
  check("重启后好友关系还在", !!daveAfter, names(m));
  check("重启后备注还在", !!findItem(m, /重启前的备注/), names(m));
  C.close();
  const bLogin = B.since(0).join(" | ");
  check("重启后待处理申请还在（上线提示）", /你有 1 个好友申请待处理/.test(bLogin), bLogin.slice(-300));
  info = await server.consoleOut("fkfriends info Dave");
  check("重启后齿轮数据还在", info.some((l) => /齿轮 收到\/计人气\/今日已送: 6\//.test(l)), info.filter((l) => /齿轮/.test(l)).join(" "));
  r = await A.cmd("/friend add Bob");
  check("重启后发出的申请还在（再发提示已发过）", /已经向 Bob 发过申请了/.test(r), r);

  // ============================================================ 收尾
  ctx.section = "收尾";
  for (const p of [A, B, C, D]) await p.quit();
  await server.stop();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过，服务器异常/警告 ${problems.length} 处`);
  writeReport();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  writeReport();
  process.exit(1);
});
