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

    const run = runCli(['run', '--no-plan', '读取 note.txt 并总结'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

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

    const run = runCli(['run', '--no-plan', '无限循环'], {
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

    const run = runCli(['run', '--no-plan', '读取 .env'], { AGENT_MOCK_SCRIPT: 'script.json' });

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

    const run = runCli(['run', '--no-plan', '越权读取'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('无法访问工作区外。');
  }, 60_000);

  it('多步任务：列目录 → 搜索 → 读取后作答', () => {
    writeFileSync(path.join(workspace, 'app.ts'), 'const greeting = "hello";\n');
    useScript([
      { toolCalls: [{ name: 'list_files', arguments: '{"path":".","recursive":false}' }] },
      { toolCalls: [{ name: 'search_code', arguments: '{"pattern":"greeting","path":"."}' }] },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"app.ts"}' }] },
      { content: 'app.ts 第 1 行定义了 greeting。' },
    ]);

    const run = runCli(['run', '--no-plan', '找出 greeting 的定义'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[1] → list_files');
    expect(run.stdout).toContain('[2] → search_code');
    expect(run.stdout).toContain('[3] → read_file {"path":"app.ts"}');
    expect(run.stdout).toContain('app.ts 第 1 行定义了 greeting。');
    expect(run.stdout).toContain('iterations=4  tools=3');
  }, 60_000);

  it('find_files 检索后读取文件作答，横幅展示上下文统计', () => {
    writeFileSync(path.join(workspace, 'extra.txt'), 'extra file\n');
    useScript([
      { toolCalls: [{ name: 'find_files', arguments: '{"glob":"*.txt"}' }] },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: '文本文件有 note.txt 与 extra.txt。' },
    ]);

    const run = runCli(['run', '--no-plan', '找出所有文本文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('context   : budget=16000 tokens  repo-map=');
    expect(run.stdout).toContain('[1] → find_files {"glob":"*.txt"}');
    expect(run.stdout).toContain('note.txt');
    expect(run.stdout).toContain('[2] → read_file {"path":"note.txt"}');
    expect(run.stdout).toContain('文本文件有 note.txt 与 extra.txt。');
    expect(run.stdout).toContain('iterations=3  tools=2');

    const log = logText();
    expect(log).toContain('"msg":"context built"');
    expect(log).toContain('"module":"context"');
    expect(log).toContain('"msg":"run finished"');
  }, 60_000);

  it('预算不足时省略项目地图并在横幅标注 0 tokens', () => {
    useScript([{ content: '完成。' }]);

    const run = runCli(['run', '--no-plan', 'x'.repeat(6000)], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_CONTEXT_BUDGET_TOKENS: '1000',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('context   : budget=1000 tokens  repo-map=0 tokens  files=0');
    expect(run.stdout).toContain('完成。');
  }, 60_000);

  it('重复同一工具调用时熔断并退出 1', () => {
    const repeated = { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] };
    useScript([repeated, repeated, repeated]);

    const run = runCli(['run', '--no-plan', '重复读取'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('repeated_tool_call');
    expect(run.stdout).toContain('iterations=3  tools=2');
  }, 60_000);

  it('连续工具失败达到阈值时退出 1', () => {
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"missing-1.txt"}' }] },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"missing-2.txt"}' }] },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"missing-3.txt"}' }] },
    ]);

    const run = runCli(['run', '--no-plan', '反复读取不存在的文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_MAX_CONSECUTIVE_FAILURES: '2',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('tool_failure_limit');
    expect(run.stdout).toContain('iterations=2  tools=2');
  }, 60_000);

  it('空答案退出 1 且标记为未完成', () => {
    useScript([{ content: '' }]);

    const run = runCli(['run', '--no-plan', '给出答案'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('empty_answer');
    expect(run.stdout).toContain('iterations=1  tools=0');
  }, 60_000);
});
