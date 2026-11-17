# Single Coding Agent 总体方案

> 状态：已确认（2026-11-12）；阶段 1-9.2 已实施，V1.2 发布（2026-11-17）
> 已定决策：工具链走方案 A（保持 Node 20.18.1，锁兼容版本）；LLM 走 OpenAI 兼容优先；环境残留直接删除后重装；git init + 首次提交（不 push）
> 适用范围：D:\my-coding-agent，从零实现的 TypeScript Single Coding Agent

## 一、需求分析

### 1.1 功能需求（源自 AGENTS.md 核心目标）

| 编号 | 需求                                    | 落地模块          | 验收阶段 |
| ---- | --------------------------------------- | ----------------- | -------- |
| FR1  | 理解用户开发需求，歧义时主动澄清        | agent + planner   | 6        |
| FR2  | 分析项目代码，检索并读取相关文件        | tools + context   | 4-5      |
| FR3  | 制定任务计划，拆解为可执行步骤          | planner           | 6        |
| FR4  | 统一注册、校验、调度工具                | tools             | 3-4      |
| FR5  | 修改代码（精确编辑/写入），路径受控     | tools + security  | 3-4      |
| FR6  | 执行测试与命令，捕获输出                | tools + evaluator | 4,7      |
| FR7  | 验证最终结果，失败自动修复（不 replan） | evaluator + agent | 7        |

### 1.2 非功能需求

| 编号 | 需求     | 具体约束                                                                                              |
| ---- | -------- | ----------------------------------------------------------------------------------------------------- |
| NFR1 | 安全     | 文件访问不得越出 workspace；密钥文件不可读；高风险命令人工确认；禁止自动 git push；重要文件覆盖需确认 |
| NFR2 | 可观测   | 结构化日志（JSONL 落盘 + 控制台），每轮循环带 runId/iteration，密钥字段强制脱敏                       |
| NFR3 | 可测试   | LLM 可替换为 mock provider；工具可独立单测；不依赖真实网络即可跑完整循环                              |
| NFR4 | 可扩展   | 新增工具只写一个 ToolDefinition 并注册，不修改 agent 循环                                             |
| NFR5 | 类型安全 | strict 模式，禁止 any，跨模块契约用显式 interface                                                     |
| NFR6 | 可中止   | 全链路传递 AbortSignal，支持 Ctrl+C 与迭代/预算上限                                                   |

### 1.3 明确不做（本项目边界）

- 不做多 Agent 协作、不做子 Agent 派发（架构选定 single）
- 不做 GUI/Web 界面，只做 CLI
- 不做插件市场、不做云端同步
- 不引入 LangChain/LlamaIndex 等编排框架（学习目的，核心循环手写）
- V1.0 不做聊天会话持久化与跨会话记忆恢复（`chat` 历史仅存内存，顺延到 V1.0 之后）

## 二、架构设计

### 2.1 分层与依赖方向

```
入口层    cli/  web/               cli：命令解析、退出码、交互确认；web：本地 HTTP 服务 + 单页
            |
编排层    agent/                   AgentLoop：感知 -> 规划 -> 行动 -> 观察 -> 评估
            |
能力层    planner/  tools/  evaluator/
            |
支撑层    llm/  context/  memory/  security/
            |
基础设施  config/  logger/  shared/(errors, types)
```

依赖规则（单向，禁止反向与环状依赖）：

1. `cli` 只依赖 `agent` + `config` + `logger`
2. `agent` 依赖能力层与支撑层的**接口**，不依赖具体实现（构造时注入）
3. 能力层之间不互相 import；`planner`/`evaluator` 需要模型时依赖 `llm` 接口
4. `security` 是纯守卫，被 `tools`/`context`/`memory` 调用，自身不依赖它们
5. `llm` 不依赖任何业务模块（业务逻辑与模型通信分离）
6. 任何模块都可依赖 `config`/`logger`/`shared`
7. `web` 与 `cli` 平级（阶段 9 落地）：复用 `cli/commands/run.js` 的 `runCommand` 完整链路
   与 `cli/run-events.ts` 的事件契约，不反向依赖，也不绕过 agent 直接调用能力层

