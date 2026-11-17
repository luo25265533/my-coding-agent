import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  logText,
  printedTaskId,
  readTask,
  readTaskSummaries,
  runCli,
  type TestWorkspace,
} from './helpers.js';

const VERIFY_GENERATED =
  "node -e \"const fs=require('fs');process.exit(fs.existsSync('generated.txt')&&fs.readFileSync('generated.txt','utf8')==='hello-v1'?0:1)\"";
const VERIFY_FIXED =
  "node -e \"const fs=require('fs');process.exit(fs.existsSync('generated.txt')&&fs.readFileSync('generated.txt','utf8')==='fixed'?0:1)\"";

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createWorkspace('agent-task-lifecycle-');
  workspace.write('note.txt', 'hello from note\n');
});

afterEach(async () => {
  await workspace.cleanup();
});

interface PlanStepFixture {
  readonly id: string;
  readonly title: string;
  readonly files?: readonly string[];
}

function planContent(steps: readonly PlanStepFixture[]): string {
  return JSON.stringify({
    goal: 'finish the task',
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: `do ${step.title}`,
      files: step.files ?? [],
    })),
    notes: undefined,
  });
}

function writeFileCall(path: string, content: string): unknown {
  return {
    toolCalls: [{ name: 'write_file', arguments: JSON.stringify({ path, content }) }],
  };
}

