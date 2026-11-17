# 测试与发布验证

> 适用版本：Coding Agent V1.2（`1.2.0`）
> 原则：默认全离线；未真实执行的测试不写成已通过；进程级用例必须验证副作用，而不只断言提示文本。

## 一、测试分层

| 层       | 范围                                                                                         | 工具                                 | 依赖网络 |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| 单元     | config / logger / llm / tools / security / planner / agent / memory / evaluator / cli 纯逻辑 | vitest                               | 否       |
| 集成     | 模块协作、mock LLM 驱动的完整循环、任务生命周期                                              | vitest + mock provider               | 否       |
| 进程级   | 真实 CLI 子进程：退出码、stdout/stderr、任务库与文件副作用、锁与信号                         | vitest + `node:child_process`        | 否       |
| 真实端点 | 智谱 / OpenAI 兼容端点的协议与流式返回                                                       | vitest（`ZHIPU_LIVE_TEST=1` opt-in） | 是       |

```bash
pnpm test              # 全量单元 + 集成 + 进程级
pnpm test:coverage     # 覆盖率（阈值见 vitest.config.ts）
pnpm verify            # 门禁 + 全量测试 + 离线演示（REPL / 规划改码 / 任务可靠性）
```

## 二、离线保证

集成与进程级测试全部离线，可重复执行：

1. **临时 workspace**：`tests/integration/helpers.ts` 的 `createWorkspace()` 为每个用例创建独立
   临时目录，`afterEach` 带重试删除（Windows 文件句柄）。不写入项目真实工作区。
2. **显式环境基线**：`helpers.ts` 的 `baseEnv()` 覆盖所有会改变行为的变量（provider、密钥、
   模型、预算、超时、任务库、验证命令、mock 脚本等），因此**不读取项目根 `.env`**。
3. **mock provider**：`LLM_PROVIDER=mock` + `AGENT_MOCK_SCRIPT` 按步回放响应；规划模式下第一
   步是规划响应，其后是各步骤与修复轮次的响应。
4. **本地假端点**：`tests/integration/llm-failure.test.ts` 用 `node:http` 起临时服务，验证重试、
   429 不重试、超时与非法响应；请求只发往 `127.0.0.1`。
5. **无真实密钥**：测试中的密钥均为明显的假值（如 `test-key-value`），并断言它们不出现在
   stdout / stderr / 日志 / 任务库中。
6. **真实端点测试默认跳过**：`zhipu-live.test.ts` 仅在显式设置 `ZHIPU_LIVE_TEST=1` 时执行，
   密钥只从 `.env` / 进程环境读取。

## 三、任务生命周期矩阵

文件：[`tests/integration/task-lifecycle.test.ts`](../tests/integration/task-lifecycle.test.ts)

| 场景                | 驱动方式                                                 | 关键断言                                                             |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| 成功闭环            | 规划 → `write_file` → 显式验证通过 → 回答                | 退出 0；`task completed`；任务 `completed`；文件内容；验证 `passed`  |
| 步骤失败与恢复      | 两步计划，首步迭代耗尽；第二次 `--resume` 不消费规划响应 | 首次 `step_failed` 且保留已完成前缀；恢复 `resumeCount=1`；最终完成  |
| 验证失败 → 修复成功 | 验证命令检查文件内容；首轮失败，修复脚本改写文件         | 退出 0；`repair 1/1`；任务 `repairs=1`；文件为修复后内容             |
| 修复耗尽            | 验证始终失败，`AGENT_MAX_REPAIR_ATTEMPTS=1`              | 退出 1；任务 `failed`；输出含 `verification: failed` 与恢复提示      |
| `--no-plan`         | 直接工具循环                                             | 不创建任务库；退出 0；保留直接模式汇总                               |
| `--no-verify`       | 关闭验证                                                 | 任务 `completed`；验证记录 `skipped`；验证命令未执行                 |
| 密钥不落库          | `LLM_API_KEY=<secret>`，验证命令打印同值文本             | 密钥不出现在 stdout/stderr/日志/任务库/验证输出；输出为 `[REDACTED]` |
| 极小上下文预算      | `AGENT_CONTEXT_BUDGET_TOKENS` 极小 + 大文本 fixture      | 任务仍完成；stdout 含 `context trimmed: dropped=... truncated=...`   |

任务库读取统一使用 `createTaskStore({ readOnly: true })`，用完 `close()`；不手写 SQL，
也不直接修改数据库文件。

## 四、异常场景矩阵

文件：
[`tests/integration/failure-modes.test.ts`](../tests/integration/failure-modes.test.ts)、
[`tests/integration/llm-failure.test.ts`](../tests/integration/llm-failure.test.ts)

