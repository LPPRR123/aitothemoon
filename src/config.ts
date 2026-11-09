import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";

const ServerSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().default(25565),
  /** Exact Minecraft version of the server, e.g. "1.20.4". */
  version: z.string().default("1.20.4"),
});

const BotSchema = z.object({
  username: z.string().default("AIBot"),
  /** "offline" for cracked/AuthMe servers, "microsoft" for premium (online-mode) servers. */
  auth: z.enum(["offline", "microsoft"]).default("offline"),
  /** Extra names the owner can use to address the bot in public chat. */
  aliases: z.array(z.string()).default([]),
});

const OwnerSchema = z.object({
  /** In-game names whose instructions the bot follows. Everyone else is treated as untrusted. */
  names: z.array(z.string()).min(1),
});

const AuthMeSchema = z.object({
  enabled: z.boolean().default(true),
  /** Register automatically when the server asks for /register. */
  autoRegister: z.boolean().default(true),
  /** Give up after this many failed logins per connection, so a wrong password never loops. */
  maxAttempts: z.number().int().default(3),
});

const ReconnectSchema = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().int().default(5_000),
  maxDelayMs: z.number().int().default(120_000),
});

const ChatSchema = z.object({
  /** Minimum gap between two messages the bot sends. */
  minIntervalMs: z.number().int().default(1_500),
  /** Hard cap on messages per minute, to stay clear of anti-spam kicks. */
  maxPerMinute: z.number().int().default(20),
  /** Longer messages are split. Minecraft's limit is 256 characters. */
  maxLength: z.number().int().max(256).default(200),
  /**
   * Extra regular expressions for chat formats changed by chat plugins.
   * Each needs the named groups `user` and `msg`, e.g. "^\\[[^\\]]+\\] (?<user>\\w+): (?<msg>.+)$".
   */
  patterns: z.array(z.string()).default([]),
  /** Same, for private messages sent to the bot. */
  whisperPatterns: z.array(z.string()).default([]),
});

const CommandsSchema = z.object({
  /** Commands the AI may run on its own (first word, without the slash). */
  allow: z.array(z.string()).default([]),
  /** Commands the AI may never run, even if the owner asks. */
  deny: z.array(z.string()).default([]),
});

const MovementSchema = z.object({
  /** Let the pathfinder break blocks while walking. Off by default so the bot never damages builds. */
  allowDig: z.boolean().default(false),
  /** Let the pathfinder place blocks (towering, bridging). Off by default for the same reason. */
  allowPlace: z.boolean().default(false),
});

const LlmSchema = z.object({
  model: z.string().default("claude-opus-5-5"),
  /** low | medium | high | xhigh | max. Low keeps in-game replies fast. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  maxTokens: z.number().int().default(16_000),
  /** Upper bound on model calls for one instruction, so a confused run cannot loop forever. */
  maxTurnsPerTask: z.number().int().default(25),
});

const AgentSchema = z.object({
  /** When the owner speaks in public chat: "mention" = only if they name the bot, "all" = every message. */
  publicTrigger: z.enum(["mention", "all"]).default("mention"),
  /** Words that stop the current task immediately, without asking the model. */
  stopWords: z.array(z.string()).default(["停", "停下", "别动", "stop"]),
  /** How many recent chat lines are shown to the model as context. */
  recentChatLines: z.number().int().default(12),
});

const StrategyConfigSchema = z.object({
  /** Answer common instructions from learned strategies without calling the model. */
  enabled: z.boolean().default(true),
  /** Learn new strategies from tasks the model solved. */
  learn: z.boolean().default(true),
  file: z.string().default("data/strategies.json"),
  /** Successful uses before a new strategy counts as trusted. */
  promoteAfter: z.number().int().min(1).default(2),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  file: z.string().default("data/memory.json"),
  /** Unused memories (that the owner did not ask to keep) fade; this many days halves their score. */
  halfLifeDays: z.number().min(1).default(14),
});

export const ConfigSchema = z.object({
  server: ServerSchema.prefault({}),
  bot: BotSchema.prefault({}),
  owner: OwnerSchema,
  authme: AuthMeSchema.prefault({}),
  reconnect: ReconnectSchema.prefault({}),
  chat: ChatSchema.prefault({}),
  commands: CommandsSchema.prefault({}),
  movement: MovementSchema.prefault({}),
  llm: LlmSchema.prefault({}),
  agent: AgentSchema.prefault({}),
  strategy: StrategyConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Secrets {
  /** AuthMe password for the bot account. */
  mcPassword?: string;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`config.yaml is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(path = "config.yaml"): Config {
  if (!fs.existsSync(path)) {
    throw new Error(`Cannot find ${path}. Copy config.example.yaml to ${path} and edit it.`);
  }
  return parseConfig(YAML.parse(fs.readFileSync(path, "utf8")));
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return { mcPassword: env.MC_PASSWORD || undefined };
}
