# my-coding-agent

从零实现的 TypeScript Single Coding Agent（V1.1）。目标是理解 Agent 的架构与实现原理，因此核心循环手写，不使用 LangChain 等编排框架。

当前为 **阶段 9：本地 Web 网页操作界面（V1.1）**。在 V1.0 的 `run` 基础上新增 `serve` 命令：
浏览器单页可直接发任务、实时查看步骤/工具调用/验证结果、批准 Plan 与高风险确认、中止任务、
浏览历史任务与详情。Web 层只做事件转发与只读查询，复用 CLI 的 `runCommand` 全部执行链路，
不引入框架与 WebSocket（SSE 单向推送）。`run` 默认先让模型产出结构化 Plan，
经 zod + 语义校验并确认后逐步执行；任务会落库，步骤完成后自动执行验证命令，验证失败进入
有界自动修复，支持 `--resume` 从已完成步骤继续。工具侧包含只读检索、写文件、精确编辑与命令
执行，写操作与高风险命令受审批约束：覆盖非空文件、删除/重置/发布类命令需人工确认，非交互
环境默认拒绝，`git push` 与灾难性命令硬拒绝。`--yes` 只跳过 Plan 确认，`--plan-only` 只输出
计划，`--no-plan` 退回直接工具循环。`chat` REPL 仍只对话、不接工具，聊天会话持久化顺延到
V1.0 之后。

> 规划、执行、验证、修复、恢复与全部工具均可离线验证：`mock` provider + 脚本化响应 + 临时
> workspace 即可跑完整个链路，不联网、不消耗配额。

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
| 任务库   | sql.js                     | 1.16.0          |
| 测试     | vitest / vite              | 3.2.7 / 6.4.6   |
| Lint     | eslint / typescript-eslint | 9.39.5 / 8.72.2 |
| 格式化   | prettier                   | 3.10.0          |

`vite` 通过 `package.json` 的 `pnpm.overrides` 强制锁在 6.4.6，避免被解析到 7.x 触发 Node 20.19 门槛。
任务库使用 sql.js（SQLite WASM），不引入 native 模块。

## 安装与启动

```bash
pnpm install
cp .env.example .env      # 可选，不创建也能跑（全部走默认值）

pnpm dev                  # 开发态直跑 TS，默认进入 run
pnpm dev "hello"          # 带任务描述启动（mock provider 下回显任务）
pnpm dev "读取 package.json 并告诉我项目名"   # 真实 provider 下会自主调用 read_file
pnpm cli --help           # 原始 CLI 透传，用于 --help / --version
pnpm cli run --verbose "hello"
pnpm cli tasks            # 查看当前 workspace 最近的任务
pnpm cli chat             # 进入多轮对话 REPL（需先配置 provider）

pnpm build                # 编译到 dist/
node dist/cli/main.js run "读取 README.md 并总结"
node dist/cli/main.js tasks show <taskId>
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
agent run [task...]          运行任务：默认先规划，确认后逐步执行并验证
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价于 --log-level debug
  --yes                      跳过 Plan 确认（不跳过工具高风险确认）
  --plan-only                只生成 Plan、落库并打印任务 ID，不执行
  --no-plan                  退回直接工具循环（不建任务、不验证、不落库）
  --resume <taskId>          恢复已保存的任务（不能同时给任务文本或 --plan-only）
  --verify <command>         本次任务使用指定验证命令（显式命令不会自动跳过）
  --no-verify                本次任务不执行验证
agent tasks                  列出最近任务（默认 20 条）
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --limit <n>                最多列出条数（1–1000）
agent tasks list             同上
agent tasks show <taskId>    查看单个任务的目标、步骤、验证与差异摘要
  --workspace <path>         覆盖 AGENT_WORKSPACE
agent chat                   多轮对话 REPL（不调用工具）
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价于 --log-level debug
  --system <prompt>          覆盖默认 system 提示
  --model <name>             覆盖 LLM_MODEL
```

`run` 默认流程：生成 Plan → 打印目标与编号步骤 → 请求确认 → 任务落库 → 逐步执行 → 验证 →
（可选）修复 → 汇总。示例：

