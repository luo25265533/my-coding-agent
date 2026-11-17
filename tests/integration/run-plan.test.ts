import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCli = path.join(projectRoot, 'src', 'cli', 'main.ts');

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-run-plan-'));
  writeFileSync(path.join(workspace, 'note.txt'), 'hello from note\n');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

interface PlanFixtureStep {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly files?: readonly string[];
}

function planContent(steps: readonly PlanFixtureStep[], notes?: string): string {
  return JSON.stringify({
    goal: 'finish the task',
    steps: steps.map((step) => ({
      description: step.description ?? `do ${step.title}`,
      ...step,
    })),
    notes,
  });
}

function useScript(steps: unknown): void {
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(steps));
}

function logText(): string {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(workspace, 'logs', `agent-${date}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('run 规划与执行（离线 mock 脚本驱动）', () => {
  it('--plan-only 输出 Plan 但不执行', () => {
    useScript([{ content: planContent([{ id: 's1', title: 'create file', files: ['new.txt'] }]) }]);

    const run = runCli(['run', '--plan-only', '创建文件'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('plan:');
    expect(run.stdout).toContain('goal: finish the task');
    expect(run.stdout).toContain('[s1] create file');
    expect(run.stdout).toContain('files: new.txt');
    expect(run.stdout).not.toContain('step 1/1 →');
    expect(existsSync(path.join(workspace, 'new.txt'))).toBe(false);
    expect(logText()).toContain('"msg":"plan only"');
  }, 60_000);

  it('--yes 按步骤执行 write_file 与 read_file', () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]) },
      {
        toolCalls: [
          { name: 'write_file', arguments: '{"path":"generated.txt","content":"from plan"}' },
        ],
      },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"generated.txt"}' }] },
      { content: '文件已创建并读取。' },
    ]);

    const run = runCli(['run', '--yes', '创建并核对文件'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('step 1/1 → create file');
    expect(run.stdout).toContain('[1] → write_file');
    expect(run.stdout).toContain('[2] → read_file {"path":"generated.txt"}');
    expect(run.stdout).toContain('from plan');
    expect(run.stdout).toContain('step 1/1 ← completed');
    expect(run.stdout).toContain('plan completed  steps=1  tools=2');
    expect(run.stdout).toContain('文件已创建并读取。');
    expect(readFileSync(path.join(workspace, 'generated.txt'), 'utf8')).toBe('from plan');

    const log = logText();
    expect(log).toContain('"msg":"plan generated"');
    expect(log).toContain('"msg":"plan confirmed"');
    expect(log).toContain('"msg":"step started"');
    expect(log).toContain('"msg":"run finished"');
  }, 60_000);

  it('非交互 stdin 未传 --yes 时拒绝执行', () => {
    useScript([{ content: planContent([{ id: 's1', title: 'create file', files: ['new.txt'] }]) }]);

    const run = runCli(['run', '创建文件'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'non-interactive stdin: plan not executed (pass --yes to execute)',
    );
    expect(run.stdout).toContain('plan declined; nothing executed');
    expect(existsSync(path.join(workspace, 'new.txt'))).toBe(false);
  }, 60_000);

  it('覆盖非空文件需要确认：非交互下拒绝且内容不变', () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'overwrite note', files: ['note.txt'] }]) },
      {
        toolCalls: [
          { name: 'write_file', arguments: '{"path":"note.txt","content":"overwritten"}' },
        ],
      },
      { content: '覆盖被拒绝。' },
    ]);

    const run = runCli(['run', '--yes', '覆盖文件'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[1] ← error');
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('high-risk action denied (non-interactive)');
    expect(readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('hello from note\n');
  }, 60_000);

  it('git push 即使 --yes 也被硬拒绝', () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'push' }]) },
      { toolCalls: [{ name: 'run_command', arguments: '{"command":"git push origin main"}' }] },
      { content: '不允许推送。' },
    ]);

    const run = runCli(['run', '--yes', '推送代码'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('不允许推送。');
  }, 60_000);

  it('高风险命令非交互下拒绝执行', () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'clean' }]) },
      { toolCalls: [{ name: 'run_command', arguments: '{"command":"git clean -fd"}' }] },
      { content: '高风险命令被拒绝。' },
    ]);

    const run = runCli(['run', '--yes', '清理工作区'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('high-risk action denied (non-interactive)');
    expect(run.stdout).toContain('高风险命令被拒绝。');
  }, 60_000);

  it('子进程环境不包含 LLM_API_KEY，密钥不落 stdout/日志', () => {
    const secret = 'super-secret-key-value';
    useScript([
      { content: planContent([{ id: 's1', title: 'inspect env' }]) },
      {
        toolCalls: [
          {
            name: 'run_command',
            arguments: JSON.stringify({
              command: 'node -e "console.log(process.env.LLM_API_KEY ?? \'unset\')"',
            }),
          },
        ],
      },
      { content: '环境变量已检查。' },
    ]);

    const run = runCli(['run', '--yes', '检查环境变量'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      LLM_API_KEY: secret,
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('unset');
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
    expect(logText()).not.toContain(secret);
  }, 60_000);

  it('Planner 输出非法时退出 1', () => {
    useScript([{ content: 'not a plan' }, { content: 'still not a plan' }]);

    const run = runCli(['run', '任务'], { AGENT_MOCK_SCRIPT: 'script.json' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('planner failed to produce a valid plan after 2 attempts');
    expect(run.stderr).toContain('did not contain a JSON object');
  }, 60_000);

  it('步骤失败时退出 1 且不执行后续步骤', () => {
    useScript([
      {
        content: planContent([
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
        ]),
      },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: 'second step should not run' },
    ]);

    const run = runCli(['run', '--yes', '分步执行'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_STEP_MAX_ITERATIONS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('plan failed at step s1: max_iterations');
    expect(run.stdout).not.toContain('step 2/2');
    expect(run.stderr).toContain('plan step s1 failed (max_iterations)');
  }, 60_000);
});