### 2.2 模块职责与核心契约

| 模块      | 职责                                       | 关键契约                                                                                                   |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| agent     | 执行循环、迭代上限、中止、状态机、任务编排 | `runAgentLoop(task, opts)`；`runPlan(plan, opts)`；`runTask(opts)`；`runRepair(opts)`                      |
| llm       | 供应商适配、流式、重试、超时、token 统计   | `LLMProvider.chat(req): Promise<ChatResponse>` / `stream(req): AsyncIterable<StreamChunk>`                 |
| planner   | 任务拆解、Plan 校验                        | `Planner.plan(task): Promise<PlanResult>`；结构 + 语义校验，失败自动修复一次                               |
| tools     | 注册表、参数校验、分发、结果规范化         | `ToolRegistry.register(def)` / `specs()`；`dispatchToolCall(registry, call, ctx): Promise<ToolResult>`     |
| context   | 上下文组装、token 预算、截断/压缩          | `ContextManager.buildMessages(task)`；`fit(messages)`；`stats()`（阶段 5 落地，阶段 8 增加头尾截断）       |
| memory    | 任务生命周期持久化                         | `TaskStore.createTask/getTask/listTasks/transition/startStep/finishStep/recordVerification/recordDiff`     |
| security  | 路径沙箱、敏感文件、忽略规则、权限决策     | `resolveInsideWorkspace`；`resolveForWrite`；`assertNotSensitive`；`classifyCommand`；`sanitizeChildEnv`   |
| evaluator | 跑验证命令、采集 git 差异                  | `Evaluator.verify(request): Promise<VerificationResult>`；`diff(): Promise<DiffSummary>`                   |
| config    | .env 加载 + zod 校验 + 冻结                | `loadConfig(env): Readonly<AppConfig>`                                                                     |
| logger    | 分级日志、脱敏、子 logger                  | `createLogger(cfg, runId?): LoggerHandle`（`logger`/`logFile`/`close`）；`logger.child({ module, runId })` |
| web       | 本地 Web 界面（阶段 9）                    | `createWebServer({ logger, publicDir, token, session })`；`RunSession` 状态机/事件缓冲/决策/中止/任务查询  |

工具定义统一形态（阶段 3 落地）：

```ts
interface ToolDefinition<P = unknown> {
  name: string;
  description: string;
  parameters: ZodType<P>; // 校验 + 自动生成 JSON Schema 供 LLM 使用
  riskLevel: 'low' | 'medium' | 'high';
  execute(params: P, ctx: ToolContext): Promise<ToolResult>;
}
```

Agent 循环的停止原因（阶段 4 落地）：

```ts
type AgentStopReason =
  | 'answer' // 无工具调用且答案非空
  | 'empty_answer' // 无工具调用但答案为空
  | 'output_truncated' // finish_reason === 'length'
  | 'repeated_tool_call' // 同一工具+参数连续达到阈值
  | 'tool_failure_limit' // 连续多轮工具全部失败
  | 'max_iterations'; // 迭代预算耗尽
```

只有 `answer` 视为成功；其余由 CLI 映射为运行时错误并退出 1。

上下文契约（阶段 5 落地）：

```ts
interface ContextManager {
  readonly budgetTokens: number;
  buildMessages(task: string): Promise<readonly ChatMessage[]>; // system + 项目概览 + 任务
  fit(messages: readonly ChatMessage[]): readonly ChatMessage[]; // 超预算时整组裁剪/头尾截断，不修改入参
  stats(): ContextStats; // repoMap/initialTokens/dropped/truncated/repoMapDropped/lastRequest
}
```