```
my-coding-agent v1.0.0
runId     : 6f0e...
workspace : /path/to/workspace
provider  : mock  model: (default)
context   : budget=16000 tokens  repo-map=34 tokens  files=4
task      : 新增 add 函数并补测试
verify    : pnpm test (auto-skip without package.json)

plan:
  goal: 新增 add 函数并补测试
  1. [s1] 实现 add
     files: src/math.ts
  2. [s2] 补单元测试
     files: tests/math.test.ts
  (attempts=1 repo-map=34 tokens)

Execute this plan? [y/N] y
task: 0f6c1d2e-...

step 1/2 → 实现 add
[1] → write_file {"path":"src/math.ts","content":"..."}
[1] ← ok 21 chars (4ms)
step 1/2 ← completed (iterations=2 tools=1)
...
verification: passed (command="pnpm test", 2.1s)
diff: 2 files, +18 -2
plan completed  steps=2  tools=2  tokens: prompt=... completion=... total=...
task completed: 0f6c1d2e-...
```

任务生命周期：

| 阶段 | 行为                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| 规划 | 模型产出 JSON Plan，zod + 语义校验；失败自动修复一次                             |
| 确认 | 交互式确认（`--yes` 跳过）；拒绝则打印 `plan declined; nothing executed`         |
| 落库 | 新任务写入 `.agent/tasks.db`，打印 `task: <id>`                                  |
| 执行 | 每步独立 AgentLoop，逐步持久化状态、迭代与用量                                   |
| 验证 | 默认 `pnpm test`；无 `package.json` 或改动仅含静态资源时跳过（显式命令始终执行） |
| 修复 | 验证失败后最多 N 轮受控修复，每轮重新验证                                        |
| 恢复 | `--resume <id>` 从第一个未完成步骤继续；已完成步骤不重跑                         |
| 查看 | `tasks` / `tasks show` 只读访问，不获取写锁、不调用模型                          |

任务状态：`planned` / `running` / `step_failed` / `verifying` / `repairing` / `completed` /
`failed` / `aborted`。恢复以步骤为最小单位；已中断的 `running` 步骤会重置重跑。任务记录的
workspace 与当前 workspace 不一致时拒绝恢复。

`--plan-only` 打印 Plan 后落库为 `planned`，输出 `task: <id>` 与
`resume with: agent run --resume <id>`，退出码 0。`--no-plan` 不创建任务库，保留阶段 5 的
启动横幅、轨迹与 `tokens: ... iterations=... tools=...` 汇总格式。工具级高风险确认独立于
`--yes`：非 TTY 下直接拒绝并打印 `high-risk action denied (non-interactive)`。

验证与修复输出：

```
verification: failed (exit=1, 1.4s)
repair 1/2: answered (iterations=3 tools=2)
verification: passed (command="pnpm test", 2.1s)
verification: skipped (disabled)
diff: unavailable (not a git repository)
```

步骤失败时打印 `plan failed at step <id>: <reason>` 与 `task step_failed: <id>`，并给出
`resume with: agent run --resume <id>`，退出码 1。修复耗尽仍失败时打印
`task failed: <id>` 与恢复提示，退出码 1。`--verify` 命令同样经过风险分级：`git push` 硬拒绝，
高风险命令需要确认，非 TTY 拒绝且不进入修复。

`run` 输出启动横幅、调用轨迹、最终答案与用量统计（`--no-plan` 直接模式示例）。横幅中的
`context` 行展示本次注入预算、项目概览消耗与扫描文件数：

```
context   : budget=16000 tokens  repo-map=34 tokens  files=4
[1] → read_file {"path":"package.json"}
[1] ← ok 41 chars (3ms)
answer:
项目名是 my-coding-agent。
tokens: prompt=... completion=... total=...  iterations=2  tools=1
```

无任务时退出码 2。任务未正常结束时退出码 1，并给出停止原因（以下为单步循环的停止原因；
规划模式下某步以非 `answer` 结束时，整体报 `plan step <id> failed (<reason>)`）：

| 停止原因             | 含义                                     |
| -------------------- | ---------------------------------------- |
| `empty_answer`       | 模型没有调用工具但答案为空               |
| `output_truncated`   | 模型输出被截断（`finish_reason=length`） |
| `repeated_tool_call` | 同一工具+参数连续出现达到阈值            |
| `tool_failure_limit` | 连续多轮工具调用全部失败                 |
| `max_iterations`     | 迭代预算耗尽（`AGENT_MAX_ITERATIONS`）   |

