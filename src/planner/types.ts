import type { TokenUsage } from '../llm/types.js';
import type { PlanStep, TaskPlan } from '../shared/plan.js';

export type { PlanStep, TaskPlan };

export interface PlanResult {
  readonly plan: TaskPlan;
  readonly usage: TokenUsage;
  /** 模型实际被调用的次数：1 表示一次通过，2 表示经过一次修复 */
  readonly attempts: number;
  readonly repoMapTokens: number;
}

export interface Planner {
  plan(task: string): Promise<PlanResult>;
}
