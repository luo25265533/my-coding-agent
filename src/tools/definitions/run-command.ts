import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { isApproved } from '../../security/approval.js';
import { sanitizeChildEnv } from '../../security/child-env.js';
import { classifyCommand } from '../../security/command-risk.js';
import { resolveInsideWorkspace } from '../../security/path-guard.js';
import { throwIfAborted } from '../../shared/abort.js';
import { AgentError, ErrorCode } from '../../shared/errors.js';
import { formatOutput, runShellCommand } from '../../shared/shell.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export const runCommandParameters = z.object({
  command: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => !value.includes('\0'), 'must not contain NUL bytes')
    .describe('Shell command to execute inside the workspace'),
  cwd: z
    .string()
    .min(1)
    .max(512)
    .default('.')
    .describe('Working directory, relative to the workspace'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds (default from AGENT_COMMAND_TIMEOUT_MS)`),
});

export type RunCommandParams = z.infer<typeof runCommandParameters>;

export const runCommandTool: ToolDefinition<RunCommandParams> = {
  name: 'run_command',
  description:
    'Run a shell command in a workspace directory, capturing stdout and stderr. Dangerous commands require confirmation; git push and destructive system commands are always denied.',
  parameters: runCommandParameters,
  riskLevel: 'high',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);

    const verdict = classifyCommand(params.command);
    if (verdict.level === 'deny') {
      ctx.logger?.warn({ reason: verdict.reason }, 'command denied');
      return errorResult('TOOL_DENIED', `command denied: ${verdict.reason}`);
    }
    if (verdict.level === 'high') {
      const approved = await isApproved(ctx.confirm, {
        kind: 'run_command',
        risk: 'high',
        summary: `run high-risk command (${verdict.reason}): ${clipText(params.command, 120)}`,
        detail: clipText(params.command, 300),
      });
      if (!approved) {
        ctx.logger?.warn({ reason: verdict.reason }, 'high-risk command rejected');
        return errorResult('TOOL_DENIED', `high-risk command denied: ${verdict.reason}`);
      }
    }

    const cwd = resolveInsideWorkspace(ctx.workspace, params.cwd);
    const cwdInfo = await stat(cwd).catch(() => undefined);
    if (cwdInfo === undefined) {
      return errorResult('TOOL_FAILED', `cwd not found: ${params.cwd}`);
    }
    if (!cwdInfo.isDirectory()) {
      return errorResult('TOOL_FAILED', `cwd is not a directory: ${params.cwd}`);
    }

    const timeoutMs = params.timeoutMs ?? ctx.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outcome = await runShellCommand({
      command: params.command,
      cwd,
      timeoutMs,
      signal: ctx.signal,
      env: sanitizeChildEnv(process.env),
    });
    const output = formatOutput(outcome.stdout, outcome.stderr);

    ctx.logger?.info(
      {
        commandChars: params.command.length,
        cwd,
        exitCode: outcome.code,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
      },
      'command executed',
    );

    if (outcome.aborted) {
      throw new AgentError(ErrorCode.LlmAborted, 'command aborted');
    }
    if (outcome.spawnError !== undefined) {
      return errorResult('TOOL_FAILED', `failed to start command: ${outcome.spawnError}`);
    }
    if (outcome.timedOut) {
      return errorResult('TOOL_FAILED', `command timed out after ${timeoutMs}ms\n${output.text}`);
    }
    if (outcome.code !== 0) {
      return errorResult(
        'TOOL_FAILED',
        `command exited with code ${outcome.code ?? 'unknown'}\n${output.text}`,
      );
    }

    return okResult(`exit code: 0\n${output.text}`, {
      truncated: output.truncated,
      meta: {
        exitCode: 0,
        durationMs: outcome.durationMs,
        timeoutMs,
      },
    });
  },
};

function clipText(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}
