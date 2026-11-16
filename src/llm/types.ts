export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 JSON 字符串；解析与校验在 tools 层完成，LLM 层不做业务解释 */
  readonly arguments: string;
}

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[] | undefined;
    }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[] | undefined;
  readonly model?: string | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
}

export interface ChatResponse {
  readonly content: string;
  /** GLM 思考流独立于正文，不参与下一轮 prompt */
  readonly reasoningContent: string | undefined;
  readonly finishReason: string;
  readonly usage: TokenUsage;
  readonly model: string;
  /** 无工具调用时为 []，调用方无需判空 */
  readonly toolCalls: readonly ToolCall[];
}

export type StreamChunk =
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'content'; readonly text: string }
  | { readonly type: 'done'; readonly response: ChatResponse };

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}
