import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { buildProgram, main } from '../../src/cli/main.js';
import { ConfigError, ExitCode } from '../../src/shared/errors.js';
import { readPackageInfo } from '../../src/shared/package-info.js';

vi.mock('../../src/cli/commands/run.js', () => ({ runCommand: vi.fn() }));

interface Captured<T> {
  readonly result: T;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const result = await fn();
    return {
      result,
      stdout: outSpy.mock.calls.map((call) => String(call[0] ?? '')).join(''),
      stderr: errSpy.mock.calls.map((call) => String(call[0] ?? '')).join(''),
    };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
});

describe('buildProgram', () => {
  it('命令名为 agent 且注册了 run 子命令', () => {
    const program = buildProgram();
    expect(program.name()).toBe('agent');
    expect(program.commands.map((command) => command.name())).toContain('run');
  });

  it('注册 tasks、tasks list 与 tasks show 子命令', () => {
    const program = buildProgram();
    const tasks = program.commands.find((command) => command.name() === 'tasks');
    expect(tasks).toBeDefined();
    expect(tasks?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['list', 'show']),
    );
  });

  it('run 帮助包含 --resume、--verify、--no-verify', () => {
    const program = buildProgram();
    const run = program.commands.find((command) => command.name() === 'run');
    const help = run?.helpInformation() ?? '';
    expect(help).toContain('--resume <taskId>');
    expect(help).toContain('--verify <command>');
    expect(help).toContain('--no-verify');
  });
});

describe('版本与帮助', () => {
  it('--version 输出 package.json 中的版本并退出 0', async () => {
    const { result, stdout } = await capture(() => main(['--version']));
    expect(result).toBe(ExitCode.Success);
    expect(stdout.trim()).toBe(readPackageInfo().version);
  });

  it('--help 输出用法并退出 0', async () => {
    const { result, stdout } = await capture(() => main(['--help']));
    expect(result).toBe(ExitCode.Success);
    expect(stdout).toContain('Usage: agent');
    expect(stdout).toContain('run');
  });

  it('无参数时打印帮助并退出 0', async () => {
    const { result, stdout } = await capture(() => main([]));
    expect(result).toBe(ExitCode.Success);
    expect(stdout).toContain('Usage: agent');
  });
});

describe('用法错误退出码 2', () => {
  it('未知命令退出 2', async () => {
    const { result } = await capture(() => main(['bogus']));
    expect(result).toBe(ExitCode.UsageError);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('非法 --log-level 退出 2 且不执行 run', async () => {
    const { result, stderr } = await capture(() => main(['run', '--log-level', 'nope']));
    expect(result).toBe(ExitCode.UsageError);
    expect(stderr).toContain('--log-level');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('未知选项退出 2', async () => {
    const { result } = await capture(() => main(['run', '--nope']));
    expect(result).toBe(ExitCode.UsageError);
  });
});

describe('run 参数解析', () => {
  it('多个 task 词与 --verbose 正确传递', async () => {
    const { result } = await capture(() => main(['run', 'hello', 'world', '--verbose']));
    expect(result).toBe(ExitCode.Success);
    expect(runCommand).toHaveBeenCalledWith(
      ['hello', 'world'],
      expect.objectContaining({ verbose: true }),
    );
  });

  it('--workspace 与 --log-level 正确传递', async () => {
    await capture(() => main(['run', 'task', '--workspace', '/tmp/ws', '--log-level', 'debug']));
    expect(runCommand).toHaveBeenCalledWith(
      ['task'],
      expect.objectContaining({ workspace: '/tmp/ws', logLevel: 'debug' }),
    );
  });

  it('不带 task 时传入空数组', async () => {
    await capture(() => main(['run']));
    expect(runCommand).toHaveBeenCalledWith([], expect.anything());
  });

  it('--resume 与 --verify 正确传递', async () => {
    await capture(() =>
      main(['run', '--resume', 'task-id', '--verify', 'pnpm run check', '--yes']),
    );
    expect(runCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        resume: 'task-id',
        verify: 'pnpm run check',
        noVerify: false,
        yes: true,
      }),
    );
  });

  it('--no-verify 映射为 noVerify 且不传 verify 命令', async () => {
    await capture(() => main(['run', 'task', '--no-verify']));
    expect(runCommand).toHaveBeenCalledWith(
      ['task'],
      expect.objectContaining({ verify: undefined, noVerify: true }),
    );
  });

  it('未提供验证参数时 verify 与 noVerify 都不覆盖', async () => {
    await capture(() => main(['run', 'task']));
    expect(runCommand).toHaveBeenCalledWith(
      ['task'],
      expect.objectContaining({ verify: undefined, noVerify: false }),
    );
  });

  it('tasks --limit 非法时退出 2 且不执行命令', async () => {
    const { result, stderr } = await capture(() => main(['tasks', '--limit', '0']));
    expect(result).toBe(ExitCode.UsageError);
    expect(stderr).toContain('--limit');
  });

  it('合法 log level 全部可解析', async () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      vi.mocked(runCommand).mockClear();
      const { result } = await capture(() => main(['run', '--log-level', level]));
      expect(result).toBe(ExitCode.Success);
      expect(runCommand).toHaveBeenCalledWith([], expect.objectContaining({ logLevel: level }));
    }
  });
});

describe('运行时错误映射', () => {
  it('ConfigError 映射为退出码 2 并输出信息到 stderr', async () => {
    vi.mocked(runCommand).mockImplementation(() => {
      throw new ConfigError('invalid configuration detail');
    });
    const { result, stderr } = await capture(() => main(['run']));
    expect(result).toBe(ExitCode.UsageError);
    expect(stderr).toContain('invalid configuration detail');
  });

  it('普通 Error 映射为退出码 1', async () => {
    vi.mocked(runCommand).mockImplementation(() => {
      throw new Error('unexpected failure');
    });
    const { result, stderr } = await capture(() => main(['run']));
    expect(result).toBe(ExitCode.RuntimeError);
    expect(stderr).toContain('unexpected failure');
  });
});
