# 阶段 7 开发 Plan：Memory 与验证（Reliability）

> 状态：已实施（2026-11-16；P7 集成测试与 P8 收尾在阶段 8 完成）
> 日期：2026-11-16
> 范围：SQLite 任务存储 / 任务状态管理 / 失败恢复 / 测试执行 / 代码差异检查 / 自动修复
> 交付：能够验证和恢复任务的 Agent

## 一、现状分析

| 需求         | 现状                                                              | 阶段 7 增量                                              |
| ------------ | ----------------------------------------------------------------- | -------------------------------------------------------- |
| SQLite 存储  | `src/memory/`、`src/evaluator/` 为空占位；`.agent/` 已被 git 忽略 | 新增基于 SQLite 的任务库（任务、步骤、验证、差异、事件） |
| 任务状态管理 | `PlanRunner` 仅在内存中推进，进程退出即丢失                       | 显式状态机 + 每次状态变更落库                            |
| 失败恢复     | 步骤失败后直接退出；无 `--resume`                                 | 保存 Plan 与已完成步骤，从失败步骤继续                   |
| 测试执行     | 只能由模型主动调用 `run_command`，Agent 自身不会验证结果          | 计划完成后执行可配置的验证命令，记录退出码与输出         |
| 差异检查     | 无                                                                | 基于 git 的改动快照、任务前后差异与越界/敏感提示         |
| 自动修复     | 无                                                                | 验证失败后启动受控修复循环，按次数上限重新验证           |
| CLI          | `run` 具备规划/确认/执行；无任务查看入口                          | `--resume`、`--verify/--no-verify`、`tasks list/show`    |

**结论**：阶段 7 把阶段 6 的“一次性执行”升级为“可观测、可验证、可恢复”的任务生命周期。
所有持久化、恢复与自动修复都受既有沙箱、审批和命令分级约束，不新增自动 push 等危险能力。

## 二、已定决策（基于现有约束）

| 决策         | 选择                                                                                                    | 理由                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SQLite 驱动  | **`sql.js` 1.16.0（SQLite WASM）+ `@types/sql.js` 1.4.11**                                              | 当前 Node 20.18.1 无 `node:sqlite`；`better-sqlite3` 最新版要求 Node ≥22 且属 native 模块（架构风险 R7） |
| 持久化方式   | 每次事务后 `db.export()`，临时文件 + rename 原子替换数据库文件                                          | sql.js 是内存数据库；原子替换保证崩溃时保留上一个完整版本                                                |
| 恢复语义     | **从第一个未完成步骤继续**，已完成步骤不复跑；失败步骤从头重跑；全部步骤完成但验证失败时只重跑验证/修复 | 步骤是最小可恢复单位；不保存半截 LLM 会话，避免恢复不可控状态                                            |
| 自动修复触发 | **仅在验证失败后触发**，不因普通步骤失败自动重跑                                                        | 步骤失败通常是计划/模型问题，盲目重跑成本高；验证失败有明确反馈可用于修复                                |
| 自动修复上限 | 每次任务默认 2 轮，`AGENT_MAX_REPAIR_ATTEMPTS=0` 可关闭；每轮独立 AgentLoop，默认 8 次迭代              | 有界重试，防止无限循环与费用失控                                                                         |
| 验证命令     | 默认 `pnpm test`；`AGENT_VERIFY_COMMAND` 或 `--verify` 可覆盖，`--no-verify` 关闭                       | 对 Node 项目开箱即用；非 Node 项目可显式配置                                                             |
| 默认验证跳过 | 仅当命令来自默认值、且 workspace 无 `package.json` 时跳过并打印原因                                     | 避免临时/非 Node 工程被默认命令误判失败；用户显式配置的命令始终执行                                      |
| 差异检查     | git 仓库：任务开始快照 + 结束后快照求差；非 git 仓库：标记不可用并告警，不判失败                        | 尽量只报告本任务造成的改动；不把“没有 git”当成任务失败                                                   |
| 直接模式     | `--no-plan` 保持阶段 5 行为：不建任务、不验证、不落库                                                   | 保留轻量调试路径，避免简单问答触发测试与修复                                                             |
| 任务库位置   | `AGENT_TASK_DB=.agent/tasks.db`（必须位于 workspace 内，且非敏感文件名）                                | 与日志同目录、默认被忽略；越界路径在加载配置时拒绝                                                       |
| 单写者锁     | 写模式持有 `tasks.db.lock`（PID），异常退出后由下一个进程检测并清理陈旧锁                               | 防止同一 workspace 两个 Agent 并发写导致任务库互相覆盖                                                   |

## 三、范围

### 3.1 本次做（IN）

