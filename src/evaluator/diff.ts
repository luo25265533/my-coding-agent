import path from 'node:path';
import { sanitizeChildEnv } from '../security/child-env.js';
import { throwIfAborted } from '../shared/abort.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { runProcess, type ShellResult } from '../shared/shell.js';
import type { DiffFile, DiffFileStatus, DiffSummary } from './types.js';

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_FILES = 500;
const REASON_MAX_CHARS = 200;
/** 静态资源扩展名；不含 .txt/.json 等可能被测试引用的文本文件 */
const STATIC_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
]);

export interface CollectDiffOptions {
  readonly workspace: string;
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface FileCounts {
  readonly insertions: number | null;
  readonly deletions: number | null;
}

interface StatusEntry {
  readonly path: string;
  readonly status: DiffFileStatus;
}

export async function collectDiff(options: CollectDiffOptions): Promise<DiffSummary> {
  throwIfAborted(options.signal);
  const env = gitEnv(options.env ?? process.env);

  const status = await runGit(
    options.workspace,
    [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
    ],
    options.signal,
    env,
  );
  assertNotAborted(status, 'status');
  if (status.spawnError !== undefined) {
    return unavailable(`git is not available: ${status.spawnError}`);
  }
  if (status.code !== 0) {
    return unavailable(gitFailure(status, 'status'));
  }

  const unstaged = await runGit(
    options.workspace,
    ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '--no-renames'],
    options.signal,
    env,
  );
  assertNotAborted(unstaged, 'diff');
  const staged = await runGit(
    options.workspace,
    ['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat', '-z', '--no-renames'],
    options.signal,
    env,
  );
  assertNotAborted(staged, 'diff --cached');

  for (const result of [unstaged, staged]) {
    if (result.spawnError !== undefined) {
      return unavailable(`git is not available: ${result.spawnError}`);
    }
    if (result.code !== 0) {
      return unavailable(gitFailure(result, 'diff'));
    }
  }

  return summarize(parseStatus(status.stdout), mergeNumstat(unstaged.stdout, staged.stdout));
}

/**
 * 任务开始与结束各采集一次快照；只保留新出现、状态变化或行数变化的文件。
 * 基线不可用时无法隔离任务改动，原样返回当前快照。
 */
export function diffSince(baseline: DiffSummary, current: DiffSummary): DiffSummary {
  if (!baseline.available || !current.available) {
    return current;
  }
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const files = current.files.filter((file) => {
    const previous = before.get(file.path);
    return (
      previous === undefined ||
      previous.status !== file.status ||
      previous.insertions !== file.insertions ||
      previous.deletions !== file.deletions
    );
  });
  const totals = sumTotals(files);
  return {
    available: true,
    reason: undefined,
    files,
    totalInsertions: totals.insertions,
    totalDeletions: totals.deletions,
    truncated: current.truncated,
  };
}

/**
 * 判定改动是否只涉及静态资源（含零改动）；快照不可用或已截断时保守返回 false。
 */
export function isStaticOnlyDiff(diff: DiffSummary): boolean {
  if (!diff.available || diff.truncated) {
    return false;
  }
  return diff.files.every((file) => STATIC_EXTENSIONS.has(path.extname(file.path).toLowerCase()));
}

function runGit(
  workspace: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<ShellResult> {
  return runProcess('git', args, {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
    signal,
  });
}

function gitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...sanitizeChildEnv(source),
    GIT_TERMINAL_PROMPT: '0',
    GIT_EXTERNAL_DIFF: '',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function assertNotAborted(result: ShellResult, label: string): void {
  if (result.aborted) {
    throw new AgentError(ErrorCode.LlmAborted, `git ${label} aborted`);
  }
}

function gitFailure(result: ShellResult, label: string): string {
  if (result.spawnError !== undefined) {
    return `git is not available: ${result.spawnError}`;
  }
  if (result.timedOut) {
    return `git ${label} timed out`;
  }
  const text = `${result.stderr}\n${result.stdout}`;
  if (/not a git repository/i.test(text)) {
    return 'not a git repository';
  }
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first === undefined) {
    return `git ${label} exited with code ${result.code ?? 'unknown'}`;
  }
  return `git ${label} failed: ${first.slice(0, REASON_MAX_CHARS)}`;
}

function unavailable(reason: string): DiffSummary {
  return {
    available: false,
    reason,
    files: [],
    totalInsertions: 0,
    totalDeletions: 0,
    truncated: false,
  };
}

function parseStatus(text: string): readonly StatusEntry[] {
  const byPath = new Map<string, DiffFileStatus>();
  for (const record of splitNul(text)) {
    if (record.length < 4) {
      continue;
    }
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath === '') {
      continue;
    }
    byPath.set(filePath, mapStatus(code));
  }
  return [...byPath.entries()]
    .map(([filePath, status]) => ({ path: filePath, status }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function mapStatus(code: string): DiffFileStatus {
  if (code === '??') {
    return 'untracked';
  }
  if (code.includes('U') || code === 'AA' || code === 'DD') {
    return 'other';
  }
  if (code.includes('R') || code.includes('C')) {
    return 'other';
  }
  if (code.includes('A')) {
    return 'added';
  }
  if (code.includes('D')) {
    return 'deleted';
  }
  if (code.includes('M') || code.includes('T')) {
    return 'modified';
  }
  return 'other';
}

function mergeNumstat(...texts: readonly string[]): Map<string, FileCounts> {
  const counts = new Map<string, FileCounts>();
  for (const text of texts) {
    for (const record of splitNul(text)) {
      const parsed = parseNumstatRecord(record);
      if (parsed === undefined) {
        continue;
      }
      const previous = counts.get(parsed.path);
      counts.set(parsed.path, {
        insertions: mergeCount(previous?.insertions, parsed.insertions),
        deletions: mergeCount(previous?.deletions, parsed.deletions),
      });
    }
  }
  return counts;
}

function parseNumstatRecord(record: string):
  | {
      readonly path: string;
      readonly insertions: number | null;
      readonly deletions: number | null;
    }
  | undefined {
  const firstTab = record.indexOf('\t');
  if (firstTab < 0) {
    return undefined;
  }
  const secondTab = record.indexOf('\t', firstTab + 1);
  if (secondTab < 0) {
    return undefined;
  }
  const filePath = record.slice(secondTab + 1);
  if (filePath === '') {
    return undefined;
  }
  return {
    path: filePath,
    insertions: parseCount(record.slice(0, firstTab)),
    deletions: parseCount(record.slice(firstTab + 1, secondTab)),
  };
}

function parseCount(text: string): number | null {
  if (text === '-') {
    return null;
  }
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

function mergeCount(current: number | null | undefined, next: number | null): number | null {
  if (next === null) {
    return current ?? null;
  }
  return (current ?? 0) + next;
}

function summarize(
  entries: readonly StatusEntry[],
  counts: ReadonlyMap<string, FileCounts>,
): DiffSummary {
  const allFiles: DiffFile[] = entries.map((entry) => {
    const count = counts.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      insertions: count?.insertions ?? null,
      deletions: count?.deletions ?? null,
    };
  });
  const truncated = allFiles.length > MAX_DIFF_FILES;
  const files = truncated ? allFiles.slice(0, MAX_DIFF_FILES) : allFiles;
  const totals = sumTotals(files);
  return {
    available: true,
    reason: undefined,
    files,
    totalInsertions: totals.insertions,
    totalDeletions: totals.deletions,
    truncated,
  };
}

function sumTotals(files: readonly DiffFile[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { insertions, deletions };
}

function splitNul(text: string): readonly string[] {
  return text.split('\0').filter((entry) => entry !== '');
}
