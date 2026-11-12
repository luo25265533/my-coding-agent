#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { pathToFileURL } from 'node:url';
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
    .description('run the agent skeleton (phase 1: no LLM call, no tool execution)')
    .argument('[task...]', 'task description')
    .option('--workspace <path>', 'override AGENT_WORKSPACE')
    .option(
      '--log-level <level>',
      `override AGENT_LOG_LEVEL (${LOG_LEVELS.join('|')})`,
      parseLogLevel,
    )
    .option('--verbose', 'shorthand for --log-level debug')
    .action((task: string[], options: RunOptions) => {
      runCommand(task, options);
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
