import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import type { Evaluator, VerifyRequest } from '../../src/evaluator/types.js';
import type { ContextManager, ContextStats } from '../../src/context/manager.js';
import type { MockStep } from '../../src/config/schema.js';
import {
  createTaskStore,
  type TaskRecord,
  type TaskStepRecord,
  type TaskStore,
} from '../../src/memory/index.js';
import type { TaskPlan } from '../../src/planner/types.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import type { AgentStopReason } from '../../src/shared/agent-stop.js';
import type {
  DiffSummary,
  VerificationResult,
  VerificationStatus,
} from '../../src/shared/reports.js';
import type { TokenUsage } from '../../src/shared/token-usage.js';
import { ToolRegistry } from '../../src/tools/index.js';
import { runTask, type RunTaskOptions } from '../../src/agent/task-runner.js';

let workspace: string;
let store: TaskStore;

beforeEach(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-task-runner-'));
  store = await createTaskStore({
    workspace,
    dbPath: path.join('.agent', 'tasks.db'),
  });
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const usage: TokenUsage = {
  promptTokens: 7,
  completionTokens: 3,
  totalTokens: 10,
  reasoningTokens: 0,
  cachedTokens: 0,
};

const changedDiff: DiffSummary = {
  available: true,
  reason: undefined,
  files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
  totalInsertions: 2,
  totalDeletions: 1,
  truncated: false,
};

function planOf(titles: readonly string[]): TaskPlan {
  return {
    goal: 'fix tests',
    steps: titles.map((title, index) => ({
      id: `s${index + 1}`,
      title,
      description: `do ${title}`,
      files: [],
    })),
    notes: undefined,
  };
}

async function createTask(
  titles: readonly string[],
  overrides: { verifyCommand?: string; verifyAutoSkip?: boolean } = {},
): Promise<TaskRecord> {
  return store.createTask({
    goal: 'fix tests',
    plan: planOf(titles),
    workspace,
    verifyCommand: overrides.verifyCommand ?? 'pnpm test',
    verifyAutoSkip: overrides.verifyAutoSkip ?? false,
    baselineDiff: undefined,
  });
}

function stepRecord(
  task: TaskRecord,
  index: number,
  status: 'completed' | 'failed',
  answer: string,
  stopReason: AgentStopReason,
): TaskStepRecord {
  const step = task.plan.steps[index];
  if (step === undefined) {
    throw new Error(`missing step ${index}`);
  }
  return {
    index,
    step,
    status,
    answer,
    iterations: 2,
    toolCalls: 1,
    usage,
    stopReason,
    startedAt: 1,
    finishedAt: 2,
  };
}

function fakeContext(): ContextManager {
  const stats: ContextStats = {
    budgetTokens: 4000,
    repoMapTokens: 0,
    repoMapFiles: 0,
    repoMapTruncated: false,
    repoMapDropped: false,
    initialTokens: 0,
    droppedMessages: 0,
    truncatedToolMessages: 0,
    lastRequestTokens: 0,
  };
  return {
    budgetTokens: 4000,
    buildMessages: (task) =>
      Promise.resolve<readonly { role: 'system' | 'user'; content: string }[]>([
        { role: 'system', content: 'system' },
        { role: 'user', content: task },
      ]),
    fit: (messages) => messages,
    stats: () => stats,
  };
}

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'echo input',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: (params) => Promise.resolve({ ok: true, content: params.text }),
  });
}

const emptyDiff: DiffSummary = {
  available: true,
  reason: undefined,
  files: [],
  totalInsertions: 0,
  totalDeletions: 0,
  truncated: false,
};

function staticDiffOf(...paths: readonly string[]): DiffSummary {
  return {
    ...emptyDiff,
    files: paths.map((filePath) => ({
      path: filePath,
      status: 'modified',
      insertions: 3,
      deletions: 1,
    })),
    totalInsertions: paths.length * 3,
    totalDeletions: paths.length,
  };
}

