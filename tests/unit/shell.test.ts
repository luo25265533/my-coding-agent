import { describe, expect, it } from 'vitest';
import { formatOutput, runProcess, runShellCommand } from '../../src/shared/shell.js';

describe('formatOutput', () => {
  it('合并 stdout 与 stderr', () => {
    expect(formatOutput('out', 'err')).toEqual({
      text: 'out\n[stderr]\nerr',
      truncated: false,
    });
  });

  it('无输出时给出占位符', () => {
    expect(formatOutput('', '')).toEqual({ text: '(no output)', truncated: false });
  });

  it('超限时保留头尾并标记截断', () => {
    const result = formatOutput('a'.repeat(20), '', { maxChars: 10, headChars: 4, tailChars: 3 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('aaaa\n... (13 chars omitted) ...\naaa');
  });
});

describe('runProcess', () => {
  it('直接执行命令并捕获输出', async () => {
    const result = await runProcess('node', ['-p', '1+1'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: process.env,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('2');
    expect(result.stderr).toBe('');
    expect(result.spawnError).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('非 0 退出码原样返回', async () => {
    const result = await runProcess('node', ['-e', 'process.exit(4)'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: process.env,
    });
    expect(result.code).toBe(4);
  });

  it('命令不存在时返回 spawnError', async () => {
    const result = await runProcess('agent-command-that-does-not-exist-xyz', [], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: process.env,
    });
    expect(result.spawnError).toBeDefined();
  });

  it('runShellCommand 使用 shell 语义', async () => {
    const result = await runShellCommand({
      command: 'node -p "1+2"',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: process.env,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });
});
