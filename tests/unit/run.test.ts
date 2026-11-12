import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';

function spyStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

let workspace: string;
let stdoutSpy: ReturnType<typeof spyStdout>;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-run-'));
  vi.stubEnv('LLM_PROVIDER', 'mock');
  vi.stubEnv('LLM_API_KEY', '');
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('AGENT_LOG_PRETTY', 'false');
  vi.stubEnv('AGENT_LOG_LEVEL', 'info');
  stdoutSpy = spyStdout();
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function printed(): string {
  return stdoutSpy.mock.calls.map((call) => String(call[0] ?? '')).join('');
}

function logLines(logFile: string): Record<string, unknown>[] {
  if (!existsSync(logFile)) {
    return [];
  }
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runCommand', () => {
  it('返回 runId 与日志路径，日志落在指定 workspace 内', () => {
    const result = runCommand(['demo'], { workspace });
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.logFile.startsWith(workspace)).toBe(true);
    expect(existsSync(result.logFile)).toBe(true);

    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'run started')).toBe(true);
    expect(lines.some((line) => line.msg === 'run finished')).toBe(true);
    for (const line of lines) {
      expect(line.runId).toBe(result.runId);
      expect(line.module).toBe('cli');
    }
  });

  it('task 词被拼接并写入日志与 stdout', () => {
    const result = runCommand(['fix', 'the', 'bug'], { workspace });
    expect(printed()).toContain('fix the bug');
    const started = logLines(result.logFile).find((line) => line.msg === 'run started');
    expect(started?.task).toBe('fix the bug');
  });

  it('无 task 时 stdout 显示 (none)', () => {
    runCommand([], { workspace });
    expect(printed()).toContain('(none)');
  });

  it('--log-level debug 覆盖生效，debug 行落盘', () => {
    const result = runCommand(['x'], { workspace, logLevel: 'debug' });
    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'configuration loaded')).toBe(true);
  });

  it('--verbose 等价于 debug', () => {
    const result = runCommand(['x'], { workspace, verbose: true });
    expect(logLines(result.logFile).some((line) => line.msg === 'configuration loaded')).toBe(true);
  });

  it('默认 info 级别下不写 debug 行', () => {
    const result = runCommand(['x'], { workspace });
    expect(logLines(result.logFile).some((line) => line.msg === 'configuration loaded')).toBe(
      false,
    );
  });

  it('stdout 打印骨架标识与脱敏配置，且不泄露密钥', () => {
    vi.stubEnv('LLM_PROVIDER', 'openai-compatible');
    vi.stubEnv('LLM_API_KEY', 'sk-run-secret');
    vi.stubEnv('LLM_BASE_URL', 'https://api.example.com/v1');
    vi.stubEnv('LLM_MODEL', 'some-model');

    const result = runCommand(['x'], { workspace });
    const out = printed();
    expect(out).toContain('phase 1 skeleton');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-run-secret');
    expect(readFileSync(result.logFile, 'utf8')).not.toContain('sk-run-secret');
  });

  it('不调用模型也不执行工具：日志中只有 cli 模块记录', () => {
    const result = runCommand(['x'], { workspace });
    const modules = new Set(logLines(result.logFile).map((line) => line.module));
    expect([...modules]).toEqual(['cli']);
  });
});
