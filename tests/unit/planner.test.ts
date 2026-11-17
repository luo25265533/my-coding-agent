import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MockStep } from '../../src/config/schema.js';
import { createPlanner } from '../../src/planner/planner.js';
import { MAX_PLAN_BYTES, parseTaskPlan, PlanParseError } from '../../src/planner/parse.js';
import type { TaskPlan } from '../../src/planner/types.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import type { ChatRequest, LLMProvider } from '../../src/llm/types.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';
import { AgentError, ErrorCode } from '../../src/shared/errors.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'agent-planner-'));
const outside = mkdtempSync(path.join(tmpdir(), 'agent-planner-outside-'));
const ignore = createIgnoreMatcher({ workspace });

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function planJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: 'add a greeting',
    steps: [
      {
        id: '1',
        title: 'create greeting',
        description: 'write hello.txt',
        files: ['hello.txt'],
      },
    ],
    notes: 'none',
    ...overrides,
  });
}

function parse(raw: string, maxSteps = 12): TaskPlan {
  return parseTaskPlan(raw, { workspace, maxSteps });
}

function planError(raw: string, maxSteps = 12): PlanParseError {
  try {
    parse(raw, maxSteps);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanParseError);
    return error as PlanParseError;
  }
  throw new Error('expected PlanParseError');
}

describe('parseTaskPlan', () => {
  it('解析纯 JSON 计划', () => {
    const plan = parse(planJson());
    expect(plan.goal).toBe('add a greeting');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toEqual({
      id: '1',
      title: 'create greeting',
      description: 'write hello.txt',
      files: ['hello.txt'],
    });
    expect(plan.notes).toBe('none');
  });

  it('容忍 markdown 围栏与前后说明文字', () => {
    const raw = `Here is the plan:\n\`\`\`json\n${planJson()}\n\`\`\`\nThanks.`;
    expect(parse(raw).steps[0]?.title).toBe('create greeting');
  });

  it('数字 id 转为字符串，notes 为 null 时归一为 undefined', () => {
    const plan = parse(planJson({ notes: null }));
    expect(plan.steps[0]?.id).toBe('1');
    expect(plan.notes).toBeUndefined();
  });

  it('files 缺省时为空数组', () => {
    const raw = JSON.stringify({
      goal: 'g',
      steps: [{ id: '1', title: 't', description: 'd' }],
    });
    expect(parse(raw).steps[0]?.files).toEqual([]);
  });

  it('拒绝空响应、非 JSON 与无 JSON 对象', () => {
    expect(planError('').message).toContain('empty');
    expect(planError('not json').message).toContain('did not contain a JSON object');
    expect(planError('{oops}').message).toContain('not valid JSON');
  });

  it('拒绝超过 20 KB 的响应', () => {
    expect(planError('x'.repeat(MAX_PLAN_BYTES + 1)).message).toContain('too large');
  });

  it('拒绝结构非法：步数为 0、超过上限、字段越界', () => {
    expect(planError(planJson({ steps: [] })).message).toContain('steps');
    expect(planError(planJson(), 0).message).toContain('steps');
    expect(planError(planJson({ goal: 'g'.repeat(501) })).message).toContain('goal');
    expect(
      planError(planJson({ steps: [{ id: '1', title: '', description: 'd', files: [] }] })).message,
    ).toContain('title');
    expect(
      planError(planJson({ steps: [{ id: '1', title: 't', description: '', files: [] }] })).message,
    ).toContain('description');
    expect(
      planError(
        planJson({
          steps: [
            { id: '1', title: 't1', description: 'd1', files: [] },
            { id: '2', title: 't2', description: 'd2', files: [] },
          ],
        }),
        1,
      ).message,
    ).toContain('steps');
  });

  it('拒绝重复、空或过长的步骤 id', () => {
    const duplicate = planJson({
      steps: [
        { id: 'a', title: 't1', description: 'd1', files: [] },
        { id: 'a', title: 't2', description: 'd2', files: [] },
      ],
    });
    expect(planError(duplicate).message).toContain('duplicate');

    const emptyId = planJson({ steps: [{ id: '  ', title: 't', description: 'd', files: [] }] });
    expect(planError(emptyId).message).toContain('id');

    const longId = planJson({
      steps: [{ id: 'x'.repeat(33), title: 't', description: 'd', files: [] }],
    });
    expect(planError(longId).message).toContain('32');
  });

  it('拒绝绝对路径、越界路径、敏感文件与 .git', () => {
    const absolute = planJson({
      steps: [{ id: '1', title: 't', description: 'd', files: [path.join(workspace, 'a.ts')] }],
    });
    expect(planError(absolute).message).toContain('relative');

    const escape = planJson({
      steps: [{ id: '1', title: 't', description: 'd', files: ['../outside/a.ts'] }],
    });
    expect(planError(escape).message).toContain('escapes workspace');

    const secret = planJson({
      steps: [{ id: '1', title: 't', description: 'd', files: ['.env'] }],
    });
    expect(planError(secret).message).toContain('sensitive file');

    const git = planJson({
      steps: [{ id: '1', title: 't', description: 'd', files: ['.git/config'] }],
    });
    expect(planError(git).message).toContain('.git');
  });

  it('拒绝经由符号链接目录逃逸的路径', () => {
    mkdirSync(path.join(workspace, 'linked'), { recursive: true });
    writeFileSync(path.join(outside, 'target.ts'), 'export {};\n');
    try {
      rmSync(path.join(workspace, 'linked'), { recursive: true, force: true });
      symlinkSync(outside, path.join(workspace, 'linked'), 'dir');
    } catch {
      return;
    }
    const escape = planJson({
      steps: [{ id: '1', title: 't', description: 'd', files: ['linked/new.ts'] }],
    });
    expect(planError(escape).message).toContain('outside workspace');
  });
});

