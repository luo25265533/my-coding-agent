import { z } from 'zod';
import pino from 'pino';
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
import { ToolRegistry, errorResult } from '../../src/tools/index.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

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

const silentLogger = pino({ level: 'silent' });

function failingRegistry(): ToolRegistry {
  return echoRegistry().register({
    name: 'fail',
    description: 'always fails',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: () => Promise.resolve(errorResult('TOOL_FAILED', 'boom')),
  });
}

function fixedProvider(response: ChatResponse): LLMProvider {
  return {
    name: 'fixed',
    chat: () => Promise.resolve(response),
    async *stream(): AsyncIterable<StreamChunk> {
      await Promise.resolve();
      yield* [] as StreamChunk[];
    },
  };
}

function responseOf(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    content: '',
    reasoningContent: undefined,
    finishReason: 'stop',
    usage: EMPTY_USAGE,
    model: 'fixed',
    toolCalls: [],
    ...overrides,
  };
}

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

  it('多步任务：连续三轮工具调用后给出答案', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'echo', arguments: '{"text":"step1"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"step2"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"step3"}' }] },
        { content: 'done after 3 steps' },
      ],
    });
    const observed: string[] = [];

    const result = await runAgentLoop('multi step', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      signal: signal(),
      onToolResult: (_call, toolResult) => observed.push(toolResult.content),
    });

    expect(result).toMatchObject({
      content: 'done after 3 steps',
      iterations: 4,
      toolCalls: 3,
      stopReason: 'answer',
    });
    expect(observed).toEqual(['step1', 'step2', 'step3']);
  });

  it('空白答案视为未完成', async () => {
    const result = await runAgentLoop('empty', {
      provider: fixedProvider(responseOf({ content: '   \n' })),
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 3,
      signal: signal(),
    });

    expect(result.stopReason).toBe('empty_answer');
    expect(result.iterations).toBe(1);
  });

  it('答案因 maxTokens 截断时视为未完成', async () => {
    const result = await runAgentLoop('truncated', {
      provider: fixedProvider(responseOf({ content: 'partial answer', finishReason: 'length' })),
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 3,
      signal: signal(),
    });

    expect(result.stopReason).toBe('output_truncated');
    expect(result.content).toBe('partial answer');
  });

  it('同一工具与参数连续出现时熔断', async () => {
    const repeated = { toolCalls: [{ name: 'echo', arguments: '{"text":"same"}' }] };
    const provider = createMockProvider({ script: [repeated, repeated, repeated] });

    const result = await runAgentLoop('repeat', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      signal: signal(),
      logger: silentLogger,
    });

    expect(result.stopReason).toBe('repeated_tool_call');
    expect(result.toolCalls).toBe(2);
    expect(result.iterations).toBe(3);
  });

  it('重复阈值可通过选项收紧', async () => {
    const repeated = { toolCalls: [{ name: 'echo', arguments: '{"text":"same"}' }] };
    const provider = createMockProvider({ script: [repeated, repeated] });

    const result = await runAgentLoop('repeat', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      maxRepeatedCalls: 2,
      signal: signal(),
    });

    expect(result.stopReason).toBe('repeated_tool_call');
    expect(result.toolCalls).toBe(1);
  });

  it('穿插不同调用时重复计数会重置', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'echo', arguments: '{"text":"a"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"b"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"a"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"a"}' }] },
        { content: 'finished' },
      ],
    });

    const result = await runAgentLoop('interleaved', {
      provider,
      tools: echoRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      signal: signal(),
    });

    expect(result.stopReason).toBe('answer');
    expect(result.toolCalls).toBe(4);
  });

  it('连续多轮工具全部失败时熔断', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'fail', arguments: '{"text":"1"}' }] },
        { toolCalls: [{ name: 'fail', arguments: '{"text":"2"}' }] },
        { toolCalls: [{ name: 'fail', arguments: '{"text":"3"}' }] },
      ],
    });

    const result = await runAgentLoop('failing', {
      provider,
      tools: failingRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      signal: signal(),
      logger: silentLogger,
    });

    expect(result.stopReason).toBe('tool_failure_limit');
    expect(result.toolCalls).toBe(3);
    expect(result.iterations).toBe(3);
  });

  it('中间出现成功的工具调用会清零失败计数', async () => {
    const provider = createMockProvider({
      script: [
        { toolCalls: [{ name: 'fail', arguments: '{"text":"1"}' }] },
        { toolCalls: [{ name: 'fail', arguments: '{"text":"2"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"ok"}' }] },
        { toolCalls: [{ name: 'fail', arguments: '{"text":"3"}' }] },
        { toolCalls: [{ name: 'fail', arguments: '{"text":"4"}' }] },
        { content: 'recovered' },
      ],
    });

    const result = await runAgentLoop('recover', {
      provider,
      tools: failingRegistry(),
      workspace: process.cwd(),
      maxIterations: 10,
      signal: signal(),
    });

    expect(result.stopReason).toBe('answer');
    expect(result.toolCalls).toBe(5);
  });

  it('provider 异常原样冒泡，不转成停止原因', async () => {
    const provider: LLMProvider = {
      name: 'boom',
      chat: () => Promise.reject(new AgentError(ErrorCode.LlmNetwork, 'offline')),
      async *stream(): AsyncIterable<StreamChunk> {
        await Promise.resolve();
        yield* [] as StreamChunk[];
      },
    };

    await expect(
      runAgentLoop('network down', {
        provider,
        tools: echoRegistry(),
        workspace: process.cwd(),
        maxIterations: 3,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LlmNetwork });
  });
});
