import { randomUUID } from 'node:crypto';
import { loadConfig, redactConfig } from '../../config/load.js';
import { createLogger } from '../../logger/index.js';
import { readPackageInfo } from '../../shared/package-info.js';
import type { LogLevel } from '../../shared/types.js';

export interface RunOptions {
  readonly workspace?: string;
  readonly logLevel?: LogLevel;
  readonly verbose?: boolean;
}

export interface RunResult {
  readonly runId: string;
  readonly logFile: string;
}

export function runCommand(task: readonly string[], options: RunOptions): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.workspace !== undefined) {
    env.AGENT_WORKSPACE = options.workspace;
  }
  const level = options.verbose === true ? 'debug' : options.logLevel;
  if (level !== undefined) {
    env.AGENT_LOG_LEVEL = level;
  }

  const config = loadConfig({ env });
  const runId = randomUUID();
  const { logger, logFile, close } = createLogger(config, runId);
  const log = logger.child({ module: 'cli' });
  const taskText = task.join(' ').trim();
  const redacted = redactConfig(config);

  log.info({ task: taskText, provider: config.llm.provider }, 'run started');
  log.debug({ config: redacted }, 'configuration loaded');

  const info = readPackageInfo();
  const lines = [
    `${info.name} v${info.version} (phase 1 skeleton)`,
    `runId     : ${runId}`,
    `workspace : ${config.agent.workspace}`,
    `provider  : ${config.llm.provider}`,
    `logFile   : ${logFile}`,
    `task      : ${taskText === '' ? '(none)' : taskText}`,
    '',
    'config (redacted):',
    JSON.stringify(redacted, null, 2),
    '',
    'Phase 1 does not call the LLM and does not execute any tool.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  log.info('run finished');
  close();
  return { runId, logFile };
}
