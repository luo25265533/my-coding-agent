import type { RepairOutcome } from '../agent/repair.js';
import type { StepResult } from '../agent/plan-runner.js';
import type { ContextStats } from '../context/manager.js';
import type { PlanStep, TaskPlan } from '../planner/types.js';
import type { DiffSummary, VerificationResult } from '../shared/reports.js';
import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';

/**
 * runCommand 的事件外发契约：CLI 不传 sink 时行为不变；
 * web 等宿主注入 sink 后在 stdout 之外获得结构化事件流。
 * 方法全部可选，宿主按需订阅。
 */
export interface RunEventSink {
  /** printBanner 组装的横幅行（含 runId/workspace/provider/context/task/verify/taskId） */
  banner?(lines: readonly string[]): void;
  /** 结构化 Plan（确认卡片渲染用），plan-only 与正式执行都会发出 */
  plan?(plan: TaskPlan): void;
  /** 新建任务落库后的任务 ID（含 plan-only） */
  taskCreated?(taskId: string): void;
  toolCall?(call: ToolCall, iteration: number): void;
  toolResult?(result: ToolResult, iteration: number, durationMs: number): void;
  stepStart?(step: PlanStep, index: number, total: number): void;
  stepEnd?(result: StepResult, index: number, total: number): void;
  verification?(result: VerificationResult): void;
  diff?(diff: DiffSummary): void;
  repair?(outcome: RepairOutcome, maxAttempts: number): void;
  taskState?(state: 'step_failed' | 'failed', taskId: string): void;
  contextTrim?(stats: ContextStats): void;
  answer?(content: string): void;
  tokens?(info: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly iterations: number;
    readonly toolCalls: number;
  }): void;
}