`Ctrl+C` 中止当前运行；规划模式下任务标记为 `aborted`，可稍后 `--resume` 继续。

### 任务查看

```
$ agent tasks
0f6c1d2e-...  completed   steps=2/2  repairs=1  updated=2026-11-16 10:21:03  新增 add 函数并补测试

$ agent tasks show 0f6c1d2e-...
task      : 0f6c1d2e-...
goal      : 新增 add 函数并补测试
workspace : /path/to/workspace
status    : completed
steps     : 2/2
repairs   : 1
resumes   : 0
verify    : pnpm test
steps:
  1. [s1] 实现 add — completed (iterations=2 tools=1)
  2. [s2] 补单元测试 — completed (iterations=2 tools=1)
verifications:
  1. failed (attempt=1, exit=1, 1402ms)
     reason: exit code 1
     output:
       ... 输出尾部（≤1200 字符）...
  2. passed (attempt=2, exit=0, 2100ms)
diffs:
  1. 2 files, +18 -2
```

`tasks show` 只对失败/跳过的验证输出原因与输出尾部（≤1200 字符），通过项不展开完整输出；
任务不存在时退出码 2（`task not found`）。

REPL 内置命令：`/exit`、`/quit` 退出；`/clear` 清空历史（保留 system）；`/help` 查看帮助。
空行忽略，未知斜杠命令按普通消息发送。`Ctrl+C` 在有请求在飞时只中止本轮，空闲时退出。
单轮请求失败只打印错误，不会终止 REPL。REPL 历史仅存内存，V1.0 不落盘。

退出码：`0` 成功 / `1` 运行时错误 / `2` 参数、配置或任务标识错误。

## Web 界面

```
$ pnpm cli serve
my-coding-agent v1.2.0 - web UI
url       : http://127.0.0.1:3210/?token=<22位随机token>
workspace : D:\demo
provider  : mock  model: (default)
Ctrl+C 退出。
```

浏览器打开完整 URL（含 `?token=`）即可使用；token 也会存入浏览器 localStorage，
之后可直接访问 `http://127.0.0.1:3210` 并手动粘贴 token。

页面能力（对话式布局：左侧 300px 任务历史，右侧对话区 + 底部操作台）：

- **发任务**：底部操作台提交任务描述（≤4000 字符）+ `--yes` / `--no-verify` / `--verify`
  等价选项；提交后生成右侧用户气泡，Agent 事件全部落在左侧气泡流
- **实时事件流**（SSE）：banner、Plan、步骤开始/结束、工具调用与结果（参数/结果默认折叠）、
  验证、修复、上下文裁剪、最终回答（绿色强调）、任务结束，断线 2 秒自动重连并回放快照
- **人工决策**：`awaiting_plan` / `awaiting_confirm` 时批准/拒绝按钮直接挂在对应气泡内，
  决策后按钮禁用并在气泡上保留 "✓ 已批准 / ✗ 已拒绝" 标记
- **确认超时**：高风险确认等待超过 `AGENT_CONFIRM_TIMEOUT_MS`（默认 5 分钟）自动拒绝，
  气泡标记 "✗ 超时自动拒绝"，任务继续执行后续步骤
- **验证诊断**：验证失败气泡展示输出尾部（≤1500 字符）；任务结束时若所有步骤已完成但验证
  未通过，标题区分为“任务未通过：步骤已完成，但验证失败”，并提示展开左侧历史查看输出
- **中止**：运行中或等待决策时中止；卡在等待决策的中止等价于拒绝
- **任务历史**：左侧栏展示最近任务（标题 2 行截断、状态圆点），点击条目手风琴展开/收起
  摘要详情（状态/步骤/验证/差异），等价 `tasks list|show`

安全边界（本地最小可用范围）：

- 仅监听 `127.0.0.1`（`AGENT_WEB_HOST` 可选 `localhost`），绝不绑定 `0.0.0.0`
- 所有 `/api/*` 请求必须回传启动时生成的 128 位 token（`x-agent-token` 头）
- Host 校验阻断 DNS rebinding；静态文件白名单防路径穿越；请求体 ≤1MB
- 单任务互斥：运行中再发任务返回 409

