import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCommand, DEFAULT_SYSTEM_PROMPT } from '../../src/cli/commands/chat.js';
import { LlmError } from '../../src/llm/errors.js';
import { createLLMProvider } from '../../src/llm/factory.js';
import type * as FactoryModule from '../../src/llm/factory.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import {
  EMPTY_USAGE,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StreamChunk,
} from '../../src/llm/types.js';
import { ErrorCode } from '../../src/shared/errors.js';

vi.mock('../../src/llm/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryModule>();
  return { ...actual, createLLMProvider: vi.fn(actual.createLLMProvider) };
});

vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

import { createInterface } from 'node:readline/promises';

interface FakeReadlineOptions {
  readonly delayMs?: number;
}

/** 假的 readline 接口：按脚本产出行，支持 close 与 SIGINT 处理器 */
function fakeReadline(lines: readonly string[], options: FakeReadlineOptions = {}) {
  let closed = false;
  const handlers: (() => void)[] = [];
  const iface = {
    on(event: string, handler: () => void): void {
      if (event === 'SIGINT') {
        handlers.push(handler);
      }
    },
    close(): void {
      closed = true;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (const line of lines) {
        if (closed) {
          return;
        }
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        if (closed) {
          return;
        }
        yield line;
      }
    },
  };
  return {
    iface,
    fireSigint(): void {
      for (const handler of handlers) {
        handler();
      }
    },
  };
}

function response(content: string): ChatResponse {
  return {
    content,
    reasoningContent: undefined,
    finishReason: 'stop',
    usage: EMPTY_USAGE,
    model: 'fake-model',
    toolCalls: [],
  };
}

/** 记录收到的历史，便于断言 system 提示与多轮上下文 */
function recordingProvider(reply: string): { provider: LLMProvider; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const provider: LLMProvider = {
    name: 'recording',
    chat(req: ChatRequest): Promise<ChatResponse> {
      calls.push(req);
      return Promise.resolve(response(reply));
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      calls.push(req);
      await Promise.resolve();
      yield { type: 'content', text: reply };
      yield { type: 'done', response: response(reply) };
    },
  };
  return { provider, calls };
}

/** 一直挂起直到被中止，用于验证 Ctrl+C 只打断本轮 */
function hangingProvider(): LLMProvider {
  return {
    name: 'hanging',
    chat(): Promise<ChatResponse> {
      return new Promise(() => {});
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      await new Promise<void>((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          reject(new LlmError(ErrorCode.LlmAborted, 'LLM request aborted', { retryable: false }));
        });
      });
      yield { type: 'done', response: response('never') };
    },
  };
}

let workspace: string;
let stdout: string[];
let stderr: string[];
let timers: number[];

function useReadline(lines: readonly string[], options: FakeReadlineOptions = {}) {
  const fake = fakeReadline(lines, options);
  vi.mocked(createInterface).mockReturnValue(fake.iface as never);
  return fake;
}

function later(ms: number, action: () => void): void {
  timers.push(Number(setTimeout(action, ms)));
}

function logLines(): Record<string, unknown>[] {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(workspace, 'logs', `agent-${date}.jsonl`);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function out(): string {
  return stdout.join('');
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-chat-unit-'));
  stdout = [];
  stderr = [];
  timers = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.stubEnv('AGENT_WORKSPACE', workspace);
  vi.stubEnv('AGENT_LOG_DIR', 'logs');
  vi.stubEnv('AGENT_LOG_PRETTY', 'false');
  vi.stubEnv('AGENT_LOG_LEVEL', 'info');
  vi.stubEnv('LLM_PROVIDER', 'mock');
  vi.stubEnv('LLM_API_KEY', '');
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('LLM_MODEL', '');
});

