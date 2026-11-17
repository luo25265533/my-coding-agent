# 阶段 9 开发 Plan：Web 网页操作界面（本地 serve + 浏览器）

> 状态：已实施（V1.1，2026-11-16）
> 日期：2026-11-16
> 范围：本地 Web UI 最小可用（发任务 / 确认 Plan / 高风险确认 / 实时进度 / 任务查询）
> 前置：阶段 8 V1.0 已验收通过（改动未提交，本阶段继续在同一工作区叠加）

## 一、现状分析

用户需求：目前只能通过命令行操作 Agent，希望以网页等方式操作。经确认：**本地 Web 网页 +
最小可用范围 + 作为阶段 9 立项**。

现有代码与本次需求的接缝：

| 现状                                                                    | 阶段 9 缺口                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `runCommand` 直接 `process.stdout.write` 打印进度（run.ts 各 printXxx） | 需要事件外发接口（sink），CLI 默认行为不变，web 注入 SSE 广播 |
| 中止只靠 `process.once('SIGINT')`（run.ts:130）                         | 需要外部 `AbortSignal` 注入，网页"中止"按钮可触发             |
| Plan 确认 / 高风险确认已支持注入（`approvePlan` / `confirm`）           | web 端挂起等待浏览器按钮应答                                  |
| 无 HTTP 服务、无静态资源、无配置项                                      | `serve` 命令 + 极简路由 + 鉴权 + 配置字段                     |
| 任务查询只有 CLI `tasks list/show`                                      | 只读 HTTP 查询接口                                            |
| 前端不存在                                                              | 单页原生 HTML/JS/CSS，无框架、无构建步骤                      |

**架构约束**：新增顶层 `web` 模块，与 `cli` 平级，依赖方向 `web → agent/{planner, tools,
evaluator} → {llm, context, memory, security} → {config, logger, shared}`；`cli → web` 仅限
`serve` 命令的参数透传。不引入 express/ws 等新依赖（`node:http` + 原生 SSE）。

## 二、已定决策

| 决策         | 选择                                                                       | 理由                                                               |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 交互形式     | 本地 Web 网页                                                              | 用户确认；零安装、复用现有模块                                     |
| 范围         | 最小可用：发任务、Plan/高风险确认、实时进度、任务列表与详情、中止          | 用户确认；控制工期，不做日志流/diff 全文/resume 按钮/会话历史      |
| HTTP 实现    | `node:http` 手写极简路由（~150 行），不引框架                              | 项目保持轻依赖；路由面积极小（6 个 API + 静态文件）                |
| 实时推送     | SSE（`text/event-stream`），连接即全量重放内存事件列表                     | 单向推送足够；重放替代 Last-Event-ID，断线重连逻辑最简             |
| 安全模型     | 仅绑定 `127.0.0.1`；启动时生成随机 token，`/api/*` 校验 `x-agent-token` 头 | 防其他本地页面 CSRF；页面 URL 带 token，不含 token 的 API 调用 403 |
| 并发模型     | 同一 server 同一时间只允许 1 个任务，运行中 `POST /api/run` 返回 409       | 最小可用；避免资源竞争与确认流交叉                                 |
| 复用执行内核 | 直接调用 `runCommand`（注入 sink / approvePlan / confirm / signal）        | 与 CLI 同一条代码路径，行为一致，不复制业务逻辑                    |
| 前端技术     | 单页原生 HTML/CSS/JS，放在 `src/web/public/`，构建随 tsc 复制              | 无框架无构建链；页面体量小，不值得引入打包器                       |
| 端口         | `AGENT_WEB_PORT`（默认 3210，1024–65535），`--port` 可覆盖                 | 配置统一走 zod 校验                                                |
| 版本         | 验收时 `1.0.0 → 1.1.0`（新功能 minor）                                     | 语义化版本                                                         |
| 提交策略     | 不自动 commit / push                                                       | AGENTS.md 安全约束                                                 |

## 三、范围

### 3.1 本次做（IN）

1. `runCommand` 事件化：`RunOptions` 增加 `sink?: RunEventSink` 与 `signal?: AbortSignal`；
   现有 stdout 打印抽为默认 sink，CLI 行为零变化
2. `web` 模块：极简 HTTP 路由、静态文件（含路径穿越防护）、token 鉴权、启动横幅
3. 任务执行 API：`POST /api/run`、`POST /api/plan`、`POST /api/confirm`、`POST /api/abort`、
   `GET /api/events`（SSE）；单任务互斥
4. 只读查询 API：`GET /api/tasks`、`GET /api/tasks/:id`（readOnly TaskStore）
5. 前端单页：任务输入、Plan 确认卡、高风险确认弹窗、步骤/工具/验证/修复实时时间线、
   diff 摘要与最终 answer、中止按钮、任务列表与详情
