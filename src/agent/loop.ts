import type { Logger } from 'pino';
import type { ContextManager } from '../context/manager.js';
import type { ConfirmFn } from '../security/approval.js';
import type { IgnoreMatcher } from '../security/ignore.js';
import { dispatchToolCall } from '../tools/dispatch.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ChatMessage, ChatResponse, LLMProvider, TokenUsage, ToolCall } from '../llm/types.js';
import { addUsage, EMPTY_USAGE } from '../llm/types.js';
import { throwIfAborted } from '../shared/abort.js';

export const AGENT_SYSTEM_PROMPT = `You are a coding agent working inside a sandboxed workspace. Complete the user's task by inspecting the code, editing files, and running commands, then answer concisely.

Workspace and safety:
- The workspace root is the current working directory. Tool paths must be relative to it.
- Never access paths outside the workspace. Secret files (.env, keys, credentials), the .git directory, task databases, and logs are off limits.
- Never run git push or destructive commands. High-risk actions still require user confirmation.

Workflow:
- Discover the project with list_files and search_code before reading files.
- Read the current file before changing it, and keep edits minimal and focused.
- After changes, verify them with the relevant command or test when the task calls for it.

Tools:
- Use write_file for new files and prefer edit_file for existing files.
- Tool arguments are JSON and must match the provided schemas exactly.
- If a tool returns an error, correct the arguments or approach; never invent tool output.
- Page through long output with read_file offset/limit instead of guessing.

Finish:
- Answer as soon as the task is satisfied. Do not run tests or long commands unless the task needs them.
- If you are blocked, state the concrete reason and the next step.`;

import type { AgentStopReason } from '../shared/agent-stop.js';

export type { AgentStopReason };

const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface AgentLoopOptions {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly workspace: string;
  readonly maxIterations: number;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  readonly systemPrompt?: string | undefined;
  /** 提供初始消息与请求级预算裁剪；缺省时使用内置 system prompt */
  readonly context?: ContextManager | undefined;
  /** 透传给遍历类工具的忽略规则 */
  readonly ignore?: IgnoreMatcher | undefined;
  /** 高风险工具动作审批；缺省视为拒绝 */
  readonly confirm?: ConfirmFn | undefined;
  /** run_command 默认超时 */
  readonly commandTimeoutMs?: number | undefined;
  /** 同一工具+参数连续出现的最大次数；达到即熔断 */
  readonly maxRepeatedCalls?: number | undefined;
  /** 连续多少轮工具全部失败后熔断 */
  readonly maxConsecutiveFailures?: number | undefined;
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
  readonly stopReason: AgentStopReason;
}

export async function runAgentLoop(task: string, options: AgentLoopOptions): Promise<AgentResult> {
  const messages: ChatMessage[] =
    options.context === undefined
      ? [
          { role: 'system', content: options.systemPrompt ?? AGENT_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ]
      : [...(await options.context.buildMessages(task))];
  let usage = EMPTY_USAGE;
  let toolCallCount = 0;
  let lastContent = '';
  let lastToolSignature: string | undefined;
  let repeatedCount = 0;
  let consecutiveFailureIterations = 0;
  const maxRepeatedCalls = options.maxRepeatedCalls ?? DEFAULT_MAX_REPEATED_CALLS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    throwIfAborted(options.signal);

    const requestMessages = options.context?.fit(messages) ?? messages;
    const response = await options.provider.chat({
      messages: requestMessages,
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
        stopReason: classifyFinalAnswer(response),
      };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    const iterationResults: ToolResult[] = [];
    for (const call of response.toolCalls) {
      throwIfAborted(options.signal);
      const signature = `${call.name}\n${call.arguments}`;
      if (signature === lastToolSignature) {
        repeatedCount += 1;
      } else {
        lastToolSignature = signature;
        repeatedCount = 1;
      }
      if (repeatedCount >= maxRepeatedCalls) {
        options.logger?.warn(
          { iteration, tool: call.name, repeated: repeatedCount },
          'repeated tool call detected',
        );
        return {
          content: lastContent,
          iterations: iteration,
          usage,
          toolCalls: toolCallCount,
          stopReason: 'repeated_tool_call',
        };
      }

      options.onToolCall?.(call, iteration);
      // 顺序执行：多工具并发会引入写入顺序与资源竞争问题
      const startedAt = Date.now();
      const result = await dispatchToolCall(options.tools, call, {
        workspace: options.workspace,
        signal: options.signal,
        logger: options.logger,
        ignore: options.ignore,
        confirm: options.confirm,
        commandTimeoutMs: options.commandTimeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      toolCallCount += 1;
      iterationResults.push(result);
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

    if (iterationResults.every((result) => !result.ok)) {
      consecutiveFailureIterations += 1;
    } else {
      consecutiveFailureIterations = 0;
    }
    if (consecutiveFailureIterations >= maxConsecutiveFailures) {
      options.logger?.warn(
        { iteration, consecutiveFailures: consecutiveFailureIterations },
        'consecutive tool failures detected',
      );
      return {
        content: lastContent,
        iterations: iteration,
        usage,
        toolCalls: toolCallCount,
        stopReason: 'tool_failure_limit',
      };
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

function classifyFinalAnswer(response: ChatResponse): AgentStopReason {
  if (response.content.trim() === '') {
    return 'empty_answer';
  }
  if (response.finishReason === 'length') {
    return 'output_truncated';
  }
  return 'answer';
}
