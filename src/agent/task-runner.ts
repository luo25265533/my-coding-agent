import { stat } from 'node:fs/promises';
import path from 'node:path';
import { diffSince, isStaticOnlyDiff } from '../evaluator/index.js';
import type { Evaluator } from '../evaluator/types.js';
import type {
  TaskRecord,
  TaskStatus,
  TaskStepRecord,
  TaskStore,
  TransitionPatch,
} from '../memory/types.js';
import type { DiffSummary, VerificationResult } from '../shared/reports.js';
import { addUsage, EMPTY_USAGE, type TokenUsage } from '../shared/token-usage.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { runRepair, type RepairOutcome } from './repair.js';
import {
  runPlan,
  type PlanRunResult,
  type RunPlanOptions,
  type StepResult,
} from './plan-runner.js';

const DEFAULT_VERIFY_COMMAND = 'pnpm test';

export interface RunTaskOptions extends Omit<RunPlanOptions, 'context' | 'completedSteps'> {
  readonly task: TaskRecord;
  readonly store: TaskStore;
  readonly evaluator: Evaluator;
  readonly context: NonNullable<RunPlanOptions['context']>;
  readonly verifyCommand: string | undefined;
  readonly verifyAutoSkip: boolean;
  readonly verifySkipStatic: boolean;
  readonly verifyTimeoutMs: number;
  readonly maxRepairAttempts: number;
  readonly repairMaxIterations: number;
  readonly onVerification?: ((result: VerificationResult) => void) | undefined;
  readonly onDiff?: ((diff: DiffSummary) => void) | undefined;
  readonly onRepair?: ((outcome: RepairOutcome) => void) | undefined;
}

export interface TaskRunResult {
  /** 重新读取的终态 */
  readonly task: TaskRecord;
  readonly steps: readonly StepResult[];
  readonly planResult: PlanRunResult;
  readonly verification: VerificationResult | undefined;
  readonly diff: DiffSummary | undefined;
  readonly repairs: number;
}

export async function runTask(options: RunTaskOptions): Promise<TaskRunResult> {
  const { store, task } = options;
  const workspace = path.resolve(options.workspace);
  if (path.resolve(task.workspace) !== workspace) {
    throw new AgentError(ErrorCode.TaskInvalid, 'task workspace does not match current workspace');
  }

  if (task.status === 'completed') {
    return completedResult(task);
  }

  let currentStatus: TaskStatus = task.status;
  const setStatus = async (to: TaskStatus, patch?: TransitionPatch): Promise<void> => {
    if (currentStatus === to) {
      return;
    }
    await store.transition(task.id, to, patch);
    currentStatus = to;
  };

  try {
    if (task.status !== 'planned') {
      await store.markResumed(task.id);
    }
    if (task.status === 'repairing') {
      await setStatus('verifying');
    } else if (task.status !== 'running' && task.status !== 'verifying') {
      await setStatus('running');
    }

    let baseline = task.baselineDiff;
    if (baseline === undefined) {
      baseline = await options.evaluator.diff();
      await store.setBaselineDiff(task.id, baseline);
    }

    const planResult = await runPlan(task.plan, {
      provider: options.provider,
      tools: options.tools,
      workspace,
      ignore: options.ignore,
      contextBudgetTokens: options.contextBudgetTokens,
      maxIterationsPerStep: options.maxIterationsPerStep,
      maxRepeatedCalls: options.maxRepeatedCalls,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      signal: options.signal,
      logger: options.logger,
      confirm: options.confirm,
      commandTimeoutMs: options.commandTimeoutMs,
      context: options.context,
      completedSteps: completedSteps(task),
      onStepStart: async (step, index, total) => {
        await store.startStep(task.id, index);
        await options.onStepStart?.(step, index, total);
      },
      onStepEnd: async (result, index, total) => {
        await store.finishStep(task.id, toStepRecord(result, index));
        await options.onStepEnd?.(result, index, total);
      },
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
    });

    if (!planResult.completed) {
      const failed = planResult.steps.find((step) => step.status === 'failed');
      const reason =
        failed === undefined
          ? 'plan failed'
          : `step ${failed.step.id} failed: ${failed.stopReason}`;
      await setStatus('step_failed', { error: reason });
      return await finalResult(
        store,
        task.id,
        planResult,
        undefined,
        undefined,
        task.repairAttempts,
      );
    }

    await setStatus('verifying');
    let repairs = task.repairAttempts;
    let diff = diffSince(baseline, await options.evaluator.diff());
    let verification = await verifyOnce(options, repairs + 1, diff);
    await recordVerification(options, verification, diff);

    while (verification.status === 'failed') {
      if (repairs >= options.maxRepairAttempts) {
        await setStatus('failed', { error: verificationFailureMessage(verification, repairs) });
        return await finalResult(store, task.id, planResult, verification, diff, repairs);
      }

      await setStatus('repairing');
      const attempt = repairs + 1;
      const outcome = await runRepair({
        attempt,
        goal: task.goal,
        plan: task.plan,
        stepResults: planResult.steps,
        verification,
        diff,
        maxIterations: options.repairMaxIterations,
        provider: options.provider,
        tools: options.tools,
        workspace,
        ignore: options.ignore,
        context: options.context,
        signal: options.signal,
        logger: options.logger,
        confirm: options.confirm,
        commandTimeoutMs: options.commandTimeoutMs,
        onToolCall: options.onToolCall,
        onToolResult: options.onToolResult,
      });
      await store.recordRepair(task.id, attempt, {
        answer: outcome.answer,
        stopReason: outcome.stopReason,
        iterations: outcome.iterations,
        toolCalls: outcome.toolCalls,
        usage: outcome.usage,
      });
      repairs = attempt;
      options.onRepair?.(outcome);

      if (outcome.stopReason !== 'answer') {
        await setStatus('failed', { error: `repair stopped: ${outcome.stopReason}` });
        return await finalResult(store, task.id, planResult, verification, diff, repairs);
      }

      await setStatus('verifying');
      diff = diffSince(baseline, await options.evaluator.diff());
      verification = await verifyOnce(options, repairs + 1, diff);
      await recordVerification(options, verification, diff);
    }

    await setStatus('completed', { error: null });
    return await finalResult(store, task.id, planResult, verification, diff, repairs);
  } catch (error) {
    await settleFailure(store, task.id, currentStatus, error, options.logger);
    throw error;
  }
}

