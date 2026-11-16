import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultToolRegistry, dispatchToolCall } from '../../src/tools/index.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-tools-'));
const registry = createDefaultToolRegistry();

const ctx: ToolContext = { workspace: root, signal: new AbortController().signal };

beforeAll(() => {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'deep', 'a', 'b'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });

  writeFileSync(
    path.join(root, 'src', 'app.ts'),
    "export const answer = 42;\nconst label = 'ANSWER uppercase';\n",
  );
  writeFileSync(path.join(root, 'README.md'), 'Project readme\nanswer documented here\n');
  writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=abc\n');
  writeFileSync(path.join(root, '.env.example'), 'LLM_PROVIDER=mock\n');
  writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x4d, 0x41, 0x47, 0x49, 0x43, 0x00]));
  writeFileSync(path.join(root, 'binary-text.bin'), Buffer.from('MAGIC\0TOKEN'));
  writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(300 * 1024));
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'export const answer = 1;\n');
  writeFileSync(path.join(root, 'deep', 'a', 'b', 'c.txt'), 'deep answer\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return dispatchToolCall(registry, { id: 'call_1', name, arguments: JSON.stringify(args) }, ctx);
}

function errorCode(result: ToolResult): string {
  const parsed = JSON.parse(result.content) as { error?: { code?: string } };
  return parsed.error?.code ?? '';
}

describe('read_file', () => {
  it('带行号返回文件内容', async () => {
    const result = await call('read_file', { path: 'src/app.ts' });
    expect(result.ok).toBe(true);
    const lines = result.content.split('\n');
    expect(lines[0]).toMatch(/^\s*1 \| export const answer = 42;$/);
    expect(lines[1]).toMatch(/^\s*2 \| const label = 'ANSWER uppercase';$/);
  });

  it('offset 与 limit 生效', async () => {
    const result = await call('read_file', { path: 'src/app.ts', offset: 2, limit: 1 });
    expect(result.content).toContain("const label = 'ANSWER uppercase';");
    expect(result.content).not.toContain('export const answer');
    expect(result.truncated).toBeUndefined();
  });

  it('limit 截断时标记 truncated 并提示继续位置', async () => {
    const result = await call('read_file', { path: 'src/app.ts', limit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('continue with offset=2');
  });

  it('offset 越界报错', async () => {
    const result = await call('read_file', { path: 'src/app.ts', offset: 99 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('beyond end of file');
  });

  it('文件不存在', async () => {
    expect(await call('read_file', { path: 'missing.txt' })).toMatchObject({ ok: false });
    expect((await call('read_file', { path: 'missing.txt' })).content).toContain('file not found');
  });

  it('目录应改用 list_files', async () => {
    const result = await call('read_file', { path: 'src' });
    expect(result.content).toContain('use list_files');
  });

  it('拒绝二进制文件与超大文件', async () => {
    expect((await call('read_file', { path: 'binary.bin' })).content).toContain('binary file');
    expect((await call('read_file', { path: 'big.txt' })).content).toContain('too large');
  });

  it('空文件返回占位文本', async () => {
    writeFileSync(path.join(root, 'empty.txt'), '');
    expect((await call('read_file', { path: 'empty.txt' })).content).toBe('(empty file)');
  });

  it('拒绝密钥文件与越界路径', async () => {
    const secret = await call('read_file', { path: '.env' });
    expect(secret.ok).toBe(false);
    expect(errorCode(secret)).toBe('TOOL_DENIED');

    const escape = await call('read_file', { path: '../outside.txt' });
    expect(escape.ok).toBe(false);
    expect(errorCode(escape)).toBe('TOOL_DENIED');
  });
});

describe('list_files', () => {
  it('递归到默认深度，忽略依赖目录与密钥文件', async () => {
    const result = await call('list_files', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/');
    expect(result.content).toContain('src/app.ts');
    expect(result.content).toContain('.env.example');
    expect(result.content).not.toContain('.env\n');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('deep/a/b/c.txt');
  });

  it('recursive=false 只列直接子项', async () => {
    const result = await call('list_files', { recursive: false });
    expect(result.content).toContain('src/');
    expect(result.content).not.toContain('src/app.ts');
  });

  it('maxEntries 截断', async () => {
    const result = await call('list_files', { recursive: false, maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('truncated at 2 entries');
  });

  it('指向文件时提示改用 read_file', async () => {
    expect((await call('list_files', { path: 'README.md' })).content).toContain('use read_file');
  });

  it('路径不存在', async () => {
    expect((await call('list_files', { path: 'nope' })).content).toContain('path not found');
  });

  it('空目录返回占位文本', async () => {
    mkdirSync(path.join(root, 'empty-dir'));
    expect((await call('list_files', { path: 'empty-dir' })).content).toBe('(empty directory)');
  });
});

describe('search_code', () => {
  it('默认忽略大小写并返回 path:line: text', async () => {
    const result = await call('search_code', { pattern: 'answer' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/app.ts:1: export const answer = 42;');
    expect(result.content).toContain('README.md:2: answer documented here');
    expect(result.content).not.toContain('node_modules');
  });

  it('caseSensitive=true 只匹配大小写一致的行', async () => {
    const result = await call('search_code', { pattern: 'ANSWER', caseSensitive: true });
    expect(result.content).toContain('src/app.ts:2:');
    expect(result.content).not.toContain('src/app.ts:1:');
  });

  it('glob 只匹配目标文件', async () => {
    const md = await call('search_code', { pattern: 'answer', glob: '*.md' });
    expect(md.content).toContain('README.md');
    expect(md.content).not.toContain('src/app.ts');

    const ts = await call('search_code', { pattern: 'answer', glob: 'src/**/*.ts' });
    expect(ts.content).toContain('src/app.ts:1');
    expect(ts.content).not.toContain('README.md');
  });

  it('跳过密钥文件与二进制文件', async () => {
    expect((await call('search_code', { pattern: 'SECRET_TOKEN' })).content).toContain(
      'no matches',
    );
    expect((await call('search_code', { pattern: 'MAGIC' })).content).toContain('no matches');
  });

  it('非法正则返回 TOOL_INVALID_ARGS', async () => {
    const result = await call('search_code', { pattern: '(' });
    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('TOOL_INVALID_ARGS');
  });

  it('maxResults 截断', async () => {
    const result = await call('search_code', { pattern: 'answer', maxResults: 1 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('truncated at 1 matches');
  });

  it('搜索单个文件', async () => {
    const result = await call('search_code', { pattern: 'readme', path: 'README.md' });
    expect(result.content).toContain('README.md:1: Project readme');
  });

  it('glob 支持 ? 与转义字符', async () => {
    const question = await call('search_code', { pattern: 'answer', glob: 'app.?s' });
    expect(question.content).toContain('src/app.ts:1');

    const dotted = await call('search_code', { pattern: 'answer', glob: 'app.ts' });
    expect(dotted.content).toContain('src/app.ts:1');
  });

  it('路径不存在', async () => {
    const result = await call('search_code', { pattern: 'x', path: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('path not found');
  });
});
