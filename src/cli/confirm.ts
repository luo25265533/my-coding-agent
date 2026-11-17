import { createInterface } from 'node:readline/promises';
import type { ConfirmFn } from '../security/approval.js';

export interface CliConfirmOptions {
  /** 对应 AGENT_CONFIRM_HIGH_RISK；false 时直接允许（硬拒绝规则仍生效） */
  readonly enabled: boolean;
  /** 默认取 process.stdin.isTTY，测试可显式覆盖 */
  readonly interactive?: boolean | undefined;
  /** 注入问答函数以便测试；缺省使用 readline */
  readonly ask?: ((question: string) => Promise<string>) | undefined;
  /** 对应 AGENT_CONFIRM_TIMEOUT_MS；未提供表示不限制等待时间 */
  readonly timeoutMs?: number | undefined;
}

export function createCliConfirm(options: CliConfirmOptions): ConfirmFn {
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  return async (request) => {
    if (!options.enabled) {
      return true;
    }
    if (!interactive) {
      process.stdout.write(`high-risk action denied (non-interactive): ${request.summary}\n`);
      return false;
    }

    const lines = [request.summary];
    if (request.detail !== undefined && request.detail !== request.summary) {
      lines.push(`  ${request.detail}`);
    }
    lines.push('Allow? [y/N] ');
    const answer = await ask(lines.join('\n'), options.ask, options.timeoutMs);
    if (answer === undefined) {
      const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
      process.stdout.write(`no response within ${seconds}s — auto-denied\n`);
      return false;
    }
    return /^y(es)?$/i.test(answer.trim());
  };
}

async function ask(
  question: string,
  injected: ((question: string) => Promise<string>) | undefined,
  timeoutMs: number | undefined,
): Promise<string | undefined> {
  if (injected !== undefined) {
    return timeoutMs === undefined
      ? injected(question)
      : raceTimeout(injected(question), timeoutMs);
  }

  const controller = new AbortController();
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return undefined;
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    rl.close();
  }
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
