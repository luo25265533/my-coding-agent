import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import type { RunEventSink } from '../../src/cli/run-events.js';
import { createTaskStore } from '../../src/memory/index.js';
import type { TaskRecord } from '../../src/memory/types.js';
import { AgentError, ErrorCode, ExitCode } from '../../src/shared/errors.js';

const { questionMock } = vi.hoisted(() => ({
  questionMock: vi.fn<(question: string) => Promise<string>>(),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: vi.fn() }),
}));

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

async function readTask(workspacePath: string, taskId: string): Promise<TaskRecord | undefined> {
  const store = await createTaskStore({
    dbPath: path.join(workspacePath, '.agent', 'tasks.db'),
    workspace: workspacePath,
    readOnly: true,
  });
  try {
    return await store.getTask(taskId);
  } finally {
    await store.close();
  }
}

function printedTaskId(pattern: RegExp): string {
  const match = pattern.exec(printed());
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('runCommand', () => {
  it('驱动工具循环：读取文件后给出答案', async () => {
    useScript([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: '文件内容是 hello from tool。' },
    ]);

    const result = await runCommand(['总结', 'note.txt'], { workspace, noPlan: true });

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
    expect(new Set(lines.map((line) => line.module))).toEqual(new Set(['cli', 'agent', 'context']));
  });

  it('无任务时抛 UsageInvalid（退出码 2）', async () => {
    const error = await runCommand([], { workspace, noPlan: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((error as AgentError).exitCode).toBe(ExitCode.UsageError);
  });

  it('无脚本时 mock 回显任务，单轮结束', async () => {
    const result = await runCommand(['fix', 'the', 'bug'], { workspace, noPlan: true });
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.content).toBe('echo: fix the bug');
    expect(printed()).toContain('echo: fix the bug');
  });

  it('--log-level debug 覆盖生效，debug 行落盘', async () => {
    const result = await runCommand(['x'], { workspace, logLevel: 'debug', noPlan: true });
    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'configuration loaded')).toBe(true);
    expect(lines.some((line) => line.msg === 'iteration completed')).toBe(true);
  });

  it('--verbose 等价于 debug；默认 info 不写 debug 行', async () => {
    const verbose = await runCommand(['x'], { workspace, verbose: true, noPlan: true });
    expect(logLines(verbose.logFile).some((line) => line.msg === 'configuration loaded')).toBe(
      true,
    );

    // 日志文件当天复用，按 runId 只看本次运行
    const normal = await runCommand(['x'], { workspace, noPlan: true });
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

    await runCommand(['long args'], { workspace, noPlan: true });

    const out = printed();
    expect(out).toContain('[1] → search_code ');
    expect(out).toContain('…');
    expect(out).not.toContain(longPattern);
  });

  it('空答案抛 AgentIncomplete（退出码 1）', async () => {
    useScript([{ content: '' }]);

    const error = await runCommand(['answer'], { workspace, noPlan: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.AgentIncomplete);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);
    expect((error as Error).message).toContain('empty_answer');
    expect(printed()).toContain('iterations=1  tools=0');
  });

  it('迭代上限耗尽抛 AgentMaxIterations（退出码 1）', async () => {
    useScript([{ toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] }]);
    vi.stubEnv('AGENT_MAX_ITERATIONS', '1');

    const error = await runCommand(['loop'], { workspace, noPlan: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.AgentMaxIterations);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);
    expect(printed()).toContain('[1] → read_file');

    const logFile = path.join(workspace, '.agent', 'logs');
    expect(existsSync(logFile)).toBe(true);
  });
});

