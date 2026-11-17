import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvaluator } from '../../src/evaluator/index.js';
import type { Evaluator, VerifyRequest } from '../../src/evaluator/types.js';
import type { ConfirmRequest } from '../../src/security/approval.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-evaluator-verify-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function evaluator(
  options: {
    confirm?: (request: ConfirmRequest) => Promise<boolean>;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  } = {},
): Evaluator {
  return createEvaluator({ workspace, ...options });
}

function request(command: string, overrides: Partial<VerifyRequest> = {}): VerifyRequest {
  return { command, timeoutMs: 10_000, attempt: 1, ...overrides };
}

describe('verifyCommand 执行结果', () => {
  it('exit 0 返回 passed 与输出', async () => {
    const result = await evaluator().verify(request('node -p "1+1"'));
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.output).toContain('2');
    expect(result.attempt).toBe(1);
  });

  it('非 0 退出码返回 failed 并带 exit code', async () => {
    const result = await evaluator().verify(request('node -e "process.exit(3)"'));
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.reason).toBe('exit code 3');
  });

  it('stderr 被合并进输出', async () => {
    const result = await evaluator().verify(request('node -e "console.error(\'boom\')"'));
    expect(result.status).toBe('passed');
    expect(result.output).toContain('[stderr]');
    expect(result.output).toContain('boom');
  });

  it('超时终止进程并返回 failed', async () => {
    const started = Date.now();
    const result = await evaluator().verify(
      request('node -e "setTimeout(() => {}, 5000)"', { timeoutMs: 1000 }),
    );
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.reason).toBe('timed out after 1000ms');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);

  it('保留 attempt 编号', async () => {
    const result = await evaluator().verify(request('node -p 1', { attempt: 3 }));
    expect(result.attempt).toBe(3);
  });

  it('cwd 在 workspace 内生效', async () => {
    mkdirSync(path.join(workspace, 'sub'));
    const result = await evaluator().verify(request('node -p "process.cwd()"', { cwd: 'sub' }));
    expect(result.status).toBe('passed');
    expect(result.output).toContain(path.join(workspace, 'sub'));
  });

  it('越界 cwd 抛出 PathDenied', async () => {
    await expect(evaluator().verify(request('node -p 1', { cwd: '..' }))).rejects.toMatchObject({
      code: ErrorCode.PathDenied,
    });
  });

  it('不存在的 cwd 返回 failed', async () => {
    const result = await evaluator().verify(request('node -p 1', { cwd: 'missing' }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('cwd not found: missing');
  });

  it('cwd 指向文件时返回 failed', async () => {
    writeFileSync(path.join(workspace, 'file.txt'), 'x');
    const result = await evaluator().verify(request('node -p 1', { cwd: 'file.txt' }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('cwd is not a directory: file.txt');
  });
});

describe('verifyCommand 中止与输出处理', () => {
  it('已中止的信号在启动前抛出 LlmAborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await evaluator({ signal: controller.signal })
      .verify(request('node -p 1'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.LlmAborted);
  });

  it('运行中中止时抛出 LlmAborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await evaluator({ signal: controller.signal })
      .verify(request('node -e "setTimeout(() => {}, 5000)"'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.LlmAborted);
  }, 15_000);

  it('超长输出保留头尾并标记省略', async () => {
    const result = await evaluator().verify(request('node -p "\'x\'.repeat(20000)"'));
    expect(result.status).toBe('passed');
    expect(result.output).toContain('chars omitted');
    expect(result.output.length).toBeLessThan(14_000);
  });

  it('命令与输出中的密钥值都被脱敏', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MY_SECRET: 'supersecretvalue' };
    const result = await evaluator({ env }).verify(
      request('node -e "console.log(\'supersecretvalue\')"'),
    );
    expect(result.status).toBe('passed');
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).not.toContain('supersecretvalue');
    expect(result.command).toContain('[REDACTED]');
    expect(result.command).not.toContain('supersecretvalue');
  });

  it('子进程环境中的密钥被移除', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, LLM_API_KEY: 'sk-verify-secret' };
    const result = await evaluator({ env }).verify(
      request('node -p "process.env.LLM_API_KEY || \'unset\'"'),
    );
    expect(result.output).toContain('unset');
    expect(result.output).not.toContain('sk-verify-secret');
  });
});

describe('verifyCommand 风险控制', () => {
  it('git push 硬拒绝且不询问', async () => {
    const confirm = vi.fn((_request: ConfirmRequest) => Promise.resolve(true));
    const result = await evaluator({ confirm }).verify(request('git push origin main'));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('command denied');
    expect(result.reason).toContain('git push');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('高风险命令缺少确认回调时拒绝且不执行', async () => {
    mkdirSync(path.join(workspace, 'build'));
    const result = await evaluator().verify(request('rm -rf build'));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('high-risk verification command denied');

    const check = await evaluator().verify(
      request("node -p \"require('fs').existsSync('build')\""),
    );
    expect(check.output).toContain('true');
  });

  it('高风险命令经确认后执行', async () => {
    const confirm = vi.fn((_request: ConfirmRequest) => Promise.resolve(true));
    const result = await evaluator({ confirm }).verify(request('git clean -fd'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ kind: 'run_command', risk: 'high' });
    expect(confirm.mock.calls[0]?.[0]?.summary).toContain('git clean');
    // 非 git 仓库会失败，但命令确实被执行
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('exit code');
  });

  it('确认回调返回 false 时拒绝', async () => {
    const result = await evaluator({ confirm: () => Promise.resolve(false) }).verify(
      request('git clean -fd'),
    );
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('high-risk verification command denied');
  });

  it('确认摘要中的密钥被脱敏', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MY_SECRET: 'supersecretvalue' };
    const confirm = vi.fn((_request: ConfirmRequest) => Promise.resolve(false));
    await evaluator({ confirm, env }).verify(request('git clean -fd supersecretvalue'));
    const shown = JSON.stringify(confirm.mock.calls[0]?.[0]);
    expect(shown).not.toContain('supersecretvalue');
    expect(shown).toContain('[REDACTED]');
  });
});