1. `memory` 模块：任务模型、状态机、SQLite schema/migration、`TaskStore` 接口与 sql.js 实现
2. 任务状态机：`planned → running → step_failed/verifying → repairing → completed/failed/aborted`
3. `evaluator` 模块：验证命令执行、结果判定、输出截断与脱敏、git 差异快照与任务增量
4. `agent` 修复循环：验证失败后构造修复任务，复用 `runAgentLoop`
5. `agent` 任务编排：执行步骤 → 持久化 → 验证 → 修复 → 再验证 → 终态
6. `runPlan` 恢复支持：接收已完成步骤，按前缀校验后从下一步开始
7. CLI：`run --resume <id>`、`--verify <cmd>`、`--no-verify`；`tasks list` / `tasks show <id>`
8. 配置：任务库路径、验证命令/超时、修复轮数/迭代上限
9. 错误码：任务不存在、任务存储失败、任务参数非法、验证失败
10. 安全：验证命令分级与审批、验证输出脱敏、任务库路径校验、恢复时 workspace 一致性校验
11. 单元 + 集成测试、`pnpm verify` 阶段 7 演示、文档与开发报告

### 3.2 本次不做（OUT）

- 会话级聊天记忆（`chat` 历史落库）与跨会话上下文恢复（保留给阶段 8）
- 多 Agent、并行任务、任务队列与分布式锁
- 自动 git commit / 自动 git push（永久禁止自动 push）
- 计划重规划（replan）；修复只针对验证失败，不重新生成 Plan
- OS 级沙箱、容器、Windows Job Object
- 任务库保留策略/清理命令（仅提供 list/show）
- 非 git 工程的差异检测（仅告警不可用）
- 真实供应商端到端回归（默认离线 mock；阶段 9 再做）

## 四、技术设计

### 4.1 分层与新增模块

保持单向依赖：`cli → agent → {planner, tools, evaluator} → {llm, context, memory, security}`。

```text
src/memory/
├─ types.ts          TaskStatus / TaskRecord / StepRecord / TaskStore / TaskSummary
├─ state.ts          状态迁移表与 assertTransition
├─ schema.ts         DDL、migration、行映射、存储用 zod 校验
├─ sqlite-store.ts   sql.js 初始化、事务、原子持久化、单写者锁
└─ index.ts          createTaskStore

src/evaluator/
├─ types.ts          VerificationResult / DiffSummary / DiffFile / Evaluator
├─ verify.ts         验证命令分级、审批、执行、脱敏
├─ diff.ts           git 快照、解析 numstat/status、任务增量
└─ index.ts          createEvaluator

src/agent/
├─ repair.ts         修复提示词、修复循环
└─ task-runner.ts    任务生命周期编排（注入 TaskStore/Evaluator）

src/shared/
├─ atomic-write.ts   从 tools 迁移；支持 string | Uint8Array
└─ shell.ts          通用进程执行、超时、进程树终止、输出截断

src/security/
├─ child-env.ts      子进程环境净化 + 文本密钥脱敏（从 run-command 抽出）
└─ ...
```

约束：

- `memory` 只依赖 `security`（路径/敏感文件）、`shared`、`zod`、`sql.js`，不依赖 `agent/tools/planner`
- `evaluator` 只依赖 `llm` 接口（暂不需要）、`security`、`shared`，不依赖 `tools/agent`
- `agent` 通过注入的 `TaskStore`/`Evaluator` 接口编排，不直接 import 具体实现
- `cli` 构造 sql.js store、evaluator、provider、tools，并注入 `TaskRunner`
- `tools/run-command.ts` 的进程执行迁移到 `shared/shell.ts`，避免 evaluator 复制超时/进程树逻辑

### 4.2 任务模型与状态机（`src/memory/types.ts`、`state.ts`）

```ts
export type TaskStatus =
  | 'planned' // Plan 已生成并确认（plan-only 也会落库）
  | 'running' // 正在执行步骤
  | 'step_failed' // 某步骤失败，可恢复
  | 'verifying' // 步骤完成，正在运行验证命令
  | 'repairing' // 验证失败，正在自动修复
  | 'completed' // 验证通过或无需验证
  | 'failed' // 验证重试耗尽 / 不可修复错误
  | 'aborted'; // 用户中止

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskStepRecord {
  readonly index: number;
  readonly step: PlanStep;
  readonly status: StepStatus;
  readonly answer: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: AgentStopReason | undefined;
  readonly startedAt: number | undefined;
  readonly finishedAt: number | undefined;
}

export interface TaskRecord {
  readonly id: string;
  readonly goal: string;
  readonly workspace: string;
  readonly status: TaskStatus;
  readonly plan: TaskPlan;
  readonly verifyCommand: string | undefined;
  readonly verifyAutoSkip: boolean;
  readonly baselineDiff: DiffSummary | undefined;
  readonly repairAttempts: number;
  readonly resumeCount: number;
  readonly error: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: readonly TaskStepRecord[];
  readonly verifications: readonly VerificationResult[];
  readonly diffs: readonly DiffSummary[];
}

export interface TaskSummary {
  readonly id: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly stepCount: number;
  readonly completedSteps: number;
  readonly repairAttempts: number;
  readonly updatedAt: number;
  readonly error: string | undefined;
}
```

