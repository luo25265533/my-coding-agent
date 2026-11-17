import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs, {
  type BindParams,
  type Database,
  type ParamsObject,
  type SqlJsStatic,
} from 'sql.js';
import { ZodError } from 'zod';
import { assertNotSensitive, resolveForWrite } from '../security/path-guard.js';
import { atomicWriteFile } from '../shared/atomic-write.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import type { TaskPlan } from '../shared/plan.js';
import type { DiffSummary, RepairRecord, VerificationResult } from '../shared/reports.js';
import type { TokenUsage } from '../shared/token-usage.js';
import {
  SCHEMA_VERSION,
  assertIntegrity,
  assertRequiredTables,
  migrateSchema,
  parseDiffSummary,
  parseRepairRecord,
  parseStepStatus,
  parseStopReason,
  parseStoredDiff,
  parseStoredPlan,
  parseStoredUsage,
  parseTaskPlan,
  parseTaskStatus,
  parseUsage,
  parseVerification,
  parseVerificationStatus,
  readSchemaVersion,
} from './schema.js';
import { assertStepTransition, assertTransition } from './state.js';
import type {
  CreateTaskInput,
  TaskRecord,
  TaskStatus,
  TaskStepRecord,
  TaskStore,
  TaskStoreOptions,
  TaskSummary,
  TransitionPatch,
} from './types.js';

const require = createRequire(import.meta.url);

let sqlPromise: Promise<SqlJsStatic> | undefined;

function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: () => path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm'),
  });
  return sqlPromise;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTaskId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function storageError(message: string, cause?: unknown): AgentError {
  return new AgentError(
    ErrorCode.TaskStorage,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function invalidTask(message: string): AgentError {
  return new AgentError(ErrorCode.TaskInvalid, message);
}

function notFound(id: string): AgentError {
  return new AgentError(ErrorCode.TaskNotFound, `task not found: ${id}`);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function rowValue(row: ParamsObject, key: string): unknown {
  return row[key];
}

function rowText(row: ParamsObject, key: string): string {
  const value = rowValue(row, key);
  if (typeof value !== 'string') {
    throw storageError(`invalid task store column: ${key}`);
  }
  return value;
}

function rowNullableText(row: ParamsObject, key: string): string | null {
  const value = rowValue(row, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw storageError(`invalid task store column: ${key}`);
  }
  return value;
}

function rowNumber(row: ParamsObject, key: string): number {
  const value = rowValue(row, key);
  if (typeof value !== 'number') {
    throw storageError(`invalid task store column: ${key}`);
  }
  return value;
}

function rowNullableNumber(row: ParamsObject, key: string): number | null {
  const value = rowValue(row, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw storageError(`invalid task store column: ${key}`);
  }
  return value;
}

async function persistDatabase(db: Database, dbPath: string): Promise<void> {
  const bytes = db.export();
  try {
    await atomicWriteFile(dbPath, bytes);
  } catch (error) {
    throw storageError(`failed to persist task store: ${dbPath}`, error);
  }
}

function openDatabase(SQL: SqlJsStatic, bytes: Uint8Array | undefined, dbPath: string): Database {
  let database: Database;
  try {
    database = bytes === undefined ? new SQL.Database() : new SQL.Database(bytes);
  } catch (error) {
    throw storageError(`failed to open task store: ${dbPath}`, error);
  }
  try {
    database.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    database.close();
    throw storageError(`failed to open task store: ${dbPath}`, error);
  }
  return database;
}

interface LockOwner {
  readonly pid: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限发送信号；ESRCH 才是已退出
    return errnoCode(error) === 'EPERM';
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined;
    }
    throw storageError(`failed to read task store lock: ${lockPath}`, error);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    return { pid };
  } catch {
    return undefined;
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const owner = { pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(owner), 'utf8');
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw storageError(`failed to create task store lock: ${lockPath}`, error);
      }
    }

    const previous = await readLockOwner(lockPath);
    if (previous === undefined) {
      // 锁可能刚被释放或尚未写完，重试一次
      continue;
    }
    if (isProcessAlive(previous.pid)) {
      throw storageError(`task store is locked by pid ${previous.pid}`);
    }
    await rm(lockPath, { force: true });
  }
  throw storageError(`task store is locked: ${lockPath}`);
}

async function releaseLock(lockPath: string | undefined): Promise<void> {
  if (lockPath === undefined) {
    return;
  }
  await rm(lockPath, { force: true }).catch(() => undefined);
}

class SqliteTaskStore implements TaskStore {
  readonly path: string;

