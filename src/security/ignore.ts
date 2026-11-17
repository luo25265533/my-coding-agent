import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.agent',
]);

export interface IgnoreMatcher {
  isIgnored(relativePath: string, isDir: boolean): boolean;
}

export interface IgnoreOptions {
  readonly workspace: string;
  /** 默认 true；false 时只保留内置默认目录 */
  readonly respectGitignore?: boolean | undefined;
  /** 追加规则，语义与 .gitignore 行一致 */
  readonly extraPatterns?: readonly string[] | undefined;
}

interface CompiledRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

/**
 * 忽略规则只负责「常规文件过滤」；敏感文件由 sensitive-files 独立拦截，
 * 内置默认目录不可被否定规则重新包含。
 */
export function createIgnoreMatcher(options: IgnoreOptions): IgnoreMatcher {
  const patterns =
    options.respectGitignore === false ? [] : readGitignorePatterns(options.workspace);
  const rules = [...patterns, ...(options.extraPatterns ?? [])]
    .map(compileRule)
    .filter((rule): rule is CompiledRule => rule !== undefined);

  return {
    isIgnored(relativePath: string, isDir: boolean): boolean {
      const normalized = normalize(relativePath);
      if (normalized === '' || normalized === '.') {
        return false;
      }
      const segments = normalized.split('/');
      if (segments.some((segment) => DEFAULT_IGNORED_DIRS.has(segment))) {
        return true;
      }

      const allPaths = [...ancestorPaths(segments), normalized];
      let ignored = false;
      for (const rule of rules) {
        const targets = rule.dirOnly && !isDir ? allPaths.slice(0, -1) : allPaths;
        if (targets.some((target) => rule.regex.test(target))) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}

function ancestorPaths(segments: readonly string[]): string[] {
  const ancestors: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    ancestors.push(segments.slice(0, length).join('/'));
  }
  return ancestors;
}

function readGitignorePatterns(workspace: string): string[] {
  let content: string;
  try {
    content = readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return content.split(/\r?\n/);
}

function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function compileRule(raw: string): CompiledRule | undefined {
  let pattern = raw.trim();
  if (pattern === '' || pattern.startsWith('#')) {
    return undefined;
  }

  const negated = pattern.startsWith('!');
  if (negated) {
    pattern = pattern.slice(1);
  }
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) {
    pattern = pattern.slice(0, -1);
  }
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
  }
  if (pattern === '') {
    return undefined;
  }

  const prefix = anchored ? '^' : '(?:^|.*/)';
  return {
    negated,
    dirOnly,
    regex: new RegExp(`${prefix}${translateGlob(pattern)}$`),
  };
}

function translateGlob(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) {
      break;
    }
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}
