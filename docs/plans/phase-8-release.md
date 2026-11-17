# 阶段 8 开发 Plan：集成测试与完善（Release / V1.0）

> 状态：已实施（P1-P8 全部完成，2026-11-16）
> 日期：2026-11-16
> 范围：端到端测试 / 异常场景 / 权限控制 / Prompt 优化 / 上下文优化 / 文档完善
> 交付：Coding Agent V1.0

## 一、现状分析

阶段 1-7 的代码已落地，阶段 7 的 P1-P6 已完成；P7（集成测试）与 P8（文档、verify 演示、
覆盖率、开发报告）尚未执行。阶段 8 在完成这两项收尾的同时，补齐 Release 所需的端到端、
异常与权限验证，并做 Prompt 与上下文的最后优化。

| 需求       | 现状                                                                                    | 阶段 8 缺口                                                                |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 端到端测试 | `run-plan.test.ts` 覆盖规划、写文件、审批、密钥不落日志；无任务生命周期                 | 完成任务持久化 → 失败 → resume → 验证 → 修复 → `tasks show` 的真实进程链路 |
| 异常场景   | 停止原因、重试、存储损坏、锁等以单元测试为主                                            | 进程级异常：LLM 失败/429/超时、验证超时、修复耗尽、损坏任务库、SIGINT      |
| 权限控制   | 覆盖覆盖写确认、`git push` 硬拒绝、高风险非 TTY 拒绝、子进程环境净化                    | 路径穿越/符号链接逃逸、敏感文件读写、验证命令分级、恢复 workspace 不一致   |
| Prompt     | 三段提示词较短，无提示词回归测试；规划/修复约束依赖模型自行理解                         | 结构化系统提示、规划与修复约束补强、提示词不变量测试                       |
| 上下文     | 整组丢弃 + 只保留工具输出头部；仓库地图截断时缺少全局摘要；裁剪不可见                   | 头尾保留截断、仓库地图顶层摘要、极小预算兜底、CLI 展示裁剪统计             |
| 文档       | README 仍写“阶段 6”；`scripts/verify.js` 仍是阶段 6 演示；路线图阶段 8/9 与本次需求冲突 | README、architecture、测试矩阵、`.env.example`、CHANGELOG、阶段 7/8 报告   |
| 版本       | `package.json` 为 `0.1.0`                                                               | 发布为 `1.0.0`                                                             |

**路线图冲突的处理**：用户本次定义的阶段 8 是 **Release**，因此把 architecture.md 路线图的
阶段 8 重定义为“集成测试与完善（V1.0）”，原阶段 8 的“聊天会话持久化 / 跨会话恢复”明确
顺延到 V1.0 之后，原阶段 9 的“总验收”并入本阶段。此调整只改文档，不扩大代码范围。

**阶段 7 收尾**：本阶段 P1/P6/P7 同时完成阶段 7 Plan 中尚未执行的 P7（集成测试）与 P8
（文档、verify 演示、覆盖率、报告），并在阶段 7 Plan 中标记完成、回填验收结果。

## 二、已定决策

