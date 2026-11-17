import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasksCommand, tasksShowCommand } from '../../src/cli/commands/tasks.js';
import { createTaskStore } from '../../src/memory/index.js';
import type { TaskStepRecord } from '../../src/memory/types.js';
import type { TaskPlan } from '../../src/shared/plan.js';
import { AgentError, ErrorCode, ExitCode } from '../../src/shared/errors.js';

function spyStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

let workspace: string;
let stdoutSpy: ReturnType<typeof spyStdout>;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-tasks-'));
  stdoutSpy = spyStdout();
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function printed(): string {
  return stdoutSpy.mock.calls.map((call) => (typeof call[0] === 'string' ? call[0] : '')).join('');
}

function plan(goal: string, stepId: string): TaskPlan {
  return {
    goal,
    steps: [{ id: stepId, title: `do ${stepId}`, description: `run ${stepId}`, files: [] }],
    notes: undefined,
  };
}

interface CreatedTask {
  readonly id: string;
}

async function createCompletedTask(
  goal: string,
  stepId: string,
  output: string,
  verification: { status?: 'passed' | 'failed'; reason?: string } = {},
): Promise<CreatedTask> {
  const verifyStatus = verification.status ?? 'passed';
  const store = await createTaskStore({
    dbPath: path.join(workspace, '.agent', 'tasks.db'),
    workspace,
  });
  try {
    const task = await store.createTask({
      goal,
      plan: plan(goal, stepId),
      workspace,
      verifyCommand: 'pnpm test',
      verifyAutoSkip: false,
      baselineDiff: undefined,
    });
    await store.transition(task.id, 'running');
    await store.startStep(task.id, 0);
    const step: TaskStepRecord = {
      index: 0,
      step: task.plan.steps[0]!,
      status: 'completed',
      answer: 'done',
      iterations: 1,
      toolCalls: 0,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedTokens: 0,
      },
      stopReason: 'answer',
      startedAt: undefined,
      finishedAt: Date.now(),
    };
    await store.finishStep(task.id, step);
    await store.transition(task.id, 'verifying');
    await store.recordVerification(task.id, {
      status: verifyStatus,
      command: 'pnpm test',
      attempt: 1,
      exitCode: verifyStatus === 'failed' ? 1 : 0,
      timedOut: false,
      durationMs: 320,
      output,
      reason: verification.reason,
    });
    await store.recordDiff(task.id, {
      available: true,
      reason: undefined,
      files: [{ path: 'src/a.ts', status: 'modified', insertions: 4, deletions: 1 }],
      totalInsertions: 4,
      totalDeletions: 1,
      truncated: false,
    });
    await store.transition(
      task.id,
      verifyStatus === 'passed' ? 'completed' : 'failed',
      verifyStatus === 'passed' ? undefined : { error: 'verification failed' },
    );
    return { id: task.id };
  } finally {
    await store.close();
  }
}

async function createPlannedTask(goal: string, stepId: string): Promise<CreatedTask> {
  const store = await createTaskStore({
    dbPath: path.join(workspace, '.agent', 'tasks.db'),
    workspace,
  });
  try {
    const task = await store.createTask({
      goal,
      plan: plan(goal, stepId),
      workspace,
      verifyCommand: undefined,
      verifyAutoSkip: false,
      baselineDiff: undefined,
    });
    return { id: task.id };
  } finally {
    await store.close();
  }
}

describe('tasks list', () => {
  it('无任务时输出 no tasks', async () => {
    await tasksCommand({ workspace });
    expect(printed()).toBe('no tasks\n');
  });

  it('列出任务状态、步骤进度与目标', async () => {
    const completed = await createCompletedTask('first goal', 's1', 'secret-output');
    const planned = await createPlannedTask('second goal', 's2');

    await tasksCommand({ workspace });

    const out = printed();
    expect(out).toContain(completed.id);
    expect(out).toContain(planned.id);
    expect(out).toContain('completed');
    expect(out).toContain('planned');
    expect(out).toContain('steps=1/1');
    expect(out).toContain('steps=0/1');
    expect(out).toContain('first goal');
    expect(out).toContain('second goal');
    expect(out).not.toContain('secret-output');
  });

  it('--limit 限制条目数量', async () => {
    const first = await createCompletedTask('first goal', 's1', 'x');
    const second = await createPlannedTask('second goal', 's2');

    await tasksCommand({ workspace, limit: 1 });

    const ids = [first.id, second.id].filter((id) => printed().includes(id));
    expect(ids).toHaveLength(1);
  });
});

describe('tasks show', () => {
  it('输出任务详情、步骤、验证与差异，但不输出完整命令输出', async () => {
    const created = await createCompletedTask('show me', 's1', 'SUPER-SECRET-OUTPUT');

    await tasksShowCommand(created.id, { workspace });

    const out = printed();
    expect(out).toContain(`task      : ${created.id}`);
    expect(out).toContain('goal      : show me');
    expect(out).toContain('status    : completed');
    expect(out).toContain('steps     : 1/1');
    expect(out).toContain('verify    : pnpm test');
    expect(out).toContain('[s1] do s1 — completed');
    expect(out).toContain('1. passed (attempt=1, exit=0, 320ms)');
    expect(out).toContain('1. 1 files, +4 -1');
    expect(out).not.toContain('SUPER-SECRET-OUTPUT');
  });

  it('失败验证输出原因与输出尾部，不输出完整长文本', async () => {
    const longOutput = `head-start ${'x'.repeat(1400)} TAIL-MARKER`;
    const created = await createCompletedTask('failed show', 's1', longOutput, {
      status: 'failed',
      reason: 'exit code 1',
    });

    await tasksShowCommand(created.id, { workspace });

    const out = printed();
    expect(out).toContain('status    : failed');
    expect(out).toContain('1. failed (attempt=1, exit=1, 320ms)');
    expect(out).toContain('reason: exit code 1');
    expect(out).toContain('output:');
    expect(out).toContain('TAIL-MARKER');
    expect(out).not.toContain('head-start');
  });

  it('planned 任务显示 disabled 验证与 pending 步骤', async () => {
    const created = await createPlannedTask('later', 's1');

    await tasksShowCommand(created.id, { workspace });

    const out = printed();
    expect(out).toContain('status    : planned');
    expect(out).toContain('verify    : disabled');
    expect(out).toContain('— pending');
    expect(out).toContain('(none)');
  });

  it('任务不存在或 ID 非法时抛 TaskNotFound（退出码 2）', async () => {
    const missing = await tasksShowCommand('00000000-0000-4000-8000-000000000000', {
      workspace,
    }).catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(AgentError);
    expect((missing as AgentError).code).toBe(ErrorCode.TaskNotFound);
    expect((missing as AgentError).exitCode).toBe(ExitCode.UsageError);

    const invalid = await tasksShowCommand('not-a-uuid', { workspace }).catch(
      (caught: unknown) => caught,
    );
    expect(invalid).toBeInstanceOf(AgentError);
    expect((invalid as AgentError).code).toBe(ErrorCode.TaskNotFound);
  });
});