function completedResult(task: TaskRecord): TaskRunResult {
  const steps = completedSteps(task);
  if (steps.length !== task.steps.length) {
    throw new AgentError(ErrorCode.TaskInvalid, 'completed task has unfinished steps');
  }
  const usage = steps.reduce<TokenUsage>((sum, step) => addUsage(sum, step.usage), EMPTY_USAGE);
  return {
    task,
    steps,
    planResult: { steps, usage, completed: true },
    verification: task.verifications[task.verifications.length - 1],
    diff: task.diffs[task.diffs.length - 1],
    repairs: task.repairAttempts,
  };
}

function completedSteps(task: TaskRecord): readonly StepResult[] {
  const results: StepResult[] = [];
  for (const record of task.steps) {
    if (record.status !== 'completed') {
      break;
    }
    results.push({
      step: record.step,
      status: 'completed',
      answer: record.answer,
      iterations: record.iterations,
      toolCalls: record.toolCalls,
      usage: record.usage,
      stopReason: record.stopReason ?? 'answer',
    });
  }
  return results;
}

function toStepRecord(result: StepResult, index: number): TaskStepRecord {
  return {
    index,
    step: result.step,
    status: result.status,
    answer: result.answer,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    usage: result.usage,
    stopReason: result.stopReason,
    startedAt: undefined,
    finishedAt: Date.now(),
  };
}

async function verifyOnce(
  options: RunTaskOptions,
  attempt: number,
  diff: DiffSummary,
): Promise<VerificationResult> {
  const command = options.verifyCommand;
  if (command === undefined) {
    return skippedResult('', attempt, 'verification disabled');
  }
  if (
    options.verifyAutoSkip &&
    command === DEFAULT_VERIFY_COMMAND &&
    !(await hasPackageJson(options.workspace))
  ) {
    return skippedResult(command, attempt, 'no package.json');
  }
  if (
    options.verifyAutoSkip &&
    options.verifySkipStatic &&
    command === DEFAULT_VERIFY_COMMAND &&
    isStaticOnlyDiff(diff)
  ) {
    const reason =
      diff.files.length === 0
        ? 'no detectable file changes'
        : `static-only changes (${diff.files.length} files)`;
    options.logger?.info({ command, reason }, 'verification skipped');
    return skippedResult(command, attempt, reason);
  }
  return options.evaluator.verify({ command, timeoutMs: options.verifyTimeoutMs, attempt });
}

async function recordVerification(
  options: RunTaskOptions,
  verification: VerificationResult,
  diff: DiffSummary,
): Promise<void> {
  await options.store.recordVerification(options.task.id, verification);
  await options.store.recordDiff(options.task.id, diff);
  options.onVerification?.(verification);
  options.onDiff?.(diff);
}

async function finalResult(
  store: TaskStore,
  taskId: string,
  planResult: PlanRunResult,
  verification: VerificationResult | undefined,
  diff: DiffSummary | undefined,
  repairs: number,
): Promise<TaskRunResult> {
  const task = await store.getTask(taskId);
  if (task === undefined) {
    throw new AgentError(ErrorCode.TaskNotFound, `task not found: ${taskId}`);
  }
  return { task, steps: planResult.steps, planResult, verification, diff, repairs };
}

async function settleFailure(
  store: TaskStore,
  taskId: string,
  status: TaskStatus,
  error: unknown,
  logger: RunTaskOptions['logger'],
): Promise<void> {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted' ||
    status === 'step_failed'
  ) {
    return;
  }
  const aborted = error instanceof AgentError && error.code === ErrorCode.LlmAborted;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await store.transition(taskId, aborted ? 'aborted' : 'failed', { error: message });
  } catch (transitionError) {
    logger?.warn({ err: transitionError }, 'failed to persist task failure state');
  }
}

function verificationFailureMessage(verification: VerificationResult, repairs: number): string {
  const detail = verification.timedOut
    ? 'timed out'
    : (verification.reason ?? `exit code ${verification.exitCode ?? 'unknown'}`);
  return `verification failed after ${repairs} repair attempt(s): ${verification.command} -> ${detail}`;
}

function skippedResult(command: string, attempt: number, reason: string): VerificationResult {
  return {
    status: 'skipped',
    command,
    attempt,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    output: '',
    reason,
  };
}

async function hasPackageJson(workspace: string): Promise<boolean> {
  const info = await stat(path.join(workspace, 'package.json')).catch(() => undefined);
  return info?.isFile() === true;
}
