#!/usr/bin/env node
/**
 * 阶段 8 离线验收（V1.0）：一条命令跑完静态门禁 + 全量测试 + mock REPL/规划/任务可靠性演示。
 * 全程不联网、不消耗模型配额；真实端点验证请另跑：
 *   ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** 仅保留人类可读行，过滤紧随提示符的单行 JSON 日志 */
function humanOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('{"level":'))
    .join('\n');
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

function printedTaskId(stdout) {
  return /task(?: (?:completed|failed|step_failed))?: ([0-9a-f-]{36})/i.exec(stdout)?.[1];
}

/** 统一 CLI 环境：显式覆盖全部行为配置，避免项目根 .env 污染演示 */
function makeCli(workspace, extraEnv = {}) {
  const env = {
    ...process.env,
    AGENT_WORKSPACE: workspace,
    AGENT_LOG_DIR: 'logs',
    AGENT_LOG_PRETTY: 'false',
    AGENT_LOG_LEVEL: 'info',
    AGENT_TASK_DB: '.agent/tasks.db',
    AGENT_VERIFY_COMMAND: '',
    AGENT_MAX_REPAIR_ATTEMPTS: '1',
    LLM_PROVIDER: 'mock',
    LLM_API_KEY: '',
    LLM_BASE_URL: '',
    LLM_MODEL: '',
    ...extraEnv,
  };
  return (...args) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join('src', 'cli', 'main.ts'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    });
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