项目概览由 `security` 的忽略匹配器驱动遍历生成，只含文件数、语言统计、顶层目录摘要、
`package.json` 白名单字段与目录树，不含文件内容；敏感文件始终排除。token 估算为启发式
（CJK ≈1 token，其余 ≈4 字符/token）。超预算时先按“assistant+tool”整组从最旧丢弃，仍超限
则对最长工具输出保留约 60% 头 + 40% 尾并插入原始长度标记，保持工具协议配对完整；极小预算
下优先移除项目概览（`repoMapDropped`），保留 system 与任务。

Plan 与审批契约（阶段 6 落地）：

```ts
interface PlanStep {
  id: string;
  title: string;
  description: string;
  files: readonly string[];
}
interface TaskPlan {
  goal: string;
  steps: readonly PlanStep[];
  notes: string | undefined;
}
interface Planner {
  plan(task: string): Promise<PlanResult>;
}
type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;
type CommandVerdict = { level: 'deny' | 'high'; reason: string } | { level: 'normal' };
```

`runPlan` 复用同一个 `ContextManager`（仓库地图按预算缓存），为每步调用 `runAgentLoop`；
`completedSteps` 只接受与计划逐项匹配的已完成前缀，恢复时跳过这些步骤并保留其用量；
步骤开始/结束回调可返回 Promise，`runPlan` 会 `await` 后再推进。
`confirm` 经 `ToolContext` 注入工具，缺失/返回 false/抛错一律拒绝；命令风险在
`security/command-risk.ts` 中先行分级，`deny` 不进入审批。

任务生命周期契约（阶段 7 落地）：

```ts
type TaskStatus =
  | 'planned'
  | 'running'
  | 'step_failed'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'aborted';

interface TaskStore {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  listTasks(limit?: number): Promise<readonly TaskSummary[]>;
  transition(id: string, to: TaskStatus, patch?: { error?: string | null }): Promise<void>;
  startStep(id: string, index: number): Promise<void>;
  finishStep(id: string, result: TaskStepRecord): Promise<void>;
  recordVerification(id: string, result: VerificationResult): Promise<void>;
  recordDiff(id: string, diff: DiffSummary): Promise<void>;
  recordRepair(id: string, attempt: number, payload: RepairRecord): Promise<void>;
  close(): Promise<void>;
}
```

`TaskStore` 基于 sql.js（SQLite WASM），每次写事务后导出快照并以临时文件 + rename 原子替换，
写模式持有 `tasks.db.lock` 单写者锁；`tasks list/show` 以只读方式打开。状态迁移由显式迁移表
约束，非法迁移抛 `TaskStorage`。恢复只接受与计划逐项匹配的已完成步骤前缀；workspace 与任务
记录不一致时拒绝执行。`runTask` 负责步骤执行、验证、修复与终态持久化，`runRepair` 复用同一
套工具、审批与熔断规则，验证通过后再确认成功。

### 2.3 核心循环（single agent）

```
run(task)
  ├─ 1. 初始化 runId / logger / AbortSignal / 预算
  ├─ 2. context.build(task)            组装系统提示 + 项目上下文
  ├─ 3. planner.plan(task, ctx)        产出步骤计划
  ├─ 4. loop (iteration < maxIterations)
  │     ├─ llm.chat(messages)          模型决定下一步（工具调用或最终回答）
  │     ├─ 无工具调用 -> 跳出循环
  │     ├─ security.check(call)        deny -> 观察错误；ask -> 人工确认
  │     ├─ tools.dispatch(call)        zod 校验 -> 执行 -> 规范化结果
  │     ├─ context.append(observation) 超预算则截断/压缩
  │     └─ 记录 trace / token / 耗时
  ├─ 5. evaluator.verify(plan, results)
  │     ├─ pass -> 任务 completed
  │     └─ fail -> runRepair() 回到 5（受修复轮数上限约束）
  └─ 6. TaskStore 记录终态与 diff + 输出报告
```

