import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Logger } from 'pino';
import { readPackageInfo } from '../shared/package-info.js';
import type { RunSession } from './session.js';

/** 生成 128 位 URL 安全 token，启动时打印一次，/api/* 请求必须回传 */
export function generateToken(): string {
  return randomBytes(16).toString('base64url');
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const STATIC_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(html|js|css)$/i;
const HOST_PATTERN = /^(127\.0\.0\.1|localhost):\d+$/;

export interface WebServerOptions {
  readonly logger: Logger;
  readonly publicDir: string;
  readonly token: string;
  readonly session: RunSession;
}

export interface WebServerHandle {
  readonly server: Server;
  close(): Promise<void>;
}

export function createWebServer(options: WebServerOptions): WebServerHandle {
  const log = options.logger.child({ module: 'web' });
  const root = path.resolve(options.publicDir);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof BodyTooLargeError) {
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof BodyInvalidError) {
        json(res, 400, { error: error.message });
        return;
      }
      /* v8 ignore next 6 -- 防御分支：正常路由下不会有其他异常逃出 handle */
      log.error({ error }, 'request handler crashed');
      if (!res.headersSent) {
        json(res, 500, { error: 'internal error' });
      } else {
        res.end();
      }
    });
  });
  server.on('clientError', (_err: Error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    // 回环绑定之上再校验 Host，阻断 DNS rebinding
    if (!HOST_PATTERN.test(host)) {
      json(res, 403, { error: 'forbidden host' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (pathname.startsWith('/api/')) {
      if (req.headers['x-agent-token'] !== options.token) {
        json(res, 403, { error: 'invalid or missing token' });
        return;
      }
      await handleApi(req, res, pathname);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, ['GET']);
      return;
    }
    await serveStatic(res, pathname, root);
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === '/api/health') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const info = readPackageInfo();
      json(res, 200, { ok: true, name: info.name, version: info.version });
      return;
    }

    if (pathname === '/api/events') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      handleEventStream(req, res);
      return;
    }

    if (pathname === '/api/run') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST']);
        return;
      }
      handleRun(req, res);
      return;
    }

    if (pathname === '/api/plan' || pathname === '/api/confirm') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST']);
        return;
      }
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const approved = body['approved'];
      if (typeof approved !== 'boolean') {
        json(res, 400, { error: 'approved must be a boolean' });
        return;
      }
      const handled =
        pathname === '/api/plan'
          ? options.session.decidePlan(approved)
          : options.session.decideConfirm(approved);
      if (!handled) {
        json(res, 409, { error: 'no pending decision' });
        return;
      }
      json(res, 200, { handled: true, approved });
      return;
    }

    if (pathname === '/api/abort') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST']);
        return;
      }
      await readJsonBody(req);
      if (!options.session.abort()) {
        json(res, 409, { error: 'no running task' });
        return;
      }
      json(res, 200, { handled: true });
      return;
    }

    if (pathname === '/api/tasks') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const limitRaw = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('limit');
      const limit = parseLimit(limitRaw);
      if (limit === undefined) {
        json(res, 400, { error: 'limit must be an integer between 1 and 100' });
        return;
      }
      const tasks = await options.session.listTasks(limit);
      json(res, 200, { tasks });
      return;
    }

    const taskDetailMatch = /^\/api\/tasks\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
    if (taskDetailMatch !== null) {
      if (req.method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const task = await options.session.getTask(taskDetailMatch[1] as string);
      if (task === undefined) {
        json(res, 404, { error: 'not found' });
        return;
      }
      json(res, 200, { task });
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  function parseLimit(raw: string | null): number | undefined {
    if (raw === null) {
      return 20;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return undefined;
    }
    return value;
  }

  function handleRun(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
      if (task === '' || task.length > 4000) {
        json(res, 400, { error: 'task must be a non-empty string of at most 4000 characters' });
        return;
      }
      const yes = body['yes'] === true;
      const noVerify = body['noVerify'] === true;
      const verifyRaw = body['verify'];
      if (verifyRaw !== undefined && (typeof verifyRaw !== 'string' || verifyRaw.trim() === '')) {
        json(res, 400, { error: 'verify must be a non-empty string when provided' });
        return;
      }
      if (!options.session.canStart()) {
        json(res, 409, { error: 'a task is already running', status: options.session.getStatus() });
        return;
      }
      options.session.start({
        task,
        yes,
        noVerify,
        verify: typeof verifyRaw === 'string' ? verifyRaw.trim() : undefined,
      });
      json(res, 202, { status: options.session.getStatus() });
    })().catch((error: unknown) => {
      if (error instanceof BodyTooLargeError) {
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof BodyInvalidError) {
        json(res, 400, { error: error.message });
        return;
      }
      /* v8 ignore next 2 -- 防御分支：/api/run 请求体异常已由前两个分支覆盖 */
      log.error({ error }, 'failed to start run');
      json(res, 500, { error: 'internal error' });
    });
  }

  function handleEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    sendEvent(res, 'snapshot', options.session.snapshot());
    const unsubscribe = options.session.subscribe((event) => {
      sendEvent(res, event.type, event.data);
    });
    const heartbeat = setInterval(() => {
      /* v8 ignore next -- 15s 心跳，测试不做真实等待 */
      res.write(': ping\n\n');
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function serveStatic(res: ServerResponse, pathname: string, root: string): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  // 白名单文件名从源头排除路径穿越；resolve 校验作为双保险
  if (!STATIC_NAME_PATTERN.test(name)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  /* v8 ignore next 4 -- 双保险校验：文件名白名单已从源头排除穿越，HTTP 层不可达 */
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    json(res, 403, { error: 'forbidden path' });
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(target);
  } catch {
    json(res, 404, { error: 'not found' });
    return;
  }
  const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(content);
}

export function methodNotAllowed(res: ServerResponse, allow: readonly string[]): void {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

export function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 读取 JSON 请求体，超限抛 BodyTooLargeError，非法 JSON 抛 BodyInvalidError */
export async function readJsonBody(
  req: AsyncIterable<unknown>,
  limitBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limitBytes) {
      throw new BodyTooLargeError(`request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BodyInvalidError('request body is not valid JSON');
  }
}

export class BodyTooLargeError extends Error {}
export class BodyInvalidError extends Error {}
