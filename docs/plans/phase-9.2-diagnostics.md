# 阶段 9.2 开发 Plan：任务失败可诊断性（验证输出 / 确认超时 / 验证减负 / 状态文案）

> 状态：已实施（验收通过，见第八节）
> 日期：2026-11-17
> 类型：可观测性与防护增强（evaluator / agent / cli / web / config / 前端）
> 前置：阶段 9.1 已验收；触发场景：任务 cca4ef18（编辑 demo.html 成功，但 `pnpm test` 失败 → 修复循环被 58 分钟人工确认卡住 → max_iterations）

## 一、问题回顾（真实数据）

任务 `cca4ef18-a2d6-40f0-a531-b38a75d020af`（workspace=D:\my-coding-agent）：

- 3 个步骤全部 completed，`write_file` 成功写入 demo.html
- 收尾验证 `pnpm test` 于 09:59:36 exit=1（43.8s）→ 触发自动修复
- 修复中一条 `run_command` 被判高风险，等待页面确认 **58 分钟**（工具时长 3505037ms，
  实际命令仅 67ms 且 exit=1）→ 修复 8 次迭代耗尽 → `repair stopped: max_iterations`
- 现状缺口：验证失败原因（哪条测试挂、输出是什么）没有出现在 CLI/Web/日志里，
  任务记录里其实已持久化 `output`，但没有任何入口展示

## 二、范围（用户批准的 4 点）

1. **验证输出可诊断**：失败时把验证命令输出尾部展示到 CLI `tasks show`、Web 事件气泡与
   历史详情、日志
2. **确认超时**：高风险确认增加可配置超时（默认 5 分钟），超时自动拒绝，避免修复循环被挂死
3. **验证减负**：默认 `pnpm test` 在"仅静态资源改动"或"无可见文件变化"时自动跳过
   （可配置关闭），避免改一个 html 触发全仓 55 个测试文件
4. **状态文案区分**：Web 端把"步骤已完成但验证/修复失败"与普通失败区分展示

### 不做（OUT）

- 不做验证命令的智能 scoping（如 vitest related）、不改验证失败后的重试策略
- 不改 SSE 协议结构（仅新增 `confirm_timeout` 事件类型与前端展示）
- 不改变任务状态机、不自动 replan、不引入新依赖

## 三、技术设计

### 3.1 验证输出（P1）

- `src/evaluator/verify.ts`：日志在失败/超时时追加 `outputChars` 与 `outputTail`
  （末尾 600 字符，已脱敏）
- `src/cli/commands/tasks.ts`：`verifications` 段失败项追加 `reason` 与输出尾部（≤1200 字符）
- `src/web/public/app.js`：
  - `verification` 事件失败时气泡内折叠展示输出尾部（≤1500 字符）
  - 历史手风琴验证段同样追加输出尾部
- 存储层不变（`task_verifications.output` 已有且经 `formatOutput` 限长 12K）

### 3.2 确认超时（P2）

- 新配置 `AGENT_CONFIRM_TIMEOUT_MS`：1000–3_600_000，默认 `300000`
- 仅约束**高风险操作确认**（Plan 审批不受影响，用户审阅计划的时间不应被限）
- CLI（`src/cli/confirm.ts`）：`Promise.race` 加计时器；超时打印
  `no response within Ns — auto-denied`，关闭 readline 并返回 false
- Web（`src/web/session.ts`）：confirm 挂起时启动计时器；超时 emit
  `confirm_timeout { timeoutMs }`、状态回到 running、resolve(false)；`decide/abort/reset`
  清理计时器
- 前端：`confirm_timeout` 事件追加提示气泡"确认超时，已自动拒绝"，并撤掉按钮

### 3.3 验证减负（P3）

- 新配置 `AGENT_VERIFY_SKIP_STATIC`（默认 true）
- 仅当同时满足时跳过（写入 verification 记录，状态 `skipped`）：
  - 验证命令为默认值 `pnpm test` 且处于 autoSkip 模式（未显式配置 `AGENT_VERIFY_COMMAND`）
  - diff 可用，且（a）无文件变化，或（b）全部变化文件为静态资源：
    `.md .markdown .html .htm .css .scss .less .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2`
  - 跳过原因写入 `reason`：`no detectable file changes` / `static-only changes (N files)`
- `task-runner` 调整：验证前先采集当前 diff，用于跳过判定并直接作为本次记录的快照
  （原先是验证后再采 diff，语义基本一致，减少一次 git 调用）
- 注意：`.txt` 不算静态资源，避免既有测试夹具（hello.txt）行为变化

### 3.4 状态文案（P4）