afterEach(async () => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(createLLMProvider).mockReset();
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('chatCommand 编排', () => {
  it('多轮对话推进并返回轮次与日志路径', async () => {
    useReadline(['hello', 'world', '/exit']);
    const result = await chatCommand({});

    expect(result.turns).toBe(2);
    expect(result.logFile).toContain(workspace);
    expect(out()).toContain('echo: hello');
    expect(out()).toContain('echo: world');
    expect(out()).toContain('[tokens] prompt=');
    expect(stderr.join('')).toBe('');

    const lines = logLines();
    expect(lines.some((line) => line.msg === 'chat started')).toBe(true);
    expect(lines.find((line) => line.msg === 'chat finished')?.turns).toBe(2);
    expect(lines.every((line) => line.runId === result.runId)).toBe(true);
  });

  it('/help 打印命令且不推进轮次', async () => {
    useReadline(['/help', '/exit']);
    const result = await chatCommand({});
    expect(result.turns).toBe(0);
    expect(out()).toContain('/clear');
  });

  it('/clear 重置历史，用量回到初始水平', async () => {
    useReadline(['aa', 'bb', '/clear', 'cc', '/exit']);
    const result = await chatCommand({});

    expect(result.turns).toBe(3);
    expect(out()).toContain('history cleared');
    const prompts = logLines()
      .filter((line) => line.msg === 'turn completed')
      .map((line) => (line.usage as { promptTokens: number }).promptTokens);
    expect(prompts[1]).toBeGreaterThan(prompts[0] ?? 0);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it('空行与纯空白被忽略', async () => {
    useReadline(['', '   ', 'hi', '/exit']);
    const result = await chatCommand({});
    expect(result.turns).toBe(1);
    expect(out()).toContain('echo: hi');
  });

  it('脚本行耗尽（EOF）时优雅收尾并写出 chat finished', async () => {
    useReadline(['only turn']);
    const result = await chatCommand({});
    expect(result.turns).toBe(1);
    expect(logLines().find((line) => line.msg === 'chat finished')?.turns).toBe(1);
  });

  it('/quit 与 /exit 等价', async () => {
    useReadline(['hi', '/quit']);
    expect((await chatCommand({})).turns).toBe(1);
  });

  it('缺省 system 提示进入历史首条', async () => {
    useReadline(['q', '/exit']);
    const { provider, calls } = recordingProvider('answer');
    vi.mocked(createLLMProvider).mockReturnValue(provider);
    await chatCommand({});
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  });

  it('--system 覆盖默认提示', async () => {
    useReadline(['q', '/exit']);
    const { provider, calls } = recordingProvider('answer');
    vi.mocked(createLLMProvider).mockReturnValue(provider);
    await chatCommand({ system: 'custom system prompt' });
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: 'custom system prompt' });
  });

  it('--model 覆盖配置并显示在横幅', async () => {
    useReadline(['/exit']);
    await chatCommand({ model: 'custom-model' });
    expect(out()).toContain('model: custom-model');
  });

  it('思考流带 [thinking] 前缀单独展示，不混入正文', async () => {
    useReadline(['q', '/exit']);
    vi.mocked(createLLMProvider).mockReturnValue(
      createMockProvider({ reply: 'body text', reasoning: 'deep thought' }),
    );
    await chatCommand({});
    const text = out();
    expect(text).toContain('[thinking] deep thought');
    expect(text).toContain('body text');
    expect(text.indexOf('deep thought')).toBeLessThan(text.indexOf('body text'));
  });

  it('单轮失败只写 stderr，REPL 继续推进', async () => {
    useReadline(['first', 'second', '/exit']);
    let attempt = 0;
    const provider: LLMProvider = {
      name: 'flaky',
      chat(): Promise<ChatResponse> {
        return Promise.reject(new Error('unused'));
      },
      async *stream(): AsyncIterable<StreamChunk> {
        await Promise.resolve();
        attempt += 1;
        if (attempt === 1) {
          throw new LlmError(ErrorCode.LlmNetwork, 'connection reset', { retryable: true });
        }
        yield { type: 'content', text: 'recovered' };
        yield { type: 'done', response: response('recovered') };
      },
    };
    vi.mocked(createLLMProvider).mockReturnValue(provider);

    const result = await chatCommand({});
    expect(result.turns).toBe(2);
    expect(stderr.join('')).toContain('connection reset');
    expect(out()).toContain('recovered');
    expect(logLines().filter((line) => line.msg === 'turn failed')).toHaveLength(1);
  });

  it('Ctrl+C 中止在飞请求，只打断本轮而不退出', async () => {
    const fake = useReadline(['hello', '/exit']);
    vi.mocked(createLLMProvider).mockReturnValue(hangingProvider());
    later(20, () => fake.fireSigint());

    const result = await chatCommand({});
    expect(result.turns).toBe(1);
    expect(stderr.join('')).toContain('aborted');
    expect(logLines().filter((line) => line.msg === 'turn failed')).toHaveLength(1);
    expect(logLines().find((line) => line.msg === 'chat finished')?.turns).toBe(1);
  });

  it('空闲时 Ctrl+C 关闭接口并退出循环', async () => {
    const fake = useReadline(['never processed'], { delayMs: 60 });
    later(20, () => fake.fireSigint());

    const result = await chatCommand({});
    expect(result.turns).toBe(0);
    expect(logLines().find((line) => line.msg === 'chat finished')?.turns).toBe(0);
  });
});
