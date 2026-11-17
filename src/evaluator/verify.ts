import { stat } from 'node:fs/promises';
import type { Logger } from 'pino';
import { isApproved, type ConfirmFn } from '../security/approval.js';
import { redactSecretValues, sanitizeChildEnv } from '../security/child-env.js';
import { classifyCommand } from '../security/command-risk.js';
import { resolveInsideWorkspace } from '../security/path-guard.js';
import { throwIfAborted } from '../shared/abort.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { formatOutput, runShellCommand } from '../shared/shell.js';
import type { VerificationResult } from './types.js';

const LOG_OUTPUT_TAIL_CHARS = 600;

export interface VerifyCommandOptions {
  readonly workspace: string;
  readonly request: {
    readonly command: string;
    readonly timeoutMs: number;
    readonly attempt: number;
    readonly cwd?: string | undefined;
  };
  readonly confirm?: ConfirmFn | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger?: Logger | undefined;
}

export async function verifyCommand(options: VerifyCommandOptions): Promise<VerificationResult> {
  const { request } = options;
  const rawCommand = request.command;
  const sourceEnv = options.env ?? process.env;
  const displayCommand = redactSecretValues(rawCommand, sourceEnv);
  const base = {
    command: displayCommand,
    attempt: request.attempt,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    output: '',
  } as const;

  throwIfAborted(options.signal);

  const verdict = classifyCommand(rawCommand);
  if (verdict.level === 'deny') {
    options.logger?.warn({ reason: verdict.reason }, 'verification command denied');
    return {
      ...base,
      status: 'failed',
      reason: `command denied: ${verdict.reason}`,
    };
  }
  if (verdict.level === 'high') {
    const approved = await isApproved(options.confirm, {
      kind: 'run_command',
      risk: 'high',
      summary: redactSecretValues(
        `run high-risk verification command (${verdict.reason}): ${clipText(rawCommand, 120)}`,
        sourceEnv,
      ),
      detail: redactSecretValues(clipText(rawCommand, 300), sourceEnv),
    });
    if (!approved) {
      options.logger?.warn({ reason: verdict.reason }, 'high-risk verification command rejected');
      return {
        ...base,
        status: 'failed',
        reason: 'high-risk verification command denied',
      };
    }
  }

  const cwd = resolveInsideWorkspace(options.workspace, request.cwd ?? '.');
  const cwdInfo = await stat(cwd).catch(() => undefined);
  if (cwdInfo === undefined) {
    return {
      ...base,
      status: 'failed',
      reason: `cwd not found: ${request.cwd ?? '.'}`,
    };
  }
  if (!cwdInfo.isDirectory()) {
    return {
      ...base,
      status: 'failed',
      reason: `cwd is not a directory: ${request.cwd ?? '.'}`,
    };
  }

  const outcome = await runShellCommand({
    command: rawCommand,
    cwd,
    timeoutMs: request.timeoutMs,
    signal: options.signal,
    env: sanitizeChildEnv(sourceEnv),
  });
  const formatted = formatOutput(outcome.stdout, outcome.stderr);
  const output = redactSecretValues(formatted.text, sourceEnv);
  const resultBase = {
    ...base,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    output,
  };

  if (outcome.aborted) {
    throw new AgentError(ErrorCode.LlmAborted, 'verification aborted');
  }

  options.logger?.info(
    {
      commandChars: rawCommand.length,
      cwd,
      exitCode: outcome.code,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      outputChars: output.length,
      ...(outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0
        ? { outputTail: tailText(output, LOG_OUTPUT_TAIL_CHARS) }
        : {}),
    },
    'verification command executed',
  );

  if (outcome.spawnError !== undefined) {
    return {
      ...resultBase,
      status: 'failed',
      reason: `failed to start command: ${outcome.spawnError}`,
    };
  }
  if (outcome.timedOut) {
    return {
      ...resultBase,
      status: 'failed',
      reason: `timed out after ${request.timeoutMs}ms`,
    };
  }
  if (outcome.code === 0) {
    return {
      ...resultBase,
      status: 'passed',
      exitCode: 0,
      reason: undefined,
    };
  }
  return {
    ...resultBase,
    status: 'failed',
    reason: `exit code ${outcome.code ?? 'unknown'}`,
  };
}

function clipText(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

function tailText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
