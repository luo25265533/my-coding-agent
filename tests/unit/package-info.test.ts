import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import { readPackageInfo } from '../../src/shared/package-info.js';

const mocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }));

describe('readPackageInfo 异常与校验', () => {
  beforeEach(() => {
    mocks.readFileSync.mockReset();
  });

  it('读取失败时抛出 Internal 错误并保留原因', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const error = (() => {
      try {
        return readPackageInfo();
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.Internal);
    expect((error as AgentError).message).toContain('Failed to read package.json');
  });

  it('JSON 非法时同样归类为 Internal 错误', () => {
    mocks.readFileSync.mockReturnValue('not json');
    expect(() => readPackageInfo()).toThrowError(/Failed to read package\.json/);
  });

  it('缺少 name 或 version 时拒绝', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({ name: 'only-name' }));
    expect(() => readPackageInfo()).toThrowError('package.json must contain name and version');
  });

  it('合法时返回裁剪后的字段', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({ name: 'pkg', version: '1.0.0', extra: 1 }));
    expect(readPackageInfo()).toEqual({ name: 'pkg', version: '1.0.0' });
  });
});
