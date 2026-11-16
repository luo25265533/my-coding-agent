import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { AgentError, ErrorCode, ExitCode } from '../../src/shared/errors.js';

function spyStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

let workspace: string;
let stdoutSpy: ReturnType<typeof spyStdout>;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-run-'));
  writeFileSync(path.join(workspace, 'note.txt'), 'hello from tool\nsecond line\n');
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

function useScript(steps: unknown): void {
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(steps));
  vi.stubEnv('AGENT_MOCK_SCRIPT', 'script.json');
}

describe('runCommand', () => {
  it('驱动工具循环：读取文件后给出答案', async () => {
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: '文件内容是 hello from tool。' },
    ]);

    const result = await runCommand(['总结', 'note.txt'], { workspace });

    expect(result.stopReason).toBe('answer');
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.content).toBe('文件内容是 hello from tool。');
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.logFile.startsWith(workspace)).toBe(true);

    const out = printed();
    expect(out).toContain('workspace :');
    expect(out).toContain('provider  : mock');
    expect(out).toContain('[1] → read_file {"path":"note.txt"}');
    expect(out).toContain('[1] ← ok');
    expect(out).toContain('answer:');
    expect(out).toContain('hello from tool');
    expect(out).toContain('iterations=2  tools=1');

    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'run started')).toBe(true);
    expect(lines.some((line) => line.msg === 'tool executed')).toBe(true);
    expect(lines.some((line) => line.msg === 'run finished')).toBe(true);
    for (const line of lines) {
      expect(line.runId).toBe(result.runId);
    }
    expect(new Set(lines.map((line) => line.module))).toEqual(new Set(['cli', 'agent']));
  });

  it('无任务时抛 UsageInvalid（退出码 2）', async () => {
    const error = await runCommand([], { workspace }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((error as AgentError).exitCode).toBe(ExitCode.UsageError);
  });

  it('无脚本时 mock 回显任务，单轮结束', async () => {
    const result = await runCommand(['fix', 'the', 'bug'], { workspace });
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.content).toBe('echo: fix the bug');
    expect(printed()).toContain('echo: fix the bug');
  });

  it('--log-level debug 覆盖生效，debug 行落盘', async () => {
    const result = await runCommand(['x'], { workspace, logLevel: 'debug' });
    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'configuration loaded')).toBe(true);
    expect(lines.some((line) => line.msg === 'iteration completed')).toBe(true);
  });

  it('--verbose 等价于 debug；默认 info 不写 debug 行', async () => {
    const verbose = await runCommand(['x'], { workspace, verbose: true });
    expect(logLines(verbose.logFile).some((line) => line.msg === 'configuration loaded')).toBe(
      true,
    );

    // 日志文件当天复用，按 runId 只看本次运行
    const normal = await runCommand(['x'], { workspace });
    expect(
      logLines(normal.logFile)
        .filter((line) => line.runId === normal.runId)
        .some((line) => line.msg === 'configuration loaded'),
    ).toBe(false);
  });

  it('超长工具参数在轨迹中截断显示', async () => {
    const longPattern = 'x'.repeat(240);
    useScript([
      {
        toolCalls: [{ name: 'search_code', arguments: JSON.stringify({ pattern: longPattern }) }],
      },
      { content: 'done' },
    ]);

    await runCommand(['long args'], { workspace });

    const out = printed();
    expect(out).toContain('[1] → search_code ');
    expect(out).toContain('…');
    expect(out).not.toContain(longPattern);
  });

  it('空答案抛 AgentIncomplete（退出码 1）', async () => {
    useScript([{ content: '' }]);

    const error = await runCommand(['answer'], { workspace }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.AgentIncomplete);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);
    expect((error as Error).message).toContain('empty_answer');
    expect(printed()).toContain('iterations=1  tools=0');
  });

  it('迭代上限耗尽抛 AgentMaxIterations（退出码 1）', async () => {
    useScript([{ toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] }]);
    vi.stubEnv('AGENT_MAX_ITERATIONS', '1');

    const error = await runCommand(['loop'], { workspace }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.AgentMaxIterations);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);
    expect(printed()).toContain('[1] → read_file');

    const logFile = path.join(workspace, '.agent', 'logs');
    expect(existsSync(logFile)).toBe(true);
  });
});
