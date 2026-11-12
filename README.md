# my-coding-agent

从零实现的 TypeScript Single Coding Agent。目标是理解 Agent 的架构与实现原理，因此核心循环手写，不使用 LangChain 等编排框架。

当前处于**阶段 1：项目初始化**。CLI 可以启动、配置可加载校验、日志可落盘，但**不调用模型、不执行任何工具**。

## 环境要求

- Node.js `>=20.18.0`（开发验证于 v20.18.1）
- pnpm 8.x

工具链版本是**刻意锁定**的，不是最新：当前 Node 20.18.1 跑不了 Vitest 5 / ESLint 10 / commander 15（均要求 Node ≥22），且 TypeScript 7 超出 typescript-eslint 的 peer 上限 `<6.1.0`。详见 [docs/architecture.md](docs/architecture.md) 第四节的实测矩阵。

| 用途     | 包                         | 版本            |
| -------- | -------------------------- | --------------- |
| 语言     | typescript                 | 5.9.3           |
| CLI      | commander                  | 14.0.3          |
| 校验     | zod                        | 4.6.7           |
| 环境变量 | dotenv                     | 18.0.10         |
| 日志     | pino / pino-pretty         | 10.4.0 / 13.2.0 |
| 测试     | vitest / vite              | 3.2.7 / 6.4.6   |
| Lint     | eslint / typescript-eslint | 9.39.5 / 8.72.2 |
| 格式化   | prettier                   | 3.10.0          |

`vite` 通过 `package.json` 的 `pnpm.overrides` 强制锁在 6.4.6，避免被解析到 7.x 触发 Node 20.19 门槛。

## 安装与启动

```bash
pnpm install
cp .env.example .env      # 可选，不创建也能跑（全部走默认值）

pnpm dev --help           # 开发态直跑 TS
pnpm dev run "hello"      # 运行骨架命令

pnpm build                # 编译到 dist/
node dist/cli/main.js run "hello"
```

## CLI

```
agent --version              输出版本号
agent --help                 输出用法
agent run [task...]          运行骨架
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价于 --log-level debug
```

退出码：`0` 成功 / `1` 运行时错误 / `2` 参数或配置错误。

## 配置

全部配置来自环境变量，优先级为 **进程环境变量 > `.env` 文件 > 默认值**，由 zod 校验后冻结为只读对象。

| 变量                      | 默认值        | 说明                                            |
| ------------------------- | ------------- | ----------------------------------------------- |
| `LLM_PROVIDER`            | `mock`        | `mock` 或 `openai-compatible`                   |
| `LLM_API_KEY`             | 空            | provider 非 mock 时必填                         |
| `LLM_BASE_URL`            | 空            | provider 为 openai-compatible 时必填            |
| `LLM_MODEL`               | 空            | 模型名                                          |
| `LLM_TIMEOUT_MS`          | `60000`       | 1–600000                                        |
| `LLM_MAX_RETRIES`         | `2`           | 0–10                                            |
| `AGENT_WORKSPACE`         | `.`           | 沙箱根，解析为绝对路径                          |
| `AGENT_MAX_ITERATIONS`    | `20`          | 1–200                                           |
| `AGENT_CONFIRM_HIGH_RISK` | `true`        | 接受 true/false/1/0                             |
| `AGENT_LOG_LEVEL`         | `info`        | trace/debug/info/warn/error/fatal/silent        |
| `AGENT_LOG_DIR`           | `.agent/logs` | 相对路径基于 workspace，且必须位于 workspace 内 |
| `AGENT_LOG_PRETTY`        | `true`        | 控制台美化输出；文件侧恒为 JSON                 |

阶段 1 只校验配置格式，不测试模型连通性。

## 日志

双输出：控制台（`AGENT_LOG_PRETTY=true` 时为人类可读文本）+ 文件 `<AGENT_LOG_DIR>/agent-<YYYY-MM-DD>.jsonl`（始终 JSON）。

- 每条日志带 `app`、`runId`、`module`，一次运行内可串联
- `apiKey` / `token` / `authorization` / `password` / `secret` / `LLM_API_KEY` 及其嵌套字段强制脱敏为 `[REDACTED]`
- CLI 打印的配置摘要走 `redactConfig()`，密钥恒为 `[REDACTED]` 或 `(unset)`
- `createLogger()` 返回句柄，`close()` 幂等且只结束文件流，不触碰 stdout

## 开发命令

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint（type-checked 规则）
pnpm lint:fix
pnpm format         # prettier --write
pnpm format:check
pnpm test           # vitest run
pnpm test:watch
pnpm test:coverage
pnpm check          # typecheck + lint + test
```

## 项目结构

```
src/
├─ index.ts        库入口
├─ cli/            命令解析、退出码
├─ config/         .env 加载 + zod 校验
├─ logger/         分级日志 + 脱敏
├─ shared/         错误、公共类型、package 信息
├─ agent/          核心执行循环      （阶段 6）
├─ llm/            模型通信          （阶段 2）
├─ planner/        任务规划          （阶段 6）
├─ tools/          工具注册与调度    （阶段 3-4）
├─ context/        上下文管理        （阶段 5）
├─ memory/         记忆与持久化      （阶段 8）
├─ security/       路径沙箱与权限    （阶段 3）
└─ evaluator/      结果验证          （阶段 7）
tests/
├─ unit/           config / logger / errors / cli
└─ integration/    真实进程冒烟（源码入口 + 构建产物入口）
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 需求分析、架构设计、技术选型、路线图、验收策略
- [docs/plans/phase-1-init.md](docs/plans/phase-1-init.md) —— 阶段 1 开发 Plan
- [AGENTS.md](AGENTS.md) —— 项目开发规范

## 安全约束（摘自 AGENTS.md）

文件访问不得越出 workspace；密钥文件不可读；高风险命令必须人工确认；禁止自动 git push；重要文件覆盖需确认。这些约束在阶段 3 由 `security` 模块落地，阶段 1 仅实现「日志目录必须位于 workspace 内」这一项校验。
