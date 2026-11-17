import type { Logger } from 'pino';
import type { AgentStopReason } from '../shared/agent-stop.js';
import type { PlanStep, TaskPlan } from '../shared/plan.js';
import type { DiffSummary, RepairRecord, VerificationResult } from '../shared/reports.js';
import type { TokenUsage } from '../shared/token-usage.js';

export const TASK_STATUSES = [
  'planned',
  'running',
  'step_failed',
  'verifying',
  'repairing',
  'completed',
  'failed',
  'aborted',
] as const;

/** planned：Plan 已生成；completed/failed/aborted 中只有 completed 是绝对终态 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export interface TaskStepRecord {
  readonly index: number;
  readonly step: PlanStep;
  readonly status: StepStatus;
  readonly answer: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: AgentStopReason | undefined;
  readonly startedAt: number | undefined;
  readonly finishedAt: number | undefined;
}

export interface TaskRecord {
  readonly id: string;
  readonly goal: string;
  readonly workspace: string;
  readonly status: TaskStatus;
  readonly plan: TaskPlan;
  readonly verifyCommand: string | undefined;
  readonly verifyAutoSkip: boolean;
  readonly baselineDiff: DiffSummary | undefined;
  readonly repairAttempts: number;
  readonly resumeCount: number;
  readonly error: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: readonly TaskStepRecord[];
  readonly verifications: readonly VerificationResult[];
  readonly diffs: readonly DiffSummary[];
}

export interface TaskSummary {
  readonly id: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly stepCount: number;
  readonly completedSteps: number;
  readonly repairAttempts: number;
  readonly updatedAt: number;
  readonly error: string | undefined;
}

export interface CreateTaskInput {
  readonly goal: string;
  readonly plan: TaskPlan;
  readonly workspace: string;
  readonly verifyCommand: string | undefined;
  readonly verifyAutoSkip: boolean;
  readonly baselineDiff: DiffSummary | undefined;
}

export interface TransitionPatch {
  /** null 清除错误；undefined 保持原值 */
  readonly error?: string | null | undefined;
}

export interface TaskStore {
  readonly path: string;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  listTasks(limit?: number): Promise<readonly TaskSummary[]>;
  transition(id: string, to: TaskStatus, patch?: TransitionPatch): Promise<void>;
  /** 恢复执行计数 +1；不改变任务状态 */
  markResumed(id: string): Promise<void>;
  startStep(id: string, index: number): Promise<void>;
  finishStep(id: string, result: TaskStepRecord): Promise<void>;
  setBaselineDiff(id: string, diff: DiffSummary): Promise<void>;
  recordVerification(id: string, result: VerificationResult): Promise<void>;
  recordDiff(id: string, diff: DiffSummary): Promise<void>;
  recordRepair(id: string, attempt: number, payload: RepairRecord): Promise<void>;
  appendEvent(id: string, type: string, payload?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface TaskStoreOptions {
  readonly dbPath: string;
  readonly workspace: string;
  readonly readOnly?: boolean | undefined;
  readonly logger?: Logger | undefined;
}
