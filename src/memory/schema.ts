import type { Database } from 'sql.js';
import { z } from 'zod';
import { AGENT_STOP_REASONS, type AgentStopReason } from '../shared/agent-stop.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import type { TaskPlan } from '../shared/plan.js';
import type {
  DiffSummary,
  RepairRecord,
  VerificationResult,
  VerificationStatus,
} from '../shared/reports.js';
import { EMPTY_USAGE, type TokenUsage } from '../shared/token-usage.js';
import { STEP_STATUSES, TASK_STATUSES, type StepStatus, type TaskStatus } from './types.js';

export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  verify_command TEXT,
  verify_auto_skip INTEGER NOT NULL DEFAULT 0,
  baseline_diff_json TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_steps (
  task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  stop_reason TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (task_id, step_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE task_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE task_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  available INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX idx_steps_task ON task_steps(task_id, step_index);
`;

const REQUIRED_TABLES = [
  'tasks',
  'task_steps',
  'task_verifications',
  'task_diffs',
  'task_events',
] as const;

const taskStatusSchema = z.enum(TASK_STATUSES);
const stepStatusSchema = z.enum(STEP_STATUSES);
const verificationStatusSchema = z.enum(['passed', 'failed', 'skipped']);

const planStepSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string(),
  description: z.string(),
  files: z.array(z.string()),
});

const taskPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(planStepSchema).min(1),
  notes: z.string().optional(),
});

const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
});

const diffFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'untracked', 'other']),
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});

const diffSummarySchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  files: z.array(diffFileSchema),
  totalInsertions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const verificationSchema = z.object({
  status: verificationStatusSchema,
  command: z.string(),
  attempt: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  output: z.string(),
  reason: z.string().optional(),
});

const repairSchema = z.object({
  answer: z.string(),
  stopReason: z.enum(AGENT_STOP_REASONS),
  iterations: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  usage: usageSchema,
});

function storageError(message: string, cause?: unknown): AgentError {
  return new AgentError(
    ErrorCode.TaskStorage,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function readSchemaVersion(db: Database): number {
  let result;
  try {
    result = db.exec('PRAGMA user_version');
  } catch (error) {
    throw storageError('failed to read task store schema version', error);
  }
  const value = result[0]?.values[0]?.[0];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw storageError('failed to read task store schema version');
  }
  return value;
}

export function migrateSchema(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA_DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务可能已因底层错误失效
    }
    throw storageError('failed to migrate task store schema', error);
  }
}

export function assertIntegrity(db: Database): void {
  let result;
  try {
    result = db.exec('PRAGMA integrity_check');
  } catch (error) {
    throw storageError('task store integrity check failed', error);
  }
  const value = result[0]?.values[0]?.[0];
  if (value !== 'ok') {
    throw storageError(`task store integrity check failed: ${String(value)}`);
  }
}

export function assertRequiredTables(db: Database): void {
  let result;
  try {
    result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
  } catch (error) {
    throw storageError('failed to read task store schema', error);
  }
  const names = new Set<string>();
  for (const row of result[0]?.values ?? []) {
    const value = row[0];
    if (typeof value === 'string') {
      names.add(value);
    }
  }
  for (const table of REQUIRED_TABLES) {
    if (!names.has(table)) {
      throw storageError(`task store schema is missing table: ${table}`);
    }
  }
}

export function parseTaskStatus(value: unknown): TaskStatus {
  const parsed = taskStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw storageError(`invalid stored task status: ${String(value)}`);
  }
  return parsed.data;
}

export function parseStepStatus(value: unknown): StepStatus {
  const parsed = stepStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw storageError(`invalid stored step status: ${String(value)}`);
  }
  return parsed.data;
}

export function parseVerificationStatus(value: unknown): VerificationStatus {
  const parsed = verificationStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw storageError(`invalid stored verification status: ${String(value)}`);
  }
  return parsed.data;
}

export function parseStopReason(value: string | null): AgentStopReason | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = z.enum(AGENT_STOP_REASONS).safeParse(value);
  if (!parsed.success) {
    throw storageError(`invalid stored stop reason: ${value}`);
  }
  return parsed.data;
}

export function parseTaskPlan(input: unknown): TaskPlan {
  const parsed = taskPlanSchema.parse(input);
  return { goal: parsed.goal, steps: parsed.steps, notes: parsed.notes };
}

export function parseStoredPlan(json: string): TaskPlan {
  try {
    return parseTaskPlan(JSON.parse(json));
  } catch (error) {
    throw storageError('invalid stored task plan', error);
  }
}

export function parseUsage(input: unknown): TokenUsage {
  return usageSchema.parse(input);
}

export function parseStoredUsage(json: string | null): TokenUsage {
  if (json === null) {
    return EMPTY_USAGE;
  }
  try {
    return parseUsage(JSON.parse(json));
  } catch (error) {
    throw storageError('invalid stored token usage', error);
  }
}

export function parseDiffSummary(input: unknown): DiffSummary {
  const parsed = diffSummarySchema.parse(input);
  return {
    available: parsed.available,
    reason: parsed.reason,
    files: parsed.files,
    totalInsertions: parsed.totalInsertions,
    totalDeletions: parsed.totalDeletions,
    truncated: parsed.truncated,
  };
}

export function parseStoredDiff(json: string): DiffSummary {
  try {
    return parseDiffSummary(JSON.parse(json));
  } catch (error) {
    throw storageError('invalid stored diff summary', error);
  }
}

export function parseVerification(input: unknown): VerificationResult {
  const parsed = verificationSchema.parse(input);
  return {
    status: parsed.status,
    command: parsed.command,
    attempt: parsed.attempt,
    exitCode: parsed.exitCode,
    timedOut: parsed.timedOut,
    durationMs: parsed.durationMs,
    output: parsed.output,
    reason: parsed.reason,
  };
}

export function parseRepairRecord(input: unknown): RepairRecord {
  const parsed = repairSchema.parse(input);
  return {
    answer: parsed.answer,
    stopReason: parsed.stopReason,
    iterations: parsed.iterations,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
  };
}
