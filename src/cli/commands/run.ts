import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Logger } from 'pino';
import { AGENT_SYSTEM_PROMPT, runAgentLoop, type AgentStopReason } from '../../agent/loop.js';
import { buildPlanSystemPrompt, type StepResult } from '../../agent/plan-runner.js';
import type { RepairOutcome } from '../../agent/repair.js';
import { runTask } from '../../agent/task-runner.js';
import {
  createContextManager,
  type ContextManager,
  type ContextStats,
} from '../../context/manager.js';
import { createCliConfirm } from '../confirm.js';
import type { RunEventSink } from '../run-events.js';
import { loadConfig, redactConfig, type AppConfig } from '../../config/load.js';
import { createEvaluator, type Evaluator } from '../../evaluator/index.js';
import { createLogger } from '../../logger/index.js';
import { createLLMProvider } from '../../llm/factory.js';
import type { LLMProvider } from '../../llm/types.js';
import { createTaskStore } from '../../memory/index.js';
import type { TaskRecord, TaskStore } from '../../memory/types.js';
import { createPlanner } from '../../planner/index.js';
import type { PlanResult, TaskPlan } from '../../planner/types.js';
import type { ConfirmFn } from '../../security/approval.js';
import { createIgnoreMatcher, type IgnoreMatcher } from '../../security/ignore.js';
import { redactSecretValues } from '../../security/child-env.js';
import { AgentError, describeError, ErrorCode } from '../../shared/errors.js';
import { readPackageInfo } from '../../shared/package-info.js';
import type { DiffSummary, VerificationResult } from '../../shared/reports.js';
import type { LogLevel } from '../../shared/types.js';
import { createDefaultToolRegistry, type ToolRegistry } from '../../tools/index.js';

export interface RunOptions {
  readonly workspace?: string | undefined;
  readonly logLevel?: LogLevel | undefined;
  readonly verbose?: boolean | undefined;
  /** 跳过 Plan 确认；不跳过工具高风险确认 */
  readonly yes?: boolean | undefined;
  /** 只生成并打印 Plan，不执行 */
  readonly planOnly?: boolean | undefined;
  /** 退回阶段 5 的直接循环模式 */
  readonly noPlan?: boolean | undefined;
  /** 恢复已保存的任务；不能与任务文本或 --plan-only 同时使用 */
  readonly resume?: string | undefined;
  /** 覆盖验证命令（显式配置，不自动跳过） */
  readonly verify?: string | undefined;
  /** 本次任务不执行验证 */
  readonly noVerify?: boolean | undefined;
  /** 测试注入：替代交互式 Plan 确认 */
  readonly approvePlan?: ((plan: TaskPlan, text: string) => Promise<boolean>) | undefined;
  /** 测试注入：替代交互式高风险工具确认 */
  readonly confirm?: ConfirmFn | undefined;
  /** 外部中止信号（web 等宿主）；与 SIGINT 兜底合并 */
  readonly signal?: AbortSignal | undefined;
  /** 结构化事件外发（web 等宿主）；不传则仅保留 stdout 行为 */
  readonly sink?: RunEventSink | undefined;
  /** 宿主注入已加载配置（web 等宿主）；传入后跳过环境变量与 .env 解析 */
  readonly config?: AppConfig | undefined;
}

export interface RunResult {
  readonly runId: string;
  readonly logFile: string;
  readonly content: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly stopReason: AgentStopReason | 'plan_declined' | 'plan_only';
  readonly context: ContextStats;
  readonly plan: TaskPlan | undefined;
  readonly steps: readonly StepResult[];
  readonly taskId?: string | undefined;
  readonly verification?: VerificationResult | undefined;
  readonly diff?: DiffSummary | undefined;
  readonly repairs?: number | undefined;
}

const NO_TASK_MESSAGE = 'a task is required: agent run "describe the task"';

interface FlowContext {
  readonly taskText: string;
  readonly config: AppConfig;
  readonly runId: string;
  readonly logFile: string;
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly ignore: IgnoreMatcher;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly options: RunOptions;
  readonly sink: RunEventSink | undefined;
}

