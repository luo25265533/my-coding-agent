# 阶段 6 开发 Plan：Planning 与执行

> 状态：已完成（2026-11-16）
> 日期：2026-11-16
> 范围：任务规划 / Plan 校验 / 用户确认 / write_file / edit_file / run_command / 逐步执行
> 交付：能够根据计划修改代码的 Agent

## 一、现状分析

| 需求          | 现状                                                    | 阶段 6 增量                                             |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| 生成任务 Plan | 无 `planner` 实现，`run` 直接进入工具循环               | `Planner` 调用模型产出结构化 JSON Plan                  |
| 校验 Plan     | 无                                                      | zod 结构校验 + 语义校验（步数、ID、路径、敏感文件）     |
| 用户确认      | 仅 `AGENT_CONFIRM_HIGH_RISK` 配置存在，尚无任何工具使用 | `run` 打印 Plan 并请求确认；高风险动作二次确认          |
| 写文件        | 只有只读工具                                            | `write_file`（新建/覆盖）与 `edit_file`（唯一匹配替换） |
| 执行命令      | 无                                                      | `run_command`：cwd 沙箱、超时、输出上限、风险分级       |
| 逐步执行      | `runAgentLoop` 单次循环完成整个任务                     | `PlanRunner` 按步骤串行执行，每步一个工具循环           |

**结论**：阶段 6 在只读能力之上引入「先计划、后执行」的受控写操作链路。计划与高风险动作
都需要人工确认；`git push` 与明确灾难性命令硬拒绝，不提供自动执行路径。

## 二、已确认决策（用户确认）

| 决策       | 选择                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| CLI 入口   | **`run` 默认先规划**：生成并校验 Plan → 打印 → 确认 → 逐步执行；`--yes` 跳过计划确认，`--plan-only` 只输出计划 |
| 执行粒度   | **每步独立 AgentLoop**：完整 Plan + 当前步骤作为子任务，模型自主选工具；步骤结束后进入下一步                   |
| 审批策略   | **分级 + 非交互拒绝**：覆盖已有文件、高风险命令交互式 y/N；无 TTY 时高风险拒绝；`git push` 硬拒绝              |
| 写工具语义 | **覆盖需确认**：`write_file` 新建直接写、覆盖已有文件需确认；`edit_file` 唯一匹配替换，不唯一/未命中报错       |

补充说明：为保留简单任务与既有调试路径，增加 `--no-plan` 显式退回当前直接循环模式；
默认行为仍是规划优先。

## 三、范围

### 3.1 本次做（IN）

1. `planner` 模块：Plan 类型、生成提示词、JSON 解析与校验、一次自动修复、token 统计
2. Plan 语义校验：步数上限、ID 唯一、标题/描述长度、文件路径必须在 workspace 内且非敏感
3. `run` 编排：规划 → 打印 → 确认（拒绝则退出 0）→ 逐步执行 → 汇总
4. `PlanRunner`：串行执行步骤，每步独立上下文与工具循环；失败即停止并报告步骤
5. `write_file`：新建/覆盖、父目录创建、大小上限、覆盖确认、原子化写入
6. `edit_file`：唯一字符串替换、`replaceAll`、未命中/歧义错误、二进制与大小限制
7. `run_command`：cwd 沙箱、超时、输出截断、环境变量净化、风险分级、进程树终止
8. 审批抽象：`ConfirmFn` 注入 `ToolContext`；CLI 交互实现；测试可注入 allow/deny
9. 路径安全补强：写入时校验最近已存在祖先的 realpath，防止符号链接目录逃逸
10. 新增配置：`AGENT_PLAN_MAX_STEPS`、`AGENT_STEP_MAX_ITERATIONS`、`AGENT_COMMAND_TIMEOUT_MS`
11. 单元 + 集成测试、文档、验收报告

### 3.2 本次不做（OUT）

- evaluator / 自动验证与重规划（阶段 7）
- memory / 会话持久化（阶段 8）
- 多 Agent、并行步骤、依赖图调度
- `bash` 交互式会话、后台进程管理
- OS 级沙箱（容器、chroot、Windows Job Object）
- git 自动提交 / 自动 push（永久禁止自动 push）
- 网络命令白名单、包安装审批策略细化
- 跨平台命令语义统一（以 shell 原生命令为准）