阶段 3 已落地其中的最小子集：`llm.chat` 决策 → `security` 路径检查 → `tools.dispatch` →
观察结果回填，循环到最终回答。阶段 4 补齐结束判定（空答案/截断）与循环熔断（重复调用、
连续失败），并验证多步任务。阶段 5 接入 `context`：启动时扫描 workspace 注入项目概览，
每次请求前按 token 预算整组裁剪历史并截短工具输出。阶段 6 接入 `planner`：先产出并校验 Plan，
人工确认后由 `PlanRunner` 为每一步启动独立循环；`tools` 增加写文件与命令执行，`security`
提供审批抽象与命令风险分级。阶段 7 接入 `memory` 与 `evaluator`：任务生命周期持久化、验证
命令执行、git 差异与验证失败后的有界修复，`--resume` 从已完成步骤前缀继续。阶段 8 完成
离线端到端、异常与权限测试，优化提示词与上下文裁剪，并把版本推进到 V1.0；核心循环骨架不变。

### 2.4 目录结构

```
src/
├─ index.ts          库入口（导出公共类型与工厂）
├─ cli/              main.ts + commands/(run, chat, tasks, serve) + run-events.ts
├─ web/              server.ts + session.ts + public/(index.html, app.js, style.css)
├─ config/           schema.ts + load.ts
├─ logger/           index.ts + redact.ts
├─ shared/           errors.ts + types.ts + plan.ts + reports.ts + abort.ts + agent-stop.ts
│                    + atomic-write.ts + shell.ts + token-usage.ts + ignore-patterns.ts
├─ agent/            loop.ts + plan-runner.ts + repair.ts + task-runner.ts + state.ts
├─ llm/              types.ts + errors.ts + retry.ts + factory.ts + providers/(mock, openai-compatible)
├─ planner/          types.ts + prompt.ts + parse.ts + planner.ts
├─ tools/            registry.ts + dispatch.ts + glob.ts + definitions/
├─ context/          manager.ts + repo-map.ts + token-budget.ts
├─ memory/           types.ts + state.ts + schema.ts + sqlite-store.ts + index.ts
├─ security/         path-guard.ts + approval.ts + command-risk.ts + sensitive-files.ts
│                    + child-env.ts + ignore.ts + walk.ts
└─ evaluator/        types.ts + verify.ts + diff.ts + index.ts
tests/
├─ unit/             按模块分子目录
└─ integration/      helpers + 进程级冒烟 + 生命周期/异常/权限矩阵 + 真实端点 opt-in
scripts/
└─ verify.js         离线验收演示（门禁、REPL、规划改码、任务可靠性）
```

## 三、开发路线图

| 阶段 | 主题            | 交付物                                                                                | 关键验收                                       |
| ---- | --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | 项目初始化      | TS 骨架、config、logger、CLI、lint/format/test 工具链                                 | `agent run` 可启动，四类检查全绿               |
| 2    | LLM 抽象层      | LLMProvider 接口 + mock provider + OpenAI 兼容 provider、流式、重试、超时、chat REPL  | mock 下可复现对话；真实 provider 可流式返回    |
| 3    | 安全与工具框架  | PathGuard、敏感文件排除、ToolRegistry、zod 校验、三只读工具、AgentLoop、run 工具循环  | 模型自主调工具；越界路径/密钥读取被拒          |
| 4    | Agent Core 加固 | 结束判定、重复调用与连续失败熔断、多步任务测试、CLI 停止原因映射                      | 多步任务自主完成；异常有明确停止原因           |
| 5    | 代码库理解      | 目录扫描、文件/代码检索、忽略规则、项目概览注入、ContextManager、token 预算与裁剪     | 概览可注入；超预算不崩溃且保留最新信息         |
| 6    | 规划与核心循环  | Planner + AgentLoop，端到端打通                                                       | mock LLM 驱动完成一个真实改码任务              |
| 7    | Memory 与验证   | TaskStore（sql.js）、状态机、验证执行、git 差异、自动修复、`--resume`/`tasks`         | 任务可验证；步骤失败可恢复；验证失败可修复     |
| 8    | 集成测试与完善  | 离线 E2E、异常/权限矩阵、Prompt/上下文优化、文档、版本 1.0.0                          | 全链路离线通过；门禁全绿；V1.0 文档一致        |
| 9    | Web 操作界面    | `serve` 命令、`src/web/`（HTTP + SSE + RunSession）、前端单页、测试与文档、版本 1.1.0 | 浏览器完成发任务/实时观察/决策/中止/任务查询   |
| 9.2  | 可诊断与防挂起  | 验证输出可见、确认超时、静态改动跳过默认验证、失败文案区分、版本 1.2.0                | 失败可定位；确认不再无限挂起；静态改动不跑全量 |

