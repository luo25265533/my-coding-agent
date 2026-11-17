import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../../src/memory/index.js';
import type { TaskRecord, TaskStore, TaskSummary } from '../../src/memory/types.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCli = path.join(projectRoot, 'src', 'cli', 'main.ts');
const TASK_DB = path.join('.agent', 'tasks.db');

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TestWorkspace {
  readonly dir: string;
  write(relativePath: string, content: string): void;
  read(relativePath: string): string | undefined;
  exists(relativePath: string): boolean;
  script(steps: unknown): void;
  cleanup(): Promise<void>;
}

export function createWorkspace(prefix = 'agent-e2e-'): TestWorkspace {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    write(relativePath: string, content: string): void {
      const target = path.join(dir, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    read(relativePath: string): string | undefined {
      const target = path.join(dir, relativePath);
      return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    },
    exists(relativePath: string): boolean {
      return existsSync(path.join(dir, relativePath));
    },
    script(steps: unknown): void {
      writeFileSync(path.join(dir, 'script.json'), JSON.stringify(steps));
    },
    cleanup(): Promise<void> {
      // 必须异步删除：pino 的 sonic-boom destroy() 是异步 fsync→close，
      // rmSync 的同步重试会阻塞事件循环，让文件一直处于 delete-pending，
      // Windows 上表现为 rmdir 持续 ENOTEMPTY。
      return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * 显式覆盖所有会改变行为的配置，避免项目根 .env 污染测试。
 * 各用例通过 env 参数覆盖需要变化的字段。
 */
function baseEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_WORKSPACE: workspace,
    AGENT_LOG_DIR: 'logs',
    AGENT_LOG_PRETTY: 'false',
    AGENT_LOG_LEVEL: 'info',
    LLM_PROVIDER: 'mock',
    LLM_API_KEY: '',
    LLM_BASE_URL: '',
    LLM_MODEL: '',
    LLM_TIMEOUT_MS: '60000',
    LLM_MAX_RETRIES: '2',
    AGENT_MAX_ITERATIONS: '20',
    AGENT_PLAN_MAX_STEPS: '12',
    AGENT_STEP_MAX_ITERATIONS: '10',
    AGENT_COMMAND_TIMEOUT_MS: '30000',
    AGENT_MAX_REPEATED_CALLS: '3',
    AGENT_MAX_CONSECUTIVE_FAILURES: '3',
    AGENT_CONTEXT_BUDGET_TOKENS: '16000',
    AGENT_RESPECT_GITIGNORE: 'true',
    AGENT_IGNORE: '',
    AGENT_CONFIRM_HIGH_RISK: 'true',
    AGENT_TASK_DB: TASK_DB,
    AGENT_VERIFY_COMMAND: '',
    AGENT_VERIFY_TIMEOUT_MS: '300000',
    AGENT_MAX_REPAIR_ATTEMPTS: '0',
    AGENT_REPAIR_MAX_ITERATIONS: '8',
    AGENT_MOCK_SCRIPT: '',
  };
}

export function runCli(
  workspace: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', sourceCli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...baseEnv(workspace), ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 异步版本：用于测试进程内需要继续服务 HTTP 请求的场景（本地假 LLM 端点） */
export function runCliAsync(
  workspace: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', sourceCli, ...args], {
      cwd: projectRoot,
      env: { ...baseEnv(workspace), ...env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`CLI did not finish within 60s: ${args.join(' ')}`));
      }
    }, 60_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on('close', (status) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      }
    });
  });
}

async function withTaskStore<T>(
  workspace: string,
  read: (store: TaskStore) => Promise<T>,
): Promise<T | undefined> {
  if (!existsSync(path.join(workspace, TASK_DB))) {
    return undefined;
  }
  const store = await createTaskStore({
    dbPath: TASK_DB,
    workspace,
    readOnly: true,
  });
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

export function readTask(workspace: string, taskId: string): Promise<TaskRecord | undefined> {
  return withTaskStore(workspace, (store) => store.getTask(taskId));
}

export function readTaskSummaries(workspace: string): Promise<readonly TaskSummary[]> {
  return withTaskStore(workspace, (store) => store.listTasks()).then((tasks) => tasks ?? []);
}

export function logText(workspace: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(workspace, 'logs', `agent-${date}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function printedTaskId(stdout: string): string | undefined {
  return /task(?: (?:completed|failed|step_failed))?: ([0-9a-f-]{36})/i.exec(stdout)?.[1];
}
