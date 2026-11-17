import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRepairTask, runRepair } from '../../src/agent/repair.js';
import type { StepResult } from '../../src/agent/plan-runner.js';
import type { ContextManager, ContextStats } from '../../src/context/manager.js';
import { createMockProvider } from '../../src/llm/providers/mock.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamChunk,
} from '../../src/llm/types.js';
import type { TaskPlan } from '../../src/planner/types.js';
import { createIgnoreMatcher } from '../../src/security/ignore.js';
import { EMPTY_USAGE } from '../../src/shared/token-usage.js';
import type { DiffSummary, VerificationResult } from '../../src/shared/reports.js';
import { ToolRegistry } from '../../src/tools/index.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'agent-repair-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function planOf(): TaskPlan {
  return {
    goal: 'make tests pass',
    steps: [
      { id: 's1', title: 'edit code', description: 'change src/a.ts', files: ['src/a.ts'] },
      { id: 's2', title: 'add test', description: 'add tests', files: [] },
    ],
    notes: undefined,
  };
}

function stepResult(stepIndex: number, answer: string): StepResult {
  const step = planOf().steps[stepIndex];
  if (step === undefined) {
    throw new Error('missing step');
  }
  return {
    step,
    status: 'completed',
    answer,
    iterations: 1,
    toolCalls: 0,
    usage: EMPTY_USAGE,
    stopReason: 'answer',
  };
}

function failedVerification(output = 'boom'): VerificationResult {
  return {
    status: 'failed',
    command: 'pnpm test',
    attempt: 1,
    exitCode: 1,
    timedOut: false,
    durationMs: 12,
    output,
    reason: 'exit code 1',
  };
}

const availableDiff: DiffSummary = {
  available: true,
  reason: undefined,
  files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
  totalInsertions: 2,
  totalDeletions: 1,
  truncated: false,
};

function fakeContext(): ContextManager {
  const stats: ContextStats = {
    budgetTokens: 4000,
    repoMapTokens: 0,
    repoMapFiles: 0,
    repoMapTruncated: false,
    repoMapDropped: false,
    initialTokens: 0,
    droppedMessages: 0,
    truncatedToolMessages: 0,
    lastRequestTokens: 0,
  };
  return {
    budgetTokens: 4000,
    buildMessages: (task) =>
      Promise.resolve<readonly ChatMessage[]>([
        { role: 'system', content: 'system' },
        { role: 'user', content: task },
      ]),
    fit: (messages) => messages,
    stats: () => stats,
  };
}

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    description: 'echo input',
    parameters: z.object({ text: z.string() }),
    riskLevel: 'low',
    execute: (params) => Promise.resolve({ ok: true, content: params.text }),
  });
}

function baseOptions(provider: LLMProvider) {
  return {
    attempt: 1,
    goal: 'make tests pass',
    plan: planOf(),
    stepResults: [stepResult(0, 'changed code')],
    verification: failedVerification(),
    diff: availableDiff,
    maxIterations: 3,
    provider,
    tools: echoRegistry(),
    workspace,
    ignore: createIgnoreMatcher({ workspace, respectGitignore: false }),
    context: fakeContext(),
    signal: new AbortController().signal,
  };
}

describe('buildRepairTask', () => {
  it('包含目标、计划、步骤结果、失败验证与差异', () => {
    const text = buildRepairTask({
      goal: 'make tests pass',
      plan: planOf(),
      stepResults: [stepResult(0, 'changed code'), stepResult(1, 'added test')],
      verification: failedVerification('assertion failed'),
      diff: availableDiff,
    });

    expect(text).toContain('Goal: make tests pass');
    expect(text).toContain('1. [s1] edit code: change src/a.ts');
    expect(text).toContain('- [s1] completed: changed code');
    expect(text).toContain('command pnpm test');
    expect(text).toContain('exit code 1');
    expect(text).toContain('assertion failed');
    expect(text).toContain('modified 2/-1 src/a.ts');
    expect(text).toContain('Do not run git push');
    expect(text).toContain('If the failure looks environmental');
  });

  it('输出只保留尾部，非 git 差异标注 unavailable', () => {
    const text = buildRepairTask({
      goal: 'g',
      plan: planOf(),
      stepResults: [],
      verification: failedVerification(`${'x'.repeat(5000)}TAIL-MARKER`),
      diff: {
        available: false,
        reason: 'not a git repository',
        files: [],
        totalInsertions: 0,
        totalDeletions: 0,
        truncated: false,
      },
    });

    expect(text).toContain('TAIL-MARKER');
    expect(text).not.toContain('x'.repeat(4500));
    expect(text).toContain('unavailable (not a git repository)');
  });

  it('步骤答案过长时截断', () => {
    const text = buildRepairTask({
      goal: 'g',
      plan: planOf(),
      stepResults: [stepResult(0, 'a'.repeat(800))],
      verification: failedVerification(),
      diff: availableDiff,
    });
    expect(text).toContain('…');
    expect(text).not.toContain('a'.repeat(600));
  });
});

describe('runRepair', () => {
  it('复用 AgentLoop 并返回修复结果', async () => {
    let captured: readonly ChatMessage[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      chat: (request: ChatRequest): Promise<ChatResponse> => {
        captured = request.messages;
        return Promise.resolve({
          content: 'fixed the test',
          reasoningContent: undefined,
          finishReason: 'stop',
          usage: { ...EMPTY_USAGE, totalTokens: 20 },
          model: 'capture',
          toolCalls: [],
        });
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream is not used');
      },
    };

    const outcome = await runRepair(baseOptions(provider));

    expect(outcome).toMatchObject({
      attempt: 1,
      answer: 'fixed the test',
      stopReason: 'answer',
      iterations: 1,
      toolCalls: 0,
    });
    expect(outcome.usage.totalTokens).toBe(20);
    const userMessage = captured.find((message) => message.role === 'user');
    expect(userMessage?.content).toContain('Verification failed');
    expect(userMessage?.content).toContain('command pnpm test');
  });

  it('修复循环未给出答案时返回对应停止原因', async () => {
    const provider = createMockProvider({
      script: [{ toolCalls: [{ name: 'echo', arguments: '{"text":"again"}' }] }],
    });

    const outcome = await runRepair({ ...baseOptions(provider), maxIterations: 1 });

    expect(outcome.stopReason).toBe('max_iterations');
    expect(outcome.toolCalls).toBe(1);
  });
});
