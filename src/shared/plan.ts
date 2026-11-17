export interface PlanStep {
  /** 计划内唯一，1-32 字符 */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** 相对 workspace 的路径；无法确定时为空数组 */
  readonly files: readonly string[];
}

export interface TaskPlan {
  readonly goal: string;
  readonly steps: readonly PlanStep[];
  readonly notes: string | undefined;
}
