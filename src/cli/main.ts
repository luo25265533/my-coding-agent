#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { pathToFileURL } from 'node:url';
import { chatCommand, type ChatOptions } from './commands/chat.js';
import { runCommand } from './commands/run.js';
import { serveCommand } from './commands/serve.js';
import { tasksCommand, tasksShowCommand } from './commands/tasks.js';
import { describeError, ExitCode, toExitCode } from '../shared/errors.js';
import { readPackageInfo } from '../shared/package-info.js';
import { LOG_LEVELS, type LogLevel } from '../shared/types.js';

function parseLogLevel(value: string): LogLevel {
  const matched = LOG_LEVELS.find((level) => level === value);
  if (matched === undefined) {
    throw new InvalidArgumentError(`must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  return matched;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new InvalidArgumentError('must be an integer between 1 and 1000');
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new InvalidArgumentError('must be an integer between 1024 and 65535');
  }
  return parsed;
}

export function buildProgram(): Command {
  const info = readPackageInfo();
  const program = new Command();

  program
    .name('agent')
    .description('A single coding agent built from scratch in TypeScript')
    .version(info.version, '-V, --version', 'output the version number')
    .showHelpAfterError()
    .exitOverride();

  program
    .command('run')
    .description('run the agent on a task: the model chooses and calls tools until it answers')
    .argument('[task...]', 'task description')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option(
      '--log-level <level>',
      `override AGENT_LOG_LEVEL (${LOG_LEVELS.join('|')})`,
      parseLogLevel,
    )
    .option('--verbose', 'shorthand for --log-level debug')
    .option('--yes', 'skip the plan confirmation (high-risk tools still ask)')
    .option('--plan-only', 'generate and print the plan without executing it')
    .option('--no-plan', 'skip planning and run the agent directly')
    .option('--resume <taskId>', 'resume a saved task (cannot be combined with a task description)')
    .option('--verify <command>', 'override the verification command for this run')
    .option('--no-verify', 'skip verification for this run')
    .action(
      async (
        task: string[],
        options: {
          workspace?: string;
          logLevel?: LogLevel;
          verbose?: boolean;
          yes?: boolean;
          planOnly?: boolean;
          plan?: boolean;
          resume?: string;
          verify?: string | boolean;
        },
      ) => {
        await runCommand(task, {
          workspace: options.workspace,
          logLevel: options.logLevel,
          verbose: options.verbose,
          yes: options.yes === true,
          planOnly: options.planOnly === true,
          noPlan: options.plan === false,
          resume: options.resume,
          verify: typeof options.verify === 'string' ? options.verify : undefined,
          noVerify: options.verify === false,
        });
      },
    );

  const tasks = program
    .command('tasks')
    .description('list saved tasks (default: latest 20)')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option('--limit <n>', 'maximum number of tasks to list', parseLimit)
    .action(async (options: { workspace?: string; limit?: number }) => {
      await tasksCommand(options);
    });

  tasks
    .command('list')
    .description('list saved tasks')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option('--limit <n>', 'maximum number of tasks to list', parseLimit)
    .action(async (options: { workspace?: string; limit?: number }) => {
      await tasksCommand(options);
    });

  tasks
    .command('show <taskId>')
    .description('show one saved task')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .action(async (taskId: string, options: { workspace?: string }) => {
      await tasksShowCommand(taskId, options);
    });

  program
    .command('serve')
    .description('start the local web UI (loopback only)')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option('--port <n>', 'override AGENT_WEB_PORT (1024-65535)', parsePort)
    .option(
      '--log-level <level>',
      `override AGENT_LOG_LEVEL (${LOG_LEVELS.join('|')})`,
      parseLogLevel,
    )
    .option('--verbose', 'shorthand for --log-level debug')
    .action(
      async (options: {
        workspace?: string;
        port?: number;
        logLevel?: LogLevel;
        verbose?: boolean;
      }) => {
        await serveCommand({
          workspace: options.workspace,
          port: options.port,
          logLevel: options.logLevel,
          verbose: options.verbose,
        });
      },
    );

  program
    .command('chat')
    .description('interactive multi-turn chat with the configured LLM provider')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option(
      '--log-level <level>',
      `override AGENT_LOG_LEVEL (${LOG_LEVELS.join('|')})`,
      parseLogLevel,
    )
    .option('--verbose', 'shorthand for --log-level debug')
    .option('--system <prompt>', 'override the system prompt')
    .option('--model <name>', 'override LLM_MODEL')
    .action(async (options: ChatOptions) => {
      await chatCommand(options);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const program = buildProgram();
  try {
    if (argv.length === 0) {
      program.outputHelp();
      return ExitCode.Success;
    }
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Success;
  } catch (error) {
    return handleCliError(error);
  }
}

function handleCliError(error: unknown): ExitCode {
  // commander 已自行输出错误信息与帮助，这里只负责映射退出码
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? ExitCode.Success : ExitCode.UsageError;
  }
  process.stderr.write(`error: ${describeError(error)}\n`);
  return toExitCode(error);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
