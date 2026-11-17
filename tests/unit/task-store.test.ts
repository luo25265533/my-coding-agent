import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskStore } from '../../src/memory/index.js';
import type { TaskRecord, TaskStepRecord, TaskStore } from '../../src/memory/types.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import type { AgentStopReason } from '../../src/shared/agent-stop.js';
import type { PlanStep, TaskPlan } from '../../src/shared/plan.js';
import type { DiffSummary, RepairRecord, VerificationResult } from '../../src/shared/reports.js';
import type { TokenUsage } from '../../src/shared/token-usage.js';

const require = createRequire(import.meta.url);
let sql: SqlJsStatic | undefined;

async function loadRawSql(): Promise<SqlJsStatic> {
  sql ??= await initSqlJs({
    locateFile: () => path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm'),
  });
  return sql;
}

async function rawQuery(dbPath: string, query: string): Promise<unknown[][]> {
  const SQL = await loadRawSql();
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    return db.exec(query)[0]?.values ?? [];
  } finally {
    db.close();
  }
}

async function rawExec(dbPath: string, statement: string): Promise<void> {
  const SQL = await loadRawSql();
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    db.exec(statement);
    writeFileSync(dbPath, db.export());
  } finally {
    db.close();
  }
}

let workspace: string;
let stores: TaskStore[];

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-task-store-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) {
    await store.close().catch(() => undefined);
  }
  rmSync(workspace, { recursive: true, force: true });
});

function dbPath(): string {
  return path.join('.agent', 'tasks.db');
}

function absoluteDbPath(): string {
  return path.join(workspace, '.agent', 'tasks.db');
}

async function openStore(options: { readOnly?: boolean } = {}): Promise<TaskStore> {
  const store = await createTaskStore({
    workspace,
    dbPath: dbPath(),
    readOnly: options.readOnly ?? false,
  });
  stores.push(store);
  return store;
}

function makePlan(goal = 'demo'): TaskPlan {
  return {
    goal,
    steps: [
      { id: 's1', title: 'first', description: 'do first', files: ['src/a.ts'] },
      { id: 's2', title: 'second', description: 'do second', files: [] },
    ],
    notes: undefined,
  };
}

async function createTask(store: TaskStore, goal = 'demo'): Promise<TaskRecord> {
  return store.createTask({
    goal,
    plan: makePlan(goal),
    workspace,
    verifyCommand: 'pnpm test',
    verifyAutoSkip: true,
    baselineDiff: undefined,
  });
}

const usage: TokenUsage = {
  promptTokens: 7,
  completionTokens: 3,
  totalTokens: 10,
  reasoningTokens: 1,
  cachedTokens: 0,
};

function makeStepResult(
  task: TaskRecord,
  index: number,
  status: 'completed' | 'failed',
  patch: {
    answer?: string;
    iterations?: number;
    toolCalls?: number;
    stopReason?: AgentStopReason;
    startedAt?: number;
    finishedAt?: number;
    step?: PlanStep;
  } = {},
): TaskStepRecord {
  const saved = task.steps[index];
  if (saved === undefined) {
    throw new Error(`missing step ${index}`);
  }
  return {
    index,
    step: patch.step ?? saved.step,
    status,
    answer: patch.answer ?? `answer-${index}`,
    iterations: patch.iterations ?? 2,
    toolCalls: patch.toolCalls ?? 1,
    usage,
    stopReason: patch.stopReason ?? (status === 'completed' ? 'answer' : 'max_iterations'),
    startedAt: patch.startedAt ?? 100,
    finishedAt: patch.finishedAt ?? 200,
  };
}

const diff: DiffSummary = {
  available: true,
  reason: undefined,
  files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
  totalInsertions: 2,
  totalDeletions: 1,
  truncated: false,
};

const passed: VerificationResult = {
  status: 'passed',
  command: 'pnpm test',
  attempt: 1,
  exitCode: 0,
  timedOut: false,
  durationMs: 1200,
  output: 'ok',
  reason: undefined,
};

const failed: VerificationResult = {
  status: 'failed',
  command: 'pnpm test',
  attempt: 1,
  exitCode: 1,
  timedOut: false,
  durationMs: 900,
  output: '1 test failed',
  reason: undefined,
};

