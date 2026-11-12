import { describe, expect, it } from 'vitest';
import {
  AgentError,
  ConfigError,
  describeError,
  ErrorCode,
  ExitCode,
  toExitCode,
} from '../../src/shared/errors.js';

describe('AgentError', () => {
  it('携带错误码、名称并映射到运行时退出码', () => {
    const error = new AgentError(ErrorCode.Internal, 'boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AgentError');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('boom');
    expect(error.exitCode).toBe(ExitCode.RuntimeError);
  });

  it('保留 cause 链', () => {
    const cause = new Error('root cause');
    const error = new AgentError(ErrorCode.LogSetupFailed, 'wrapped', { cause });
    expect(error.cause).toBe(cause);
  });

  it('每个 ErrorCode 都有确定的退出码映射', () => {
    for (const code of Object.values(ErrorCode)) {
      const exitCode = new AgentError(code, 'x').exitCode;
      expect([ExitCode.RuntimeError, ExitCode.UsageError]).toContain(exitCode);
    }
  });
});

describe('ConfigError', () => {
  it('是 AgentError 子类且映射到用法错误退出码 2', () => {
    const error = new ConfigError('bad config');
    expect(error).toBeInstanceOf(AgentError);
    expect(error.name).toBe('ConfigError');
    expect(error.code).toBe(ErrorCode.ConfigInvalid);
    expect(error.exitCode).toBe(ExitCode.UsageError);
  });
});

describe('toExitCode', () => {
  it('AgentError 使用自身映射', () => {
    expect(toExitCode(new ConfigError('x'))).toBe(ExitCode.UsageError);
    expect(toExitCode(new AgentError(ErrorCode.Internal, 'x'))).toBe(ExitCode.RuntimeError);
  });

  it('普通 Error 归为运行时错误', () => {
    expect(toExitCode(new Error('x'))).toBe(ExitCode.RuntimeError);
  });

  it('非 Error 值归为运行时错误', () => {
    expect(toExitCode('oops')).toBe(ExitCode.RuntimeError);
    expect(toExitCode(undefined)).toBe(ExitCode.RuntimeError);
  });
});

describe('describeError', () => {
  it('Error 取 message', () => {
    expect(describeError(new Error('detail'))).toBe('detail');
  });

  it('非 Error 转为字符串', () => {
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
  });
});