| 决策           | 选择                                                                              | 理由                                                             |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 阶段 8 定位    | Release：只做测试、缺陷修复、Prompt/上下文优化与文档，不新增 Agent 能力           | 符合用户需求；V1.0 前控制范围，避免引入未验证的新功能            |
| 端到端测试方式 | 真实子进程 `node --import tsx src/cli/main.ts` + `mock` provider + 临时 workspace | 覆盖进程边界、CLI 退出码与文件副作用；完全离线、零配额           |
| LLM 异常测试   | 本地 `node:http` 假端点 + `openai-compatible` provider                            | 在进程级验证重试、429 不重试、超时与错误脱敏，仍不联网           |
| 权限测试       | 以真实工具调用/真实命令执行验证“拒绝确实没有副作用”，不只断言错误字符串           | 安全约束必须验证结果，而非仅验证提示                             |
| Prompt 优化    | 保守改写三段提示词（系统、规划、修复），用不变量测试锁定关键约束                  | 无法离线衡量模型质量；先保证安全/格式/工作流约束不退化           |
| 上下文优化     | 头尾保留截断 + 仓库地图顶层摘要 + 裁剪统计可见；不引入模型摘要压缩                | 现有“整组丢弃”可预测、协议安全；头尾保留能同时保住指令与错误尾部 |
| 验证命令默认值 | 保持 `pnpm test`；E2E 测试显式设置 `AGENT_VERIFY_COMMAND`，避免受本机 `.env` 影响 | 测试必须可复现，不能读取开发者本地配置                           |
| 真实供应商回归 | 不作为门禁；保留 `ZHIPU_LIVE_TEST=1` 手工执行，并写入发布检查清单                 | 会产生费用且依赖密钥/配额；离线 E2E 已覆盖协议与生命周期         |
| 版本号         | `1.0.0`                                                                           | “Coding Agent V1.0”的交付物；无发布 npm 包的计划                 |
| 提交策略       | 不自动 commit / push；仅在用户明确要求时提交                                      | AGENTS.md 安全约束                                               |

## 三、范围

### 3.1 本次做（IN）

1. 抽取 E2E 测试辅助（临时 workspace、子进程 CLI、mock 脚本、任务库只读检查、日志读取）
2. 任务生命周期 E2E：成功、步骤失败、resume、验证失败 → 修复 → 通过、修复耗尽、`--no-plan`
   不建库、`--no-verify`、密钥不落任何输出/存储、`tasks list/show`
3. 异常 E2E：本地假 LLM 端点（500 重试、429 配额不重试、超时、非法响应）、验证超时、
   损坏任务库、写锁冲突、SIGINT 中止、非 git 差异不可用
4. 权限 E2E：路径穿越、绝对路径越界、符号链接逃逸、敏感文件读写、`.git/` 写入、覆盖确认、
   硬拒绝命令、高风险非 TTY、验证命令分级、恢复 workspace 不一致、任务库路径校验
5. Prompt 优化：系统提示、规划提示、修复提示；新增提示词不变量测试
6. 上下文优化：工具输出头尾截断、仓库地图顶层目录摘要、极小预算兜底、CLI 裁剪统计
7. 测试矩阵文档与发布文档：README、architecture、`docs/testing.md`、`.env.example`、CHANGELOG
8. `scripts/verify.js` 升级为阶段 8：保留 5 道门禁，新增任务可靠性演示（验证/修复/resume/tasks）
9. 版本升级到 `1.0.0`，覆盖率门禁与全量验收、git diff 检查、开发报告
10. 完成阶段 7 Plan 的 P7/P8 收尾与验收回填

### 3.2 本次不做（OUT）

- 聊天会话持久化、跨会话记忆恢复（原路线图阶段 8，V1.0 之后）
- 新工具、新 Agent 能力、重规划（replan）、多 Agent/并行任务
- 模型输出质量评测集或自动 Prompt 调优（只做约束与回归测试）
- 真实供应商 CI 门禁、自动消耗配额
- 自动 git commit / git push、发布 npm 包、打 tag
- GUI/Web、跨平台容器沙箱

## 四、技术设计

### 4.1 E2E 测试骨架（`tests/integration/helpers.ts`）

由 `run-plan.test.ts` 的内联辅助抽取而来，供新增用例复用：

```ts
export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TestWorkspace {
  readonly dir: string;
  write(relative: string, content: string): void;
  read(relative: string): string | undefined;
  exists(relative: string): boolean;
  script(steps: unknown): void;
  cleanup(): void;
}

export function createWorkspace(): TestWorkspace;
export function runCli(workspace: string, args: readonly string[], env?: NodeJS.ProcessEnv): CliRun;
export async function readTask(workspace: string, taskId: string): Promise<TaskRecord | undefined>;
export function readTaskSummaries(workspace: string): Promise<readonly TaskSummary[]>;
export function logText(workspace: string): string;
export function printedTaskId(stdout: string): string | undefined;
```

要点：

