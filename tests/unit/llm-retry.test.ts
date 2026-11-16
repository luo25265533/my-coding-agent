import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  parseRetryAfter,
} from '../../src/llm/retry.js';

describe('parseRetryAfter', () => {
  it('null 与空串返回 undefined', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
  });

  it('秒数转毫秒', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(' 3 ')).toBe(3000);
  });

  it('负数被夹到 0', () => {
    expect(parseRetryAfter('-5')).toBe(0);
  });

  it('HTTP-date 按与 now 的差值计算', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    const later = '2026-11-13T00:00:05Z';
    expect(parseRetryAfter(later, now)).toBe(5000);
  });

  it('已过去的 HTTP-date 夹到 0', () => {
    const now = Date.parse('2026-11-13T00:00:10Z');
    expect(parseRetryAfter('2026-11-13T00:00:00Z', now)).toBe(0);
  });

  it('无法解析时返回 undefined', () => {
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('computeBackoffDelay', () => {
  const base = { baseDelayMs: 100, maxDelayMs: 8000, retryAfterMs: undefined, random: () => 0.5 };

  it('指数增长并受上限约束', () => {
    expect(computeBackoffDelay({ ...base, attempt: 0 })).toBe(75);
    expect(computeBackoffDelay({ ...base, attempt: 1 })).toBe(150);
    expect(computeBackoffDelay({ ...base, attempt: 2 })).toBe(300);
    expect(computeBackoffDelay({ ...base, attempt: 20 })).toBe(6000);
  });

  it('equal jitter 落在 ceiling 的一半到全额之间', () => {
    expect(computeBackoffDelay({ ...base, attempt: 0, random: () => 0 })).toBe(50);
    expect(computeBackoffDelay({ ...base, attempt: 0, random: () => 1 })).toBe(100);
  });

  it('Retry-After 优先于指数退避', () => {
    expect(computeBackoffDelay({ ...base, attempt: 5, retryAfterMs: 1234 })).toBe(1234);
  });

  it('Retry-After 也受上限约束', () => {
    expect(computeBackoffDelay({ ...base, attempt: 0, retryAfterMs: 99_999 })).toBe(8000);
  });

  it('默认常量合理', () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(500);
    expect(DEFAULT_MAX_DELAY_MS).toBe(8000);
  });
});