阶段 9（CLI 体验与总验收）已并入阶段 8：REPL 与流式输出在阶段 2 提前落地，交互确认在阶段
6/7 落地，token 用量汇总已包含在 `run` 输出中，端到端验收由阶段 8 的离线矩阵与可选手工真实
端点回归承担。原阶段 8 的“聊天会话持久化 / 跨会话恢复”明确顺延到 V1.0 之后。

阶段 9 按需求实现 **本地 Web 网页操作界面（V1.1）**，范围收敛为最小可用：发任务、实时看
步骤/工具/验证、Plan 与高风险确认、中止、任务列表与详情。设计要点：

- `runCommand` 事件化：新增 `RunEventSink`（`src/cli/run-events.ts`，因分层约束放在 cli 下）
  与 `RunOptions.config` 注入（宿主跳过 `.env` 解析）+ 外部 AbortSignal；CLI 不传 sink 行为不变。
- `web` 与 `cli` 平级：`RunSession` 包装 runCommand——状态机（idle/running/awaiting_plan/
  awaiting_confirm/finished）、事件缓冲（上限 5000 溢出计数）、单任务互斥（409）、
  挂起决策的批准/拒绝、中止（含解除挂起决策）、只读任务查询（每次新开只读 sql.js store）。
- HTTP 服务：全部 `/api/*` 强制 token（启动时生成 128 位随机值）；Host 白名单防 DNS rebinding；
  静态文件名白名单防穿越；请求体 ≤1MB；SSE 推送快照 + 增量（载荷为事件数据本身）+ 15s 心跳。
- 前端为原生单页（无框架）：fetch + ReadableStream 解析 SSE（EventSource 无法带自定义头），
  断线 2s 重连并回放快照。
- 明确不做：日志全文流、diff 全文、resume 按钮、会话历史回放、WebSocket、多用户与 HTTPS。

阶段 9.1 只改前端（`src/web/public/` 三文件）：左侧 300px 任务历史（标题两行截断、手风琴
懒加载详情）、右侧双气泡对话流（用户任务靠右，Agent 事件按 kind 着色）、底部操作台；后端
API 与 SSE 协议零变更。

阶段 9.2 聚焦**可诊断与防挂起**：验证输出尾部落库并在 `tasks show` / Web / 日志中可见；
高风险确认增加 `AGENT_CONFIRM_TIMEOUT_MS` 上限（超时按拒绝处理，CLI 与 Web 一致）；
`AGENT_VERIFY_SKIP_STATIC` 让默认 `pnpm test` 在改动仅含静态资源（或无可检测改动）时跳过，
显式指定的命令始终执行；Web 任务结束文案区分“步骤完成但验证失败”与普通失败。

阶段 1 只交付基础设施，`run` 命令为骨架（不调用模型、不执行工具），避免提前扩大范围。

阶段 2 按需求交付「能够持续对话的 CLI」，因此 REPL 与流式输出提前在此落地；历史仅存内存，
聊天会话持久化顺延到 V1.0 之后。

阶段 3 已交付工具调用闭环：`read_file` / `list_files` / `search_code` 三个只读工具、最小 AgentLoop、
`run` 升级为真正的任务入口。`chat` REPL 工具化未纳入 V1.0，当前仍只做纯对话。