注意事项：

- `serve` 与 CLI `run` 相同，从**当前工作目录**读取 `.env` 与环境变量；请先 `cd` 到目标
  workspace 或显式设置 `AGENT_WORKSPACE`，避免误加载其他目录的配置
- SSE 只推送状态与摘要（工具结果预览 ≤400 字符），不推送完整日志与 diff 全文

## 配置

全部配置来自环境变量，优先级为 **进程环境变量 > `.env` 文件 > 默认值**，由 zod 校验后冻结为只读对象。

| 变量                             | 默认值            | 说明                                             |
| -------------------------------- | ----------------- | ------------------------------------------------ |
| `LLM_PROVIDER`                   | `mock`            | `mock` 或 `openai-compatible`                    |
| `LLM_API_KEY`                    | 空                | provider 非 mock 时必填                          |
| `LLM_BASE_URL`                   | 空                | provider 为 openai-compatible 时必填             |
| `LLM_MODEL`                      | 空                | provider 非 mock 时必填                          |
| `LLM_TIMEOUT_MS`                 | `60000`           | 1–600000                                         |
| `LLM_MAX_RETRIES`                | `2`               | 0–10                                             |
| `AGENT_WORKSPACE`                | `.`               | 沙箱根，解析为绝对路径                           |
| `AGENT_MAX_ITERATIONS`           | `20`              | 1–200，直接模式单任务循环上限                    |
| `AGENT_MAX_REPEATED_CALLS`       | `3`               | 2–100，重复同一调用达到该次数即停止              |
| `AGENT_MAX_CONSECUTIVE_FAILURES` | `3`               | 1–100，连续工具全失败达到该轮数即停止            |
| `AGENT_CONFIRM_HIGH_RISK`        | `true`            | 接受 true/false/1/0；false 时高风险动作直接放行  |
| `AGENT_CONFIRM_TIMEOUT_MS`       | `300000`          | 1000–3600000，高风险确认等待上限，超时自动拒绝   |
| `AGENT_CONTEXT_BUDGET_TOKENS`    | `16000`           | 1000–200000，单次请求的上下文 token 预算         |
| `AGENT_PLAN_MAX_STEPS`           | `12`              | 1–50，Plan 最大步骤数                            |
| `AGENT_STEP_MAX_ITERATIONS`      | `10`              | 1–100，每个 Plan 步骤的工具循环上限              |
| `AGENT_COMMAND_TIMEOUT_MS`       | `30000`           | 1000–600000，`run_command` 默认超时              |
| `AGENT_TASK_DB`                  | `.agent/tasks.db` | 任务库路径；必须位于 workspace 内且非敏感文件名  |
| `AGENT_VERIFY_COMMAND`           | `pnpm test`       | 步骤完成后的验证命令；显式留空表示关闭自动验证   |
| `AGENT_VERIFY_TIMEOUT_MS`        | `300000`          | 1000–600000，验证命令超时                        |
| `AGENT_VERIFY_SKIP_STATIC`       | `true`            | 默认命令下静态资源/无改动时跳过验证              |
| `AGENT_MAX_REPAIR_ATTEMPTS`      | `2`               | 0–10，验证失败后的最大修复轮数，0 关闭自动修复   |
| `AGENT_REPAIR_MAX_ITERATIONS`    | `8`               | 1–100，每轮修复的 AgentLoop 迭代上限             |
| `AGENT_RESPECT_GITIGNORE`        | `true`            | 读取工作区根部 `.gitignore` 作为忽略规则         |
| `AGENT_IGNORE`                   | 空                | 额外忽略规则，逗号/换行分隔，语法同 `.gitignore` |
| `AGENT_LOG_LEVEL`                | `info`            | trace/debug/info/warn/error/fatal/silent         |
| `AGENT_LOG_DIR`                  | `.agent/logs`     | 相对路径基于 workspace，且必须位于 workspace 内  |
| `AGENT_LOG_PRETTY`               | `true`            | 控制台美化输出；文件侧恒为 JSON                  |
| `AGENT_MOCK_SCRIPT`              | 空                | 仅 mock provider：按步回放的工具调用脚本路径     |
| `AGENT_WEB_PORT`                 | `3210`            | 1024–65535，`serve` 命令的 HTTP 端口             |
| `AGENT_WEB_HOST`                 | `127.0.0.1`       | 仅允许 `127.0.0.1` / `localhost`                 |