## 四、技术设计

### 4.1 Plan 数据模型（`src/planner/types.ts`）

```ts
export interface PlanStep {
  readonly id: string; // 1-32 字符，计划内唯一
  readonly title: string; // 1-120
  readonly description: string; // 1-2000，可执行的具体动作
  readonly files: readonly string[]; // 0-20，相对 workspace 的路径
}

export interface TaskPlan {
  readonly goal: string; // 1-500
  readonly steps: readonly PlanStep[]; // 1-AGENT_PLAN_MAX_STEPS
  readonly notes: string | undefined; // 可选风险/假设说明
}
```

模型输出约定为**单个 JSON 对象**，不含 Markdown 代码块、不含工具调用。解析器仍容忍
```json 围栏与前后说明文字，提取首个 `{` 到最后一个 `}`。

### 4.2 Plan 生成与校验（`src/planner/`）

```ts
export interface PlanResult {
  readonly plan: TaskPlan;
  readonly usage: TokenUsage;
  readonly attempts: number;
  readonly repoMapTokens: number;
}

export interface Planner {
  plan(task: string): Promise<PlanResult>;
}

export function createPlanner(options: {
  provider: LLMProvider;
  workspace: string;
  ignore: IgnoreMatcher;
  contextBudgetTokens: number;
  maxSteps: number;
  signal?: AbortSignal;
  logger?: Logger;
}): Planner;
```

流程：

1. 用 `buildRepoMap` 生成计划上下文，预算取 `AGENT_CONTEXT_BUDGET_TOKENS` 的 25%
   （下限 400，上限 2000）；概览已排除敏感文件与忽略目录
2. 调用 `provider.chat`，system 为计划提示词 + 项目概览，user 为任务；不传 tools
3. 解析 → zod 校验 → 语义校验；失败则携带错误信息自动修复一次
4. 两次仍失败：抛 `AgentError(PlannerInvalid)`（退出码 1），不执行任何写操作

语义校验：

- `steps` 数量 1..`AGENT_PLAN_MAX_STEPS`；`id` 非空且唯一
- 文件路径必须通过 `resolveInsideWorkspace`（拒绝绝对路径、`..` 逃逸、符号链接逃逸）
- 文件路径不得命中敏感文件名；不得指向 `.git/`
- Plan JSON 原文不超过 20 KB，避免异常大响应

### 4.3 审批抽象（`src/security/approval.ts`）

```ts
export interface ConfirmRequest {
  readonly kind: 'overwrite_file' | 'run_command';
  readonly risk: 'high';
  readonly summary: string; // 一行人类可读摘要
  readonly detail?: string | undefined; // 覆盖路径 / 命令预览（已截断）
}

export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;
```

- `ToolContext` 新增 `confirm?: ConfirmFn`
- 未注入 `confirm`、返回 false 或抛错，一律视为拒绝，工具返回 `TOOL_DENIED`
- CLI 实现：
  - `AGENT_CONFIRM_HIGH_RISK=false` 时直接允许（但硬拒绝规则仍生效）
  - stdin 非 TTY 时不提示，直接拒绝，并打印 `high-risk action denied (non-interactive)`
  - TTY 下显示摘要，读取 `y/N`，默认 N
- Plan 确认与工具确认分开：`--yes` 只跳过 Plan 确认，不跳过工具高风险确认

### 4.4 写工具

**`write_file`**（`src/tools/definitions/write-file.ts`）

| 参数      | 约束       | 说明                 |
| --------- | ---------- | -------------------- |
| `path`    | 1-512 字符 | workspace 内相对路径 |
| `content` | 0-256 KB   | 完整文件内容         |

- 路径先经 `resolveForWrite`（4.5），敏感文件与 `.git/` 拒绝
- 父目录不存在时递归创建
- 目标已存在且非空：调用 `confirm({kind:'overwrite_file'})`；拒绝则 `TOOL_DENIED`
- 写入临时文件后 `rename`，避免中途失败留下半截文件
- 返回 `wrote <path> (<n> bytes)`；meta 含 `created` / `overwritten`

**`edit_file`**（`src/tools/definitions/edit-file.ts`）

| 参数         | 约束             | 说明                            |
| ------------ | ---------------- | ------------------------------- |
| `path`       | 1-512 字符       | 已存在的文本文件                |
| `old_string` | 1-20 KB          | 必须唯一匹配（除非 replaceAll） |
| `new_string` | 0-256 KB         | 允许为空（删除片段）            |
| `replaceAll` | 布尔，默认 false | true 时替换全部匹配             |

- 文件不存在、二进制、>1 MB 一律报错
- 匹配 0 次：`old_string not found`
- 匹配多次且 `replaceAll=false`：返回匹配次数，提示提供更多上下文
- 写入沿用与 `write_file` 相同的路径、大小与原子写规则；不额外确认（Plan 已确认）

### 4.5 路径安全补强（`src/security/path-guard.ts`）

现有 `resolveInsideWorkspace` 在目标**不存在**时不会检查父级符号链接。新增：

```ts
export function resolveForWrite(workspace: string, input: string): string;
```

- 解析绝对路径并做前缀检查
- 从目标向上找到**最近存在的祖先**，对其 `realpath` 后再校验是否仍在真实 workspace 内
- 目标本身存在时仍按现规则复核
- 拒绝 `.git` 目录内的任何写入

### 4.6 `run_command` 与风险分级（`src/security/command-risk.ts`）

```ts
export type CommandVerdict =
  | { readonly level: 'deny'; readonly reason: string }
  | { readonly level: 'high'; readonly reason: string }
  | { readonly level: 'normal' };

