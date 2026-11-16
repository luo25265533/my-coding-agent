import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNotSensitive, resolveInsideWorkspace } from '../../src/security/path-guard.js';
import { isSensitiveFileName } from '../../src/security/sensitive-files.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-security-'));
const outside = mkdtempSync(path.join(tmpdir(), 'agent-outside-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isSensitiveFileName', () => {
  it.each([
    '.env',
    '.ENV',
    '.env.local',
    '.Env.Production',
    'server.pem',
    'CERT.KEY',
    'bundle.p12',
    'id_rsa',
    'id_rsa.pub',
    'ID_ED25519',
    '.npmrc',
    '.git-credentials',
    'credentials',
    'credentials.json',
  ])('拒绝 %s', (name) => {
    expect(isSensitiveFileName(name)).toBe(true);
  });

  it.each(['.env.example', 'app.ts', 'package.json', 'environment.ts', 'keyboard.ts'])(
    '放行 %s',
    (name) => {
      expect(isSensitiveFileName(name)).toBe(false);
    },
  );
});

describe('resolveInsideWorkspace', () => {
  it('相对路径基于 workspace 解析', () => {
    expect(resolveInsideWorkspace(root, 'src/app.ts')).toBe(path.join(root, 'src', 'app.ts'));
    expect(resolveInsideWorkspace(root, '.')).toBe(root);
  });

  it('workspace 内的绝对路径放行', () => {
    const target = path.join(root, 'a.txt');
    expect(resolveInsideWorkspace(root, target)).toBe(target);
  });

  it('拒绝 .. 穿越', () => {
    expect(() => resolveInsideWorkspace(root, '../secret.txt')).toThrow(AgentError);
    try {
      resolveInsideWorkspace(root, '../secret.txt');
    } catch (error) {
      expect((error as AgentError).code).toBe(ErrorCode.PathDenied);
      expect((error as AgentError).exitCode).toBe(1);
    }
  });

  it('拒绝 workspace 外的绝对路径', () => {
    expect(() => resolveInsideWorkspace(root, path.join(outside, 'x.txt'))).toThrow(
      /escapes workspace/,
    );
  });

  it('拒绝指向外部的符号链接', () => {
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    writeFileSync(path.join(outside, 'target.txt'), 'secret');
    const link = path.join(root, 'sub', 'escape.txt');
    try {
      symlinkSync(path.join(outside, 'target.txt'), link, 'file');
    } catch {
      // Windows 无符号链接权限时跳过该场景
      return;
    }
    expect(() => resolveInsideWorkspace(root, 'sub/escape.txt')).toThrow(/outside workspace/);
  });

  it('assertNotSensitive 拒绝密钥文件', () => {
    expect(() => assertNotSensitive(path.join(root, '.env'))).toThrow(/sensitive file/);
    expect(() => assertNotSensitive(path.join(root, 'app.ts'))).not.toThrow();
  });
});