interface VerificationSettings {
  readonly command: string | undefined;
  readonly autoSkip: boolean;
}

interface ExecuteTaskOptions {
  readonly store: TaskStore;
  readonly task: TaskRecord;
  readonly context: ContextManager;
  readonly evaluator: Evaluator;
  readonly verification: VerificationSettings;
}

export async function runCommand(task: readonly string[], options: RunOptions): Promise<RunResult> {
  const taskText = task.join(' ').trim();
  assertOptions(taskText, options);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.workspace !== undefined) {
    env.AGENT_WORKSPACE = options.workspace;
  }
  const level = options.verbose === true ? 'debug' : options.logLevel;
  if (level !== undefined) {
    env.AGENT_LOG_LEVEL = level;
  }

  const config = options.config ?? loadConfig({ env });
  const runId = randomUUID();
  const { logger, logFile, close } = createLogger(config, runId);
  const log = logger.child({ module: 'cli' });
  const agentLog = logger.child({ module: 'agent' });

  const provider = createLLMProvider(config, { logger: agentLog });
  const tools = createDefaultToolRegistry();
  const ignore = createIgnoreMatcher({
    workspace: config.agent.workspace,
    respectGitignore: config.agent.respectGitignore,
    extraPatterns: config.agent.ignorePatterns,
  });

  log.info({ task: taskText, resume: options.resume, provider: provider.name }, 'run started');
  log.debug({ config: redactConfig(config) }, 'configuration loaded');

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  const onExternalAbort = (): void => {
    controller.abort();
  };
  const externalSignal = options.signal;
  if (externalSignal?.aborted === true) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  const flow: FlowContext = {
    taskText,
    config,
    runId,
    logFile,
    provider,
    tools,
    ignore,
    signal: controller.signal,
    logger,
    options,
    sink: options.sink,
  };

  try {
    if (options.noPlan === true) {
      return await runDirect(flow, log, agentLog);
    }
    return await runPlanned(flow, log, agentLog);
  } catch (error) {
    log.error({ reason: describeError(error) }, 'run failed');
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    close();
  }
}

function assertOptions(taskText: string, options: RunOptions): void {
  if (options.verify !== undefined) {
    if (options.verify.trim() === '') {
      throw new AgentError(ErrorCode.UsageInvalid, '--verify requires a non-empty command');
    }
    if (options.noVerify === true) {
      throw new AgentError(ErrorCode.UsageInvalid, '--verify cannot be combined with --no-verify');
    }
  }

  if (options.resume !== undefined) {
    if (taskText !== '') {
      throw new AgentError(
        ErrorCode.UsageInvalid,
        '--resume cannot be combined with a task description',
      );
    }
    if (options.planOnly === true) {
      throw new AgentError(ErrorCode.UsageInvalid, '--resume cannot be combined with --plan-only');
    }
    return;
  }

  if (taskText === '') {
    throw new AgentError(ErrorCode.UsageInvalid, NO_TASK_MESSAGE);
  }
}

async function runDirect(flow: FlowContext, log: Logger, agentLog: Logger): Promise<RunResult> {
  const { config, provider, tools, ignore, signal, taskText } = flow;
  const context = createContextManager({
    workspace: config.agent.workspace,
    budgetTokens: config.agent.contextBudgetTokens,
    ignore,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    signal,
    logger: flow.logger.child({ module: 'context' }),
  });
  await context.buildMessages(taskText);
  printBanner(flow, context.stats());

  const result = await runAgentLoop(taskText, {
    provider,
    tools,
    workspace: config.agent.workspace,
    maxIterations: config.agent.maxIterations,
    maxRepeatedCalls: config.agent.maxRepeatedCalls,
    maxConsecutiveFailures: config.agent.maxConsecutiveFailures,
    signal,
    logger: agentLog,
    context,
    ignore,
    confirm: resolveConfirm(flow),
    commandTimeoutMs: config.agent.commandTimeoutMs,
    onToolCall: (call, iteration) => {
      printToolCall(call, iteration);
      flow.sink?.toolCall?.(call, iteration);
    },
    onToolResult: (call, toolResult, iteration, durationMs) => {
      printToolResult(call, toolResult, iteration, durationMs);
      flow.sink?.toolResult?.(toolResult, iteration, durationMs);
    },
  });

  if (result.content !== '' && result.stopReason === 'answer') {
    process.stdout.write(`\nanswer:\n${result.content}\n`);
    flow.sink?.answer?.(result.content);
  }
  process.stdout.write(
    `tokens: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}  iterations=${result.iterations}  tools=${result.toolCalls}\n`,
  );
  flow.sink?.tokens?.({
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
  });
  printContextTrim(context.stats());
  flow.sink?.contextTrim?.(context.stats());

  if (result.stopReason !== 'answer') {
    throw stopError(result.stopReason, result.iterations);
  }

  log.info(
    {
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      usage: result.usage,
      context: context.stats(),
    },
    'run finished',
  );
  return {
    runId: flow.runId,
    logFile: flow.logFile,
    content: result.content,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    context: context.stats(),
    plan: undefined,
    steps: [],
  };
}