interface RecordingProvider {
  readonly provider: LLMProvider;
  readonly requests: ChatRequest[];
}

function recordingProvider(script: readonly MockStep[] | undefined): RecordingProvider {
  const inner = createMockProvider({ script });
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: {
      name: 'recording',
      chat: (request) => {
        requests.push(request);
        return inner.chat(request);
      },
      stream: (request) => inner.stream(request),
    },
  };
}

function plannerFor(script: readonly MockStep[] | undefined) {
  const recording = recordingProvider(script);
  const planner = createPlanner({
    provider: recording.provider,
    workspace,
    ignore,
    contextBudgetTokens: 4000,
    maxSteps: 12,
  });
  return { planner, requests: recording.requests };
}

describe('createPlanner', () => {
  it('首次返回合法 Plan 时一次成功并统计用量', async () => {
    const { planner, requests } = plannerFor([{ content: planJson() }]);

    const result = await planner.plan('add a greeting');

    expect(result.attempts).toBe(1);
    expect(result.plan.goal).toBe('add a greeting');
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.repoMapTokens).toBeGreaterThanOrEqual(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.messages[1]?.content).toBe('add a greeting');
  });

  it('首次非法时携带错误自动修复一次', async () => {
    const { planner, requests } = plannerFor([
      { content: 'I will not use JSON' },
      { content: planJson() },
    ]);

    const result = await planner.plan('add a greeting');

    expect(result.attempts).toBe(2);
    expect(requests).toHaveLength(2);
    const repairMessages = requests[1]?.messages ?? [];
    expect(repairMessages.some((message) => message.role === 'assistant')).toBe(true);
    const last = repairMessages[repairMessages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain('previous answer was invalid');
  });

  it('两次都非法时抛 PLANNER_INVALID', async () => {
    const { planner } = plannerFor([{ content: 'nope' }, { content: 'still nope' }]);

    const error = await planner.plan('x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(ErrorCode.PlannerInvalid);
    expect((error as AgentError).exitCode).toBe(1);
    expect((error as Error).message).toContain('2 attempts');
  });

  it('语义校验失败也走修复路径', async () => {
    const { planner } = plannerFor([
      {
        content: planJson({ steps: [{ id: '1', title: 't', description: 'd', files: ['.env'] }] }),
      },
      { content: planJson() },
    ]);

    const result = await planner.plan('x');
    expect(result.attempts).toBe(2);
  });

  it('空工作区也能生成计划（仓库概览为空）', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'agent-planner-empty-'));
    try {
      const inner = createMockProvider({ script: [{ content: planJson() }] });
      const planner = createPlanner({
        provider: inner,
        workspace: empty,
        ignore: createIgnoreMatcher({ workspace: empty }),
        contextBudgetTokens: 1000,
        maxSteps: 12,
      });
      const result = await planner.plan('x');
      expect(result.attempts).toBe(1);
      expect(result.repoMapTokens).toBeGreaterThan(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
