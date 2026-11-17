import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../src/config/load.js';
import { createWebServer, listen } from '../../src/web/server.js';
import { RunSession } from '../../src/web/session.js';
import { createWorkspace, readTask, type TestWorkspace } from './helpers.js';

const TOKEN = 'test-token-web-flow';

interface CollectedEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** 进程内 SSE 读取器：与前端 app.js 相同的解析规则 */
class SseCollector {
  private readonly events: CollectedEvent[] = [];
  private readonly controller = new AbortController();
  private readonly done: Promise<void>;

  constructor(baseUrl: string) {
    this.done = (async () => {
      const response = await fetch(`${baseUrl}/api/events`, {
        headers: { 'x-agent-token': TOKEN },
        signal: this.controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let name = '';
      let dataLines: string[] = [];
      while (true) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        const value = read.value as Uint8Array;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.startsWith('event: ')) {
            name = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6).trim());
          } else if (line === '' && name !== '') {
            const data = JSON.parse(dataLines.join('\n') || '{}') as Record<string, unknown>;
            this.events.push({ type: name, data });
            name = '';
            dataLines = [];
          }
          index = buffer.indexOf('\n');
        }
      }
    })().catch(() => undefined);
  }

  all(): readonly CollectedEvent[] {
    return this.events;
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  async waitFor(
    predicate: (event: CollectedEvent) => boolean,
    timeoutMs = 15_000,
  ): Promise<CollectedEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found !== undefined) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timeout waiting for event (${this.types().join(', ')})`);
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }
}

async function post(
  baseUrl: string,
  apiPath: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: 'POST',
    headers: { 'x-agent-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

interface RunningServer {
  readonly baseUrl: string;
  readonly session: RunSession;
  close(): Promise<void>;
}

async function startServer(workspace: TestWorkspace): Promise<RunningServer> {
  const publicDir = mkdtempSync(path.join(tmpdir(), 'agent-web-public-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<h1>test</h1>');
  const config = loadConfig({
    env: {
      LLM_PROVIDER: 'mock',
      LLM_API_KEY: '',
      AGENT_WORKSPACE: workspace.dir,
      AGENT_MOCK_SCRIPT: 'script.json',
    },
    envFilePath: null,
  });
  const session = new RunSession(config, pino({ level: 'silent' }));
  const web = createWebServer({
    logger: pino({ level: 'silent' }),
    publicDir,
    token: TOKEN,
    session,
  });
  await listen(web.server, 0, '127.0.0.1');
  const address = web.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server address unavailable');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    session,
    close: async () => {
      await web.close().catch(() => undefined);
      await rm(publicDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

let workspace: TestWorkspace | undefined;
let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await workspace?.cleanup();
  workspace = undefined;
});

function planStep(plan: { goal: string; title: string; description: string }): string {
  return JSON.stringify({
    goal: plan.goal,
    steps: [{ id: 's1', title: plan.title, description: plan.description, files: [] }],
    notes: null,
  });
}

describe('web 全流程（mock provider）', () => {
  it('发任务 → SSE 收到快照与增量 → 批准 Plan → 任务完成', async () => {
    workspace = createWorkspace('agent-web-flow-');
    workspace.write('note.txt', 'hello from tool\n');
    workspace.script([
      { content: planStep({ goal: '总结 note.txt', title: '读取', description: '读取 note.txt' }) },
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"note.txt"}' }] },
      { content: '文件内容是 hello from tool。' },
    ]);
    server = await startServer(workspace);

    const collector = new SseCollector(server.baseUrl);
    const snapshot = await collector.waitFor((event) => event.type === 'snapshot');
    expect(snapshot.data.status).toBe('idle');
    expect(snapshot.data.events).toEqual([]);

    await post(server.baseUrl, '/api/run', { task: '总结 note.txt 的内容' });
    await collector.waitFor(
      (event) => event.type === 'session_status' && event.data.status === 'awaiting_plan',
    );

    // 运行中重复提交被拒绝
    expect((await post(server.baseUrl, '/api/run', { task: 'second' })).status).toBe(409);

    const approved = await post(server.baseUrl, '/api/plan', { approved: true });
    expect(approved.status).toBe(200);
    expect(approved.json.handled).toBe(true);

    const done = await collector.waitFor((event) => event.type === 'session_done');
    expect(done.data.error).toBeUndefined();
    const taskId = done.data.taskId as string;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    const types = collector.types();
    expect(types).toContain('plan');
    expect(types).toContain('task_created');
    expect(types).toContain('step_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('step_end');
    expect(types).toContain('verification');
    expect(types).toContain('answer');
    const planEvent = collector.all().find((event) => event.type === 'plan');
    expect((planEvent?.data as { goal?: string }).goal).toBe('总结 note.txt');
    const answerEvent = collector.all().find((event) => event.type === 'answer');
    expect((answerEvent?.data as { content?: string }).content).toContain('hello from tool');

    const task = await readTask(workspace.dir, taskId);
    expect(task?.status).toBe('completed');
    await collector.close();
  });

  it('高风险确认：批准后继续执行', async () => {
    workspace = createWorkspace('agent-web-flow-');
    workspace.write('note.txt', 'old content\n');
    workspace.script([
      { content: planStep({ goal: '更新 note.txt', title: '写入', description: '更新 note.txt' }) },
      { toolCalls: [{ name: 'write_file', arguments: '{"path":"note.txt","content":"new"}' }] },
      { content: '已更新。' },
    ]);
    server = await startServer(workspace);

    const collector = new SseCollector(server.baseUrl);
    await post(server.baseUrl, '/api/run', { task: '更新 note.txt' });
    await collector.waitFor(
      (event) => event.type === 'session_status' && event.data.status === 'awaiting_plan',
    );
    await post(server.baseUrl, '/api/plan', { approved: true });

    const confirmRequest = await collector.waitFor((event) => event.type === 'confirm_request');
    expect((confirmRequest.data as { summary?: string }).summary).toContain('note.txt');
    expect((await post(server.baseUrl, '/api/confirm', { approved: true })).status).toBe(200);

    const done = await collector.waitFor((event) => event.type === 'session_done');
    expect(done.data.error).toBeUndefined();
    expect(collector.types()).toContain('answer');
    expect(workspace.read('note.txt')).toBe('new');
    await collector.close();
  });

  it('高风险确认：拒绝后任务不落盘写入', async () => {
    workspace = createWorkspace('agent-web-flow-');
    workspace.write('note.txt', 'keep me\n');
    workspace.script([
      { content: planStep({ goal: '更新 note.txt', title: '写入', description: '更新 note.txt' }) },
      { toolCalls: [{ name: 'write_file', arguments: '{"path":"note.txt","content":"new"}' }] },
      { content: '已更新。' },
    ]);
    server = await startServer(workspace);

    const collector = new SseCollector(server.baseUrl);
    await post(server.baseUrl, '/api/run', { task: '更新 note.txt' });
    await collector.waitFor(
      (event) => event.type === 'session_status' && event.data.status === 'awaiting_plan',
    );
    await post(server.baseUrl, '/api/plan', { approved: true });
    await collector.waitFor((event) => event.type === 'confirm_request');
    expect((await post(server.baseUrl, '/api/confirm', { approved: false })).status).toBe(200);

    const done = await collector.waitFor((event) => event.type === 'session_done');
    expect(done.data.taskId).toBeDefined();
    expect(workspace.read('note.txt')).toBe('keep me\n');
    await collector.close();
  });

  it('等待 Plan 时中止：任务立即结束且无任务记录', async () => {
    workspace = createWorkspace('agent-web-flow-');
    workspace.script([
      { content: planStep({ goal: 'g', title: 't', description: 'd' }) },
      { content: 'done' },
    ]);
    server = await startServer(workspace);

    const collector = new SseCollector(server.baseUrl);
    await post(server.baseUrl, '/api/run', { task: '中止测试' });
    await collector.waitFor(
      (event) => event.type === 'session_status' && event.data.status === 'awaiting_plan',
    );

    const aborted = await post(server.baseUrl, '/api/abort', {});
    expect(aborted.status).toBe(200);

    const done = await collector.waitFor((event) => event.type === 'session_done');
    expect(done.data.taskId).toBeUndefined();
    expect(await readTask(workspace.dir, 'any')).toBeUndefined();
    expect((await post(server.baseUrl, '/api/abort', {})).status).toBe(409);
    await collector.close();
  });
});
