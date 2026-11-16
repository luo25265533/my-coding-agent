import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../src/shared/errors.js';
import {
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleOptions,
} from '../../src/llm/providers/openai-compatible/client.js';
import type { ChatMessage, LLMProvider, StreamChunk } from '../../src/llm/types.js';

const KEY = 'unit-test-placeholder-key';
const BASE_URL = 'https://api.example.com/v4';

const COMPLETION = {
  choices: [
    {
      finish_reason: 'stop',
      index: 0,
      message: { role: 'assistant', content: '42', reasoning_content: 'thinking' },
    },
  ],
  model: 'glm-5.3',
  usage: {
    prompt_tokens: 51,
    completion_tokens: 17,
    total_tokens: 68,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 14 },
  },
};

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const fetchMock = vi.fn<typeof fetch>();

function makeProvider(overrides: Partial<OpenAiCompatibleOptions> = {}): LLMProvider {
  return createOpenAiCompatibleProvider({
    baseUrl: BASE_URL,
    apiKey: KEY,
    model: 'test-model',
    timeoutMs: 5000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    random: () => 0.5,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ model: 'glm-5.3', choices: [{ index: 0, delta }], ...extra })}\n\n`;
}

function requestInit(index = 0): RequestInit {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call[1] ?? {};
}

function requestBody(index = 0): Record<string, unknown> {
  const body = requestInit(index).body;
  if (typeof body !== 'string') {
    throw new Error('expected string body');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const item of iterable) {
    chunks.push(item);
  }
  return chunks;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('chat 请求构造', () => {
  it('URL 拼接去掉 baseUrl 末尾斜杠', async () => {
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    await makeProvider({ baseUrl: `${BASE_URL}///` }).chat({ messages: MESSAGES });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/chat/completions`);
  });

  it('携带 Bearer 鉴权与 JSON content-type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    await makeProvider().chat({ messages: MESSAGES });
    const headers = new Headers(requestInit().headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('请求体含 model/messages/stream=false', async () => {
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    await makeProvider().chat({ messages: MESSAGES });
    const body = requestBody();
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('temperature 与 maxTokens 仅在提供时出现', async () => {
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    await makeProvider().chat({ messages: MESSAGES });
    expect(requestBody()).not.toHaveProperty('temperature');
    expect(requestBody()).not.toHaveProperty('max_tokens');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    await makeProvider().chat({
      messages: MESSAGES,
      temperature: 0.2,
      maxTokens: 64,
      model: 'override',
    });
    const body = requestBody();
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(64);
    expect(body.model).toBe('override');
  });
});

describe('chat 响应映射', () => {
  it('完整映射正文、思考流、finishReason 与用量明细', async () => {
    fetchMock.mockResolvedValue(jsonResponse(COMPLETION));
    const response = await makeProvider().chat({ messages: MESSAGES });
    expect(response.content).toBe('42');
    expect(response.reasoningContent).toBe('thinking');
    expect(response.finishReason).toBe('stop');
    expect(response.model).toBe('glm-5.3');
    expect(response.usage).toEqual({
      promptTokens: 51,
      completionTokens: 17,
      totalTokens: 68,
      reasoningTokens: 14,
      cachedTokens: 3,
    });
  });

  it('缺 usage 时用量归零而非抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    const response = await makeProvider().chat({ messages: MESSAGES });
    expect(response.usage.totalTokens).toBe(0);
    expect(response.model).toBe('test-model');
    expect(response.finishReason).toBe('unknown');
  });

  it('content 为 null 时映射为空串', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: null } }] }));
    expect((await makeProvider().chat({ messages: MESSAGES })).content).toBe('');
  });

  it('空 reasoning_content 归一为 undefined', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'x', reasoning_content: '' } }] }),
    );
    expect((await makeProvider().chat({ messages: MESSAGES })).reasoningContent).toBeUndefined();
  });
});