async function runPlanned(flow: FlowContext, log: Logger, agentLog: Logger): Promise<RunResult> {
  return flow.options.resume === undefined
    ? runNewTask(flow, log, agentLog)
    : runResume(flow, log, agentLog);
}

async function runNewTask(flow: FlowContext, log: Logger, agentLog: Logger): Promise<RunResult> {
  const { config, provider, ignore, signal, options, taskText } = flow;

  const planner = createPlanner({
    provider,
    workspace: config.agent.workspace,
    ignore,
    contextBudgetTokens: config.agent.contextBudgetTokens,
    maxSteps: config.agent.planMaxSteps,
    signal,
    logger: flow.logger.child({ module: 'planner' }),
  });
  const planResult = await planner.plan(taskText);
  const plan = planResult.plan;
  log.info(
    { steps: plan.steps.length, attempts: planResult.attempts, usage: planResult.usage },
    'plan generated',
  );

  const verification = resolveVerification(config, options);
  const context = await createRunContext(flow, buildPlanSystemPrompt(plan), taskText);
  printBanner(flow, context.stats(), { verification });
  const planText = printPlan(plan, planResult, flow.sink);

  const evaluator = createRunEvaluator(flow, resolveConfirm(flow));

  if (options.planOnly === true) {
    const store = await openTaskStore(flow);
    try {
      const baseline = await evaluator.diff();
      const task = await store.createTask({
        goal: taskText,
        plan,
        workspace: config.agent.workspace,
        verifyCommand: verification.command,
        verifyAutoSkip: verification.autoSkip,
        baselineDiff: baseline,
      });
      log.info({ steps: plan.steps.length, taskId: task.id }, 'plan only');
      process.stdout.write(`task: ${task.id}\nresume with: agent run --resume ${task.id}\n`);
      flow.sink?.taskCreated?.(task.id);
      return {
        runId: flow.runId,
        logFile: flow.logFile,
        content: '',
        iterations: 0,
        toolCalls: 0,
        stopReason: 'plan_only',
        context: context.stats(),
        plan,
        steps: [],
        taskId: task.id,
      };
    } finally {
      await store.close();
    }
  }

  const approved =
    options.yes === true ? true : await approvePlan(plan, planText, options.approvePlan);
  if (!approved) {
    log.info({ steps: plan.steps.length }, 'plan declined');
    process.stdout.write('plan declined; nothing executed\n');
    return {
      runId: flow.runId,
      logFile: flow.logFile,
      content: '',
      iterations: 0,
      toolCalls: 0,
      stopReason: 'plan_declined',
      context: context.stats(),
      plan,
      steps: [],
    };
  }

  const store = await openTaskStore(flow);
  try {
    const baseline = await evaluator.diff();
    const task = await store.createTask({
      goal: taskText,
      plan,
      workspace: config.agent.workspace,
      verifyCommand: verification.command,
      verifyAutoSkip: verification.autoSkip,
      baselineDiff: baseline,
    });
    log.info({ steps: plan.steps.length, taskId: task.id }, 'plan confirmed');
    process.stdout.write(`task: ${task.id}\n`);
    flow.sink?.taskCreated?.(task.id);
    return await executeTask(flow, log, agentLog, {
      store,
      task,
      context,
      evaluator,
      verification,
    });
  } finally {
    await store.close();
  }
}

