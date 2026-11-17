import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../src/config/load.js';
import { createTaskStore } from '../../src/memory/index.js';
import { ConfigError } from '../../src/shared/errors.js';
import {
  BodyInvalidError,
  BodyTooLargeError,
  createWebServer,
  generateToken,
  listen,
  readJsonBody,
  type WebServerHandle,
} from '../../src/web/server.js';
import { RunSession } from '../../src/web/session.js';

let publicDir: string;
let port: number;
let closeServer: (() => Promise<void>) | undefined;
let handle: WebServerHandle | undefined;
const token = 'test-token-123';
const session = new RunSession(
  loadConfig({
    env: { LLM_PROVIDER: 'mock', LLM_API_KEY: '' },
    envFilePath: null,
  }),
  pino({ level: 'silent' }),
);

beforeEach(() => {
  publicDir = mkdtempSync(path.join(tmpdir(), 'agent-web-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<h1>agent web</h1>');
  writeFileSync(path.join(publicDir, 'app.js'), 'window.agentToken = "";');
  writeFileSync(path.join(publicDir, 'style.css'), 'body{margin:0}');
  writeFileSync(path.join(publicDir, 'secret.txt'), 'should not serve');
  writeFileSync(path.join(path.dirname(publicDir), 'outside.txt'), 'outside');
});

afterEach(async () => {
  if (closeServer !== undefined) {
    await closeServer().catch(() => undefined);
    closeServer = undefined;
  }
  handle = undefined;
  await rm(publicDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function start(sessionOverride?: RunSession): Promise<void> {
  handle = createWebServer({
    logger: pino({ level: 'silent' }),
    publicDir,
    token,
    session: sessionOverride ?? session,
  });
  await listen(handle.server, 0, '127.0.0.1');
  const address = handle.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server address unavailable');
  }
  port = address.port;
  const serverHandle = handle;
  closeServer = () => serverHandle.close();
}

function base(): string {
  return `http://127.0.0.1:${port}`;
}

function authHeaders(): Record<string, string> {
  return { 'x-agent-token': token };
}

describe('web 静态资源', () => {
  it('GET / 返回 index.html', async () => {
    await start();
    const response = await fetch(`${base()}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('agent web');
  });

  it('白名单内的 js/css 可访问，其他扩展名一律 404', async () => {
    await start();
    expect((await fetch(`${base()}/app.js`)).status).toBe(200);
    expect((await fetch(`${base()}/style.css`)).status).toBe(200);
    expect((await fetch(`${base()}/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base()}/missing.html`)).status).toBe(404);
  });

  it('路径穿越被拒绝', async () => {
    await start();
    expect((await fetch(`${base()}/../outside.txt`)).status).toBe(404);
    expect((await fetch(`${base()}/%2e%2e/outside.txt`)).status).toBe(404);
    expect((await fetch(`${base()}/..%2foutside.txt`)).status).toBe(404);
    expect((await fetch(`${base()}/sub/../secret.txt`)).status).toBe(404);
  });

  it('非 GET 方法访问静态资源返回 405', async () => {
    await start();
    const response = await fetch(`${base()}/`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('GET');
  });
});

describe('web API 鉴权', () => {
  it('缺少或错误 token 一律 403', async () => {
    await start();
    const missing = await fetch(`${base()}/api/health`);
    expect(missing.status).toBe(403);
    const wrong = await fetch(`${base()}/api/health`, {
      headers: { 'x-agent-token': 'wrong' },
    });
    expect(wrong.status).toBe(403);
  });

  it('携带 token 的 /api/health 返回版本信息', async () => {
    await start();
    const response = await fetch(`${base()}/api/health`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('1.2.0');
  });

  it('未知 API 返回 404，错误方法返回 405', async () => {
    await start();
    expect((await fetch(`${base()}/api/nope`, { headers: authHeaders() })).status).toBe(404);
    const post = await fetch(`${base()}/api/health`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toContain('GET');
  });

  it('伪造 Host 头的请求被拒绝（防 DNS rebinding）', async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example:80' } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });
});

describe('readJsonBody', () => {
  it('解析 JSON 请求体', async () => {
    const body = await readJsonBody(Readable.from([Buffer.from('{"a":1}')]));
    expect(body).toEqual({ a: 1 });
  });

  it('空请求体视为空对象', async () => {
    expect(await readJsonBody(Readable.from([]))).toEqual({});
  });

  it('超限抛 BodyTooLargeError', async () => {
    await expect(
      readJsonBody(Readable.from([Buffer.alloc(1024 * 1024 + 1)])),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('非法 JSON 抛 BodyInvalidError', async () => {
    await expect(readJsonBody(Readable.from([Buffer.from('nope')]))).rejects.toBeInstanceOf(
      BodyInvalidError,
    );
  });
});

describe('web 任务查询 API', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'agent-web-tasks-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function sessionForWorkspace(): RunSession {
    return new RunSession(
      loadConfig({
        env: { LLM_PROVIDER: 'mock', LLM_API_KEY: '', AGENT_WORKSPACE: workspace },
        envFilePath: null,
      }),
      pino({ level: 'silent' }),
    );
  }

  it('空任务库返回空列表', async () => {
    await start(sessionForWorkspace());
    const response = await fetch(`${base()}/api/tasks`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [] });
  });

  it('返回任务列表与详情，未知 id 返回 404', async () => {
    const store = await createTaskStore({
      dbPath: path.join(workspace, '.agent', 'tasks.db'),
      workspace,
    });
    const created = await store.createTask({
      goal: 'fix the bug',
      plan: {
        goal: 'fix the bug',
        steps: [{ id: 's1', title: 'locate', description: 'find it', files: [] }],
        notes: undefined,
      },
      workspace,
      verifyCommand: undefined,
      verifyAutoSkip: false,
      baselineDiff: undefined,
    });
    await store.close();

    await start(sessionForWorkspace());
    const list = await fetch(`${base()}/api/tasks`, { headers: authHeaders() });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      tasks: readonly { id: string; goal: string; status: string }[];
    };
    expect(listBody.tasks).toHaveLength(1);
    expect(listBody.tasks[0]?.id).toBe(created.id);
    expect(listBody.tasks[0]?.goal).toBe('fix the bug');

    const detail = await fetch(`${base()}/api/tasks/${created.id}`, { headers: authHeaders() });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      task: { id: string; steps: readonly { step: { id: string } }[] };
    };
    expect(detailBody.task.id).toBe(created.id);
    expect(detailBody.task.steps[0]?.step.id).toBe('s1');

    const missing = await fetch(`${base()}/api/tasks/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it('limit 校验与错误方法', async () => {
    await start(sessionForWorkspace());
    expect((await fetch(`${base()}/api/tasks?limit=0`, { headers: authHeaders() })).status).toBe(
      400,
    );
    expect((await fetch(`${base()}/api/tasks?limit=abc`, { headers: authHeaders() })).status).toBe(
      400,
    );
    expect((await fetch(`${base()}/api/tasks?limit=101`, { headers: authHeaders() })).status).toBe(
      400,
    );
    expect((await fetch(`${base()}/api/tasks?limit=5`, { headers: authHeaders() })).status).toBe(
      200,
    );
    const post = await fetch(`${base()}/api/tasks`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toContain('GET');
  });
});

describe('web API 校验与边界', () => {
  it('generateToken 生成 22 字符 base64url', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateToken()).not.toBe(token);
  });

  it('错误方法一律 405', async () => {
    await start();
    expect(
      (await fetch(`${base()}/api/events`, { method: 'POST', headers: authHeaders() })).status,
    ).toBe(405);
    expect((await fetch(`${base()}/api/run`, { headers: authHeaders() })).status).toBe(405);
    expect((await fetch(`${base()}/api/plan`, { headers: authHeaders() })).status).toBe(405);
    expect((await fetch(`${base()}/api/abort`, { headers: authHeaders() })).status).toBe(405);
    expect(
      (
        await fetch(`${base()}/api/tasks/00000000-0000-0000-0000-000000000000`, {
          method: 'POST',
          headers: authHeaders(),
        })
      ).status,
    ).toBe(405);
  });

  it('决策接口：approved 非布尔 400，无挂起决策 409', async () => {
    await start();
    const invalid = await fetch(`${base()}/api/plan`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ approved: 'yes' }),
    });
    expect(invalid.status).toBe(400);
    const noPending = await fetch(`${base()}/api/plan`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ approved: true }),
    });
    expect(noPending.status).toBe(409);
    const noPendingConfirm = await fetch(`${base()}/api/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ approved: false }),
    });
    expect(noPendingConfirm.status).toBe(409);
  });

  it('/api/run：空任务 400，空 verify 400', async () => {
    await start();
    const empty = await fetch(`${base()}/api/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ task: '   ' }),
    });
    expect(empty.status).toBe(400);
    const badVerify = await fetch(`${base()}/api/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ task: 'x', verify: '  ' }),
    });
    expect(badVerify.status).toBe(400);
  });

  it('/api/run 超大请求体 413，非法 JSON 400', async () => {
    await start();
    const tooLarge = await fetch(`${base()}/api/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    const invalid = await fetch(`${base()}/api/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: 'not-json',
    });
    expect(invalid.status).toBe(400);
  });

  it('/api/plan 超大请求体走统一异常分支 413，/api/run 非法 JSON 400', async () => {
    await start();
    const tooLarge = await fetch(`${base()}/api/plan`, {
      method: 'POST',
      headers: authHeaders(),
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    const invalid = await fetch(`${base()}/api/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: 'not-json',
    });
    expect(invalid.status).toBe(400);
  });

  it('/api/abort 无运行任务 409', async () => {
    await start();
    const response = await fetch(`${base()}/api/abort`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
  });

  it('GET /api/events 返回 SSE 快照帧', async () => {
    await start();
    const response = await fetch(`${base()}/api/events`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const read = await reader!.read();
    const text = new TextDecoder().decode(read.value as Uint8Array);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"status":"idle"');
    await reader!.cancel();
  });

  it('非法 HTTP 请求触发 clientError 400', async () => {
    await start();
    const data = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('BAD\r\n\r\n');
      });
      socket.on('data', (chunk: Buffer) => {
        resolve(chunk.toString());
        socket.end();
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('clientError timeout')), 3000).unref();
    });
    expect(data).toContain('400 Bad Request');
  });

  it('close 后再次 close 抛错', async () => {
    await start();
    await handle?.close();
    await expect(handle?.close()).rejects.toThrow();
  });
});

describe('web 配置校验', () => {
  function webEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    return {
      LLM_PROVIDER: 'mock',
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      ...extra,
    };
  }

  it('默认端口与回环地址', () => {
    const config = loadConfig({ env: webEnv({}), envFilePath: null });
    expect(config.web).toEqual({ port: 3210, host: '127.0.0.1' });
  });

  it('端口越界与非法地址被拒绝', () => {
    expect(() => loadConfig({ env: webEnv({ AGENT_WEB_PORT: '80' }), envFilePath: null })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ env: webEnv({ AGENT_WEB_PORT: '70000' }), envFilePath: null }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ env: webEnv({ AGENT_WEB_HOST: '0.0.0.0' }), envFilePath: null }),
    ).toThrow(ConfigError);
  });
});
