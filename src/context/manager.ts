import type { Logger } from 'pino';
import type { ChatMessage } from '../llm/types.js';
import type { IgnoreMatcher } from '../security/ignore.js';
import { buildRepoMap, type RepoMapResult } from './repo-map.js';
import { estimateMessagesTokens, estimateTokens } from './token-budget.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const MIN_REPO_MAP_TOKENS = 200;
const REPO_MAP_BUDGET_RATIO = 0.3;
const MIN_TOOL_CONTENT_CHARS = 200;
const TOOL_HEAD_RATIO = 0.6;
/** 相邻任务的预算差异不超过该值时复用仓库地图，避免逐步执行时重复扫描 */
const REPO_MAP_CACHE_TOLERANCE = 64;

export interface ContextStats {
  readonly budgetTokens: number;
  readonly repoMapTokens: number;
  readonly repoMapFiles: number;
  readonly repoMapTruncated: boolean;
  readonly repoMapDropped: boolean;
  readonly initialTokens: number;
  readonly droppedMessages: number;
  readonly truncatedToolMessages: number;
  readonly lastRequestTokens: number;
}

export interface ContextManager {
  readonly budgetTokens: number;
  buildMessages(task: string): Promise<readonly ChatMessage[]>;
  /** 返回本次请求可用的消息视图；不修改传入数组 */
  fit(messages: readonly ChatMessage[]): readonly ChatMessage[];
  stats(): ContextStats;
}

export interface CreateContextManagerOptions {
  readonly workspace: string;
  readonly budgetTokens: number;
  readonly ignore: IgnoreMatcher;
  readonly systemPrompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
}

export function createContextManager(options: CreateContextManagerOptions): ContextManager {
  const stats = {
    budgetTokens: options.budgetTokens,
    repoMapTokens: 0,
    repoMapFiles: 0,
    repoMapTruncated: false,
    repoMapDropped: false,
    initialTokens: 0,
    droppedMessages: 0,
    truncatedToolMessages: 0,
    lastRequestTokens: 0,
  };
  let cached: { task: string; messages: readonly ChatMessage[] } | undefined;
  let repoMapCache: { budget: number; result: RepoMapResult } | undefined;

  return {
    budgetTokens: options.budgetTokens,
    async buildMessages(task: string): Promise<readonly ChatMessage[]> {
      if (cached !== undefined && cached.task === task) {
        return cached.messages;
      }
      const mapBudget = repoMapBudget(options, task);
      const cachedMap =
        repoMapCache !== undefined &&
        Math.abs(repoMapCache.budget - mapBudget) <= REPO_MAP_CACHE_TOLERANCE
          ? repoMapCache.result
          : undefined;
      const map =
        mapBudget >= MIN_REPO_MAP_TOKENS
          ? (cachedMap ??
            (await buildRepoMap({
              workspace: options.workspace,
              budgetTokens: mapBudget,
              ignore: options.ignore,
              signal: options.signal,
              logger: options.logger,
            })))
          : undefined;
      if (map !== undefined && cachedMap === undefined) {
        repoMapCache = { budget: mapBudget, result: map };
      }

      stats.repoMapTokens = map?.estimatedTokens ?? 0;
      stats.repoMapFiles = map?.filesScanned ?? 0;
      stats.repoMapTruncated = map?.truncated ?? false;
      stats.repoMapDropped = mapBudget < MIN_REPO_MAP_TOKENS && options.budgetTokens > 0;
      if (stats.repoMapDropped) {
        options.logger?.info(
          { budgetTokens: options.budgetTokens, repoMapBudget: mapBudget },
          'repo map dropped to fit budget',
        );
      }

      const systemContent =
        map === undefined || map.text === ''
          ? options.systemPrompt
          : `${options.systemPrompt}\n\n${map.text}`;
      let messages: readonly ChatMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: task },
      ];
      if (map !== undefined && estimateMessagesTokens(messages) > options.budgetTokens) {
        // 系统提示与任务本身已占满预算时，优先丢掉仓库地图，保留原始指令
        messages = [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: task },
        ];
        stats.repoMapDropped = true;
        options.logger?.info(
          { budgetTokens: options.budgetTokens, repoMapTokens: stats.repoMapTokens },
          'repo map dropped to fit budget',
        );
      }
      stats.initialTokens = estimateMessagesTokens(messages);
      cached = { task, messages };
      options.logger?.info(
        {
          budgetTokens: options.budgetTokens,
          repoMapTokens: stats.repoMapTokens,
          filesScanned: stats.repoMapFiles,
          repoMapTruncated: stats.repoMapTruncated,
          repoMapDropped: stats.repoMapDropped,
          initialTokens: stats.initialTokens,
        },
        'context built',
      );
      return messages;
    },

    fit(messages: readonly ChatMessage[]): readonly ChatMessage[] {
      const estimated = estimateMessagesTokens(messages);
      if (estimated <= options.budgetTokens) {
        stats.lastRequestTokens = estimated;
        return messages;
      }

      const fitted = fitToBudget(messages, options.budgetTokens, stats);
      stats.lastRequestTokens = estimateMessagesTokens(fitted);
      if (stats.droppedMessages > 0 || stats.truncatedToolMessages > 0) {
        options.logger?.info(
          {
            budgetTokens: options.budgetTokens,
            beforeTokens: estimated,
            afterTokens: stats.lastRequestTokens,
            droppedMessages: stats.droppedMessages,
            truncatedToolMessages: stats.truncatedToolMessages,
          },
          'context trimmed',
        );
      }
      return fitted;
    },

    stats(): ContextStats {
      return Object.freeze({ ...stats });
    },
  };
}

