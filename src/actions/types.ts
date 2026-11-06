import type { Bot } from "mineflayer";
import { z } from "zod";
import type { ChatListener, ChatSender } from "../bot/chat.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface ActionContext {
  bot: Bot;
  config: Config;
  /** Aborted when the owner says a stop word or gives a new instruction that replaces this one. */
  signal: AbortSignal;
  sender: ChatSender;
  chat: ChatListener;
  /** Owner name for the current task. */
  owner: string;
  /** Everything the owner said during the current task (used to approve commands). */
  ownerMessages: string[];
  log: Logger;
}

export type RiskLevel = "low" | "medium" | "high";

/** What an action returns: text for the model, plus optional facts for learning (e.g. what was clicked). */
export type ActionOutput = string | { text: string; meta?: Record<string, unknown> };

export interface Action<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  risk: RiskLevel;
  schema: S;
  run(ctx: ActionContext, input: z.infer<S>): Promise<ActionOutput>;
}

/** Helper that keeps the input type tied to the schema. */
export function defineAction<S extends z.ZodObject>(action: Action<S>): Action<S> {
  return action;
}

/** Thrown by actions for expected failures; the message is shown to the model as-is. */
export class ActionError extends Error {}
