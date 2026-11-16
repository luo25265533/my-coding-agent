import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import { ErrorCode } from '../../../shared/errors.js';
import {
  badResponseError,
  classifyFetchError,
  classifyHttpError,
  LlmError,
  type HttpFailure,
} from '../../errors.js';
import {
  computeBackoffDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  parseRetryAfter,
} from '../../retry.js';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
} from '../../types.js';
import {
  apiErrorSchema,
  chatCompletionChunkSchema,
  chatCompletionSchema,
  type ChatCompletion,
} from './schema.js';
import { createSseParser, SSE_DONE } from './sse.js';

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs?: number | undefined;
  readonly retryMaxDelayMs?: number | undefined;
  readonly logger?: Logger | undefined;
  readonly random?: (() => number) | undefined;
}

interface SendResult {
  readonly response: Response;
  readonly release: () => void;
}

interface TimeoutHandle {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly release: () => void;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LLMProvider {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const baseDelayMs = options.retryBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.retryMaxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const log = options.logger;

  function backoff(attempt: number, retryAfterMs: number | undefined): number {
    return computeBackoffDelay({ attempt, baseDelayMs, maxDelayMs, retryAfterMs, random });
  }

  async function sendWithRetry(req: ChatRequest, stream: boolean): Promise<SendResult> {
    const body = buildBody(req, options.model, stream);
    let attempt = 0;

    for (;;) {
      log?.debug(
        { url, model: req.model ?? options.model, stream, messages: req.messages.length },
        'llm request',
      );
      const timeout = startTimeout(req.signal, options.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            accept: stream ? 'text/event-stream' : 'application/json',
          },
          body,
          signal: timeout.signal,
        });
      } catch (error) {
        timeout.release();
        const failure = classifyFetchError(error, timeout.timedOut());
        if (!failure.retryable || attempt >= options.maxRetries) {
          throw failure;
        }
        log?.warn({ attempt: attempt + 1, reason: failure.code }, 'llm request failed, retrying');
        await sleep(backoff(attempt, undefined), req.signal);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        return { response, release: timeout.release };
      }

      const failure = classifyHttpError(await readHttpFailure(response));
      timeout.release();
      if (!failure.retryable || attempt >= options.maxRetries) {
        throw failure;
      }
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      log?.warn(
        { attempt: attempt + 1, reason: failure.code, status: failure.status },
        'llm request rejected, retrying',
      );
      await sleep(backoff(attempt, retryAfterMs), req.signal);
      attempt += 1;
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const { response, release } = await sendWithRetry(req, false);
    try {
      const text = await response.text();
      return toChatResponse(
        parsePayload(text, chatCompletionSchema, 'completion'),
        req.model ?? options.model,
        log,
      );
    } finally {
      release();
    }
  }

  async function* stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const { response, release } = await sendWithRetry(req, true);
    // 流式正文长度不可预期，取得响应头即释放计时器，避免长回答被总时长误杀
    release();

    if (response.body === null) {
      throw badResponseError('stream response has no body');
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const fallbackModel = req.model ?? options.model;

    let content = '';
    let reasoning = '';
    // 协议允许一条工具调用按 index 分片到达，必须累积而不能假设一次到齐
    const toolCalls = new Map<
      number,
      { id: string | undefined; name: string; arguments: string }
    >();
    let usage: TokenUsage = EMPTY_USAGE;
    let finishReason = 'unknown';
    let model = fallbackModel;
    let finished = false;

    const handle = (data: string): StreamChunk | undefined => {
      if (data === SSE_DONE) {
        finished = true;
        return undefined;
      }
      const chunk = parsePayload(data, chatCompletionChunkSchema, 'stream chunk');
      if (chunk.model !== undefined) {
        model = chunk.model;
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = toUsage(chunk.usage);
      }
      const choice = chunk.choices?.[0];
      if (choice === undefined) {
        return undefined;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (delta === undefined || delta === null) {
        return undefined;
      }
      const toolCallParts = delta.tool_calls;
      if (toolCallParts !== undefined && toolCallParts !== null) {
        for (const [position, part] of toolCallParts.entries()) {
          const index = part.index ?? position;
          const bucket = toolCalls.get(index) ?? { id: undefined, name: '', arguments: '' };
          if (part.id !== undefined && part.id !== null && part.id !== '') {
            bucket.id = part.id;
          }
          const namePart = part.function?.name;
          if (namePart !== undefined && namePart !== null) {
            bucket.name += namePart;
          }
          const argumentsPart = part.function?.arguments;
          if (argumentsPart !== undefined && argumentsPart !== null) {
            bucket.arguments += argumentsPart;
          }
          toolCalls.set(index, bucket);
        }
      }
      const reasoningText = delta.reasoning_content;
      if (reasoningText !== undefined && reasoningText !== null && reasoningText !== '') {
        reasoning += reasoningText;
        return { type: 'reasoning', text: reasoningText };
      }
      const contentText = delta.content;
      if (contentText !== undefined && contentText !== null && contentText !== '') {
        content += contentText;
        return { type: 'content', text: contentText };
      }
      return undefined;
    };

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          const chunk = handle(data);
          if (chunk !== undefined) {
            yield chunk;
          }
          if (finished) {
            break;
          }
        }
      }
      if (!finished) {
        for (const data of parser.flush()) {
          const chunk = handle(data);
          if (chunk !== undefined) {
            yield chunk;
          }
          if (finished) {
            break;
          }
        }
      }
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      throw classifyFetchError(error, false);
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'done',
      response: {
        content,
        reasoningContent: reasoning === '' ? undefined : reasoning,
        finishReason,
        usage,
        model,
        toolCalls: finalizeToolCalls(toolCalls, log),
      },
    };
  }

  return { name: 'openai-compatible', chat, stream };
}

