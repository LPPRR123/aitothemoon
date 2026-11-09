import type { LlmClient, Message, MessageParams } from "../src/brain/llm.js";
import type { CompiledStrategy } from "../src/strategy/compiler.js";

export interface Step {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A stand-in for Claude used by the smoke test: for each owner instruction it plays back a
 * fixed list of tool calls, then ends the turn with a short summary of the last tool result.
 * This exercises the real agent loop, tools and game connection without an API key.
 */
export class ScriptedLlm implements LlmClient {
  readonly calls: string[] = [];
  /** Model requests made for tasks (not counting strategy compilation). */
  taskRequests = 0;
  readonly compiled: string[] = [];
  /** Whether the last task prompt carried a note (a learned strategy failed first). */
  lastTaskHadNote = false;
  /** First user message of the last task (to check what context the model was given). */
  lastTaskPrompt = "";

  constructor(
    private readonly scripts: Record<string, Step[]>,
    private readonly compiles: Record<string, CompiledStrategy> = {},
  ) {}

  /** Add a script at run time (for instructions that contain coordinates known only then). */
  addScript(instruction: string, steps: Step[]): void {
    this.scripts[instruction] = steps;
  }

  async create(params: MessageParams, signal: AbortSignal): Promise<Message> {
    if (signal.aborted) throw new Error("aborted");
    const first = params.messages[0];
    const firstText = typeof first?.content === "string" ? first.content : "";
    if (params.output_config?.format) return this.compile(params, firstText);
    this.taskRequests++;
    if (params.messages.length === 1) {
      this.lastTaskHadNote = firstText.includes("<note>");
      this.lastTaskPrompt = firstText;
    }
    const instruction = firstText.split("对你说：").pop()?.trim() ?? "";
    const steps = this.scripts[instruction] ?? [];
    const done = params.messages.filter((m) => m.role === "assistant").length;
    const last = params.messages[params.messages.length - 1];
    const lastBlocks = Array.isArray(last?.content) ? last.content : [];
    const interrupted = lastBlocks.some((b) => b.type === "text" && b.text.includes("又说了"));
    const lastResult = lastBlocks.find((b) => b.type === "tool_result");
    const resultText =
      lastResult && lastResult.type === "tool_result" && typeof lastResult.content === "string" ? lastResult.content : "";

    const base = {
      id: `msg_${Date.now()}`,
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    if (!interrupted && done < steps.length) {
      const step = steps[done]!;
      this.calls.push(step.name);
      return {
        ...base,
        content: [{ type: "tool_use", id: `toolu_${done}_${Date.now()}`, name: step.name, input: step.input }],
        stop_reason: "tool_use",
      } as unknown as Message;
    }
    const summary = interrupted ? "收到，按你新说的来" : `完成：${resultText.replace(/\s*\n\s*/g, " ").slice(0, 150)}`;
    return { ...base, content: [{ type: "text", text: summary }], stop_reason: "end_turn" } as unknown as Message;
  }

  private compile(params: MessageParams, prompt: string): Message {
    const instruction = /主人的原话：(.+)/.exec(prompt)?.[1]?.trim() ?? "";
    this.compiled.push(instruction);
    const result: CompiledStrategy = this.compiles[instruction] ?? {
      reusable: false, reason: "剧本里没有", name: "", triggers: [], params: [], steps: [], reply: "",
    };
    return {
      id: `msg_${Date.now()}`, type: "message", role: "assistant", model: params.model, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify(result) }],
      stop_reason: "end_turn",
    } as unknown as Message;
  }
}
