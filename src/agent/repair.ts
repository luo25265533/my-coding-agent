import type { Logger } from 'pino';
import type { ContextManager } from '../context/manager.js';
import type { LLMProvider, ToolCall } from '../llm/types.js';
import type { TaskPlan } from '../planner/types.js';
import type { ConfirmFn } from '../security/approval.js';
import type { IgnoreMatcher } from '../security/ignore.js';
import type { DiffSummary, VerificationResult } from '../shared/reports.js';
import type { TokenUsage } from '../shared/token-usage.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import { runAgentLoop, type AgentStopReason } from './loop.js';
import type { StepResult } from './plan-runner.js';

const MAX_ANSWER_CHARS = 500;
const MAX_OUTPUT_TAIL_CHARS = 4_000;
const MAX_DIFF_FILES = 20;

export interface RepairOutcome {
  readonly attempt: number;
  readonly answer: string;
  readonly stopReason: AgentStopReason;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
}

export interface RunRepairOptions {
  readonly attempt: number;
  readonly goal: string;
  readonly plan: TaskPlan;
  readonly stepResults: readonly StepResult[];
  readonly verification: VerificationResult;
  readonly diff: DiffSummary;
  readonly maxIterations: number;
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly workspace: string;
  readonly ignore: IgnoreMatcher;
  readonly context: ContextManager;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  readonly confirm?: ConfirmFn | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly onToolCall?: ((call: ToolCall, iteration: number) => void) | undefined;
  readonly onToolResult?:
    | ((call: ToolCall, result: ToolResult, iteration: number, durationMs: number) => void)
    | undefined;
}

export async function runRepair(options: RunRepairOptions): Promise<RepairOutcome> {
  const result = await runAgentLoop(
    buildRepairTask({
      goal: options.goal,
      plan: options.plan,
      stepResults: options.stepResults,
      verification: options.verification,
      diff: options.diff,
    }),
    {
      provider: options.provider,
      tools: options.tools,
      workspace: options.workspace,
      maxIterations: options.maxIterations,
      signal: options.signal,
      logger: options.logger,
      context: options.context,
      ignore: options.ignore,
      confirm: options.confirm,
      commandTimeoutMs: options.commandTimeoutMs,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
    },
  );

  return {
    attempt: options.attempt,
    answer: result.content,
    stopReason: result.stopReason,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    usage: result.usage,
  };
}

export interface RepairTaskInput {
  readonly goal: string;
  readonly plan: TaskPlan;
  readonly stepResults: readonly StepResult[];
  readonly verification: VerificationResult;
  readonly diff: DiffSummary;
}

export function buildRepairTask(input: RepairTaskInput): string {
  const lines = [
    'Verification failed. Repair the workspace changes for this task.',
    'Do not rerun steps that already completed; inspect the current files first.',
    '',
    `Goal: ${input.goal}`,
    'Plan:',
    ...input.plan.steps.map(
      (step, index) => `${index + 1}. [${step.id}] ${step.title}: ${step.description}`,
    ),
    'Step results:',
    ...stepSummaries(input.stepResults),
    '',
    `Verification: ${describeVerification(input.verification)}`,
  ];

  const tail = outputTail(input.verification.output);
  if (tail !== '') {
    lines.push('Verification output (tail):', tail);
  }

  lines.push('', `Changes since task start: ${describeDiff(input.diff)}`);
  lines.push(
    '',
    'Constraints:',
    '- Only modify files inside the workspace.',
    '- Keep the repair minimal: do not install dependencies or touch unrelated files without a clear reason.',
    '- Rerun the failed command when possible and report the result.',
    '- Do not run git push or other destructive commands.',
    '- If the failure looks environmental, explain it instead of guessing.',
    'Reply with a short summary of what you changed and how you verified it.',
  );
  return lines.join('\n');
}

function stepSummaries(stepResults: readonly StepResult[]): readonly string[] {
  if (stepResults.length === 0) {
    return ['(no steps completed)'];
  }
  return stepResults.map(
    (result) => `- [${result.step.id}] ${result.status}: ${clip(result.answer, MAX_ANSWER_CHARS)}`,
  );
}

function describeVerification(verification: VerificationResult): string {
  const parts = [
    `attempt ${verification.attempt}`,
    `command ${verification.command === '' ? '(none)' : verification.command}`,
    `status ${verification.status}`,
  ];
  if (verification.exitCode !== null) {
    parts.push(`exit code ${verification.exitCode}`);
  }
  if (verification.timedOut) {
    parts.push('timed out');
  }
  if (verification.reason !== undefined) {
    parts.push(`reason ${verification.reason}`);
  }
  return parts.join(', ');
}

function describeDiff(diff: DiffSummary): string {
  if (!diff.available) {
    return `unavailable (${diff.reason ?? 'unknown'})`;
  }
  if (diff.files.length === 0) {
    return 'no changes detected';
  }
  const header = `${diff.files.length} files, +${diff.totalInsertions} -${diff.totalDeletions}`;
  const files = diff.files.slice(0, MAX_DIFF_FILES).map((file) => {
    const counts = `${file.insertions ?? '?'}/-${file.deletions ?? '?'}`;
    return `- ${file.status} ${counts} ${file.path}`;
  });
  if (diff.files.length > MAX_DIFF_FILES) {
    files.push(`- … ${diff.files.length - MAX_DIFF_FILES} more files omitted`);
  }
  return [header, ...files].join('\n');
}

function outputTail(output: string): string {
  return output.length <= MAX_OUTPUT_TAIL_CHARS
    ? output.trim()
    : output.slice(-MAX_OUTPUT_TAIL_CHARS).trim();
}

function clip(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}
