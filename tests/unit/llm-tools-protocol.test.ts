import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleOptions,
} from '../../src/llm/providers/openai-compatible/client.js';
import type { ChatMessage, LLMProvider, StreamChunk, ToolSpec } from '../../src/llm/types.js';

const BASE_URL = 'https://api.example.com/v4';

const fetchMock = vi.fn<typeof fetch>();

function makeProvider(overrides: Partial<OpenAiCompatibleOptions> = {}): LLMProvider {
  return createOpenAiCompatibleProvider({
    baseUrl: BASE_URL,
    apiKey: 'unit-test-placeholder-key',
    model: 'test-model',
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    random: () => 0.5,
    ...overrides,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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

function sse(delta: Record<string, unknown>, finishReason?: string): string {
  const choice: Record<string, unknown> = { index: 0, delta };
  if (finishReason !== undefined) {
    choice.finish_reason = finishReason;
  }
  return `data: ${JSON.stringify({ model: 'glm-5.3', choices: [choice] })}\n\n`;
}

function requestBody(index = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch call ${index} missing`);
  }
  const body = call[1]?.body;
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

const TOOL_SPEC: ToolSpec = {
  name: 'read_file',
  description: 'read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('请求体：工具与工具消息映射', () => {
  it('发送 tools 与四种消息形态', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file body' },
    ];

    await makeProvider().chat({ messages, tools: [TOOL_SPEC] });
    const body = requestBody();

    expect(body.tools).toEqual([{ type: 'function', function: TOOL_SPEC }]);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ]);
  });

  it('无工具时不发送 tools 字段；assistant 普通消息保留正文', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await makeProvider().chat({
      messages: [{ role: 'assistant', content: 'previous answer' }],
    });
    const body = requestBody();
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'assistant', content: 'previous answer' }]);
  });
});

describe('非流式 tool_calls 解析', () => {
  it('解析调用列表并允许 content 为空字符串', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: 'glm-5.3',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_-707',
                  index: 0,
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"package.json"}' },
                },
              ],
            },
          },
        ],
      }),
    );

    const response = await makeProvider().chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.content).toBe('');
    expect(response.toolCalls).toEqual([
      { id: 'call_-707', name: 'read_file', arguments: '{"path":"package.json"}' },
    ]);
  });

  it('缺少 id 时生成确定性兜底 id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [{ function: { name: 'list_files', arguments: '{}' } }],
            },
          },
        ],
      }),
    );

    const response = await makeProvider().chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(response.toolCalls).toEqual([{ id: 'call_0', name: 'list_files', arguments: '{}' }]);
  });

  it('普通回答的 toolCalls 为空数组', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }),
    );
    const response = await makeProvider().chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(response.toolCalls).toEqual([]);
  });
});

describe('流式 tool_calls 累积', () => {
  it('按 index 拼接被切分的 name 与 arguments', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sse({
          tool_calls: [
            {
              index: 0,
              id: 'call_9',
              type: 'function',
              function: { name: 'read_', arguments: '{"pa' },
            },
          ],
        }),
        sse({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.txt"}' } }] }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collect(
      makeProvider().stream({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const last = chunks.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type !== 'done') {
      throw new Error('missing done chunk');
    }
    expect(last.response.toolCalls).toEqual([
      { id: 'call_9', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ]);
    expect(last.response.finishReason).toBe('tool_calls');
    expect(last.response.content).toBe('');
    // 阶段 3 不展示工具调用中间分片
    expect(chunks.filter((chunk) => chunk.type !== 'done')).toEqual([]);
  });

  it('流式缺少 id 时使用确定性兜底 id', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sse({ tool_calls: [{ index: 0, function: { name: 'list_files', arguments: '{}' } }] }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collect(
      makeProvider().stream({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const last = chunks.at(-1);
    if (last?.type !== 'done') {
      throw new Error('missing done chunk');
    }
    expect(last.response.toolCalls).toEqual([
      { id: 'call_0', name: 'list_files', arguments: '{}' },
    ]);
  });

  it('空 name 的工具调用分片被丢弃', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sse({ tool_calls: [{ index: 0, function: { name: '', arguments: '' } }] }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collect(
      makeProvider().stream({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const last = chunks.at(-1);
    if (last?.type !== 'done') {
      throw new Error('missing done chunk');
    }
    expect(last.response.toolCalls).toEqual([]);
  });

  it('多个 index 并行累积并按 index 排序', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sse({
          tool_calls: [
            { index: 1, id: 'b', function: { name: 'search_code', arguments: '{"pattern":"x"}' } },
          ],
        }),
        sse({
          tool_calls: [{ index: 0, id: 'a', function: { name: 'list_files', arguments: '{}' } }],
        }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = await collect(
      makeProvider().stream({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const last = chunks.at(-1);
    if (last?.type !== 'done') {
      throw new Error('missing done chunk');
    }
    expect(last.response.toolCalls.map((call) => call.name)).toEqual(['list_files', 'search_code']);
  });
});
