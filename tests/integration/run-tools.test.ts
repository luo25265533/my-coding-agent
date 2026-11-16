import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCli = path.join(projectRoot, 'src', 'cli', 'main.ts');

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-run-tools-'));
  writeFileSync(path.join(workspace, 'note.txt'), 'hello from note\n');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', sourceCli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      AGENT_WORKSPACE: workspace,
      AGENT_LOG_DIR: 'logs',
      AGENT_LOG_PRETTY: 'false',
      LLM_PROVIDER: 'mock',
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function useScript(steps: unknown): void {
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(steps));
}

function logText(): string {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(workspace, 'logs', `agent-${date}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('run 工具循环（离线 mock 脚本驱动）', () => {
  it('调用 read_file 后基于结果作答', () => {
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: '文件内容是 hello from note。' },
    ]);

    const run = runCli(['run', '读取 note.txt 并总结'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('[1] → read_file {"path":"note.txt"}');
    expect(run.stdout).toContain('[1] ← ok');
    expect(run.stdout).toContain('hello from note');
    expect(run.stdout).toContain('answer:');
    expect(run.stdout).toContain('文件内容是 hello from note。');
    expect(run.stdout).toContain('iterations=2  tools=1');

    const log = logText();
    expect(log).toContain('"msg":"tool executed"');
    expect(log).toContain('"msg":"run finished"');
  }, 60_000);

  it('迭代上限耗尽退出 1 并输出错误', () => {
    useScript([{ toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] }]);

    const run = runCli(['run', '无限循环'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_MAX_ITERATIONS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no final answer after 1 iterations');
    expect(run.stdout).toContain('[1] → read_file');
  }, 60_000);

  it('密钥文件被拒绝，内容不进入 stdout 与日志', () => {
    const secret = 'top-secret-value-123';
    writeFileSync(path.join(workspace, '.env'), `SECRET_VALUE=${secret}\n`);
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":".env"}' }] },
      { content: '访问被拒绝。' },
    ]);

    const run = runCli(['run', '读取 .env'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[1] ← error');
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
    expect(logText()).not.toContain(secret);
  }, 60_000);

  it('路径越界被拒绝', () => {
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"../outside.txt"}' }] },
      { content: '无法访问工作区外。' },
    ]);

    const run = runCli(['run', '越权读取'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('无法访问工作区外。');
  }, 60_000);
});
