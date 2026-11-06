import { EventEmitter } from "node:events";
import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import collectBlockPkg from "mineflayer-collectblock";
import type { Config, Secrets } from "../config.js";
import { createLogger } from "../logger.js";
import { AuthMeSession, classifyAuthMessage } from "./authme.js";
import { ChatListener, ChatSender, compilePatterns } from "./chat.js";
import { componentToText, stripColors } from "./text.js";

const { pathfinder } = pathfinderPkg;
const log = createLogger("bot");

export interface BotManagerEvents {
  /** Bot spawned and (if AuthMe is on) logged in. Fired again after each reconnect. */
  ready: [Bot];
  /** Connection ended. `willReconnect` says whether a reconnect is scheduled. */
  disconnected: [{ reason: string; willReconnect: boolean }];
}

/**
 * Owns the Mineflayer connection: creates the bot, loads plugins, logs in through AuthMe,
 * and reconnects with exponential backoff. A new Bot object is created on every reconnect,
 * so other modules should read `manager.bot` when they need it instead of keeping a copy.
 */
export class BotManager extends EventEmitter<BotManagerEvents> {
  bot: Bot | null = null;
  ready = false;
  readonly chat: ChatListener;
  readonly sender: ChatSender;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Set when reconnecting would not help (wrong password); stops the reconnect loop. */
  private fatal: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly secrets: Secrets,
  ) {
    super();
    this.reconnectDelay = config.reconnect.initialDelayMs;
    this.chat = new ChatListener(
      50,
      compilePatterns(config.chat.patterns),
      compilePatterns(config.chat.whisperPatterns),
    );
    this.sender = new ChatSender(config.chat, (text) => {
      if (!this.bot) return;
      this.bot.chat(text);
      if (!text.startsWith("/")) this.chat.recordSelf(text);
    });
  }

  start(): void {
    this.stopped = false;
    this.fatal = null;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sender.clear();
    this.bot?.quit("shutdown");
  }

  private connect(): void {
    const { server, bot: botCfg } = this.config;
    log.info(`连接 ${server.host}:${server.port}（${server.version}）用户名 ${botCfg.username}`);
    const bot = mineflayer.createBot({
      host: server.host,
      port: server.port,
      version: server.version,
      username: botCfg.username,
      auth: botCfg.auth,
      checkTimeoutInterval: 60_000,
    });
    this.bot = bot;
    this.ready = false;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlockPkg.plugin);
    this.chat.attach(bot);

    let auth: AuthMeSession | null = null;
    let ended = false;
    const markReady = () => {
      if (this.ready || this.bot !== bot || ended) return;
      this.ready = true;
      this.reconnectDelay = this.config.reconnect.initialDelayMs;
      log.info("已就绪");
      this.emit("ready", bot);
    };

    bot.once("spawn", () => {
      log.info(`已进入世界，位置 ${bot.entity.position.floored().toString()}`);
      if (!this.config.authme.enabled) return markReady();
      if (!this.secrets.mcPassword) {
        log.warn("authme.enabled 为 true 但没有设置 MC_PASSWORD，跳过自动登录");
        return markReady();
      }
      auth = new AuthMeSession({
        password: this.secrets.mcPassword,
        autoRegister: this.config.authme.autoRegister,
        maxAttempts: this.config.authme.maxAttempts,
        sendCommand: (cmd) => {
          log.info(cmd.startsWith("/register") ? "AuthMe：自动注册" : "AuthMe：自动登录");
          bot.chat(cmd);
        },
        onLoggedIn: () => {
          log.info("AuthMe：登录成功");
          markReady();
        },
        onGiveUp: (reason) => {
          log.error(`AuthMe：${reason}`);
          this.fatal = reason;
          bot.quit("authme");
        },
      });
      // Some servers keep players logged in by IP session and never prompt; don't wait forever.
      setTimeout(() => {
        if (!this.ready && !ended && this.bot === bot && auth && !auth.finished) {
          log.warn("15 秒内没有看到登录提示，按已登录处理");
          markReady();
        }
      }, 15_000);
    });

    bot.on("messagestr", (raw, position) => {
      const text = stripColors(raw);
      if (position !== "game_info") log.debug(`聊天：${text}`);
      if (auth && !text.startsWith("<")) auth.handle(text);
    });

    bot.on("kicked", (reason) => {
      const text = componentToText(bot, reason) || String(reason);
      log.warn(`被踢出：${text}`);
      if (classifyAuthMessage(text) === "wrong_password") {
        this.fatal = "AuthMe 密码错误，已停止重连。请检查 .env 里的 MC_PASSWORD 是否和这个账号注册时的密码一致";
      }
    });
    bot.on("error", (err) => log.error("连接错误", err));
    bot.on("end", (reason) => {
      ended = true;
      if (this.bot !== bot) return;
      this.ready = false;
      this.sender.clear();
      if (this.fatal) log.error(this.fatal);
      const willReconnect = !this.stopped && !this.fatal && this.config.reconnect.enabled;
      log.warn(`连接断开：${reason}${willReconnect ? `，${Math.round(this.reconnectDelay / 1000)} 秒后重连` : ""}`);
      this.emit("disconnected", { reason, willReconnect });
      if (willReconnect) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnect.maxDelayMs);
  }
}
