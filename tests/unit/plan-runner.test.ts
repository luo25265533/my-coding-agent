import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildPlanSystemPrompt, runPlan, type StepResult } from '../../src/agent/plan-runner.js';
import type { MockStep } from '../../src/config/schema.js';
import type { ContextManager, ContextStats } from '../../src/context/manager.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import type { ChatMessage } from '../../src/llm/types.js';
import type { PlanStep, TaskPlan } from '../../src/planner/types.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import { ToolRegistry } from '../../src/tools/index.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-plan-runner-'));
const ignore = createIgnoreMatcher({ workspace: root, respectGitignore: false });
const signal = new AbortController().signal;

beforeAll(() => {
  writeFileSync(path.join(root, 'app.ts'), 'export const x = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'echo input',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: (params) => Promise.resolve({ ok: true, content: params.text }),
  });
}

function planOf(titles: readonly string[], notes?: string): TaskPlan {
  return {
    goal: 'make the change',
    steps: titles.map((title, index) => ({
      id: `s${index + 1}`,
      title,
      description: `do ${title}`,
      files: [],
    })),
    notes,
  };
}

function stepAt(plan: TaskPlan, index: number): PlanStep {
  const step = plan.steps[index];
  if (step === undefined) {
    throw new Error(`missing plan step ${index}`);
  }
  return step;
}

function completedStep(step: PlanStep, totalTokens = 10): StepResult {
  return {
    step,
    status: 'completed',
    answer: `${step.id} done`,
    iterations: 2,
    toolCalls: 1,
    usage: {
      promptTokens: totalTokens,
      completionTokens: 0,
      totalTokens,
      reasoningTokens: 0,
      cachedTokens: 0,
    },
    stopReason: 'answer',
  };
}

function baseOptions(script: readonly MockStep[] | undefined): {
  provider: ReturnType<typeof createMockProvider>;
  tools: ToolRegistry;
  workspace: string;
  ignore: typeof ignore;
  contextBudgetTokens: number;
  maxIterationsPerStep: number;
  maxRepeatedCalls: number;
  maxConsecutiveFailures: number;
  signal: AbortSignal;
} {
  return {
    provider: createMockProvider({ script }),
    tools: echoRegistry(),
    workspace: root,
    ignore,
    contextBudgetTokens: 4000,
    maxIterationsPerStep: 5,
    maxRepeatedCalls: 3,
    maxConsecutiveFailures: 3,
    signal,
  };
}

describe('buildPlanSystemPrompt', () => {
  it('包含目标、编号步骤与备注', () => {
    const prompt = buildPlanSystemPrompt(planOf(['edit a', 'test b'], 'keep it small'));

    expect(prompt).toContain('Goal: make the change');
    expect(prompt).toContain('1. [s1] edit a: do edit a');
    expect(prompt).toContain('2. [s2] test b: do test b');
    expect(prompt).toContain('Notes: keep it small');
  });

  it('无备注时不追加 Notes 行', () => {
    expect(buildPlanSystemPrompt(planOf(['only']))).not.toContain('Notes:');
  });
});