阶段 4 按用户要求重新定义为 **Agent Core 加固**（而非原路线图的写工具）：结束判定、
重复调用/连续失败熔断、多步任务验证。原路线图的写工具与命令执行（write/edit/bash +
PermissionGate）顺延，插入在阶段 4 之后实施；阶段 5-9 的编号与主题保持不变。

阶段 5 按需求实现 **代码库理解**：根 `.gitignore` 简化解析与默认忽略、`find_files`、
`search_code` 上下文行、项目概览自动注入、启发式 token 预算与历史裁剪。`walk.ts` 从
`tools/` 迁移到 `security/`，使 `context` 能在不依赖上层模块的前提下复用遍历与忽略逻辑。
`ContextManager` 采用“整组丢弃 + 工具输出截短”而非模型摘要压缩，先保证协议正确与可预测性。

阶段 6 按需求实现 **Planning 与执行**：Planner 产出单个 JSON Plan，zod + 语义校验（步数、ID、
路径、敏感文件），失败自动修复一次；`run` 默认规划优先，`--yes` 跳过计划确认、`--plan-only`
只输出计划、`--no-plan` 保留直接循环；新增 `write_file` / `edit_file` / `run_command`；
`PlanRunner` 为每步启动独立 AgentLoop，失败即停止。审批与 Plan 确认分离：`--yes` 不放宽工具级
高风险确认，`git push` 与灾难性命令硬拒绝。写路径对最近存在祖先做 realpath 校验，防止符号链接
目录逃逸。

阶段 7 引入任务生命周期：`TaskStore` 持久化计划、步骤结果、验证、差异与修复轮次；
`runTask` 负责状态迁移、步骤落库、验证判定与最多 N 轮修复，`runRepair` 复用同一套工具、
审批与熔断规则；`runPlan` 接受与计划逐项匹配的已完成前缀，恢复时跳过这些步骤。
恢复以步骤为最小单位，已中断的 `running` 步骤可重置重跑；workspace 与任务记录不一致时拒绝执行。
CLI 提供 `--resume <taskId>`、`--verify <command>` 与 `--no-verify`，并新增只读的
`tasks list` / `tasks show <taskId>`；`--no-plan` 保持轻量直连模式，不创建任务库。
规划模式默认把任务落库并打印任务 ID，验证通过打印 `task completed`，步骤失败或验证失败打印
恢复提示并分别以 `AgentIncomplete` / `VerificationFailed` 退出。

阶段 8 按需求交付 **Coding Agent V1.0（Release）**：抽取 E2E 辅助并把任务生命周期、LLM 异常、
存储损坏/锁冲突、SIGINT、非 git 差异与权限边界做成真实 CLI 子进程测试；提示词按角色、安全、
工作流、工具策略与完成条件结构化，并用不变量测试锁定；上下文增加工具输出头尾保留截断、
仓库地图顶层摘要、极小预算移除概览与 `context trimmed` 可见性；文档补齐 README、
`docs/testing.md`、CHANGELOG 与阶段 7/8 验收；版本升级为 `1.0.0`。V1.0 仍不包含聊天会话
持久化、自动 replan、多 Agent 与 OS 级沙箱。

## 四、技术选型

### 四.1 环境实测结论（2026-11-12 实测）

当前机器：Node **v20.18.1**（nvm 已装 20.18.1 / 18.20.4 / 18.15.0 / 16.15.1，**无 22+**），npm 11.11.1，pnpm 8.6.0，git 2.40.1。

registry 实测的版本与引擎约束：

