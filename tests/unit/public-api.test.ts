import { describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';

describe('公共入口 src/index.ts', () => {
  it('导出配置、上下文、日志与安全工厂', () => {
    expect(typeof api.loadConfig).toBe('function');
    expect(typeof api.redactConfig).toBe('function');
    expect(typeof api.createContextManager).toBe('function');
    expect(typeof api.buildRepoMap).toBe('function');
    expect(typeof api.estimateTokens).toBe('function');
    expect(typeof api.estimateMessagesTokens).toBe('function');
    expect(typeof api.createLogger).toBe('function');
    expect(typeof api.resolveLogFilePath).toBe('function');
    expect(typeof api.createIgnoreMatcher).toBe('function');
    expect(typeof api.readPackageInfo).toBe('function');
    expect(api.LLM_PROVIDERS.length).toBeGreaterThan(0);
    expect(api.DEFAULT_IGNORED_DIRS).toContain('node_modules');
    expect(api.LOG_LEVELS).toContain('info');
  });

  it('导出的错误类型可直接构造并映射退出码', () => {
    const error = new api.AgentError(api.ErrorCode.UsageInvalid, 'bad usage');
    expect(error.code).toBe(api.ErrorCode.UsageInvalid);
    expect(api.toExitCode(error)).toBe(api.ExitCode.UsageError);
    expect(api.describeError(error)).toContain('bad usage');
    expect(api.REDACTED).toBe('[REDACTED]');
    expect(api.UNSET).toBe('(unset)');
  });
});
