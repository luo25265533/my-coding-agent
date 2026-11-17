export const ExitCode = {
  Success: 0,
  RuntimeError: 1,
  UsageError: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const ErrorCode = {
  ConfigInvalid: 'CONFIG_INVALID',
  UsageInvalid: 'USAGE_INVALID',
  LogSetupFailed: 'LOG_SETUP_FAILED',
  Internal: 'INTERNAL_ERROR',
  LlmAuth: 'LLM_AUTH',
  LlmQuota: 'LLM_QUOTA',
  LlmRateLimit: 'LLM_RATE_LIMIT',
  LlmTimeout: 'LLM_TIMEOUT',
  LlmNetwork: 'LLM_NETWORK',
  LlmBadResponse: 'LLM_BAD_RESPONSE',
  LlmAborted: 'LLM_ABORTED',
  PathDenied: 'PATH_DENIED',
  AgentMaxIterations: 'AGENT_MAX_ITERATIONS',
  AgentIncomplete: 'AGENT_INCOMPLETE',
  PlannerInvalid: 'PLANNER_INVALID',
  TaskNotFound: 'TASK_NOT_FOUND',
  TaskInvalid: 'TASK_INVALID',
  TaskStorage: 'TASK_STORAGE',
  VerificationFailed: 'VERIFICATION_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const EXIT_CODE_BY_ERROR_CODE: Record<ErrorCode, ExitCode> = {
  [ErrorCode.ConfigInvalid]: ExitCode.UsageError,
  [ErrorCode.UsageInvalid]: ExitCode.UsageError,
  [ErrorCode.LogSetupFailed]: ExitCode.RuntimeError,
  [ErrorCode.Internal]: ExitCode.RuntimeError,
  [ErrorCode.LlmAuth]: ExitCode.RuntimeError,
  [ErrorCode.LlmQuota]: ExitCode.RuntimeError,
  [ErrorCode.LlmRateLimit]: ExitCode.RuntimeError,
  [ErrorCode.LlmTimeout]: ExitCode.RuntimeError,
  [ErrorCode.LlmNetwork]: ExitCode.RuntimeError,
  [ErrorCode.LlmBadResponse]: ExitCode.RuntimeError,
  [ErrorCode.LlmAborted]: ExitCode.RuntimeError,
  [ErrorCode.PathDenied]: ExitCode.RuntimeError,
  [ErrorCode.AgentMaxIterations]: ExitCode.RuntimeError,
  [ErrorCode.AgentIncomplete]: ExitCode.RuntimeError,
  [ErrorCode.PlannerInvalid]: ExitCode.RuntimeError,
  [ErrorCode.TaskNotFound]: ExitCode.UsageError,
  [ErrorCode.TaskInvalid]: ExitCode.UsageError,
  [ErrorCode.TaskStorage]: ExitCode.RuntimeError,
  [ErrorCode.VerificationFailed]: ExitCode.RuntimeError,
};

export class AgentError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentError';
    this.code = code;
  }

  get exitCode(): ExitCode {
    return EXIT_CODE_BY_ERROR_CODE[this.code];
  }
}

export class ConfigError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.ConfigInvalid, message, options);
    this.name = 'ConfigError';
  }
}

export function toExitCode(error: unknown): ExitCode {
  return error instanceof AgentError ? error.exitCode : ExitCode.RuntimeError;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
