import type { MockStep } from '../../config/schema.js';
import { ErrorCode } from '../../shared/errors.js';
import { LlmError } from '../errors.js';
import {
  EMPTY_USAGE,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
} from '../types.js';

export interface MockProviderOptions {
  readonly model?: string | undefined;
  /** 固定回复；缺省时回显最后一条 user 消息，便于断言多轮上下文 */
  readonly reply?: string | undefined;
  readonly reasoning?: string | undefined;
  /** 脚本化响应：每次 chat/stream 调用消费一步，用尽后返回空正文的最终回答 */
  readonly script?: readonly MockStep[] | undefined;
}

const PIECE_SIZE = 4;

export function createMockProvider(options: MockProviderOptions = {}): LLMProvider {
  const model = options.model ?? 'mock-model';
  const script = options.script;
  let stepIndex = 0;

  function nextResponse(req: ChatRequest): ChatResponse {
    if (script === undefined) {
      return echoResponse(req);
    }
    const index = stepIndex;
    stepIndex += 1;
    const step = script[index];
    if (step === undefined) {
      return finish(req, '', undefined, []);
    }
    const content = step.content ?? '';
    const toolCalls = (step.toolCalls ?? []).map((call, position) => ({
      id: `mock-call-${index}-${position}`,
      name: call.name,
      arguments: call.arguments,
    }));
    const reasoning =
      step.reasoning === undefined || step.reasoning === '' ? undefined : step.reasoning;
    return finish(req, content, reasoning, toolCalls);
  }

  function echoResponse(req: ChatRequest): ChatResponse {
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    const content = options.reply ?? `echo: ${lastUser?.content ?? ''}`;
    const reasoning = options.reasoning;
    return finish(
      req,
      content,
      reasoning === undefined || reasoning === '' ? undefined : reasoning,
      [],
    );
  }

  function finish(
    req: ChatRequest,
    content: string,
    reasoning: string | undefined,
    toolCalls: readonly ToolCall[],
  ): ChatResponse {
    return {
      content,
      reasoningContent: reasoning,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: countUsage(req, content, reasoning, toolCalls),
      model: req.model ?? model,
      toolCalls,
    };
  }

  return {
    name: 'mock',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      await Promise.resolve();
      assertNotAborted(req.signal);
      return nextResponse(req);
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      const response = nextResponse(req);
      if (response.reasoningContent !== undefined) {
        for (const text of pieces(response.reasoningContent)) {
          assertNotAborted(req.signal);
          // 让出微任务，使中止能在分块之间被观察到
          await Promise.resolve();
          yield { type: 'reasoning', text };
        }
      }
      for (const text of pieces(response.content)) {
        assertNotAborted(req.signal);
        await Promise.resolve();
        yield { type: 'content', text };
      }
      assertNotAborted(req.signal);
      yield { type: 'done', response };
    },
  };
}

/** 字符数近似，仅为让 mock 的用量统计确定可断言，不代表真实分词 */
function countUsage(
  req: ChatRequest,
  content: string,
  reasoning: string | undefined,
  toolCalls: readonly ToolCall[],
): TokenUsage {
  const promptTokens = req.messages.reduce((sum, message) => sum + message.content.length, 0);
  const completionTokens =
    content.length + toolCalls.reduce((sum, call) => sum + call.arguments.length, 0);
  const reasoningTokens = reasoning?.length ?? 0;
  return {
    ...EMPTY_USAGE,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens,
  };
}

function* pieces(text: string): Generator<string> {
  for (let index = 0; index < text.length; index += PIECE_SIZE) {
    yield text.slice(index, index + PIECE_SIZE);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LlmError(ErrorCode.LlmAborted, 'LLM request aborted', { retryable: false });
  }
}
