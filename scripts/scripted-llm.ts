import type { LlmClient, Message, MessageParams } from "../src/brain/llm.js";

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
  constructor(private readonly scripts: Record<string, Step[]>) {}

  async create(params: MessageParams, signal: AbortSignal): Promise<Message> {
    if (signal.aborted) throw new Error("aborted");
    const first = params.messages[0];
    const firstText = typeof first?.content === "string" ? first.content : "";
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
}
