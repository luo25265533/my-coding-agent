import { spawn, type ChildProcess } from 'node:child_process';
import { describeError } from './errors.js';

const MAX_CAPTURE_CHARS = 64_000;
const MAX_OUTPUT_CHARS = 12_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;

export interface ShellResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: string | undefined;
  readonly durationMs: number;
}

export interface RunShellOptions {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}

export interface RunProcessOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function runShellCommand(options: RunShellOptions): Promise<ShellResult> {
  return execute(
    () =>
      spawn(options.command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        windowsHide: true,
        // POSIX 下建立新进程组，便于整棵进程树一起终止
        detached: process.platform !== 'win32',
      }),
    options.timeoutMs,
    options.signal,
  );
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ShellResult> {
  return execute(
    () =>
      spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
      }),
    options.timeoutMs,
    options.signal,
  );
}

function execute(
  start: () => ChildProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let child: ChildProcess | undefined;

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    const onAbort = (): void => {
      aborted = true;
      if (child !== undefined) {
        killTree(child);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child !== undefined) {
        killTree(child);
      }
    }, timeoutMs);

    try {
      child = start();
    } catch (error) {
      spawnError = describeError(error);
      finish(null);
      return;
    }

    const running = child;
    running.stdout?.on('data', (data: Buffer) => {
      stdout = appendCapped(stdout, data.toString('utf8'));
    });
    running.stderr?.on('data', (data: Buffer) => {
      stderr = appendCapped(stderr, data.toString('utf8'));
    });
    running.on('error', (error) => {
      spawnError = describeError(error);
      finish(null);
    });
    running.on('close', (code) => {
      finish(code);
    });

    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_CAPTURE_CHARS) {
    return next;
  }
  const half = Math.floor(MAX_CAPTURE_CHARS / 2);
  return `${next.slice(0, half)}\n... (capture truncated) ...\n${next.slice(-half)}`;
}

export function formatOutput(
  stdout: string,
  stderr: string,
  options: { maxChars?: number; headChars?: number; tailChars?: number } = {},
): { text: string; truncated: boolean } {
  const maxChars = options.maxChars ?? MAX_OUTPUT_CHARS;
  const headChars = options.headChars ?? HEAD_CHARS;
  const tailChars = options.tailChars ?? TAIL_CHARS;
  const sections: string[] = [];
  if (stdout !== '') {
    sections.push(stdout);
  }
  if (stderr !== '') {
    sections.push(`[stderr]\n${stderr}`);
  }
  const body = sections.length === 0 ? '(no output)' : sections.join('\n');
  if (body.length <= maxChars) {
    return { text: body, truncated: false };
  }
  const omitted = body.length - headChars - tailChars;
  return {
    text: `${body.slice(0, headChars)}\n... (${omitted} chars omitted) ...\n${body.slice(-tailChars)}`,
    truncated: true,
  };
}
