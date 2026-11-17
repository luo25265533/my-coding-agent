import { loadConfig } from '../../config/load.js';
import { createTaskStore } from '../../memory/index.js';
import type { TaskRecord, TaskSummary } from '../../memory/types.js';
import { AgentError, ErrorCode } from '../../shared/errors.js';

export interface TasksOptions {
  readonly workspace?: string | undefined;
  /** 默认最近 20 条 */
  readonly limit?: number | undefined;
}

export interface TasksShowOptions {
  readonly workspace?: string | undefined;
}

export async function tasksCommand(options: TasksOptions = {}): Promise<void> {
  const config = loadWorkspaceConfig(options.workspace);
  const store = await createTaskStore({
    dbPath: config.agent.taskDb,
    workspace: config.agent.workspace,
    readOnly: true,
  });

  try {
    const tasks = await store.listTasks(options.limit ?? 20);
    if (tasks.length === 0) {
      process.stdout.write('no tasks\n');
      return;
    }
    process.stdout.write(formatTasks(tasks));
  } finally {
    await store.close();
  }
}

export async function tasksShowCommand(
  taskId: string,
  options: TasksShowOptions = {},
): Promise<void> {
  const config = loadWorkspaceConfig(options.workspace);
  const store = await createTaskStore({
    dbPath: config.agent.taskDb,
    workspace: config.agent.workspace,
    readOnly: true,
  });

  try {
    const task = await store.getTask(taskId);
    if (task === undefined) {
      throw new AgentError(ErrorCode.TaskNotFound, `task not found: ${taskId}`);
    }
    process.stdout.write(formatTask(task));
  } finally {
    await store.close();
  }
}

function loadWorkspaceConfig(workspace: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (workspace !== undefined) {
    env.AGENT_WORKSPACE = workspace;
  }
  return loadConfig({ env });
}

function formatTasks(tasks: readonly TaskSummary[]): string {
  const lines = tasks.map((task) => {
    const error = task.error === undefined ? '' : `  error=${task.error}`;
    return `${task.id}  ${task.status.padEnd(10)}  steps=${task.completedSteps}/${task.stepCount}  repairs=${task.repairAttempts}  updated=${formatTime(task.updatedAt)}  ${task.goal}${error}`;
  });
  return `${lines.join('\n')}\n`;
}

function formatTask(task: TaskRecord): string {
  const completed = task.steps.filter((step) => step.status === 'completed').length;
  const lines = [
    `task      : ${task.id}`,
    `goal      : ${task.goal}`,
    `workspace : ${task.workspace}`,
    `status    : ${task.status}`,
    `steps     : ${completed}/${task.steps.length}`,
    `repairs   : ${task.repairAttempts}`,
    `resumes   : ${task.resumeCount}`,
    `created   : ${formatTime(task.createdAt)}`,
    `updated   : ${formatTime(task.updatedAt)}`,
    `verify    : ${describeVerify(task)}`,
  ];
  if (task.error !== undefined) {
    lines.push(`error     : ${task.error}`);
  }
  if (task.baselineDiff !== undefined) {
    lines.push(`baseline  : ${describeDiff(task.baselineDiff)}`);
  }

  lines.push('', 'steps:');
  task.steps.forEach((record, index) => {
    lines.push(
      `  ${index + 1}. [${record.step.id}] ${record.step.title} — ${record.status} (iterations=${record.iterations} tools=${record.toolCalls})`,
    );
  });

  lines.push('', 'verifications:');
  if (task.verifications.length === 0) {
    lines.push('  (none)');
  }
  task.verifications.forEach((result, index) => {
    const exit = result.exitCode === null ? 'n/a' : String(result.exitCode);
    lines.push(
      `  ${index + 1}. ${result.status} (attempt=${result.attempt}, exit=${exit}, ${result.durationMs}ms)`,
    );
    if (result.reason !== undefined) {
      lines.push(`     reason: ${result.reason}`);
    }
    if (result.status !== 'passed' && result.output !== '') {
      lines.push('     output:');
      lines.push(indentTail(result.output, VERIFICATION_OUTPUT_TAIL_CHARS));
    }
  });

  lines.push('', 'diffs:');
  if (task.diffs.length === 0) {
    lines.push('  (none)');
  }
  task.diffs.forEach((diff, index) => {
    lines.push(`  ${index + 1}. ${describeDiff(diff)}`);
  });

  return `${lines.join('\n')}\n`;
}

function describeVerify(task: TaskRecord): string {
  if (task.verifyCommand === undefined) {
    return 'disabled';
  }
  return task.verifyAutoSkip ? `${task.verifyCommand} (auto-skip)` : task.verifyCommand;
}

function describeDiff(diff: TaskRecord['diffs'][number]): string {
  if (!diff.available) {
    return `unavailable (${diff.reason ?? 'unknown'})`;
  }
  return `${diff.files.length} files, +${diff.totalInsertions} -${diff.totalDeletions}`;
}

const VERIFICATION_OUTPUT_TAIL_CHARS = 1200;

function indentTail(text: string, max: number): string {
  const trimmed = text.trim();
  const tail = trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
  return tail
    .split('\n')
    .map((line) => `       ${line}`)
    .join('\n');
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
}
