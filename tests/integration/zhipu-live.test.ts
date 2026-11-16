import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../../src/agent/loop.js';
import { loadConfig } from '../../src/config/load.js';
import { createLLMProvider } from '../../src/llm/factory.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import type { ChatMessage, LLMProvider, StreamChunk } from '../../src/llm/types.js';
import { ErrorCode } from '../../src/shared/errors.js';

/**
 * 真实端点测试，默认跳过：只有显式设置 ZHIPU_LIVE_TEST=1 才执行。
 * 端点与密钥一律来自项目 .env / 环境变量，不在源码中出现。
 * 运行方式：ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
 */
const enabled = process.env.ZHIPU_LIVE_TEST === '1';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const TIMEOUT = 120_000;

function liveProvider(): LLMProvider {
  const config = loadConfig({ cwd: path.resolve(projectRoot) });
  if (config.llm.provider === 'mock') {
    throw new Error('ZHIPU_LIVE_TEST=1 requires LLM_PROVIDER=openai-compatible in .env');
  }
  return createLLMProvider(config);
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks: readonly StreamChunk[], type: 'content' | 'reasoning'): string {
  return chunks
    .filter((chunk) => chunk.type === type)
    .map((chunk) => (chunk.type === 'done' ? '' : chunk.text))
    .join('');
}

describe.skipIf(!enabled)('智谱真实端点（opt-in，会消耗配额）', () => {
  it(
    '非流式 chat 返回正文与用量',
    async () => {
      const provider = liveProvider();
      const response = await provider.chat({
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        maxTokens: 2048,
      });

      expect(response.content.length).toBeGreaterThan(0);
      expect(response.content.toUpperCase()).toContain('PONG');
      expect(response.model.length).toBeGreaterThan(0);
      expect(response.usage.promptTokens).toBeGreaterThan(0);
      expect(response.usage.completionTokens).toBeGreaterThan(0);
      expect(response.usage.totalTokens).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    '流式分块拼接后与 done 正文一致，思考流与正文分离',
    async () => {
      const provider = liveProvider();
      const chunks = await collect(
        provider.stream({
          messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces.' }],
          maxTokens: 2048,
        }),
      );

      const last = chunks.at(-1);
      expect(last?.type).toBe('done');
      if (last?.type !== 'done') {
        throw new Error('stream did not end with a done chunk');
      }
      expect(textOf(chunks, 'content')).toBe(last.response.content);
      expect(last.response.content).toContain('5');
      expect(last.response.usage.totalTokens).toBeGreaterThan(0);
      // 思考流只能出现在 reasoning 分块与 reasoningContent 中，不得混入正文
      expect(last.response.reasoningContent ?? '').toBe(textOf(chunks, 'reasoning'));
    },
    TIMEOUT,
  );

  it(
    '多轮对话能引用上一轮内容',
    async () => {
      const provider = liveProvider();
      const history: ChatMessage[] = [
        { role: 'system', content: 'You are a precise assistant. Answer with digits only.' },
        { role: 'user', content: 'Remember this number: 4271. Reply with OK only.' },
      ];
      const first = await provider.chat({ messages: history, maxTokens: 2048 });
      history.push({ role: 'assistant', content: first.content });
      history.push({ role: 'user', content: 'What number did I ask you to remember?' });

      const second = await provider.chat({ messages: history, maxTokens: 2048 });
      expect(second.content).toContain('4271');
      expect(second.usage.promptTokens).toBeGreaterThan(first.usage.promptTokens);
    },
    TIMEOUT,
  );

  it(
    '工具循环：模型自主调用 read_file 并基于文件内容作答',
    async () => {
      const provider = liveProvider();
      const workspace = mkdtempSync(path.join(tmpdir(), 'agent-live-tools-'));
      try {
        writeFileSync(path.join(workspace, 'facts.txt'), 'The access code is ORANGE-7319.\n');
        const result = await runAgentLoop('Read facts.txt and tell me the access code.', {
          provider,
          tools: createDefaultToolRegistry(),
          workspace,
          maxIterations: 4,
          signal: new AbortController().signal,
        });

        expect(result.stopReason).toBe('answer');
        expect(result.toolCalls).toBeGreaterThanOrEqual(1);
        expect(result.content).toContain('ORANGE-7319');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    '无效密钥被归类为鉴权错误，且错误消息不含密钥',
    async () => {
      const config = loadConfig({ cwd: path.resolve(projectRoot) });
      const bogusKey = 'invalid-key-for-live-auth-test';
      const provider = createLLMProvider({
        ...config,
        llm: { ...config.llm, apiKey: bogusKey, maxRetries: 0 },
      });

      const error: unknown = await provider
        .chat({ messages: [{ role: 'user', content: 'hi' }] })
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: ErrorCode.LlmAuth, retryable: false });
      expect(error instanceof Error ? error.message : String(error)).not.toContain(bogusKey);
    },
    TIMEOUT,
  );
});
