import { describe, expect, it } from 'vitest';
import { resolveCommand, streamTurn } from '../../src/cli/commands/chat.js';
import { LlmError } from '../../src/llm/errors.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StreamChunk,
} from '../../src/llm/types.js';
import { ErrorCode } from '../../src/shared/errors.js';

const SYSTEM: ChatMessage = { role: 'system', content: 'you are helpful' };

function response(content: string): ChatResponse {
  return {
    content,
    reasoningContent: undefined,
    finishReason: 'stop',
    usage: EMPTY_USAGE,
    model: 'scripted-model',
    toolCalls: [],
  };
}

interface ProviderCall {
  readonly messages: readonly ChatMessage[];
  readonly signal: AbortSignal | undefined;
}

/** 产出给定分块后（可选）抛错的 provider，同时记录每次调用收到的历史快照 */
function scripted(
  chunks: readonly StreamChunk[],
  error?: Error,
): { provider: LLMProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const provider: LLMProvider = {
    name: 'scripted',
    chat(_req: ChatRequest): Promise<ChatResponse> {
      return Promise.reject(new Error('chat is not used by the REPL'));
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      calls.push({ messages: [...req.messages], signal: req.signal });
      for (const chunk of chunks) {
        // 让出微任务，使中止与提前 break 能在分块之间被观察到
        await Promise.resolve();
        yield chunk;
      }
      if (error !== undefined) {
        throw error;
      }
    },
  };
  return { provider, calls };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('resolveCommand', () => {
  it('/exit 与 /quit 都退出', () => {
    expect(resolveCommand('/exit')).toBe('exit');
    expect(resolveCommand('/quit')).toBe('exit');
  });

  it('/help 与 /clear 各自成命令', () => {
    expect(resolveCommand('/help')).toBe('help');
    expect(resolveCommand('/clear')).toBe('clear');
  });

  it('普通文本与未知斜杠命令都当作消息', () => {
    expect(resolveCommand('hello')).toBe('message');
    expect(resolveCommand('/unknown')).toBe('message');
    expect(resolveCommand('')).toBe('message');
  });

  it('不做大小写与空白归一化，交由调用方 trim', () => {
    expect(resolveCommand('/EXIT')).toBe('message');
    expect(resolveCommand('/exit ')).toBe('message');
  });
});

describe('streamTurn 历史语义', () => {
  it('按序写入 user 与 assistant 正文', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const provider = createMockProvider();
    await collect(streamTurn(provider, history, 'hello'));
    expect(history).toEqual([
      SYSTEM,
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'echo: hello' },
    ]);
  });

  it('思考流单独产出但不写入历史', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const provider = createMockProvider({ reply: 'body text', reasoning: 'deep thought' });
    const chunks = await collect(streamTurn(provider, history, 'q'));

    expect(chunks.some((chunk) => chunk.type === 'reasoning')).toBe(true);
    expect(history).toEqual([
      SYSTEM,
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'body text' },
    ]);
    expect(JSON.stringify(history)).not.toContain('deep thought');
  });

  it('把含 system 与本轮 user 的完整历史交给 provider', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const { provider, calls } = scripted([
      { type: 'content', text: 'ok' },
      { type: 'done', response: response('ok') },
    ]);
    await collect(streamTurn(provider, history, 'first'));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([SYSTEM, { role: 'user', content: 'first' }]);
  });

  it('多轮共享同一历史数组，第二轮能看到上一轮回复', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const { provider, calls } = scripted([{ type: 'done', response: response('answer') }]);
    await collect(streamTurn(provider, history, 'first'));
    await collect(streamTurn(provider, history, 'second'));

    expect(calls[1]?.messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
    expect(history).toHaveLength(5);
  });

  it('原样透传 signal 与 done 分块', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const controller = new AbortController();
    const final = response('done body');
    const { provider, calls } = scripted([{ type: 'done', response: final }]);
    const chunks = await collect(streamTurn(provider, history, 'q', controller.signal));

    expect(calls[0]?.signal).toBe(controller.signal);
    expect(chunks).toEqual([{ type: 'done', response: final }]);
  });
});

describe('streamTurn 失败回滚', () => {
  it('流中途报错时回滚本轮 user 消息', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const { provider } = scripted(
      [{ type: 'content', text: 'partial' }],
      new LlmError(ErrorCode.LlmNetwork, 'connection reset', { retryable: true }),
    );

    await expect(collect(streamTurn(provider, history, 'q'))).rejects.toMatchObject({
      code: ErrorCode.LlmNetwork,
    });
    expect(history).toEqual([SYSTEM]);
  });

  it('飞行途中中止会停下并回滚', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const provider = createMockProvider({ reply: 'a long enough reply to be split' });
    const controller = new AbortController();

    const consume = (async () => {
      for await (const chunk of streamTurn(provider, history, 'q', controller.signal)) {
        if (chunk.type === 'content') {
          controller.abort();
        }
      }
    })();

    await expect(consume).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
    expect(history).toEqual([SYSTEM]);
  });

  it('缺少 done 分块时抛 LlmBadResponse 并回滚', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const { provider } = scripted([{ type: 'content', text: 'no terminator' }]);

    await expect(collect(streamTurn(provider, history, 'q'))).rejects.toMatchObject({
      code: ErrorCode.LlmBadResponse,
    });
    expect(history).toEqual([SYSTEM]);
  });

  it('消费者提前 break 时也回滚，不留半截历史', async () => {
    const history: ChatMessage[] = [SYSTEM];
    const { provider } = scripted([
      { type: 'content', text: 'first' },
      { type: 'content', text: 'second' },
      { type: 'done', response: response('firstsecond') },
    ]);

    for await (const chunk of streamTurn(provider, history, 'q')) {
      if (chunk.type === 'content') {
        break;
      }
    }
    expect(history).toEqual([SYSTEM]);
  });

  it('回滚只弹出本轮 user，不影响既有历史', async () => {
    const history: ChatMessage[] = [
      SYSTEM,
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const { provider } = scripted(
      [],
      new LlmError(ErrorCode.LlmBadResponse, 'boom', { retryable: false }),
    );

    await expect(collect(streamTurn(provider, history, 'now'))).rejects.toThrow('boom');
    expect(history).toHaveLength(3);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'earlier answer' });
  });
});