6. `serve` CLI 命令与配置字段（`AGENT_WEB_PORT` / `AGENT_WEB_HOST`）、`.env.example`
7. 测试：路由/鉴权/穿越单测 + 进程内 server 集成测试（mock 脚本全流程）
8. 文档：README、architecture（web 模块 + 路线图阶段 9）、testing.md
9. 验收：门禁全绿 + 真实浏览器演示 + 开发报告；版本 1.1.0

### 3.2 本次不做（OUT）

- 多任务并行、任务队列、resume 按钮、日志实时流、diff 全文展示、会话持久化
- 远程访问 / HTTPS / 用户体系（仅本机回环 + token）
- WebSocket、前端框架、打包器、Node 版本/依赖升级
- chat REPL 工具化

## 四、技术设计

### 4.1 事件化改造（`src/cli/commands/run.ts` + `src/cli/run-events.ts`）

> 实施修正：`RunEventSink` 最终落在 `src/cli/run-events.ts` 而非 `src/shared/`——
> sink 签名引用了 agent/planner/context 等上层模块的类型（TaskPlan、StepResult、
> ContextStats 等），放 shared 会违反分层单向依赖，因此随 cli 层定义。

```ts
// src/shared/run-events.ts —— cli 与 web 共用的事件契约（shared 层，无依赖）
export interface RunEventSink {
  banner?(lines: readonly string[]): void;
  plan?(plan: TaskPlan, meta: string): void;
  toolCall?(call: { name: string; arguments: string }, iteration: number): void;
  toolResult?(...): void;
  stepStart?(step, index, total): void;
  stepEnd?(stepResult, index, total): void;
  verification?(result: VerificationResult): void;
  diff?(diff: DiffSummary): void;
  repair?(outcome: RepairOutcome, maxAttempts: number): void;
  taskState?(state: 'step_failed' | 'failed', taskId: string): void;
  contextTrim?(stats: ContextStats): void;
  answer?(content: string): void;
  tokens?(line: string): void;
}
```

- run.ts 内所有 `printXxx` 改为：先写默认 stdout 实现，再调用 `sink?.xxx?.()`；默认
  `stdoutSink` 放回 run.ts 私有，CLI 不传 sink 时行为与现状逐字节一致
- 外部中止：`RunOptions.signal` 存在时 `signal.addEventListener('abort', () => controller.abort())`；
  SIGINT 处理保留（serve 进程 Ctrl+C 兜底）
- 验收要求：`tests/unit/run.test.ts` 全部既有断言不变即证明零回归

### 4.2 Web 服务骨架（`src/web/`）

```
src/web/
  server.ts      createWebServer(config, deps): http.Server —— 路由分发、鉴权、SSE
  session.ts     RunSession：单任务会话状态机 + 事件缓冲 + confirm/plan 挂起
  store.ts       只读任务查询（readOnly TaskStore，按请求开关）
  public/        index.html / app.js / style.css
```

- 路由：`GET /`（页面）、`GET /api/events`、`POST /api/run|plan|confirm|abort`、
  `GET /api/tasks`、`GET /api/tasks/:id`；请求体仅 JSON 且 ≤ 1MB
- 鉴权：启动生成 32 字节随机 token；`/api/*` 必须带 `x-agent-token`；`Host` 必须是
  `127.0.0.1:<port>` 或 `localhost:<port>`；不匹配一律 403/404
- 静态文件：resolve 后必须仍在 `public/` 内（防穿越）；仅白名单扩展名与 MIME
- 生命周期：`POST /api/run` → `runCommand`（注入 webSink + 外部 AbortController +
  approvePlan/confirm 挂起 Promise）异步启动，立即 202；事件经 sink 写入会话缓冲并广播 SSE；
  会话结束后保留快照供 `GET /api/events` 重放，直到下一个任务重置

### 4.3 SSE 事件协议

`event: <type>` + `data: <json>`，type 对齐 RunEventSink（banner/plan/tool_call/tool_result/
step_start/step_end/verification/diff/repair/task_state/context_trim/answer/session 状态变化）。
连接建立先推 `snapshot`（已缓冲事件 + 当前状态），随后增量推送，15s 心跳注释行保活。

### 4.4 前端页面

- 顶栏：状态徽标（idle/awaiting_plan/running/…）+ 中止按钮
- 主区：任务输入框 + `--yes`/`--no-verify` 开关 → 发起；Plan 确认卡（目标、步骤、批准/拒绝）；
  时间线（步骤开始/结束、工具调用与结果截断 500 字、验证结果、修复进度、diff 摘要）；
  最终 answer 区