function evaluatorWith(
  statuses: readonly VerificationStatus[],
  diffs: readonly DiffSummary[] = [changedDiff],
): {
  evaluator: Evaluator;
  verify: ReturnType<typeof vi.fn>;
  diff: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const verify = vi.fn((request: VerifyRequest): Promise<VerificationResult> => {
    const status = statuses[index] ?? 'passed';
    index += 1;
    return Promise.resolve({
      status,
      command: request.command,
      attempt: request.attempt,
      exitCode: status === 'failed' ? 1 : 0,
      timedOut: false,
      durationMs: 5,
      output: status === 'failed' ? 'failure output' : '',
      reason: status === 'failed' ? 'exit code 1' : undefined,
    });
  });
  let diffIndex = 0;
  const diff = vi.fn((): Promise<DiffSummary> => {
    const value = diffs[Math.min(diffIndex, diffs.length - 1)] ?? emptyDiff;
    diffIndex += 1;
    return Promise.resolve(value);
  });
  return { evaluator: { verify, diff }, verify, diff };
}

function optionsFor(
  task: TaskRecord,
  evaluator: Evaluator,
  script: readonly MockStep[] | undefined,
  overrides: Partial<RunTaskOptions> = {},
): RunTaskOptions {
  return {
    task,
    store,
    evaluator,
    provider: createMockProvider({ script }),
    tools: echoRegistry(),
    workspace,
    ignore: createIgnoreMatcher({ workspace, respectGitignore: false }),
    contextBudgetTokens: 4000,
    maxIterationsPerStep: 5,
    maxRepeatedCalls: 3,
    maxConsecutiveFailures: 3,
    signal: new AbortController().signal,
    context: fakeContext(),
    verifyCommand: 'pnpm test',
    verifyAutoSkip: false,
    verifySkipStatic: false,
    verifyTimeoutMs: 5000,
    maxRepairAttempts: 2,
    repairMaxIterations: 2,
    ...overrides,
  };
}

async function currentTask(task: TaskRecord): Promise<TaskRecord> {
  const current = await store.getTask(task.id);
  if (current === undefined) {
    throw new Error('task disappeared');
  }
  return current;
}