验证命令的取值规则：

- `--no-verify` > `--verify <command>` > 环境变量 > 任务中保存的命令（`--resume`）
- `AGENT_VERIFY_COMMAND` 显式置空（含 `.env` 中写空）表示不做验证；默认 `pnpm test` 在缺少
  `package.json` 的工作区自动跳过并给出原因
- 默认命令在改动仅涉及静态资源（`.md`/`.html`/`.css`/`.svg`/图片/字体等）或无可检测改动时
  跳过，原因写入任务记录；`AGENT_VERIFY_SKIP_STATIC=false` 可关闭（显式命令始终执行）
- 显式指定的命令始终执行（超时或非 0 退出均判失败）

配置只做格式与必填校验，不在加载时测试模型连通性；连通性由实际请求时体现。

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

## 测试

默认测试套件**完全离线**：

- provider 用 `mock` + `AGENT_MOCK_SCRIPT` 脚本化回放
- 进程级 E2E 使用临时 workspace 与真实 CLI 子进程
- LLM 异常用本地 `node:http` 假端点，不访问外网
- 测试基线显式覆盖所有相关环境变量，不读取项目根 `.env`

```bash
pnpm test              # 全量单元 + 集成测试
pnpm test:coverage     # 覆盖率报告（含阈值）
pnpm verify            # 门禁 + 全量测试 + mock REPL / 规划改码 / 任务可靠性演示
```

测试分层、异常与权限矩阵、各用例对应文件、SIGINT 平台说明见 [docs/testing.md](docs/testing.md)。

### 真实端点测试（默认跳过）

真实端点测试需显式开启，密钥只从 `.env` / 环境变量读取：

```bash
ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
```

该测试会产生费用并依赖配额，不作为发布门禁。

## 工具与沙箱

| 工具          | 用途                              | 关键上限                                                         |
| ------------- | --------------------------------- | ---------------------------------------------------------------- |
| `read_file`   | 带行号读取文本，支持 offset/limit | 单次 ≤400 行且 ≤256 KB；含 NUL 字节判为二进制并拒绝              |
| `list_files`  | 列目录，可递归、可控制深度与条数  | 深度 ≤5、默认 200 条；应用忽略规则                               |
| `search_code` | 逐行正则搜索，可按 glob/路径过滤  | 命中 ≤200、上下文行 ≤5；跳过 >1 MB 文件、二进制与敏感/忽略项     |
| `find_files`  | 按 glob 查找文件，递归、可限深度  | 结果 ≤500、默认 100；应用忽略规则                                |
| `write_file`  | 写入完整文件，自动建父目录        | ≤256 KB；覆盖非空文件需确认；原子写；拒绝敏感文件与 `.git/`      |
| `edit_file`   | 字符串唯一匹配替换                | 文件 ≤1 MB；`old_string` 1–20 KB；歧义/未命中报错；可 replaceAll |
| `run_command` | 执行 shell 命令并捕获输出         | 命令 1–1000 字符；cwd 限于 workspace；超时 + 进程树终止          |

- 路径先经 PathGuard：相对路径基于 workspace；绝对路径与 `..` 越界一律拒绝；目标存在时再用
  `realpath` 复核，防止 workspace 内的符号链接指向外部。写入额外调用 `resolveForWrite`，
  对**最近已存在祖先**做 realpath 校验，防止目标尚未创建时经符号链接目录逃逸。
