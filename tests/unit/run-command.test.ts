import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '../../src/security/approval.js';
import { sanitizeChildEnv } from '../../src/security/child-env.js';
import { dispatchToolCall, ToolRegistry } from '../../src/tools/index.js';
import { runCommandTool } from '../../src/tools/definitions/run-command.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

let workspace: string;
const registry = new ToolRegistry().register(runCommandTool);

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-run-command-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function call(
  args: Record<string, unknown>,
  options: {
    confirm?: (request: ConfirmRequest) => Promise<boolean>;
    signal?: AbortSignal;
    commandTimeoutMs?: number;
  } = {},
): Promise<ToolResult> {
  const ctx: ToolContext = {
    workspace,
    signal: options.signal ?? new AbortController().signal,
    confirm: options.confirm,
    commandTimeoutMs: options.commandTimeoutMs,
  };
  return dispatchToolCall(
    registry,
    { id: 'call_1', name: 'run_command', arguments: JSON.stringify(args) },
    ctx,
  );
}

function errorCode(result: ToolResult): string {
  const parsed = JSON.parse(result.content) as { error?: { code?: string } };
  return parsed.error?.code ?? '';
}

describe('run_command 执行', () => {
  it('exit 0 时返回 stdout 与退出码', async () => {
    const result = await call({ command: 'node -p "1+1"' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('exit code: 0');
    expect(result.content).toContain('2');
    expect(result.meta).toMatchObject({ exitCode: 0 });
  });

  it('非 0 退出码返回 TOOL_FAILED 并包含 code', async () => {
    const result = await call({ command: 'node -e "process.exit(3)"' });
    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('TOOL_FAILED');
    expect(result.content).toContain('exited with code 3');
  });

  it('stderr 被合并输出', async () => {
    const result = await call({ command: 'node -e "console.error(\'boom\')"' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('[stderr]');
    expect(result.content).toContain('boom');
  });

  it('cwd 在 workspace 内生效', async () => {
    mkdirSync(path.join(workspace, 'sub'));
    const result = await call({ command: 'node -p "process.cwd()"', cwd: 'sub' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(path.join(workspace, 'sub'));
  });

  it('拒绝越界或不存在的 cwd、NUL 与超长命令', async () => {
    expect(errorCode(await call({ command: 'node -p 1', cwd: '..' }))).toBe('TOOL_DENIED');
    expect(errorCode(await call({ command: 'node -p 1', cwd: 'missing' }))).toBe('TOOL_FAILED');
    expect(errorCode(await call({ command: 'node -p 1\u0000' }))).toBe('TOOL_INVALID_ARGS');
    expect(errorCode(await call({ command: 'x'.repeat(1001) }))).toBe('TOOL_INVALID_ARGS');
  });

  it('超时后终止进程并返回 TOOL_FAILED', async () => {
    const started = Date.now();
    const result = await call(
      { command: 'node -e "setTimeout(() => {}, 5000)"' },
      { commandTimeoutMs: 1000 },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('timed out after 1000ms');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);

  it('中止信号终止子进程并抛出 LlmAborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const error = await call(
      { command: 'node -e "setTimeout(() => {}, 5000)"' },
      { signal: controller.signal },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.LlmAborted);
  }, 15_000);

  it('输出超长时保留头尾并标记 truncated', async () => {
    const result = await call({ command: 'node -p "\'x\'.repeat(20000)"' });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('chars omitted');
    expect(result.content.length).toBeLessThan(14_000);
  });

  it('捕获缓冲区超限时中间标记截断，仍保留头尾', async () => {
    const result = await call({ command: 'node -e "process.stdout.write(\'x\'.repeat(70000))"' });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('chars omitted');
    expect(result.content.length).toBeLessThan(14_000);
  }, 15_000);
});

describe('run_command 风险控制', () => {
  it('git push 硬拒绝', async () => {
    const result = await call({ command: 'git push origin main' });
    expect(errorCode(result)).toBe('TOOL_DENIED');
    expect(result.content).toContain('git push');
  });

  it('高风险命令无确认回调时拒绝且不执行', async () => {
    mkdirSync(path.join(workspace, 'build'));
    const result = await call({ command: 'rm -rf build' });
    expect(errorCode(result)).toBe('TOOL_DENIED');
    expect(result.content).toContain('high-risk command denied');

    // 目录仍然存在，说明命令没有被执行
    const check = await call({ command: "node -p \"require('fs').existsSync('build')\"" });
    expect(check.content).toContain('true');
  });

  it('高风险命令经确认后执行', async () => {
    const confirm = vi.fn((_request: ConfirmRequest) => Promise.resolve(true));
    const result = await call({ command: 'git clean -fd' }, { confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ kind: 'run_command', risk: 'high' });
    // 非 git 仓库会失败，但已实际执行
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exited with code');
  });

  it('确认回调返回 false 时拒绝', async () => {
    const result = await call(
      { command: 'git clean -fd' },
      { confirm: () => Promise.resolve(false) },
    );
    expect(errorCode(result)).toBe('TOOL_DENIED');
  });
});

describe('sanitizeChildEnv', () => {
  it('移除密钥类变量，保留普通变量', () => {
    const env = sanitizeChildEnv({
      PATH: '/bin',
      LLM_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 't',
      DB_PASSWORD: 'p',
      MY_SECRET: 's',
      AWS_CREDENTIAL: 'c',
      HOME: '/home/u',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u' });
  });

  it('子进程读不到密钥', async () => {
    vi.stubEnv('LLM_API_KEY', 'sk-run-command-secret');
    vi.stubEnv('MY_TOKEN', 'token-value');
    const result = await call({
      command: 'node -p "process.env.LLM_API_KEY || \'unset\'"',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('unset');
    expect(result.content).not.toContain('sk-run-command-secret');
  });
});
