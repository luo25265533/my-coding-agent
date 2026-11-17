import { describe, expect, it } from 'vitest';
import { redactSecretValues, sanitizeChildEnv } from '../../src/security/child-env.js';

describe('sanitizeChildEnv', () => {
  it('删除密钥类变量并保留普通变量', () => {
    expect(
      sanitizeChildEnv({
        PATH: '/bin',
        LLM_API_KEY: 'sk-secret',
        GITHUB_TOKEN: 'token',
        DB_PASSWORD: 'password',
        AWS_CREDENTIAL: 'credential',
        HOME: '/home/u',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/home/u' });
  });
});

describe('redactSecretValues', () => {
  it('替换环境中的长密钥值', () => {
    expect(
      redactSecretValues('api=sk-123456 token=abcdefgh other=keep', {
        LLM_API_KEY: 'sk-123456',
        GITHUB_TOKEN: 'abcdefgh',
        OTHER: 'keep',
      }),
    ).toBe('api=[REDACTED] token=[REDACTED] other=keep');
  });

  it('按长度优先替换，避免短值先破坏长值', () => {
    expect(
      redactSecretValues('value=secret-long', {
        SHORT_SECRET: 'secret',
        LONG_SECRET: 'secret-long',
      }),
    ).toBe('value=[REDACTED]');
  });

  it('忽略短值、空值与已脱敏占位符', () => {
    expect(
      redactSecretValues('abc [REDACTED]', {
        SHORT_TOKEN: 'abc',
        EMPTY_SECRET: '',
        ALREADY_SECRET: '[REDACTED]',
      }),
    ).toBe('abc [REDACTED]');
  });

  it('正则特殊字符按字面替换', () => {
    expect(redactSecretValues('prefix a.b*c$d suffix', { MY_SECRET: 'a.b*c$d' })).toBe(
      'prefix [REDACTED] suffix',
    );
  });

  it('文本中没有密钥时原样返回', () => {
    expect(redactSecretValues('nothing here', { LLM_API_KEY: 'sk-123456' })).toBe('nothing here');
  });
});
