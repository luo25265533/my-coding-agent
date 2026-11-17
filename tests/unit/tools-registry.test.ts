import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultToolRegistry,
  dispatchToolCall,
  ToolRegistry,
} from '../../src/tools/index.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx: ToolContext = { workspace: process.cwd(), signal: new AbortController().signal };

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'echo the text back',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: (params) => Promise.resolve({ ok: true, content: params.text }),
  });
}

function parseContent(result: { content: string }): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

describe('ToolRegistry', () => {
  it('注册后可按名查找并生成 JSON Schema spec', () => {
    const registry = echoRegistry();
    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(['echo']);
    const spec = registry.specs()[0];
    expect(spec?.name).toBe('echo');
    expect(spec?.description).toBe('echo the text back');
    expect(spec?.parameters).toMatchObject({
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    });
    expect(registry.get('echo')?.riskLevel).toBe('low');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('重名注册抛错', () => {
    const registry = echoRegistry();
    expect(() =>
      registry.register({
        name: 'echo',
        description: 'duplicate',
        parameters: z.object({}),
        riskLevel: 'low',
        execute: () => Promise.resolve({ ok: true, content: '' }),
      }),
    ).toThrow(AgentError);
  });

  it('参数 schema 无法转成 JSON Schema 时注册期抛错', () => {
    expect(() =>
      new ToolRegistry().register({
        name: 'unsupported',
        description: 'cannot be represented',
        parameters: z.object({ callback: z.custom<() => void>() }),
        riskLevel: 'low',
        execute: () => Promise.resolve({ ok: true, content: '' }),
      }),
    ).toThrow(/unsupported parameter schema/);
  });

  it('默认注册只读工具与写入/执行工具', () => {
    const registry = createDefaultToolRegistry();
    expect(registry.names()).toEqual([
      'read_file',
      'list_files',
      'search_code',
      'find_files',
      'write_file',
      'edit_file',
      'run_command',
    ]);
    for (const spec of registry.specs()) {
      expect(spec.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('dispatchToolCall', () => {
  it('校验通过后执行并传出参数', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, content: 'done' }));
    const registry = new ToolRegistry().register({
      name: 'run',
      description: 'r',
      parameters: z.object({ count: z.number().int() }),
      riskLevel: 'low',
      execute,
    });

    const result = await dispatchToolCall(
      registry,
      { id: 'c1', name: 'run', arguments: '{"count":3}' },
      ctx,
    );
    expect(execute).toHaveBeenCalledWith({ count: 3 }, ctx);
    expect(result).toEqual({ ok: true, content: 'done' });
  });

  it('未知工具返回 TOOL_NOT_FOUND', async () => {
    const result = await dispatchToolCall(
      echoRegistry(),
      { id: 'c1', name: 'nope', arguments: '{}' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(parseContent(result).error).toMatchObject({ code: 'TOOL_NOT_FOUND' });
  });

  it('非法 JSON 返回 TOOL_INVALID_ARGS', async () => {
    const result = await dispatchToolCall(
      echoRegistry(),
      { id: 'c1', name: 'echo', arguments: '{oops' },
      ctx,
    );
    expect(parseContent(result).error).toMatchObject({ code: 'TOOL_INVALID_ARGS' });
  });

  it('参数校验失败返回 issue 文本', async () => {
    const result = await dispatchToolCall(
      echoRegistry(),
      { id: 'c1', name: 'echo', arguments: '{"text":1}' },
      ctx,
    );
    const error = parseContent(result).error as { code: string; message: string };
    expect(error.code).toBe('TOOL_INVALID_ARGS');
    expect(error.message).toContain('text');
  });

  it('空 arguments 视为空对象', async () => {
    const registry = new ToolRegistry().register({
      name: 'noargs',
      description: 'n',
      parameters: z.object({}),
      riskLevel: 'low',
      execute: () => Promise.resolve({ ok: true, content: 'ok' }),
    });
    expect(
      (await dispatchToolCall(registry, { id: 'c', name: 'noargs', arguments: '' }, ctx)).ok,
    ).toBe(true);
  });

  it('execute 抛错转为 TOOL_FAILED', async () => {
    const registry = new ToolRegistry().register({
      name: 'boom',
      description: 'b',
      parameters: z.object({}),
      riskLevel: 'low',
      execute: () => Promise.reject(new Error('disk full')),
    });
    const result = await dispatchToolCall(
      registry,
      { id: 'c', name: 'boom', arguments: '{}' },
      ctx,
    );
    expect(parseContent(result).error).toMatchObject({
      code: 'TOOL_FAILED',
      message: 'disk full',
    });
  });

  it('PathDenied 转为 TOOL_DENIED', async () => {
    const registry = new ToolRegistry().register({
      name: 'denied',
      description: 'd',
      parameters: z.object({}),
      riskLevel: 'low',
      execute: () => Promise.reject(new AgentError(ErrorCode.PathDenied, 'nope')),
    });
    const result = await dispatchToolCall(
      registry,
      { id: 'c', name: 'denied', arguments: '{}' },
      ctx,
    );
    expect(parseContent(result).error).toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('执行过程中中止会抛出而不是返回结果', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry().register({
      name: 'slow',
      description: 's',
      parameters: z.object({}),
      riskLevel: 'low',
      execute: () => {
        controller.abort();
        return Promise.reject(new AgentError(ErrorCode.LlmAborted, 'aborted'));
      },
    });

    await expect(
      dispatchToolCall(
        registry,
        { id: 'c', name: 'slow', arguments: '{}' },
        {
          ...ctx,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
  });

  it('execute 抛出的中止错误直接冒泡', async () => {
    const registry = new ToolRegistry().register({
      name: 'aborted',
      description: 'a',
      parameters: z.object({}),
      riskLevel: 'low',
      execute: () => Promise.reject(new AgentError(ErrorCode.LlmAborted, 'aborted')),
    });
    await expect(
      dispatchToolCall(registry, { id: 'c', name: 'aborted', arguments: '{}' }, ctx),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
  });

  it('已中止的信号直接抛错，不返回结果', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      dispatchToolCall(
        echoRegistry(),
        { id: 'c', name: 'echo', arguments: '{"text":"x"}' },
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
  });
});