function repoMapBudget(options: CreateContextManagerOptions, task: string): number {
  const reserved =
    estimateTokens(options.systemPrompt) + estimateTokens(task) + 2 * MESSAGE_OVERHEAD_TOKENS + 32;
  const available = options.budgetTokens - reserved;
  return Math.max(0, Math.min(Math.floor(options.budgetTokens * REPO_MAP_BUDGET_RATIO), available));
}

function fitToBudget(
  messages: readonly ChatMessage[],
  budgetTokens: number,
  stats: MutableStats,
): readonly ChatMessage[] {
  const system = messages[0];
  if (system === undefined) {
    return messages;
  }
  const taskMessage = messages[1]?.role === 'user' ? messages[1] : undefined;
  const historyStart = taskMessage === undefined ? 1 : 2;
  const groups = groupMessages(messages.slice(historyStart));

  const base: ChatMessage[] = taskMessage === undefined ? [system] : [system, taskMessage];
  let used = estimateMessagesTokens(base);
  const kept: ChatMessage[][] = [];
  let dropped = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) {
      continue;
    }
    const cost = estimateMessagesTokens(group);
    if (used + cost <= budgetTokens) {
      kept.unshift(group);
      used += cost;
    } else {
      dropped = index + 1;
      break;
    }
  }
  if (kept.length === 0 && groups.length > 0) {
    const newest = groups[groups.length - 1];
    if (newest !== undefined) {
      kept.push(newest);
      dropped = groups.length - 1;
    }
  }
  stats.droppedMessages += groups.slice(0, dropped).reduce((sum, group) => sum + group.length, 0);

  let result: ChatMessage[] = rebuild(base, dropped, kept);
  if (estimateMessagesTokens(result) > budgetTokens) {
    result = [...shrinkToolMessages(result, budgetTokens, stats)];
  }

  while (estimateMessagesTokens(result) > budgetTokens && kept.length > 0) {
    const removed = kept.shift();
    if (removed === undefined) {
      break;
    }
    stats.droppedMessages += removed.length;
    result = rebuild(base, dropped, kept);
  }

  return result;
}

function rebuild(
  base: readonly ChatMessage[],
  dropped: number,
  kept: readonly ChatMessage[][],
): ChatMessage[] {
  const result: ChatMessage[] = [...base];
  if (dropped > 0) {
    result.push({
      role: 'system',
      content: `[context budget] Omitted ${dropped} earlier message group(s) to stay within the token budget.`,
    });
  }
  for (const group of kept) {
    result.push(...group);
  }
  return result;
}

function shrinkToolMessages(
  messages: readonly ChatMessage[],
  budgetTokens: number,
  stats: MutableStats,
): readonly ChatMessage[] {
  let current = [...messages];
  const truncated = new Set<number>();
  while (estimateMessagesTokens(current) > budgetTokens) {
    let targetIndex = -1;
    let targetLength = MIN_TOOL_CONTENT_CHARS;
    current.forEach((message, index) => {
      if (message.role === 'tool' && message.content.length > targetLength) {
        targetIndex = index;
        targetLength = message.content.length;
      }
    });
    if (targetIndex === -1) {
      break;
    }

    const target = current[targetIndex];
    if (target === undefined || target.role !== 'tool') {
      break;
    }
    const nextLength = Math.max(MIN_TOOL_CONTENT_CHARS, Math.floor(target.content.length / 2));
    const content = truncateMiddle(target.content, nextLength);
    if (!truncated.has(targetIndex)) {
      truncated.add(targetIndex);
      stats.truncatedToolMessages += 1;
    }
    current = [
      ...current.slice(0, targetIndex),
      { role: 'tool', toolCallId: target.toolCallId, content },
      ...current.slice(targetIndex + 1),
    ];
  }
  return current;
}

/** 保留约 60% 头部与 40% 尾部，避免丢失命令末尾的错误信息 */
function truncateMiddle(content: string, targetChars: number): string {
  const originalLength = markerOriginalLength(content);
  const headChars = Math.floor(targetChars * TOOL_HEAD_RATIO);
  const tailChars = targetChars - headChars;
  const marker = `\n... (middle truncated; was ${originalLength} chars) ...\n`;
  const clipped =
    headChars <= 0 || tailChars <= 0
      ? ''
      : `${content.slice(0, headChars)}${marker}${content.slice(content.length - tailChars)}`;
  if (clipped !== '' && clipped.length < content.length) {
    return clipped;
  }
  return `(tool output omitted to fit context budget; was ${originalLength} chars)`;
}

function markerOriginalLength(content: string): number {
  const matched = /\(middle truncated; was (\d+) chars\)/.exec(content);
  const parsed = matched?.[1];
  if (parsed !== undefined) {
    const value = Number.parseInt(parsed, 10);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return content.length;
}

function groupMessages(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'tool' && groups.length > 0) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last[0]?.role === 'assistant') {
        last.push(message);
        continue;
      }
    }
    groups.push([message]);
  }
  return groups;
}

interface MutableStats {
  droppedMessages: number;
  truncatedToolMessages: number;
}