describe('runCommand planned flow', () => {
  it('--plan-only 只生成并打印 Plan，不执行任何步骤', async () => {
    useScript([
      {
        content: planContent(
          [
            { id: 's1', title: 'write note', files: ['generated.txt'] },
            { id: 's2', title: 'review' },
          ],
          'keep it small',
        ),
      },
    ]);

    const result = await runCommand(['要', '做完'], { workspace, planOnly: true });

    expect(result.stopReason).toBe('plan_only');
    expect(result.plan?.goal).toBe('finish the task');
    expect(result.plan?.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(result.steps).toHaveLength(0);
    expect(result.iterations).toBe(0);
    expect(existsSync(path.join(workspace, 'generated.txt'))).toBe(false);

    const out = printed();
    expect(out).toContain('plan:');
    expect(out).toContain('goal: finish the task');
    expect(out).toContain('1. [s1] write note');
    expect(out).toContain('files: generated.txt');
    expect(out).toContain('notes: keep it small');
    expect(out).toContain('(attempts=1 repo-map=');
    expect(out).not.toContain('step 1/2 →');

    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'plan generated')).toBe(true);
    expect(lines.some((line) => line.msg === 'plan only')).toBe(true);
  });

  it('--yes 跳过 Plan 确认并按步骤执行 write_file', async () => {
    useScript([
      {
        content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]),
      },
      {
        toolCalls: [
          { name: 'write_file', arguments: '{"path":"generated.txt","content":"from plan"}' },
        ],
      },
      { content: 'created generated.txt' },
    ]);

    const result = await runCommand(['创建文件'], { workspace, yes: true });

    expect(result.stopReason).toBe('answer');
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      status: 'completed',
      iterations: 2,
      toolCalls: 1,
      answer: 'created generated.txt',
    });
    expect(readFileSync(path.join(workspace, 'generated.txt'), 'utf8')).toBe('from plan');

    const out = printed();
    expect(out).toContain('step 1/1 → create file');
    expect(out).toContain('step 1/1 ← completed');
    expect(out).toContain('[1] → write_file');
    expect(out).toContain('plan completed  steps=1  tools=1');
    expect(out).toContain('answer:\ncreated generated.txt');

    const lines = logLines(result.logFile);
    expect(lines.some((line) => line.msg === 'plan confirmed')).toBe(true);
    expect(lines.filter((line) => line.msg === 'step started')).toHaveLength(1);
    expect(lines.some((line) => line.msg === 'run finished')).toBe(true);
  });

  it('Plan 被拒绝时不执行步骤', async () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'create file', files: ['generated.txt'] }]) },
    ]);
    const approvePlan = vi.fn(() => Promise.resolve(false));

    const result = await runCommand(['创建文件'], { workspace, approvePlan });

    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('plan_declined');
    expect(result.steps).toHaveLength(0);
    expect(existsSync(path.join(workspace, 'generated.txt'))).toBe(false);
    expect(printed()).toContain('plan declined; nothing executed');
    expect(logLines(result.logFile).some((line) => line.msg === 'plan declined')).toBe(true);
  });

  it('非交互环境未传 --yes 时拒绝执行并提示', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'only' }]) }]);

    const result = await runCommand(['任务'], { workspace });

    expect(result.stopReason).toBe('plan_declined');
    expect(printed()).toContain('non-interactive stdin: plan not executed (pass --yes to execute)');
  });

  it('TTY 下询问确认，y 执行、空回答拒绝', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'only' }]) }, { content: 'done' }]);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      questionMock.mockResolvedValueOnce('y');
      const approved = await runCommand(['任务'], { workspace });
      expect(approved.stopReason).toBe('answer');
      expect(questionMock).toHaveBeenCalledWith(
        expect.stringContaining('Execute this plan? [y/N]'),
      );

      questionMock.mockResolvedValueOnce('');
      const declined = await runCommand(['任务'], { workspace });
      expect(declined.stopReason).toBe('plan_declined');
      expect(printed()).toContain('plan declined; nothing executed');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: tty?.value,
        configurable: true,
      });
    }
  });

  it('Planner 连续两次输出非法 JSON 时抛 PlannerInvalid', async () => {
    useScript([{ content: 'not a plan' }, { content: 'still not a plan' }]);

    const error = await runCommand(['任务'], { workspace }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.PlannerInvalid);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);
    expect((error as Error).message).toContain('after 2 attempts');
    expect(printed()).not.toContain('plan:');
  });

  it('步骤失败时停止后续步骤并抛 AgentIncomplete', async () => {
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
    vi.stubEnv('AGENT_STEP_MAX_ITERATIONS', '1');

    const error = await runCommand(['任务'], { workspace, yes: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.AgentIncomplete);
    expect((error as Error).message).toContain('plan step s1 failed (max_iterations)');

    const out = printed();
    expect(out).toContain('step 1/2 → first');
    expect(out).toContain('step 1/2 ← failed');
    expect(out).toContain('plan failed at step s1: max_iterations');
    expect(out).toContain('task step_failed:');
    expect(out).toContain('resume with: agent run --resume');
    expect(out).not.toContain('step 2/2');
  });
});

