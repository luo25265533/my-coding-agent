import { execFileSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDiff, diffSince, isStaticOnlyDiff } from '../../src/evaluator/diff.js';
import { createEvaluator } from '../../src/evaluator/index.js';
import type { DiffSummary } from '../../src/evaluator/types.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-evaluator-diff-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
}

function initRepo(): void {
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(workspace, 'b.txt'), 'old\n');
  git('add', '--all');
  git('commit', '--quiet', '-m', 'init');
}

function file(summary: DiffSummary, filePath: string) {
  return summary.files.find((entry) => entry.path === filePath);
}

describe('collectDiff git 快照', () => {
  it('非 git 目录降级为 unavailable', async () => {
    const summary = await collectDiff({ workspace });
    expect(summary.available).toBe(false);
    expect(summary.reason).toBe('not a git repository');
    expect(summary.files).toEqual([]);
    expect(summary.totalInsertions).toBe(0);
    expect(summary.totalDeletions).toBe(0);
  });

  it('干净仓库返回空文件列表', async () => {
    initRepo();
    const summary = await collectDiff({ workspace });
    expect(summary.available).toBe(true);
    expect(summary.reason).toBeUndefined();
    expect(summary.files).toEqual([]);
    expect(summary.truncated).toBe(false);
  }, 20_000);

  it('识别修改、删除、未跟踪与含中文空格的路径', async () => {
    initRepo();
    writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\n');
    unlinkSync(path.join(workspace, 'b.txt'));
    writeFileSync(path.join(workspace, '新 文件.txt'), 'hi\n');

    const summary = await collectDiff({ workspace });
    expect(summary.available).toBe(true);
    expect(file(summary, 'a.txt')).toMatchObject({
      status: 'modified',
      insertions: 1,
      deletions: 0,
    });
    expect(file(summary, 'b.txt')).toMatchObject({
      status: 'deleted',
      insertions: 0,
      deletions: 1,
    });
    expect(file(summary, '新 文件.txt')).toMatchObject({
      status: 'untracked',
      insertions: null,
      deletions: null,
    });
    expect(summary.totalInsertions).toBe(1);
    expect(summary.totalDeletions).toBe(1);
  });

  it('暂存与未暂存的行数合并计算', async () => {
    initRepo();
    writeFileSync(path.join(workspace, 'c.txt'), 'line1\n');
    git('add', 'c.txt');
    writeFileSync(path.join(workspace, 'c.txt'), 'line1\nline2\n');

    const summary = await collectDiff({ workspace });
    expect(file(summary, 'c.txt')).toMatchObject({
      status: 'added',
      insertions: 2,
      deletions: 0,
    });
    expect(summary.totalInsertions).toBe(2);
  });

  it('文件按路径排序', async () => {
    initRepo();
    writeFileSync(path.join(workspace, 'z.txt'), 'z\n');
    writeFileSync(path.join(workspace, 'a-new.txt'), 'a\n');

    const summary = await collectDiff({ workspace });
    expect(summary.files.map((entry) => entry.path)).toEqual(
      ['a-new.txt', 'z.txt'].sort((left, right) => (left < right ? -1 : 1)),
    );
  });

  it('超过上限时截断并标记 truncated', async () => {
    initRepo();
    for (let index = 0; index < 501; index += 1) {
      writeFileSync(path.join(workspace, `f-${String(index).padStart(4, '0')}.txt`), 'x\n');
    }
    const summary = await collectDiff({ workspace });
    expect(summary.available).toBe(true);
    expect(summary.truncated).toBe(true);
    expect(summary.files).toHaveLength(500);
  }, 30_000);

  it('已中止的信号在采集前抛出 LlmAborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await createEvaluator({ workspace, signal: controller.signal })
      .diff()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.LlmAborted);
  });

  it('createEvaluator 的 diff 使用工作区快照', async () => {
    initRepo();
    writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\n');
    const summary = await createEvaluator({ workspace }).diff();
    expect(summary.available).toBe(true);
    expect(file(summary, 'a.txt')?.status).toBe('modified');
  });
});

