import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../logger/index.js';
import { badResponseError } from '../../llm/errors.js';
import { createLLMProvider } from '../../llm/factory.js';
import type { ChatMessage, LLMProvider, StreamChunk, TokenUsage } from '../../llm/types.js';
import { describeError } from '../../shared/errors.js';
import { readPackageInfo } from '../../shared/package-info.js';
import type { LogLevel } from '../../shared/types.js';

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful coding assistant. Answer concisely and accurately.';

export interface ChatOptions {
  readonly workspace?: string;
  readonly logLevel?: LogLevel;
  readonly verbose?: boolean;
  readonly system?: string;
  readonly model?: string;
}

export interface ChatResult {
  readonly runId: string;
  readonly logFile: string;
  readonly turns: number;
}

export type ReplCommand = 'exit' | 'help' | 'clear' | 'message';

export function resolveCommand(input: string): ReplCommand {
  if (input === '/exit' || input === '/quit') {
    return 'exit';
  }
  if (input === '/help') {
    return 'help';
  }
  if (input === '/clear') {
    return 'clear';
  }
  return 'message';
}

/**
 * 推进一轮对话。只有正文写入历史，思考流不入历史，
 * 避免污染下一轮 prompt 并节省 token。失败或提前中止时回滚本轮 user 消息。
 */
export async function* streamTurn(
  provider: LLMProvider,
  history: ChatMessage[],
  input: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  history.push({ role: 'user', content: input });
  let committed = false;
  try {
    for await (const chunk of provider.stream({ messages: history, signal })) {
      if (chunk.type === 'done') {
        history.push({ role: 'assistant', content: chunk.response.content });
        committed = true;
      }
      yield chunk;
    }
    if (!committed) {
      throw badResponseError('stream ended without a done chunk');
    }
  } finally {
    if (!committed) {
      history.pop();
    }
  }
}

export async function chatCommand(options: ChatOptions): Promise<ChatResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.workspace !== undefined) {
    env.AGENT_WORKSPACE = options.workspace;
  }
  const level = options.verbose === true ? 'debug' : options.logLevel;
  if (level !== undefined) {
    env.AGENT_LOG_LEVEL = level;
  }
  if (options.model !== undefined) {
    env.LLM_MODEL = options.model;
  }

  const config = loadConfig({ env });
  const runId = randomUUID();
  const { logger, logFile, close } = createLogger(config, runId);
  const log = logger.child({ module: 'chat' });
  const provider = createLLMProvider(config, { logger: log });

  const history: ChatMessage[] = [
    { role: 'system', content: options.system ?? DEFAULT_SYSTEM_PROMPT },
  ];

  const info = readPackageInfo();
  process.stdout.write(`${info.name} v${info.version} - interactive chat\n`);
  process.stdout.write(`provider: ${provider.name}  model: ${config.llm.model ?? '(default)'}\n`);
  process.stdout.write(`runId: ${runId}\nlogFile: ${logFile}\n`);
  process.stdout.write('Type /help for commands, /exit to quit.\n\n');
  log.info({ provider: provider.name }, 'chat started');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let active: AbortController | undefined;
  let turns = 0;

  const onSigint = (): void => {
    // 有请求在飞则只中止本轮，空闲时才退出
    if (active !== undefined) {
      active.abort();
      return;
    }
    rl.close();
  };
  process.on('SIGINT', onSigint);
  // TTY 原始模式下 Ctrl+C 由 readline 截获，不会变成进程信号
  rl.on('SIGINT', onSigint);

  async function runTurn(input: string): Promise<void> {
    const controller = new AbortController();
    active = controller;
    let inReasoning = false;
    try {
      for await (const chunk of streamTurn(provider, history, input, controller.signal)) {
        if (chunk.type === 'reasoning') {
          if (!inReasoning) {
            beginReasoning();
            inReasoning = true;
          }
          process.stdout.write(chunk.text);
        } else if (chunk.type === 'content') {
          if (inReasoning) {
            endReasoning();
            inReasoning = false;
          }
          process.stdout.write(chunk.text);
        } else {
          if (inReasoning) {
            endReasoning();
            inReasoning = false;
          }
          process.stdout.write('\n');
          writeUsage(chunk.response.usage);
          log.info(
            { usage: chunk.response.usage, finishReason: chunk.response.finishReason },
            'turn completed',
          );
        }
      }
    } catch (error) {
      if (inReasoning) {
        endReasoning();
      }
      process.stdout.write('\n');
      process.stderr.write(`error: ${describeError(error)}\n`);
      log.warn({ reason: describeError(error) }, 'turn failed');
    } finally {
      active = undefined;
    }
  }

  try {
    // 用异步迭代器而非逐轮 rl.question：后者会丢弃无待决 question 时到达的行
    // （管道输入一次性送达多行），且 EOF 后 promise 永不 settle，finally 不会执行
    process.stdout.write('> ');
    for await (const line of rl) {
      const input = line.trim();
      if (input !== '') {
        const command = resolveCommand(input);
        if (command === 'exit') {
          break;
        }
        if (command === 'help') {
          printHelp();
        } else if (command === 'clear') {
          history.length = 1;
          process.stdout.write('history cleared\n');
        } else {
          turns += 1;
          await runTurn(input);
        }
      }
      process.stdout.write('> ');
    }
  } finally {
    process.off('SIGINT', onSigint);
    rl.close();
    log.info({ turns }, 'chat finished');
    close();
  }

  return { runId, logFile, turns };
}

function beginReasoning(): void {
  process.stdout.write(process.stdout.isTTY === true ? '\x1b[2m[thinking] ' : '[thinking] ');
}

function endReasoning(): void {
  process.stdout.write(process.stdout.isTTY === true ? '\x1b[0m\n' : '\n');
}

function writeUsage(usage: TokenUsage): void {
  process.stdout.write(
    `[tokens] prompt=${usage.promptTokens} completion=${usage.completionTokens} reasoning=${usage.reasoningTokens} total=${usage.totalTokens}\n`,
  );
}

function printHelp(): void {
  process.stdout.write(
    '/exit, /quit  leave the chat\n/clear        reset conversation history\n/help         show this help\n',
  );
}
