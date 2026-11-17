import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { ErrorCode } from '../../src/shared/errors.js';
import { createWorkspace, printedTaskId, readTask, runCli, type TestWorkspace } from './helpers.js';

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createWorkspace('agent-failure-modes-');
});

afterEach(async () => {
  await workspace.cleanup();
  vi.restoreAllMocks();
});

function planContent(title: string): string {
  return JSON.stringify({
    goal: 'finish the task',
    steps: [
      {
        id: 's1',
        title,
        description: `do ${title}`,
        files: [],
      },
    ],
    notes: undefined,
  });
}

function applyEnv(overrides: NodeJS.ProcessEnv): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

describe('异常场景端到端（真实 CLI 子进程）', () => {
  it('验证命令超时：任务失败并记录 timedOut', async () => {
    workspace.script([{ content: planContent('quick answer') }, { content: 'done' }]);

    const run = runCli(workspace.dir, ['run', '--yes', 'verify timeout'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      AGENT_VERIFY_COMMAND: 'node -e "setTimeout(function(){},5000)"',
      AGENT_VERIFY_TIMEOUT_MS: '1000',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('verification: failed (timeout');
    expect(run.stderr).toContain('timed out');

    const taskId = printedTaskId(run.stdout);
    expect(taskId).toBeDefined();
    const task = await readTask(workspace.dir, taskId ?? '');
    expect(task?.status).toBe('failed');
    expect(task?.verifications.at(-1)?.status).toBe('failed');
    expect(task?.verifications.at(-1)?.timedOut).toBe(true);
    expect(task?.error).toContain('timed out');
  }, 15_000);

  it('任务库损坏：报错退出且不覆盖原文件', () => {
    const dbPath = '.agent/tasks.db';
    const corruptBytes = 'this is not a sqlite database';
    workspace.write(dbPath, corruptBytes);
    workspace.script([{ content: planContent('unused step') }]);

    const run = runCli(workspace.dir, ['run', '--plan-only', 'corrupt store'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/task store/i);
    expect(workspace.read(dbPath)).toBe(corruptBytes);
    expect(workspace.exists('.agent/tasks.db.lock')).toBe(false);
  });

  it('任务库被存活进程锁定：报错退出且不创建任务库', () => {
    workspace.write(
      '.agent/tasks.db.lock',
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    workspace.script([{ content: planContent('unused step') }]);

    const run = runCli(workspace.dir, ['run', '--plan-only', 'locked store'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`locked by pid ${process.pid}`);
    expect(workspace.exists('.agent/tasks.db')).toBe(false);
  });

  it('恢复不存在的任务返回 TASK_NOT_FOUND（退出码 2）', () => {
    const unknown = runCli(workspace.dir, [
      'run',
      '--resume',
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('task not found');

    const malformed = runCli(workspace.dir, ['run', '--resume', 'not-a-task-id']);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain('task not found');
  });

  it('非 git 工作区：差异采集降级为 unavailable，任务仍可完成', async () => {
    workspace.script([{ content: planContent('quick answer') }, { content: 'done' }]);

    const run = runCli(workspace.dir, ['run', '--yes', '--no-verify', 'no git here'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('diff: unavailable (not a git repository)');

    const taskId = printedTaskId(run.stdout);
    expect(taskId).toBeDefined();
    const task = await readTask(workspace.dir, taskId ?? '');
    expect(task?.status).toBe('completed');
    expect(task?.diffs.at(-1)?.available).toBe(false);
    expect(task?.diffs.at(-1)?.reason).toBe('not a git repository');
  });
});

describe('中止信号（进程内注入 SIGINT）', () => {
  it('运行中的命令被中止，任务持久化为 aborted', async () => {
    workspace.script([
      { content: planContent('long command') },
      {
        toolCalls: [
          {
            name: 'run_command',
            arguments: JSON.stringify({
              command: 'node -e "setTimeout(function(){},10000)"',
              timeoutMs: 20_000,
            }),
          },
        ],
      },
      { content: 'done' },
    ]);

    const restoreEnv = applyEnv({
      AGENT_LOG_DIR: 'logs',
      AGENT_LOG_PRETTY: 'false',
      AGENT_LOG_LEVEL: 'info',
      AGENT_TASK_DB: '.agent/tasks.db',
      AGENT_VERIFY_COMMAND: '',
      AGENT_MOCK_SCRIPT: 'script.json',
      LLM_PROVIDER: 'mock',
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
    });

    let output = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let check: NodeJS.Timeout | undefined;

    try {
      const runPromise = runCommand(['abort the running command'], {
        workspace: workspace.dir,
        yes: true,
        noVerify: true,
        logLevel: 'info',
      });

      let interrupted = false;
      await Promise.race([
        runPromise.then(
          () => {
            throw new Error('run finished before SIGINT could be injected');
          },
          (error: unknown) => {
            if (interrupted) {
              return;
            }
            throw error;
          },
        ),
        new Promise<void>((resolve) => {
          check = setInterval(() => {
            output = outSpy.mock.calls.map((call) => String(call[0] ?? '')).join('');
            if (!interrupted && output.includes('→ run_command')) {
              interrupted = true;
              process.emit('SIGINT');
              resolve();
            }
          }, 5);
        }),
      ]);

      await expect(runPromise).rejects.toMatchObject({ code: ErrorCode.LlmAborted });

      const taskId = /task: ([0-9a-f-]{36})/i.exec(output)?.[1];
      expect(taskId).toBeDefined();
      const task = await readTask(workspace.dir, taskId ?? '');
      expect(task?.status).toBe('aborted');
      expect(task?.error).toMatch(/abort/i);
    } finally {
      if (check !== undefined) {
        clearInterval(check);
      }
      outSpy.mockRestore();
      errSpy.mockRestore();
      restoreEnv();
    }
  }, 20_000);
});
