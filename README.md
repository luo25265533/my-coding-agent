# my-coding-agent

从零实现的 TypeScript Single Coding Agent。目标是理解 Agent 的架构与实现原理，因此核心循环手写，不使用 LangChain 等编排框架。

当前处于**阶段 4：Agent Core 加固**。`run` 能自主完成多步任务：模型决策 → 调用工具 → 观察结果 →
继续决策，直到给出非空答案。循环具备迭代上限、重复调用熔断、连续失败熔断与明确的停止原因；
所有工具只读、受 workspace 沙箱与敏感文件规则约束；`chat` REPL 仍只对话、不接工具。

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

pnpm dev                  # 开发态直跑 TS，默认进入 run
pnpm dev "hello"          # 带任务描述启动（mock provider 下回显任务）
pnpm dev "读取 package.json 并告诉我项目名"   # 真实 provider 下会自主调用 read_file
pnpm cli --help           # 原始 CLI 透传，用于 --help / --version
pnpm cli run --verbose "hello"
pnpm cli chat             # 进入多轮对话 REPL（需先配置 provider）

pnpm build                # 编译到 dist/
node dist/cli/main.js run "读取 README.md 并总结"
node dist/cli/main.js chat
```

`dev` 已内置 `run` 子命令，所以裸跑即启动，不会再只打印帮助。需要 `--help`、`--version` 或其他子命令时走 `cli`。

改用 npm 时，**传参必须加 `--` 分隔符**，否则参数会被 npm 自己吞掉：

```bash
npm run dev               # 启动骨架
npm run dev -- "hello"    # 带任务描述
npm run cli -- --version  # 透传 CLI 参数
```

## CLI

```
agent --version              输出版本号
agent --help                 输出用法
agent run [task...]          运行任务：模型自主调用工具直到给出答案
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价于 --log-level debug
agent chat                   多轮对话 REPL（不调用工具）
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价于 --log-level debug
  --system <prompt>          覆盖默认 system 提示
  --model <name>             覆盖 LLM_MODEL
```

`run` 输出调用轨迹、最终答案与用量统计：

```
[1] → read_file {"path":"package.json"}
[1] ← ok 41 chars (3ms)
answer:
项目名是 my-coding-agent。
tokens: prompt=... completion=... total=...  iterations=2  tools=1
```

无任务时退出码 2。任务未正常结束时退出码 1，并给出停止原因：

| 停止原因             | 含义                                     |
| -------------------- | ---------------------------------------- |
| `empty_answer`       | 模型没有调用工具但答案为空               |
| `output_truncated`   | 模型输出被截断（`finish_reason=length`） |
| `repeated_tool_call` | 同一工具+参数连续出现达到阈值            |
| `tool_failure_limit` | 连续多轮工具调用全部失败                 |
| `max_iterations`     | 迭代预算耗尽（`AGENT_MAX_ITERATIONS`）   |

`Ctrl+C` 中止当前运行。

REPL 内置命令：`/exit`、`/quit` 退出；`/clear` 清空历史（保留 system）；`/help` 查看帮助。
空行忽略，未知斜杠命令按普通消息发送。`Ctrl+C` 在有请求在飞时只中止本轮，空闲时退出。
单轮请求失败只打印错误，不会终止 REPL。

退出码：`0` 成功 / `1` 运行时错误 / `2` 参数或配置错误。

## 配置

全部配置来自环境变量，优先级为 **进程环境变量 > `.env` 文件 > 默认值**，由 zod 校验后冻结为只读对象。

| 变量                             | 默认值        | 说明                                            |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `LLM_PROVIDER`                   | `mock`        | `mock` 或 `openai-compatible`                   |
| `LLM_API_KEY`                    | 空            | provider 非 mock 时必填                         |
| `LLM_BASE_URL`                   | 空            | provider 为 openai-compatible 时必填            |
| `LLM_MODEL`                      | 空            | provider 非 mock 时必填                         |
| `LLM_TIMEOUT_MS`                 | `60000`       | 1–600000                                        |
| `LLM_MAX_RETRIES`                | `2`           | 0–10                                            |
| `AGENT_WORKSPACE`                | `.`           | 沙箱根，解析为绝对路径                          |
| `AGENT_MAX_ITERATIONS`           | `20`          | 1–200                                           |
| `AGENT_MAX_REPEATED_CALLS`       | `3`           | 2–100，重复同一调用达到该次数即停止             |
| `AGENT_MAX_CONSECUTIVE_FAILURES` | `3`           | 1–100，连续工具全失败达到该轮数即停止           |
| `AGENT_CONFIRM_HIGH_RISK`        | `true`        | 接受 true/false/1/0                             |
| `AGENT_LOG_LEVEL`                | `info`        | trace/debug/info/warn/error/fatal/silent        |
| `AGENT_LOG_DIR`                  | `.agent/logs` | 相对路径基于 workspace，且必须位于 workspace 内 |
| `AGENT_LOG_PRETTY`               | `true`        | 控制台美化输出；文件侧恒为 JSON                 |
| `AGENT_MOCK_SCRIPT`              | 空            | 仅 mock provider：按步回放的工具调用脚本路径    |

配置只做格式与必填校验，不在加载时测试模型连通性；连通性由 `chat` 实际发起请求时体现。

### 接入智谱 GLM

`openai-compatible` provider 走手写的 fetch 客户端（不依赖 openai SDK，因其要求 Node ≥22）。
在 `.env` 中填入自己的密钥即可，**密钥不要写进任何源码、测试或文档**：

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
LLM_API_KEY=<your-key>
LLM_MODEL=glm-5.3
```

两个官方端点的区别（实测）：