describe('错误分类与重试', () => {
  it('401 不重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: '401', message: 'bad key' } }, 401));
    await expect(makeProvider().chat({ messages: MESSAGES })).rejects.toMatchObject({
      code: ErrorCode.LlmAuth,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 + 1113 配额耗尽不重试', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } }, 429),
    );
    await expect(makeProvider().chat({ messages: MESSAGES })).rejects.toMatchObject({
      code: ErrorCode.LlmQuota,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 限流会重试并最终成功', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: '1302', message: 'slow down' } }, 429))
      .mockResolvedValueOnce(jsonResponse(COMPLETION));
    const response = await makeProvider().chat({ messages: MESSAGES });
    expect(response.content).toBe('42');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx 会重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 503))
      .mockResolvedValueOnce(jsonResponse(COMPLETION));
    await makeProvider().chat({ messages: MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('400 不重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: '400', message: 'bad' } }, 400));
    await expect(makeProvider().chat({ messages: MESSAGES })).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('超过 maxRetries 后抛出最后一次错误', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500));
    await expect(
      makeProvider({ maxRetries: 2 }).chat({ messages: MESSAGES }),
    ).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 时只请求一次', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500));
    await expect(makeProvider({ maxRetries: 0 }).chat({ messages: MESSAGES })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络异常会重试', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(COMPLETION));
    await makeProvider().chat({ messages: MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('错误体非 JSON 时仍按状态码分类', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    await expect(
      makeProvider({ maxRetries: 0 }).chat({ messages: MESSAGES }),
    ).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
      status: 502,
    });
  });

  it('Retry-After 存在时仍完成重试', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'slow' } }, 429, { 'retry-after': '1' }),
      )
      .mockResolvedValueOnce(jsonResponse(COMPLETION));
    await makeProvider({ retryMaxDelayMs: 5 }).chat({ messages: MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('超时与中止', () => {
  it('超时归为 LlmTimeout', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(abortError());
          });
        }),
    );
    await expect(
      makeProvider({ timeoutMs: 20, maxRetries: 0 }).chat({ messages: MESSAGES }),
    ).rejects.toMatchObject({ code: ErrorCode.LlmTimeout });
  });

  it('调用方中止归为 LlmAborted 且不重试', async () => {
    fetchMock.mockRejectedValue(abortError());
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeProvider().chat({ messages: MESSAGES, signal: controller.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试等待期间中止会立即停下', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500));
    const controller = new AbortController();
    const promise = makeProvider({ retryBaseDelayMs: 5000, retryMaxDelayMs: 5000 }).chat({
      messages: MESSAGES,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('非法响应体', () => {
  it('非 JSON 归为 LlmBadResponse', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(makeProvider().chat({ messages: MESSAGES })).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
  });

  it('schema 不符归为 LlmBadResponse', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [] }));
    await expect(makeProvider().chat({ messages: MESSAGES })).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
  });
});

describe('流式', () => {
  it('reasoning 先于 content，done 携带完整用量', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        chunk({ role: 'assistant', reasoning_content: 'think' }),
        chunk({ content: '4' }),
        chunk({ content: '2' }),
        `data: ${JSON.stringify({
          model: 'glm-5.3',
          choices: [{ index: 0, finish_reason: 'stop', delta: { content: '' } }],
          usage: {
            prompt_tokens: 14,
            completion_tokens: 3,
            total_tokens: 17,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const chunks = await collect(makeProvider().stream({ messages: MESSAGES }));
    expect(chunks.map((c) => c.type)).toEqual(['reasoning', 'content', 'content', 'done']);
    const done = chunks.at(-1);
    if (done?.type === 'done') {
      expect(done.response.content).toBe('42');
      expect(done.response.reasoningContent).toBe('think');
      expect(done.response.finishReason).toBe('stop');
      expect(done.response.usage.reasoningTokens).toBe(5);
      expect(done.response.usage.totalTokens).toBe(17);
    }
  });

  it('请求体 stream=true 且 accept 为 event-stream', async () => {
    fetchMock.mockResolvedValue(sseResponse([chunk({ content: 'x' }), 'data: [DONE]\n\n']));
    await collect(makeProvider().stream({ messages: MESSAGES }));
    expect(requestBody().stream).toBe(true);
    expect(new Headers(requestInit().headers).get('accept')).toBe('text/event-stream');
  });

  it('事件跨分片截断仍能重组', async () => {
    const full = chunk({ content: 'hello' });
    fetchMock.mockResolvedValue(
      sseResponse([full.slice(0, 12), full.slice(12), 'data: [DONE]\n\n']),
    );
    const chunks = await collect(makeProvider().stream({ messages: MESSAGES }));
    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.response.content).toBe('hello');
    }
  });

  it('无 [DONE] 时靠流结束收尾', async () => {
    fetchMock.mockResolvedValue(sseResponse([chunk({ content: 'x' })]));
    const chunks = await collect(makeProvider().stream({ messages: MESSAGES }));
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('空 choices 心跳块被跳过', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"choices":[]}\n\n', chunk({ content: 'x' }), 'data: [DONE]\n\n']),
    );
    const chunks = await collect(makeProvider().stream({ messages: MESSAGES }));
    expect(chunks.map((c) => c.type)).toEqual(['content', 'done']);
  });

  it('首字节前的 5xx 会重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 500))
      .mockResolvedValueOnce(sseResponse([chunk({ content: 'x' }), 'data: [DONE]\n\n']));
    const chunks = await collect(makeProvider().stream({ messages: MESSAGES }));
    expect(chunks.at(-1)?.type).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('首字节后断流不重试，直接抛错', async () => {
    const encoder = new TextEncoder();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ content: 'partial' })));
        controller.error(new Error('connection lost'));
      },
    });
    fetchMock.mockResolvedValue(new Response(broken, { status: 200 }));
    await expect(collect(makeProvider().stream({ messages: MESSAGES }))).rejects.toMatchObject({
      code: ErrorCode.LlmNetwork,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('流式响应无 body 时报错', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(collect(makeProvider().stream({ messages: MESSAGES }))).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
  });

  it('非法分块 JSON 归为 LlmBadResponse', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {oops}\n\n']));
    await expect(collect(makeProvider().stream({ messages: MESSAGES }))).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
  });
});

describe('日志安全', () => {
  it('日志与错误消息均不含密钥', async () => {
    const records: string[] = [];
    const logger = {
      debug: (obj: unknown, msg: string) => records.push(JSON.stringify([obj, msg])),
      warn: (obj: unknown, msg: string) => records.push(JSON.stringify([obj, msg])),
      info: (obj: unknown, msg: string) => records.push(JSON.stringify([obj, msg])),
    } as unknown as Logger;

    fetchMock.mockResolvedValue(jsonResponse({ error: { code: '1113', message: 'quota' } }, 429));
    const error = await makeProvider({ logger })
      .chat({ messages: MESSAGES })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
    expect(records.join('\n')).not.toContain(KEY);
    expect(records.length).toBeGreaterThan(0);
  });
});
