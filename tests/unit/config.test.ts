import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, REDACTED, redactConfig, UNSET } from '../../src/config/load.js';
import { ConfigError } from '../../src/shared/errors.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'agent-config-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function load(env: NodeJS.ProcessEnv) {
  return loadConfig({ cwd, env, envFilePath: null });
}

describe('默认值', () => {
  it('空环境时全部默认值生效', () => {
    const config = load({});
    expect(config.llm.provider).toBe('mock');
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.llm.timeoutMs).toBe(60_000);
    expect(config.llm.maxRetries).toBe(2);
    expect(config.agent.maxIterations).toBe(20);
    expect(config.agent.maxRepeatedCalls).toBe(3);
    expect(config.agent.maxConsecutiveFailures).toBe(3);
    expect(config.agent.contextBudgetTokens).toBe(16_000);
    expect(config.agent.respectGitignore).toBe(true);
    expect(config.agent.ignorePatterns).toEqual([]);
    expect(config.agent.confirmHighRisk).toBe(true);
    expect(config.agent.confirmTimeoutMs).toBe(300_000);
    expect(config.agent.planMaxSteps).toBe(12);
    expect(config.agent.stepMaxIterations).toBe(10);
    expect(config.agent.commandTimeoutMs).toBe(30_000);
    expect(config.agent.taskDb).toBe(path.join(cwd, '.agent', 'tasks.db'));
    expect(config.agent.verifyCommand).toBe('pnpm test');
    expect(config.agent.verifyCommandExplicit).toBe(false);
    expect(config.agent.verifyTimeoutMs).toBe(300_000);
    expect(config.agent.verifySkipStatic).toBe(true);
    expect(config.agent.maxRepairAttempts).toBe(2);
    expect(config.agent.repairMaxIterations).toBe(8);
    expect(config.log.level).toBe('info');
    expect(config.log.pretty).toBe(true);
  });

  it('workspace 与日志目录解析为绝对路径', () => {
    const config = load({});
    expect(path.isAbsolute(config.agent.workspace)).toBe(true);
    expect(config.agent.workspace).toBe(cwd);
    expect(config.log.dir).toBe(path.join(cwd, '.agent', 'logs'));
  });

  it('相对 workspace 被解析，日志目录基于 workspace', () => {
    const config = load({ AGENT_WORKSPACE: 'sub/project' });
    expect(config.agent.workspace).toBe(path.join(cwd, 'sub', 'project'));
    expect(config.log.dir).toBe(path.join(cwd, 'sub', 'project', '.agent', 'logs'));
  });
});

