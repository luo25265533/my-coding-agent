import type { Logger } from 'pino';
import { createContextManager, type ContextManager } from '../context/manager.js';
import type { LLMProvider, TokenUsage, ToolCall } from '../llm/types.js';
import { addUsage, EMPTY_USAGE } from '../llm/types.js';
import type { PlanStep, TaskPlan } from '../planner/types.js';
import type { ConfirmFn } from '../security/approval.js';
import type { IgnoreMatcher } from '../security/ignore.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import { AGENT_SYSTEM_PROMPT, runAgentLoop, type AgentStopReason } from './loop.js';

export interface StepResult {
  readonly step: PlanStep;
  readonly status: 'completed' | 'failed';
  readonly answer: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: AgentStopReason;
}

export interface PlanRunResult {
  readonly steps: readonly StepResult[];
  readonly usage: TokenUsage;
  readonly completed: boolean;
}

export interface RunPlanOptions {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly workspace: string;
  readonly ignore: IgnoreMatcher;
  readonly contextBudgetTokens: number;
  readonly maxIterationsPerStep: number;
  readonly maxRepeatedCalls: number;
  readonly maxConsecutiveFailures: number;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  readonly confirm?: ConfirmFn | undefined;
  readonly commandTimeoutMs?: number | undefined;
  /** CLI 可复用已构建的上下文，以便在规划后立即展示统计 */
  readonly context?: ContextManager | undefined;
  /** 恢复执行：必须与 plan.steps 的前缀逐项匹配，已完成步骤不再调用模型 */
  readonly completedSteps?: readonly StepResult[] | undefined;
  readonly onStepStart?:
    ((step: PlanStep, index: number, total: number) => void | Promise<void>) | undefined;
  readonly onStepEnd?:
    ((result: StepResult, index: number, total: number) => void | Promise<void>) | undefined;
  readonly onToolCall?: ((call: ToolCall, iteration: number) => void) | undefined;
  readonly onToolResult?:
    | ((call: ToolCall, result: ToolResult, iteration: number, durationMs: number) => void)
    | undefined;
}

export function buildPlanSystemPrompt(plan: TaskPlan): string {
  const steps = plan.steps.map(
    (step, index) => `${index + 1}. [${step.id}] ${step.title}: ${step.description}`,
  );
  const parts = [
    AGENT_SYSTEM_PROMPT,
    'Task plan (execute the steps in order and stay inside the current step):',
    `Goal: ${plan.goal}`,
    ...steps,
  ];
  if (plan.notes !== undefined) {
    parts.push(`Notes: ${plan.notes}`);
  }
  return parts.join('\n');
}

export async function runPlan(plan: TaskPlan, options: RunPlanOptions): Promise<PlanRunResult> {
  const completedSteps = options.completedSteps ?? [];
  assertCompletedPrefix(plan, completedSteps);

  const total = plan.steps.length;
  const steps: StepResult[] = [...completedSteps];
  let usage: TokenUsage = completedSteps.reduce(
    (sum, stepResult) => addUsage(sum, stepResult.usage),
    EMPTY_USAGE,
  );
  let completed = true;

  if (steps.length === total) {
    return { steps, usage, completed };
  }

  const context =
    options.context ??
    createContextManager({
      workspace: options.workspace,
      budgetTokens: options.contextBudgetTokens,
      ignore: options.ignore,
      systemPrompt: buildPlanSystemPrompt(plan),
      signal: options.signal,
      logger: options.logger,
    });

  for (let index = steps.length; index < total; index += 1) {
    const step = plan.steps[index];
    if (step === undefined) {
      break;
    }
    await options.onStepStart?.(step, index, total);
    options.logger?.info({ step: step.id, index: index + 1, total }, 'step started');

    const result = await runAgentLoop(stepTask(step, index, total), {
      provider: options.provider,
      tools: options.tools,
      workspace: options.workspace,
      maxIterations: options.maxIterationsPerStep,
      maxRepeatedCalls: options.maxRepeatedCalls,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      signal: options.signal,
      logger: options.logger,
      context,
      ignore: options.ignore,
      confirm: options.confirm,
      commandTimeoutMs: options.commandTimeoutMs,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
    });

    usage = addUsage(usage, result.usage);
    const status = result.stopReason === 'answer' ? 'completed' : 'failed';
    const stepResult: StepResult = {
      step,
      status,
      answer: result.content,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      usage: result.usage,
      stopReason: result.stopReason,
    };
    steps.push(stepResult);
    options.logger?.info(
      {
        step: step.id,
        status,
        stopReason: result.stopReason,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
      },
      'step finished',
    );
    await options.onStepEnd?.(stepResult, index, total);

    if (status === 'failed') {
      completed = false;
      break;
    }
  }

  return { steps, usage, completed };
}

function stepTask(step: PlanStep, index: number, total: number): string {
  const files = step.files.length === 0 ? '(choose files as needed)' : step.files.join(', ');
  return [
    `Plan step ${index + 1}/${total}: ${step.title}`,
    step.description,
    `Related files: ${files}`,
    'Work only on this step, then reply with a short summary of the result.',
  ].join('\n');
}

function assertCompletedPrefix(plan: TaskPlan, completedSteps: readonly StepResult[]): void {
  if (completedSteps.length > plan.steps.length) {
    throw new AgentError(
      ErrorCode.TaskInvalid,
      `completed steps (${completedSteps.length}) exceed plan steps (${plan.steps.length})`,
    );
  }
  for (let index = 0; index < completedSteps.length; index += 1) {
    const entry = completedSteps[index];
    const expected = plan.steps[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.status !== 'completed') {
      throw new AgentError(
        ErrorCode.TaskInvalid,
        `completed step ${index + 1} has status ${entry.status}`,
      );
    }
    if (expected === undefined || !sameStep(entry.step, expected)) {
      throw new AgentError(
        ErrorCode.TaskInvalid,
        `completed step ${index + 1} does not match plan step`,
      );
    }
  }
}

function sameStep(left: PlanStep, right: PlanStep): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.description === right.description &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index])
  );
}
