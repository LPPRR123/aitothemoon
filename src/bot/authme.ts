import { stripColors } from "./text.js";

/**
 * Recognises AuthMe (and similar login plugins) prompts in English and Chinese.
 * Kept as plain functions so they are easy to test and to extend for other plugins.
 */
const REGISTER_PROMPT = [/\/(register|reg)\b/i];
const LOGIN_PROMPT = [/\/(login|l)\s*</i, /\/login\b/i];
const SUCCESS = [/successful login/i, /successfully registered/i, /已成功登录/, /已成功注册/, /登录成功/, /注册成功/, /already logged in/i, /已经登陆过了|已经登录过了/];
const WRONG_PASSWORD = [/wrong password/i, /错误的密码/, /密码错误/];
/** Only react to lines that look like requests, not to usage hints after a successful login. */
const REQUEST_HINT = [/please/i, /请/, /usage|用法/i];

export type AuthPrompt = "register" | "login" | "success" | "wrong_password" | null;

export function classifyAuthMessage(raw: string): AuthPrompt {
  const text = stripColors(raw);
  if (SUCCESS.some((r) => r.test(text))) return "success";
  if (WRONG_PASSWORD.some((r) => r.test(text))) return "wrong_password";
  const isRequest = REQUEST_HINT.some((r) => r.test(text));
  if (!isRequest) return null;
  if (REGISTER_PROMPT.some((r) => r.test(text))) return "register";
  if (LOGIN_PROMPT.some((r) => r.test(text))) return "login";
  return null;
}

export interface AuthMeOptions {
  password: string;
  autoRegister: boolean;
  maxAttempts: number;
  /** Send a command straight to the server (bypasses the normal chat queue). */
  sendCommand: (cmd: string) => void;
  onLoggedIn: () => void;
  onGiveUp: (reason: string) => void;
}

/** Per-connection login state machine. Create a new one for each connection. */
export class AuthMeSession {
  private attempts = 0;
  /** Logged in, or gave up; either way stop reacting to prompts. */
  private done = false;
  private success = false;
  private lastSent = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: AuthMeOptions) {}

  get loggedIn(): boolean {
    return this.success;
  }

  get finished(): boolean {
    return this.done;
  }

  handle(message: string, now = Date.now()): void {
    if (this.done) return;
    const kind = classifyAuthMessage(message);
    if (kind === "success") {
      this.done = true;
      this.success = true;
      this.opts.onLoggedIn();
      return;
    }
    if (kind === "wrong_password") {
      this.done = true;
      this.opts.onGiveUp("服务器提示密码错误，已停止自动登录，请检查 .env 里的 MC_PASSWORD");
      return;
    }
    if (kind !== "register" && kind !== "login") return;
    // AuthMe repeats its prompt every few seconds; don't answer every repeat.
    if (now - this.lastSent < 4_000) return;
    if (this.attempts >= this.opts.maxAttempts) {
      this.done = true;
      this.opts.onGiveUp(`尝试登录 ${this.attempts} 次仍未成功，已停止`);
      return;
    }
    if (kind === "register" && !this.opts.autoRegister) {
      this.done = true;
      this.opts.onGiveUp("服务器要求注册，但配置里关闭了自动注册");
      return;
    }
    this.attempts++;
    this.lastSent = now;
    const pw = this.opts.password;
    this.opts.sendCommand(kind === "register" ? `/register ${pw} ${pw}` : `/login ${pw}`);
  }
}
