/**
 * FKFriends 端到端测试共用的部分：启动/停止服务器进程、玩家机器人、结果记录、写报告。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { AuthMeSession } from "../../src/bot/authme.js";
import { describeItem } from "../../src/bot/perception.js";
import { componentToText, stripColors } from "../../src/bot/text.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// ---------------------------------------------------------------- 结果记录

export interface Result {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
export interface Problem {
  step: string;
  time: string;
  lines: string[];
}
export const results: Result[] = [];
export const problems: Problem[] = [];
/** 当前在测哪一段、哪一步：服务器异常会记到这里 */
export const ctx = { section: "启动", step: "启动服务器" };

export function check(name: string, ok: boolean, detail: string) {
  results.push({ section: ctx.section, name, ok, detail: detail.replace(/\s+/g, " ").slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${ctx.section}] ${name}  —  ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
}

// ---------------------------------------------------------------- 服务器

export class TestServer {
  constructor(
    readonly dir: string,
    readonly label = path.basename(dir),
    readonly args = ["-Xmx2G", "-Dterminal.jline=false", "-Dterminal.ansi=false", "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-jar", "paper.jar", "--nogui"],
    readonly readyRe = /Done \([\d.]+s\)!/,
  ) {}

  proc: ChildProcessWithoutNullStreams | null = null;
  lines: string[] = [];
  private partial = "";
  private open: Problem | null = null;
  private openTimer: NodeJS.Timeout | null = null;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("java", this.args, { cwd: this.dir });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error(`${this.label} 180 秒内没有启动完成`)), 180_000);
      const onData = (buf: Buffer) => {
        this.partial += buf.toString("utf8");
        const parts = this.partial.split(/\r?\n/);
        this.partial = parts.pop() ?? "";
        for (const raw of parts) {
          const line = stripAnsi(raw);
          this.lines.push(line);
          this.watch(line);
          if (this.readyRe.test(line)) {
            clearTimeout(timer);
            resolve();
          }
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        this.proc = null;
        if (code !== 0 && code !== null) console.log(`服务器退出，代码 ${code}`);
      });
    });
  }

  /** 把异常、FKFriends 的 WARN/ERROR 记到当前这一步 */
  private watch(line: string) {
    const isStack = /^\s+at |^\s*\.\.\. \d+ more|^Caused by:/.test(line);
    const isStart =
      /Exception|Error:/.test(line) && !/Done \(/.test(line) ||
      /(WARN|ERROR)\]: \[FKFriends\]/.test(line) ||
      /ERROR\]:/.test(line);
    if (isStart || (isStack && this.open)) {
      if (!this.open) {
        this.open = { step: `${ctx.section} / ${ctx.step}（${this.label}）`, time: new Date().toISOString(), lines: [] };
        problems.push(this.open);
      }
      if (this.open.lines.length < 80) this.open.lines.push(line);
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = setTimeout(() => (this.open = null), 300);
    }
  }

  console(cmd: string) {
    this.proc?.stdin.write(cmd + "\n");
  }

  /** 控制台输入线程起来前发的命令会丢：反复发 list 直到有回应 */
  async waitConsole(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const out = await this.consoleOut("list", 1000);
      if (out.some((l) => /There are \d+ of a max/.test(l))) return;
    }
    throw new Error("服务器控制台 30 秒内没有回应");
  }

  /** 发控制台命令，收集之后 waitMs 内的输出 */
  async consoleOut(cmd: string, waitMs = 1500): Promise<string[]> {
    const from = this.lines.length;
    this.console(cmd);
    await sleep(waitMs);
    return this.lines.slice(from);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const p = this.proc;
      const t = setTimeout(() => {
        p.kill();
        resolve();
      }, 60_000);
      p.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      this.console("stop");
    });
  }
}

// ---------------------------------------------------------------- 玩家机器人

export interface Msg {
  text: string;
  json: string;
}
export interface MenuItem {
  slot: number;
  name: string;
  lore: string[];
}
export interface Menu {
  title: string;
  items: MenuItem[];
}

export class Player {
  bot!: Bot;
  msgs: Msg[] = [];
  kicked: string | null = null;
  constructor(
    readonly name: string,
    readonly host = "127.0.0.1",
    readonly port = Number(process.env.MC_PORT ?? 25565),
  ) {}

