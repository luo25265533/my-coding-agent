import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared/errors.js';
import { LlmError } from '../../src/llm/errors.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import type { ChatMessage, StreamChunk } from '../../src/llm/types.js';

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks: readonly StreamChunk[], type: 'reasoning' | 'content'): string {
  return chunks
    .filter((chunk) => chunk.type === type)
    .map((chunk) => (chunk.type === 'done' ? '' : chunk.text))
    .join('');
}

const history: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];

describe('mock provider chat', () => {
  it('缺省回显最后一条 user 消息，便于断言多轮上下文', async () => {
    const provider = createMockProvider();
    const response = await provider.chat({ messages: history });
    expect(response.content).toBe('echo: hi');
    expect(response.finishReason).toBe('stop');
    expect(response.model).toBe('mock-model');
    expect(response.reasoningContent).toBeUndefined();
  });

  it('取最后一条 user 而非第一条', async () => {
    const provider = createMockProvider();
    const response = await provider.chat({
      messages: [
        ...history,
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(response.content).toBe('echo: second');
  });

  it('固定 reply 覆盖回显', async () => {
    const provider = createMockProvider({ reply: 'fixed answer' });
    expect((await provider.chat({ messages: history })).content).toBe('fixed answer');
  });

  it('reasoning 选项产出独立思考流', async () => {
    const provider = createMockProvider({ reply: 'body', reasoning: 'think' });
    const response = await provider.chat({ messages: history });
    expect(response.content).toBe('body');
    expect(response.reasoningContent).toBe('think');
  });

  it('用量按字符数确定可断言', async () => {
    const provider = createMockProvider({ reply: 'abcd', reasoning: 'xy' });
    const response = await provider.chat({ messages: history });
    expect(response.usage.promptTokens).toBe('sys'.length + 'hi'.length);
    expect(response.usage.completionTokens).toBe(4);
    expect(response.usage.reasoningTokens).toBe(2);
    expect(response.usage.totalTokens).toBe(5 + 4);
    expect(response.usage.cachedTokens).toBe(0);
  });

  it('req.model 覆盖默认模型名', async () => {
    const provider = createMockProvider();
    expect((await provider.chat({ messages: history, model: 'custom' })).model).toBe('custom');
  });

  it('无 user 消息时回显空串而不抛错', async () => {
    const provider = createMockProvider();
    expect((await provider.chat({ messages: [{ role: 'system', content: 's' }] })).content).toBe(
      'echo: ',
    );
  });

  it('已中止的信号立即抛 LlmAborted', async () => {
    const provider = createMockProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.chat({ messages: history, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: ErrorCode.LlmAborted,
    });
  });
});

describe('mock provider stream', () => {
  it('分块拼接后等于完整正文，并以 done 收尾', async () => {
    const provider = createMockProvider({ reply: 'hello world' });
    const chunks = await collect(provider.stream({ messages: history }));
    expect(textOf(chunks, 'content')).toBe('hello world');
    expect(chunks.at(-1)?.type).toBe('done');
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('思考流先于正文，且两者分离', async () => {
    const provider = createMockProvider({ reply: 'body', reasoning: 'thinking' });
    const chunks = await collect(provider.stream({ messages: history }));
    const firstContent = chunks.findIndex((chunk) => chunk.type === 'content');
    const lastReasoning = chunks.map((c) => c.type).lastIndexOf('reasoning');
    expect(lastReasoning).toBeLessThan(firstContent);
    expect(textOf(chunks, 'reasoning')).toBe('thinking');
    expect(textOf(chunks, 'content')).toBe('body');
  });

  it('done 携带与非流式一致的响应', async () => {
    const provider = createMockProvider({ reply: 'same' });
    const streamed = await provider.chat({ messages: history });
    const chunks = await collect(provider.stream({ messages: history }));
    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.response).toEqual(streamed);
    }
  });

  it('无 reasoning 时不产出 reasoning 分块', async () => {
    const provider = createMockProvider({ reply: 'x' });
    const chunks = await collect(provider.stream({ messages: history }));
    expect(chunks.some((chunk) => chunk.type === 'reasoning')).toBe(false);
  });

  it('已中止的信号抛 LlmAborted', async () => {
    const provider = createMockProvider({ reply: 'long enough to split' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(provider.stream({ messages: history, signal: controller.signal })),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('飞行途中中止会停下（脚本模式同样生效）', async () => {
    const provider = createMockProvider({ reply: 'abcdefghijklmnop' });
    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.stream({
          messages: history,
          signal: controller.signal,
        })) {
          seen.push(chunk);
          if (seen.length === 2) {
            controller.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
    expect(seen.length).toBeLessThan(5);
  });
});

describe('mock provider 脚本化', () => {
  it('按步骤返回工具调用与回答，脚本用尽后返回空正文', async () => {
    const provider = createMockProvider({
      script: [
        { reasoning: 'think', toolCalls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] },
        { content: 'final' },
      ],
    });

    const first = await provider.chat({ messages: history });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.content).toBe('');
    expect(first.reasoningContent).toBe('think');
    expect(first.toolCalls).toEqual([
      { id: 'mock-call-0-0', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ]);
    expect(first.usage.completionTokens).toBe('{"path":"a.txt"}'.length);

    const second = await provider.chat({ messages: history });
    expect(second.finishReason).toBe('stop');
    expect(second.content).toBe('final');
    expect(second.toolCalls).toEqual([]);

    const exhausted = await provider.chat({ messages: history });
    expect(exhausted.content).toBe('');
    expect(exhausted.finishReason).toBe('stop');
    expect(exhausted.toolCalls).toEqual([]);
  });

  it('流式脚本在 done 中携带工具调用', async () => {
    const provider = createMockProvider({
      script: [{ content: 'body', toolCalls: [{ name: 'x', arguments: '{}' }] }],
    });
    const chunks = await collect(provider.stream({ messages: history }));
    expect(textOf(chunks, 'content')).toBe('body');
    const done = chunks.at(-1);
    if (done?.type !== 'done') {
      throw new Error('missing done chunk');
    }
    expect(done.response.toolCalls).toEqual([{ id: 'mock-call-0-0', name: 'x', arguments: '{}' }]);
    expect(done.response.finishReason).toBe('tool_calls');
  });

  it('无脚本时保持回显且 toolCalls 为空', async () => {
    const response = await createMockProvider().chat({ messages: history });
    expect(response.content).toBe('echo: hi');
    expect(response.toolCalls).toEqual([]);
  });
});
