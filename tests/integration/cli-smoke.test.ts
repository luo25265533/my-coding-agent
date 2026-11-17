import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readPackageInfo } from '../../src/shared/package-info.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCli = path.join(projectRoot, 'src', 'cli', 'main.ts');
const distCli = path.join(projectRoot, 'dist', 'cli', 'main.js');
const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

let workspace: string;

beforeAll(() => {
  const build = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (build.status !== 0) {
    throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  }
}, 180_000);

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-smoke-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(entry: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const nodeArgs = entry.endsWith('.ts') ? ['--import', 'tsx', entry, ...args] : [entry, ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
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

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(workspace, 'logs', `agent-${date}.jsonl`);
}

function readLogLines(): Record<string, unknown>[] {
  const file = logFilePath();
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('源码入口（tsx 直跑）', () => {
  it('run 命令退出 0、回答任务并写出 JSONL 日志', () => {
    const run = runCli(sourceCli, ['run', '--no-plan', 'demo', 'task']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('phase 1 skeleton');
    expect(run.stdout).toContain('demo task');
    expect(run.stdout).toContain('answer:');
    expect(run.stdout).toContain('echo: demo task');
    expect(run.stdout).toContain('iterations=1  tools=0');

    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const runIdMatch = /runId\s*:\s*([0-9a-f-]+)/.exec(run.stdout);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    for (const line of lines) {
      expect(line.runId).toBe(runId);
      expect(line.app).toBe('my-coding-agent');
    }
    expect(lines.some((line) => line.msg === 'run started')).toBe(true);
    expect(lines.some((line) => line.msg === 'run finished')).toBe(true);
  }, 60_000);

  it('无任务时退出 2 并提示缺少任务', () => {
    const run = runCli(sourceCli, ['run']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('task is required');
  }, 60_000);

  it('--version 与 package.json 一致', () => {
    const run = runCli(sourceCli, ['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(readPackageInfo().version);
  }, 60_000);

  it('非法 --log-level 退出 2', () => {
    const run = runCli(sourceCli, ['run', '--no-plan', '--log-level', 'nope']);
    expect(run.status).toBe(2);
  }, 60_000);

  it('日志目录越界时退出 2 且不创建目录', () => {
    const run = runCli(sourceCli, ['run', '--no-plan', 'escape check'], {
      AGENT_LOG_DIR: '../escaped-logs',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('must stay inside');
    expect(existsSync(path.join(workspace, 'logs'))).toBe(false);
  }, 60_000);

  it('pretty 模式下控制台为人类可读文本，文件侧仍是 JSONL', () => {
    const run = runCli(sourceCli, ['run', '--no-plan', 'pretty demo'], {
      AGENT_LOG_PRETTY: 'true',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('INFO');
    expect(run.stdout).toContain('run started');
    expect(run.stdout).toContain('echo: pretty demo');

    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => line.msg === 'run started')).toBe(true);
  }, 60_000);

  it('真实密钥不出现在 stdout、stderr 与日志文件中', () => {
    const secret = 'sk-smoke-top-secret';
    const run = runCli(sourceCli, ['run', '--no-plan', 'secret check'], {
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: secret,
      LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      LLM_MODEL: 'some-model',
      LLM_MAX_RETRIES: '0',
    });
    // 网络失败是预期路径：本用例只关心密钥不被打印
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);

    const file = logFilePath();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(secret);
  }, 60_000);
});

describe('构建产物入口（node dist）', () => {
  it('--version 退出 0 且版本一致', () => {
    const run = runCli(distCli, ['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(readPackageInfo().version);
  }, 60_000);

  it('run 命令退出 0 并写出日志', () => {
    const run = runCli(distCli, ['run', '--no-plan', 'dist demo']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('echo: dist demo');
    expect(readLogLines().length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('配置错误退出 2', () => {
    const run = runCli(distCli, ['run', '--no-plan', 'config check'], {
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: '',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('LLM_API_KEY');
  }, 60_000);
});