describe('任务生命周期端到端（真实 CLI 子进程 + mock provider）', () => {
  it('规划 → 写入 → 验证通过 → 任务完成，并可由 tasks 查看与 no-op 恢复', async () => {
    workspace.script([
      { content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]) },
      writeFileCall('generated.txt', 'hello-v1'),
      { content: 'created generated.txt' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '创建文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_VERIFY_COMMAND: VERIFY_GENERATED,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('verification: passed');
    expect(run.stdout).toContain('task completed:');
    expect(workspace.read('generated.txt')).toBe('hello-v1');

    const taskId = printedTaskId(run.stdout);
    expect(taskId).toBeDefined();
    const task = await readTask(workspace.dir, taskId ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.steps.map((step) => step.status)).toEqual(['completed']);
    expect(task?.verifications.at(-1)?.status).toBe('passed');

    const list = runCli(workspace.dir, ['tasks', 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(taskId ?? 'missing-task-id');
    expect(list.stdout).toContain('completed');

    const show = runCli(workspace.dir, ['tasks', 'show', taskId ?? '']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain(`task      : ${taskId ?? ''}`);
    expect(show.stdout).toContain('status    : completed');
    expect(show.stdout).toContain('1. passed');
    expect(show.stdout).not.toContain('verification: passed');

    const summaries = await readTaskSummaries(workspace.dir);
    expect(summaries.map((summary) => summary.id)).toContain(taskId);

    const again = runCli(workspace.dir, ['run', '--resume', taskId ?? '']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`task completed: ${taskId ?? ''}`);
    expect((await readTask(workspace.dir, taskId ?? ''))?.resumeCount).toBe(0);
  }, 60_000);

  it('步骤失败后保留已完成前缀，--resume 从失败步骤继续并完成', async () => {
    workspace.script([
      {
        content: planContent([
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
        ]),
      },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
    ]);

    const failed = runCli(workspace.dir, ['run', '--yes', '分步执行'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_STEP_MAX_ITERATIONS: '1',
    });

    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('plan failed at step s1: max_iterations');
    expect(failed.stdout).toContain('task step_failed:');
    expect(failed.stdout).toContain('resume with: agent run --resume');

    const taskId = printedTaskId(failed.stdout);
    expect(taskId).toBeDefined();
    const stored = await readTask(workspace.dir, taskId ?? '');
    expect(stored?.status).toBe('step_failed');
    expect(stored?.steps.map((step) => step.status)).toEqual(['failed', 'pending']);

    workspace.script([{ content: 'first fixed' }, { content: 'second done' }]);
    const resumed = runCli(workspace.dir, ['run', '--resume', taskId ?? '']);

    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain(
      `resuming task ${taskId ?? ''} (status=step_failed, completed steps 0/2)`,
    );
    expect(resumed.stdout).toContain('task completed:');

    const completed = await readTask(workspace.dir, taskId ?? '');
    expect(completed?.status).toBe('completed');
    expect(completed?.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(completed?.resumeCount).toBe(1);
  }, 60_000);

  it('验证失败后自动修复一轮，再次验证通过并落库 repairs=1', async () => {
    workspace.script([
      { content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]) },
      { content: 'initial attempt' },
      writeFileCall('generated.txt', 'fixed'),
      { content: 'repair applied' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '--verify', VERIFY_FIXED, '修复文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_MAX_REPAIR_ATTEMPTS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('verification: failed');
    expect(run.stdout).toContain('repair 1/1: answered');
    expect(run.stdout).toContain('verification: passed');
    expect(run.stdout).toContain('task completed:');
    expect(workspace.read('generated.txt')).toBe('fixed');

    const task = await readTask(workspace.dir, printedTaskId(run.stdout) ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.repairAttempts).toBe(1);
  }, 60_000);

  it('修复耗尽后任务失败并保留恢复提示', async () => {
    workspace.script([
      { content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]) },
      { content: 'initial attempt' },
      writeFileCall('generated.txt', 'still-wrong'),
      { content: 'repair did not help' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '--verify', VERIFY_FIXED, '修复文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_MAX_REPAIR_ATTEMPTS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('verification: failed (exit=1');
    expect(run.stdout).toContain('repair 1/1: answered');
    expect(run.stdout).toContain('task failed:');
    expect(run.stdout).toContain('resume with: agent run --resume');

    const task = await readTask(workspace.dir, printedTaskId(run.stdout) ?? '');
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('verification failed after 1 repair attempt');
  }, 60_000);

  it('--no-plan 不创建任务库', () => {
    workspace.script([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: 'done' },
    ]);

    const run = runCli(workspace.dir, ['run', '--no-plan', '--yes', '直接执行'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('answer:\ndone');
    expect(workspace.exists('.agent/tasks.db')).toBe(false);
  }, 60_000);

  it('--no-verify 跳过验证命令且不产生副作用', async () => {
    workspace.script([
      { content: planContent([{ id: 's1', title: 'answer only' }]) },
      { content: 'done' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '--no-verify', '无需验证'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_VERIFY_COMMAND: "node -e \"require('fs').writeFileSync('verify-ran','1')\"",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('verification: skipped (verification disabled)');
    expect(workspace.exists('verify-ran')).toBe(false);

    const task = await readTask(workspace.dir, printedTaskId(run.stdout) ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.verifications.at(-1)?.status).toBe('skipped');
  }, 60_000);

  it('验证输出中的密钥在落库与日志前被脱敏', async () => {
    const secret = 'super-secret-key-value';
    workspace.write('secret-input.txt', secret);
    workspace.script([
      { content: planContent([{ id: 's1', title: 'answer only' }]) },
      { content: 'done' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '检查脱敏'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      LLM_API_KEY: secret,
      AGENT_VERIFY_COMMAND:
        "node -e \"console.log(require('fs').readFileSync('secret-input.txt','utf8'))\"",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
    expect(logText(workspace.dir)).not.toContain(secret);

    const task = await readTask(workspace.dir, printedTaskId(run.stdout) ?? '');
    expect(task?.verifications.at(-1)?.status).toBe('passed');
    expect(task?.verifications.at(-1)?.output).toContain('[REDACTED]');
    expect(task?.verifications.at(-1)?.output).not.toContain(secret);
    expect(workspace.read('.agent/tasks.db') ?? '').not.toContain(secret);
  }, 60_000);

  it('极小上下文预算下仍能完成，并记录 context 裁剪日志', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index} ${'x'.repeat(80)}`);
    workspace.write('big.txt', `${lines.join('\n')}\n`);
    workspace.script([
      { content: planContent([{ id: 's1', title: 'read big file', files: ['big.txt'] }]) },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"big.txt","limit":400}' }] },
      { content: 'read it' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', '读取大文件'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_CONTEXT_BUDGET_TOKENS: '1000',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('task completed:');
    expect(run.stdout).toContain('context trimmed: dropped=');
    expect(logText(workspace.dir)).toContain('"msg":"context trimmed"');
  }, 60_000);
});
