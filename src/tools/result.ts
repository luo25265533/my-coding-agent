import type { ToolResult } from './types.js';

/** 工具层回传给模型的错误码；与进程级 ErrorCode 分离 */
export type ToolErrorCode = 'TOOL_NOT_FOUND' | 'TOOL_INVALID_ARGS' | 'TOOL_FAILED' | 'TOOL_DENIED';

export interface ResultOptions {
  readonly truncated?: boolean | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export function okResult(content: string, options: ResultOptions = {}): ToolResult {
  return {
    ok: true,
    content,
    truncated: options.truncated,
    meta: options.meta,
  };
}

export function errorResult(code: ToolErrorCode, message: string): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({ ok: false, error: { code, message } }),
    meta: { code },
  };
}
