import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, printedTaskId, readTask, runCli, type TestWorkspace } from './helpers.js';

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createWorkspace('agent-permissions-');
});

afterEach(async () => {
  await workspace.cleanup();
});

const symlinkSupport = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'agent-symlink-probe-'));
  try {
    mkdirSync(path.join(probe, 'target'));
    symlinkSync(
      path.join(probe, 'target'),
      path.join(probe, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

function toolCall(name: string, args: unknown): unknown {
  return { toolCalls: [{ name, arguments: JSON.stringify(args) }] };
}

describe('权限控制端到端（真实 CLI 子进程）', () => {
  it('write_file 路径穿越被拒绝且不落盘', () => {
    const outsideName = `${path.basename(workspace.dir)}-escape.txt`;
    workspace.script([
      { content: planContent('escape') },
      toolCall('write_file', { path: `../${outsideName}`, content: 'escaped' }),
      { content: 'escape blocked' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', 'escape write'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('TOOL_DENIED');
    expect(run.stdout).toContain('escape blocked');
    expect(existsSync(path.join(tmpdir(), outsideName))).toBe(false);
  });

  it('敏感文件与 .git 目录拒绝写入', () => {
    workspace.script([
      { content: planContent('sensitive') },
      toolCall('write_file', { path: '.env', content: 'TOKEN=leak' }),
      toolCall('write_file', { path: '.git/config', content: '[remote]' }),
      toolCall('write_file', { path: 'credentials.json', content: '{}' }),
      { content: 'blocked' },
    ]);

    const run = runCli(workspace.dir, ['run', '--yes', 'sensitive write'], {
      AGENT_MOCK_SCRIPT: 'script.json',
      // 三次拒绝是预期场景，放宽熔断以便继续下一步断言
      AGENT_MAX_CONSECUTIVE_FAILURES: '5',
    });

    expect(run.status).toBe(0);
    expect(run.stdout.match(/TOOL_DENIED/g)?.length).toBe(3);
    expect(workspace.exists('.env')).toBe(false);
    expect(workspace.exists('.git/config')).toBe(false);
    expect(workspace.exists('credentials.json')).toBe(false);
  });

  it.skipIf(!symlinkSupport)('符号链接逃逸在读写两侧都被拒绝', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'agent-outside-dir-'));
    try {
      writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside secret\n');
      symlinkSync(
        outsideDir,
        path.join(workspace.dir, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      workspace.script([
        { content: planContent('symlink escape') },
        toolCall('read_file', { path: 'escape/secret.txt' }),
        toolCall('write_file', { path: 'escape/pwned.txt', content: 'pwned' }),
        { content: 'link blocked' },
      ]);

      const run = runCli(workspace.dir, ['run', '--yes', 'symlink escape'], {
        AGENT_MOCK_SCRIPT: 'script.json',
      });

      expect(run.status).toBe(0);
      expect(run.stdout.match(/TOOL_DENIED/g)?.length).toBe(2);
      expect(run.stdout).not.toContain('outside secret');
      expect(existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('AGENT_TASK_DB 越界或指向敏感文件时配置校验失败（退出码 2）', () => {
    const escape = runCli(workspace.dir, ['run', '--plan-only', 'task db escape'], {
      AGENT_TASK_DB: '../outside.db',
    });
    expect(escape.status).toBe(2);
    expect(escape.stderr).toContain('AGENT_TASK_DB is invalid');
    expect(escape.stderr).toContain('escapes workspace');
    expect(workspace.exists('../outside.db')).toBe(false);

    const sensitive = runCli(workspace.dir, ['run', '--plan-only', 'task db sensitive'], {
      AGENT_TASK_DB: '.env',
    });
    expect(sensitive.status).toBe(2);
    expect(sensitive.stderr).toContain('AGENT_TASK_DB is invalid');
    expect(sensitive.stderr).toContain('sensitive file');
  });

  it('恢复其他工作区的任务被拒绝（退出码 2）', async () => {
    workspace.script([{ content: planContent('portable task') }]);
    const created = runCli(workspace.dir, ['run', '--plan-only', 'portable task'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });
    expect(created.status).toBe(0);
    const taskId =
      printedTaskId(created.stdout) ?? /task: ([0-9a-f-]{36})/i.exec(created.stdout)?.[1];
    expect(taskId).toBeDefined();

    const other = createWorkspace('agent-permissions-other-');
    try {
      mkdirSync(path.join(other.dir, '.agent'), { recursive: true });
      copyFileSync(
        path.join(workspace.dir, '.agent', 'tasks.db'),
        path.join(other.dir, '.agent', 'tasks.db'),
      );

      const resumed = runCli(other.dir, ['run', '--resume', taskId ?? '']);
      expect(resumed.status).toBe(2);
      expect(resumed.stderr).toContain('task workspace does not match current workspace');
    } finally {
      await other.cleanup();
    }
  }, 20_000);

  it('验证命令被硬拒绝时任务失败且不执行副作用', async () => {
    workspace.script([{ content: planContent('deny verify') }, { content: 'step done' }]);

    const run = runCli(workspace.dir, ['run', '--yes', '--verify', 'git push origin main', 'x'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('verification: failed');
    expect(run.stderr).toContain('command denied');

    const taskId = printedTaskId(run.stdout);
    expect(taskId).toBeDefined();
    const task = await readTask(workspace.dir, taskId ?? '');
    expect(task?.status).toBe('failed');
    expect(task?.verifications.at(-1)?.reason).toContain('command denied');
  });

  it('高风险验证命令在非交互下被拒绝', async () => {
    workspace.script([{ content: planContent('confirm verify') }, { content: 'step done' }]);

    const run = runCli(workspace.dir, ['run', '--yes', '--verify', 'git clean -fd', 'x'], {
      AGENT_MOCK_SCRIPT: 'script.json',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('high-risk action denied (non-interactive)');
    expect(run.stderr).toContain('high-risk verification command denied');

    const taskId = printedTaskId(run.stdout);
    expect(taskId).toBeDefined();
    const task = await readTask(workspace.dir, taskId ?? '');
    expect(task?.status).toBe('failed');
    expect(task?.verifications.at(-1)?.status).toBe('failed');
  });
});
