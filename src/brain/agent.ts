import { ACTIONS, runAction, toolInputSchema } from "../actions/index.js";
import { stopEverything } from "../actions/movement.js";
import type { BotManager } from "../bot/BotManager.js";
import type { ChatLine, IncomingChat } from "../bot/chat.js";
import { observe } from "../bot/perception.js";
import type { Config } from "../config.js";
import { createLogger } from "../logger.js";
import { describeApiError, type LlmClient, type MessageParam, type Tool, type ToolResultBlock, type ToolUseBlock } from "./llm.js";
import { buildInterjection, buildSystemPrompt, buildTaskPrompt } from "./prompts.js";

const log = createLogger("agent");

interface Task {
  owner: string;
  whisper: boolean;
  /** Aborts the whole task (stop word, disconnect). */
  abort: AbortController;
  /** Aborts only the tool that is running right now (owner sent a new message). */
  toolAbort: AbortController | null;
  /** Owner messages that arrived while the task was running, not yet shown to the model. */
  pending: string[];
  /** Everything the owner said during this task. */
  ownerMessages: string[];
}

export function isOwner(config: Config, username: string): boolean {
  const u = username.toLowerCase();
  return config.owner.names.some((n) => n.toLowerCase() === u);
}

function botNames(config: Config): string[] {
  return [config.bot.username, ...config.bot.aliases].filter(Boolean);
}

/** Is a public message addressed to the bot? Returns the message without the name, or null. */
export function addressedText(config: Config, message: string): string | null {
  const lower = message.toLowerCase();
  for (const name of botNames(config)) {
    const n = name.toLowerCase();
    const idx = lower.indexOf(n);
    if (idx < 0) continue;
    const stripped = (message.slice(0, idx) + message.slice(idx + n.length))
      .replace(/^[\s@,，:：、!！]+/, "")
      .replace(/[\s,，]+$/, "")
      .trim();
    return stripped || message;
  }
  return null;
}

export function isStopWord(config: Config, text: string): boolean {
  const t = text.trim().replace(/[!！。.~～]+$/, "").toLowerCase();
  return config.agent.stopWords.some((w) => w.toLowerCase() === t);
}

export function formatChatLines(lines: ChatLine[], config: Config): string {
  return lines
    .map((l) => {
      if (l.kind === "self") return `[我] ${l.text}`;
      if (l.kind === "server") return `[服务器] ${l.text}`;
      const who = l.username ?? "?";
      const role = isOwner(config, who) ? "主人" : "玩家";
      return `[${l.kind === "whisper" ? "私聊" : ""}${role} ${who}] ${l.text}`;
    })
    .join("\n");
}

