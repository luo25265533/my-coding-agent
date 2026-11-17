import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../logger/index.js';
import { readPackageInfo } from '../../shared/package-info.js';
import type { LogLevel } from '../../shared/types.js';
import { createWebServer, generateToken, listen } from '../../web/server.js';
import { RunSession } from '../../web/session.js';

export interface ServeOptions {
  readonly workspace?: string | undefined;
  readonly port?: number | undefined;
  readonly logLevel?: LogLevel | undefined;
  readonly verbose?: boolean | undefined;
  /** 测试等宿主在监听成功后接管句柄；CLI 不传时行为不变 */
  readonly onStarted?: ((handle: ServeHandle) => void) | undefined;
}

export interface ServeHandle {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.workspace !== undefined) {
    env.AGENT_WORKSPACE = options.workspace;
  }
  if (options.port !== undefined) {
    env.AGENT_WEB_PORT = String(options.port);
  }
  const level = options.verbose === true ? 'debug' : options.logLevel;
  if (level !== undefined) {
    env.AGENT_LOG_LEVEL = level;
  }

  const config = loadConfig({ env });
  const { logger, logFile, close } = createLogger(config);
  const log = logger.child({ module: 'cli' });
  const publicDir = fileURLToPath(new URL('../../web/public/', import.meta.url));
  const token = generateToken();
  const session = new RunSession(config, logger);
  const web = createWebServer({ logger, publicDir, token, session });

  const info = readPackageInfo();
  const url = `http://${config.web.host}:${config.web.port}/?token=${token}`;

  try {
    await listen(web.server, config.web.port, config.web.host);
  } catch (error) {
    close();
    throw error;
  }

  log.info(
    { url, workspace: config.agent.workspace, publicDir: path.resolve(publicDir) },
    'web server started',
  );
  const lines = [
    `${info.name} v${info.version} - web UI`,
    `url       : ${url}`,
    `workspace : ${config.agent.workspace}`,
    `provider  : ${config.llm.provider}  model: ${config.llm.model ?? '(default)'}`,
    `logFile   : ${logFile}`,
    '',
    '仅监听本机回环地址；完整 URL 含访问 token，请勿分享。',
    'Ctrl+C 退出。',
  ];
  process.stdout.write(lines.join('\n') + '\n');

  options.onStarted?.({
    url,
    token,
    close: async () => {
      await web.close().catch(() => undefined);
      close();
    },
  });

  /* v8 ignore next 14 -- SIGINT 处理依赖真实进程信号，进程内测试无法触发 */
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    process.stdout.write('\nstopping web server...\n');
    void web
      .close()
      .catch(() => undefined)
      .then(() => {
        close();
        process.exit(0);
      });
  });
}
