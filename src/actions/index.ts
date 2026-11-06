import { z } from "zod";
import { chatActions } from "./chat.js";
import { gatherActions } from "./gather.js";
import { interactActions } from "./interact.js";
import { inventoryActions } from "./inventory.js";
import { movementActions } from "./movement.js";
import { ActionError, type Action, type ActionContext } from "./types.js";

/** Every action the AI can use, in a fixed order (a stable tool list keeps the prompt cache warm). */
export const ACTIONS: Action[] = [
  ...inventoryActions,
  ...chatActions,
  ...movementActions,
  ...gatherActions,
  ...interactActions,
] as Action[];

const byName = new Map(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): Action | undefined {
  return byName.get(name);
}

/** JSON Schema for a tool's input, in the shape the Claude API expects. */
export function toolInputSchema(action: Action): { type: "object"; [k: string]: unknown } {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(action.schema, { io: "input" }) as Record<string, unknown>;
  return { ...schema, type: "object" };
}

export interface ActionResult {
  ok: boolean;
  text: string;
  meta?: Record<string, unknown>;
}

/** Validate input and run an action. Never throws: failures come back as text for the model. */
export async function runAction(ctx: ActionContext, name: string, input: unknown): Promise<ActionResult> {
  const action = byName.get(name);
  if (!action) return { ok: false, text: `没有叫 ${name} 的工具` };
  const parsed = action.schema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, text: `参数错误：${z.prettifyError(parsed.error)}` };
  try {
    const out = await action.run(ctx, parsed.data);
    return typeof out === "string" ? { ok: true, text: out } : { ok: true, text: out.text, meta: out.meta };
  } catch (err) {
    if (err instanceof ActionError) return { ok: false, text: err.message };
    ctx.log.error(`工具 ${name} 出错`, err);
    return { ok: false, text: `执行出错：${(err as Error).message ?? String(err)}` };
  }
}

export { ActionError, type Action, type ActionContext };