| 包                | 最新版  | Node 要求                        | 能否跑在 20.18.1         |
| ----------------- | ------- | -------------------------------- | ------------------------ |
| typescript        | 7.0.2   | —                                | 可装，但见下方 lint 冲突 |
| typescript-eslint | 8.72.2  | peer `typescript >=4.8.4 <6.1.0` | **不支持 TS 7**          |
| eslint            | 10.14.0 | `^20.19 \|\| ^22.13 \|\| >=24`   | 否（差一个 patch）       |
| eslint            | 9.39.5  | `^18.18 \|\| ^20.9 \|\| >=21.1`  | **是**                   |
| vitest            | 5.1.0   | `^22.12 \|\| ^24 \|\| >=26`      | 否                       |
| vitest            | 3.2.7   | `^18 \|\| ^20 \|\| >=22`         | **是**（配 vite 6.4.6）  |
| commander         | 15.1.0  | `>=22.12`                        | 否                       |
| commander         | 14.0.3  | `>=20`                           | **是**                   |
| prettier          | 3.10.0  | `>=14`                           | 是                       |
| tsx               | 4.23.15 | `>=18`                           | 是                       |
| dotenv            | 18.0.10 | `>=12`                           | 是                       |
| zod               | 4.6.7   | —                                | 是                       |
| pino              | 10.4.0  | 无 engines 限制                  | 是                       |

两个关键冲突：

1. **TS 7 与 typescript-eslint 不兼容**（peer 上限 <6.1.0），即使升级 Node 也解决不了；要 type-aware lint 就得用 TS 5.9.3，或改用 oxlint 放弃 type-aware 规则。
2. **Vitest 5 / ESLint 10 / commander 15 都要 Node ≥22**，当前 Node 20.18.1 全部跑不了。

### 四.2 方案 A（已采纳：零环境改动，锁版本）

保持 Node 20.18.1，全部选用兼容版本：

- 语言/构建：TypeScript **5.9.3**，`tsc` 编译到 `dist/`，开发用 **tsx 4.23.15**
- 模块制：ESM + `module/moduleResolution: nodenext`（源码内相对 import 必须带 `.js` 后缀）
- CLI：**commander 14.0.3**
- 校验：**zod 4.6.7**（工具参数 schema + 自动生成 JSON Schema）
- 环境变量：**dotenv 18.0.10**
- 日志：**pino 10.4.0** + pino-pretty（安装时校验引擎兼容）
- 测试：**vitest 3.2.7** + **vite 6.4.6**（显式锁 vite，避免被解析到 7.x 触发 Node 20.19 门槛）
- Lint：**eslint 9.39.5** flat config + **typescript-eslint 8.72.2**
- 格式化：**prettier 3.10.0**
- 包管理：**pnpm 8.6.0**（现有 lockfile 即 pnpm 格式）

优点：立刻可开工、工具链稳定、type-aware lint 可用。
代价：版本比最新落后一个大版本，后续升级 Node 时需同步升工具链。

### 四.3 方案 B（未采纳，留作后续升级路径）

`nvm install 22`（需联网下载 + Windows 下 `nvm use` 可能要管理员权限），随后可用 Vitest 5 / ESLint 10 / commander 15。
但 TS 7 仍与 typescript-eslint 冲突，需二选一：TS 5.9.3 保留 type-aware lint，或 TS 7 + oxlint。

### 四.4 其他选型理由

- **手写 AgentLoop 而非用框架**：目标是理解原理，框架会屏蔽循环、上下文、工具调度等关键细节。
- **任务库用 sql.js（SQLite WASM），不引入 native 模块**：Node 20.18.1 无 `node:sqlite`，
  `better-sqlite3` 等 native 模块在 Windows 上有预编译/构建失败风险；sql.js 便于离线安装与
  测试。代价是每次写事务导出整个数据库文件，因此只存元数据与截断输出，并采用原子替换。
  聊天会话持久化（原路线图阶段 8）顺延到 V1.0 之后。
- **provider 抽象优先 mock**：保证无网络、无密钥也能跑完整循环测试（NFR3）。
- **真实 provider 只做 OpenAI 兼容一家**：`openai` SDK + 可配 `baseURL`，一套实现覆盖 OpenAI / DeepSeek / Kimi / 通义 / Ollama 本地，换供应商只改 `.env`。Anthropic 适配不在当前范围，接口预留扩展位但不提前实现。
- **zod 作为单一 schema 源**：同一份定义既做运行时校验又导出 JSON Schema 给模型，避免两处维护。