- 敏感文件名大小写不敏感拒绝：`.env`、`.env.*`（放行 `.env.example`）、`*.pem`、`*.key`、
  `*.p12`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.git-credentials`、`credentials`；写入同样拒绝。
- 命令风险分级：`git push`、`sudo`、`shutdown`、`diskpart`、`mkfs`、根目录删除等**硬拒绝**；
  递归删除、`git reset --hard`、`git clean -f`、`git checkout .`、发布命令、`curl | sh`、
  `chmod/chown`、`kill/taskkill`、引用 `.env` / 私钥 / `.npmrc` 等命令**需确认**。
- 子进程环境删除名称匹配 `/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` 的变量；
  输出合并 stdout/stderr 后保留头 8000 + 尾 4000 字符，避免撑爆上下文。
- 验证命令与 `run_command` 使用同一套分级与审批；验证输出在打印、落库、送入修复模型前
  按当前环境中的密钥值做文本脱敏。
- 参数由 zod 校验（同一份 schema 同时生成 JSON Schema 发给模型）；业务错误以
  `{"ok":false,"error":{"code":...,"message":...}}` 回传模型，让其自我纠正而不中断循环。
- 工具串行执行，输出统一截断并提示，避免撑爆上下文。
- 循环保护：连续重复同一调用、连续多轮工具全失败都会熔断，避免模型陷入无效循环。

### 忽略规则

`context` 与所有遍历型工具共享同一份忽略匹配器（`security/ignore.ts`）：

- 始终忽略 `node_modules`、`.git`、`dist`、`coverage`、`.agent`，且无法被反选
- `AGENT_RESPECT_GITIGNORE=true` 时读取工作区**根部** `.gitignore`（不支持嵌套 `.gitignore`）
- 支持 `!` 反选、目录规则（尾 `/`）、根锚定（首 `/`）、`*`、`?`、`**`
- `AGENT_IGNORE` 追加项目级规则；顺序为 `.gitignore` 在前、额外规则在后，后者可覆盖前者
- 敏感文件规则独立生效，即使被忽略规则反选也不会被读取

### 上下文与 Token 预算

- 启动时扫描 workspace 生成项目概览：文件数、语言统计、顶层目录摘要、`package.json` 摘要与
  目录树（深度 ≤3、条目 ≤2000、树 ≤300 行），概览最多占预算的 30%，剩余预算给任务与历史
- 预算不足以容纳概览（<200 tokens）或“系统 + 任务”已超预算时，移除概览并保留原始 system
  提示与任务；`stats().repoMapDropped` 与日志 `repo map dropped to fit budget` 记录该情况
- token 估算为启发式：CJK 字符 ≈1 token，其余 ≈4 字符/token，另加每条消息与工具调用的固定开销
- 每次请求前若超预算，按“assistant+tool”整组从最旧开始丢弃并插入省略提示；仍超限则对最长的
  工具输出做**头尾保留**截断（约 60% 头 + 40% 尾，中间插入 `middle truncated; was N chars`），
  保住开头指令与结尾错误信息，同时保持 `toolCallId` 配对
- 直接模式与任务模式结束时，若发生裁剪会额外打印
  `context trimmed: dropped=N truncated=M`；日志记录 `context built` 与 `context trimmed`

### 离线脚本化（测试支撑）

`LLM_PROVIDER=mock` 时可用 `AGENT_MOCK_SCRIPT=path/to/script.json` 按步回放模型响应：

```json
[
  { "toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"package.json\"}" }] },
  { "content": "项目名是 my-coding-agent。" }
]
```

每次模型调用消费一步，用于集成测试与无网络演示；真实 provider 下该配置被忽略。
规划模式下脚本的第一步是规划响应，之后依次是各步骤与每次修复的响应。

## 日志

双输出：控制台（`AGENT_LOG_PRETTY=true` 时为人类可读文本）+ 文件 `<AGENT_LOG_DIR>/agent-<YYYY-MM-DD>.jsonl`（始终 JSON）。

- 每条日志带 `app`、`runId`、`module`，一次运行内可串联
- `apiKey` / `token` / `authorization` / `password` / `secret` / `LLM_API_KEY` 及其嵌套字段强制脱敏为 `[REDACTED]`
- CLI 打印的配置摘要走 `redactConfig()`，密钥恒为 `[REDACTED]` 或 `(unset)`
- 验证输出与任务库同样做值级脱敏；日志不记录完整命令输出
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
pnpm verify         # 一条命令：门禁 + 全量测试 + mock REPL/规划改码/任务可靠性演示（零成本，不联网）
pnpm check          # typecheck + lint + test
```

## 项目结构