describe('runTask 验证流程', () => {
  it('步骤完成且验证通过后进入 completed 并落库', async () => {
    const task = await createTask(['one', 'two']);
    const { evaluator, verify } = evaluatorWith(['passed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'one done' }, { content: 'two done' }]),
    );

    expect(result.task.status).toBe('completed');
    expect(result.verification).toMatchObject({ status: 'passed', attempt: 1 });
    expect(result.repairs).toBe(0);
    expect(verify).toHaveBeenCalledOnce();
    const stored = await currentTask(task);
    expect(stored.status).toBe('completed');
    expect(stored.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(stored.verifications).toHaveLength(1);
    expect(stored.diffs).toHaveLength(1);
    expect(stored.error).toBeUndefined();
  });

  it('无验证命令时记录 skipped 并完成', async () => {
    const task = await createTask(['one']);
    const { evaluator, verify } = evaluatorWith(['passed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'done' }], { verifyCommand: undefined }),
    );

    expect(result.task.status).toBe('completed');
    expect(result.verification?.status).toBe('skipped');
    expect(result.verification?.reason).toBe('verification disabled');
    expect(verify).not.toHaveBeenCalled();
    expect((await currentTask(task)).verifications).toHaveLength(1);
  });

  it('默认验证命令缺少 package.json 时自动跳过', async () => {
    const task = await createTask(['one']);
    const { evaluator, verify } = evaluatorWith(['passed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'done' }], { verifyAutoSkip: true }),
    );

    expect(result.task.status).toBe('completed');
    expect(result.verification?.status).toBe('skipped');
    expect(result.verification?.reason).toBe('no package.json');
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('runTask 静态改动跳过验证', () => {
  function writePackageJson(): void {
    writeFileSync(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  }

  async function runWithDiffs(
    diffs: readonly DiffSummary[],
    overrides: Partial<RunTaskOptions> = {},
  ) {
    writePackageJson();
    const task = await createTask(['one']);
    const { evaluator, verify } = evaluatorWith(['passed'], diffs);
    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'done' }], {
        verifyAutoSkip: true,
        verifySkipStatic: true,
        ...overrides,
      }),
    );
    return { task, result, verify };
  }

  it('零改动时跳过默认验证并记录原因', async () => {
    const { task, result, verify } = await runWithDiffs([emptyDiff, emptyDiff]);

    expect(result.task.status).toBe('completed');
    expect(result.verification).toMatchObject({
      status: 'skipped',
      reason: 'no detectable file changes',
    });
    expect(verify).not.toHaveBeenCalled();
    expect((await currentTask(task)).verifications[0]?.reason).toBe('no detectable file changes');
  });

  it('仅静态资源改动时跳过默认验证并记录文件数', async () => {
    const staticDiff = staticDiffOf('index.html', 'style.css');
    const { result, verify } = await runWithDiffs([emptyDiff, staticDiff]);

    expect(result.task.status).toBe('completed');
    expect(result.verification).toMatchObject({
      status: 'skipped',
      reason: 'static-only changes (2 files)',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(result.diff?.files).toHaveLength(2);
  });

  it('混入代码文件时仍执行验证', async () => {
    const mixed = staticDiffOf('index.html', 'src/a.ts');
    const { result, verify } = await runWithDiffs([emptyDiff, mixed]);

    expect(result.verification?.status).toBe('passed');
    expect(verify).toHaveBeenCalledOnce();
  });

  it('AGENT_VERIFY_SKIP_STATIC=false 时静态改动仍验证', async () => {
    const staticDiff = staticDiffOf('style.css');
    const { result, verify } = await runWithDiffs([emptyDiff, staticDiff], {
      verifySkipStatic: false,
    });

    expect(result.verification?.status).toBe('passed');
    expect(verify).toHaveBeenCalledOnce();
  });

  it('显式指定的验证命令不参与静态跳过', async () => {
    const staticDiff = staticDiffOf('style.css');
    const { result, verify } = await runWithDiffs([emptyDiff, staticDiff], {
      verifyAutoSkip: false,
    });

    expect(result.verification?.status).toBe('passed');
    expect(verify).toHaveBeenCalledOnce();
  });
});

describe('runTask 修复循环', () => {
  it('验证失败后修复成功并再次验证通过', async () => {
    const task = await createTask(['one']);
    const { evaluator, verify } = evaluatorWith(['failed', 'passed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'step done' }, { content: 'repair done' }], {
        maxRepairAttempts: 1,
        onRepair: (outcome) => {
          expect(outcome.attempt).toBe(1);
          expect(outcome.answer).toBe('repair done');
        },
      }),
    );

    expect(result.task.status).toBe('completed');
    expect(result.repairs).toBe(1);
    expect(result.verification?.status).toBe('passed');
    expect(verify).toHaveBeenCalledTimes(2);
    const stored = await currentTask(task);
    expect(stored.repairAttempts).toBe(1);
    expect(stored.verifications.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it('修复耗尽后任务失败并包含命令、退出码与轮数', async () => {
    const task = await createTask(['one']);
    const { evaluator } = evaluatorWith(['failed', 'failed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ content: 'step done' }, { content: 'repair done' }], {
        maxRepairAttempts: 1,
      }),
    );

    expect(result.task.status).toBe('failed');
    expect(result.repairs).toBe(1);
    const stored = await currentTask(task);
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('verification failed after 1 repair attempt(s)');
    expect(stored.error).toContain('pnpm test');
    expect(stored.error).toContain('exit code 1');
    expect(stored.repairAttempts).toBe(1);
  });

  it('修复循环未给出答案时立即终止修复', async () => {
    const task = await createTask(['one']);
    const { evaluator, verify } = evaluatorWith(['failed']);

    const result = await runTask(
      optionsFor(
        task,
        evaluator,
        [{ content: 'step done' }, { toolCalls: [{ name: 'echo', arguments: '{"text":"x"}' }] }],
        { maxRepairAttempts: 2, repairMaxIterations: 1 },
      ),
    );

    expect(result.task.status).toBe('failed');
    expect(result.repairs).toBe(1);
    expect(verify).toHaveBeenCalledOnce();
    const stored = await currentTask(task);
    expect(stored.error).toBe('repair stopped: max_iterations');
    expect(stored.repairAttempts).toBe(1);
  });
});

describe('runTask 失败与中止', () => {
  it('步骤失败进入 step_failed 且不执行验证', async () => {
    const task = await createTask(['one', 'two']);
    const { evaluator, verify } = evaluatorWith(['passed']);

    const result = await runTask(
      optionsFor(task, evaluator, [{ toolCalls: [{ name: 'echo', arguments: '{"text":"x"}' }] }], {
        maxIterationsPerStep: 1,
      }),
    );

    expect(result.task.status).toBe('step_failed');
    expect(result.verification).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    const stored = await currentTask(task);
    expect(stored.status).toBe('step_failed');
    expect(stored.error).toContain('step s1 failed: max_iterations');
    expect(stored.steps.map((step) => step.status)).toEqual(['failed', 'pending']);
  });

  it('中止后状态为 aborted 并抛出 LlmAborted', async () => {
    const task = await createTask(['one']);
    const { evaluator } = evaluatorWith(['passed']);
    const controller = new AbortController();
    controller.abort();

    const error = await runTask(
      optionsFor(task, evaluator, [{ content: 'done' }], { signal: controller.signal }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.LlmAborted);
    expect((await currentTask(task)).status).toBe('aborted');
  });

  it('意外异常标记 failed 并原样抛出', async () => {
    const task = await createTask(['one']);
    const evaluator: Evaluator = {
      verify: () => Promise.reject(new Error('verify exploded')),
      diff: () => Promise.resolve(changedDiff),
    };

    await expect(runTask(optionsFor(task, evaluator, [{ content: 'done' }]))).rejects.toThrow(
      'verify exploded',
    );
    const stored = await currentTask(task);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('verify exploded');
  });

  it('workspace 不一致时拒绝且不执行', async () => {
    const task = await createTask(['one']);
    const { evaluator } = evaluatorWith(['passed']);
    const options = {
      ...optionsFor(task, evaluator, [{ content: 'done' }]),
      workspace: path.join(workspace, 'other'),
    };

    await expect(runTask(options)).rejects.toMatchObject({ code: ErrorCode.TaskInvalid });
    const stored = await currentTask(task);
    expect(stored.status).toBe('planned');
    expect(stored.steps.every((step) => step.status === 'pending')).toBe(true);
  });
});

describe('runTask 恢复', () => {
  it('从 running 状态恢复时跳过已完成步骤并保留汇总', async () => {
    const task = await createTask(['one', 'two']);
    await store.transition(task.id, 'running');
    await store.startStep(task.id, 0);
    await store.finishStep(task.id, stepRecord(task, 0, 'completed', 'old done', 'answer'));
    const resumed = await currentTask(task);
    const { evaluator } = evaluatorWith(['passed']);

    const result = await runTask(optionsFor(resumed, evaluator, [{ content: 'second done' }]));

    expect(result.task.status).toBe('completed');
    expect(result.steps.map((step) => step.answer)).toEqual(['old done', 'second done']);
    expect(result.planResult.usage.totalTokens).toBe(
      10 + (result.steps[1]?.usage.totalTokens ?? 0),
    );
    const stored = await currentTask(task);
    expect(stored.resumeCount).toBe(1);
    expect(stored.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
  });

  it('从 step_failed 恢复时重跑失败步骤', async () => {
    const task = await createTask(['one', 'two']);
    await store.transition(task.id, 'running');
    await store.startStep(task.id, 0);
    await store.finishStep(task.id, stepRecord(task, 0, 'completed', 'old done', 'answer'));
    await store.startStep(task.id, 1);
    await store.finishStep(task.id, stepRecord(task, 1, 'failed', '', 'max_iterations'));
    await store.transition(task.id, 'step_failed');
    const resumed = await currentTask(task);
    const { evaluator } = evaluatorWith(['passed']);

    const result = await runTask(optionsFor(resumed, evaluator, [{ content: 'second done' }]));

    expect(result.task.status).toBe('completed');
    expect(result.steps[0]?.answer).toBe('old done');
    expect(result.steps[1]?.answer).toBe('second done');
    const stored = await currentTask(task);
    expect(stored.resumeCount).toBe(1);
    expect(stored.steps[1]?.status).toBe('completed');
  });

  it('已完成任务直接返回，不调用模型与验证', async () => {
    const task = await createTask(['one']);
    await store.transition(task.id, 'running');
    await store.startStep(task.id, 0);
    await store.finishStep(task.id, stepRecord(task, 0, 'completed', 'done', 'answer'));
    await store.transition(task.id, 'verifying');
    await store.transition(task.id, 'completed');
    const completed = await currentTask(task);
    const { evaluator, verify } = evaluatorWith(['failed']);

    const result = await runTask(optionsFor(completed, evaluator, undefined));

    expect(result.task.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.answer).toBe('done');
    expect(result.verification).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
});
