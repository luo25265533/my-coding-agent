#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { pathToFileURL } from 'node:url';
import { chatCommand, type ChatOptions } from './commands/chat.js';
import { runCommand, type RunOptions } from './commands/run.js';
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
    .action(async (task: string[], options: RunOptions) => {
      await runCommand(task, options);
    });

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