- 每个用例独立临时目录；`afterEach` 重试删除（Windows 文件句柄）
- 基线环境显式覆盖：`AGENT_WORKSPACE`、`AGENT_LOG_DIR=logs`、`LLM_PROVIDER=mock`、
  `LLM_API_KEY=''`、`LLM_BASE_URL=''`、`LLM_MODEL=''`、`AGENT_VERIFY_COMMAND=''`；
  验证相关用例再显式传入命令，避免读取项目根 `.env`
- 任务库读取使用 `createTaskStore({ readOnly: true })`，用完 `close()`；不直接手写 SQL
- 子进程超时 60s；E2E 文件保持在 5 个以内，避免 `pnpm test` 明显变慢

### 4.2 任务生命周期 E2E（`tests/integration/task-lifecycle.test.ts`）

| 场景                | 驱动方式                                                     | 关键断言                                                                                 |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 成功闭环            | 规划 → `write_file` → 显式验证命令通过 → 回答                | 退出 0；`task completed: <id>`；任务 `completed`；文件内容；`verification.status=passed` |
| 步骤失败            | 两步计划，`AGENT_STEP_MAX_ITERATIONS=1` 使首步耗尽           | 退出 1；任务 `step_failed`；已完成前缀保留；stdout 含 resume 提示                        |
| 恢复执行            | 第二次进程 `run --resume <id>`，脚本从步骤开始（不消费规划） | 不重新规划；`resumeCount=1`；同一任务 ID；最终 `completed`；已完成步骤不重跑             |
| 验证失败 → 修复成功 | 验证命令检查文件内容；首轮失败，修复脚本改写文件，第二轮通过 | 退出 0；`repair 1/1`；任务 `repairs=1`；文件为修复后内容；`task completed`               |
| 修复耗尽            | 验证始终失败，`AGENT_MAX_REPAIR_ATTEMPTS=1`                  | 退出 1；任务 `failed`；stdout 含 `verification: failed` 与 resume 提示                   |
| `--no-plan`         | 直接工具循环                                                 | 不创建任务库文件；退出 0；行为与阶段 5 一致                                              |
| `--no-verify`       | 规划完成后关闭验证                                           | 任务 `completed`；验证记录为 `skipped`（disabled）；不执行验证命令                       |
| 密钥不落库          | `LLM_API_KEY=<secret>`；验证命令打印同值文本                 | secret 不出现在 stdout/stderr/日志/任务库/验证输出；输出为 `[REDACTED]` 或 `unset`       |
| 任务查看            | 完成一次任务后 `tasks list`、`tasks show <id>`               | list 含状态/步数；show 含目标、步骤、验证状态与差异摘要；不打印完整验证输出              |
| 上下文极小预算      | `AGENT_CONTEXT_BUDGET_TOKENS=1000` + 大文本 fixture          | 任务仍完成；stdout 出现 `context trimmed: dropped=... truncated=...`                     |

### 4.3 异常场景（`tests/integration/failure-modes.test.ts`、`tests/integration/llm-failure.test.ts`）

| 类别     | 场景                        | 预期                                                       |
| -------- | --------------------------- | ---------------------------------------------------------- |
| LLM      | 第一次 500，第二次成功      | CLI 重试后成功；请求数 2；退出 0                           |
| LLM      | 429 + 业务码 1113（配额）   | 不重试；退出 1；错误信息含配额提示且不含密钥               |
| LLM      | 请求超时                    | 退出 1；错误分类为超时；日志无密钥                         |
| LLM      | 非法 JSON / 缺字段          | 按既有策略失败；退出 1；错误可读                           |
| 验证     | 验证命令超时                | 任务 `failed`；`timedOut=true`；进程树被终止               |
| 验证     | 验证命令为 `git push`       | 不执行；任务失败；子进程未被创建                           |
| 存储     | 任务库文件损坏              | 退出 1；`TASK_STORAGE`；原文件未被覆盖                     |
| 存储     | 第二个写进程并发            | 第二个退出 1；锁错误；任务库未被覆盖                       |
| 存储     | `--resume` 不存在/非法 ID   | 退出 2；`TASK_NOT_FOUND` / `TASK_INVALID`                  |
| 中止     | 运行中发送 SIGINT           | 退出非 0；任务 `aborted`（可恢复）；不崩溃、不残留子进程   |
| 差异     | 临时 workspace 非 git 仓库  | `diff: unavailable (not a git repository)`；任务不因此失败 |
| 循环保护 | `max_iterations` / 重复调用 | 既有单元测试覆盖；E2E 保留步骤失败用例，不重复造用例       |

