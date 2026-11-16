import { describe, expect, it } from 'vitest';
import { ErrorCode, ExitCode } from '../../src/shared/errors.js';
import {
  badResponseError,
  classifyFetchError,
  classifyHttpError,
  isAbortError,
  LlmError,
  QUOTA_EXHAUSTED_CODE,
} from '../../src/llm/errors.js';

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

describe('classifyHttpError', () => {
  it('401/403 归为鉴权失败且不可重试', () => {
    for (const status of [401, 403]) {
      const error = classifyHttpError({
        status,
        providerCode: undefined,
        serverMessage: 'bad key',
      });
      expect(error.code).toBe(ErrorCode.LlmAuth);
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(status);
      expect(error.message).toContain('LLM_API_KEY');
    }
  });

  it('429 + code=1113 归为配额耗尽且不可重试', () => {
    const error = classifyHttpError({
      status: 429,
      providerCode: QUOTA_EXHAUSTED_CODE,
      serverMessage: '余额不足或无可用资源包,请充值。',
    });
    expect(error.code).toBe(ErrorCode.LlmQuota);
    expect(error.retryable).toBe(false);
    expect(error.providerCode).toBe('1113');
    expect(error.message).toContain('1113');
  });

  it('429 非 1113 归为限流且可重试', () => {
    const error = classifyHttpError({
      status: 429,
      providerCode: '1302',
      serverMessage: 'rate limited',
    });
    expect(error.code).toBe(ErrorCode.LlmRateLimit);
    expect(error.retryable).toBe(true);
  });

  it('429 无 code 时按限流处理', () => {
    const error = classifyHttpError({
      status: 429,
      providerCode: undefined,
      serverMessage: undefined,
    });
    expect(error.code).toBe(ErrorCode.LlmRateLimit);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('(no message)');
  });

  it('5xx 可重试', () => {
    for (const status of [500, 502, 503]) {
      const error = classifyHttpError({ status, providerCode: undefined, serverMessage: 'oops' });
      expect(error.code).toBe(ErrorCode.LlmBadResponse);
      expect(error.retryable).toBe(true);
    }
  });

  it('400/404/422 不可重试', () => {
    for (const status of [400, 404, 422]) {
      const error = classifyHttpError({
        status,
        providerCode: '400',
        serverMessage: 'bad request',
      });
      expect(error.code).toBe(ErrorCode.LlmBadResponse);
      expect(error.retryable).toBe(false);
    }
  });

  it('全部映射到运行时退出码 1', () => {
    const error = classifyHttpError({
      status: 401,
      providerCode: undefined,
      serverMessage: undefined,
    });
    expect(error.exitCode).toBe(ExitCode.RuntimeError);
    expect(error).toBeInstanceOf(LlmError);
  });
});

describe('isAbortError', () => {
  it('按 name 判定而非消息文本', () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new Error('aborted'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('classifyFetchError', () => {
  it('超时中止归为 LlmTimeout 且可重试', () => {
    const error = classifyFetchError(abortError(), true);
    expect(error.code).toBe(ErrorCode.LlmTimeout);
    expect(error.retryable).toBe(true);
  });

  it('用户中止归为 LlmAborted 且不可重试', () => {
    const error = classifyFetchError(abortError(), false);
    expect(error.code).toBe(ErrorCode.LlmAborted);
    expect(error.retryable).toBe(false);
  });

  it('网络异常归为 LlmNetwork 且可重试', () => {
    const error = classifyFetchError(new Error('ECONNRESET'), false);
    expect(error.code).toBe(ErrorCode.LlmNetwork);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNRESET');
  });

  it('非 Error 值也能归类', () => {
    expect(classifyFetchError('boom', false).code).toBe(ErrorCode.LlmNetwork);
  });

  it('保留 cause 链', () => {
    const cause = abortError();
    expect(classifyFetchError(cause, true).cause).toBe(cause);
  });
});

describe('badResponseError', () => {
  it('不可重试且可携带 cause', () => {
    const cause = new Error('root');
    const error = badResponseError('broken payload', cause);
    expect(error.code).toBe(ErrorCode.LlmBadResponse);
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('broken payload');
  });

  it('无 cause 时不设置该属性', () => {
    expect(badResponseError('x').cause).toBeUndefined();
  });
});
