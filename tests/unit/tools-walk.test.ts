import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared/errors.js';
import {
  looksBinary,
  toRelativePath,
  walkEntries,
  type WalkEntry,
  type WalkOptions,
} from '../../src/tools/walk.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-walk-'));

beforeAll(() => {
  writeFileSync(path.join(root, 'single.txt'), 'x');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  mkdirSync(path.join(root, 'empty'));
  mkdirSync(path.join(root, 'dir', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'dir', 'a.txt'), 'a');
  writeFileSync(path.join(root, 'dir', 'nested', 'b.txt'), 'b');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function collect(overrides: Partial<WalkOptions> = {}): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for await (const entry of walkEntries({
    workspace: root,
    start: root,
    maxDepth: 5,
    ...overrides,
  })) {
    entries.push(entry);
  }
  return entries;
}

describe('walkEntries', () => {
  it('start 为文件时只产出该文件', async () => {
    const entries = await collect({ start: path.join(root, 'single.txt') });
    expect(entries).toEqual([
      {
        absolutePath: path.join(root, 'single.txt'),
        relativePath: 'single.txt',
        type: 'file',
        size: 1,
      },
    ]);
  });

  it('空目录产出空列表', async () => {
    expect(await collect({ start: path.join(root, 'empty') })).toEqual([]);
  });

  it('不存在的路径抛错', async () => {
    await expect(collect({ start: path.join(root, 'missing') })).rejects.toThrow();
  });

  it('includeDirs 控制目录条目', async () => {
    const withDirs = await collect({ includeDirs: true });
    expect(withDirs.some((entry) => entry.type === 'dir' && entry.relativePath === 'dir')).toBe(
      true,
    );

    const filesOnly = await collect();
    expect(filesOnly.every((entry) => entry.type === 'file')).toBe(true);
  });

  it('maxDepth=1 不递归', async () => {
    const entries = await collect({ maxDepth: 1 });
    expect(entries.map((entry) => entry.relativePath)).toEqual(['single.txt']);
  });

  it('敏感文件名被排除', async () => {
    const entries = await collect();
    expect(entries.some((entry) => entry.relativePath === '.env')).toBe(false);
  });

  it('符号链接被跳过', async () => {
    const link = path.join(root, 'dir', 'link.txt');
    try {
      symlinkSync(path.join(root, 'single.txt'), link, 'file');
    } catch {
      return;
    }
    const entries = await collect();
    expect(entries.some((entry) => entry.relativePath === 'dir/link.txt')).toBe(false);
  });

  it('已中止的信号抛 LlmAborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect({ signal: controller.signal })).rejects.toMatchObject({
      code: ErrorCode.LlmAborted,
    });
  });
});

describe('辅助函数', () => {
  it('toRelativePath 统一为正斜杠', () => {
    expect(toRelativePath(root, path.join(root, 'dir', 'a.txt'))).toBe('dir/a.txt');
    expect(toRelativePath(root, root)).toBe('.');
  });

  it('looksBinary 只嗅探前 8 KB 的 NUL', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    const lateNul = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
    expect(looksBinary(lateNul)).toBe(false);
  });
});
