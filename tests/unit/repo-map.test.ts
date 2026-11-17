import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRepoMap } from '../../src/context/repo-map.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-repomap-'));

beforeAll(() => {
  mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(root, 'ignored-dir'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'map-demo',
      version: '1.0.0',
      main: 'index.js',
      scripts: { build: 'tsc', test: 'vitest' },
    }),
  );
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'src', 'nested', 'util.ts'), 'export const util = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# Demo\n');
  writeFileSync(path.join(root, 'note.txt'), 'note\n');
  writeFileSync(path.join(root, 'secret.txt'), 'TOKEN\n');
  writeFileSync(path.join(root, 'ignored-dir', 'hidden.ts'), 'hidden\n');
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(root, '.gitignore'), 'secret.txt\nignored-dir/\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function build(budgetTokens: number, workspace = root) {
  const ignore = createIgnoreMatcher({ workspace });
  return buildRepoMap({ workspace, budgetTokens, ignore });
}

describe('buildRepoMap', () => {
  it('汇总文件数、语言、顶层目录与 package.json 信息', async () => {
    const result = await build(5000);
    expect(result.text).toContain('Project overview:');
    expect(result.text).toContain('Languages:');
    expect(result.text).toContain('ts=2');
    expect(result.text).toContain('Top-level: (root)=4, src/=2');
    expect(result.text).toContain('package.json: name=map-demo version=1.0.0');
    expect(result.text).toContain('scripts=build, test');
    expect(result.filesScanned).toBeGreaterThanOrEqual(5);
    expect(result.truncated).toBe(false);
    expect(result.estimatedTokens).toBeLessThanOrEqual(5000);
  });

  it('预算截断目录树后仍保留顶层目录摘要', async () => {
    const result = await build(60);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('Top-level:');
    expect(result.text).toContain('src/=2');
    expect(result.text).toContain('repo map truncated');
  });

  it('目录树包含嵌套文件并跳过忽略项与密钥文件', async () => {
    const result = await build(5000);
    expect(result.text).toContain('src/');
    expect(result.text).toContain('app.ts');
    expect(result.text).toContain('nested/');
    expect(result.text).toContain('util.ts');
    expect(result.text).not.toContain('node_modules');
    expect(result.text).not.toContain('secret.txt');
    expect(result.text).not.toContain('ignored-dir');
    expect(result.text).not.toContain('.env');
  });

  it('同一工作区多次生成结果一致', async () => {
    const first = await build(5000);
    const second = await build(5000);
    expect(second.text).toBe(first.text);
  });

  it('预算不足时按行截断并标记', async () => {
    const result = await build(30);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('repo map truncated');
  });

  it('预算为 0 时直接返回空地图', async () => {
    const result = await build(0);
    expect(result).toEqual({ text: '', filesScanned: 0, estimatedTokens: 0, truncated: true });
  });

  it('package.json 非法或非对象时降级', async () => {
    const invalid = mkdtempSync(path.join(tmpdir(), 'agent-repomap-bad-'));
    const nonObject = mkdtempSync(path.join(tmpdir(), 'agent-repomap-scalar-'));
    try {
      writeFileSync(path.join(invalid, 'package.json'), 'not json');
      const invalidResult = await build(1000, invalid);
      expect(invalidResult.text).toContain('package.json: (invalid JSON)');

      writeFileSync(path.join(nonObject, 'package.json'), '42');
      const scalarResult = await build(1000, nonObject);
      expect(scalarResult.text).not.toContain('package.json:');
    } finally {
      rmSync(invalid, { recursive: true, force: true });
      rmSync(nonObject, { recursive: true, force: true });
    }
  });

  it('空工作区不输出语言与脚本行', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'agent-repomap-empty-'));
    try {
      const result = await build(1000, empty);
      expect(result.text).toContain('Project overview: 0 files scanned');
      expect(result.text).not.toContain('Languages:');
      expect(result.text).not.toContain('Top-level:');
      expect(result.filesScanned).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('工作区不可读时降级为提示文本', async () => {
    const missing = path.join(root, 'missing-workspace');
    const ignore = createIgnoreMatcher({ workspace: missing });
    const result = await buildRepoMap({ workspace: missing, budgetTokens: 1000, ignore });
    expect(result.text).toContain('Project overview unavailable');
    expect(result.filesScanned).toBe(0);
    expect(result.truncated).toBe(true);
  });
});