SIGINT 用例使用 `spawn`（非 `spawnSync`）启动 CLI，等待出现首个步骤输出后发送 `SIGINT`；
若 Windows 下出现不稳定，降级为“注入 AbortSignal 的单测 + 手动验证”，并在 `docs/testing.md`
标注平台限制，不把未执行通过的测试写成已通过。

### 4.4 权限控制（`tests/integration/permissions.test.ts`）

先盘点 `security.test.ts`、`write-tools.test.ts`、`run-command.test.ts`、`approval-risk.test.ts`、
`run-plan.test.ts` 的现有覆盖，只补进程级缺口：

| 权限点       | 用例                                                         | 断言                                |
| ------------ | ------------------------------------------------------------ | ----------------------------------- |
| 路径沙箱     | `read_file ../outside.txt`、绝对路径越界、`..` 混合路径      | `TOOL_DENIED`；外部文件未读取       |
| 符号链接     | workspace 内链接指向外部文件/目录；写入经链接目录            | 拒绝；外部目标未被修改              |
| 敏感文件     | 读/写 `.env`、`.env.local`、`*.pem`、`id_rsa`、`credentials` | 拒绝；`.env.example` 放行（仅读取） |
| `.git/`      | `write_file .git/config`                                     | 拒绝                                |
| 覆盖写       | 覆盖非空文件，非交互                                         | 拒绝；内容不变；`--yes` 不放宽      |
| 命令硬拒绝   | `git push`、`sudo`、`shutdown`、`mkfs`、根目录删除           | 拒绝；命令未执行                    |
| 高风险确认   | `git clean -fd` 非 TTY                                       | 拒绝；工作区不变                    |
| 确认放行     | 注入确认函数返回 true（单测）                                | 执行一次；确认只影响该次调用        |
| 验证命令分级 | `--verify "git push origin main"`                            | 任务失败；命令未执行；不进入修复    |
| 子进程环境   | `run_command` 打印 `LLM_API_KEY` / `GITHUB_TOKEN`            | 均为 `unset`；日志无密钥            |
| 任务库路径   | `AGENT_TASK_DB=../outside.db`、`.env`、`.git/tasks.db`       | 配置阶段退出 2；不创建文件          |
| 恢复一致性   | 复制任务库到另一 workspace 后 resume                         | 退出 2；`TASK_INVALID`；不执行工具  |

### 4.5 Prompt 优化

保持提示词为英文（与现有模型行为一致），只强化约束与工作流，不做风格性重写。

**系统提示（`src/agent/loop.ts` 的 `AGENT_SYSTEM_PROMPT`）** 按节组织：

1. 角色与目标：在工作区内完成用户任务，回答简洁
2. 工作区与安全：相对路径；禁止越界、密钥、`.git/`、任务库/日志；禁止 `git push`
3. 工作流：先检索再读取；修改前先读现状；最小改动；改完再验证
4. 工具策略：新文件用 `write_file`，已有文件优先 `edit_file`；参数必须匹配 schema；
   工具错误要修正参数而不是编造结果；长输出用 offset/limit 分页
5. 完成条件：任务满足即回答；任务要求跑测试才跑，否则避免无意义的长命令；
   被阻塞时说明具体原因与下一步

**规划提示（`src/planner/prompt.ts`）**：