| 端点                                          | 适用                     |
| --------------------------------------------- | ------------------------ |
| `https://open.bigmodel.cn/api/coding/paas/v4` | GLM Coding Plan 套餐密钥 |
| `https://open.bigmodel.cn/api/paas/v4`        | 普通按量计费密钥         |

Coding Plan 密钥打到普通端点会返回 `429` 且业务码 `1113`（余额不足）。本项目把这种 429 判为
**配额耗尽、不可重试**，与真正的限流 429 区分开，避免无意义重试。

注意：智谱官方文档说明 GLM Coding Plan 仅限在官方支持的指定工具与产品环境中使用，
在自建 Agent 中使用前请自行确认套餐条款。

### 真实端点测试（默认跳过）

默认测试套件**完全离线**：provider 用 mock，HTTP 用 stub fetch，不联网、不消耗配额。
真实端点测试需显式开启，密钥只从 `.env` / 环境变量读取：

```bash
ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
```

## 工具与沙箱

| 工具          | 用途                              | 关键上限                                              |
| ------------- | --------------------------------- | ----------------------------------------------------- |
| `read_file`   | 带行号读取文本，支持 offset/limit | 单次 ≤400 行且 ≤256 KB；含 NUL 字节判为二进制并拒绝   |
| `list_files`  | 列目录，可递归、可控制深度与条数  | 深度 ≤5、默认 200 条；忽略 `node_modules .git dist …` |
| `search_code` | 逐行正则搜索，可按 glob 过滤      | 命中 ≤200；跳过 >1 MB 文件、二进制与敏感/忽略目录     |

- 路径先经 PathGuard：相对路径基于 workspace；绝对路径与 `..` 越界一律拒绝；目标存在时再用
  `realpath` 复核，防止 workspace 内的符号链接指向外部。
- 敏感文件名大小写不敏感拒绝：`.env`、`.env.*`（放行 `.env.example`）、`*.pem`、`*.key`、
  `*.p12`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.git-credentials`、`credentials`。
- 参数由 zod 校验（同一份 schema 同时生成 JSON Schema 发给模型）；业务错误以
  `{"ok":false,"error":{"code":...,"message":...}}` 回传模型，让其自我纠正而不中断循环。
- 工具串行执行，输出统一截断并提示，避免撑爆上下文。
- 循环保护：连续重复同一调用、连续多轮工具全失败都会熔断，避免模型陷入无效循环。

### 离线脚本化（测试支撑）

`LLM_PROVIDER=mock` 时可用 `AGENT_MOCK_SCRIPT=path/to/script.json` 按步回放模型响应：

```json
[
  { "toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"package.json\"}" }] },
  { "content": "项目名是 my-coding-agent。" }
]
```

每次模型调用消费一步，用于集成测试与无网络演示；真实 provider 下该配置被忽略。

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
pnpm verify         # 一条命令：门禁 + 全量测试 + mock REPL 多轮演示（零成本，不联网）
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
├─ agent/          核心执行循环      （阶段 4：结束判定 + 熔断）
├─ llm/            模型通信          （阶段 2 已落地）
│  ├─ types.ts       消息结构 + LLMProvider 契约（含工具协议）
│  ├─ errors.ts      HTTP/网络错误分类与可重试判定
│  ├─ retry.ts       退避抖动 + Retry-After 解析
│  ├─ factory.ts     按配置选择 provider
│  └─ providers/     mock（可脚本化）+ openai-compatible（手写 fetch、SSE 解析、zod 校验）
├─ planner/        任务规划          （阶段 6）
├─ tools/          工具注册与调度    （阶段 3 已落地）
│  ├─ registry.ts    zod 校验 + JSON Schema 生成
│  ├─ dispatch.ts    调用分发与错误规范化
│  ├─ walk.ts        共享遍历/忽略/二进制嗅探
│  └─ definitions/   read_file / list_files / search_code
├─ context/        上下文管理        （阶段 5）
├─ memory/         记忆与持久化      （阶段 8）
├─ security/       路径沙箱 + 敏感文件（阶段 3 已落地）
└─ evaluator/      结果验证          （阶段 7）
tests/
├─ unit/           config / logger / llm / tools / security / agent / cli
└─ integration/    真实进程冒烟（源码入口 + 构建产物入口）+ 工具循环 + 真实端点 opt-in
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 需求分析、架构设计、技术选型、路线图、验收策略
- [docs/plans/phase-1-init.md](docs/plans/phase-1-init.md) —— 阶段 1 开发 Plan
- [docs/plans/phase-2-llm.md](docs/plans/phase-2-llm.md) —— 阶段 2 开发 Plan 与验收结果
- [docs/plans/phase-3-tools.md](docs/plans/phase-3-tools.md) —— 阶段 3 工具调用 Plan 与验收结果
- [docs/plans/phase-4-agent-core.md](docs/plans/phase-4-agent-core.md) —— 阶段 4 Agent Core 加固 Plan 与验收结果
- [AGENTS.md](AGENTS.md) —— 项目开发规范

## 安全约束（摘自 AGENTS.md）

文件访问不得越出 workspace；密钥文件不可读；高风险命令必须人工确认；禁止自动 git push；重要文件覆盖需确认。

完整约束在阶段 3 由 `security` 模块落地。当前已实现的部分：

- 阶段 1：日志目录必须位于 workspace 内
- 阶段 2：密钥只从环境变量 / `.env` 读取，`.env` 已被 gitignore；日志强制脱敏，错误消息与请求日志均不含密钥（有专门测试断言）；`chat` 不执行任何工具、不读写任何业务文件
- 阶段 3：路径越界、符号链接逃逸、敏感文件读取均被拒绝（`TOOL_DENIED`）；搜索与列目录复用同一份敏感文件排除规则；工具输出有条数/字节/命中上限；无写操作与子进程执行
