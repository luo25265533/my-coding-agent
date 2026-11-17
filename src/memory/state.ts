import { AgentError, ErrorCode } from '../shared/errors.js';
import type { StepStatus, TaskStatus } from './types.js';

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planned: ['running', 'aborted', 'failed'],
  running: ['step_failed', 'verifying', 'completed', 'failed', 'aborted'],
  step_failed: ['running', 'failed', 'aborted'],
  verifying: ['repairing', 'completed', 'failed', 'aborted'],
  repairing: ['verifying', 'failed', 'aborted'],
  failed: ['running', 'verifying', 'aborted'],
  aborted: ['running', 'verifying', 'failed'],
  completed: [],
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: ['running'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new AgentError(ErrorCode.TaskStorage, `invalid task status transition: ${from} -> ${to}`);
  }
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new AgentError(ErrorCode.TaskStorage, `invalid step status transition: ${from} -> ${to}`);
  }
}