const repair: RepairRecord = {
  answer: 'fixed the failing test',
  stopReason: 'answer',
  iterations: 3,
  toolCalls: 2,
  usage,
};

async function expectError(promise: Promise<unknown>, code: ErrorCode): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    const agentError = error as AgentError;
    expect(agentError.code).toBe(code);
    return agentError;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe('TaskStore 初始化与 schema', () => {
  it('创建目录与数据库文件，user_version=1，重复打开幂等', async () => {
    const store = await openStore();
    expect(existsSync(store.path)).toBe(true);
    const version = await rawQuery(store.path, 'PRAGMA user_version');
    expect(version[0]?.[0]).toBe(1);
    expect(await store.listTasks()).toEqual([]);

    await store.close();
    const reopened = await openStore();
    expect(reopened.path).toBe(store.path);
    expect(await reopened.listTasks()).toEqual([]);
  });

  it('路径越界、.git 与敏感文件名均拒绝', async () => {
    await expectError(
      createTaskStore({ workspace, dbPath: '../outside.db' }),
      ErrorCode.PathDenied,
    );
    await expectError(
      createTaskStore({ workspace, dbPath: '.git/tasks.db' }),
      ErrorCode.PathDenied,
    );
    await expectError(createTaskStore({ workspace, dbPath: '.env' }), ErrorCode.PathDenied);
  });

  it('损坏的数据库文件抛出 TaskStorage 且不覆盖原文件', async () => {
    const absolute = absoluteDbPath();
    mkdirSync(path.dirname(absolute), { recursive: true });
    const garbage = Buffer.from('this is definitely not a sqlite database');
    writeFileSync(absolute, garbage);

    await expectError(createTaskStore({ workspace, dbPath: dbPath() }), ErrorCode.TaskStorage);
    expect(readFileSync(absolute).equals(garbage)).toBe(true);
    expect(existsSync(`${absolute}.lock`)).toBe(false);
  });

  it('不支持的 schema 版本直接拒绝', async () => {
    const store = await openStore();
    await store.close();
    await rawExec(store.path, 'PRAGMA user_version = 99');

    await expectError(createTaskStore({ workspace, dbPath: dbPath() }), ErrorCode.TaskStorage);
  });
});

describe('TaskStore 任务生命周期', () => {
  it('创建、读取、列表与文本原样存储', async () => {
    const store = await openStore();
    const goal = `他说："你好" 😀 'quoted'`;
    const task = await createTask(store, goal);

    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.status).toBe('planned');
    expect(task.workspace).toBe(workspace);
    expect(task.goal).toBe(goal);
    expect(task.verifyCommand).toBe('pnpm test');
    expect(task.verifyAutoSkip).toBe(true);
    expect(task.steps).toHaveLength(2);
    expect(task.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
    expect(task.steps[0]?.step.id).toBe('s1');

    const loaded = await store.getTask(task.id);
    expect(loaded?.goal).toBe(goal);
    expect((await store.listTasks())[0]).toMatchObject({
      id: task.id,
      goal,
      status: 'planned',
      stepCount: 2,
      completedSteps: 0,
      repairAttempts: 0,
    });
  });

  it('非法迁移被拒绝且不改变状态', async () => {
    const store = await openStore();
    const task = await createTask(store);

    const error = await expectError(store.transition(task.id, 'completed'), ErrorCode.TaskStorage);
    expect(error.message).toContain('planned -> completed');
    expect((await store.getTask(task.id))?.status).toBe('planned');
  });

  it('完整状态链 planned → running → verifying → repairing → completed', async () => {
    const store = await openStore();
    const task = await createTask(store);

    await store.transition(task.id, 'running');
    await store.transition(task.id, 'verifying');
    await store.transition(task.id, 'repairing');
    await store.transition(task.id, 'verifying');
    await store.transition(task.id, 'completed');

    expect((await store.getTask(task.id))?.status).toBe('completed');
    await expectError(store.transition(task.id, 'running'), ErrorCode.TaskStorage);
  });

  it('markResumed 累加恢复次数且不改变状态', async () => {
    const store = await openStore();
    const task = await createTask(store);
    await store.transition(task.id, 'running');

    await store.markResumed(task.id);
    await store.markResumed(task.id);

    const loaded = await store.getTask(task.id);
    expect(loaded?.status).toBe('running');
    expect(loaded?.resumeCount).toBe(2);
    const rows = await rawQuery(
      absoluteDbPath(),
      `SELECT COUNT(*) FROM task_events WHERE task_id = '${task.id}' AND type = 'resumed'`,
    );
    expect(rows[0]?.[0]).toBe(2);
  });

  it('未知任务与非法 ID 返回 not found', async () => {
    const store = await openStore();
    const unknown = '00000000-0000-4000-8000-000000000000';

    expect(await store.getTask(unknown)).toBeUndefined();
    expect(await store.getTask('not-a-uuid')).toBeUndefined();
    await expectError(store.transition(unknown, 'running'), ErrorCode.TaskNotFound);
    await expectError(store.transition('not-a-uuid', 'running'), ErrorCode.TaskNotFound);
  });

  it('workspace 不一致时拒绝创建任务', async () => {
    const store = await openStore();
    await expectError(
      store.createTask({
        goal: 'demo',
        plan: makePlan(),
        workspace: path.join(workspace, 'other'),
        verifyCommand: undefined,
        verifyAutoSkip: false,
        baselineDiff: undefined,
      }),
      ErrorCode.TaskInvalid,
    );
  });

  it('关闭后拒绝访问，close 幂等且释放锁', async () => {
    const store = await openStore();
    const lockPath = `${store.path}.lock`;
    expect(existsSync(lockPath)).toBe(true);

    await store.close();
    await store.close();
    expect(existsSync(lockPath)).toBe(false);
    await expectError(store.listTasks(), ErrorCode.TaskStorage);
  });
});