- 步骤必须是可直接执行的动作，按顺序排列，1..MAX
- 每步说明具体文件、行为或验证命令；`files` 为 workspace 相对路径，不确定时为空数组
- 代码改动任务应包含验证步骤；但不要把“再规划一次”写成步骤
- 禁止秘密文件、`.git/`、越界路径、破坏性命令与 `git push`
- `notes` 用于风险/假设，无内容可省略

**修复提示（`src/agent/repair.ts` 的 `buildRepairTask`）**：

- 明确“不要重跑已完成步骤”，先检查当前文件现状
- 最小修复；不要无理由安装依赖或改无关文件
- 可行时重跑失败命令；环境问题要说明而不是猜测
- 保持既有约束（工作区内、无 `git push`、无破坏性命令）
- 回答包含改动摘要与验证结果

**测试（`tests/unit/prompts.test.ts`）**：断言关键不变量（JSON-only、步骤上限插值、文件路径约束、
安全禁令、修复约束、无示例密钥），不做整段快照，避免无意义抖动。

### 4.6 上下文优化

1. **工具输出头尾截断**（`src/context/manager.ts`）
   - 超预算时仍按“从最旧整组丢弃”优先；仅剩最新组仍超限时截短最长的 `tool` 消息
   - 截断保留约 60% 头部 + 40% 尾部，中间插入
     `\n... (middle truncated; was N chars) ...\n`，避免丢掉命令末尾的错误信息
   - 保持 `toolCallId` 配对；不修改入参；统计 `truncatedToolMessages`
2. **仓库地图顶层摘要**（`src/context/repo-map.ts`）
   - 在 `Languages` 之后增加 `Top-level: src/=42, tests/=18, ...`（最多 12 项）
   - 目录树被预算截断时，仍能看到项目整体结构
3. **极小预算兜底**
   - `buildMessages` 已保证仓库地图不超过可用预算；新增保护：若“系统 + 任务”仍超预算，
     优先移除仓库地图段（按固定分隔标记切分），保留原始系统提示与任务
   - 移除时日志记录 `repo map dropped to fit budget`，上下文统计新增 `repoMapDropped`
4. **CLI 可见性**（`src/cli/commands/run.ts`）
   - 直接模式与任务模式结束时，若 `droppedMessages > 0 || truncatedToolMessages > 0`，
     打印 `context trimmed: dropped=N truncated=M`
   - 不改变既有 `context` 横幅格式
5. **测试**
   - `context-manager.test.ts`：头尾标记、极小预算移除地图、含 tool 配对、入参不变、统计累计
   - `repo-map.test.ts`：顶层摘要、预算截断后摘要仍在、无文件时的空状态
   - E2E：极小预算仍完成任务（见 4.2）

### 4.7 文档与发布物

| 文件                                | 变更                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `README.md`                         | 改为 V1.0 / 阶段 8；补齐 `run` 全部参数、`tasks` 命令、阶段 6/7 配置项、项目结构、测试与安全说明、已知限制 |
| `docs/architecture.md`              | 路线图阶段 8 重定义为 Release；原会话持久化顺延；阶段 9 并入；新增阶段 8 段落与 V1.0 边界                  |
| `docs/testing.md`（新增）           | 测试分层、离线保证、异常/权限矩阵与对应测试文件、真实端点 opt-in、SIGINT 平台说明                          |
| `docs/plans/phase-7-reliability.md` | 状态改为已实施；P7/P8 标记完成；第十节回填阶段 7 验收结果                                                  |
| `docs/plans/phase-8-release.md`     | 本文件；实施后回填验收结果                                                                                 |
| `.env.example`                      | 校对阶段 6/7 配置说明；本阶段不新增变量，仅修正过期描述                                                    |
| `CHANGELOG.md`（新增）              | `1.0.0` 条目：阶段 1-8 的能力、测试与已知限制                                                              |
| `package.json`                      | `version: 1.0.0`                                                                                           |

### 4.8 `scripts/verify.js` 升级

保留 5 道门禁（typecheck / lint / format:check / build / test:coverage）与现有 REPL、规划演示，
新增 `taskDemo()`：

