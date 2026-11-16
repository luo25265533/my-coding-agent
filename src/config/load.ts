import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import type { ZodError } from 'zod';
import { ConfigError } from '../shared/errors.js';
import type { LogLevel } from '../shared/types.js';
import { envSchema, mockScriptSchema, type LlmProvider, type MockStep } from './schema.js';

export interface AppConfig {
  readonly llm: {
    readonly provider: LlmProvider;
    readonly apiKey: string | undefined;
    readonly baseUrl: string | undefined;
    readonly model: string | undefined;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  readonly agent: {
    readonly workspace: string;
    readonly maxIterations: number;
    readonly maxRepeatedCalls: number;
    readonly maxConsecutiveFailures: number;
    readonly confirmHighRisk: boolean;
    /** 仅 mock provider 读取；为测试支撑配置 */
    readonly mockScript: readonly MockStep[] | undefined;
  };
  readonly log: {
    readonly level: LogLevel;
    readonly dir: string;
    readonly pretty: boolean;
  };
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** null 表示跳过 .env 文件，只使用传入的环境变量 */
  readonly envFilePath?: string | null;
}

export const REDACTED = '[REDACTED]';
export const UNSET = '(unset)';

export interface RedactedAppConfig {
  readonly llm: {
    readonly provider: LlmProvider;
    readonly apiKey: string;
    readonly baseUrl: string | undefined;
    readonly model: string | undefined;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  readonly agent: AppConfig['agent'];
  readonly log: AppConfig['log'];
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const envFilePath =
    options.envFilePath === undefined ? path.join(cwd, '.env') : options.envFilePath;
  const fileEnv = envFilePath === null ? {} : readEnvFile(envFilePath);
  const processEnv = options.env ?? process.env;
  const parsed = envSchema.safeParse({ ...fileEnv, ...processEnv });

  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${formatIssues(parsed.error)}`, {
      cause: parsed.error,
    });
  }

  const env = parsed.data;
  const workspace = path.resolve(cwd, env.AGENT_WORKSPACE);
  const logDir = path.isAbsolute(env.AGENT_LOG_DIR)
    ? path.resolve(env.AGENT_LOG_DIR)
    : path.resolve(workspace, env.AGENT_LOG_DIR);

  assertInsideWorkspace(workspace, logDir);

  const mockScript =
    env.LLM_PROVIDER === 'mock' ? readMockScript(workspace, env.AGENT_MOCK_SCRIPT) : undefined;

  return Object.freeze({
    llm: Object.freeze({
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    }),
    agent: Object.freeze({
      workspace,
      maxIterations: env.AGENT_MAX_ITERATIONS,
      maxRepeatedCalls: env.AGENT_MAX_REPEATED_CALLS,
      maxConsecutiveFailures: env.AGENT_MAX_CONSECUTIVE_FAILURES,
      confirmHighRisk: env.AGENT_CONFIRM_HIGH_RISK,
      mockScript,
    }),
    log: Object.freeze({
      level: env.AGENT_LOG_LEVEL,
      dir: logDir,
      pretty: env.AGENT_LOG_PRETTY,
    }),
  });
}

export function redactConfig(config: AppConfig): RedactedAppConfig {
  return {
    llm: {
      provider: config.llm.provider,
      apiKey: config.llm.apiKey === undefined ? UNSET : REDACTED,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: config.llm.maxRetries,
    },
    agent: config.agent,
    log: config.log,
  };
}

function assertInsideWorkspace(workspace: string, logDir: string): void {
  const relative = path.relative(workspace, logDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(
      `AGENT_LOG_DIR must stay inside AGENT_WORKSPACE (workspace=${workspace}, logDir=${logDir})`,
    );
  }
}

function readEnvFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw new ConfigError(`Failed to read env file: ${filePath}`, { cause: error });
  }
  return parseEnv(content);
}

function readMockScript(
  workspace: string,
  scriptPath: string | undefined,
): readonly MockStep[] | undefined {
  if (scriptPath === undefined) {
    return undefined;
  }
  const filePath = path.resolve(workspace, scriptPath);
  const relative = path.relative(workspace, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(
      `AGENT_MOCK_SCRIPT must stay inside AGENT_WORKSPACE (workspace=${workspace}, script=${filePath})`,
    );
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Failed to read AGENT_MOCK_SCRIPT: ${filePath}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`AGENT_MOCK_SCRIPT is not valid JSON: ${filePath}`, { cause: error });
  }

  const parsed = mockScriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid AGENT_MOCK_SCRIPT (${filePath}):\n${formatIssues(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${field}: ${issue.message}`;
    })
    .join('\n');
}
