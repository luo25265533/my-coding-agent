import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveCommand, type ServeHandle } from '../../src/cli/commands/serve.js';

let workspace: string;
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'AGENT_WORKSPACE',
  'AGENT_MOCK_SCRIPT',
  'AGENT_WEB_HOST',
  'AGENT_WEB_PORT',
  'AGENT_LOG_LEVEL',
  'AGENT_LOG_DIR',
] as const;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-serve-'));
  writeFileSync(path.join(workspace, 'script.json'), '[]');
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.LLM_PROVIDER = 'mock';
  process.env.LLM_API_KEY = '';
  process.env.AGENT_WORKSPACE = workspace;
  process.env.AGENT_MOCK_SCRIPT = 'script.json';
  process.env.AGENT_WEB_HOST = '127.0.0.1';
  process.env.AGENT_LOG_LEVEL = 'silent';
});

afterEach(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

async function startServe(): Promise<ServeHandle> {
  return new Promise<ServeHandle>((resolve, reject) => {
    void serveCommand({ onStarted: resolve }).catch(reject);
  });
}

describe('serveCommand', () => {
  it('启动后健康检查可用，close 释放端口', async () => {
    const port = await freePort();
    process.env.AGENT_WEB_PORT = String(port);
    const handle = await startServe();
    try {
      expect(handle.url).toContain(`127.0.0.1:${port}`);
      expect(handle.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { 'x-agent-token': handle.token },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await handle.close();
    }
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('端口被占用时抛错并退出', async () => {
    const blocker = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
      blocker.on('error', reject);
    });
    process.env.AGENT_WEB_PORT = String(port);
    await expect(startServe()).rejects.toThrow();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
