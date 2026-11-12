import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config/load.js';
import { createLogger, resolveLogFilePath } from '../../src/logger/index.js';
import { AgentError, ErrorCode, ExitCode } from '../../src/shared/errors.js';

let cwd: string;
let closers: (() => void)[] = [];

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'agent-logger-'));
  closers = [];
});

afterEach(async () => {
  for (const close of closers) {
    close();
  }
  // 必须用异步 rm：sonic-boom 通过异步回调关闭 fd，
  // rmSync 的同步重试会阻塞事件循环，导致句柄永远不释放
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup(env: NodeJS.ProcessEnv = {}, runId = 'run-test') {
  const config: AppConfig = loadConfig({
    cwd,
    env: { AGENT_LOG_PRETTY: 'false', ...env },
    envFilePath: null,
  });
  const handle = createLogger(config, runId);
  closers.push(handle.close);
  return { config, handle };
}

function readRaw(logFile: string): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function readLines(logFile: string): Record<string, unknown>[] {
  return readRaw(logFile)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('级别过滤', () => {
  it('info 级别下 debug 不落盘', () => {
    const { handle } = setup({ AGENT_LOG_LEVEL: 'info' });
    handle.logger.debug('hidden');
    handle.logger.info('visible');
    const lines = readLines(handle.logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('visible');
  });

  it('debug 级别下 debug 落盘', () => {
    const { handle } = setup({ AGENT_LOG_LEVEL: 'debug' });
    handle.logger.debug('shown');
    expect(readLines(handle.logFile)[0]?.msg).toBe('shown');
  });

  it('trace 级别下 trace 落盘', () => {
    const { handle } = setup({ AGENT_LOG_LEVEL: 'trace' });
    handle.logger.trace('lowest');
    expect(readLines(handle.logFile)[0]?.msg).toBe('lowest');
  });

  it('silent 级别下 error 也不落盘', () => {
    const { handle } = setup({ AGENT_LOG_LEVEL: 'silent' });
    handle.logger.error('muted');
    expect(readLines(handle.logFile)).toHaveLength(0);
  });
});

describe('脱敏', () => {
  it('顶层与嵌套的敏感字段都不出现明文', () => {
    const { handle } = setup();
    handle.logger.info(
      {
        apiKey: 'sk-top-secret',
        nested: { token: 'tok-secret', authorization: 'Bearer xyz', password: 'pw-secret' },
      },
      'redaction check',
    );
    const raw = readRaw(handle.logFile);
    expect(raw).not.toContain('sk-top-secret');
    expect(raw).not.toContain('tok-secret');
    expect(raw).not.toContain('Bearer xyz');
    expect(raw).not.toContain('pw-secret');
    expect(raw).toContain('[REDACTED]');
  });

  it('LLM_API_KEY 字段被脱敏', () => {
    const { handle } = setup();
    handle.logger.info({ LLM_API_KEY: 'sk-env-secret' }, 'env key');
    expect(readRaw(handle.logFile)).not.toContain('sk-env-secret');
  });
});

describe('JSONL 结构', () => {
  it('每行都是可解析 JSON 且含 level/time/msg', () => {
    const { handle } = setup();
    handle.logger.info('one');
    handle.logger.warn('two');
    handle.logger.error('three');
    const lines = readLines(handle.logFile);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(typeof line.level).toBe('number');
      expect(typeof line.time).toBe('string');
      expect(typeof line.msg).toBe('string');
    }
  });

  it('child 的 module 与 runId 透传到每一行', () => {
    const { handle } = setup({}, 'run-abc');
    handle.logger.child({ module: 'tools' }).info('from tools');
    const line = readLines(handle.logFile)[0];
    expect(line?.module).toBe('tools');
    expect(line?.runId).toBe('run-abc');
    expect(line?.app).toBe('my-coding-agent');
  });

  it('未传 runId 时不注入该字段', () => {
    const config = loadConfig({ cwd, env: { AGENT_LOG_PRETTY: 'false' }, envFilePath: null });
    const handle = createLogger(config);
    closers.push(handle.close);
    handle.logger.info('no run id');
    expect(readLines(handle.logFile)[0]?.runId).toBeUndefined();
  });
});

describe('文件与目录', () => {
  it('日志目录不存在时自动创建', () => {
    const { config, handle } = setup({ AGENT_LOG_DIR: 'nested/logs' });
    expect(existsSync(config.log.dir)).toBe(true);
    handle.logger.info('created');
    expect(existsSync(handle.logFile)).toBe(true);
  });

  it('handle.logFile 与 resolveLogFilePath 一致且为 .jsonl', () => {
    const { config, handle } = setup();
    expect(handle.logFile).toBe(resolveLogFilePath(config));
    expect(handle.logFile.endsWith('.jsonl')).toBe(true);
  });

  it('日志目录无法创建时抛 LogSetupFailed 并映射退出码 1', () => {
    const blocked = path.join(cwd, 'blocked');
    writeFileSync(blocked, 'i am a file, not a directory', 'utf8');
    const config = loadConfig({
      cwd,
      env: { AGENT_LOG_DIR: 'blocked', AGENT_LOG_PRETTY: 'false' },
      envFilePath: null,
    });
    expect(() => createLogger(config)).toThrow(AgentError);
    expect(() => createLogger(config)).toThrow(/Failed to initialize logger/);

    let caught: unknown;
    try {
      createLogger(config);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).code).toBe(ErrorCode.LogSetupFailed);
    expect((caught as AgentError).exitCode).toBe(ExitCode.RuntimeError);
  });

  it('close 幂等且释放文件句柄，目录可被删除（Windows 回归）', async () => {
    const { handle } = setup({ AGENT_LOG_DIR: 'closable' });
    handle.logger.info('before close');
    expect(readLines(handle.logFile)[0]?.msg).toBe('before close');
    handle.close();
    handle.close();
    const dir = path.dirname(handle.logFile);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    expect(existsSync(dir)).toBe(false);
  });
});