async function runResume(flow: FlowContext, log: Logger, agentLog: Logger): Promise<RunResult> {
  const taskId = flow.options.resume ?? '';
  const { config, options } = flow;
  const store = await openTaskStore(flow);

  try {
    const task = await store.getTask(taskId);
    if (task === undefined) {
      throw new AgentError(ErrorCode.TaskNotFound, `task not found: ${taskId}`);
    }
    if (path.resolve(task.workspace) !== path.resolve(config.agent.workspace)) {
      throw new AgentError(
        ErrorCode.TaskInvalid,
        `task workspace does not match current workspace (task=${task.workspace}, current=${config.agent.workspace})`,
      );
    }

    const completed = task.steps.filter((step) => step.status === 'completed').length;
    process.stdout.write(
      `resuming task ${task.id} (status=${task.status}, completed steps ${completed}/${task.steps.length})\n`,
    );

    const verification = resolveVerification(config, options, task);
    const context = await createRunContext(flow, buildPlanSystemPrompt(task.plan), task.goal);
    printBanner(flow, context.stats(), {
      goal: task.goal,
      taskId: task.id,
      verification,
    });

    if (task.status !== 'completed') {
      const planText = printPlan(task.plan, undefined, flow.sink);
      if (task.status === 'planned') {
        const approved =
          options.yes === true ? true : await approvePlan(task.plan, planText, options.approvePlan);
        if (!approved) {
          log.info({ steps: task.plan.steps.length, taskId: task.id }, 'plan declined');
          process.stdout.write('plan declined; nothing executed\n');
          return {
            runId: flow.runId,
            logFile: flow.logFile,
            content: '',
            iterations: 0,
            toolCalls: 0,
            stopReason: 'plan_declined',
            context: context.stats(),
            plan: task.plan,
            steps: [],
            taskId: task.id,
          };
        }
        log.info({ steps: task.plan.steps.length, taskId: task.id }, 'plan confirmed');
      }
    }

    const evaluator = createRunEvaluator(flow, resolveConfirm(flow));
    return await executeTask(flow, log, agentLog, {
      store,
      task,
      context,
      evaluator,
      verification,
    });
  } finally {
    await store.close();
  }
}