1. 临时 workspace + mock 脚本：规划 → 写文件 → 显式验证命令（首次失败）
2. 修复脚本改写文件 → 第二次验证通过
3. 断言：`verification: failed`、`repair 1/1`、`verification: passed`、`task completed`
4. `tasks show <id>` 输出 `status=completed`、`repairs=1`
5. 用一份独立脚本演示 `--plan-only` → `--resume`（不重新规划），断言恢复后任务完成；
   另用 `step_failed` → `--resume` 演示并断言 `resumes=1`（planned 任务首次执行按设计不计 resume）

全程使用 `LLM_PROVIDER=mock`、空密钥、临时目录，不联网、不消耗配额；失败时退出 1。

### 4.9 覆盖率与版本

- 为 `vitest.config.ts` 增加覆盖率阈值（实测基线 94.67%，补公共入口测试后设
  语句/行 ≥95%、分支 ≥88%、函数 ≥99%；不通过降阈值掩盖）
- `package.json` 版本改为 `1.0.0`；`--version` 不新增硬编码断言，沿用动态读取
- V1.0 发布检查清单写入 `docs/testing.md` 或 README：全量门禁、`pnpm verify`、
  可选真实端点手工回归、已知限制

## 五、任务分解

| #   | 任务                                                                          | 依赖  |
| --- | ----------------------------------------------------------------------------- | ----- |
| P1  | E2E 辅助抽取 + 任务生命周期集成测试（阶段 7 P7 主体）                         | —     |
| P2  | 异常场景测试：LLM 假端点、验证超时、存储损坏/锁、SIGINT、非 git 差异          | P1    |
| P3  | 权限控制进程级测试（只补缺口）                                                | P1    |
| P4  | Prompt 优化 + `prompts.test.ts`                                               | P1    |
| P5  | 上下文优化 + `context-manager`/`repo-map` 测试 + CLI 裁剪统计                 | P1    |
| P6  | 文档：README、architecture、testing.md、phase-7 回填、CHANGELOG、.env.example | P2-P5 |
| P7  | `scripts/verify.js` 阶段 8、覆盖率阈值、版本 1.0.0                            | P1-P6 |
| P8  | 全量验收：门禁、覆盖率、verify、git diff、开发报告、阶段 8 验收回填           | P7    |

## 六、测试计划（必须真实执行）

### 6.1 新增单元测试

- **提示词**：系统/规划/修复关键约束；最大步骤插值；无示例密钥；JSON-only 指令
- **上下文**：头尾截断标记与长度；tool 消息配对；入参不变；极小预算移除仓库地图；
  `repoMapDropped`/计数统计
- **仓库地图**：`Top-level` 摘要；预算截断后摘要保留；空 workspace
- **异常补缺**：既有覆盖不足的错误分支（以缺口清单为准，不重复既有用例）

### 6.2 集成 / E2E

- 任务生命周期 10 组（4.2）
- 异常场景表（4.3），SIGINT 按平台可行性降级并记录
- 权限矩阵（4.4），只补现有测试未覆盖的进程级路径
- LLM 假端点：500 重试、429 不重试、超时、非法响应
- `tasks list/show` 只读与缺失任务

### 6.3 回归与验收门

- 阶段 1-7 全部既有用例通过；`zhipu-live` 默认跳过
- `pnpm typecheck` / `lint` / `format:check` / `build` / `test:coverage` 全绿
- 覆盖率报告实际值；达到阈值
- `pnpm verify` 全绿并包含任务可靠性演示
- 真实执行结果回填本文件第十节；未执行的测试不得描述为已通过

### 6.4 发布检查清单

- [x] 全量门禁与 `pnpm verify` 通过
- [x] 版本 `1.0.0`，README/CHANGELOG 一致
- [ ] 可选：`ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts`（本轮未执行，不消耗真实配额）
- [x] git diff 人工检查（无密钥、无本地路径、无调试残留）
- [x] 已知限制写入文档

## 七、安全验收用例