function buildBody(req: ChatRequest, fallbackModel: string, stream: boolean): string {
  const payload: Record<string, unknown> = {
    model: req.model ?? fallbackModel,
    messages: req.messages.map(toWireMessage),
    stream,
  };
  if (req.tools !== undefined && req.tools.length > 0) {
    payload.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    payload.max_tokens = req.maxTokens;
  }
  return JSON.stringify(payload);
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (
    message.role === 'assistant' &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    return {
      role: 'assistant',
      // 与实测协议一致：纯工具调用回合的正文发 null
      content: message.content === '' ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function startTimeout(caller: AbortSignal | undefined, timeoutMs: number): TimeoutHandle {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const signal =
    caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]);
  return {
    signal,
    timedOut: () => expired,
    release: () => {
      clearTimeout(timer);
    },
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new LlmError(ErrorCode.LlmAborted, 'LLM request aborted', { retryable: false }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError(ErrorCode.LlmAborted, 'LLM request aborted', { retryable: false }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readHttpFailure(response: Response): Promise<HttpFailure> {
  let providerCode: string | undefined;
  let serverMessage: string | undefined;
  try {
    const text = await response.text();
    const parsed = apiErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const code = parsed.data.error.code;
      providerCode = code === undefined || code === null ? undefined : String(code);
      serverMessage = parsed.data.error.message ?? undefined;
    } else {
      serverMessage = text.slice(0, 500);
    }
  } catch {
    // 错误体不可读时仍按 HTTP 状态码分类，不掩盖原始失败
  }
  return { status: response.status, providerCode, serverMessage };
}

function parsePayload<T>(text: string, schema: ZodType<T>, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw badResponseError(`${label} is not valid JSON`, error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw badResponseError(`${label} failed validation (${detail})`, parsed.error);
  }
  return parsed.data;
}

function toUsage(wire: ChatCompletion['usage']): TokenUsage {
  if (wire === undefined || wire === null) {
    return EMPTY_USAGE;
  }
  return {
    promptTokens: wire.prompt_tokens ?? 0,
    completionTokens: wire.completion_tokens ?? 0,
    totalTokens: wire.total_tokens ?? 0,
    reasoningTokens: wire.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: wire.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function toChatResponse(
  parsed: ChatCompletion,
  fallbackModel: string,
  logger?: Logger,
): ChatResponse {
  const choice = parsed.choices[0];
  if (choice === undefined) {
    throw badResponseError('choices[0] is missing');
  }
  const reasoning = choice.message.reasoning_content;
  const toolCalls = (choice.message.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? fallbackToolCallId(logger, index),
    name: call.function.name,
    arguments: call.function.arguments,
  }));
  return {
    content: choice.message.content ?? '',
    reasoningContent:
      reasoning === undefined || reasoning === null || reasoning === '' ? undefined : reasoning,
    finishReason: choice.finish_reason ?? 'unknown',
    usage: toUsage(parsed.usage),
    model: parsed.model ?? fallbackModel,
    toolCalls,
  };
}

function finalizeToolCalls(
  buckets: ReadonlyMap<
    number,
    { readonly id: string | undefined; readonly name: string; readonly arguments: string }
  >,
  logger: Logger | undefined,
): ToolCall[] {
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, call]) => call.name !== '')
    .map(([index, call]) => ({
      id: call.id ?? fallbackToolCallId(logger, index),
      name: call.name,
      arguments: call.arguments,
    }));
}

/** 确定性兜底：同一响应内按 index 唯一，模型回传 tool_call_id 时可对应 */
function fallbackToolCallId(logger: Logger | undefined, index: number): string {
  const id = `call_${index}`;
  logger?.warn({ index, id }, 'tool call without id, generated fallback id');
  return id;
}
