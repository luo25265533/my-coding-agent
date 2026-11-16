import type { Logger } from 'pino';
import { dispatchToolCall } from '../tools/dispatch.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ChatMessage, LLMProvider, TokenUsage, ToolCall } from '../llm/types.js';
import { addUsage, EMPTY_USAGE } from '../llm/types.js';
import { throwIfAborted } from '../shared/abort.js';

export const AGENT_SYSTEM_PROMPT = `You are a coding agent working inside a sandboxed workspace.
- The workspace root is the current working directory. Paths passed to tools are relative to it.
- You cannot access files outside the workspace; secret files are blocked.
- Discover the project with list_files and search_code before reading files. read_file supports offset/limit paging.
- Tool arguments are JSON and must match the provided schemas. If a tool returns an error, fix the arguments and retry.
- Do not guess file contents. When you have enough information, answer the task concisely.`;

export interface AgentLoopOptions {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly workspace: string;
  readonly maxIterations: number;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  readonly systemPrompt?: string | undefined;
  readonly onToolCall?: ((call: ToolCall, iteration: number) => void) | undefined;
  readonly onToolResult?:
    | ((call: ToolCall, result: ToolResult, iteration: number, durationMs: number) => void)
    | undefined;
}

export interface AgentResult {
  readonly content: string;
  readonly iterations: number;
  readonly usage: TokenUsage;
  /** 实际执行的工具调用总数（不是轮次） */
  readonly toolCalls: number;
  readonly stopReason: 'answer' | 'max_iterations';
}

export async function runAgentLoop(task: string, options: AgentLoopOptions): Promise<AgentResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt ?? AGENT_SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  let usage = EMPTY_USAGE;
  let toolCallCount = 0;
  let lastContent = '';

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    throwIfAborted(options.signal);

    const response = await options.provider.chat({
      messages,
      tools: options.tools.specs(),
      signal: options.signal,
    });
    usage = addUsage(usage, response.usage);
    lastContent = response.content;
    options.logger?.debug(
      {
        iteration,
        finishReason: response.finishReason,
        toolCalls: response.toolCalls.length,
        usage: response.usage,
      },
      'iteration completed',
    );

    if (response.toolCalls.length === 0) {
      return {
        content: response.content,
        iterations: iteration,
        usage,
        toolCalls: toolCallCount,
        stopReason: 'answer',
      };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      throwIfAborted(options.signal);
      options.onToolCall?.(call, iteration);
      // 顺序执行：多工具并发会引入写入顺序与资源竞争问题
      const startedAt = Date.now();
      const result = await dispatchToolCall(options.tools, call, {
        workspace: options.workspace,
        signal: options.signal,
        logger: options.logger,
      });
      const durationMs = Date.now() - startedAt;
      toolCallCount += 1;
      messages.push({ role: 'tool', toolCallId: call.id, content: result.content });
      options.logger?.info(
        {
          tool: call.name,
          ok: result.ok,
          durationMs,
          outputChars: result.content.length,
          truncated: result.truncated === true,
        },
        'tool executed',
      );
      options.onToolResult?.(call, result, iteration, durationMs);
    }
  }

  return {
    content: lastContent,
    iterations: options.maxIterations,
    usage,
    toolCalls: toolCallCount,
    stopReason: 'max_iterations',
  };
}