- 前端跟踪 `planTotal / completedSteps / lastVerificationFailed`
- `session_done` 且 error、且"全部步骤完成 + 最近一次验证失败"时：
  标题改为 `任务未通过：步骤已完成，但验证失败`，正文附错误与"展开左侧历史查看验证输出"
- 其余失败保持 `任务失败`

## 四、任务分解

| #   | 任务                                                          | 依赖  |
| --- | ------------------------------------------------------------- | ----- |
| P1  | 配置字段（confirmTimeoutMs / verifySkipStatic）+ .env.example | —     |
| P2  | verify.ts 输出日志 + isStaticOnlyDiff + task-runner 策略接线  | P1    |
| P3  | CLI：confirm 超时 + tasks show 输出尾部                       | P1    |
| P4  | Web：session confirm 超时 + 前端三类展示（输出/超时/文案）    | P2-P3 |
| P5  | 测试补齐（config/verify/cli/run-task/web-session/tasks）      | P2-P4 |
| P6  | 文档 + 版本 1.2.0 + 门禁 + 浏览器验收 + 报告                  | P5    |

## 五、测试计划

- 单元：`isStaticOnlyDiff` 矩阵（静态/混合/空/不可用）；任务静态改动跳过验证、
  混合改动正常验证、`verifySkipStatic=false` 关闭跳过；CLI 确认超时自动拒绝；
  Web 会话确认超时事件与状态
- 命令级：`tasks show` 打印失败验证输出尾部
- 回归：既有 run/run-task/web-session 测试不降级；`pnpm verify` 35 项全绿
- 浏览器验收（mock provider）：验证失败任务展示输出、超时提示气泡、失败文案区分

## 六、风险

| 风险                                   | 应对                                            |
| -------------------------------------- | ----------------------------------------------- |
| 静态跳过隐藏真实回归                   | 可配置关闭；跳过原因显式展示；.txt/配置类不豁免 |
| 确认超时误伤慢用户                     | 默认 5 分钟且可调；超时仅拒绝、任务可重跑       |
| task-runner 采集 diff 前移影响既有断言 | 保持记录内容不变，跑全量测试回归                |

## 七、交付清单

- [x] Plan 文件（本文件）
- [x] 代码变更
- [x] 测试结果（回填第八节）
- [x] 文档更新（README / CHANGELOG 1.2.0 / architecture / testing / .env.example）
- [x] git diff 检查与开发报告

## 八、验收结果（实施后回填）

### 8.1 门禁

| 门禁                 | 结果                                                     |
| -------------------- | -------------------------------------------------------- |
| `pnpm typecheck`     | PASS                                                     |
| `pnpm lint`          | PASS                                                     |
| `pnpm format:check`  | PASS                                                     |
| `pnpm build`         | PASS                                                     |
| `pnpm test:coverage` | PASS（848 项：843 通过 / 5 跳过；覆盖率 95.57/90/99.75） |
| `pnpm verify`        | PASS（5/5 门禁 + 离线演示全项通过）                      |

### 8.2 CLI 验收（mock provider）

- 静态改动（仅 `style.css`）：默认验证被跳过，输出 `verification: skipped (static-only changes (1 files))`，
  任务记录 `reason=static-only changes (1 files)`。
- 显式失败验证（`node -e "console.error('boom verify output'); process.exit(1)"`）：
  `tasks show` 展示 `reason: exit code 1` 与输出尾部 `[stderr] boom verify output`。
- 高风险确认超时（`AGENT_CONFIRM_TIMEOUT_MS=1000`，非交互运行）：打印
  `no response within 1s — auto-denied`，按拒绝处理且不产生文件副作用。

### 8.3 浏览器验收（serve + mock，端口 3211）

- Plan 气泡批准后进入 `awaiting_confirm`，1s 后出现 `确认超时（1s 未响应，已自动拒绝）`
  气泡且按钮禁用、标记 `✗ 超时自动拒绝`，任务继续后续步骤。
- 验证失败气泡展示 `验证 failed — exit code 1`，折叠区“验证失败详情（含输出尾部）”
  展示 `[stderr] boom verify output`。
- 任务结束文案为 `任务未通过：步骤已完成，但验证失败`，与普通 `任务失败` 区分；
  左侧任务历史手风琴验证段展示 `reason` 与输出尾部。

> 验收中发现并修正：原文案“编辑已生效，但验证失败”在高风险操作被拒绝（无 diff）时属于
> 过度断言，改为“步骤已完成，但验证失败”，与用户第 4 点表述一致。

### 8.4 残留风险

- 静态跳过基于扩展名白名单，新增静态类型需同步维护；`.txt`/配置类不豁免。
- 确认超时对“超慢但有效的审阅”会直接拒绝，需通过 `AGENT_CONFIRM_TIMEOUT_MS` 调整。
- 输出尾部固定截断，极长错误需结合日志文件定位。
