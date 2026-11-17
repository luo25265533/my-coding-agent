import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIgnoreMatcher } from '../../src/security/ignore.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-ignore-'));

beforeAll(() => {
  writeFileSync(
    path.join(root, '.gitignore'),
    [
      '# comment',
      '*.log',
      'build/',
      '/root-only.txt',
      'src/generated',
      'docs/**/draft.md',
      '!keep.log',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function matcher(extraPatterns: readonly string[] = [], respectGitignore = true) {
  return createIgnoreMatcher({ workspace: root, respectGitignore, extraPatterns });
}

describe('内置默认规则', () => {
  it('忽略依赖、构建、日志与缓存目录', () => {
    const ignore = matcher();
    for (const target of [
      'node_modules/pkg/index.js',
      '.git/config',
      'dist/main.js',
      'coverage/report.html',
      '.agent/logs/run.jsonl',
    ]) {
      expect(ignore.isIgnored(target, false)).toBe(true);
    }
  });

  it('默认目录不可被否定规则重新包含', () => {
    const ignore = matcher(['!node_modules', '!dist/']);
    expect(ignore.isIgnored('node_modules/pkg/index.js', false)).toBe(true);
    expect(ignore.isIgnored('dist/main.js', false)).toBe(true);
  });

  it('普通文件不受默认规则影响', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('src/app.ts', false)).toBe(false);
    expect(ignore.isIgnored('.env.example', false)).toBe(false);
  });
});

describe('.gitignore 解析', () => {
  it('通配与注释生效', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('debug.log', false)).toBe(true);
    expect(ignore.isIgnored('logs/deep/trace.log', false)).toBe(true);
    expect(ignore.isIgnored('src/app.ts', false)).toBe(false);
  });

  it('目录规则同时忽略其下文件', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('build', true)).toBe(true);
    expect(ignore.isIgnored('build/main.js', false)).toBe(true);
    expect(ignore.isIgnored('src/generated', true)).toBe(true);
    expect(ignore.isIgnored('src/generated/schema.ts', false)).toBe(true);
  });

  it('前导斜杠锚定根目录', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('root-only.txt', false)).toBe(true);
    expect(ignore.isIgnored('nested/root-only.txt', false)).toBe(false);
  });

  it('** 跨层级匹配', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('docs/draft.md', false)).toBe(true);
    expect(ignore.isIgnored('docs/a/b/draft.md', false)).toBe(true);
    expect(ignore.isIgnored('docs/a/b/final.md', false)).toBe(false);
  });

  it('否定规则按出现顺序重新包含', () => {
    const ignore = matcher();
    expect(ignore.isIgnored('keep.log', false)).toBe(false);
    expect(ignore.isIgnored('other.log', false)).toBe(true);
  });

  it('respectGitignore=false 时不读取 .gitignore', () => {
    const ignore = matcher([], false);
    expect(ignore.isIgnored('debug.log', false)).toBe(false);
    expect(ignore.isIgnored('node_modules/pkg/index.js', false)).toBe(true);
  });
});

describe('追加规则', () => {
  it('AGENT_IGNORE 模式参与匹配', () => {
    const ignore = matcher(['tmp/', '*.tmp']);
    expect(ignore.isIgnored('tmp/file.txt', false)).toBe(true);
    expect(ignore.isIgnored('cache/state.tmp', false)).toBe(true);
    expect(ignore.isIgnored('src/app.ts', false)).toBe(false);
  });

  it('? 只匹配单个字符', () => {
    const ignore = matcher(['file?.txt']);
    expect(ignore.isIgnored('file1.txt', false)).toBe(true);
    expect(ignore.isIgnored('file10.txt', false)).toBe(false);
  });

  it('结尾 ** 匹配目录下任意层级', () => {
    const ignore = matcher(['assets/**']);
    expect(ignore.isIgnored('assets/logo.png', false)).toBe(true);
    expect(ignore.isIgnored('assets/icons/deep/logo.svg', false)).toBe(true);
    expect(ignore.isIgnored('src/logo.png', false)).toBe(false);
  });

  it('空模式与纯否定标记被忽略', () => {
    const ignore = matcher(['/', '!']);
    expect(ignore.isIgnored('src/app.ts', false)).toBe(false);
  });
});
