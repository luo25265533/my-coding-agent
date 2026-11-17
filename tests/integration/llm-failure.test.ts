import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, runCliAsync, type TestWorkspace } from './helpers.js';

interface FakeReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly raw?: string;
  readonly delayMs?: number;
}

interface FakeLlm {
  readonly baseUrl: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

function completion(content: string): unknown {
  return {
    id: 'fake-completion',
    model: 'fake-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

async function startFakeLlm(reply: (requestIndex: number) => FakeReply): Promise<FakeLlm> {
  let count = 0;
  const server: Server = createServer((request, response) => {
    count += 1;
    const index = count;
    // 请求体读到结束再响应，避免客户端提前断开
    request.resume();
    request.on('end', () => {
      const next = reply(index);
      setTimeout(() => {
        if (response.writableEnded) {
          return;
        }
        response.statusCode = next.status ?? 200;
        response.setHeader('content-type', 'application/json');
        response.end(next.raw ?? JSON.stringify(next.json ?? {}));
      }, next.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => count,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

let workspace: TestWorkspace;
let fake: FakeLlm | undefined;

beforeEach(() => {
  workspace = createWorkspace('agent-llm-failure-');
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await workspace.cleanup();
});

function apiEnv(fakeLlm: FakeLlm, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: fakeLlm.baseUrl,
    LLM_API_KEY: 'test-key-value',
    LLM_MODEL: 'fake-model',
    ...extra,
  };
}

describe('LLM 异常场景端到端（本地假端点，不联网）', () => {
  it('HTTP 500 后重试成功', async () => {
    fake = await startFakeLlm((index) =>
      index === 1
        ? { status: 500, json: { error: { message: 'temporary failure' } } }
        : { json: completion('recovered') },
    );

    const run = await runCliAsync(workspace.dir, ['run', '--no-plan', '--yes', '重试'], {
      ...apiEnv(fake),
      LLM_MAX_RETRIES: '2',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('recovered');
    expect(fake.requests()).toBe(2);
  }, 60_000);

  it('429 配额耗尽不重试，错误不含密钥', async () => {
    fake = await startFakeLlm(() => ({
      status: 429,
      json: { error: { code: '1113', message: 'quota exhausted' } },
    }));

    const run = await runCliAsync(workspace.dir, ['run', '--no-plan', '--yes', '配额'], {
      ...apiEnv(fake),
      LLM_MAX_RETRIES: '3',
    });

    expect(run.status).toBe(1);
    expect(fake.requests()).toBe(1);
    expect(run.stderr).toContain('quota exhausted');
    expect(run.stderr).not.toContain('test-key-value');
    expect(run.stdout).not.toContain('test-key-value');
  }, 60_000);

  it('请求超时按运行时错误退出', async () => {
    // 超时留在数百毫秒级：覆盖率插桩和并行用例下，50ms 可能早于请求到达本地端点
    fake = await startFakeLlm(() => ({ delayMs: 2_000, json: completion('too late') }));

    const run = await runCliAsync(workspace.dir, ['run', '--no-plan', '--yes', '超时'], {
      ...apiEnv(fake),
      LLM_TIMEOUT_MS: '500',
      LLM_MAX_RETRIES: '0',
    });

    expect(run.status).toBe(1);
    expect(fake.requests()).toBe(1);
    expect(run.stderr).toContain('timed out');
    expect(run.stderr).not.toContain('test-key-value');
  }, 60_000);

  it('非法响应体不重试并给出可读错误', async () => {
    fake = await startFakeLlm(() => ({ raw: 'not a completion payload' }));

    const run = await runCliAsync(workspace.dir, ['run', '--no-plan', '--yes', '坏响应'], {
      ...apiEnv(fake),
      LLM_MAX_RETRIES: '2',
    });

    expect(run.status).toBe(1);
    expect(fake.requests()).toBe(1);
    expect(run.stderr).toContain('not valid JSON');
  }, 60_000);
});