/** Clean model text for in-game chat: no Markdown, single line, bounded length. */
export function toChatText(text: string, max = 200): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*|__|`/g, "") // bold/code markers; single "_" is kept (item IDs like oak_log)
    .replace(/^\s*(#+|>|[-•*])\s+/gm, "") // headings, quotes, list bullets
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Listens to the owner, runs one task at a time with Claude + tools, and reports back.
 * Each instruction starts a fresh conversation (append-only within the task), so history
 * never needs to be edited and the stable tools + system prompt prefix stays cached.
 */
export class Agent {
  private task: Task | null = null;
  private readonly tools: Tool[];
  private readonly system: string;

  constructor(
    private readonly manager: BotManager,
    private readonly config: Config,
    private readonly llm: LlmClient,
  ) {
    this.system = buildSystemPrompt(config);
    this.tools = ACTIONS.map((a) => ({
      name: a.name,
      description: a.description,
      input_schema: toolInputSchema(a),
    }));
  }

  get busy(): boolean {
    return this.task !== null;
  }

  attach(): void {
    this.manager.chat.on("message", (m) => this.onMessage(m));
    this.manager.on("disconnected", () => this.cancel("连接断开"));
  }

  cancel(reason: string): void {
    if (!this.task) return;
    log.info(`取消当前任务：${reason}`);
    this.task.abort.abort();
  }

  /** Send a reply to the owner the same way they talked to us. */
  reply(owner: string, whisper: boolean, text: string): void {
    const msg = toChatText(text);
    if (!msg) return;
    log.info(`回复 ${owner}：${msg}`);
    this.manager.sender.say(whisper ? `/msg ${owner} ${msg}` : msg);
  }

  onMessage(m: IncomingChat): void {
    if (!isOwner(this.config, m.username) || !this.manager.ready) return;
    const text = m.whisper || this.config.agent.publicTrigger === "all" ? m.message : addressedText(this.config, m.message);
    if (text === null) return;

    if (isStopWord(this.config, text)) {
      this.cancel("主人说停");
      const bot = this.manager.bot;
      if (bot) stopEverything(bot);
      this.reply(m.username, m.whisper, "好的，停下了");
      return;
    }

    if (this.task) {
      // Deliver it to the running task and interrupt the current action so the model can react.
      this.task.pending.push(text);
      this.task.ownerMessages.push(text);
      this.task.toolAbort?.abort();
      return;
    }
    void this.runTask(m.username, m.whisper, text);
  }

  async runTask(owner: string, whisper: boolean, message: string): Promise<void> {
    const task: Task = {
      owner,
      whisper,
      abort: new AbortController(),
      toolAbort: null,
      pending: [],
      ownerMessages: [message],
    };
    this.task = task;
    log.info(`新任务（${owner}）：${message}`);
    try {
      const final = await this.loop(task, message);
      if (final && !task.abort.signal.aborted) this.reply(owner, whisper, final);
    } catch (err) {
      if (!task.abort.signal.aborted) {
        log.error("任务出错", err);
        this.reply(owner, whisper, `出错了：${describeApiError(err)}`);
      }
    } finally {
      this.task = null;
    }
    // Messages that arrived after the model's last turn start a new task.
    if (task.pending.length && !task.abort.signal.aborted) {
      void this.runTask(owner, whisper, task.pending.join(" "));
    }
  }

  private async loop(task: Task, message: string): Promise<string> {
    const bot = this.manager.bot;
    if (!bot) return "我还没连上服务器";
    const recent = this.manager.chat.history.slice(-this.config.agent.recentChatLines);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: buildTaskPrompt({
          owner: task.owner,
          message,
          whisper: task.whisper,
          recentChat: formatChatLines(recent, this.config),
          observation: observe(bot),
        }),
      },
    ];

    for (let turn = 0; turn < this.config.llm.maxTurnsPerTask; turn++) {
      const response = await this.llm.create(
        {
          model: this.config.llm.model,
          max_tokens: this.config.llm.maxTokens,
          system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
          tools: this.tools,
          messages,
          output_config: { effort: this.config.llm.effort },
          cache_control: { type: "ephemeral" },
        },
        task.abort.signal,
      );
      log.debug(
        `第 ${turn + 1} 轮 stop=${response.stop_reason} 输入=${response.usage.input_tokens} 缓存读=${response.usage.cache_read_input_tokens ?? 0}`,
      );

      if (response.stop_reason === "refusal") return "这个请求我没法处理";
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        return response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join(" ");
      }

      const results: ToolResultBlock[] = [];
      for (const use of toolUses) {
        results.push(await this.execute(task, use));
      }
      const content: Array<ToolResultBlock | { type: "text"; text: string }> = [...results];
      if (task.pending.length) content.push({ type: "text", text: buildInterjection(task.owner, task.pending.splice(0)) });
      messages.push({ role: "user", content });
    }
    return "这件事步骤太多了，我先停下，你可以换个说法再告诉我";
  }

  private async execute(task: Task, use: ToolUseBlock): Promise<ToolResultBlock> {
    const bot = this.manager.bot;
    if (task.abort.signal.aborted || !bot) {
      return { type: "tool_result", tool_use_id: use.id, content: "任务已取消，没有执行", is_error: true };
    }
    // A message that arrived before this tool started is handled after it, not by aborting it.
    const toolAbort = new AbortController();
    task.toolAbort = toolAbort;
    const signal = AbortSignal.any([task.abort.signal, toolAbort.signal]);
    log.info(`调用 ${use.name} ${JSON.stringify(use.input)}`);
    const result = await runAction(
      {
        bot,
        config: this.config,
        signal,
        sender: this.manager.sender,
        chat: this.manager.chat,
        owner: task.owner,
        ownerMessages: task.ownerMessages,
        log,
      },
      use.name,
      use.input,
    );
    task.toolAbort = null;
    let text = result.text;
    if (toolAbort.signal.aborted && !task.abort.signal.aborted) {
      stopEverything(bot);
      text = `这个动作被主人的新消息打断了（${result.text}）`;
    }
    log.info(`结果 ${use.name}：${text.split("\n")[0]}`);
    return { type: "tool_result", tool_use_id: use.id, content: text, is_error: !result.ok };
  }
}
