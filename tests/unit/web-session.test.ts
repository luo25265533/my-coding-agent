import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../src/config/load.js';
import { RunSession } from '../../src/web/session.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-web-session-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sessionFor(script: unknown, extraEnv: Record<string, string> = {}): RunSession {
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(script));
  return new RunSession(
    loadConfig({
      env: {
        LLM_PROVIDER: 'mock',
        LLM_API_KEY: '',
        AGENT_WORKSPACE: workspace,
        AGENT_MOCK_SCRIPT: 'script.json',
        ...extraEnv,
      },
      envFilePath: null,
    }),
    pino({ level: 'silent' }),
  );
}

function planScript(): unknown {
  return [{ content: planContentJson() }, ...planScriptBody(), { content: 'done' }];
}

function planContentJson(): string {
  return JSON.stringify({
    goal: '测试',
    steps: [{ id: 's1', title: '读取', description: '读取 note.txt', files: [] }],
    notes: null,
  });
}

function planScriptBody(): unknown[] {
  return [{ toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] }];
}

function waitForSessionStatus(
  session: RunSession,
  status: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'session_status' &&
        (event.data as { status?: string }).status === status
      ) {
        unsubscribe();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for status ${status}`));
    }, timeoutMs);
    void timer.unref();
    if (session.getStatus() === status) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

describe('RunSession 会话状态机', () => {
  it('新会话空闲且无挂起决策', () => {
    const session = sessionFor(planScript());
    expect(session.getStatus()).toBe('idle');
    expect(session.canStart()).toBe(true);
    expect(session.hasPendingPlan()).toBe(false);
    expect(session.hasPendingConfirm()).toBe(false);
    expect(session.snapshot().events).toEqual([]);
    expect(session.decidePlan(true)).toBe(false);
    expect(session.decideConfirm(false)).toBe(false);
    expect(session.abort()).toBe(false);
  });

  it('无 yes 时挂起等待 Plan 决策，decidePlan 后继续执行', async () => {
    const session = sessionFor(planScript());
    session.start({ task: '总结 note.txt', yes: false, noVerify: true, verify: undefined });
    expect(session.canStart()).toBe(false);

    await waitForSessionStatus(session, 'awaiting_plan');
    expect(session.hasPendingPlan()).toBe(true);
    expect(() =>
      session.start({ task: 'second', yes: true, noVerify: true, verify: undefined }),
    ).toThrow('session is busy');
    expect(session.decidePlan(true)).toBe(true);
    expect(session.hasPendingPlan()).toBe(false);

    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    expect(snapshot.status).toBe('finished');
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.events.some((event) => event.type === 'answer')).toBe(true);

    // 完成后可以再次启动；start 会重置缓冲
    expect(session.canStart()).toBe(true);
  });

  it('decidePlan(false) 拒绝后任务结束且无错误', async () => {
    const session = sessionFor(planScript());
    session.start({ task: '总结 note.txt', yes: false, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'awaiting_plan');
    expect(session.decidePlan(false)).toBe(true);
    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.taskId).toBeUndefined();
  });

  it('运行失败时记录错误并发出 session_done', async () => {
    // 规划响应不是合法 Plan JSON → planner 自动修复一次后仍失败 → runCommand 拒绝
    const session = sessionFor([{ content: 'not a plan' }, { content: 'still not a plan' }]);
    session.start({ task: '会失败的任务', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    expect(snapshot.status).toBe('finished');
    expect(snapshot.error).toBeDefined();
    expect(snapshot.error!.length).toBeGreaterThan(0);
    const done = [...snapshot.events].reverse().find((event) => event.type === 'session_done');
    expect((done?.data as { error?: string }).error).toBe(snapshot.error);
  });

  it('运行中 abort() 返回 true 并让会话结束', async () => {
    const session = sessionFor(planScript());
    session.start({ task: '总结 note.txt', yes: false, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'awaiting_plan');
    expect(session.abort()).toBe(true);
    await waitForSessionStatus(session, 'finished');
    expect(session.getStatus()).toBe('finished');
  });

  it('等待高风险确认时中止：解除挂起决策并结束', async () => {
    const session = sessionFor([
      { content: planContentJson() },
      { toolCalls: [{ name: 'write_file', arguments: '{"path":"note.txt","content":"x"}' }] },
      { content: 'done' },
    ]);
    // 覆盖已存在文件才会触发高风险确认
    writeFileSync(path.join(workspace, 'note.txt'), 'old');
    session.start({ task: '确认中止测试', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'awaiting_confirm');
    expect(session.hasPendingConfirm()).toBe(true);
    expect(session.abort()).toBe(true);
    await waitForSessionStatus(session, 'finished');
    expect(session.hasPendingConfirm()).toBe(false);
    expect(readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('old');
  });

  it('高风险确认超时后自动拒绝并发出 confirm_timeout', async () => {
    const session = sessionFor(
      [
        { content: planContentJson() },
        { toolCalls: [{ name: 'write_file', arguments: '{"path":"note.txt","content":"x"}' }] },
        { content: 'done' },
      ],
      { AGENT_CONFIRM_TIMEOUT_MS: '1000' },
    );
    writeFileSync(path.join(workspace, 'note.txt'), 'old');
    session.start({ task: '确认超时测试', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'awaiting_confirm');
    expect(session.hasPendingConfirm()).toBe(true);

    await waitForSessionStatus(session, 'finished', 15_000);
    const snapshot = session.snapshot();
    expect(session.hasPendingConfirm()).toBe(false);
    const timeoutEvent = snapshot.events.find((event) => event.type === 'confirm_timeout');
    expect(timeoutEvent?.data).toEqual({ timeoutMs: 1000 });
    expect(snapshot.error).toBeUndefined();
    expect(readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('old');
  }, 20_000);

  it('步骤迭代超限触发 task_state 事件', async () => {
    const session = sessionFor(
      [
        { content: planContentJson() },
        { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
        { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      ],
      { AGENT_STEP_MAX_ITERATIONS: '1' },
    );
    session.start({ task: '步骤失败测试', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    const taskState = snapshot.events.find((event) => event.type === 'task_state');
    expect(taskState).toBeDefined();
    expect((taskState?.data as { state?: string }).state).toBe('step_failed');
    expect(snapshot.error).toBeDefined();
  });

  it('验证失败触发 repair 事件', async () => {
    const session = sessionFor(
      [
        { content: planContentJson() },
        { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
        { content: 'first attempt' },
        { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
        { content: 'repair attempt' },
      ],
      {
        AGENT_VERIFY_COMMAND: 'node -e "process.exit(1)"',
        AGENT_MAX_REPAIR_ATTEMPTS: '1',
      },
    );
    session.start({ task: '修复测试', yes: true, noVerify: false, verify: undefined });
    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    const repair = snapshot.events.find((event) => event.type === 'repair');
    expect(repair).toBeDefined();
    expect(snapshot.error).toBeDefined();
  });

  it('订阅者抛错不影响事件广播', async () => {
    const session = sessionFor(planScript());
    session.subscribe(() => {
      throw new Error('boom');
    });
    session.start({ task: '总结 note.txt', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'finished');
    const snapshot = session.snapshot();
    expect(snapshot.status).toBe('finished');
    expect(snapshot.error).toBeUndefined();
  });

  it('yes=true 跳过 Plan 确认直接执行', async () => {
    const session = sessionFor(planScript());
    session.start({ task: '总结 note.txt', yes: true, noVerify: true, verify: undefined });
    await waitForSessionStatus(session, 'finished');
    const statuses = session
      .snapshot()
      .events.filter((event) => event.type === 'session_status')
      .map((event) => (event.data as { status: string }).status);
    expect(statuses).not.toContain('awaiting_plan');
    expect(statuses).toContain('running');
  });
});