- 侧栏：任务列表（`GET /api/tasks`，点击加载 `GET /api/tasks/:id` 只读详情）
- 高风险确认：模态弹窗（复用 confirm 事件中的命令文本）

### 4.5 CLI 与配置

- `agent serve [--workspace <path>] [--port <n>] [--log-level <level>] [--verbose]`
- envSchema 新增：`AGENT_WEB_PORT`（1024–65535，默认 3210）、`AGENT_WEB_HOST`
  （`127.0.0.1` | `localhost`，默认 `127.0.0.1`）
- 启动横幅打印访问地址（含 token）与安全提示（仅本机、Ctrl+C 退出）

## 五、任务分解

| #   | 任务                                                                  | 依赖  |
| --- | --------------------------------------------------------------------- | ----- |
| P1  | run 事件化改造：RunEventSink + 外部 AbortSignal + 单测回归            | —     |
| P2  | web 骨架：server/session/store + serve 命令 + 配置字段 + 鉴权/静态    | P1    |
| P3  | 执行 API：run/plan/confirm/abort + SSE 事件流 + 单任务互斥            | P2    |
| P4  | 查询 API：tasks 列表与详情                                            | P2    |
| P5  | 前端单页（时间线/确认/中止/任务列表）                                 | P3-P4 |
| P6  | 测试：单测（路由/鉴权/穿越/配置）+ 集成（mock 全流程/中止/409/403）   | P3-P5 |
| P7  | 文档（README/architecture/testing/.env.example）+ 验收 + 报告 + 1.1.0 | P6    |

## 六、测试计划（必须真实执行）

### 6.1 单元测试

- `run-events` / run sink：默认输出与现状一致；注入 sink 收到完整事件序列
- web 路由：无 token 403、错 token 403、错误方法 405、未知路径 404、body 超 1MB 413、
  非 JSON 400
- 静态文件：`../` 穿越拒绝、白名单外扩展名拒绝
- 配置：`AGENT_WEB_PORT` 越界/非整数拒绝；`AGENT_WEB_HOST` 非法值拒绝

### 6.2 集成测试（进程内起 server，随机端口 + mock 脚本）

- 全流程：`POST /api/run` → SSE 收到 plan → `POST /api/plan {approved:true}` → 步骤/工具
  事件 → 验证 → 任务 completed → `GET /api/tasks/:id` 状态一致
- 高风险确认：写工具触发 confirm → SSE 收到确认请求 → `POST /api/confirm` 两分支
- 中止：运行中 `POST /api/abort` → 任务持久化 aborted，SSE 收到中止事件
- 互斥：任务运行中再次 `POST /api/run` → 409
- 鉴权：无 token 的 API 调用 403；错误 Host 403
- 回归：全量既有测试通过；`zhipu-live` 默认跳过

### 6.3 验收门

- `pnpm typecheck / lint / format:check / build / test:coverage` 全绿
- `pnpm verify` 全绿（verify.js 本阶段不改，保持 35 项）
- 真实浏览器手动演示：发任务 → 确认 Plan → 观察 timeline → 中止一次 → 再跑成功 →
  任务列表查看详情（截图/输出记录回填第十节）

## 七、安全验收用例

- 仅绑定 127.0.0.1；外部接口访问拒绝
- 无 token / 错 token 的 API 一律 403；静态页面不含任何密钥
- 静态文件路径穿越（`../`、绝对路径、URL 编码）全部拒绝
- 请求体 ≤ 1MB、仅 JSON；SSE 只读
- web 下所有工具确认仍走 `isApproved`/`classifyCommand`，`--yes` 不放宽工具确认
- 测试不读取项目根 `.env`、不写真实工作区、不自动 commit / push、不消耗真实配额

## 八、风险与应对

| 风险                                | 说明                                       | 应对                                                             |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| runCommand 进程内复用与 SIGINT 交互 | serve 进程 Ctrl+C 需退出服务而非仅中止任务 | SIGINT 先 abort 当前任务，二次 SIGINT 退出进程；外部 signal 主导 |
| SSE 长连接被中断                    | 代理/杀软可能断开                          | 心跳 + 断线自动重连 + snapshot 重放                              |
| 无鉴权被本机其他页面调用            | CSRF/DNS rebinding                         | token 头 + Host 白名单 + 仅回环绑定                              |
| 手写路由健壮性                      | URL/方法/体异常                            | 统一入口 try/catch、白名单分发、体大小限制，全部有单测           |
| 事件量大撑爆内存                    | 单任务事件数百条级                         | 会话缓冲设上限（如 5000 条，超出丢弃最旧并打标）                 |
| 前端无框架可维护性                  | 逻辑分散                                   | 事件驱动单文件 ≤ 500 行，状态机集中一处                          |
| tsc 不复制 public/                  | 构建产物缺页面                             | build 脚本补 `cp public dist/web/public`（含 Windows 兼容写法）  |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件，已确认并实施）
- [x] 代码变更（run 事件化、web 模块、serve 命令、配置、前端页面）
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明
- [x] 完成情况
- [x] 文档更新（README、architecture、testing.md、.env.example、CHANGELOG 1.1.0）
- [x] git diff 检查
- [x] 开发报告

