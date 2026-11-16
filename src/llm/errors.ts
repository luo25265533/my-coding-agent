import { AgentError, ErrorCode } from '../shared/errors.js';

/** 智谱实测：429 + code=1113 表示配额耗尽，属永久失败，与限流同状态码但不可重试 */
export const QUOTA_EXHAUSTED_CODE = '1113';

export interface LlmErrorDetails {
  readonly status?: number | undefined;
  readonly providerCode?: string | undefined;
  readonly retryable?: boolean | undefined;
}

export class LlmError extends AgentError {
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    details: LlmErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'LlmError';
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.retryable = details.retryable ?? false;
  }
}

export interface HttpFailure {
  readonly status: number;
  readonly providerCode: string | undefined;
  readonly serverMessage: string | undefined;
}

export function classifyHttpError(failure: HttpFailure): LlmError {
  const { status, providerCode } = failure;
  const detail = failure.serverMessage ?? '(no message)';
  const codeSuffix = providerCode === undefined ? '' : `, code=${providerCode}`;
  const details: LlmErrorDetails = { status, providerCode };

  if (status === 401 || status === 403) {
    return new LlmError(
      ErrorCode.LlmAuth,
      `LLM authentication failed (HTTP ${status}${codeSuffix}): ${detail}. Check LLM_API_KEY.`,
      { ...details, retryable: false },
    );
  }

  if (status === 429 && providerCode === QUOTA_EXHAUSTED_CODE) {
    return new LlmError(
      ErrorCode.LlmQuota,
      `LLM quota exhausted (HTTP 429${codeSuffix}): ${detail}. Recharge, or use the endpoint your plan covers.`,
      { ...details, retryable: false },
    );
  }

  if (status === 429) {
    return new LlmError(
      ErrorCode.LlmRateLimit,
      `LLM rate limited (HTTP 429${codeSuffix}): ${detail}`,
      {
        ...details,
        retryable: true,
      },
    );
  }

  if (status >= 500) {
    return new LlmError(ErrorCode.LlmBadResponse, `LLM server error (HTTP ${status}): ${detail}`, {
      ...details,
      retryable: true,
    });
  }

  return new LlmError(
    ErrorCode.LlmBadResponse,
    `LLM request rejected (HTTP ${status}${codeSuffix}): ${detail}`,
    { ...details, retryable: false },
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function classifyFetchError(error: unknown, timedOut: boolean): LlmError {
  if (isAbortError(error)) {
    if (timedOut) {
      return new LlmError(
        ErrorCode.LlmTimeout,
        'LLM request timed out',
        { retryable: true },
        { cause: error },
      );
    }
    return new LlmError(
      ErrorCode.LlmAborted,
      'LLM request aborted',
      { retryable: false },
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(
    ErrorCode.LlmNetwork,
    `LLM network failure: ${message}`,
    { retryable: true },
    { cause: error },
  );
}

export function badResponseError(message: string, cause?: unknown): LlmError {
  return new LlmError(
    ErrorCode.LlmBadResponse,
    `LLM returned an unusable response: ${message}`,
    { retryable: false },
    cause === undefined ? undefined : { cause },
  );
}
