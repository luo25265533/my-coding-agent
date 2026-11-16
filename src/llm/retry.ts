export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

/** Retry-After 支持秒数与 HTTP-date 两种形式，无法解析时返回 undefined 交由退避决定 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now);
}

export interface BackoffInput {
  /** 0-based，第几次重试 */
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryAfterMs: number | undefined;
  readonly random: () => number;
}

export function computeBackoffDelay(input: BackoffInput): number {
  const ceiling = Math.min(input.baseDelayMs * 2 ** input.attempt, input.maxDelayMs);
  if (input.retryAfterMs !== undefined) {
    return Math.min(input.retryAfterMs, input.maxDelayMs);
  }
  // equal jitter：一半固定一半随机，既打散并发又不会退化成 0 延迟
  const half = ceiling / 2;
  return Math.round(half + input.random() * half);
}
