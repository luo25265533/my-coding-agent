import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { IgnoreMatcher } from '../security/ignore.js';
import { walkEntries, type WalkEntry } from '../security/walk.js';
import { throwIfAborted } from '../shared/abort.js';
import { describeError } from '../shared/errors.js';
import { estimateTokens } from './token-budget.js';

const MAX_SCAN_ENTRIES = 2000;
const MAX_TREE_DEPTH = 3;
const MAX_TREE_LINES = 300;
const MAX_LANGUAGES = 10;
const MAX_SCRIPTS = 8;
const MAX_TOP_LEVEL = 12;

export interface RepoMapResult {
  readonly text: string;
  readonly filesScanned: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export interface RepoMapOptions {
  readonly workspace: string;
  readonly budgetTokens: number;
  readonly ignore: IgnoreMatcher;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
}

export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  if (options.budgetTokens <= 0) {
    return { text: '', filesScanned: 0, estimatedTokens: 0, truncated: true };
  }

  let entries: WalkEntry[];
  try {
    entries = await collectEntries(options);
  } catch (error) {
    throwIfAborted(options.signal);
    options.logger?.warn({ reason: describeError(error) }, 'repo map scan failed');
    const text = `Project overview unavailable: ${describeError(error)}`;
    return {
      text,
      filesScanned: 0,
      estimatedTokens: estimateTokens(text),
      truncated: true,
    };
  }

  const files = entries.filter((entry) => entry.type === 'file');
  const scanTruncated = entries.length >= MAX_SCAN_ENTRIES;
  const candidates = [
    `Project overview: ${files.length} files scanned${scanTruncated ? ' (scan capped)' : ''}.`,
    describeLanguages(files),
    describeTopLevel(files),
    await describePackageJson(options),
    'Tree:',
    ...describeTree(entries),
  ].filter((line): line is string => line !== undefined);

  const fitted = fitLines(candidates, options.budgetTokens);
  const truncated = fitted.truncated || scanTruncated;
  const text = truncated ? `${fitted.text}\n... (repo map truncated)` : fitted.text;
  return {
    text,
    filesScanned: files.length,
    estimatedTokens: estimateTokens(text),
    truncated,
  };
}

async function collectEntries(options: RepoMapOptions): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for await (const entry of walkEntries({
    workspace: options.workspace,
    start: options.workspace,
    maxDepth: MAX_TREE_DEPTH,
    includeDirs: true,
    ignore: options.ignore,
    signal: options.signal,
  })) {
    if (entries.length >= MAX_SCAN_ENTRIES) {
      break;
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return entries;
}

function describeLanguages(files: readonly WalkEntry[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const extension = path.extname(file.relativePath).toLowerCase().replace(/^\./, '');
    const label = extension === '' ? '(none)' : extension;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  return `Languages: ${summary}`;
}

/** 顶层目录摘要：目录树被预算截断时仍能看到项目整体结构 */
function describeTopLevel(files: readonly WalkEntry[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const segments = file.relativePath.split('/');
    const label = segments.length > 1 ? `${segments[0]}/` : '(root)';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TOP_LEVEL)
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  return `Top-level: ${summary}`;
}

async function describePackageJson(options: RepoMapOptions): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(options.workspace, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    options.logger?.warn({ reason: describeError(error) }, 'package.json is not valid JSON');
    return 'package.json: (invalid JSON)';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['name', 'version', 'main'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') {
      parts.push(`${key}=${value}`);
    }
  }
  const scripts = record['scripts'];
  if (typeof scripts === 'object' && scripts !== null) {
    const names = Object.keys(scripts).slice(0, MAX_SCRIPTS);
    if (names.length > 0) {
      parts.push(`scripts=${names.join(', ')}`);
    }
  }
  return parts.length === 0 ? undefined : `package.json: ${parts.join(' ')}`;
}

function describeTree(entries: readonly WalkEntry[]): string[] {
  const lines = entries.slice(0, MAX_TREE_LINES).map((entry) => {
    const depth = entry.relativePath.split('/').length - 1;
    const name =
      entry.type === 'dir'
        ? `${path.posix.basename(entry.relativePath)}/`
        : path.posix.basename(entry.relativePath);
    return `${'  '.repeat(depth)}${name}`;
  });
  return lines;
}

function fitLines(
  lines: readonly string[],
  budgetTokens: number,
): { text: string; truncated: boolean } {
  let text = '';
  for (const line of lines) {
    const next = text === '' ? line : `${text}\n${line}`;
    if (estimateTokens(next) > budgetTokens) {
      return { text, truncated: true };
    }
    text = next;
  }
  return { text, truncated: false };
}