describe('runPlan', () => {
  it('按顺序执行全部步骤并汇总结果', async () => {
    const events: string[] = [];
    const result = await runPlan(planOf(['first', 'second']), {
      ...baseOptions([{ content: 'step one done' }, { content: 'step two done' }]),
      onStepStart: (step, index, total) => {
        events.push(`start:${step.id}:${index + 1}/${total}`);
      },
      onStepEnd: (stepResult) => {
        events.push(`end:${stepResult.step.id}:${stepResult.status}`);
      },
    });

    expect(result.completed).toBe(true);
    expect(result.steps.map((step) => step.answer)).toEqual(['step one done', 'step two done']);
    expect(result.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(events).toEqual([
      'start:s1:1/2',
      'end:s1:completed',
      'start:s2:2/2',
      'end:s2:completed',
    ]);
  });

  it('第一步失败后停止，后续步骤不再执行', async () => {
    const provider = createMockProvider({
      script: [
        { content: 'first ok' },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"x"}' }] },
      ],
    });
    const events: string[] = [];

    const result = await runPlan(planOf(['a', 'b', 'c']), {
      ...baseOptions(undefined),
      provider,
      maxIterationsPerStep: 1,
      onStepStart: (step) => {
        events.push(step.id);
      },
    });

    expect(result.completed).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({ status: 'failed', stopReason: 'max_iterations' });
    expect(events).toEqual(['s1', 's2']);
  });

  it('迭代次数与 usage 按步骤累加', async () => {
    const result = await runPlan(planOf(['one', 'two']), {
      ...baseOptions([
        { toolCalls: [{ name: 'echo', arguments: '{"text":"a"}' }] },
        { content: 'one done' },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"b"}' }] },
        { content: 'two done' },
      ]),
    });

    expect(result.steps.map((step) => step.iterations)).toEqual([2, 2]);
    expect(result.steps.map((step) => step.toolCalls)).toEqual([1, 1]);
    const total = result.steps.reduce((sum, step) => sum + step.usage.totalTokens, 0);
    expect(result.usage.totalTokens).toBe(total);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('复用传入的 ContextManager，不重复创建工作区上下文', async () => {
    const buildMessages = vi.fn((task: string) =>
      Promise.resolve<readonly ChatMessage[]>([
        { role: 'system', content: 'system' },
        { role: 'user', content: task },
      ]),
    );
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
    const context: ContextManager = {
      budgetTokens: 4000,
      buildMessages,
      fit: (messages) => messages,
      stats: () => stats,
    };

    const result = await runPlan(planOf(['first', 'second']), {
      ...baseOptions([{ content: 'one' }, { content: 'two' }]),
      context,
    });

    expect(result.completed).toBe(true);
    expect(buildMessages).toHaveBeenCalledTimes(2);
    expect(buildMessages.mock.calls[0]?.[0]).toContain('Plan step 1/2: first');
    expect(buildMessages.mock.calls[1]?.[0]).toContain('Plan step 2/2: second');
  });

  it('每步迭代上限独立生效', async () => {
    const result = await runPlan(planOf(['loop']), {
      ...baseOptions([
        { toolCalls: [{ name: 'echo', arguments: '{"text":"again"}' }] },
        { toolCalls: [{ name: 'echo', arguments: '{"text":"again2"}' }] },
        { content: 'never reached' },
      ]),
      maxIterationsPerStep: 2,
    });

    expect(result.completed).toBe(false);
    expect(result.steps[0]?.iterations).toBe(2);
    expect(result.steps[0]?.stopReason).toBe('max_iterations');
  });

  it('空步骤列表视为已完成', async () => {
    const result = await runPlan(planOf([]), baseOptions([]));

    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(0);
  });
});

describe('runPlan 恢复', () => {
  it('跳过已完成步骤，只执行剩余步骤并保留汇总', async () => {
    const plan = planOf(['first', 'second', 'third']);
    const completed = [completedStep(stepAt(plan, 0))];
    const starts: string[] = [];
    const ends: string[] = [];

    const result = await runPlan(plan, {
      ...baseOptions([{ content: 'two' }, { content: 'three' }]),
      completedSteps: completed,
      onStepStart: (_step, index, total) => {
        starts.push(`${index + 1}/${total}`);
      },
      onStepEnd: (stepResult) => {
        ends.push(stepResult.step.id);
      },
    });

    expect(result.completed).toBe(true);
    expect(result.steps.map((step) => step.answer)).toEqual(['s1 done', 'two', 'three']);
    expect(result.steps[0]).toEqual(completed[0]);
    expect(starts).toEqual(['2/3', '3/3']);
    expect(ends).toEqual(['s2', 's3']);
    expect(result.usage.totalTokens).toBe(
      result.steps.reduce((sum, step) => sum + step.usage.totalTokens, 0),
    );
    expect(result.usage.totalTokens).toBeGreaterThan(10);
  });

  it('全部步骤已完成时不创建上下文、不调用模型', async () => {
    const plan = planOf(['only']);
    const buildMessages = vi.fn(() =>
      Promise.resolve<readonly ChatMessage[]>([{ role: 'user', content: 'unused' }]),
    );
    const context: ContextManager = {
      budgetTokens: 4000,
      buildMessages,
      fit: (messages) => messages,
      stats: () => ({
        budgetTokens: 4000,
        repoMapTokens: 0,
        repoMapFiles: 0,
        repoMapTruncated: false,
        repoMapDropped: false,
        initialTokens: 0,
        droppedMessages: 0,
        truncatedToolMessages: 0,
        lastRequestTokens: 0,
      }),
    };

    const result = await runPlan(plan, {
      ...baseOptions(undefined),
      completedSteps: [completedStep(stepAt(plan, 0))],
      context,
    });

    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(buildMessages).not.toHaveBeenCalled();
  });

  it('已完成步骤数量超过计划时拒绝', async () => {
    const plan = planOf(['only']);
    const duplicated = [completedStep(stepAt(plan, 0)), completedStep(stepAt(plan, 0))];

    await expect(
      runPlan(plan, { ...baseOptions(undefined), completedSteps: duplicated }),
    ).rejects.toMatchObject({ code: ErrorCode.TaskInvalid });
  });

  it('已完成前缀包含失败步骤时拒绝', async () => {
    const plan = planOf(['only']);
    const failed: StepResult = { ...completedStep(stepAt(plan, 0)), status: 'failed' };

    await expect(
      runPlan(plan, { ...baseOptions(undefined), completedSteps: [failed] }),
    ).rejects.toBeInstanceOf(AgentError);
    await expect(
      runPlan(plan, { ...baseOptions(undefined), completedSteps: [failed] }),
    ).rejects.toMatchObject({ code: ErrorCode.TaskInvalid });
  });

  it('已完成步骤与计划不一致时拒绝', async () => {
    const plan = planOf(['only']);
    const drifted = completedStep({ ...stepAt(plan, 0), id: 'other' });

    await expect(
      runPlan(plan, { ...baseOptions(undefined), completedSteps: [drifted] }),
    ).rejects.toMatchObject({ code: ErrorCode.TaskInvalid });
  });

  it('等待异步步骤回调完成后再继续', async () => {
    const events: string[] = [];
    const result = await runPlan(planOf(['only']), {
      ...baseOptions([{ content: 'done' }]),
      onStepStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push('start');
      },
      onStepEnd: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push('end');
      },
    });

    expect(result.completed).toBe(true);
    expect(events).toEqual(['start', 'end']);
  });
});