  private readonly db: Database;
  private readonly workspace: string;
  private readonly readOnly: boolean;
  private readonly lockPath: string | undefined;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    db: Database,
    dbPath: string,
    workspace: string,
    readOnly: boolean,
    lockPath: string | undefined,
  ) {
    this.db = db;
    this.path = dbPath;
    this.workspace = workspace;
    this.readOnly = readOnly;
    this.lockPath = lockPath;
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return this.exclusive(async () => {
      this.ensureWritable();
      if (input.goal.trim() === '') {
        throw invalidTask('task goal must not be empty');
      }
      if (path.resolve(input.workspace) !== this.workspace) {
        throw invalidTask('task workspace does not match task store workspace');
      }
      const plan = this.normalizePlan(input.plan);
      const baselineDiff =
        input.baselineDiff === undefined ? undefined : this.normalizeDiff(input.baselineDiff);
      const id = randomUUID();
      const now = Date.now();

      this.write(() => {
        this.db.run(
          `INSERT INTO tasks (
             id, goal, workspace, status, plan_json, verify_command, verify_auto_skip,
             baseline_diff_json, repair_attempts, resume_count, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.goal,
            this.workspace,
            'planned',
            JSON.stringify(plan),
            input.verifyCommand ?? null,
            input.verifyAutoSkip ? 1 : 0,
            baselineDiff === undefined ? null : JSON.stringify(baselineDiff),
            0,
            0,
            null,
            now,
            now,
          ],
        );
        plan.steps.forEach((step, index) => {
          this.db.run(
            "INSERT INTO task_steps (task_id, step_index, step_id, status) VALUES (?, ?, ?, 'pending')",
            [id, index, step.id],
          );
        });
        this.insertEvent(id, 'created', { steps: plan.steps.length }, now);
      });

      await this.persist();
      const task = this.readTask(id);
      if (task === undefined) {
        throw storageError('created task could not be read back');
      }
      return task;
    });
  }

  getTask(id: string): Promise<TaskRecord | undefined> {
    return this.exclusive(() => {
      this.ensureOpen();
      if (!isTaskId(id)) {
        return undefined;
      }
      return this.readTask(id);
    });
  }

  listTasks(limit = 20): Promise<readonly TaskSummary[]> {
    return this.exclusive(() => {
      this.ensureOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw invalidTask(`invalid task list limit: ${limit}`);
      }
      const rows = this.queryAll(
        `SELECT
           t.id, t.goal, t.status, t.repair_attempts, t.updated_at, t.error,
           (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
           (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id AND s.status = 'completed')
             AS completed_steps
         FROM tasks t
         ORDER BY t.updated_at DESC
         LIMIT ?`,
        [limit],
      );
      return rows.map((row) => ({
        id: rowText(row, 'id'),
        goal: rowText(row, 'goal'),
        status: parseTaskStatus(rowValue(row, 'status')),
        stepCount: rowNumber(row, 'step_count'),
        completedSteps: rowNumber(row, 'completed_steps'),
        repairAttempts: rowNumber(row, 'repair_attempts'),
        updatedAt: rowNumber(row, 'updated_at'),
        error: rowNullableText(row, 'error') ?? undefined,
      }));
    });
  }

  async transition(id: string, to: TaskStatus, patch?: TransitionPatch): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      const current = this.requireTaskState(id);
      assertTransition(current.status, to);
      const now = Date.now();

      this.write(() => {
        if (patch !== undefined && patch.error !== undefined) {
          this.db.run('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
            to,
            patch.error,
            now,
            id,
          ]);
        } else {
          this.db.run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', [to, now, id]);
        }
        this.insertEvent(id, 'status', { from: current.status, to }, now);
      });

      await this.persist();
    });
  }

  async markResumed(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      const current = this.requireTaskState(id);
      const now = Date.now();

      this.write(() => {
        this.db.run(
          'UPDATE tasks SET resume_count = resume_count + 1, updated_at = ? WHERE id = ?',
          [now, id],
        );
        this.insertEvent(id, 'resumed', { status: current.status }, now);
      });

      await this.persist();
    });
  }

  async startStep(id: string, index: number): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.assertStepIndex(index);
      this.requireTaskState(id);
      const row = this.queryOne(
        'SELECT status, step_id FROM task_steps WHERE task_id = ? AND step_index = ?',
        [id, index],
      );
      if (row === undefined) {
        throw invalidTask(`step index out of range: ${index}`);
      }
      const current = parseStepStatus(rowValue(row, 'status'));
      if (current !== 'running') {
        assertStepTransition(current, 'running');
      }
      const now = Date.now();

      this.write(() => {
        this.db.run(
          `UPDATE task_steps SET
             status = 'running', answer = '', iterations = 0, tool_calls = 0,
             usage_json = NULL, stop_reason = NULL, started_at = ?, finished_at = NULL
           WHERE task_id = ? AND step_index = ?`,
          [now, id, index],
        );
        this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, id]);
        this.insertEvent(id, 'step_started', { index, resumed: current !== 'pending' }, now);
      });

      await this.persist();
    });
  }

  async finishStep(id: string, result: TaskStepRecord): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.assertStepIndex(result.index);
      if (result.status !== 'completed' && result.status !== 'failed') {
        throw invalidTask(`invalid final step status: ${result.status}`);
      }
      const usage = this.normalizeUsage(result.usage);
      this.assertNonNegativeInteger(result.iterations, 'step iterations');
      this.assertNonNegativeInteger(result.toolCalls, 'step tool calls');

      this.requireTaskState(id);
      const row = this.queryOne(
        'SELECT status, step_id FROM task_steps WHERE task_id = ? AND step_index = ?',
        [id, result.index],
      );
      if (row === undefined) {
        throw invalidTask(`step index out of range: ${result.index}`);
      }
      if (rowText(row, 'step_id') !== result.step.id) {
        throw invalidTask('step id does not match stored plan');
      }
      const current = parseStepStatus(rowValue(row, 'status'));
      assertStepTransition(current, result.status);
      const now = Date.now();
      const stopReason =
        result.stopReason === undefined ? null : parseStopReason(result.stopReason);

      this.write(() => {
        this.db.run(
          `UPDATE task_steps SET
             status = ?, answer = ?, iterations = ?, tool_calls = ?,
             usage_json = ?, stop_reason = ?, finished_at = ?
           WHERE task_id = ? AND step_index = ?`,
          [
            result.status,
            result.answer,
            result.iterations,
            result.toolCalls,
            JSON.stringify(usage),
            stopReason ?? null,
            result.finishedAt ?? now,
            id,
            result.index,
          ],
        );
        this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, id]);
        this.insertEvent(
          id,
          'step_finished',
          {
            index: result.index,
            status: result.status,
            stopReason: result.stopReason ?? null,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
          },
          now,
        );
      });

      await this.persist();
    });
  }

  async setBaselineDiff(id: string, diff: DiffSummary): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.requireTaskState(id);
      const normalized = this.normalizeDiff(diff);
      const now = Date.now();

      this.write(() => {
        this.db.run('UPDATE tasks SET baseline_diff_json = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify(normalized),
          now,
          id,
        ]);
        this.insertEvent(id, 'baseline_diff', { files: normalized.files.length }, now);
      });

      await this.persist();
    });
  }

  async recordVerification(id: string, result: VerificationResult): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.requireTaskState(id);
      const normalized = this.normalizeVerification(result);
      const now = Date.now();

      this.write(() => {
        this.db.run(
          `INSERT INTO task_verifications (
             task_id, attempt, command, status, exit_code, timed_out,
             duration_ms, output, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            normalized.attempt,
            normalized.command,
            normalized.status,
            normalized.exitCode,
            normalized.timedOut ? 1 : 0,
            normalized.durationMs,
            normalized.output,
            normalized.reason ?? null,
            now,
          ],
        );
        this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, id]);
        this.insertEvent(
          id,
          'verification',
          {
            attempt: normalized.attempt,
            status: normalized.status,
            exitCode: normalized.exitCode,
            timedOut: normalized.timedOut,
            durationMs: normalized.durationMs,
          },
          now,
        );
      });

      await this.persist();
    });
  }

  async recordDiff(id: string, diff: DiffSummary): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.requireTaskState(id);
      const normalized = this.normalizeDiff(diff);
      const now = Date.now();

      this.write(() => {
        this.db.run(
          `INSERT INTO task_diffs (task_id, attempt, available, summary_json, created_at)
           VALUES (
             ?,
             (SELECT COALESCE(MAX(attempt), 0) + 1 FROM task_diffs WHERE task_id = ?),
             ?, ?, ?
           )`,
          [id, id, normalized.available ? 1 : 0, JSON.stringify(normalized), now],
        );
        this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, id]);
        this.insertEvent(
          id,
          'diff',
          {
            available: normalized.available,
            files: normalized.files.length,
            insertions: normalized.totalInsertions,
            deletions: normalized.totalDeletions,
          },
          now,
        );
      });

      await this.persist();
    });
  }

  async recordRepair(id: string, attempt: number, payload: RepairRecord): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      this.assertNonNegativeInteger(attempt, 'repair attempt');
      if (attempt < 1) {
        throw invalidTask(`invalid repair attempt: ${attempt}`);
      }
      this.requireTaskState(id);
      const normalized = this.normalizeRepair(payload);
      const now = Date.now();

      this.write(() => {
        this.db.run(
          `UPDATE tasks SET
             repair_attempts = CASE WHEN repair_attempts < ? THEN ? ELSE repair_attempts END,
             updated_at = ?
           WHERE id = ?`,
          [attempt, attempt, now, id],
        );
        this.insertEvent(id, 'repair', { attempt, ...normalized }, now);
      });

      await this.persist();
    });
  }

  async appendEvent(id: string, type: string, payload?: unknown): Promise<void> {
    return this.exclusive(async () => {
      this.ensureWritable();
      if (type.trim() === '') {
        throw invalidTask('event type must not be empty');
      }
      this.requireTaskState(id);
      const now = Date.now();

      this.write(() => {
        this.insertEvent(id, type, payload, now);
        this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, id]);
      });

      await this.persist();
    });
  }

  async close(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      try {
        this.db.close();
      } finally {
        await releaseLock(this.lockPath);
      }
    });
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw storageError('task store is closed');
    }
  }

  private ensureWritable(): void {
    this.ensureOpen();
    if (this.readOnly) {
      throw storageError('task store is opened read-only');
    }
  }

  private write<T>(operation: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 底层错误可能已终止事务
      }
      if (error instanceof AgentError) {
        throw error;
      }
      throw storageError('task store transaction failed', error);
    }
  }

  private async persist(): Promise<void> {
    await persistDatabase(this.db, this.path);
  }

  private queryAll(sql: string, params: BindParams): ParamsObject[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: ParamsObject[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private queryOne(sql: string, params: BindParams): ParamsObject | undefined {
    return this.queryAll(sql, params)[0];
  }

  private requireTaskState(id: string): { status: TaskStatus; error: string | null } {
    if (!isTaskId(id)) {
      throw notFound(id);
    }
    const row = this.queryOne('SELECT status, error FROM tasks WHERE id = ?', [id]);
    if (row === undefined) {
      throw notFound(id);
    }
    return {
      status: parseTaskStatus(rowValue(row, 'status')),
      error: rowNullableText(row, 'error'),
    };
  }

  private readTask(id: string): TaskRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id, goal, workspace, status, plan_json, verify_command, verify_auto_skip,
         baseline_diff_json, repair_attempts, resume_count, error, created_at, updated_at
       FROM tasks WHERE id = ?`,
      [id],
    );
    if (row === undefined) {
      return undefined;
    }
    const plan = parseStoredPlan(rowText(row, 'plan_json'));
    const baselineJson = rowNullableText(row, 'baseline_diff_json');
    return {
      id: rowText(row, 'id'),
      goal: rowText(row, 'goal'),
      workspace: rowText(row, 'workspace'),
      status: parseTaskStatus(rowValue(row, 'status')),
      plan,
      verifyCommand: rowNullableText(row, 'verify_command') ?? undefined,
      verifyAutoSkip: rowNumber(row, 'verify_auto_skip') !== 0,
      baselineDiff: baselineJson === null ? undefined : parseStoredDiff(baselineJson),
      repairAttempts: rowNumber(row, 'repair_attempts'),
      resumeCount: rowNumber(row, 'resume_count'),
      error: rowNullableText(row, 'error') ?? undefined,
      createdAt: rowNumber(row, 'created_at'),
      updatedAt: rowNumber(row, 'updated_at'),
      steps: this.readSteps(id, plan),
      verifications: this.readVerifications(id),
      diffs: this.readDiffs(id),
    };
  }

  private readSteps(id: string, plan: TaskPlan): readonly TaskStepRecord[] {
    const rows = this.queryAll(
      `SELECT
         step_index, step_id, status, answer, iterations, tool_calls,
         usage_json, stop_reason, started_at, finished_at
       FROM task_steps WHERE task_id = ? ORDER BY step_index`,
      [id],
    );
    if (rows.length !== plan.steps.length) {
      throw storageError('task step count does not match stored plan');
    }
    return rows.map((row, position) => {
      const index = rowNumber(row, 'step_index');
      if (index !== position) {
        throw storageError('task step indexes are inconsistent');
      }
      const step = plan.steps[position];
      if (step === undefined) {
        throw storageError('task step is missing from stored plan');
      }
      if (rowText(row, 'step_id') !== step.id) {
        throw storageError('task step id does not match stored plan');
      }
      return {
        index,
        step,
        status: parseStepStatus(rowValue(row, 'status')),
        answer: rowText(row, 'answer'),
        iterations: rowNumber(row, 'iterations'),
        toolCalls: rowNumber(row, 'tool_calls'),
        usage: parseStoredUsage(rowNullableText(row, 'usage_json')),
        stopReason: parseStopReason(rowNullableText(row, 'stop_reason')),
        startedAt: rowNullableNumber(row, 'started_at') ?? undefined,
        finishedAt: rowNullableNumber(row, 'finished_at') ?? undefined,
      };
    });
  }

  private readVerifications(id: string): readonly VerificationResult[] {
    const rows = this.queryAll(
      `SELECT
         attempt, command, status, exit_code, timed_out, duration_ms, output, reason
       FROM task_verifications WHERE task_id = ? ORDER BY id`,
      [id],
    );
    return rows.map((row) => ({
      status: parseVerificationStatus(rowValue(row, 'status')),
      command: rowText(row, 'command'),
      attempt: rowNumber(row, 'attempt'),
      exitCode: rowNullableNumber(row, 'exit_code'),
      timedOut: rowNumber(row, 'timed_out') !== 0,
      durationMs: rowNumber(row, 'duration_ms'),
      output: rowText(row, 'output'),
      reason: rowNullableText(row, 'reason') ?? undefined,
    }));
  }

  private readDiffs(id: string): readonly DiffSummary[] {
    const rows = this.queryAll(
      'SELECT summary_json FROM task_diffs WHERE task_id = ? ORDER BY id',
      [id],
    );
    return rows.map((row) => parseStoredDiff(rowText(row, 'summary_json')));
  }

  private insertEvent(id: string, type: string, payload: unknown, now: number): void {
    const json = payload === undefined ? null : (JSON.stringify(payload) ?? null);
    this.db.run('INSERT INTO task_events (task_id, ts, type, payload_json) VALUES (?, ?, ?, ?)', [
      id,
      now,
      type,
      json,
    ]);
  }

  private assertStepIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
      throw invalidTask(`invalid step index: ${index}`);
    }
  }

  private assertNonNegativeInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw invalidTask(`invalid ${label}: ${value}`);
    }
  }

  private normalizePlan(plan: TaskPlan): TaskPlan {
    try {
      return parseTaskPlan(plan);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidTask('invalid task plan');
      }
      throw error;
    }
  }

  private normalizeUsage(usage: TokenUsage): TokenUsage {
    try {
      return parseUsage(usage);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidTask('invalid token usage');
      }
      throw error;
    }
  }

  private normalizeDiff(diff: DiffSummary): DiffSummary {
    try {
      return parseDiffSummary(diff);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidTask('invalid diff summary');
      }
      throw error;
    }
  }

  private normalizeVerification(result: VerificationResult): VerificationResult {
    try {
      return parseVerification(result);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidTask('invalid verification result');
      }
      throw error;
    }
  }

  private normalizeRepair(payload: RepairRecord): RepairRecord {
    try {
      return parseRepairRecord(payload);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidTask('invalid repair record');
      }
      throw error;
    }
  }
}

export async function createTaskStore(options: TaskStoreOptions): Promise<TaskStore> {
  const workspace = path.resolve(options.workspace);
  const dbPath = resolveForWrite(workspace, options.dbPath);
  assertNotSensitive(dbPath);
  const readOnly = options.readOnly === true;
  await mkdir(path.dirname(dbPath), { recursive: true });

  const lockPath = readOnly ? undefined : `${dbPath}.lock`;
  if (lockPath !== undefined) {
    await acquireLock(lockPath);
  }

  let db: Database | undefined;
  try {
    const SQL = await loadSql();
    let bytes: Uint8Array | undefined;
    try {
      bytes = new Uint8Array(await readFile(dbPath));
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        throw storageError(`failed to read task store: ${dbPath}`, error);
      }
    }

    const opened = openDatabase(SQL, bytes, dbPath);
    db = opened;

    const version = readSchemaVersion(opened);
    if (version > SCHEMA_VERSION) {
      throw storageError(
        `unsupported task store schema version ${version} (expected ${SCHEMA_VERSION})`,
      );
    }
    let migrated = false;
    if (version === 0) {
      migrateSchema(opened);
      migrated = true;
    }
    assertIntegrity(opened);
    assertRequiredTables(opened);

    if (!readOnly && (bytes === undefined || migrated)) {
      await persistDatabase(opened, dbPath);
    }
    return new SqliteTaskStore(opened, dbPath, workspace, readOnly, lockPath);
  } catch (error) {
    db?.close();
    await releaseLock(lockPath);
    throw error;
  }
}