- E2E 全程只使用临时 workspace；测试不读取项目根 `.env`，不写入真实工作区
- 敏感文件读取/写入在进程级被拒绝且无副作用；`.env.example` 仍可读
- 符号链接逃逸（文件与目录）被拒绝；外部目标未被修改
- `git push`、灾难性命令硬拒绝；高风险命令非 TTY 拒绝；`--yes` 不放宽工具确认
- 验证命令同样经过分级/审批；`git push` 验证命令不执行
- 子进程环境不含密钥；验证输出、任务库、日志、stdout/stderr 均无密钥
- 任务库路径越界/敏感文件名在配置阶段拒绝；恢复任务 workspace 不一致拒绝
- 测试输出与文档中不出现真实密钥；真实端点测试仅从环境变量读取
- 不自动 commit / push；不消耗真实配额

## 八、风险与应对

| 风险                       | 说明                                         | 应对                                                        |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Windows 子进程测试慢/抖动  | 每个用例启动一次 Node + tsx                  | 控制用例数量、60s 超时、临时目录隔离、必要时同文件串行      |
| `.env` 污染测试            | 项目根 `.env` 可能配置真实 provider/验证命令 | 测试显式覆盖全部相关环境变量；不使用真实密钥                |
| 信号测试平台差异           | Windows 上 SIGINT 传播给子进程树不完全一致   | 能稳定通过则保留；否则降级为注入 AbortSignal 并记录平台限制 |
| Prompt 改动导致行为回归    | 模型行为无法离线量化                         | 只强化约束；不变量测试 + 全部既有 mock E2E 回归             |
| 上下文头尾截断丢失中间信息 | 中间可能是关键诊断                           | 保留明确标记与原始字符数；预算优先丢弃旧组而非新信息        |
| 覆盖率阈值导致门禁不稳定   | 新增模块多，阈值可能一开始达不到             | 先测后设；不达标补测试，不降低标准                          |
| 路线图/文档同步遗漏        | 多处阶段描述与现状不一致                     | P6 逐项核对 README/architecture/plan/verify 的阶段字样      |
| 真实供应商未自动回归       | 离线测试不能证明真实端点行为                 | 保留 opt-in 手工测试并写入发布清单；明确残余风险            |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件）
- [x] 代码变更（测试、Prompt、上下文、verify、文档、版本号）
- [x] 测试结果（真实执行数据，已回填第十节）
- [x] 风险说明
- [x] 完成情况
- [x] 文档更新（README、architecture、testing.md、阶段 7 回填、CHANGELOG）
- [x] git diff 检查
- [x] 开发报告
- [x] Coding Agent V1.0（版本 1.0.0）

## 十、验收结果（实施后回填）

验收日期：2026-11-16，Windows 10 / Node v20.18.1 / pnpm。以下均为本机真实执行输出。

### 10.1 验收门（`pnpm verify` 汇总）

| 门禁                     | 结果 | 耗时  |
| ------------------------ | ---- | ----- |
| 类型检查 `typecheck`     | PASS | 3.4s  |
| Lint                     | PASS | 8.1s  |
| 格式 `format:check`      | PASS | 3.0s  |
| 构建 `build`             | PASS | 2.7s  |
| 全量测试 `test:coverage` | PASS | 29.0s |

`node dist/cli/main.js --version` 输出 `1.0.0`；`git diff --check` 无空白错误。

### 10.2 测试统计

独立执行 `pnpm test:coverage`（全量，含覆盖率）：

- Test Files：`50 passed | 1 skipped (51)`
- Tests：`782 passed | 5 skipped (787)`（跳过项为 `zhipu-live` 等显式 opt-in 用例）
- 覆盖率：语句 95.55% / 分支 89.64% / 函数 100% / 行 95.55%，达到阈值 95/88/99/95

新增/强化的进程级集成矩阵（单独并行执行 5 个文件，34 用例，14.5s）：

