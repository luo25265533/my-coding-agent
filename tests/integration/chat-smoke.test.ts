import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCli = path.join(projectRoot, 'src', 'cli', 'main.ts');
const distCli = path.join(projectRoot, 'dist', 'cli', 'main.js');
const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** 回环地址上必然拒连的端口，用于制造单轮失败且不触达外网 */
const REFUSED_BASE_URL = 'http://127.0.0.1:1/v1';

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
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-chat-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface ChatRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runChat(
  entry: string,
  input: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): ChatRun {
  const nodeArgs = entry.endsWith('.ts') ? ['--import', 'tsx', entry, ...args] : [entry, ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    input,
    env: {
      ...process.env,
      AGENT_WORKSPACE: workspace,
      AGENT_LOG_DIR: 'logs',
      AGENT_LOG_PRETTY: 'false',
      AGENT_LOG_LEVEL: 'info',
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

function promptTokensPerTurn(): number[] {
  return readLogLines()
    .filter((line) => line.msg === 'turn completed')
    .map((line) => {
      const usage = line.usage as { promptTokens: number } | undefined;
      return usage?.promptTokens ?? -1;
    });
}

describe('chat REPL（源码入口，mock provider，全程离线）', () => {
  it('多轮对话持续进行，退出 0 并记录每轮用量', () => {
    const run = runChat(sourceCli, 'hello\nworld\n/exit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('interactive chat');
    expect(run.stdout).toContain('provider: mock');
    expect(run.stdout).toContain('echo: hello');
    expect(run.stdout).toContain('echo: world');
    expect(run.stdout).toContain('[tokens] prompt=');

    const lines = readLogLines();
    expect(lines.some((line) => line.msg === 'chat started')).toBe(true);
    expect(lines.filter((line) => line.msg === 'turn completed')).toHaveLength(2);
    const finished = lines.find((line) => line.msg === 'chat finished');
    expect(finished?.turns).toBe(2);
    expect(lines.every((line) => line.module === 'chat')).toBe(true);

    const runId = /runId:\s*([0-9a-f-]+)/.exec(run.stdout)?.[1];
    expect(runId).toBeDefined();
    expect(lines.every((line) => line.runId === runId)).toBe(true);
  }, 60_000);

  it('历史逐轮累积，/clear 后回到初始长度', () => {
    const run = runChat(sourceCli, 'aa\nbb\n/clear\ncc\n/exit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('history cleared');

    const prompts = promptTokensPerTurn();
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBeGreaterThan(prompts[0] ?? 0);
    expect(prompts[2]).toBe(prompts[0]);
  }, 60_000);

  it('/help 打印命令且不消耗对话轮次', () => {
    const run = runChat(sourceCli, '/help\n/exit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('/clear');
    expect(run.stdout).toContain('/exit');
    expect(promptTokensPerTurn()).toHaveLength(0);
  }, 60_000);

  it('空行被忽略，未知斜杠命令当作普通消息', () => {
    const run = runChat(sourceCli, '\n   \n/unknown\n/exit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('echo: /unknown');
    expect(promptTokensPerTurn()).toHaveLength(1);
  }, 60_000);

  it('/quit 与 /exit 等价', () => {
    const run = runChat(sourceCli, 'hi\n/quit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('echo: hi');
    expect(readLogLines().find((line) => line.msg === 'chat finished')?.turns).toBe(1);
  }, 60_000);

  it('stdin 结束（EOF）时优雅退出，无需 /exit', () => {
    const run = runChat(sourceCli, 'only one turn\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('echo: only one turn');
    expect(readLogLines().find((line) => line.msg === 'chat finished')?.turns).toBe(1);
  }, 60_000);

  it('--model 覆盖配置并显示在横幅中', () => {
    const run = runChat(sourceCli, '/exit\n', ['chat', '--model', 'custom-model']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('model: custom-model');
  }, 60_000);

  it('单轮请求失败只报错，不终止 REPL', () => {
    const run = runChat(sourceCli, 'first\nsecond\n/exit\n', ['chat'], {
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: 'placeholder-not-a-real-key',
      LLM_BASE_URL: REFUSED_BASE_URL,
      LLM_MODEL: 'some-model',
      LLM_MAX_RETRIES: '0',
      LLM_TIMEOUT_MS: '3000',
    });
    expect(run.status).toBe(0);
    expect(run.stderr.match(/error:/g)).toHaveLength(2);
    expect(readLogLines().filter((line) => line.msg === 'turn failed')).toHaveLength(2);
    expect(readLogLines().find((line) => line.msg === 'chat finished')?.turns).toBe(2);
  }, 60_000);

  it('密钥不出现在 stdout、stderr 与日志文件中', () => {
    const secret = 'sk-chat-top-secret';
    const run = runChat(sourceCli, 'hello\n/exit\n', ['chat'], {
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: secret,
      LLM_BASE_URL: REFUSED_BASE_URL,
      LLM_MODEL: 'some-model',
      LLM_MAX_RETRIES: '0',
      LLM_TIMEOUT_MS: '3000',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
    expect(readFileSync(logFilePath(), 'utf8')).not.toContain(secret);
  }, 60_000);

  it('日志目录越界时退出 2 且不创建目录', () => {
    const run = runChat(sourceCli, '/exit\n', ['chat'], { AGENT_LOG_DIR: '../escaped-logs' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('must stay inside');
    expect(existsSync(path.join(workspace, 'logs'))).toBe(false);
  }, 60_000);
});

describe('chat REPL（构建产物入口）', () => {
  it('node dist 下多轮对话可用且退出 0', () => {
    const run = runChat(distCli, 'dist hello\n/exit\n', ['chat']);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('echo: dist hello');
    expect(readLogLines().filter((line) => line.msg === 'turn completed')).toHaveLength(1);
  }, 60_000);

  it('缺少必需配置时退出 2', () => {
    const run = runChat(distCli, '/exit\n', ['chat'], {
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: '',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('LLM_API_KEY');
  }, 60_000);
});
