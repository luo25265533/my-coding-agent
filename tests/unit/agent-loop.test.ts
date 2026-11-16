import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../../src/agent/loop.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StreamChunk,
  type TokenUsage,
} from '../../src/llm/types.js';
import { ToolRegistry } from '../../src/tools/index.js';
import { ErrorCode } from '../../src/shared/errors.js';

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'echo input',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: (params) => Promise.resolve({ ok: true, content: params.text }),
  });
}

const signal = (): AbortSignal => new AbortController().signal;

describe('runAgentLoop', () => {
  it('执行单次工具调用后返回最终答案，回调顺序正确', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'final answer' },
      ],
    });
    const events: string[] = [];

    const result = await runAgentLoop('do it', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 5,
      signal: signal(),
      onToolCall: (call, iteration) => events.push(`call:${call.name}:${iteration}`),
      onToolResult: (_call, toolResult, iteration) =>
        events.push(`result:${toolResult.content}:${iteration}`),
    });

    expect(result).toMatchObject({
      content: 'final answer',
      iterations: 2,
      toolCalls: 1,
      stopReason: 'answer',
    });
    expect(events).toEqual(['call:echo:1', 'result:hi:1']);
  });

  it('单轮多个工具按顺序执行', async () => {
    const provider = createMockProvider({
      script: [
        {
          toolCalls: [
            { name: 'echo', arguments: '{"text":"a"}' },
            { name: 'echo', arguments: '{"text":"b"}' },
          ],
        },
        { content: 'done' },
      ],
    });
    const seen: string[] = [];

    const result = await runAgentLoop('two tools', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 5,
      signal: signal(),
      onToolResult: (_call, toolResult) => seen.push(toolResult.content),
    });

    expect(result.toolCalls).toBe(2);
    expect(seen).toEqual(['a', 'b']);
  });

  it('工具参数错误时把错误回传模型并继续循环', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'echo', arguments: '{"text":1}' }] },
        { content: 'recovered' },
      ],
    });
    const results: { ok: boolean; content: string }[] = [];

    const result = await runAgentLoop('bad args', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 5,
      signal: signal(),
      onToolResult: (_call, toolResult) => results.push(toolResult),
    });

    expect(result.content).toBe('recovered');
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.content).toContain('TOOL_INVALID_ARGS');
  });

  it('未知工具回传 TOOL_NOT_FOUND', async () => {
    const provider = createMockProvider({
      script: [{ toolCalls: [{ name: 'nope', arguments: '{}' }] }, { content: 'ok' }],
    });
    const results: string[] = [];

    await runAgentLoop('unknown', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 5,
      signal: signal(),
      onToolResult: (_call, toolResult) => results.push(toolResult.content),
    });

    expect(results[0]).toContain('TOOL_NOT_FOUND');
  });

  it('迭代上限耗尽返回 max_iterations', async () => {
    const provider = createMockProvider({
      script: [{ toolCalls: [{ name: 'echo', arguments: '{"text":"again"}' }] }],
    });

    const result = await runAgentLoop('loop forever', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 1,
      signal: signal(),
    });

    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.content).toBe('');
  });

  it('已中止的信号不发起模型调用', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgentLoop('abort', {
        provider: createMockProvider({}),
        tools: echoRegistry(),
        workspace: process.cwd(),
        maxIterations: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });
  });

  it('累加每轮用量，并在第二轮传入 assistant 与 tool 消息', async () => {
    const usage: TokenUsage = {
      ...EMPTY_USAGE,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };
    const requests: ChatRequest[] = [];
    const toolCallResponse: ChatResponse = {
      content: '',
      reasoningContent: undefined,
      finishReason: 'tool_calls',
      usage,
      model: 'fake',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
    };
    const provider: LLMProvider = {
      name: 'recording',
      chat(req: ChatRequest): Promise<ChatResponse> {
        requests.push(req);
        if (requests.length === 1) {
          return Promise.resolve(toolCallResponse);
        }
        return Promise.resolve({
          content: 'done',
          reasoningContent: undefined,
          finishReason: 'stop',
          usage,
          model: 'fake',
          toolCalls: [],
        });
      },
      async *stream(): AsyncIterable<StreamChunk> {
        await Promise.resolve();
        yield* [] as StreamChunk[];
      },
    };

    const result = await runAgentLoop('accumulate', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 5,
      signal: signal(),
    });

    expect(result.usage).toEqual({
      ...EMPTY_USAGE,
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
    });
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['echo']);

    const secondMessages: readonly ChatMessage[] = requests[1]?.messages ?? [];
    expect(secondMessages.at(-2)).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
    });
    expect(secondMessages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'hi',
    });
  });
});