```
src/
├─ index.ts        库入口
├─ cli/            命令解析、退出码
│  ├─ commands/    run / chat / tasks / serve
│  └─ run-events.ts  runCommand 事件外发契约（RunEventSink）
├─ web/            本地 Web 界面（与 cli 平级，复用 runCommand）
│  ├─ server.ts      HTTP 服务：静态页 + /api/*（token/Host 校验、SSE）
│  ├─ session.ts     RunSession：状态机、事件缓冲、决策/中止、任务查询
│  └─ public/        前端单页（原生 HTML/CSS/JS，fetch 流式 SSE）
├─ config/         .env 加载 + zod 校验
├─ logger/         分级日志 + 脱敏
├─ shared/         错误、公共类型、Plan/报告、中止信号、原子写、进程执行、token 用量
├─ agent/          核心执行与任务编排
│  ├─ loop.ts        单任务工具循环
│  ├─ plan-runner.ts 按步骤串行执行 Plan
│  ├─ repair.ts      验证失败后的受控修复循环
│  └─ task-runner.ts 任务生命周期（状态、验证、修复、恢复）
├─ llm/            模型通信
│  ├─ types.ts       消息结构 + LLMProvider 契约（含工具协议）
│  ├─ errors.ts      HTTP/网络错误分类与可重试判定
│  ├─ retry.ts       退避抖动 + Retry-After 解析
│  ├─ factory.ts     按配置选择 provider
│  └─ providers/     mock（可脚本化）+ openai-compatible（手写 fetch、SSE 解析、zod 校验）
├─ planner/        任务规划
│  ├─ prompt.ts      规划提示词与修复提示
│  ├─ parse.ts       JSON 提取 + zod/语义校验
│  └─ planner.ts     调用模型、自动修复一次
├─ tools/          工具注册与调度
│  ├─ registry.ts    zod 校验 + JSON Schema 生成
│  ├─ dispatch.ts    调用分发与错误规范化
│  ├─ glob.ts        glob 编译（find_files / search_code 共用）
│  └─ definitions/   read_file / list_files / search_code / find_files / write_file / edit_file / run_command
├─ context/        上下文管理
│  ├─ token-budget.ts 启发式 token 估算
│  ├─ repo-map.ts     项目概览生成
│  └─ manager.ts      注入 + 预算裁剪 + 仓库地图缓存
├─ memory/         任务持久化
│  ├─ types.ts       任务/步骤/存储契约
│  ├─ state.ts       状态迁移表
│  ├─ schema.ts      SQLite DDL、migration、行映射
│  └─ sqlite-store.ts sql.js 实现、原子快照、单写者锁
├─ security/       路径沙箱 + 审批 + 敏感文件 + 忽略规则
│  ├─ path-guard.ts   路径沙箱（读/写）
│  ├─ sensitive-files.ts 敏感文件名
│  ├─ approval.ts     高风险动作审批抽象
│  ├─ command-risk.ts 命令风险分级
│  ├─ child-env.ts    子进程环境净化 + 文本脱敏
│  ├─ ignore.ts       .gitignore 简化解析 + 默认忽略
│  └─ walk.ts         共享遍历/忽略/二进制嗅探
└─ evaluator/      结果验证
   ├─ verify.ts      验证命令执行、分级/审批、输出脱敏
   ├─ diff.ts        git 差异快照与任务增量
   └─ types.ts       验证/差异契约
scripts/
└─ verify.js       离线验收演示（REPL、规划改码、任务验证/修复/恢复）
tests/
├─ unit/           按模块划分的单元测试
└─ integration/    真实 CLI 子进程冒烟、工具/规划循环、任务生命周期、异常与权限矩阵
```

## 已知限制（V1.1）

- `chat` REPL 只对话，不调用工具，也不持久化历史；聊天会话恢复顺延到 V1.0 之后
- Web 界面为本地单用户设计：token 明文出现在启动 URL 与浏览器 localStorage，不做 HTTPS、
  不做多用户/持久会话历史；任务运行期间刷新页面可恢复事件快照，但历史会话不回放