function planDemo() {
  heading('规划 → 确认 → 改码演示（mock provider，零成本）');
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-verify-plan-'));
  const plan = {
    goal: '创建一个问候文件',
    steps: [
      {
        id: 's1',
        title: '写入 greeting.txt',
        description: '用 write_file 创建 greeting.txt',
        files: ['greeting.txt'],
      },
    ],
  };
  const script = [
    { content: JSON.stringify(plan) },
    {
      toolCalls: [
        {
          name: 'write_file',
          arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello from plan\n' }),
        },
      ],
    },
    { content: '已创建 greeting.txt。' },
  ];
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(script));
  const cli = makeCli(workspace, { AGENT_MOCK_SCRIPT: 'script.json' });
  const target = path.join(workspace, 'greeting.txt');

  try {
    const planOnly = cli('run', '--plan-only', '创建问候文件');
    const planOnlyOut = `${planOnly.stdout ?? ''}${planOnly.stderr ?? ''}`;
    const planOnlyWrote = existsSync(target);
    const planned = cli('run', '--yes', '--no-verify', '创建问候文件');
    const plannedOut = humanOutput(planned);
    console.log(plannedOut);

    const checks = [
      ['--plan-only 退出码 0', planOnly.status === 0],
      ['--plan-only 打印 Plan', planOnlyOut.includes('goal: 创建一个问候文件')],
      ['--plan-only 未写文件', !planOnlyWrote],
      ['--plan-only 落库并给出恢复提示', printedTaskId(planOnlyOut) !== undefined],
      ['--yes 退出码 0', planned.status === 0],
      ['--yes 按步骤执行', plannedOut.includes('step 1/1 → 写入 greeting.txt')],
      ['--yes 输出汇总', plannedOut.includes('plan completed  steps=1  tools=1')],
      ['文件内容正确', existsSync(target) && readFileSync(target, 'utf8') === 'hello from plan\n'],
    ];
    for (const [name, ok] of checks) {
      record(`Plan · ${name}`, ok, ok ? '通过' : '断言失败');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function taskDemo() {
  heading('任务可靠性演示（验证失败 → 修复 → 通过 → tasks show）');
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-verify-task-'));
  const verifyCommand =
    "node -e \"const fs=require('fs');process.exit(fs.existsSync('deliverable.txt')&&fs.readFileSync('deliverable.txt','utf8')==='fixed'?0:1)\"";
  const plan = {
    goal: '生成交付文件',
    steps: [
      {
        id: 's1',
        title: '生成 deliverable.txt',
        description: '写入内容正确的交付文件',
        files: ['deliverable.txt'],
      },
    ],
  };
  const script = [
    { content: JSON.stringify(plan) },
    { content: 'initial attempt' },
    {
      toolCalls: [
        {
          name: 'write_file',
          arguments: JSON.stringify({ path: 'deliverable.txt', content: 'fixed' }),
        },
      ],
    },
    { content: 'repair applied' },
  ];
  writeFileSync(path.join(workspace, 'script.json'), JSON.stringify(script));
  const cli = makeCli(workspace, { AGENT_MOCK_SCRIPT: 'script.json' });
  const target = path.join(workspace, 'deliverable.txt');

  try {
    const run = cli('run', '--yes', '--verify', verifyCommand, '生成交付文件');
    const out = humanOutput(run);
    console.log(out);
    const taskId = printedTaskId(out);
    const show = taskId === undefined ? undefined : cli('tasks', 'show', taskId);
    const showOut = show === undefined ? '' : humanOutput(show);
    if (showOut !== '') {
      console.log(showOut);
    }

    const checks = [
      ['退出码 0', run.status === 0],
      ['首次验证失败', out.includes('verification: failed')],
      ['自动修复一轮', out.includes('repair 1/1: answered')],
      ['再次验证通过', out.includes('verification: passed')],
      ['任务完成', taskId !== undefined && out.includes(`task completed: ${taskId}`)],
      ['文件为修复后内容', existsSync(target) && readFileSync(target, 'utf8') === 'fixed'],
      [
        'tasks show 状态与修复次数',
        showOut.includes('status    : completed') && showOut.includes('repairs   : 1'),
      ],
    ];
    for (const [name, ok] of checks) {
      record(`Task · ${name}`, ok, ok ? '通过' : '断言失败');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function resumeDemo() {
  heading('恢复演示（--plan-only → --resume 不重新规划）');
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-verify-resume-'));
  const plan = {
    goal: '恢复执行问候文件',
    steps: [
      {
        id: 's1',
        title: '写入 resume.txt',
        description: '用 write_file 创建 resume.txt',
        files: ['resume.txt'],
      },
    ],
  };
  writeFileSync(
    path.join(workspace, 'script.json'),
    JSON.stringify([{ content: JSON.stringify(plan) }]),
  );
  const cli = makeCli(workspace, { AGENT_MOCK_SCRIPT: 'script.json' });
  const target = path.join(workspace, 'resume.txt');

  try {
    const planOnly = cli('run', '--plan-only', '--no-verify', '先规划后恢复');
    const planOut = humanOutput(planOnly);
    console.log(planOut);
    const taskId = printedTaskId(planOut);
    const planOnlyWrote = existsSync(target);

    // 恢复阶段脚本只有“写文件 + 回答”两步：若重新调用规划器会立刻失败
    writeFileSync(
      path.join(workspace, 'script.json'),
      JSON.stringify([
        {
          toolCalls: [
            {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'resume.txt', content: 'resumed' }),
            },
          ],
        },
        { content: '已恢复并完成。' },
      ]),
    );
    const resumed = taskId === undefined ? undefined : cli('run', '--resume', taskId, '--yes');
    const resumedOut = resumed === undefined ? '' : humanOutput(resumed);
    console.log(resumedOut);
    const show = taskId === undefined ? undefined : cli('tasks', 'show', taskId);
    const showOut = show === undefined ? '' : humanOutput(show);

    const checks = [
      ['--plan-only 退出码 0 且落库', planOnly.status === 0 && taskId !== undefined],
      ['--plan-only 未执行', !planOnlyWrote],
      ['--resume 退出码 0', resumed?.status === 0],
      [
        '按原计划恢复（status=planned）',
        resumedOut.includes(`resuming task ${taskId}`) && resumedOut.includes('status=planned'),
      ],
      ['任务完成且文件写入', resumedOut.includes('task completed:') && existsSync(target)],
      [
        'planned 首次执行不计 resume（resumes=0）',
        showOut.includes('status    : completed') && showOut.includes('resumes   : 0'),
      ],
    ];
    for (const [name, ok] of checks) {
      record(`Resume · ${name}`, ok, ok ? '通过' : '断言失败');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function recoveryCountDemo() {
  heading('步骤失败恢复演示（step_failed → --resume，resumes=1）');
  const workspace = mkdtempSync(path.join(tmpdir(), 'agent-verify-recovery-'));
  const plan = {
    goal: '恢复失败步骤',
    steps: [
      {
        id: 's1',
        title: '读取目录',
        description: '调用 list_files',
        files: [],
      },
    ],
  };
  writeFileSync(
    path.join(workspace, 'script.json'),
    JSON.stringify([
      { content: JSON.stringify(plan) },
      { toolCalls: [{ name: 'list_files', arguments: '{}' }] },
    ]),
  );
  const cli = makeCli(workspace, {
    AGENT_MOCK_SCRIPT: 'script.json',
    AGENT_STEP_MAX_ITERATIONS: '1',
  });

  try {
    const failed = cli('run', '--yes', '--no-verify', '先失败再恢复');
    const failedOut = humanOutput(failed);
    console.log(failedOut);
    const taskId = printedTaskId(failedOut);

    writeFileSync(path.join(workspace, 'script.json'), JSON.stringify([{ content: 'recovered' }]));
    const resumed = taskId === undefined ? undefined : cli('run', '--resume', taskId, '--yes');
    const resumedOut = resumed === undefined ? '' : humanOutput(resumed);
    const show = taskId === undefined ? undefined : cli('tasks', 'show', taskId);
    const showOut = show === undefined ? '' : humanOutput(show);

    const checks = [
      [
        '首个进程步骤失败并给出恢复提示',
        failed.status === 1 &&
          failedOut.includes('task step_failed:') &&
          failedOut.includes('resume with: agent run --resume'),
      ],
      [
        '恢复按已完成前缀继续',
        resumed?.status === 0 &&
          resumedOut.includes(`resuming task ${taskId}`) &&
          resumedOut.includes('status=step_failed'),
      ],
      ['恢复后任务完成', resumedOut.includes(`task completed: ${taskId ?? ''}`)],
      [
        '恢复计数 +1',
        showOut.includes('status    : completed') && showOut.includes('resumes   : 1'),
      ],
    ];
    for (const [name, ok] of checks) {
      record(`Recovery · ${name}`, ok, ok ? '通过' : '断言失败');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

console.log('阶段 8 离线验收（V1.0，不联网、不消耗配额）');
gate('1/5 类型检查 typecheck', ['run', 'typecheck']);
gate('2/5 Lint', ['run', 'lint']);
gate('3/5 格式 format:check', ['run', 'format:check']);
gate('4/5 构建 build', ['run', 'build']);
gate('5/5 全量测试 test:coverage', ['run', 'test:coverage'], (output) => {
  // 剥离 ANSI 颜色码后只看 vitest 汇总行，避免测试日志里 "step s1 failed" 之类的业务文本误判
  // 拆掉 ANSI 颜色序列（ES C + [..m）后只看 vitest 汇总行，
  // 避免测试日志里 "step s1 failed" 之类的业务文本误判
  const plain = output
    .split('\u001b')
    .map((part) => part.replace(/^\[[0-9;]*m/, ''))
    .join('');
  const passed = /(?:Test Files|Tests)\s+\d+ passed/.test(plain);
  const failed = /(?:Test Files|Tests)\s+\d+ failed/.test(plain);
  return passed && !failed;
});

replDemo();
planDemo();
taskDemo();
resumeDemo();
recoveryCountDemo();

const failed = results.filter((item) => !item.ok);
console.log('\n=== 汇总 ===');
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`);
}

if (failed.length > 0) {
  console.log(`\n验证未通过：${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过（${results.length} 项）：阶段 8 离线验收 OK（V1.0）`);
  console.log(
    '真实端点验证另跑：ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts',
  );
}