  join(): Promise<void> {
    this.msgs = [];
    this.kicked = null;
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({ host: this.host, port: this.port, version: "1.20.4", username: this.name, auth: "offline" });
      this.bot = bot;
      const timer = setTimeout(() => reject(new Error(`${this.name} 30 秒内没有登录成功`)), 30_000);
      const auth = new AuthMeSession({
        password: `${this.name}Pass123`,
        autoRegister: true,
        maxAttempts: 3,
        sendCommand: (c) => bot.chat(c),
        onLoggedIn: () => {
          clearTimeout(timer);
          // FKFriends 每秒检查一次 AuthMe 登录状态，再异步加载数据
          setTimeout(resolve, 2500);
        },
        onGiveUp: (r) => reject(new Error(`${this.name}: ${r}`)),
      });
      bot.on("message", (json, position) => {
        if (position === "game_info") return;
        const text = stripColors(json.toString());
        this.msgs.push({ text, json: JSON.stringify(json.json) });
        auth.handle(text);
      });
      bot.on("kicked", (r) => {
        this.kicked = componentToText(bot, r) || String(r);
      });
      bot.once("error", (e) => reject(e));
    });
  }

  /** 加入但不登录 AuthMe（测未登录时的行为） */
  joinNoAuth(): Promise<void> {
    this.msgs = [];
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({ host: this.host, port: this.port, version: "1.20.4", username: this.name, auth: "offline" });
      this.bot = bot;
      bot.on("message", (json, position) => {
        if (position === "game_info") return;
        this.msgs.push({ text: stripColors(json.toString()), json: JSON.stringify(json.json) });
      });
      bot.once("spawn", () => {
        setTimeout(resolve, 2000);
      });
      bot.once("error", reject);
    });
  }

  quit(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.bot?.player) return resolve();
      this.bot.once("end", () => resolve());
      this.bot.quit();
      setTimeout(resolve, 3000);
    });
  }

  mark() {
    return this.msgs.length;
  }
  since(i: number): string[] {
    return this.msgs.slice(i).map((m) => m.text);
  }
  sinceJson(i: number): string[] {
    return this.msgs.slice(i).map((m) => m.json);
  }

  /** 发一条命令/聊天，等 waitMs，返回这期间自己收到的消息 */
  async cmd(text: string, waitMs = 1800): Promise<string> {
    const i = this.mark();
    this.bot.chat(text);
    await sleep(waitMs);
    return this.since(i).join(" | ");
  }

  menu(): Menu | null {
    const win = this.bot.currentWindow;
    if (!win) return null;
    const items: MenuItem[] = [];
    for (let slot = 0; slot < win.inventoryStart; slot++) {
      const it = win.slots[slot];
      if (!it) continue;
      const d = describeItem(this.bot, it);
      if (d.name.trim() === "" && it.name.endsWith("glass_pane")) continue; // 背景板
      items.push({ slot, name: d.name, lore: d.lore });
    }
    return { title: componentToText(this.bot, win.title) || String(win.type), items };
  }

  /** 执行命令并等菜单打开 */
  async openMenu(command: string, timeoutMs = 5000): Promise<Menu | null> {
    if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow);
    const opened = new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), timeoutMs);
      this.bot.once("windowOpen", () => {
        clearTimeout(t);
        r(true);
      });
    });
    this.bot.chat(command);
    if (!(await opened)) return null;
    await sleep(700); // 等窗口内容包
    return this.menu();
  }

  /** 点菜单格子；mode 0=普通，1=Shift；button 0=左 1=右。返回点完后的菜单（可能是新窗口或已关闭）和消息 */
  async click(slot: number, button = 0, mode = 0, waitMs = 1500): Promise<{ menu: Menu | null; msgs: string }> {
    const i = this.mark();
    const win = this.bot.currentWindow;
    if (!win) return { menu: null, msgs: "（没有打开的窗口）" };
    await this.bot.clickWindow(slot, button, mode).catch(() => {});
    await sleep(waitMs);
    return { menu: this.menu(), msgs: this.since(i).join(" | ") };
  }

  close() {
    if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow);
  }
}

export const findItem = (m: Menu | null, re: RegExp) => m?.items.find((x) => re.test(x.name));
export const names = (m: Menu | null) => (m ? m.items.map((x) => `${x.slot}:${x.name}`).join(", ") : "（没开）");


export function writeReport(prefix = "fkfriends") {
  fs.mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join("reports", `${prefix}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ results, problems }, null, 2));
  const md: string[] = [`# ${prefix} 自动测试结果 ${stamp}`, "", `${results.filter((r) => r.ok).length}/${results.length} 通过，服务器异常/警告 ${problems.length} 处`, ""];
  let sec = "";
  for (const r of results) {
    if (r.section !== sec) {
      sec = r.section;
      md.push("", `## ${sec}`, "", "| 结果 | 项目 | 实际 |", "|---|---|---|");
    }
    md.push(`| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.detail.replace(/\|/g, "／")} |`);
  }
  md.push("", "## 服务器异常 / 警告", "");
  if (!problems.length) md.push("无");
  for (const p of problems) md.push(`### ${p.step}`, "", "```", ...p.lines, "```", "");
  fs.writeFileSync(`${base}.md`, md.join("\n"));
  console.log(`报告：${base}.md`);
}