async function executeTask(
  flow: FlowContext,
  log: Logger,
  agentLog: Logger,
  exec: ExecuteTaskOptions,
): Promise<RunResult> {
  const { config, provider, tools, ignore, signal } = flow;
  const { store, task, context, evaluator, verification } = exec;
  let printedVerification = false;
  let printedDiff = false;

  const result = await runTask({
    task,
    store,
    evaluator,
    context,
    provider,
    tools,
    workspace: config.agent.workspace,
    ignore,
    contextBudgetTokens: config.agent.contextBudgetTokens,
    maxIterationsPerStep: config.agent.stepMaxIterations,
    maxRepeatedCalls: config.agent.maxRepeatedCalls,
    maxConsecutiveFailures: config.agent.maxConsecutiveFailures,
    signal,
    logger: agentLog,
    confirm: resolveConfirm(flow),
    commandTimeoutMs: config.agent.commandTimeoutMs,
    verifyCommand: verification.command,
    verifyAutoSkip: verification.autoSkip,
    verifySkipStatic: config.agent.verifySkipStatic,
    verifyTimeoutMs: config.agent.verifyTimeoutMs,
    maxRepairAttempts: config.agent.maxRepairAttempts,
    repairMaxIterations: config.agent.repairMaxIterations,
    onStepStart: (step, index, total) => {
      process.stdout.write(`\nstep ${index + 1}/${total} → ${step.title}\n`);
      flow.sink?.stepStart?.(step, index, total);
    },
    onStepEnd: (stepResult, index, total) => {
      process.stdout.write(
        `step ${index + 1}/${total} ← ${stepResult.status} (iterations=${stepResult.iterations} tools=${stepResult.toolCalls})\n`,
      );
      flow.sink?.stepEnd?.(stepResult, index, total);
    },
    onToolCall: (call, iteration) => {
      printToolCall(call, iteration);
      flow.sink?.toolCall?.(call, iteration);
    },
    onToolResult: (call, toolResult, iteration, durationMs) => {
      printToolResult(call, toolResult, iteration, durationMs);
      flow.sink?.toolResult?.(toolResult, iteration, durationMs);
    },
    onVerification: (verificationResult) => {
      printedVerification = true;
      printVerification(verificationResult, flow.sink);
    },
    onDiff: (diff) => {
      printedDiff = true;
      printDiff(diff, flow.sink);
    },
    onRepair: (outcome) => {
      printRepair(outcome, config.agent.maxRepairAttempts, flow.sink);
    },
  });

  const finalTask = result.task;
  printContextTrim(context.stats());
  flow.sink?.contextTrim?.(context.stats());
  const iterations = result.steps.reduce((sum, step) => sum + step.iterations, 0);
  const toolCalls = result.steps.reduce((sum, step) => sum + step.toolCalls, 0);
  const lastStep = result.steps[result.steps.length - 1];

  log.info(
    {
      taskId: finalTask.id,
      status: finalTask.status,
      steps: result.steps.length,
      toolCalls,
      usage: result.planResult.usage,
      context: context.stats(),
    },
    'run finished',
  );

  if (!printedVerification && result.verification !== undefined) {
    printVerification(result.verification, flow.sink);
  }
  if (!printedDiff && result.diff !== undefined) {
    printDiff(result.diff, flow.sink);
  }

  if (finalTask.status === 'step_failed') {
    const failed = result.steps.find((step) => step.status === 'failed');
    process.stdout.write(
      `plan failed at step ${failed?.step.id ?? '?'}: ${failed?.stopReason ?? 'unknown'}\n`,
    );
    printTaskState('step_failed', finalTask.id, flow.sink);
    log.warn(
      { taskId: finalTask.id, step: failed?.step.id, stopReason: failed?.stopReason },
      'task step failed',
    );
    throw new AgentError(
      ErrorCode.AgentIncomplete,
      `plan step ${failed?.step.id ?? '?'} failed (${failed?.stopReason ?? 'unknown'}); later steps were not executed`,
    );
  }

  if (finalTask.status !== 'completed') {
    printTaskState('failed', finalTask.id, flow.sink);
    log.warn(
      { taskId: finalTask.id, status: finalTask.status, error: finalTask.error },
      'task failed',
    );
    throw new AgentError(
      ErrorCode.VerificationFailed,
      finalTask.error ?? `task ${finalTask.id} did not complete`,
    );
  }

  process.stdout.write(
    `plan completed  steps=${result.steps.length}  tools=${toolCalls}  tokens: prompt=${result.planResult.usage.promptTokens} completion=${result.planResult.usage.completionTokens} total=${result.planResult.usage.totalTokens}\n`,
  );
  if (lastStep !== undefined && lastStep.answer !== '') {
    process.stdout.write(`\nanswer:\n${lastStep.answer}\n`);
    flow.sink?.answer?.(lastStep.answer);
  }
  process.stdout.write(`task completed: ${finalTask.id}\n`);

  return {
    runId: flow.runId,
    logFile: flow.logFile,
    content: lastStep?.answer ?? '',
    iterations,
    toolCalls,
    stopReason: 'answer',
    context: context.stats(),
    plan: finalTask.plan,
    steps: result.steps,
    taskId: finalTask.id,
    verification: result.verification,
    diff: result.diff,
    repairs: result.repairs,
  };
}

function resolveConfirm(flow: FlowContext): ConfirmFn {
  return (
    flow.options.confirm ??
    createCliConfirm({
      enabled: flow.config.agent.confirmHighRisk,
      timeoutMs: flow.config.agent.confirmTimeoutMs,
    })
  );
}

function resolveVerification(
  config: AppConfig,
  options: RunOptions,
  task?: TaskRecord,
): VerificationSettings {
  if (options.noVerify === true) {
    return { command: undefined, autoSkip: false };
  }
  if (options.verify !== undefined) {
    return { command: options.verify.trim(), autoSkip: false };
  }
  if (task !== undefined) {
    return { command: task.verifyCommand, autoSkip: task.verifyAutoSkip };
  }
  return {
    command: config.agent.verifyCommand,
    autoSkip: !config.agent.verifyCommandExplicit,
  };
}

