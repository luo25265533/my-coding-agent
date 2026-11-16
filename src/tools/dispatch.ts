import type { ToolCall } from '../llm/types.js';
import { throwIfAborted } from '../shared/abort.js';
import { AgentError, describeError, ErrorCode } from '../shared/errors.js';
import type { ToolRegistry } from './registry.js';
import { errorResult, type ToolErrorCode } from './result.js';
import type { ToolContext, ToolResult } from './types.js';

/**
 * 统一调度入口：业务错误一律转成可回传模型的结果，不中断循环；
 * 中止不是工具错误，直接抛出以终止整个任务。
 */
export async function dispatchToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  throwIfAborted(ctx.signal);

  const tool = registry.get(call.name);
  if (tool === undefined) {
    return errorResult(
      'TOOL_NOT_FOUND',
      `unknown tool "${call.name}"; available: ${registry.names().join(', ')}`,
    );
  }

  let input: unknown;
  try {
    input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch (error) {
    return errorResult(
      'TOOL_INVALID_ARGS',
      `arguments must be a JSON object: ${describeError(error)}`,
    );
  }

  try {
    return await tool.run(input, ctx);
  } catch (error) {
    throwIfAborted(ctx.signal);
    if (error instanceof AgentError && error.code === ErrorCode.LlmAborted) {
      throw error;
    }
    const code: ToolErrorCode =
      error instanceof AgentError && error.code === ErrorCode.PathDenied
        ? 'TOOL_DENIED'
        : 'TOOL_FAILED';
    return errorResult(code, describeError(error));
  }
}