- Web 下 `tokens` 事件不外发（仅直接模式产生）；工具结果只展示 ≤400 字符预览
- 规划失败或步骤失败不会自动重规划（replan）；自动修复只针对**验证失败**
- 非 git 工作区无法做差异检查，只提示 `diff: unavailable`，不影响任务成败
- 任务库为单进程单写者模型；每次状态变更重写整个 sql.js 数据库文件，适合单任务规模，不做并发写
- 安全依赖路径沙箱、敏感文件规则与命令风险分级，不是 OS 级容器沙箱
- Windows 下 `Ctrl+C` 由 CLI 进程自身处理；进程级 E2E 的 SIGINT 用例通过进程内信号注入验证，
  以避免 Windows 上子进程信号语义差异（见 `docs/testing.md`）
- 真实供应商行为不在自动门禁内，仅保留 `ZHIPU_LIVE_TEST=1` 手工回归

## 文档

- [docs/architecture.md](docs/architecture.md) —— 需求分析、架构设计、技术选型、路线图、验收策略
- [docs/testing.md](docs/testing.md) —— 测试分层、离线保证、异常/权限矩阵、发布检查清单
- [docs/plans/phase-1-init.md](docs/plans/phase-1-init.md) —— 阶段 1 开发 Plan
- [docs/plans/phase-2-llm.md](docs/plans/phase-2-llm.md) —— 阶段 2 开发 Plan 与验收结果
- [docs/plans/phase-3-tools.md](docs/plans/phase-3-tools.md) —— 阶段 3 工具调用 Plan 与验收结果
- [docs/plans/phase-4-agent-core.md](docs/plans/phase-4-agent-core.md) —— 阶段 4 Agent Core 加固 Plan 与验收结果
- [docs/plans/phase-5-codebase.md](docs/plans/phase-5-codebase.md) —— 阶段 5 代码库理解 Plan 与验收结果
- [docs/plans/phase-6-planning.md](docs/plans/phase-6-planning.md) —— 阶段 6 规划与执行 Plan 与验收结果
- [docs/plans/phase-7-reliability.md](docs/plans/phase-7-reliability.md) —— 阶段 7 Memory 与验证 Plan 与验收结果
- [docs/plans/phase-8-release.md](docs/plans/phase-8-release.md) —— 阶段 8 集成测试与完善 Plan 与验收结果
- [docs/plans/phase-9-web-ui.md](docs/plans/phase-9-web-ui.md) —— 阶段 9 Web 网页操作界面 Plan 与验收结果
- [CHANGELOG.md](CHANGELOG.md) —— 版本变更记录
- [AGENTS.md](AGENTS.md) —— 项目开发规范

## 安全约束（摘自 AGENTS.md）

文件访问不得越出 workspace；密钥文件不可读；高风险命令必须人工确认；禁止自动 git push；重要文件覆盖需确认。

当前已实现的部分：

- 阶段 1：日志目录必须位于 workspace 内
- 阶段 2：密钥只从环境变量 / `.env` 读取，`.env` 已被 gitignore；日志强制脱敏，错误消息与请求日志均不含密钥（有专门测试断言）；`chat` 不执行任何工具、不读写任何业务文件
- 阶段 3：路径越界、符号链接逃逸、敏感文件读取均被拒绝（`TOOL_DENIED`）；搜索与列目录复用同一份敏感文件排除规则；工具输出有条数/字节/命中上限
- 阶段 5：项目概览只包含路径、语言统计与 `package.json` 白名单字段，不读取文件内容；概览与遍历工具共享忽略规则，密钥文件独立于忽略规则始终排除
- 阶段 6：写工具校验最近存在祖先的 realpath 并拒绝敏感文件/`.git/`；覆盖非空文件需确认；
  高风险命令交互式确认、非 TTY 默认拒绝；`git push` 与灾难性命令硬拒绝；子进程环境删除密钥类
  变量，日志不记录完整命令与输出
- 阶段 7：任务库路径必须在 workspace 内且非敏感文件名；验证命令同样分级/审批；验证输出在
  打印、落库、送入修复模型前脱敏；恢复任务校验 workspace 一致性；单写者锁防止并发覆盖；
  任务库损坏时报告错误且不覆盖原文件
- 阶段 8：进程级 E2E 验证越界路径、符号链接逃逸、敏感文件读写、验证命令分级与恢复一致性，
  断言“拒绝确实没有副作用”；全程临时 workspace，不读取项目根 `.env`，不写入真实工作区