describe('diffSince 任务增量', () => {
  const baseline: DiffSummary = {
    available: true,
    reason: undefined,
    files: [
      { path: 'a.txt', status: 'modified', insertions: 1, deletions: 0 },
      { path: 'b.txt', status: 'modified', insertions: 5, deletions: 0 },
    ],
    totalInsertions: 6,
    totalDeletions: 0,
    truncated: false,
  };

  it('只保留新增、状态变化或行数变化的文件', () => {
    const current: DiffSummary = {
      available: true,
      reason: undefined,
      files: [
        { path: 'a.txt', status: 'modified', insertions: 1, deletions: 0 },
        { path: 'b.txt', status: 'modified', insertions: 6, deletions: 0 },
        { path: 'c.txt', status: 'added', insertions: 2, deletions: 0 },
      ],
      totalInsertions: 9,
      totalDeletions: 0,
      truncated: false,
    };

    const result = diffSince(baseline, current);
    expect(result.files.map((entry) => entry.path)).toEqual(['b.txt', 'c.txt']);
    expect(result.totalInsertions).toBe(8);
    expect(result.totalDeletions).toBe(0);
  });

  it('基线包含文件但当前已删除时视为变化', () => {
    const current: DiffSummary = {
      available: true,
      reason: undefined,
      files: [{ path: 'a.txt', status: 'deleted', insertions: 0, deletions: 2 }],
      totalInsertions: 0,
      totalDeletions: 2,
      truncated: false,
    };
    expect(diffSince(baseline, current).files).toEqual(current.files);
  });

  it('基线不可用时原样返回当前快照', () => {
    const current: DiffSummary = { ...baseline, files: [] };
    expect(
      diffSince({ ...baseline, available: false, reason: 'not a git repository' }, current),
    ).toBe(current);
  });

  it('当前不可用时原样返回当前快照', () => {
    const current: DiffSummary = {
      available: false,
      reason: 'git is not available',
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      truncated: false,
    };
    expect(diffSince(baseline, current)).toBe(current);
  });

  it('保留当前快照的截断标记', () => {
    const current: DiffSummary = { ...baseline, truncated: true };
    expect(diffSince(baseline, current).truncated).toBe(true);
  });
});

describe('isStaticOnlyDiff', () => {
  function summary(paths: readonly string[], overrides: Partial<DiffSummary> = {}): DiffSummary {
    return {
      available: true,
      reason: undefined,
      files: paths.map((filePath) => ({
        path: filePath,
        status: 'modified',
        insertions: 1,
        deletions: 0,
      })),
      totalInsertions: paths.length,
      totalDeletions: 0,
      truncated: false,
      ...overrides,
    };
  }

  it('零改动视为静态改动', () => {
    expect(isStaticOnlyDiff(summary([]))).toBe(true);
  });

  it('仅静态资源扩展名（大小写不敏感）', () => {
    expect(
      isStaticOnlyDiff(summary(['docs/a.MD', 'web/style.css', 'index.html', 'img/logo.svg'])),
    ).toBe(true);
  });

  it('混入脚本或配置文件时返回 false', () => {
    expect(isStaticOnlyDiff(summary(['index.html', 'src/a.ts']))).toBe(false);
    expect(isStaticOnlyDiff(summary(['package.json']))).toBe(false);
  });

  it('纯 .txt 改动不视为静态，避免跳过读取测试样例的用例', () => {
    expect(isStaticOnlyDiff(summary(['hello.txt']))).toBe(false);
  });

  it('快照不可用或截断时保守返回 false', () => {
    expect(
      isStaticOnlyDiff(summary([], { available: false, reason: 'not a git repository' })),
    ).toBe(false);
    expect(isStaticOnlyDiff(summary(['a.css'], { truncated: true }))).toBe(false);
  });
});
