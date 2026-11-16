#!/usr/bin/env node
/**
 * 阶段 2 离线验收：一条命令跑完静态门禁 + 全量测试 + mock REPL 多轮演示。
 * 全程不联网、不消耗模型配额；真实端点验证请另跑：
 *   ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`);
}

function heading(text) {
  console.log(`\n== ${text}`);
}

function tailLines(text, count) {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

/** Windows 下 spawn pnpm.cmd 必须经过 shell；参数均为常量，无注入风险 */
function runPnpm(args) {
  return spawnSync('pnpm', args, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: 900_000,
    env: { ...process.env, ZHIPU_LIVE_TEST: '' },
  });
}

function gate(name, args, validate) {
  heading(name);
  const started = Date.now();
  const result = runPnpm(args);
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0 && (validate === undefined || validate(output));
  console.log(ok ? tailLines(output, 3) : output.trimEnd());
  record(name, ok, elapsed);
  return ok;
}

function findLogFile(workspace) {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(workspace, 'logs', `agent-${date}.jsonl`);
  return existsSync(file) ? file : undefined;
}

function readLogLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function replDemo() {
  heading('chat REPL 多轮演示（mock provider，零成本）');
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-verify-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'cli', 'main.ts'), 'chat'],
      {
        cwd: ROOT,
        input: 'hello\nworld\n/clear\nagain\n/exit\n',
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          AGENT_WORKSPACE: workspace,
          AGENT_LOG_DIR: 'logs',
          AGENT_LOG_PRETTY: 'false',
          LLM_PROVIDER: 'mock',
          LLM_API_KEY: '',
          LLM_BASE_URL: '',
          LLM_MODEL: '',
        },
      },
    );

    const stdout = result.stdout ?? '';
    // 去掉单行 JSON 日志（可能紧跟提示符），只留人类可读的对话过程
    const transcript = stdout
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('{"level":'));
    console.log(transcript.join('\n'));

    const logFile = findLogFile(workspace);
    const lines = logFile === undefined ? [] : readLogLines(logFile);
    const prompts = lines
      .filter((line) => line.msg === 'turn completed')
      .map((line) => line.usage.promptTokens);
    const finished = lines.find((line) => line.msg === 'chat finished');

    const checks = [
      ['退出码 0', result.status === 0],
      ['两轮均回显', stdout.includes('echo: hello') && stdout.includes('echo: world')],
      ['/clear 生效', stdout.includes('history cleared') && stdout.includes('echo: again')],
      [
        '历史累积后归零',
        prompts.length === 3 && prompts[0] < prompts[1] && prompts[2] === prompts[0],
      ],
      ['日志收尾 turns=3', finished !== undefined && finished.turns === 3],
    ];

    for (const [name, ok] of checks) {
      record(`REPL · ${name}`, ok, ok ? '通过' : '断言失败');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

console.log('阶段 2 离线验收（不联网、不消耗配额）');

gate('1/5 类型检查 typecheck', ['run', 'typecheck']);
gate('2/5 Lint', ['run', 'lint']);
gate('3/5 格式 format:check', ['run', 'format:check']);
gate('4/5 构建 build', ['run', 'build']);
gate('5/5 全量测试 test:coverage', ['run', 'test:coverage'], (output) => {
  const passed = /\d+ passed/.test(output);
  const failed = /\d+ failed/.test(output);
  return passed && !failed;
});

replDemo();

const failed = results.filter((item) => !item.ok);
console.log('\n=== 汇总 ===');
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`);
}

if (failed.length > 0) {
  console.log(`\n验证未通过：${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过（${results.length} 项）：阶段 2 离线验收 OK`);
  console.log(
    '真实端点验证另跑：ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts',
  );
}