describe('TaskStore 步骤与结果', () => {
  it('running 步骤可重启并重置上次进度', async () => {
    const store = await openStore();
    const task = await createTask(store);

    await store.startStep(task.id, 0);
    await store.startStep(task.id, 0);

    const loaded = await store.getTask(task.id);
    expect(loaded?.steps[0]?.status).toBe('running');
    expect(loaded?.steps[0]?.answer).toBe('');
    expect(loaded?.steps[0]?.usage.totalTokens).toBe(0);
  });

  it('步骤失败后可从 failed 重置并重跑', async () => {
    const store = await openStore();
    const task = await createTask(store);
    await store.transition(task.id, 'running');

    await store.startStep(task.id, 0);
    await store.finishStep(task.id, makeStepResult(task, 0, 'failed'));
    let loaded = await store.getTask(task.id);
    expect(loaded?.steps[0]?.status).toBe('failed');
    expect(loaded?.steps[0]?.answer).toBe('answer-0');

    await store.startStep(task.id, 0);
    loaded = await store.getTask(task.id);
    expect(loaded?.steps[0]?.status).toBe('running');
    expect(loaded?.steps[0]?.answer).toBe('');
    expect(loaded?.steps[0]?.usage.totalTokens).toBe(0);

    await store.finishStep(
      task.id,
      makeStepResult(task, 0, 'completed', { answer: 'retried', startedAt: 300, finishedAt: 400 }),
    );
    loaded = await store.getTask(task.id);
    expect(loaded?.steps[0]).toMatchObject({
      status: 'completed',
      answer: 'retried',
      iterations: 2,
      toolCalls: 1,
      stopReason: 'answer',
      finishedAt: 400,
    });
    expect(typeof loaded?.steps[0]?.startedAt).toBe('number');
    expect(loaded?.steps[0]?.usage).toEqual(usage);
  });

  it('非法步骤操作被拒绝', async () => {
    const store = await openStore();
    const task = await createTask(store);

    await expectError(store.startStep(task.id, 5), ErrorCode.TaskInvalid);
    await expectError(
      store.finishStep(task.id, makeStepResult(task, 0, 'completed')),
      ErrorCode.TaskStorage,
    );

    await store.startStep(task.id, 0);
    await expectError(
      store.finishStep(
        task.id,
        makeStepResult(task, 0, 'completed', {
          step: { id: 'other', title: 'other', description: 'other', files: [] },
        }),
      ),
      ErrorCode.TaskInvalid,
    );

    await store.finishStep(task.id, makeStepResult(task, 0, 'completed'));
    await expectError(store.startStep(task.id, 0), ErrorCode.TaskStorage);
  });

  it('步骤、验证、差异、修复与事件全部落库并在重开后保留', async () => {
    const store = await openStore();
    const task = await createTask(store);
    const dbFile = store.path;

    await store.transition(task.id, 'running');
    await store.startStep(task.id, 0);
    await store.finishStep(task.id, makeStepResult(task, 0, 'completed'));
    await store.setBaselineDiff(task.id, diff);
    await store.recordVerification(task.id, passed);
    await store.recordVerification(task.id, failed);
    await store.recordDiff(task.id, diff);
    await store.recordRepair(task.id, 1, repair);
    await store.recordRepair(task.id, 2, repair);
    await store.recordRepair(task.id, 1, repair);
    await store.appendEvent(task.id, 'custom', { hello: '世界' });
    await store.close();

    const reopened = await openStore();
    const loaded = await reopened.getTask(task.id);
    expect(loaded?.status).toBe('running');
    expect(loaded?.steps[0]?.status).toBe('completed');
    expect(loaded?.baselineDiff).toEqual(diff);
    expect(loaded?.verifications.map((item) => item.status)).toEqual(['passed', 'failed']);
    expect(loaded?.verifications[1]).toMatchObject({ exitCode: 1, output: '1 test failed' });
    expect(loaded?.diffs).toHaveLength(1);
    expect(loaded?.repairAttempts).toBe(2);

    const events = await rawQuery(
      dbFile,
      `SELECT type FROM task_events WHERE task_id = '${task.id}' ORDER BY id`,
    );
    const types = events.map((row) => row[0]);
    expect(types).toContain('created');
    expect(types).toContain('verification');
    expect(types).toContain('repair');
    expect(types).toContain('custom');
  });

  it('appendEvent 拒绝空类型，列表 limit 校验', async () => {
    const store = await openStore();
    const task = await createTask(store);

    await expectError(store.appendEvent(task.id, '  '), ErrorCode.TaskInvalid);
    await expectError(store.listTasks(0), ErrorCode.TaskInvalid);
    await expectError(store.listTasks(1001), ErrorCode.TaskInvalid);
  });

  it('并发写操作串行化并全部持久化', async () => {
    const store = await openStore();
    const task = await createTask(store);
    await Promise.all([
      store.appendEvent(task.id, 'parallel-a'),
      store.appendEvent(task.id, 'parallel-b'),
    ]);

    const rows = await rawQuery(
      store.path,
      `SELECT COUNT(*) FROM task_events WHERE task_id = '${task.id}' AND type IN ('parallel-a', 'parallel-b')`,
    );
    expect(rows[0]?.[0]).toBe(2);
  });

  it('损坏的 plan_json 在读取时抛出 TaskStorage', async () => {
    const store = await openStore();
    const task = await createTask(store);
    const dbFile = store.path;
    await store.close();

    await rawExec(dbFile, `UPDATE tasks SET plan_json = '{"goal":"x","steps":[]}'`);
    const reopened = await openStore();
    await expectError(reopened.getTask(task.id), ErrorCode.TaskStorage);
  });
});