describe('校验失败', () => {
  it('非法 log level 报 ConfigError 且指出字段', () => {
    expect(() => load({ AGENT_LOG_LEVEL: 'nope' })).toThrow(ConfigError);
    expect(() => load({ AGENT_LOG_LEVEL: 'nope' })).toThrow(/AGENT_LOG_LEVEL/);
  });

  it('provider 非 mock 时缺 apiKey 报错', () => {
    expect(() => load({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'https://x/v1' })).toThrow(
      /LLM_API_KEY/,
    );
  });

  it('openai-compatible 缺 baseUrl 报错', () => {
    expect(() => load({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-x' })).toThrow(
      /LLM_BASE_URL/,
    );
  });

  it('provider 非 mock 时缺 model 报错', () => {
    expect(() =>
      load({
        LLM_PROVIDER: 'openai-compatible',
        LLM_API_KEY: 'sk-x',
        LLM_BASE_URL: 'https://api.example.com/v1',
      }),
    ).toThrow(/LLM_MODEL/);
  });

  it('mock provider 不要求 model', () => {
    expect(load({ LLM_PROVIDER: 'mock' }).llm.model).toBeUndefined();
  });

  it('未知 provider 报错', () => {
    expect(() => load({ LLM_PROVIDER: 'anthropic' })).toThrow(/LLM_PROVIDER/);
  });

  it('迭代次数越界或非数字报错', () => {
    expect(() => load({ AGENT_MAX_ITERATIONS: '0' })).toThrow(/AGENT_MAX_ITERATIONS/);
    expect(() => load({ AGENT_MAX_ITERATIONS: 'abc' })).toThrow(/AGENT_MAX_ITERATIONS/);
  });

  it('熔断阈值越界或非数字报错', () => {
    expect(() => load({ AGENT_MAX_REPEATED_CALLS: '1' })).toThrow(/AGENT_MAX_REPEATED_CALLS/);
    expect(() => load({ AGENT_MAX_REPEATED_CALLS: '101' })).toThrow(/AGENT_MAX_REPEATED_CALLS/);
    expect(() => load({ AGENT_MAX_REPEATED_CALLS: 'abc' })).toThrow(/AGENT_MAX_REPEATED_CALLS/);
    expect(() => load({ AGENT_MAX_CONSECUTIVE_FAILURES: '0' })).toThrow(
      /AGENT_MAX_CONSECUTIVE_FAILURES/,
    );
    expect(() => load({ AGENT_MAX_CONSECUTIVE_FAILURES: '101' })).toThrow(
      /AGENT_MAX_CONSECUTIVE_FAILURES/,
    );
  });

  it('上下文预算越界或非数字报错', () => {
    expect(() => load({ AGENT_CONTEXT_BUDGET_TOKENS: '999' })).toThrow(
      /AGENT_CONTEXT_BUDGET_TOKENS/,
    );
    expect(() => load({ AGENT_CONTEXT_BUDGET_TOKENS: '200001' })).toThrow(
      /AGENT_CONTEXT_BUDGET_TOKENS/,
    );
    expect(() => load({ AGENT_CONTEXT_BUDGET_TOKENS: 'many' })).toThrow(
      /AGENT_CONTEXT_BUDGET_TOKENS/,
    );
    expect(() => load({ AGENT_RESPECT_GITIGNORE: 'maybe' })).toThrow(/AGENT_RESPECT_GITIGNORE/);
  });

  it('非法布尔值报错', () => {
    expect(() => load({ AGENT_CONFIRM_HIGH_RISK: 'yes' })).toThrow(/AGENT_CONFIRM_HIGH_RISK/);
  });

  it('验证与修复配置越界或非数字报错', () => {
    expect(() => load({ AGENT_VERIFY_TIMEOUT_MS: '999' })).toThrow(/AGENT_VERIFY_TIMEOUT_MS/);
    expect(() => load({ AGENT_VERIFY_TIMEOUT_MS: '600001' })).toThrow(/AGENT_VERIFY_TIMEOUT_MS/);
    expect(() => load({ AGENT_VERIFY_TIMEOUT_MS: 'slow' })).toThrow(/AGENT_VERIFY_TIMEOUT_MS/);
    expect(() => load({ AGENT_CONFIRM_TIMEOUT_MS: '999' })).toThrow(/AGENT_CONFIRM_TIMEOUT_MS/);
    expect(() => load({ AGENT_CONFIRM_TIMEOUT_MS: '3600001' })).toThrow(/AGENT_CONFIRM_TIMEOUT_MS/);
    expect(() => load({ AGENT_CONFIRM_TIMEOUT_MS: 'soon' })).toThrow(/AGENT_CONFIRM_TIMEOUT_MS/);
    expect(() => load({ AGENT_MAX_REPAIR_ATTEMPTS: '-1' })).toThrow(/AGENT_MAX_REPAIR_ATTEMPTS/);
    expect(() => load({ AGENT_MAX_REPAIR_ATTEMPTS: '11' })).toThrow(/AGENT_MAX_REPAIR_ATTEMPTS/);
    expect(() => load({ AGENT_REPAIR_MAX_ITERATIONS: '0' })).toThrow(/AGENT_REPAIR_MAX_ITERATIONS/);
    expect(() => load({ AGENT_REPAIR_MAX_ITERATIONS: '101' })).toThrow(
      /AGENT_REPAIR_MAX_ITERATIONS/,
    );
  });

  it('AGENT_VERIFY_COMMAND 超长或含 NUL 报错', () => {
    expect(() => load({ AGENT_VERIFY_COMMAND: 'x'.repeat(1001) })).toThrow(/AGENT_VERIFY_COMMAND/);
    expect(() => load({ AGENT_VERIFY_COMMAND: 'pnpm test\u0000' })).toThrow(/AGENT_VERIFY_COMMAND/);
  });

  it('AGENT_TASK_DB 越界、.git 与敏感文件名被拒', () => {
    expect(() => load({ AGENT_TASK_DB: '../outside.db' })).toThrow(ConfigError);
    expect(() => load({ AGENT_TASK_DB: '../outside.db' })).toThrow(/AGENT_TASK_DB/);
    expect(() => load({ AGENT_TASK_DB: '.git/tasks.db' })).toThrow(/AGENT_TASK_DB/);
    expect(() => load({ AGENT_TASK_DB: '.env' })).toThrow(/sensitive/);
  });

  it('规划与命令超时配置越界报错', () => {
    expect(() => load({ AGENT_PLAN_MAX_STEPS: '0' })).toThrow(/AGENT_PLAN_MAX_STEPS/);
    expect(() => load({ AGENT_PLAN_MAX_STEPS: '51' })).toThrow(/AGENT_PLAN_MAX_STEPS/);
    expect(() => load({ AGENT_PLAN_MAX_STEPS: 'abc' })).toThrow(/AGENT_PLAN_MAX_STEPS/);
    expect(() => load({ AGENT_STEP_MAX_ITERATIONS: '0' })).toThrow(/AGENT_STEP_MAX_ITERATIONS/);
    expect(() => load({ AGENT_STEP_MAX_ITERATIONS: '101' })).toThrow(/AGENT_STEP_MAX_ITERATIONS/);
    expect(() => load({ AGENT_COMMAND_TIMEOUT_MS: '999' })).toThrow(/AGENT_COMMAND_TIMEOUT_MS/);
    expect(() => load({ AGENT_COMMAND_TIMEOUT_MS: '600001' })).toThrow(/AGENT_COMMAND_TIMEOUT_MS/);
    expect(() => load({ AGENT_COMMAND_TIMEOUT_MS: 'slow' })).toThrow(/AGENT_COMMAND_TIMEOUT_MS/);
  });
});

describe('取值解析', () => {
  it('openai-compatible 配置齐全时通过', () => {
    const config = load({
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: 'sk-x',
      LLM_BASE_URL: 'https://api.example.com/v1',
      LLM_MODEL: 'some-model',
    });
    expect(config.llm.provider).toBe('openai-compatible');
    expect(config.llm.model).toBe('some-model');
  });

  it('布尔字符串 true/false/1/0 正确解析', () => {
    expect(load({ AGENT_LOG_PRETTY: 'false' }).log.pretty).toBe(false);
    expect(load({ AGENT_LOG_PRETTY: '0' }).log.pretty).toBe(false);
    expect(load({ AGENT_CONFIRM_HIGH_RISK: '1' }).agent.confirmHighRisk).toBe(true);
    expect(load({ AGENT_CONFIRM_HIGH_RISK: 'true' }).agent.confirmHighRisk).toBe(true);
  });

  it('数字字符串被强制转换', () => {
    expect(load({ LLM_TIMEOUT_MS: '1500' }).llm.timeoutMs).toBe(1500);
    expect(load({ AGENT_MAX_REPEATED_CALLS: '5' }).agent.maxRepeatedCalls).toBe(5);
    expect(load({ AGENT_MAX_CONSECUTIVE_FAILURES: '1' }).agent.maxConsecutiveFailures).toBe(1);
    expect(load({ AGENT_CONTEXT_BUDGET_TOKENS: '8000' }).agent.contextBudgetTokens).toBe(8000);
    expect(load({ AGENT_PLAN_MAX_STEPS: '6' }).agent.planMaxSteps).toBe(6);
    expect(load({ AGENT_STEP_MAX_ITERATIONS: '4' }).agent.stepMaxIterations).toBe(4);
    expect(load({ AGENT_COMMAND_TIMEOUT_MS: '1500' }).agent.commandTimeoutMs).toBe(1500);
  });

  it('AGENT_IGNORE 按逗号与换行拆分并裁剪空白', () => {
    expect(load({ AGENT_IGNORE: ' tmp/ , *.log\nbuild/ , ' }).agent.ignorePatterns).toEqual([
      'tmp/',
      '*.log',
      'build/',
    ]);
  });

  it('阶段 7 数值配置被强制转换并接受边界值', () => {
    const config = load({
      AGENT_VERIFY_TIMEOUT_MS: '1500',
      AGENT_CONFIRM_TIMEOUT_MS: '60000',
      AGENT_VERIFY_SKIP_STATIC: '0',
      AGENT_MAX_REPAIR_ATTEMPTS: '0',
      AGENT_REPAIR_MAX_ITERATIONS: '1',
      AGENT_TASK_DB: 'state/tasks.db',
    });
    expect(config.agent.verifyTimeoutMs).toBe(1500);
    expect(config.agent.confirmTimeoutMs).toBe(60_000);
    expect(config.agent.verifySkipStatic).toBe(false);
    expect(config.agent.maxRepairAttempts).toBe(0);
    expect(config.agent.repairMaxIterations).toBe(1);
    expect(config.agent.taskDb).toBe(path.join(cwd, 'state', 'tasks.db'));
  });

  it('AGENT_VERIFY_COMMAND 显式提供时标记 explicit（含空值）', () => {
    expect(load({ AGENT_VERIFY_COMMAND: 'pnpm run check' }).agent).toMatchObject({
      verifyCommand: 'pnpm run check',
      verifyCommandExplicit: true,
    });
    expect(load({ AGENT_VERIFY_COMMAND: '  ' }).agent).toMatchObject({
      verifyCommand: undefined,
      verifyCommandExplicit: true,
    });
  });

  it('.env 中的 AGENT_VERIFY_COMMAND 也标记 explicit', () => {
    writeFileSync(path.join(cwd, '.env'), 'AGENT_VERIFY_COMMAND=pnpm test\n', 'utf8');
    const config = loadConfig({ cwd, env: {} });
    expect(config.agent.verifyCommand).toBe('pnpm test');
    expect(config.agent.verifyCommandExplicit).toBe(true);
  });

  it('AGENT_RESPECT_GITIGNORE 解析布尔值', () => {
    expect(load({ AGENT_RESPECT_GITIGNORE: '0' }).agent.respectGitignore).toBe(false);
    expect(load({ AGENT_RESPECT_GITIGNORE: 'true' }).agent.respectGitignore).toBe(true);
  });

  it('空白字符串视为未设置', () => {
    expect(load({ LLM_API_KEY: '   ' }).llm.apiKey).toBeUndefined();
  });

  it('首尾空白被裁剪', () => {
    expect(load({ LLM_MODEL: '  m  ' }).llm.model).toBe('m');
  });
});

describe('日志目录沙箱', () => {
  it('相对路径逃逸 workspace 被拒', () => {
    expect(() => load({ AGENT_LOG_DIR: '../outside' })).toThrow(/must stay inside/);
  });

  it('绝对路径指向 workspace 外被拒', () => {
    expect(() => load({ AGENT_LOG_DIR: path.join(tmpdir(), 'agent-outside') })).toThrow(
      /must stay inside/,
    );
  });

  it('workspace 内的绝对路径被接受', () => {
    const inside = path.join(cwd, 'mylogs');
    expect(load({ AGENT_LOG_DIR: inside }).log.dir).toBe(inside);
  });

  it('workspace 内的嵌套相对路径被接受', () => {
    expect(load({ AGENT_LOG_DIR: 'logs/deep' }).log.dir).toBe(path.join(cwd, 'logs', 'deep'));
  });
});

describe('.env 与优先级', () => {
  it('读取 .env 文件', () => {
    writeFileSync(path.join(cwd, '.env'), 'AGENT_LOG_LEVEL=warn\n', 'utf8');
    expect(loadConfig({ cwd, env: {} }).log.level).toBe('warn');
  });

  it('进程环境变量覆盖 .env', () => {
    writeFileSync(path.join(cwd, '.env'), 'AGENT_LOG_LEVEL=warn\n', 'utf8');
    expect(loadConfig({ cwd, env: { AGENT_LOG_LEVEL: 'error' } }).log.level).toBe('error');
  });

  it('.env 不存在时不报错', () => {
    expect(loadConfig({ cwd, env: {} }).llm.provider).toBe('mock');
  });

  it('.env 路径是目录时抛 ConfigError 而非静默忽略', () => {
    mkdirSync(path.join(cwd, '.env'));
    expect(() => loadConfig({ cwd, env: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd, env: {} })).toThrow(/Failed to read env file/);
  });

  it('envFilePath=null 时跳过 .env', () => {
    writeFileSync(path.join(cwd, '.env'), 'AGENT_LOG_LEVEL=warn\n', 'utf8');
    expect(loadConfig({ cwd, env: {}, envFilePath: null }).log.level).toBe('info');
  });
});

describe('不可变性与脱敏', () => {
  it('返回对象及其嵌套层全部冻结', () => {
    const config = load({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.llm)).toBe(true);
    expect(Object.isFrozen(config.agent)).toBe(true);
    expect(Object.isFrozen(config.log)).toBe(true);
  });

  it('redactConfig 不泄露明文密钥，原配置保留真实值', () => {
    const config = load({
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: 'sk-super-secret',
      LLM_BASE_URL: 'https://api.example.com/v1',
      LLM_MODEL: 'some-model',
    });
    const redacted = redactConfig(config);
    expect(config.llm.apiKey).toBe('sk-super-secret');
    expect(redacted.llm.apiKey).toBe(REDACTED);
    expect(JSON.stringify(redacted)).not.toContain('sk-super-secret');
  });

  it('未设置密钥时显示 unset 占位', () => {
    expect(redactConfig(load({})).llm.apiKey).toBe(UNSET);
  });
});

describe('AGENT_MOCK_SCRIPT', () => {
  it('mock provider 下读取脚本文件（相对 workspace）', () => {
    writeFileSync(
      path.join(cwd, 'script.json'),
      JSON.stringify([
        { toolCalls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] },
        { content: 'done' },
      ]),
    );

    const config = load({ AGENT_MOCK_SCRIPT: 'script.json' });
    expect(config.agent.mockScript).toEqual([
      { toolCalls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { content: 'done' },
    ]);
  });

  it('未配置时为 undefined', () => {
    expect(load({}).agent.mockScript).toBeUndefined();
  });

  it('脚本路径越界报 ConfigError', () => {
    expect(() => load({ AGENT_MOCK_SCRIPT: '../script.json' })).toThrow(/must stay inside/);
  });

  it('非 JSON 与结构非法均报 ConfigError', () => {
    writeFileSync(path.join(cwd, 'bad.json'), 'not json');
    expect(() => load({ AGENT_MOCK_SCRIPT: 'bad.json' })).toThrow(/not valid JSON/);

    writeFileSync(path.join(cwd, 'shape.json'), JSON.stringify([{ content: 1 }]));
    expect(() => load({ AGENT_MOCK_SCRIPT: 'shape.json' })).toThrow(/Invalid AGENT_MOCK_SCRIPT/);
  });

  it('非 mock provider 下忽略脚本文件', () => {
    const config = load({
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'https://x/v1',
      LLM_MODEL: 'm',
      AGENT_MOCK_SCRIPT: 'missing.json',
    });
    expect(config.agent.mockScript).toBeUndefined();
  });
});
