import Anthropic from "@anthropic-ai/sdk";

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;
export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type Tool = Anthropic.Beta.Messages.BetaTool;
export type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

/** The one thing the agent needs from a model. Tests swap in a scripted fake. */
export interface LlmClient {
  create(params: MessageParams, signal: AbortSignal): Promise<Message>;
}

/**
 * Claude through the official SDK. Reads ANTHROPIC_API_KEY from the environment.
 * Uses the beta endpoint for server-side refusal fallbacks: if a request is declined by a
 * safety classifier, the API retries it on a recommended fallback model in the same call.
 */
export class ClaudeClient implements LlmClient {
  private readonly client = new Anthropic();

  create(params: MessageParams, signal: AbortSignal): Promise<Message> {
    return this.client.beta.messages.create(
      { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
      { signal },
    );
  }
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Claude API Key 无效，请检查 .env 里的 ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.PermissionDeniedError) return "这个 API Key 没有权限使用该模型";
  if (err instanceof Anthropic.RateLimitError) return "Claude API 请求太频繁，稍后再试";
  if (err instanceof Anthropic.BadRequestError) return `请求参数有误：${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "连不上 Claude API，请检查网络/代理";
  if (err instanceof Anthropic.APIError) return `Claude API 出错（${err.status}）：${err.message}`;
  return (err as Error)?.message ?? String(err);
}
