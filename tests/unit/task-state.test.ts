import { describe, expect, it } from 'vitest';
import {
  assertStepTransition,
  assertTransition,
  canTransition,
  canTransitionStep,
} from '../../src/memory/state.js';
import {
  STEP_STATUSES,
  TASK_STATUSES,
  type StepStatus,
  type TaskStatus,
} from '../../src/memory/types.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planned: ['running', 'aborted', 'failed'],
  running: ['step_failed', 'verifying', 'completed', 'failed', 'aborted'],
  step_failed: ['running', 'failed', 'aborted'],
  verifying: ['repairing', 'completed', 'failed', 'aborted'],
  repairing: ['verifying', 'failed', 'aborted'],
  failed: ['running', 'verifying', 'aborted'],
  aborted: ['running', 'verifying', 'failed'],
  completed: [],
};

const ALLOWED_STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: ['running'],
};

const taskPairs = TASK_STATUSES.flatMap((from) =>
  TASK_STATUSES.map((to) => ({ from, to, allowed: ALLOWED_TASK_TRANSITIONS[from].includes(to) })),
);

const stepPairs = STEP_STATUSES.flatMap((from) =>
  STEP_STATUSES.map((to) => ({ from, to, allowed: ALLOWED_STEP_TRANSITIONS[from].includes(to) })),
);

describe('任务状态机', () => {
  it.each(taskPairs)('$from -> $to 允许=$allowed', ({ from, to, allowed }) => {
    expect(canTransition(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertTransition(from, to)).not.toThrow();
      return;
    }
    expect(() => assertTransition(from, to)).toThrow(AgentError);
    try {
      assertTransition(from, to);
    } catch (error) {
      expect((error as AgentError).code).toBe(ErrorCode.TaskStorage);
      expect((error as AgentError).message).toContain(`${from} -> ${to}`);
    }
  });

  it('completed 是绝对终态', () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition('completed', to)).toBe(false);
    }
  });

  it('failed/aborted 只能通过 resume 回到 running/verifying', () => {
    expect(canTransition('failed', 'running')).toBe(true);
    expect(canTransition('failed', 'verifying')).toBe(true);
    expect(canTransition('aborted', 'running')).toBe(true);
    expect(canTransition('aborted', 'verifying')).toBe(true);
    expect(canTransition('failed', 'completed')).toBe(false);
    expect(canTransition('aborted', 'completed')).toBe(false);
  });
});

describe('步骤状态机', () => {
  it.each(stepPairs)('$from -> $to 允许=$allowed', ({ from, to, allowed }) => {
    expect(canTransitionStep(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertStepTransition(from, to)).not.toThrow();
      return;
    }
    expect(() => assertStepTransition(from, to)).toThrow(AgentError);
    try {
      assertStepTransition(from, to);
    } catch (error) {
      expect((error as AgentError).code).toBe(ErrorCode.TaskStorage);
      expect((error as AgentError).message).toContain(`${from} -> ${to}`);
    }
  });

  it('completed 步骤不再重跑，failed 步骤可重置为 running', () => {
    expect(canTransitionStep('completed', 'running')).toBe(false);
    expect(canTransitionStep('completed', 'failed')).toBe(false);
    expect(canTransitionStep('failed', 'running')).toBe(true);
    expect(canTransitionStep('pending', 'completed')).toBe(false);
  });
});