| 类别 | 场景                          | 测试文件                | 预期                                                       |
| ---- | ----------------------------- | ----------------------- | ---------------------------------------------------------- |
| LLM  | 第一次 500，第二次成功        | `llm-failure.test.ts`   | 重试后成功；请求数 2；退出 0                               |
| LLM  | 429 + 业务码 1113（配额耗尽） | `llm-failure.test.ts`   | 不重试；退出 1；错误含配额提示；不含密钥                   |
| LLM  | 请求超时                      | `llm-failure.test.ts`   | 退出 1；错误分类为超时；不含密钥                           |
| LLM  | 非法响应体                    | `llm-failure.test.ts`   | 不重试；退出 1；错误可读                                   |
| 验证 | 验证命令超时                  | `failure-modes.test.ts` | 任务 `failed`；`timedOut=true`；进程树被终止               |
| 存储 | 任务库文件损坏                | `failure-modes.test.ts` | 退出 1；存储错误；原文件字节未被覆盖；无残留锁             |
| 存储 | 第二个写进程并发              | `failure-modes.test.ts` | 退出 1；锁错误（含持有 PID）；任务库未被创建/覆盖          |
| 存储 | `--resume` 不存在或非法 ID    | `failure-modes.test.ts` | 退出 2；`task not found`                                   |
| 中止 | 运行中收到 SIGINT             | `failure-modes.test.ts` | 中止错误；任务 `aborted`；可恢复                           |
| 差异 | 非 git 工作区                 | `failure-modes.test.ts` | `diff: unavailable (not a git repository)`；任务不因此失败 |

循环保护（`max_iterations`、重复调用、连续失败）由既有单元测试与步骤失败 E2E 覆盖，不再重复造进程级用例。

## 五、权限控制矩阵

文件：[`tests/integration/permissions.test.ts`](../tests/integration/permissions.test.ts)
以及既有单元/集成覆盖（`security.test.ts`、`write-tools.test.ts`、`run-command.test.ts`、
`approval-risk.test.ts`、`run-plan.test.ts`）。

| 权限点         | 用例                                                          | 断言                                                      |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| 路径穿越       | `write_file ../<unique>-escape.txt`                           | `TOOL_DENIED`；workspace 外文件不存在                     |
| 敏感文件写     | `.env`、`.git/config`、`credentials.json`                     | 均 `TOOL_DENIED`；文件不存在                              |
| 符号链接逃逸   | workspace 内链接目录指向外部，读 `secret.txt`、写 `pwned.txt` | 均拒绝；外部密钥未被打印；外部文件未被创建                |
| 任务库路径     | `AGENT_TASK_DB=../outside.db` / `.env`                        | 退出 2；提示越界或敏感文件；不创建外部文件                |
| 恢复一致性     | 把任务库复制到另一 workspace 后 `--resume`                    | 退出 2；`task workspace does not match current workspace` |
| 验证命令硬拒绝 | `--verify "git push origin main"`                             | 任务失败；`command denied`；子进程未执行                  |
| 验证高风险     | `--verify "git clean -fd"`（非 TTY）                          | 任务失败；`high-risk action denied (non-interactive)`     |

既有覆盖（不重复）：

- 覆盖非空文件需确认，`--yes` 不放宽工具级确认（`run-plan.test.ts` / `write-tools.test.ts`）
- `git push`、`sudo`、`shutdown`、`mkfs` 等命令硬拒绝（`approval-risk.test.ts` / `run-command.test.ts`）
- 子进程环境删除密钥类变量，命令输出与日志不含密钥（`child-env.test.ts` / `run-command.test.ts`）

### 平台说明

- 符号链接用例在用例文件加载时探测 `symlinkSync` 能力；Windows 无权限时使用 `it.skipIf` 跳过，
  不会伪装成通过。
- SIGINT 用例采用**进程内信号注入**：spy stdout，等待出现首个 `run_command` 轨迹后调用
  `process.emit('SIGINT')`。原因是 Windows 上对子进程 `kill('SIGINT')` 可能直接终止进程，
  无法保证优雅中止与任务状态落库。这是已知平台差异，不影响 CLI 自身对 `Ctrl+C` 的处理逻辑。

## 六、Web 界面测试（V1.1）

Web 层（`src/web/`）全部通过 HTTP/Session API 驱动，进程内起服务 + mock 脚本，不联网。