describe('TaskStore 单写者锁与只读模式', () => {
  it('第二个写实例被拒绝，释放后可重新打开', async () => {
    const store = await openStore();
    await expectError(createTaskStore({ workspace, dbPath: dbPath() }), ErrorCode.TaskStorage);

    await store.close();
    const reopened = await openStore();
    expect(await reopened.listTasks()).toEqual([]);
  });

  it('清理已退出进程留下的陈旧锁', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) {
      throw new Error('failed to spawn helper process');
    }
    mkdirSync(path.dirname(absoluteDbPath()), { recursive: true });
    writeFileSync(
      `${absoluteDbPath()}.lock`,
      JSON.stringify({ pid: child.pid, startedAt: Date.now() }),
      'utf8',
    );

    const store = await openStore();
    expect(existsSync(store.path)).toBe(true);
    expect(await store.listTasks()).toEqual([]);
  });

  it('只读模式不获取写锁，写操作被拒绝', async () => {
    const writer = await openStore();
    const task = await createTask(writer);
    const reader = await openStore({ readOnly: true });

    expect((await reader.getTask(task.id))?.id).toBe(task.id);
    await expectError(reader.transition(task.id, 'running'), ErrorCode.TaskStorage);
    await expectError(createTaskStore({ workspace, dbPath: dbPath() }), ErrorCode.TaskStorage);
  });
});
