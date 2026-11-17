import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createContextManager } from '../../src/context/manager.js';
import { estimateMessagesTokens } from '../../src/context/token-budget.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-context-'));

beforeAll(() => {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ctx-demo' }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function manager(budgetTokens: number, logger?: Logger) {
  return createContextManager({
    workspace: root,
    budgetTokens,
    ignore: createIgnoreMatcher({ workspace: root }),
    systemPrompt: 'BASE PROMPT',
    logger,
  });
}

function toolGroup(id: string, filler: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read_file', arguments: '{"path":"src/app.ts"}' }],
    },
    { role: 'tool', toolCallId: id, content: filler.repeat(400) },
  ];
}

describe('buildMessages', () => {
  it('注入基础提示、项目地图与任务', async () => {
    const context = manager(5000);
    const messages = await context.buildMessages('summarize the project');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain('BASE PROMPT');
    expect(messages[0]?.content).toContain('Project overview:');
    expect(messages[1]).toEqual({ role: 'user', content: 'summarize the project' });

    const stats = context.stats();
    expect(stats.repoMapFiles).toBeGreaterThanOrEqual(2);
    expect(stats.repoMapTokens).toBeGreaterThan(0);
    expect(stats.initialTokens).toBeGreaterThan(0);
  });

  it('相同任务重复构建返回缓存', async () => {
    const context = manager(5000);
    const first = await context.buildMessages('same task');
    const second = await context.buildMessages('same task');
    expect(second).toBe(first);
  });

  it('任务占满预算时省略项目地图', async () => {
    const context = manager(1000);
    const messages = await context.buildMessages('x'.repeat(6000));
    expect(messages[0]?.content).toBe('BASE PROMPT');
    expect(context.stats().repoMapTokens).toBe(0);
  });

  it('极小预算时丢弃仓库地图并记录统计与日志', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const context = manager(100, logger);
    const messages = await context.buildMessages('tiny task');

    expect(messages[0]?.content).toBe('BASE PROMPT');
    const stats = context.stats();
    expect(stats.repoMapDropped).toBe(true);
    expect(stats.repoMapTokens).toBe(0);
    expect(info.mock.calls.some((call) => call[1] === 'repo map dropped to fit budget')).toBe(true);
  });
});

describe('fit', () => {
  it('未超预算时原样返回', async () => {
    const context = manager(5000);
    const messages = await context.buildMessages('short');
    expect(context.fit(messages)).toBe(messages);
    expect(context.stats().lastRequestTokens).toBeLessThanOrEqual(5000);
  });

  it('超预算时整组丢弃旧历史并插入提示', () => {
    const context = manager(150);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
      ...toolGroup('call_1', 'a'),
      ...toolGroup('call_2', 'b'),
    ];

    const fitted = context.fit(messages);
    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(150);
    expect(
      fitted.some(
        (message) => message.role === 'system' && message.content.includes('[context budget]'),
      ),
    ).toBe(true);
    expect(
      fitted.some((message) => message.role === 'tool' && message.content.startsWith('b')),
    ).toBe(true);
    expect(
      fitted.some((message) => message.role === 'tool' && message.content.startsWith('a')),
    ).toBe(false);

    const toolIndex = fitted.findIndex((message) => message.role === 'tool');
    expect(fitted[toolIndex - 1]?.role).toBe('assistant');
    expect(fitted[toolIndex - 1]).toMatchObject({ toolCalls: [{ id: 'call_2' }] });

    const stats = context.stats();
    expect(stats.droppedMessages).toBe(2);
    expect(stats.truncatedToolMessages).toBeGreaterThanOrEqual(1);
  });

  it('无法整组丢弃时截短最长的工具输出', () => {
    const context = manager(60);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
      ...toolGroup('call_1', 'a'),
    ];

    const fitted = context.fit(messages);
    const tool = fitted.find((message) => message.role === 'tool');
    expect(tool?.content).toContain('fit context budget');
    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(60);
    expect(context.stats().truncatedToolMessages).toBeGreaterThanOrEqual(1);
  });

  it('截短工具输出时保留头尾并标记原始长度', () => {
    const context = manager(300);
    const content = `BEGIN-${'a'.repeat(1500)}-END`;
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content },
    ];

    const fitted = context.fit(messages);
    const tool = fitted.find((message) => message.role === 'tool');
    expect(tool?.content).toContain('middle truncated');
    expect(tool?.content).toContain(`was ${content.length} chars`);
    expect(tool?.content.startsWith('BEGIN-')).toBe(true);
    expect(tool?.content.endsWith('-END')).toBe(true);

    const toolIndex = fitted.findIndex((message) => message.role === 'tool');
    expect(fitted[toolIndex - 1]).toMatchObject({ toolCalls: [{ id: 'call_1' }] });
    expect(fitted[toolIndex]).toMatchObject({ toolCallId: 'call_1' });
    expect(messages[3]?.content).toBe(content);
    expect(context.stats().truncatedToolMessages).toBe(1);
  });

  it('多次裁剪时统计累计', () => {
    const context = manager(60);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
      ...toolGroup('call_1', 'a'),
    ];

    context.fit(messages);
    context.fit(messages);
    expect(context.stats().truncatedToolMessages).toBe(2);
  });

  it('任务本身超预算时不崩溃', () => {
    const context = manager(100);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'x'.repeat(5000) },
    ];
    const fitted = context.fit(messages);
    expect(fitted).toHaveLength(2);
    expect(fitted[1]).toEqual(messages[1]);
  });

  it('截短后仍超预算时丢弃最新组', () => {
    const context = manager(40);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
      ...toolGroup('call_1', 'a'),
    ];

    const fitted = context.fit(messages);
    expect(fitted).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'T' },
    ]);
  });

  it('无工具消息可截短时原样返回基础消息', () => {
    const context = manager(20);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(400) },
      { role: 'user', content: 'T' },
    ];
    const fitted = context.fit(messages);
    expect(fitted).toEqual(messages);
  });

  it('空消息数组与异常预算不崩溃', () => {
    const context = manager(-1);
    const empty: ChatMessage[] = [];
    expect(context.fit(empty)).toBe(empty);
  });
});
