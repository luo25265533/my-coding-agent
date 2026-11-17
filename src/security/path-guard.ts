import { realpathSync } from 'node:fs';
import path from 'node:path';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { isSensitiveFileName } from './sensitive-files.js';

export function isInsideWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * 把模型给出的路径解析为绝对路径并做沙箱检查。
 * 目标存在时用 realpath 复核，防止 workspace 内的符号链接指向外部。
 */
export function resolveInsideWorkspace(workspace: string, input: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, input);
  if (!isInsideWorkspace(root, target)) {
    throw denied(`path escapes workspace: ${input}`);
  }

  const realRoot = tryRealpath(root);
  if (realRoot !== undefined) {
    const realTarget = tryRealpath(target);
    if (realTarget !== undefined && !isInsideWorkspace(realRoot, realTarget)) {
      throw denied(`path resolves outside workspace: ${input}`);
    }
  }
  return target;
}

/**
 * 写入路径解析：目标可能尚不存在，因此回溯到最近已存在的祖先做 realpath 校验，
 * 防止通过 workspace 内的符号链接目录逃逸。`.git` 目录一律拒绝写入。
 */
export function resolveForWrite(workspace: string, input: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, input);
  if (!isInsideWorkspace(root, target)) {
    throw denied(`path escapes workspace: ${input}`);
  }

  const segments = path.relative(root, target).split(path.sep);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw denied(`refusing to write inside .git: ${input}`);
  }

  const realRoot = tryRealpath(root);
  if (realRoot !== undefined) {
    const realAncestor = realpathOfNearestAncestor(target);
    if (realAncestor !== undefined && !isInsideWorkspace(realRoot, realAncestor)) {
      throw denied(`path resolves outside workspace: ${input}`);
    }
  }
  return target;
}

export function assertNotSensitive(filePath: string): void {
  const name = path.basename(filePath);
  if (isSensitiveFileName(name)) {
    throw denied(`refusing to access sensitive file: ${name}`);
  }
}

function realpathOfNearestAncestor(target: string): string | undefined {
  let current = target;
  for (;;) {
    const real = tryRealpath(current);
    if (real !== undefined) {
      return real;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw denied(`cannot verify path: ${target}`, error);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function denied(message: string, cause?: unknown): AgentError {
  return new AgentError(ErrorCode.PathDenied, message, cause === undefined ? undefined : { cause });
}
