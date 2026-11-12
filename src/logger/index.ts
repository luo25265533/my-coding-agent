import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type Logger, type LoggerOptions } from 'pino';
import pretty from 'pino-pretty';
import type { AppConfig } from '../config/load.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { REDACT_CENSOR, REDACT_PATHS } from './redact.js';

export interface LoggerHandle {
  readonly logger: Logger;
  readonly logFile: string;
  /** 只结束文件流，不触碰 stdout —— 进程标准输出不属于 logger */
  readonly close: () => void;
}

export function resolveLogFilePath(config: AppConfig): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(config.log.dir, `agent-${date}.jsonl`);
}

export function createLogger(config: AppConfig, runId?: string): LoggerHandle {
  const logFile = resolveLogFilePath(config);

  try {
    mkdirSync(config.log.dir, { recursive: true });

    // sync: true —— CLI 是短生命周期进程，异步缓冲会在退出时丢日志
    const fileStream = pino.destination({ dest: logFile, sync: true });
    const consoleStream = config.log.pretty
      ? pretty({ translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,app' })
      : process.stdout;

    const options: LoggerOptions = {
      level: config.log.level,
      base: runId === undefined ? { app: 'my-coding-agent' } : { app: 'my-coding-agent', runId },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    };

    const logger = pino(
      options,
      // multistream 未指定 level 时默认按 info 过滤，必须显式对齐配置级别
      pino.multistream([
        { stream: consoleStream, level: config.log.level },
        { stream: fileStream, level: config.log.level },
      ]),
    );

    return {
      logger,
      logFile,
      close: () => {
        fileStream.destroy();
      },
    };
  } catch (error) {
    throw new AgentError(
      ErrorCode.LogSetupFailed,
      `Failed to initialize logger (dir=${config.log.dir})`,
      { cause: error },
    );
  }
}