| 文件                                         | 覆盖内容                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/web-server.test.ts`（27 项）     | token 生成格式、Host/静态白名单、405 矩阵、413/400 请求体边界、SSE 快照帧、clientError、close 二次拒绝                 |
| `tests/unit/web-session.test.ts`（11 项）    | 状态机迁移、busy 互斥、Plan/确认批准与拒绝、确认超时自动拒绝、运行中与决策等待时中止、步骤迭代超限、修复轮、订阅者异常 |
| `tests/unit/serve.test.ts`（2 项）           | `serveCommand` 启动后健康检查可用、close 释放端口、端口占用时抛错                                                      |
| `tests/integration/web-flow.test.ts`（4 项） | SSE 全事件流闭环、高风险确认批准落盘、确认拒绝不落盘、等待 Plan 时中止无任务记录                                       |

关键行为断言：

- SSE 快照首帧先于增量事件；增量事件载荷为事件数据本身（非事件信封）。
- 覆盖非空文件才触发高风险确认；中止等待决策等价于拒绝，不产生任务副作用。
- 会话失败路径：规划 zod 失败 → 快照 `error` 与 `session_done.error` 一致。
- `serveCommand` 测试通过 `onStarted` 句柄在进程内接管服务；SIGINT 分支依赖真实进程信号，
  以 `/* v8 ignore */` 标注（进程内测试无法触发 `process.exit`）。

## 七、Prompt 与上下文回归

| 文件                                  | 覆盖内容                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `tests/unit/prompts.test.ts`          | 系统 / 规划 / 修复提示的关键约束（JSON-only、步骤上限、路径与安全禁令）  |
| `tests/unit/context-manager.test.ts`  | 头尾截断标记、原始长度、tool 配对、入参不变、统计累计、极小预算移除概览  |
| `tests/unit/repo-map.test.ts`         | 顶层目录摘要、预算截断后摘要保留、空 workspace、非法 `package.json` 降级 |
| `tests/unit/task-runner.test.ts`      | 验证/修复/恢复编排、修复耗尽、静态改动跳过、显式中止与状态持久化         |
| `tests/unit/evaluator-verify.test.ts` | 验证命令分级/审批、超时、输出截断与脱敏                                  |
| `tests/unit/evaluator-diff.test.ts`   | git 快照解析、baseline 增量、静态改动判定、非 git 降级                   |

提示词测试锁定“不变量”而非整段快照，避免无意义抖动；上下文测试断言协议字段（`toolCallId`）
与统计值，不依赖具体日志格式。

## 八、覆盖率与门禁

- `pnpm typecheck`：`tsc --noEmit`，0 error
- `pnpm lint`：eslint（type-checked），0 error
- `pnpm format:check`：prettier 校验
- `pnpm build`：编译到 `dist/`
- `pnpm test:coverage`：全量测试 + 覆盖率阈值
- `pnpm verify`：上述门禁 + 全量测试 + 离线演示

覆盖率阈值以 `vitest.config.ts` 中的实际配置为准（语句/行目标 ≥95%，分支按实测结果设定）；
不通过补测试，不通过降阈值掩盖。

## 九、真实端点手工回归（可选）

```bash
ZHIPU_LIVE_TEST=1 pnpm exec vitest run tests/integration/zhipu-live.test.ts
```

- 需要 `.env` 中配置真实 `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
- 会产生费用、消耗配额；不作为 CI 门禁
- 失败时先核对端点类型（Coding Plan 与按量计费端点不可混用）与配额，再判断代码问题

## 十、V1.1 发布检查清单

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` 全绿
- [x] `pnpm test:coverage` 全绿且达到阈值（2026-11-16：828 通过，覆盖率 95.59/89.97/99.74/95.59）
- [x] `pnpm verify` 全绿（含任务验证/修复/恢复演示，35 项 PASS）
- [x] `package.json` 版本为 `1.1.0`，README / CHANGELOG 一致
- [x] `git diff` 人工复核：无密钥、无本机绝对路径、无调试残留、无未跟踪临时文件
- [ ] 可选：真实端点手工回归（`ZHIPU_LIVE_TEST=1`；会消耗配额，本轮未执行）
- [x] Web 界面浏览器人工验收（token 登录、发任务、SSE 实时事件、Plan/确认、中止、任务查询）
- [x] 已知限制已写入 README

## 十一、V1.2 发布检查清单（阶段 9.2）

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` 全绿
- [x] `pnpm test:coverage` 全绿且达到阈值（2026-11-17：848 项，843 通过 / 5 跳过；覆盖率 95.57/90/99.75）
- [x] `pnpm verify` 全绿（5/5 门禁 + 离线演示全项 PASS）
- [x] `package.json` 版本为 `1.2.0`，README / CHANGELOG 一致
- [x] `git diff` 人工复核：无密钥、无本机绝对路径、无调试残留
- [x] 新增配置 `AGENT_CONFIRM_TIMEOUT_MS` / `AGENT_VERIFY_SKIP_STATIC` 已写入 `.env.example` 与 README
- [x] CLI 人工验收：静态改动跳过验证、失败验证输出尾部可查、非交互确认超时自动拒绝
- [x] Web 浏览器人工验收：确认超时气泡与自动拒绝标记、验证失败输出折叠、结束文案区分
- [ ] 可选：真实端点手工回归（`ZHIPU_LIVE_TEST=1`；会消耗配额，本轮未执行）