状态迁移（非法迁移抛 `TaskStorage`，不允许自由写状态）：

| From          | 允许的 To                                                    |
| ------------- | ------------------------------------------------------------ |
| `planned`     | `running`, `aborted`, `failed`                               |
| `running`     | `step_failed`, `verifying`, `completed`, `failed`, `aborted` |
| `step_failed` | `running`, `failed`, `aborted`                               |
| `verifying`   | `repairing`, `completed`, `failed`, `aborted`                |
| `repairing`   | `verifying`, `failed`, `aborted`                             |
| `failed`      | `running`, `verifying`, `aborted`（仅 resume）               |
| `aborted`     | `running`, `verifying`, `failed`（仅 resume）                |
| `completed`   | 无（终态）                                                   |

步骤迁移：`pending → running → completed|failed`；resume 时 `failed → running`（清空上一次结果），
`completed` 不再重跑。

### 4.3 SQLite schema 与存储契约（`src/memory/schema.ts`、`sqlite-store.ts`）

DDL（`PRAGMA user_version = 1`；版本高于当前直接报错，不自动降级）：

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  verify_command TEXT,
  verify_auto_skip INTEGER NOT NULL DEFAULT 0,
  baseline_diff_json TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_steps (
  task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  stop_reason TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (task_id, step_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE task_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE task_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  available INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX idx_steps_task ON task_steps(task_id, step_index);
```

`TaskStore` 接口：

```ts
export interface TaskStore {
  readonly path: string;
  createTask(input: {
    goal: string;
    plan: TaskPlan;
    workspace: string;
    verifyCommand: string | undefined;
    verifyAutoSkip: boolean;
    baselineDiff: DiffSummary | undefined;
  }): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  listTasks(limit?: number): Promise<readonly TaskSummary[]>;
  transition(id: string, to: TaskStatus, patch?: { error?: string | null }): Promise<void>;
  startStep(id: string, index: number): Promise<void>;
  finishStep(id: string, result: TaskStepRecord): Promise<void>;
  setBaselineDiff(id: string, diff: DiffSummary): Promise<void>;
  recordVerification(id: string, result: VerificationResult): Promise<void>;
  recordDiff(id: string, diff: DiffSummary): Promise<void>;
  recordRepair(id: string, attempt: number, payload: RepairRecord): Promise<void>;
  appendEvent(id: string, type: string, payload?: unknown): Promise<void>;
  close(): Promise<void>;
}

export function createTaskStore(options: {
  dbPath: string;
  workspace: string;
  readOnly?: boolean;
  logger?: Logger;
}): Promise<TaskStore>;
```

实现要点：

- 初始化：创建父目录（`.agent/`）→ 读取现有文件字节 → `new SQL.Database(bytes)` → migration
  → `PRAGMA integrity_check`；损坏时抛 `TaskStorage`，不覆盖原文件
- sql.js 的 WASM 路径通过 `createRequire(import.meta.url)` 定位到 `sql.js/dist/sql-wasm.wasm`
- 每次写操作使用 `BEGIN/COMMIT`；提交后 `db.export()` → `atomicWriteFile(dbPath, bytes)`
- 持久化失败：错误抛给上层并保持内存状态；`atomicWriteFile` 保证旧文件或新文件二选一
- 参数全部使用预编译语句绑定；任务 ID 必须匹配 UUID 格式
- Plan/Usage/Diff 以 JSON 文本存储，读取时用 zod 校验结构；非法数据抛 `TaskStorage`
- 写模式获取 `${dbPath}.lock`：
  - `open(..., 'wx')` 写入 `{ pid, startedAt }`
  - 已存在时读取 PID：活进程 → `TaskStorage("task store is locked by pid …")`；死进程 → 删除后重试一次
  - `close()` 持久化并删除锁；幂等
- `readOnly: true` 用于 `tasks list/show`：不获取写锁，只读取原子替换后的完整文件
- 单进程、单写者模型写入文档；不实现跨进程事务

### 4.4 验证执行（`src/evaluator/verify.ts`、`src/shared/shell.ts`）

```ts
export interface VerificationResult {
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly command: string;
  readonly attempt: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly output: string; // 已截断、已脱敏
  readonly reason: string | undefined;
}

export interface Evaluator {
  verify(request: {
    command: string;
    timeoutMs: number;
    attempt: number;
    cwd?: string;
  }): Promise<VerificationResult>;
  diff(): Promise<DiffSummary>;
}
```

执行流程：

1. `classifyCommand(command)`：
   - `deny` → 不执行，`status='failed'`，`reason='command denied: …'`，任务直接失败（不进入修复）
   - `high` → 通过注入的 `ConfirmFn` 审批；拒绝则失败，原因 `high-risk verification command denied`
2. `cwd` 用 `resolveInsideWorkspace`；默认 workspace 根
3. `sanitizeChildEnv(process.env)` 后交给 `runShellCommand`（沿用阶段 6 净化规则）
4. 超时默认 `AGENT_VERIFY_TIMEOUT_MS=300000`，超时终止整棵进程树
5. 输出合并 stdout/stderr，捕获上限 64 KB，展示保留头 8000 + 尾 4000，总长 12000
6. `redactSecretValues(output)`：把当前环境中密钥类变量的值替换为 `[REDACTED]`，再落库/回传模型
7. 退出码 0 → `passed`；非 0 / 超时 / 启动失败 → `failed`
8. 中止信号 → 终止子进程并抛 `LlmAborted`

`shared/shell.ts` 提供：

```ts
runShellCommand(options: {
  workspace: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<ShellResult>;

runProcess(command: string, args: readonly string[], options: {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ShellResult>;
```

`run_command` 工具改为复用上述实现；`runProcess` 供 git 差异检查使用（argv，不经过 shell）。

### 4.5 代码差异检查（`src/evaluator/diff.ts`）

```ts
export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'untracked' | 'other';
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface DiffSummary {
  readonly available: boolean;
  readonly reason: string | undefined; // 非 git 仓库 / git 不可用
  readonly files: readonly DiffFile[];
  readonly totalInsertions: number;
  readonly totalDeletions: number;
  readonly truncated: boolean;
}
```

采集：

- `git -c core.quotepath=false status --porcelain=v1 -z --untracked-files=all --no-renames`
- `git diff --numstat -z --no-renames`（未暂存）+ `git diff --cached --numstat -z --no-renames`
- 环境：`GIT_TERMINAL_PROMPT=0`、`GIT_EXTERNAL_DIFF=''`、`GIT_CONFIG_NOSYSTEM=1`，超时 30 秒
- 路径数量上限 500；超出标记 `truncated`；输出不进入模型
- `diffSince(baseline, current)`：只保留新增/状态变化/行数变化的文件；基线已有的未再改动文件不算本次任务改动
- 非 git 仓库或 git 不可用：`available=false` + reason；CLI 打印告警，不判任务失败

任务开始前采集 baseline 并写入 `tasks.baseline_diff_json`；每次验证后采集当前快照并求差，
写入 `task_diffs`。CLI 打印：

```text
diff: 3 files, +42 -7
diff warning: changed files not listed in the plan: src/x.ts
diff: unavailable (not a git repository)
```

越界/敏感提示只告警，不作为失败条件（写入工具本身已受 PathGuard/敏感文件约束）。

### 4.6 自动修复（`src/agent/repair.ts`）

```ts
export interface RepairOutcome {
  readonly attempt: number;
  readonly answer: string;
  readonly stopReason: AgentStopReason;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
}

export async function runRepair(options: {
  goal: string;
  plan: TaskPlan;
  stepResults: readonly StepResult[];
  verification: VerificationResult;
  diff: DiffSummary;
  maxIterations: number;
  provider: LLMProvider;
  tools: ToolRegistry;
  workspace: string;
  ignore: IgnoreMatcher;
  context: ContextManager; // 修复轮之间复用（仓库地图缓存）
  signal: AbortSignal;
  logger?: Logger;
  confirm?: ConfirmFn;
  commandTimeoutMs?: number;
  onToolCall?: ...;
  onToolResult?: ...;
}): Promise<RepairOutcome>;
```

修复任务文本包含：

- 目标与完整 Plan 摘要
- 每个已完成步骤的简短结果
- 失败的验证命令、退出码、脱敏后的输出尾部
- 相对于任务开始时的差异摘要
- 约束：只在工作区内修复；不要执行 `git push`；若判断是环境问题，明确说明而不是猜测

修复循环与步骤循环一致：同一套工具、PathGuard、审批、命令分级、重复调用/连续失败熔断。
`stopReason !== 'answer'` 视为本轮修复失败并立即终止后续修复（避免相同故障空转）。

### 4.7 任务编排（`src/agent/task-runner.ts`）

```ts
export interface RunTaskOptions extends Omit<RunPlanOptions, 'context'> {
  readonly task: TaskRecord;
  readonly store: TaskStore;
  readonly evaluator: Evaluator;
  readonly context: ContextManager;
  readonly verifyCommand: string | undefined;
  readonly verifyAutoSkip: boolean;
  readonly verifyTimeoutMs: number;
  readonly maxRepairAttempts: number;
  readonly repairMaxIterations: number;
  readonly onVerification?: (result: VerificationResult) => void;
  readonly onDiff?: (diff: DiffSummary) => void;
  readonly onRepair?: (outcome: RepairOutcome) => void;
}

export interface TaskRunResult {
  readonly task: TaskRecord; // 重新读取的终态
  readonly steps: readonly StepResult[];
  readonly planResult: PlanRunResult;
  readonly verification: VerificationResult | undefined;
  readonly diff: DiffSummary | undefined;
  readonly repairs: number;
}
```

流程：

1. `transition(task.id, 'running')`；非首次执行则 `resumeCount + 1`
2. 采集 baseline diff（仅首次），写入任务
3. 取 `task.steps` 中连续的 `completed` 前缀，重建 `StepResult[]`
4. `runPlan(plan, { ..., completedSteps })`：跳过已完成的步骤并持久化每个步骤结果
5. 步骤失败：`transition('step_failed', { error })`，返回（不进入验证/修复）
6. 验证命令决策：
   - `verifyCommand === undefined` → `skipped`（原因：disabled）
   - `verifyAutoSkip && command === 'pnpm test' && !exists(workspace/package.json)` → `skipped`（原因：no package.json）
   - 否则执行验证
7. 验证结果与差异落库；`passed` → `completed`
8. `failed` 且可修复 → `repairing` → `runRepair` → 记录事件/修复轮次 → `verifying` → 重跑验证
9. 修复耗尽仍失败 → `failed`，错误信息包含验证命令、退出码、修复轮数
10. `LlmAborted` → `transition('aborted')` 后原样抛出；其他异常 → `failed` 后原样抛出
11. 终态重新 `getTask` 返回；CLI 根据状态映射退出码

恢复规则：

- `status=planned`：Plan 尚未确认（来自 `--plan-only`），resume 时仍需确认（或 `--yes`）
- `status=running/step_failed`：从第一个非 `completed` 步骤继续，失败步骤重置为 `running`
- `status=failed/aborted`：若存在未完成步骤，按上一条恢复；若全部步骤完成，则重新验证/修复
- `status=completed`：打印已完成后直接退出 0，不再调用模型
- resume 前校验存储的 workspace 与当前配置一致；不一致抛 `TaskInvalid`

`runPlan` 调整：

```ts
export interface RunPlanOptions {
  // ...既有字段
  /** 恢复执行：必须与 plan.steps 的前缀逐项匹配 */
  readonly completedSteps?: readonly StepResult[] | undefined;
  readonly onStepStart?: (step, index, total) => void | Promise<void>;
  readonly onStepEnd?: (result, index, total) => void | Promise<void>;
}
```

`runPlan` 会 `await` 两个回调，便于 TaskRunner 在步骤结束时持久化；既有同步回调不受影响。

### 4.8 CLI（`src/cli/commands/run.ts`、`tasks.ts`、`main.ts`）

新增 `run` 参数：

| 参数                 | 说明                                             |
| -------------------- | ------------------------------------------------ |
| `--resume <taskId>`  | 恢复任务；不允许同时提供任务文本或 `--plan-only` |
| `--verify <command>` | 覆盖验证命令（显式配置，不自动跳过）             |
| `--no-verify`        | 本次任务不执行验证                               |

新增命令：

```text
agent tasks [--workspace <path>] [--limit <n>]       # 默认列出最近 20 条
agent tasks show <taskId> [--workspace <path>]
```

`run` 新流程：

1. 原有配置、日志、provider、tools、ignore 初始化
2. `--no-plan`：完全沿用阶段 5/6 直接循环，不初始化任务库
3. 新任务：规划 → 打印 → 确认 → 采集 baseline → `createTask(status=planned)` → 打印 `task: <id>`
4. `--plan-only`：同样落库为 `planned`，打印 `task: <id>` 与恢复提示，退出 0
5. 执行：`TaskRunner` 逐步持久化；横幅增加 `task` 与 `verify` 信息
6. 验证/修复打印：
   - `verification: passed (command="pnpm test", 3.2s)`
   - `verification: failed (exit=1, 1.4s)`
   - `repair 1/2: answered (iterations=3 tools=2)`
   - `verification: skipped (no package.json)`
7. 终态汇总：
   - 成功：`plan completed ...` + `verification passed` + `diff: N files, +X -Y` + `task completed: <id>`
   - 步骤失败：`task step_failed: <id>` + `resume with: agent run --resume <id>`，退出 1
   - 验证失败：`task failed: <id>` + resume 提示，抛 `VerificationFailed`，退出 1
8. `--resume`：
   - 读取任务 → 打印 `resuming task <id> (status=..., completed steps k/n)`
   - `planned` 状态仍需 Plan 确认；其余状态直接恢复
   - 使用任务中保存的验证命令与 auto-skip 标记；CLI 覆盖优先
   - 完成后同样更新同一个任务行，不新建任务

`RunResult` 扩展（可选字段，兼容既有测试）：

```ts
readonly taskId?: string;
readonly verification?: VerificationResult;
readonly diff?: DiffSummary;
readonly repairs?: number;
```

### 4.9 配置（`src/config/schema.ts`、`load.ts`）

| 变量                          | 默认              | 范围        | 说明                                        |
| ----------------------------- | ----------------- | ----------- | ------------------------------------------- |
| `AGENT_TASK_DB`               | `.agent/tasks.db` | —           | 任务库路径，必须位于 workspace 内且非敏感名 |
| `AGENT_VERIFY_COMMAND`        | `pnpm test`       | 1-1000 字符 | 计划完成后的验证命令；空值表示关闭自动验证  |
| `AGENT_VERIFY_TIMEOUT_MS`     | 300000            | 1000-600000 | 验证命令超时                                |
| `AGENT_MAX_REPAIR_ATTEMPTS`   | 2                 | 0-10        | 验证失败后的最大修复轮数，0 关闭自动修复    |
| `AGENT_REPAIR_MAX_ITERATIONS` | 8                 | 1-100       | 每轮修复的 AgentLoop 迭代上限               |

- `AppConfig.agent` 新增 `taskDb`、`verifyCommand`、`verifyCommandExplicit`、`verifyTimeoutMs`、
  `maxRepairAttempts`、`repairMaxIterations`
- `verifyCommandExplicit`：环境变量或 `.env` 显式提供（含空值）时为 true；仅默认值为 false
- `AGENT_TASK_DB` 用 `resolveForWrite(workspace, …)` 校验沙箱与 `.git`，并拒绝敏感文件名；
  库目录不存在时由 store 创建
- `AGENT_VERIFY_COMMAND` 拒绝 NUL；空字符串 → `undefined`（关闭）
- `.env.example` 同步新增说明

### 4.10 错误码（`src/shared/errors.ts`）

| 错误码               | 值                    | 退出码 | 场景                                       |
| -------------------- | --------------------- | ------ | ------------------------------------------ |
| `TaskNotFound`       | `TASK_NOT_FOUND`      | 2      | `--resume`/`tasks show` 指定不存在的任务   |
| `TaskInvalid`        | `TASK_INVALID`        | 2      | workspace 不一致、参数组合非法、任务已完成 |
| `TaskStorage`        | `TASK_STORAGE`        | 1      | 初始化/迁移/锁/持久化/数据损坏             |
| `VerificationFailed` | `VERIFICATION_FAILED` | 1      | 修复耗尽后验证仍失败                       |

步骤失败继续使用 `AgentIncomplete`；中止继续使用 `LlmAborted`。

### 4.11 安全与数据保护

- 任务库路径限定在 workspace；拒绝 `.git` 与 `.env`/密钥类文件名
- 任务库默认位于 `.agent/`，已被 git 忽略；文档明确不要提交任务库
- 验证命令先分级：`git push`/灾难性命令硬拒绝；高风险命令必须审批；无 TTY 拒绝
- 验证输出先按上限截断，再用当前环境中的密钥值做文本脱敏，才落库/打印/送入修复模型
- 子进程环境沿用阶段 6 净化规则；`git` 差异检查使用 argv，不经过 shell
- 修复循环复用 PathGuard、敏感文件、覆盖确认、命令分级；不提供自动 push 路径
- 恢复任务只允许在创建该任务的 workspace 中执行；任务 ID 使用 UUID 并参数化查询
- 任务库包含目标、步骤结果与验证输出，属于本地运行数据；`tasks show` 不输出完整命令输出

## 五、任务分解

| #   | 任务                                                                                                                   | 依赖       |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | 依赖与基础设施：`sql.js`、`shared/atomic-write`、`shared/shell`、`security/child-env`（已完成 2026-11-16）             | —          |
| P2  | 任务类型、状态机、SQLite schema/migration、`TaskStore` + 锁 + 单元测试（已完成 2026-11-16）                            | P1         |
| P3  | Evaluator：验证执行、命令分级/审批、输出脱敏、git 差异快照/增量 + 单元测试（已完成 2026-11-16）                        | P1         |
| P4  | `runPlan` 恢复支持（completedSteps、异步回调）+ 既有测试回归（已完成 2026-11-16）                                      | P2         |
| P5  | 修复循环 + 任务编排（验证/修复/终态持久化）+ 单元测试（已完成 2026-11-16）                                             | P2, P3, P4 |
| P6  | CLI：`--resume`、`--verify/--no-verify`、`tasks list/show`、输出与退出码（已完成 2026-11-16）                          | P5         |
| P7  | 集成测试：步骤失败恢复、验证修复、任务库持久化、密钥不落库（由阶段 8 P1 完成，2026-11-16）                             | P6         |
| P8  | 文档、`.env.example`、`pnpm verify` 阶段 7 演示、覆盖率、git diff、开发报告（文档与 verify/覆盖率由阶段 8 P6/P7 收尾） | P7         |

## 六、测试计划（必须真实执行）

### 6.1 单元测试

- **状态机**：所有合法迁移；全部非法迁移拒绝；步骤 `failed → running` 重置；completed 终态
- **TaskStore**：
  - 初始化建目录、`user_version=1`、重复打开幂等
  - 创建/读取/列表/关闭重开持久化；步骤、验证、差异、事件落库
  - 非法迁移、未知任务、非法 UUID、workspace 不匹配
  - 写锁：并发第二实例拒绝；陈旧 PID 自动清理；`close` 幂等释放
  - 损坏数据库文件 → `TaskStorage` 且不覆盖原文件
  - 路径越界/`.git`/敏感文件名配置拒绝
  - 含引号/中文/emoji 的目标文本安全存储（参数化查询）
- **Evaluator**：
  - 验证通过/非 0/超时/启动失败/中止；输出截断；脱敏（密钥值不出现）
  - `git push` 硬拒绝且不执行；高风险命令审批允许/拒绝；`cwd` 越界拒绝
  - 非 git 目录 `available=false`；git 仓库新增/修改/删除/未跟踪；baseline 增量只保留任务改动
- **runPlan 恢复**：`completedSteps` 前缀匹配；不匹配拒绝；已完成步骤不调用模型；回调异步持久化
- **修复与编排**：
  - 验证通过直接 completed；无验证命令 completed；默认命令无 `package.json` 跳过
  - 验证失败 → 修复成功 → 再验证通过（repairAttempts=1）
  - 修复耗尽 → failed；修复 AgentLoop 非 answer → 立即停止修复
  - 步骤失败 → step_failed，不进入验证
  - 中止 → aborted；异常 → failed
  - resume 跳过 completed 步骤并保留 usage/iterations 汇总
- **CLI**：
  - `--plan-only` 落库 planned 并打印任务 ID/恢复提示
  - `--resume` 已完成任务 no-op；step_failed 只执行剩余步骤（mock 脚本不消费规划步）
  - `--resume` 与任务文本/`--plan-only` 组合非法
  - workspace 不一致 → `TaskInvalid`
  - `--no-verify` / `--verify` 覆盖生效
  - `tasks list` / `tasks show` 输出与缺失任务错误

### 6.2 集成测试（离线 mock）

- 首轮步骤失败 → 退出 1、任务库状态 `step_failed`、完成步骤保留
- 第二轮 `run --resume <id>` → 不重新规划、从失败步骤继续 → 验证通过 → 状态 `completed`
- 验证失败 → 修复写文件 → 再验证通过 → 文件内容正确、任务记录 repairs=1
- 验证修复耗尽 → 退出 1、状态 `failed`、输出含 resume 提示
- `--no-plan` 不创建任务库文件
- 密钥不出现在 stdout/stderr/日志/任务库/验证输出中
- 任务库文件位于 workspace 内，且 `.agent/` 仍被忽略

### 6.3 回归与验收门

- 阶段 1-6 全部既有用例保持通过；`zhipu-live` 默认跳过
- `pnpm typecheck` / `lint` / `format:check` / `build` / `test:coverage` 全绿
- 覆盖率目标：语句 ≥ 95%，并报告实际值（阶段 6 为 97.03%）
- `pnpm verify` 增加阶段 7 演示：验证修复、步骤失败恢复、`tasks show` 状态检查
- 真实执行结果回填本文件第十节；未执行的测试不得描述为已通过

## 七、安全验收用例

- `AGENT_TASK_DB=../outside.db` → `ConfigError`
- `AGENT_TASK_DB=.env` → 拒绝（敏感文件名）
- 验证命令 `git push` → 硬拒绝，子进程不执行
- 验证命令 `rm -rf`（高风险）→ 非 TTY 拒绝；交互确认后才执行
- 验证输出包含 `LLM_API_KEY` 的值 → 落库/打印前替换为 `[REDACTED]`
- 恢复任务的 workspace 与记录不一致 → `TaskInvalid`，不执行任何工具
- 任务 ID 注入字符串 → 参数化查询，任务不存在而非执行 SQL
- 任务库损坏 → 报错退出，不静默重建覆盖
- 自动修复中调用 `git push` → 仍由工具层硬拒绝
- 并发第二个写实例 → 锁错误退出，不覆盖任务库

## 八、风险与应对

| 风险                            | 说明                                       | 应对                                                         |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| sql.js 全量导出写入放大         | 每次状态变更重写整个 DB 文件               | 任务库只存元数据与截断输出；原子替换；文档说明适用单任务规模 |
| 并发写任务库                    | 两个 Agent 同时写同一 workspace 会互相覆盖 | 单写者锁 + PID 存活检测；`tasks` 只读不加锁                  |
| 恢复重跑失败步骤产生重复修改    | 步骤可能已部分写入                         | 恢复提示要求模型先检查现状；写工具仍受覆盖确认保护           |
| 验证命令存在副作用              | 测试/构建命令可能修改文件                  | 风险分级 + 高风险审批 + 超时；验证后差异检查会显示副作用     |
| 自动修复费用/循环               | 模型可能反复修改无效                       | 默认 2 轮 + 每轮迭代上限；修复循环非 answer 立即停止         |
| 验证输出携带密钥                | 命令可能打印 `.env` 或环境变量             | 子进程环境净化 + 输出值级脱敏 + 截断；文档说明残余风险       |
| 非 git 工程无法差异检查         | 无法判断任务改动                           | `available=false` 告警，不影响任务成败                       |
| Windows 文件锁/进程存活判断差异 | `process.kill(pid,0)` 在 Windows 语义不同  | 采用 EPERM=存活、ESRCH=死亡；加入平台分支测试                |
| 任务库损坏                      | 非原子写或外部修改                         | 临时文件 + rename、打开时 integrity_check、损坏不覆盖        |
| 大输出进入修复提示              | 可能撑爆上下文                             | evaluator 先截断（12000 字符），ContextManager 再按预算裁剪  |

## 九、交付清单（AGENTS.md 第七节）

- [ ] Plan 文件（本文件，待确认）
- [ ] 代码变更
- [ ] 测试结果（真实执行数据，实施后回填第十节）
- [ ] 风险说明
- [ ] 完成情况
- [ ] 文档更新（architecture.md、README、.env.example）
- [ ] git diff 检查
- [ ] 开发报告

## 十、验收结果（实施后回填）

### 10.1 已完成范围

- **P1-P6**：`shared/atomic-write`、`shared/shell`、`security/child-env`；`memory` 的
  `types/state/schema/sqlite-store`（sql.js、原子快照、单写者锁、`user_version=1`）；
  `evaluator` 的验证执行与 git 差异；`runPlan` 恢复前缀与异步回调；`runRepair` 与
  `runTask` 编排；CLI `--resume` / `--verify` / `--no-verify` / `tasks list|show` 与配置项。
- **P7（阶段 8 P1 完成）**：`tests/integration/task-lifecycle.test.ts` 8 个用例真实执行通过
  （约 10.2s），覆盖成功闭环、步骤失败与恢复、验证失败→修复、修复耗尽、`--no-plan`、
  `--no-verify`、密钥不落库、极小上下文预算。
- **P8（阶段 8 P6 完成文档部分）**：README 升级到 V1.0；architecture 路线图重定义并补充
  阶段 7/8；新增 `docs/testing.md`；`.env.example` 已包含阶段 7 配置；CHANGELOG 记录 1.0.0。
  `scripts/verify.js` 的阶段 7/8 任务可靠性演示与覆盖率阈值在阶段 8 P7 落地，最终门禁与
  覆盖率真实输出回填 `docs/plans/phase-8-release.md` 第十节。

### 10.2 测试证据（本阶段相关）

| 测试文件                                   | 结果                   |
| ------------------------------------------ | ---------------------- |
| `tests/integration/task-lifecycle.test.ts` | 8/8 通过（约 10.2s）   |
| `tests/integration/failure-modes.test.ts`  | 6/6 通过（约 6.2s）    |
| `tests/integration/permissions.test.ts`    | 7/7 通过（约 6.3s）    |
| `tests/integration/llm-failure.test.ts`    | 4/4 通过（本地假端点） |

单元测试（task-store / task-state / evaluator / task-runner / repair / tasks-command 等）随
全量套件执行；全量数字与覆盖率以阶段 8 P8 的真实输出为准。

### 10.3 残余风险与边界

- sql.js 每次写事务导出整个数据库文件：当前只存元数据与截断输出，适合单任务规模；不做并发写。
- 非 git 工作区差异检查不可用，只告警，不判任务失败。
- 恢复不保存半截 LLM 会话，失败步骤从头重跑；模型需先检查现状，写工具仍受覆盖确认保护。
- 真实供应商不在自动门禁内，保留 `ZHIPU_LIVE_TEST=1` 手工回归。
- 聊天会话持久化与跨会话记忆恢复顺延到 V1.0 之后。