export function classifyCommand(command: string): CommandVerdict;
```

- **deny（硬拒绝，不询问）**：`git push`、`sudo`、`shutdown`、`format`、`diskpart`、
  `rm -rf /` 等灾难性模式；AGENTS.md 明确禁止自动 push
- **high（需确认）**：删除类（`rm -rf`、`del /f /s /q`）、`git reset --hard`、
  `git clean -f`、`git checkout -- .`、包发布、`curl|sh`、`chmod/chown`、`kill/taskkill`、
  引用 `.env` / `id_rsa` / `*.pem` / `.npmrc` / `credentials` 的命令
- **normal**：其余（构建、测试、查看状态等）
- 命令长度 1..1000，拒绝 NUL；`cwd` 必须位于 workspace 内

执行细节：

- `spawn(command, { shell: true, cwd, env: sanitizedEnv, windowsHide: true })`
- 环境变量净化：删除名称匹配 `/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` 的变量
  （含 `LLM_API_KEY`），避免子进程通过 `env` 读取密钥
- 默认超时 `AGENT_COMMAND_TIMEOUT_MS=30000`，超时后终止整棵进程树
  （Windows 用 `taskkill /T /F`，其他平台 `SIGKILL`）
- 输出合并 stdout/stderr，超过 12000 字符时保留头 8000 + 尾 4000，中间标记截断
- 退出码非 0 返回 `ok:false` 且内容含 exit code；超时/启动失败返回 `TOOL_FAILED`
- 中止信号触发时终止子进程并抛 `LlmAborted`
- 日志只记录命令长度、cwd、退出码、耗时，不记录完整命令与输出

### 4.7 PlanRunner（`src/agent/plan-runner.ts`）

```ts
export interface StepResult {
  readonly step: PlanStep;
  readonly status: 'completed' | 'failed';
  readonly answer: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: AgentStopReason;
}

export interface PlanRunResult {
  readonly steps: readonly StepResult[];
  readonly usage: TokenUsage;
  readonly completed: boolean;
}