function openTaskStore(flow: FlowContext): Promise<TaskStore> {
  return createTaskStore({
    dbPath: flow.config.agent.taskDb,
    workspace: flow.config.agent.workspace,
    logger: flow.logger.child({ module: 'memory' }),
  });
}

function createRunEvaluator(flow: FlowContext, confirm: ConfirmFn): Evaluator {
  return createEvaluator({
    workspace: flow.config.agent.workspace,
    confirm,
    signal: flow.signal,
    logger: flow.logger.child({ module: 'evaluator' }),
  });
}

async function createRunContext(
  flow: FlowContext,
  systemPrompt: string,
  goal: string,
): Promise<ContextManager> {
  const context = createContextManager({
    workspace: flow.config.agent.workspace,
    budgetTokens: flow.config.agent.contextBudgetTokens,
    ignore: flow.ignore,
    systemPrompt,
    signal: flow.signal,
    logger: flow.logger.child({ module: 'context' }),
  });
  await context.buildMessages(goal);
  return context;
}

function printBanner(
  flow: FlowContext,
  stats: ContextStats,
  extra?: {
    readonly goal?: string;
    readonly taskId?: string;
    readonly verification?: VerificationSettings;
  },
): void {
  const info = readPackageInfo();
  const lines = [
    `${info.name} v${info.version}`,
    `runId     : ${flow.runId}`,
    `workspace : ${flow.config.agent.workspace}`,
    `provider  : ${flow.provider.name}  model: ${flow.config.llm.model ?? '(default)'}`,
    `context   : budget=${stats.budgetTokens} tokens  repo-map=${stats.repoMapTokens} tokens  files=${stats.repoMapFiles}${stats.repoMapTruncated ? ' (truncated)' : ''}`,
    `task      : ${extra?.goal ?? flow.taskText}`,
  ];
  if (extra?.taskId !== undefined) {
    lines.push(`taskId    : ${extra.taskId}`);
  }
  if (extra?.verification !== undefined) {
    lines.push(
      `verify    : ${redactSecretValues(describeVerification(extra.verification), redactionEnv(flow.config))}`,
    );
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
  flow.sink?.banner?.(lines);
}

function describeVerification(settings: VerificationSettings): string {
  if (settings.command === undefined) {
    return 'disabled';
  }
  return settings.autoSkip
    ? `${settings.command} (auto-skip without package.json)`
    : settings.command;
}

function redactionEnv(config: AppConfig): NodeJS.ProcessEnv {
  if (config.llm.apiKey === undefined) {
    return process.env;
  }
  return { ...process.env, LLM_API_KEY: config.llm.apiKey };
}

function printPlan(plan: TaskPlan, planResult?: PlanResult, sink?: RunEventSink): string {
  const lines = ['plan:', `  goal: ${plan.goal}`];
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. [${step.id}] ${step.title}`);
    if (step.files.length > 0) {
      lines.push(`     files: ${step.files.join(', ')}`);
    }
  });
  if (plan.notes !== undefined) {
    lines.push(`  notes: ${plan.notes}`);
  }
  if (planResult !== undefined) {
    lines.push(`  (attempts=${planResult.attempts} repo-map=${planResult.repoMapTokens} tokens)`);
  }
  lines.push('');
  const text = lines.join('\n');
  process.stdout.write(text);
  sink?.plan?.(plan);
  return text;
}

async function approvePlan(
  plan: TaskPlan,
  planText: string,
  injected: RunOptions['approvePlan'],
): Promise<boolean> {
  if (injected !== undefined) {
    return injected(plan, planText);
  }
  if (process.stdin.isTTY !== true) {
    process.stdout.write('non-interactive stdin: plan not executed (pass --yes to execute)\n');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Execute this plan? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printToolCall(
  call: { readonly name: string; readonly arguments: string },
  iteration: number,
): void {
  process.stdout.write(`[${iteration}] → ${call.name} ${compactArguments(call.arguments)}\n`);
}

function printToolResult(
  _call: unknown,
  toolResult: {
    readonly ok: boolean;
    readonly content: string;
    readonly truncated?: boolean | undefined;
    readonly meta?: Readonly<Record<string, unknown>> | undefined;
  },
  iteration: number,
  durationMs: number,
): void {
  const status = toolResult.ok ? 'ok' : 'error';
  const truncated = toolResult.truncated === true ? ', truncated' : '';
  const errorCode = toolResult.meta?.['code'];
  const detail = typeof errorCode === 'string' ? `: ${errorCode}` : '';
  process.stdout.write(
    `[${iteration}] ← ${status} ${toolResult.content.length} chars (${durationMs}ms${truncated})${detail}\n`,
  );
}

function printVerification(result: VerificationResult, sink?: RunEventSink): void {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.status === 'passed') {
    process.stdout.write(`verification: passed (command="${result.command}", ${seconds}s)\n`);
    sink?.verification?.(result);
    return;
  }
  if (result.status === 'skipped') {
    process.stdout.write(`verification: skipped (${result.reason ?? 'disabled'})\n`);
    sink?.verification?.(result);
    return;
  }
  const detail = result.timedOut ? 'timeout' : `exit=${result.exitCode ?? 'null'}`;
  process.stdout.write(`verification: failed (${detail}, ${seconds}s)\n`);
  sink?.verification?.(result);
}

function printDiff(diff: DiffSummary, sink?: RunEventSink): void {
  if (!diff.available) {
    process.stdout.write(`diff: unavailable (${diff.reason ?? 'unknown'})\n`);
    sink?.diff?.(diff);
    return;
  }
  const truncated = diff.truncated ? ' (truncated)' : '';
  process.stdout.write(
    `diff: ${diff.files.length} files, +${diff.totalInsertions} -${diff.totalDeletions}${truncated}\n`,
  );
  sink?.diff?.(diff);
}

function printContextTrim(stats: ContextStats): void {
  if (stats.droppedMessages > 0 || stats.truncatedToolMessages > 0) {
    process.stdout.write(
      `context trimmed: dropped=${stats.droppedMessages} truncated=${stats.truncatedToolMessages}\n`,
    );
  }
}

function printRepair(outcome: RepairOutcome, maxAttempts: number, sink?: RunEventSink): void {
  const label = outcome.stopReason === 'answer' ? 'answered' : outcome.stopReason;
  process.stdout.write(
    `repair ${outcome.attempt}/${maxAttempts}: ${label} (iterations=${outcome.iterations} tools=${outcome.toolCalls})\n`,
  );
  sink?.repair?.(outcome, maxAttempts);
}

function printTaskState(
  state: 'step_failed' | 'failed',
  taskId: string,
  sink?: RunEventSink,
): void {
  process.stdout.write(`task ${state}: ${taskId}\nresume with: agent run --resume ${taskId}\n`);
  sink?.taskState?.(state, taskId);
}

const INCOMPLETE_HINTS: Readonly<
  Record<Exclude<AgentStopReason, 'answer' | 'max_iterations'>, string>
> = {
  empty_answer: 'the model returned an empty answer',
  output_truncated: 'the model output was truncated (finish_reason=length)',
  repeated_tool_call: 'the model kept calling the same tool with the same arguments',
  tool_failure_limit: 'consecutive tool failures reached the limit',
};

function stopError(reason: Exclude<AgentStopReason, 'answer'>, iterations: number): AgentError {
  if (reason === 'max_iterations') {
    return new AgentError(
      ErrorCode.AgentMaxIterations,
      `no final answer after ${iterations} iterations; raise AGENT_MAX_ITERATIONS or narrow the task`,
    );
  }
  return new AgentError(
    ErrorCode.AgentIncomplete,
    `agent stopped (${reason}): ${INCOMPLETE_HINTS[reason]} after ${iterations} iterations`,
  );
}

function compactArguments(argumentsText: string): string {
  const singleLine = argumentsText.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 200) {
    return singleLine;
  }
  return `${singleLine.slice(0, 200)}…`;
}
