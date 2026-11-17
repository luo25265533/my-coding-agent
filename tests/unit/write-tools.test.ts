import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '../../src/security/approval.js';
import { atomicWriteFile } from '../../src/shared/atomic-write.js';
import { dispatchToolCall, ToolRegistry } from '../../src/tools/index.js';
import { editFileTool } from '../../src/tools/definitions/edit-file.js';
import { writeFileTool } from '../../src/tools/definitions/write-file.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';

let workspace: string;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-write-tools-'));
  registry = new ToolRegistry().register(writeFileTool).register(editFileTool);
  writeFileSync(path.join(workspace, 'existing.txt'), 'old content\n');
  writeFileSync(path.join(workspace, 'empty.txt'), '');
  writeFileSync(path.join(workspace, 'multi.txt'), 'alpha beta alpha gamma\n');
  writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0x4d, 0x41, 0x00, 0x47]));
  writeFileSync(path.join(workspace, '.env'), 'SECRET=1\n');
  mkdirSync(path.join(workspace, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function call(
  name: string,
  args: Record<string, unknown>,
  confirm?: (request: ConfirmRequest) => Promise<boolean>,
): Promise<ToolResult> {
  const ctx: ToolContext = {
    workspace,
    signal: new AbortController().signal,
    confirm,
  };
  return dispatchToolCall(registry, { id: 'call_1', name, arguments: JSON.stringify(args) }, ctx);
}

function errorCode(result: ToolResult): string {
  const parsed = JSON.parse(result.content) as { error?: { code?: string } };
  return parsed.error?.code ?? '';
}

describe('write_file', () => {
  it('新建文件并递归创建父目录', async () => {
    const result = await call('write_file', {
      path: 'src/deep/new.ts',
      content: 'export const x = 1;\n',
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(workspace, 'src', 'deep', 'new.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(result.meta).toMatchObject({ created: true, overwritten: false });
    expect(result.content).toContain('wrote src/deep/new.ts');
    expect(readdirSync(path.join(workspace, 'src', 'deep'))).toEqual(['new.ts']);
  });

  it('空内容合法', async () => {
    const result = await call('write_file', { path: 'blank.txt', content: '' });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(workspace, 'blank.txt'), 'utf8')).toBe('');
  });

  it('覆盖非空文件未确认时拒绝，文件保持不变', async () => {
    const result = await call('write_file', { path: 'existing.txt', content: 'new' });

    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('TOOL_DENIED');
    expect(readFileSync(path.join(workspace, 'existing.txt'), 'utf8')).toBe('old content\n');
  });

  it('覆盖非空文件经确认后写入', async () => {
    const confirm = vi.fn((_request: ConfirmRequest) => Promise.resolve(true));
    const result = await call('write_file', { path: 'existing.txt', content: 'new' }, confirm);

    expect(result.ok).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: 'overwrite_file',
      risk: 'high',
    });
    expect(readFileSync(path.join(workspace, 'existing.txt'), 'utf8')).toBe('new');
    expect(result.meta).toMatchObject({ created: false, overwritten: true });
  });

  it('覆盖空文件无需确认', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const result = await call('write_file', { path: 'empty.txt', content: 'x' }, confirm);

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('拒绝敏感文件、.git、越界与目录目标', async () => {
    mkdirSync(path.join(workspace, 'src'));
    expect(errorCode(await call('write_file', { path: '.env', content: 'x' }))).toBe('TOOL_DENIED');
    expect(errorCode(await call('write_file', { path: '.git/config', content: 'x' }))).toBe(
      'TOOL_DENIED',
    );
    expect(errorCode(await call('write_file', { path: '../escape.txt', content: 'x' }))).toBe(
      'TOOL_DENIED',
    );
    expect(errorCode(await call('write_file', { path: 'src', content: 'x' }))).toBe('TOOL_FAILED');
  });

  it('按 UTF-8 字节数拒绝超过 256 KB 的内容', async () => {
    const result = await call('write_file', { path: 'huge.txt', content: '中'.repeat(100_000) });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('too large');
    expect(existsSync(path.join(workspace, 'huge.txt'))).toBe(false);
  });
});

describe('edit_file', () => {
  it('唯一匹配替换，无需确认', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const result = await call(
      'edit_file',
      { path: 'existing.txt', old_string: 'old', new_string: 'brand new' },
      confirm,
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(path.join(workspace, 'existing.txt'), 'utf8')).toBe('brand new content\n');
    expect(result.meta).toMatchObject({ replacements: 1 });
  });

  it('replaceAll=true 替换全部匹配', async () => {
    const result = await call('edit_file', {
      path: 'multi.txt',
      old_string: 'alpha',
      new_string: 'omega',
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(workspace, 'multi.txt'), 'utf8')).toBe(
      'omega beta omega gamma\n',
    );
  });

  it('未命中时报错', async () => {
    const result = await call('edit_file', {
      path: 'existing.txt',
      old_string: 'missing',
      new_string: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('old_string not found');
  });

  it('多处匹配且未 replaceAll 时报错并给出次数', async () => {
    const result = await call('edit_file', {
      path: 'multi.txt',
      old_string: 'alpha',
      new_string: 'omega',
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('matches 2 locations');
  });

  it('new_string 为空时删除片段', async () => {
    const result = await call('edit_file', {
      path: 'existing.txt',
      old_string: 'old ',
      new_string: '',
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(workspace, 'existing.txt'), 'utf8')).toBe('content\n');
  });

  it('拒绝二进制、缺失、敏感与越界路径', async () => {
    expect(
      (await call('edit_file', { path: 'binary.bin', old_string: 'M', new_string: 'X' })).content,
    ).toContain('binary');
    expect(
      (await call('edit_file', { path: 'missing.txt', old_string: 'a', new_string: 'b' })).content,
    ).toContain('file not found');
    expect(
      errorCode(await call('edit_file', { path: '.env', old_string: 'a', new_string: 'b' })),
    ).toBe('TOOL_DENIED');
    expect(
      errorCode(await call('edit_file', { path: '../x.txt', old_string: 'a', new_string: 'b' })),
    ).toBe('TOOL_DENIED');
  });

  it('拒绝超过 1 MB 的文件', async () => {
    writeFileSync(path.join(workspace, 'big.txt'), 'a'.repeat(1024 * 1024 + 1));
    const result = await call('edit_file', {
      path: 'big.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('too large to edit');
  });

  it('拒绝目录目标', async () => {
    mkdirSync(path.join(workspace, 'folder'));
    const result = await call('edit_file', {
      path: 'folder',
      old_string: 'a',
      new_string: 'b',
    });
    expect(errorCode(result)).toBe('TOOL_FAILED');
    expect(result.content).toContain('not a regular file');
  });

  it('替换后超过 1 MB 时拒绝且原文件不变', async () => {
    const original = `${'a'.repeat(899_990)}MARKER`;
    writeFileSync(path.join(workspace, 'grow.txt'), original);
    const result = await call('edit_file', {
      path: 'grow.txt',
      old_string: 'MARKER',
      new_string: 'b'.repeat(200_000),
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('would exceed');
    expect(readFileSync(path.join(workspace, 'grow.txt'), 'utf8')).toBe(original);
  });
});

describe('atomicWriteFile', () => {
  it('写入 Uint8Array 并原样读回', async () => {
    const target = path.join(workspace, 'bytes.bin');
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0xff]);
    await atomicWriteFile(target, bytes);
    expect([...readFileSync(target)]).toEqual([...bytes]);
  });

  it('rename 失败时清理临时文件并抛出原错误', async () => {
    mkdirSync(path.join(workspace, 'dir-target'));
    await expect(atomicWriteFile(path.join(workspace, 'dir-target'), 'content')).rejects.toThrow();
    expect(readdirSync(workspace).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