export async function runPlan(
  plan: TaskPlan,
  options: {
    provider: LLMProvider;
    tools: ToolRegistry;
    workspace: string;
    ignore: IgnoreMatcher;
    contextBudgetTokens: number;
    maxIterationsPerStep: number;
    maxRepeatedCalls: number;
    maxConsecutiveFailures: number;
    signal: AbortSignal;
    logger?: Logger;
    confirm?: ConfirmFn;
    onStepStart?: (step: PlanStep, index: number, total: number) => void;
    onStepEnd?: (result: StepResult, index: number, total: number) => void;
  },
): Promise<PlanRunResult>;
```

- 构造一次 `ContextManager`，system = `AGENT_SYSTEM_PROMPT` + 完整 Plan + 当前步骤约束；
  `ContextManager` 增加「仓库地图按任务无关缓存」，避免每步重复扫描
- 每步 `runAgentLoop(stepTask, { context, maxIterations: maxIterationsPerStep, ... })`
- 步骤任务文本：`Step i/n: title` + description + 相关文件
- `stopReason !== 'answer'` 视为该步失败，停止后续步骤并返回 `completed=false`
- 汇总每步 usage、iterations、toolCalls

### 4.8 AgentLoop 调整

- `AgentLoopOptions` 新增 `confirm?: ConfirmFn | undefined`，透传到 `ToolContext`
- 其余循环、熔断、结束判定保持不变

### 4.9 CLI（`src/cli/commands/run.ts`、`src/cli/main.ts`）

新增参数：

| 参数          | 说明                                           |
| ------------- | ---------------------------------------------- |
| `--yes`       | 跳过 Plan 确认（不跳过工具高风险确认）         |
| `--plan-only` | 只生成并打印 Plan，不执行，退出 0              |
| `--no-plan`   | 退回阶段 5 的直接循环模式（兼容简单任务/调试） |

默认流程：

1. 启动横幅（workspace / provider / context 预算，保持阶段 5 格式）
2. `plan:` 区块打印目标与编号步骤（含文件列表）
3. `--plan-only`：结束，退出 0
4. 非 `--yes`：提示 `Execute this plan? [y/N]`；拒绝则打印 `plan declined; nothing executed`，退出 0
5. 逐步执行：打印 `step 1/3 → ...`、`step 1/3 ← completed`；每步内部工具轨迹沿用 `[i] → tool`
6. 汇总：`plan completed  steps=3  tools=5  tokens=...`；任一步失败打印步骤与停止原因，退出 1
7. `--no-plan`：完全沿用当前 `runAgentLoop` 行为

`RunResult` 扩展 `plan`、`steps`，`stopReason` 增加 `plan_declined`；原有字段保持。
日志新增：`plan generated`、`plan confirmed`、`plan declined`、`step started`、`step finished`。

### 4.10 配置（`src/config/schema.ts`、`load.ts`）

| 变量                        | 默认  | 范围        | 说明                   |
| --------------------------- | ----- | ----------- | ---------------------- |
| `AGENT_PLAN_MAX_STEPS`      | 12    | 1-50        | Plan 最大步骤数        |
| `AGENT_STEP_MAX_ITERATIONS` | 10    | 1-100       | 每个步骤的工具循环上限 |
| `AGENT_COMMAND_TIMEOUT_MS`  | 30000 | 1000-600000 | `run_command` 默认超时 |

`AppConfig.agent` 新增 `planMaxSteps`、`stepMaxIterations`、`commandTimeoutMs`。
`AGENT_CONFIRM_HIGH_RISK` 复用现有字段。

### 4.11 错误码

新增 `PlannerInvalid: 'PLANNER_INVALID'`，退出码 1。工具层业务失败继续以
`TOOL_DENIED` / `TOOL_INVALID_ARGS` / `TOOL_FAILED` 回传模型，不中断步骤循环。

## 五、任务分解

| #   | 任务                                                                | 依赖       |
| --- | ------------------------------------------------------------------- | ---------- |
| P1  | Plan 类型、提示词、解析与语义校验、错误码                           | —          |
| P2  | Planner 工厂 + 仓库概览 + 自动修复 + 配置                           | P1         |
| P3  | 审批抽象、路径写入补强、命令风险分级                                | —          |
| P4  | `write_file` + `edit_file` + 注册 + 单元测试                        | P3         |
| P5  | `run_command` + 环境净化 + 超时/输出上限 + 单元测试                 | P3         |
| P6  | PlanRunner + AgentLoop `confirm` 透传 + 单元测试                    | P2, P4, P5 |
| P7  | CLI 规划流程、`--yes/--plan-only/--no-plan`、既有测试迁移、集成测试 | P6         |
| P8  | 文档更新、覆盖率、`pnpm verify`、git diff、开发报告                 | P7         |

## 六、测试计划（必须真实执行）

- **Plan 解析**：纯 JSON、代码围栏、前后说明文字；非法 JSON、超长、步数为 0、超过上限、
  重复 ID、标题/描述越界
- **Plan 语义**：绝对路径、`..` 逃逸、符号链接逃逸、敏感文件路径、`.git/` 路径全部拒绝
- **Planner**：mock 首次合法；首次非法 → 修复成功（两次调用）；两次非法 → `PLANNER_INVALID`；
  usage 累加；无项目概览时仍可生成
- **审批**：allow / deny / 未注入 / confirm 抛错；非 TTY 高风险拒绝
- **路径补强**：目标不存在但父级符号链接指向外部时拒绝（Windows 无权限建链接则跳过）
- **write_file**：新建、递归建目录、覆盖需确认（允许/拒绝）、敏感文件拒绝、`.git` 拒绝、
  越界拒绝、超 256 KB 拒绝、空内容
- **edit_file**：唯一替换、`replaceAll`、未命中、多处歧义、二进制、不存在、越界
- **run_command**：exit 0、非 0、超时、`cwd` 越界、输出截断、`git push` 硬拒绝、
  删除类需确认、确认拒绝、环境变量净化（密钥不进入子进程）、中止终止子进程
- **PlanRunner**：两步完成、步骤失败即停止、每步独立上下文、usage/iterations 汇总、
  每步迭代上限生效
- **CLI 单元**：`--plan-only` 不执行工具；`--yes` 执行；拒绝 Plan 退出 0 且无写操作；
  `--no-plan` 保持旧行为；步骤失败退出 1
- **集成（离线 mock）**：规划 JSON → `write_file` → `read_file` 验证 → 回答；
  `run_command` 执行测试命令；`--plan-only`；拒绝确认；高风险命令非交互拒绝；
  密钥不出现在 stdout/stderr/日志与子进程环境
- **回归**：阶段 1-5 全部用例通过；`zhipu-live` 默认跳过
- **验收门**：`typecheck` / `lint` / `format:check` / `build` / `test:coverage` 全绿，
  `pnpm verify` 10/10；覆盖率不低于阶段 5 的 96.84%

## 七、安全约束

- 所有读写与命令 cwd 限定在 workspace；写入校验最近存在祖先的 realpath
- 敏感文件与 `.git/` 禁止写入；Plan 中的文件路径同样校验
- `git push` 与灾难性命令硬拒绝，不提供 `--yes` 绕过
- 高风险动作无 TTY 时默认拒绝；`--yes` 仅跳过 Plan 确认
- 子进程环境删除密钥类变量；日志不记录完整命令与输出
- 命令输出截断后才进入上下文；不新增 `sudo`、交互式 shell、后台进程能力
- 不自动 git commit / push；不覆盖 Plan 未确认的文件

## 八、风险与应对

| 风险                       | 说明                                     | 应对                                                         |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `run_command` 无法完全沙箱 | shell 可读取 workspace 内 `.env` 等文件  | 敏感引用命令强制确认；子进程环境净化；文档明确边界与残余风险 |
| 命令风险分级被绕过         | 字符串匹配无法覆盖所有等价写法           | 默认对删除/重置/发布等保守判 high；硬拒绝仅作最后防线        |
| 计划质量不稳定             | 模型可能给出过粗/不可执行步骤            | 提示词约束 + 两次尝试 + 用户确认；失败不写文件               |
| 每步重复扫描仓库           | 多步骤可能重复生成概览                   | ContextManager 缓存仓库地图（与任务无关）                    |
| 覆盖用户未提交修改         | 写工具可能覆盖工作区现有内容             | 覆盖确认 + 原子写 + Plan 展示文件列表                        |
| Windows 进程树终止         | `child.kill` 可能留下孙进程              | Windows 使用 `taskkill /T /F`；其他平台 `SIGKILL`            |
| 既有测试依赖直接循环       | 默认改为规划优先会打破 mock 脚本         | 新增 `--no-plan`；迁移测试脚本，保留直接模式回归用例         |
| 多 system 消息兼容性       | 步骤上下文与裁剪提示可能增加 system 消息 | 离线测试；真实端点留待阶段 9 复核                            |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件，已确认并实施）
- [x] 代码变更
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明
- [x] 完成情况
- [x] 文档更新（architecture.md、README、.env.example）
- [x] git diff 检查
- [x] 开发报告

## 十、验收结果（实施后回填）

**结论：阶段 6 完成。** 离线 mock 驱动下已验证「生成 Plan → 校验 → 确认 → 逐步改码」全链路，
写操作与命令执行均受审批和沙箱约束。

### 10.1 验收门（2026-11-16 真实执行）

| 命令                 | 结果                                                      |
| -------------------- | --------------------------------------------------------- |
| `pnpm typecheck`     | 通过，0 error                                             |
| `pnpm lint`          | 通过，0 error                                             |
| `pnpm format:check`  | 通过                                                      |
| `pnpm build`         | 通过                                                      |
| `pnpm test:coverage` | 33 个文件通过 / 1 跳过；**524 passed / 5 skipped（529）** |
| 覆盖率（All files）  | 语句 **97.03%** / 分支 92.15% / 函数 98.9% / 行 97.03%    |
| `pnpm verify`        | **17/17 通过**（5 项门禁 + 5 项 REPL + 7 项规划改码演示） |

真实端点测试本阶段未执行（默认离线）；如需复核：
`ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts`。

### 10.2 新增测试覆盖

- `tests/unit/planner.test.ts`：JSON/围栏/前后文字解析、长度与数量边界、重复/空 ID、绝对路径、
  `..` 逃逸、符号链接父目录逃逸、敏感文件与 `.git`、修复成功与两次失败。
- `tests/unit/approval-risk.test.ts`：`resolveForWrite` 沙箱、`isApproved` 缺省/拒绝/抛错、
  CLI 确认（禁用、非交互、注入 ask、默认 readline）、命令风险分级表。
- `tests/unit/write-tools.test.ts`：新建/递归目录/空文件、覆盖确认允许与拒绝、敏感文件、
  `.git`、越界、目录目标、UTF-8 字节上限；`edit_file` 唯一匹配、replaceAll、未命中、歧义、
  空替换、二进制、>1 MB、替换后超限；原子写 rename 失败清理临时文件。
- `tests/unit/run-command.test.ts`：退出码、stderr、cwd、非法参数、超时、中止、输出与捕获
  截断、`git push` 硬拒绝、高风险确认允许/拒绝、环境变量净化与子进程不可读密钥。
- `tests/unit/plan-runner.test.ts`：两步完成、失败停止、迭代/用量汇总、上下文复用、
  每步迭代上限、空步骤。
- `tests/unit/run.test.ts`：`--plan-only`、`--yes` 执行 `write_file`、Plan 拒绝、非交互拒绝、
  TTY 确认、Planner 非法、步骤失败、备注打印。
- `tests/integration/run-plan.test.ts`：真实进程下规划改码、覆盖确认拒绝、`git push` 硬拒绝、
  高风险命令非交互拒绝、密钥不进入 stdout/stderr/日志/子进程环境、非法 Plan 与步骤失败退出码。

### 10.3 实施中发现并修正的问题

- `verify.js` 首次加入规划演示时，“--plan-only 未写文件”检查放在 `--yes` 运行之后，导致误报；
  改为在 plan-only 结束后立即取快照，并补回被编辑遗漏的 Lint 门禁。复跑 17/17 通过。
- 覆盖率初次为 96.33%，低于阶段 5 的 96.84%。补充原子写失败清理、`edit_file` 目录/超限、
  命令捕获截断、默认 readline 确认与 TTY Plan 确认用例后达到 97.03%。

### 10.4 残余风险与边界

- `run_command` 不是 OS 级沙箱：shell 仍可读取 workspace 内 `.env` 等文件。当前依靠敏感引用
  判 high + 人工确认 + 子进程环境净化 + 非交互拒绝降低风险；容器/Job Object 不在本阶段范围。
- 命令风险依赖字符串模式，等价写法可能漏判；删除/重置/发布类默认 high，`deny` 仅作最后防线。
- Windows 下 POSIX 进程组终止分支（`process.kill(-pid)`）无法在本机覆盖；已通过平台分支与
  `taskkill /T /F` 实现，留待跨平台环境验证。
- Plan 质量依赖模型；本阶段只保证结构/语义合法与确认关口，不评估计划是否最优（属于阶段 7）。
- 真实供应商未在本阶段回归；使用真实端点前应先确认密钥轮换与配额，避免消耗与泄露风险。
