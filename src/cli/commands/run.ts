import { randomUUID } from 'node:crypto';
import { runAgentLoop, type AgentStopReason } from '../../agent/loop.js';
import { loadConfig, redactConfig } from '../../config/load.js';
import { createLogger } from '../../logger/index.js';
import { createLLMProvider } from '../../llm/factory.js';
import { createDefaultToolRegistry } from '../../tools/index.js';
import { AgentError, describeError, ErrorCode } from '../../shared/errors.js';
import { readPackageInfo } from '../../shared/package-info.js';
import type { LogLevel } from '../../shared/types.js';

export interface RunOptions {
  readonly workspace?: string;
  readonly logLevel?: LogLevel;
  readonly verbose?: boolean;
}

export interface RunResult {
  readonly runId: string;
  readonly logFile: string;
  readonly content: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly stopReason: 'answer' | 'max_iterations';
}

const NO_TASK_MESSAGE = 'a task is required: agent run "describe the task"';

export async function runCommand(task: readonly string[], options: RunOptions): Promise<RunResult> {
  const taskText = task.join(' ').trim();
  if (taskText === '') {
    throw new AgentError(ErrorCode.UsageInvalid, NO_TASK_MESSAGE);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.workspace !== undefined) {
    env.AGENT_WORKSPACE = options.workspace;
  }
  const level = options.verbose === true ? 'debug' : options.logLevel;
  if (level !== undefined) {
    env.AGENT_LOG_LEVEL = level;
  }

  const config = loadConfig({ env });
  const runId = randomUUID();
  const { logger, logFile, close } = createLogger(config, runId);
  const log = logger.child({ module: 'cli' });
  const agentLog = logger.child({ module: 'agent' });

  const provider = createLLMProvider(config, { logger: agentLog });
  const tools = createDefaultToolRegistry();

  log.info({ task: taskText, provider: provider.name }, 'run started');
  log.debug({ config: redactConfig(config) }, 'configuration loaded');

  const info = readPackageInfo();
  process.stdout.write(
    [
      `${info.name} v${info.version}`,
      `runId     : ${runId}`,
      `workspace : ${config.agent.workspace}`,
      `provider  : ${provider.name}  model: ${config.llm.model ?? '(default)'}`,
      `task      : ${taskText}`,
      '',
    ].join('\n'),
  );

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  try {
    const result = await runAgentLoop(taskText, {
      provider,
      tools,
      workspace: config.agent.workspace,
      maxIterations: config.agent.maxIterations,
      maxRepeatedCalls: config.agent.maxRepeatedCalls,
      maxConsecutiveFailures: config.agent.maxConsecutiveFailures,
      signal: controller.signal,
      logger: agentLog,
      onToolCall: (call, iteration) => {
        process.stdout.write(`[${iteration}] → ${call.name} ${compactArguments(call.arguments)}\n`);
      },
      onToolResult: (_call, toolResult, iteration, durationMs) => {
        const status = toolResult.ok ? 'ok' : 'error';
        const truncated = toolResult.truncated === true ? ', truncated' : '';
        const errorCode = toolResult.meta?.['code'];
        const detail = typeof errorCode === 'string' ? `: ${errorCode}` : '';
        process.stdout.write(
          `[${iteration}] ← ${status} ${toolResult.content.length} chars (${durationMs}ms${truncated})${detail}\n`,
        );
      },
    });

    if (result.content !== '' && result.stopReason === 'answer') {
      process.stdout.write(`\nanswer:\n${result.content}\n`);
    }
    process.stdout.write(
      `tokens: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}  iterations=${result.iterations}  tools=${result.toolCalls}\n`,
    );

    if (result.stopReason !== 'answer') {
      throw stopError(result.stopReason, result.iterations);
    }

    log.info(
      {
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        stopReason: result.stopReason,
        usage: result.usage,
      },
      'run finished',
    );
    return {
      runId,
      logFile,
      content: result.content,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
    };
  } catch (error) {
    log.error({ reason: describeError(error) }, 'run failed');
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    close();
  }
}

const INCOMPLETE_HINTS: Readonly<
  Record<Exclude<AgentStopReason, 'answer' | 'max_iterations'>, string>
> = {
  empty_answer: 'the model returned an empty answer',
  output_truncated: 'the model output was truncated (finish_reason=length)',
  repeated_tool_call: 'the model kept calling the same tool with the same arguments',
  tool_failure_limit: 'consecutive tool failures reached the limit',
};

function stopError(reason: Exclude<AgentStopReason, 'answer'>, iterations: number): AgentError {
  if (reason === 'max_iterations') {
    return new AgentError(
      ErrorCode.AgentMaxIterations,
      `no final answer after ${iterations} iterations; raise AGENT_MAX_ITERATIONS or narrow the task`,
    );
  }
  return new AgentError(
    ErrorCode.AgentIncomplete,
    `agent stopped (${reason}): ${INCOMPLETE_HINTS[reason]} after ${iterations} iterations`,
  );
}

function compactArguments(argumentsText: string): string {
  const singleLine = argumentsText.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 200) {
    return singleLine;
  }
  return `${singleLine.slice(0, 200)}…`;
}