## 十、验收结果（实施后回填）

### 10.1 验收门真实输出（2026-11-16）

- `pnpm typecheck`：tsc --noEmit，0 error
- `pnpm lint`：eslint（type-checked），0 error
- `pnpm format:check`：prettier，全部通过
- `pnpm build`：tsc 编译 + copy-public.js 复制静态页，成功
- `pnpm test:coverage`：**828 通过 + 5 跳过（833）**，覆盖率 **语句/行 95.59%、分支 89.97%、
  函数 99.74%**（阈值 95/88/99 未降低）
- `pnpm verify`：**35 项全部 PASS**（门禁 5 项 + REPL/规划/任务验证/修复/恢复/Resume 演示）
- 真实端点回归（`ZHIPU_LIVE_TEST=1`）：本轮未执行

### 10.2 新增测试统计

| 文件                                 | 数量 | 内容摘要                                                                        |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------- |
| `tests/unit/web-server.test.ts`      | 27   | token 格式、405 矩阵、413/400/409 边界、SSE 快照帧、clientError、close 二次拒绝 |
| `tests/unit/web-session.test.ts`     | 11   | 状态机、busy 互斥、Plan/确认批准与拒绝、中止（含决策等待中）、步骤失败、修复    |
| `tests/unit/serve.test.ts`           | 2    | serve 启动健康检查 + close、端口占用抛错                                        |
| `tests/integration/web-flow.test.ts` | 4    | SSE 全事件流、确认批准落盘、确认拒绝不落盘、等待 Plan 时中止                    |

浏览器人工验收（P6 期间完成）：token 登录 → 发任务 → SSE 实时事件 → Plan 批准/拒绝 →
高风险确认 → 中止 → 409 互斥 → 任务列表与详情，全部通过（mock provider，不消耗配额）。

### 10.3 实施中发现并修复的问题

1. **SSE 载荷信封 bug**：服务端最初推送完整 WebEvent `{seq,type,data}`，前端按载荷解析导致
   全部字段 undefined。修正为推送 `event.data`，并补快照帧测试锁定。
2. **中止在决策等待时失效**：`awaiting_plan/awaiting_confirm` 期间 abort 无法解除挂起
   Promise。修正为 abort 时将挂起决策 resolve(false)（等价拒绝），任务立即结束。
3. **配置注入缺口（重要）**：`runCommand` 默认从进程环境 + cwd/.env 加载配置，进程内宿主
   （web session）会读到宿主目录的 `.env`。增加 `RunOptions.config` 注入并在 `RunSession`
   中传入已加载配置，测试与宿主不再触碰真实端点。
4. **verify.js 误判**：新测试日志中的业务文本（`plan step s1 failed`）命中了旧的
   `/\d+ failed/` 汇总校验。改为剥离 ANSI 颜色码后仅匹配 vitest 汇总行
   （`Test Files|Tests \d+ failed`）。
5. **write_file 确认触发条件**：仅覆盖已存在文件才触发高风险确认；相关测试据此预置文件。

### 10.4 残余风险与已知限制

- token 明文出现在启动 URL 与浏览器 localStorage；本地单用户设计，无 HTTPS/多用户。
- SSE 只推状态与摘要（工具结果预览 ≤400 字符），无日志全文与 diff 全文。
- `tokens` 事件仅直接模式（`--no-plan`）产生，Web 规划流不外发。
- `serve` 与 CLI `run` 一致，从当前工作目录读取 `.env`——宿主应使用 `RunOptions.config`。
- 事件缓冲上限 5000，超出丢弃最旧并在快照中标记 `droppedEvents`。
- SIGINT 处理依赖真实进程信号，进程内测试无法覆盖（`/* v8 ignore */` 标注）。

### 10.5 配额消耗说明（透明记录）

本阶段实施过程中发生 **3 次真实端点调用**（glm-5.3，约 1200 promptTokens 级）：1 次 serve
演示时误读仓库根 `.env`，2 次为配置注入修复前的集成测试。修复后全部测试恢复离线 mock，
不再消耗配额。建议尽快轮换 `.env` 中的密钥（曾在早期阶段明文暴露）。