| 文件                                       | 用例数 | 覆盖要点                                                       |
| ------------------------------------------ | ------ | -------------------------------------------------------------- |
| `tests/integration/task-lifecycle.test.ts` | 8      | 成功闭环、失败恢复、验证失败→修复、修复耗尽、`--no-plan`、密钥 |
| `tests/integration/failure-modes.test.ts`  | 6      | 验证超时、任务库损坏/被锁、TASK_NOT_FOUND、非 git 降级、SIGINT |
| `tests/integration/permissions.test.ts`    | 7      | 路径越界、符号链接、敏感文件、硬拒绝验证命令、覆盖确认等       |
| `tests/integration/llm-failure.test.ts`    | 4      | 500 重试、429 不重试、超时、非法响应（本地假端点）             |
| `tests/integration/run-plan.test.ts`       | 9      | 规划、写文件、审批、密钥不落日志、只读工具链路                 |

单元测试新增：`public-api`、`evaluator-diff-mock`、`package-info`、`prompts`、`context-manager`、
`repo-map`、`token-budget`、`ignore`、`approval-risk`、`child-env`、`shell`、`task-store/state`、
`plan-runner`、`repair`、`task-runner`、`tasks-command`、`write-tools`、`planner` 等。

### 10.3 `pnpm verify` 演示结果

汇总 35 项全部 PASS：5 道门禁 + REPL 5 项 + 规划演示 8 项 + 任务可靠性 7 项（含验证失败→
修复→再次验证→`tasks show`）+ `--plan-only`→`--resume` 6 项（断言 planned 首次执行
`resumes=0`）+ `step_failed`→`--resume` 4 项（断言 `resumes=1`）。全程 `LLM_PROVIDER=mock`、
空密钥、临时 workspace，未联网、未消耗配额。

### 10.4 实施中发现并修复的问题

1. **LLM 超时用例抖动**：覆盖率插桩与并行负载下 50ms 超时可能早于请求到达本地假端点；
   改为端点延迟 2000ms / 客户端超时 500ms，单独与全量均稳定通过。
2. **覆盖率未达阈值**：基线 94.67%；补充公共入口、差异采集错误分支、包信息读取失败等
   真实用例后达到 95.55%，未通过降阈值掩盖。
3. **Windows SIGINT 用例清理竞态**：`ENOTEMPTY` 删不掉 `logs/`。根因是 pino（sonic-boom）
   的 `destroy()` 走异步 `fsync→fs.close`，而 `rmSync` 的同步重试会阻塞事件循环，文件
   长时间处于 delete-pending；将测试 workspace 清理改为异步 `fs.promises.rm` 重试后稳定。
4. **恢复计数语义澄清**：planned 任务首次执行按设计不计 resume；演示拆分为
   `--plan-only→--resume`（断言 0）与 `step_failed→--resume`（断言 1），并同步修正本文 §4.8。
5. **类型检查夹具缺字段**：新增上下文统计/计划/差异字段后，测试夹具补齐
   `repoMapDropped`、`notes`、`reason`。

### 10.5 git diff 检查

- 扫描 `src`、`tests`、`docs`、`scripts`、README、CHANGELOG、`.env.example`：无 `sk-` 密钥、
  无本机绝对路径、无 `TODO`/`debugger` 调试残留。
- 未跟踪文件均为源码、测试与文档（无临时产物）；`coverage/`、`dist/`、日志与 `.env` 由
  `.gitignore` 排除。
- 按 AGENTS.md 约束未执行 commit / push，全部改动留在工作区待用户确认。

### 10.6 残余风险与 V1.0 已知限制

- sql.js 每次写事务导出整库：适合单任务规模，不做并发写。
- 非 git 工作区差异检查 `available=false`，只告警，不判任务失败。
- 恢复不保存半截 LLM 会话，失败步骤从头重跑（写工具仍受覆盖确认保护）。
- 真实供应商不在自动门禁内，保留 `ZHIPU_LIVE_TEST=1` 手工回归。
- Windows 上 SIGINT 用例以进程内注入信号验证中止与持久化，未验证真实 Ctrl+C 的进程树传播。
- 聊天 REPL 仍为纯对话，无工具调用与会话持久化（顺延至 V1.0 之后）。