## 五、测试与验收策略

### 5.1 分层

| 层       | 范围                                                                   | 工具                                    | 是否依赖网络 |
| -------- | ---------------------------------------------------------------------- | --------------------------------------- | ------------ |
| 单元     | config/logger/llm/security/tools/planner/memory/evaluator/agent 纯逻辑 | vitest                                  | 否           |
| 集成     | 模块协作、mock LLM 驱动的完整循环                                      | vitest + mock provider                  | 否           |
| 进程级   | 真实 CLI 子进程：任务生命周期、异常、权限、退出码、任务库与文件副作用  | vitest + child_process + 临时 workspace | 否           |
| 真实端点 | 真实供应商协议、流式与错误分类（手工 opt-in）                          | vitest + `ZHIPU_LIVE_TEST=1`            | 是（手工）   |

### 5.2 每阶段统一验收门（AGENTS.md 第六节）

```
pnpm typecheck      # tsc --noEmit，0 error
pnpm lint           # eslint（type-checked），0 error
pnpm format:check   # prettier 校验
pnpm test           # vitest run，全绿
pnpm test:coverage  # 覆盖率阈值
pnpm build          # 产物可执行
pnpm verify         # 门禁 + 全量测试 + 离线演示
git diff            # 人工复核变更
```

禁止把未执行的测试描述为已通过；每次交付附真实命令输出。

### 5.3 安全验收用例（阶段 3 起强制）

- 越界路径：`../../etc/passwd`、绝对路径指向 workspace 外、符号链接逃逸 -> 必须拒绝
- 写路径：目标不存在但父级符号链接指向外部、`.git/`、敏感文件名 -> 必须拒绝
- 密钥文件：`.env`、`id_rsa`、`*.pem`、`.aws/credentials` -> 必须拒绝读取
- 覆盖：目标非空且未确认 -> 拒绝并保持原内容
- 高风险命令：`rm -rf`、`git clean -f`、`curl | sh`、重定向覆盖 -> 必须人工确认；非 TTY 拒绝
- 硬拒绝：`git push`、`sudo`、`shutdown`、`diskpart`、根目录删除 -> 不提供绕过
- 子进程环境：密钥类变量被删除，命令输出与日志不包含密钥
- 日志脱敏：任何含 apiKey/token 的对象写入日志后不得出现明文

## 六、风险登记

| 编号 | 风险                                   | 影响                            | 应对                                                              |
| ---- | -------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| R1   | 现有 node_modules 为空壳且自指符号链接 | 依赖全部无法解析，项目无法启动  | 阶段 1 第一步清理重装（需授权）                                   |
| R2   | Node 20.18.1 与最新工具链不兼容        | 装得上但跑不起来                | 方案 A 锁版本 / 方案 B 升级 Node                                  |
| R3   | TS 7 与 typescript-eslint 冲突         | lint 直接报 peer 错误           | 选 TS 5.9.3                                                       |
| R4   | 无 git 仓库                            | 无法满足 AGENTS.md 的 diff 检查 | 阶段 1 git init（需授权）                                         |
| R5   | Windows 路径与符号链接                 | 沙箱绕过风险                    | PathGuard 用 realpath + 前缀校验，阶段 3 专项测试                 |
| R6   | .env 密钥泄露                          | 安全事故                        | .gitignore + 日志 redact + .env.example 只放占位                  |
| R7   | native 依赖构建失败                    | 阻塞进度                        | 阶段 1-7 不引入 native 模块                                       |
| R8   | 模型输出不稳定导致测试不可复现         | CI 抖动                         | 单测/集成一律用 mock provider，真实调用只在 V1.0 手工 opt-in 回归 |
