import { describe, expect, it } from 'vitest';
import { AGENT_SYSTEM_PROMPT } from '../../src/agent/loop.js';
import type { StepResult } from '../../src/agent/plan-runner.js';
import { buildRepairTask } from '../../src/agent/repair.js';
import {
  buildPlanSystemPrompt,
  PLAN_SYSTEM_PROMPT,
  REPAIR_PROMPT,
} from '../../src/planner/index.js';
import type { DiffSummary, VerificationResult } from '../../src/shared/reports.js';
import type { PlanStep, TaskPlan } from '../../src/shared/plan.js';
import type { TokenUsage } from '../../src/shared/token-usage.js';
import { EMPTY_USAGE } from '../../src/shared/token-usage.js';

const plan: TaskPlan = {
  goal: 'make tests pass',
  steps: [{ id: 's1', title: 'edit code', description: 'change src/a.ts', files: ['src/a.ts'] }],
  notes: undefined,
};

const failedVerification: VerificationResult = {
  status: 'failed',
  command: 'pnpm test',
  attempt: 1,
  exitCode: 1,
  timedOut: false,
  durationMs: 120,
  output: 'assertion failed',
  reason: 'exit code 1',
};

const diff: DiffSummary = {
  available: true,
  files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
  totalInsertions: 2,
  totalDeletions: 1,
  truncated: false,
  reason: undefined,
};

const usage: TokenUsage = EMPTY_USAGE;

function stepResult(answer: string): StepResult {
  return {
    step: plan.steps[0] as PlanStep,
    status: 'completed',
    answer,
    iterations: 1,
    toolCalls: 0,
    usage,
    stopReason: 'answer',
  };
}

describe('系统提示词不变量', () => {
  it('覆盖角色、安全边界、工作流、工具策略与完成条件', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('coding agent');
    expect(AGENT_SYSTEM_PROMPT).toContain('Workspace and safety:');
    expect(AGENT_SYSTEM_PROMPT).toContain('Workflow:');
    expect(AGENT_SYSTEM_PROMPT).toContain('Tools:');
    expect(AGENT_SYSTEM_PROMPT).toContain('Finish:');
  });

  it('声明关键安全禁令与相对路径约束', () => {
    const prompt = AGENT_SYSTEM_PROMPT;
    expect(prompt).toContain('relative to it');
    expect(prompt).toContain('outside the workspace');
    expect(prompt).toContain('.env');
    expect(prompt).toContain('.git');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('confirmation');
  });

  it('声明检索、最小改动与验证优先的工作流', () => {
    const prompt = AGENT_SYSTEM_PROMPT;
    expect(prompt).toContain('list_files');
    expect(prompt).toContain('search_code');
    expect(prompt).toContain('Read the current file before changing it');
    expect(prompt).toContain('minimal');
    expect(prompt).toContain('verify');
  });

  it('声明 write_file/edit_file、schema 校验与分页策略', () => {
    const prompt = AGENT_SYSTEM_PROMPT;
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('edit_file');
    expect(prompt).toContain('schemas');
    expect(prompt).toContain('never invent tool output');
    expect(prompt).toContain('offset/limit');
  });
});

describe('规划提示词不变量', () => {
  it('保持 JSON-only 输出格式', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('Return exactly one JSON object and nothing else');
    expect(PLAN_SYSTEM_PROMPT).toContain('Do not use markdown fences');
    expect(PLAN_SYSTEM_PROMPT).toContain('do not call tools');
  });

  it('正确插值最大步骤数且不残留占位符', () => {
    const prompt = buildPlanSystemPrompt(7);
    expect(prompt).toContain('1 to 7 steps');
    expect(prompt).not.toContain('{MAX_STEPS}');
    expect(buildPlanSystemPrompt(1)).toContain('1 to 1 steps');
  });

  it('要求具体动作、文件路径与验证步骤', () => {
    const prompt = PLAN_SYSTEM_PROMPT;
    expect(prompt).toContain('directly actionable');
    expect(prompt).toContain('concrete file, behavior, or verification command');
    expect(prompt).toContain('workspace-relative paths');
    expect(prompt).toContain('empty array when unsure');
    expect(prompt).toContain('verification step');
    expect(prompt).toContain('Do not add a step that only replans');
  });

  it('声明安全禁令与最小计划约束', () => {
    const prompt = PLAN_SYSTEM_PROMPT;
    expect(prompt).toContain('outside the workspace');
    expect(prompt).toContain('.env');
    expect(prompt).toContain('.git');
    expect(prompt).toContain('destructive commands');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('speculative refactors');
  });

  it('规划修复提示保留错误占位符与 JSON-only 要求', () => {
    expect(REPAIR_PROMPT).toContain('{ERROR}');
    expect(REPAIR_PROMPT).toContain('only a corrected JSON object');
    expect(REPAIR_PROMPT).toContain('Do not add explanations or markdown fences');
  });
});

describe('修复任务提示词不变量', () => {
  it('要求先检查现状且不重跑已完成步骤', () => {
    const text = buildRepairTask({
      goal: plan.goal,
      plan,
      stepResults: [stepResult('changed src/a.ts')],
      verification: failedVerification,
      diff,
    });
    expect(text).toContain('Verification failed');
    expect(text).toContain('Do not rerun steps that already completed');
    expect(text).toContain('inspect the current files first');
  });

  it('要求最小修复、重跑命令并报告结果', () => {
    const text = buildRepairTask({
      goal: plan.goal,
      plan,
      stepResults: [stepResult('changed src/a.ts')],
      verification: failedVerification,
      diff,
    });
    expect(text).toContain('Keep the repair minimal');
    expect(text).toContain('do not install dependencies');
    expect(text).toContain('Rerun the failed command when possible');
    expect(text).toContain('summary of what you changed and how you verified it');
  });

  it('保留工作区、git push 与环境问题的既有约束', () => {
    const text = buildRepairTask({
      goal: plan.goal,
      plan,
      stepResults: [],
      verification: failedVerification,
      diff,
    });
    expect(text).toContain('Only modify files inside the workspace');
    expect(text).toContain('Do not run git push');
    expect(text).toContain('If the failure looks environmental');
  });
});

describe('提示词不含示例密钥', () => {
  it('所有提示词与修复任务中不出现密钥样式文本', () => {
    const corpus = [
      AGENT_SYSTEM_PROMPT,
      buildPlanSystemPrompt(12),
      REPAIR_PROMPT,
      buildRepairTask({
        goal: plan.goal,
        plan,
        stepResults: [],
        verification: failedVerification,
        diff,
      }),
    ].join('\n');
    expect(corpus).not.toMatch(/\bsk-[A-Za-z0-9]{8,}/);
    expect(corpus).not.toMatch(/\b(?:API_KEY|TOKEN|PASSWORD)\s*=/);
    expect(corpus).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });
});
