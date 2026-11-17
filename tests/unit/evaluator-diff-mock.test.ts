import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDiff } from '../../src/evaluator/diff.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';
import type { ShellResult } from '../../src/shared/shell.js';

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }));

vi.mock('../../src/shared/shell.js', () => ({ runProcess: mocks.runProcess }));

function shell(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    spawnError: undefined,
    durationMs: 1,
    ...overrides,
  };
}

describe('collectDiff git 失败与解析边界（mock 进程）', () => {
  beforeEach(() => {
    mocks.runProcess.mockReset();
  });

  it('git 不可用时返回 spawn 错误', async () => {
    mocks.runProcess.mockResolvedValueOnce(shell({ code: null, spawnError: 'ENOENT' }));
    const summary = await collectDiff({ workspace: 'unused' });
    expect(summary.available).toBe(false);
    expect(summary.reason).toBe('git is not available: ENOENT');
  });

  it('status 失败时截取首行错误信息', async () => {
    mocks.runProcess.mockResolvedValueOnce(shell({ code: 1, stderr: 'fatal: boom' }));
    const summary = await collectDiff({ workspace: 'unused' });
    expect(summary.reason).toBe('git status failed: fatal: boom');
  });

  it('status 无输出时退化为退出码提示', async () => {
    mocks.runProcess.mockResolvedValueOnce(shell({ code: 128 }));
    const summary = await collectDiff({ workspace: 'unused' });
    expect(summary.reason).toBe('git status exited with code 128');
  });

  it('状态成功但 diff 不可用时仍降级', async () => {
    mocks.runProcess
      .mockResolvedValueOnce(shell())
      .mockResolvedValueOnce(shell({ code: null, spawnError: 'EACCES' }))
      .mockResolvedValueOnce(shell());
    expect((await collectDiff({ workspace: 'unused' })).reason).toBe(
      'git is not available: EACCES',
    );

    mocks.runProcess
      .mockResolvedValueOnce(shell())
      .mockResolvedValueOnce(shell())
      .mockResolvedValueOnce(shell({ code: 1, stderr: 'bad staged diff' }));
    expect((await collectDiff({ workspace: 'unused' })).reason).toBe(
      'git diff failed: bad staged diff',
    );
  });

  it('diff 阶段被中止时抛出 LlmAborted', async () => {
    mocks.runProcess.mockResolvedValueOnce(shell()).mockResolvedValueOnce(shell({ aborted: true }));
    const first = await collectDiff({ workspace: 'unused' }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(AgentError);
    expect((first as AgentError).code).toBe(ErrorCode.LlmAborted);
    expect((first as AgentError).message).toContain('git diff aborted');

    mocks.runProcess
      .mockResolvedValueOnce(shell())
      .mockResolvedValueOnce(shell())
      .mockResolvedValueOnce(shell({ aborted: true }));
    const second = await collectDiff({ workspace: 'unused' }).catch((error: unknown) => error);
    expect((second as AgentError).message).toContain('git diff --cached aborted');
  });

  it('解析状态码与 numstat 的异常记录', async () => {
    const status = [
      '?? a.txt',
      ' M ok.txt',
      ' M bin.dat',
      'A  new.txt',
      'D  gone.txt',
      'T  type.txt',
      'AA both.txt',
      'R  ren.txt',
      'C  copy.txt',
      'UU conflict.txt',
      'XY odd.txt',
      'M',
      'M  ',
    ].join('\0');
    const unstaged = [
      'no-tabs',
      '1\tno-second-tab',
      '1\t2\t',
      'x\ty\tweird.txt',
      '3\t4\tok.txt',
      '-\t-\tbin.dat',
      '0\t1\tgone.txt',
    ].join('\0');
    const staged = ['1\t1\tok.txt', '2\t0\tnew.txt'].join('\0');
    mocks.runProcess
      .mockResolvedValueOnce(shell({ stdout: status }))
      .mockResolvedValueOnce(shell({ stdout: unstaged }))
      .mockResolvedValueOnce(shell({ stdout: staged }));

    const summary = await collectDiff({ workspace: 'unused' });
    const byPath = new Map(summary.files.map((entry) => [entry.path, entry]));

    expect(summary.available).toBe(true);
    expect(byPath.get('a.txt')).toMatchObject({ status: 'untracked', insertions: null });
    expect(byPath.get('ok.txt')).toMatchObject({ status: 'modified', insertions: 4, deletions: 5 });
    expect(byPath.get('bin.dat')).toMatchObject({ status: 'modified', insertions: null });
    expect(byPath.get('new.txt')).toMatchObject({ status: 'added', insertions: 2, deletions: 0 });
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath.get('type.txt')?.status).toBe('modified');
    expect(byPath.get('both.txt')?.status).toBe('other');
    expect(byPath.get('ren.txt')?.status).toBe('other');
    expect(byPath.get('copy.txt')?.status).toBe('other');
    expect(byPath.get('conflict.txt')?.status).toBe('other');
    expect(byPath.get('odd.txt')?.status).toBe('other');
    expect(byPath.has('weird.txt')).toBe(false);
    expect(summary.files.map((entry) => entry.path)).toEqual([...byPath.keys()].sort());
  });
});
