import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { isSensitiveFileName } from '../security/sensitive-files.js';
import { throwIfAborted } from '../shared/abort.js';

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.agent',
]);

const BINARY_SNIFF_BYTES = 8192;

export interface WalkEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: 'file' | 'dir';
  readonly size: number;
}

export interface WalkOptions {
  readonly workspace: string;
  /** 已通过 PathGuard 的绝对路径，可以是文件或目录 */
  readonly start: string;
  /** 1 表示只列 start 的直接子项 */
  readonly maxDepth: number;
  readonly includeDirs?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function* walkEntries(options: WalkOptions): AsyncGenerator<WalkEntry> {
  const startInfo = await stat(options.start);
  const relativePath = toRelativePath(options.workspace, options.start);

  if (startInfo.isFile()) {
    if (!isSensitiveFileName(path.basename(options.start))) {
      yield {
        absolutePath: options.start,
        relativePath,
        type: 'file',
        size: startInfo.size,
      };
    }
    return;
  }
  if (!startInfo.isDirectory()) {
    return;
  }
  yield* walkDirectory(options, options.start, 0);
}

async function* walkDirectory(
  options: WalkOptions,
  dir: string,
  depth: number,
): AsyncGenerator<WalkEntry> {
  const { signal, maxDepth } = options;
  throwIfAborted(signal);

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // 根目录不可读时应让调用方看到错误；子目录权限问题则跳过
    if (depth === 0) {
      throw error;
    }
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    throwIfAborted(signal);
    // 不跟随符号链接：可逃逸 workspace，也容易形成环
    if (entry.isSymbolicLink()) {
      continue;
    }
    const absolutePath = path.join(dir, entry.name);
    const relativePath = toRelativePath(options.workspace, absolutePath);

    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      if (options.includeDirs === true) {
        yield { absolutePath, relativePath, type: 'dir', size: 0 };
      }
      if (depth + 1 < maxDepth) {
        yield* walkDirectory(options, absolutePath, depth + 1);
      }
      continue;
    }

    if (!entry.isFile() || isSensitiveFileName(entry.name)) {
      continue;
    }
    const info = await stat(absolutePath);
    yield { absolutePath, relativePath, type: 'file', size: info.size };
  }
}

export function toRelativePath(workspace: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspace), absolutePath);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