describe('runCommand 任务持久化与恢复', () => {
  it('--plan-only 落库为 planned 并打印任务 ID 与恢复提示', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }]);

    const result = await runCommand(['任务'], { workspace, planOnly: true });

    expect(result.stopReason).toBe('plan_only');
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);
    const out = printed();
    expect(out).toContain(`task: ${result.taskId ?? ''}`);
    expect(out).toContain(`resume with: agent run --resume ${result.taskId ?? ''}`);
    expect(out).toContain('verify    : pnpm test (auto-skip without package.json)');

    const task = await readTask(workspace, result.taskId ?? '');
    expect(task?.status).toBe('planned');
    expect(task?.verifyCommand).toBe('pnpm test');
    expect(task?.verifyAutoSkip).toBe(true);
  });

  it('默认验证命令在无 package.json 时跳过，任务仍完成', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }, { content: 'done' }]);

    const result = await runCommand(['任务'], { workspace, yes: true });

    expect(result.stopReason).toBe('answer');
    expect(result.taskId).toBeDefined();
    expect(result.verification?.status).toBe('skipped');
    expect(result.verification?.reason).toBe('no package.json');
    expect(printed()).toContain('verification: skipped (no package.json)');
    expect(printed()).toContain('diff: unavailable (not a git repository)');
    expect(printed()).toContain(`task completed: ${result.taskId ?? ''}`);

    const task = await readTask(workspace, result.taskId ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.verifications[0]?.status).toBe('skipped');
  });

  it('--no-verify 关闭验证', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }, { content: 'done' }]);

    const result = await runCommand(['任务'], { workspace, yes: true, noVerify: true });

    expect(result.verification?.status).toBe('skipped');
    expect(result.verification?.reason).toBe('verification disabled');
    expect(printed()).toContain('verification: skipped (verification disabled)');
  });

  it('--verify 覆盖默认命令并执行', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }, { content: 'done' }]);

    const result = await runCommand(['任务'], {
      workspace,
      yes: true,
      verify: 'node -e "process.exit(0)"',
    });

    expect(result.verification?.status).toBe('passed');
    expect(result.verification?.command).toBe('node -e "process.exit(0)"');
    expect(result.taskId).toBeDefined();
    expect(printed()).toContain('verification: passed');
    expect(printed()).toContain('task completed:');

    const task = await readTask(workspace, result.taskId ?? '');
    expect(task?.verifyAutoSkip).toBe(false);
  });

  it('验证失败且修复轮数为 0 时抛 VerificationFailed 并保留 failed 状态', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }, { content: 'done' }]);
    vi.stubEnv('AGENT_MAX_REPAIR_ATTEMPTS', '0');

    const error = await runCommand(['任务'], {
      workspace,
      yes: true,
      verify: 'node -e "process.exit(1)"',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.VerificationFailed);
    expect((error as AgentError).exitCode).toBe(ExitCode.RuntimeError);

    const out = printed();
    expect(out).toContain('verification: failed');
    const taskId = printedTaskId(/task failed: ([0-9a-f-]{36})/);
    expect(out).toContain(`resume with: agent run --resume ${taskId}`);

    const task = await readTask(workspace, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('verification failed after 0 repair attempt(s)');
  });

  it('验证失败后自动修复一轮并再次验证通过', async () => {
    useScript([
      { content: planContent([{ id: 's1', title: 'one' }]) },
      { content: 'initial attempt' },
      { content: 'repair applied' },
    ]);
    vi.stubEnv('AGENT_MAX_REPAIR_ATTEMPTS', '1');
    const verify = `node -e "const fs=require('fs');const f='.verify-once';if(fs.existsSync(f)){fs.rmSync(f);process.exit(0)}else{fs.writeFileSync(f,'1');process.exit(1)}"`;

    const result = await runCommand(['任务'], { workspace, yes: true, verify });

    expect(result.repairs).toBe(1);
    expect(result.verification?.status).toBe('passed');
    expect(result.steps[0]?.answer).toBe('initial attempt');

    const out = printed();
    expect(out).toContain('verification: failed');
    expect(out).toContain('repair 1/1: answered');
    expect(out).toContain('verification: passed');
    expect(out).toContain('task completed:');

    const task = await readTask(workspace, result.taskId ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.repairAttempts).toBe(1);
  });

  it('--resume 执行 planned 任务的步骤，重复恢复已完成任务不再调用模型', async () => {
    useScript([
      {
        content: planContent([
          { id: 's1', title: 'one' },
          { id: 's2', title: 'two' },
        ]),
      },
    ]);
    const planned = await runCommand(['任务'], { workspace, planOnly: true });
    const taskId = planned.taskId ?? '';

    useScript([{ content: 's1 done' }, { content: 's2 done' }]);
    const resumed = await runCommand([], { workspace, resume: taskId, yes: true });

    expect(resumed.stopReason).toBe('answer');
    expect(resumed.steps).toHaveLength(2);
    expect(resumed.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(resumed.taskId).toBe(taskId);
    expect(printed()).toContain(`resuming task ${taskId} (status=planned, completed steps 0/2)`);
    expect(printed()).toContain(`task completed: ${taskId}`);

    useScript([]);
    const again = await runCommand([], { workspace, resume: taskId });

    // 已完成任务直接返回已存储结果，不重新调用模型
    expect(again.iterations).toBe(resumed.iterations);
    expect(again.toolCalls).toBe(resumed.toolCalls);
    expect(again.stopReason).toBe('answer');
    expect(again.taskId).toBe(taskId);
    expect(printed()).toContain(`task completed: ${taskId}`);

    const task = await readTask(workspace, taskId);
    expect(task?.status).toBe('completed');
    expect(task?.resumeCount).toBe(0);
  });

  it('步骤失败后 --resume 从失败步骤继续并完成验证', async () => {
    useScript([
      {
        content: planContent([
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
        ]),
      },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
    ]);
    vi.stubEnv('AGENT_STEP_MAX_ITERATIONS', '1');

    await runCommand(['任务'], { workspace, yes: true }).catch(() => undefined);
    const taskId = printedTaskId(/task step_failed: ([0-9a-f-]{36})/);
    expect((await readTask(workspace, taskId))?.status).toBe('step_failed');
    expect((await readTask(workspace, taskId))?.steps[0]?.status).toBe('failed');

    vi.stubEnv('AGENT_STEP_MAX_ITERATIONS', '10');
    useScript([{ content: 'first fixed' }, { content: 'second done' }]);

    const resumed = await runCommand([], { workspace, resume: taskId });

    expect(resumed.stopReason).toBe('answer');
    expect(resumed.steps).toHaveLength(2);
    expect(resumed.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(printed()).toContain(
      `resuming task ${taskId} (status=step_failed, completed steps 0/2)`,
    );

    const task = await readTask(workspace, taskId);
    expect(task?.status).toBe('completed');
    expect(task?.resumeCount).toBe(1);
  });

  it('--resume 与任务文本或 --plan-only 组合非法', async () => {
    const withTask = await runCommand(['任务'], { workspace, resume: 'id' }).catch(
      (caught: unknown) => caught,
    );
    expect(withTask).toBeInstanceOf(AgentError);
    expect((withTask as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((withTask as Error).message).toContain('--resume cannot be combined with a task');

    const withPlanOnly = await runCommand([], {
      workspace,
      resume: 'id',
      planOnly: true,
    }).catch((caught: unknown) => caught);
    expect(withPlanOnly).toBeInstanceOf(AgentError);
    expect((withPlanOnly as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((withPlanOnly as Error).message).toContain('--plan-only');
  });

  it('--verify 与 --no-verify 组合非法，空命令非法', async () => {
    const both = await runCommand(['任务'], {
      workspace,
      verify: 'pnpm test',
      noVerify: true,
    }).catch((caught: unknown) => caught);
    expect(both).toBeInstanceOf(AgentError);
    expect((both as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((both as Error).message).toContain('--verify cannot be combined with --no-verify');

    const empty = await runCommand(['任务'], { workspace, verify: '  ' }).catch(
      (caught: unknown) => caught,
    );
    expect(empty).toBeInstanceOf(AgentError);
    expect((empty as AgentError).code).toBe(ErrorCode.UsageInvalid);
    expect((empty as Error).message).toContain('--verify requires a non-empty command');
  });

  it('恢复任务的 workspace 与记录不一致时抛 TaskInvalid', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'one' }]) }]);
    const planned = await runCommand(['任务'], { workspace, planOnly: true });
    const taskId = planned.taskId ?? '';

    const other = mkdtempSync(path.join(tmpdir(), 'agent-run-other-'));
    try {
      mkdirSync(path.join(other, '.agent'), { recursive: true });
      copyFileSync(
        path.join(workspace, '.agent', 'tasks.db'),
        path.join(other, '.agent', 'tasks.db'),
      );
      copyFileSync(path.join(workspace, 'script.json'), path.join(other, 'script.json'));

      const error = await runCommand([], { workspace: other, resume: taskId, yes: true }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code, (error as Error).message).toBe(ErrorCode.TaskInvalid);
      expect((error as Error).message).toContain('task workspace does not match');
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('恢复不存在的任务抛 TaskNotFound（退出码 2）', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const error = await runCommand([], { workspace, resume: missing }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.TaskNotFound);
    expect((error as AgentError).exitCode).toBe(ExitCode.UsageError);
  });
});

describe('runCommand 事件外发（RunEventSink）', () => {
  it('planned 流程按序发出结构化事件', async () => {
    useScript([
      { content: planContent([{ id: 's1', title: '读取笔记', files: ['note.txt'] }]) },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: 'done' },
    ]);
    vi.stubEnv('AGENT_VERIFY_COMMAND', '');
    vi.stubEnv('AGENT_MAX_REPAIR_ATTEMPTS', '0');

    const events: string[] = [];
    let plannedGoal = '';
    const sink: RunEventSink = {
      banner: () => events.push('banner'),
      plan: (plan: { goal: string }) => {
        plannedGoal = plan.goal;
        events.push('plan');
      },
      stepStart: () => events.push('stepStart'),
      toolCall: () => events.push('toolCall'),
      toolResult: () => events.push('toolResult'),
      stepEnd: () => events.push('stepEnd'),
      verification: () => events.push('verification'),
      diff: () => events.push('diff'),
      answer: () => events.push('answer'),
    };

    const result = await runCommand(['summarize note'], {
      workspace,
      yes: true,
      sink,
    });

    expect(result.stopReason).toBe('answer');
    expect(plannedGoal).toBe('finish the task');
    const order = (name: string): number => events.indexOf(name);
    for (const name of ['banner', 'plan', 'stepStart', 'toolCall', 'toolResult', 'stepEnd']) {
      expect(order(name), `event ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(order('banner')).toBeLessThan(order('plan'));
    expect(order('plan')).toBeLessThan(order('stepStart'));
    expect(order('stepStart')).toBeLessThan(order('toolCall'));
    expect(order('toolCall')).toBeLessThan(order('toolResult'));
    expect(order('toolResult')).toBeLessThan(order('stepEnd'));
    expect(order('answer')).toBeGreaterThanOrEqual(0);
    expect(order('verification')).toBeGreaterThanOrEqual(0);
    expect(order('diff')).toBeGreaterThanOrEqual(0);
    expect(events.filter((name) => name === 'plan')).toHaveLength(1);
  });

  it('CLI 默认不传 sink 时输出不变', async () => {
    useScript([{ content: planContent([{ id: 's1', title: 'quick' }]) }, { content: 'done' }]);
    vi.stubEnv('AGENT_VERIFY_COMMAND', '');

    const result = await runCommand(['任务'], { workspace, yes: true });
    expect(result.stopReason).toBe('answer');
    expect(printed()).toContain('plan:');
    expect(printed()).toContain('task completed:');
  });
});

describe('runCommand 外部中止信号（AbortSignal）', () => {
  it('运行中触发外部 signal：拒绝 LlmAborted 且任务持久化为 aborted', async () => {
    useScript([
      { content: planContent([{ id: 's1', title: '长命令' }]) },
      {
        toolCalls: [
          {
            name: 'run_command',
            arguments: JSON.stringify({
              command: 'node -e "setTimeout(function(){},10000)"',
              timeoutMs: 20_000,
            }),
          },
        ],
      },
      { content: 'done' },
    ]);
    vi.stubEnv('AGENT_VERIFY_COMMAND', '');

    const controller = new AbortController();
    let sawToolCall = false;
    const sink: RunEventSink = {
      toolCall: () => {
        sawToolCall = true;
        controller.abort();
      },
    };

    await expect(
      runCommand(['long running command'], {
        workspace,
        yes: true,
        noVerify: true,
        signal: controller.signal,
        sink,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LlmAborted });

    expect(sawToolCall).toBe(true);
    const taskId = printedTaskId(/task: ([0-9a-f-]{36})/i);
    const task = await readTask(workspace, taskId);
    expect(task?.status).toBe('aborted');
    expect(task?.error).toMatch(/abort/i);
  });
});
