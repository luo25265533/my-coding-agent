# Changelog

本项目遵循语义化版本。V1.0 之前按开发阶段推进，阶段 8 收尾为 `1.0.0`，阶段 9 收尾为 `1.1.0`，
阶段 9.2 收尾为 `1.2.0`。

## [1.2.0] - 2026-11-17

阶段 9.2：可诊断与防挂起——验证失败可定位、高风险确认不再无限期等待、静态改动不再触发
全仓回归、Web 失败文案区分执行阶段。

### Added

- **验证输出可见**：验证命令失败/超时时，日志记录 `outputChars` 与输出尾部（≤600 字符，
  脱敏后）；`tasks show` 展示失败/跳过验证的 `reason` 与输出尾部（≤1200 字符）；Web 验证
  失败气泡可折叠查看输出尾部（≤1500 字符），任务历史手风琴同样展示。
- **`AGENT_CONFIRM_TIMEOUT_MS`**（1000–3600000，默认 300000）：高风险操作确认等待上限。
  CLI 超时打印 `no response within Ns — auto-denied` 并按拒绝处理；Web 发出
  `confirm_timeout {timeoutMs}` 事件、气泡标记“超时自动拒绝”并继续执行。Plan 审批不受此限制。
- **`AGENT_VERIFY_SKIP_STATIC`**（默认 `true`）：默认验证命令在改动仅涉及静态资源
  （`.md`/`.html`/`.css`/`.svg`/图片/字体等）或无可检测改动时跳过，原因写入验证记录
  （`static-only changes (N files)` / `no detectable file changes`）。任务在验证前采集 diff。

### Changed

- `runTask` 先采集 diff 再执行验证，验证跳过判定与修复循环共享同一份最新差异。
- Web 任务结束文案区分“任务未通过：步骤已完成，但验证失败”（所有步骤完成且验证失败）
  与普通失败，并提示展开左侧历史查看输出。
- 显式指定的验证命令（`--verify`、显式 `AGENT_VERIFY_COMMAND`）始终执行，不参与静态跳过。

### Security

- 验证输出在落库、日志与 Web 展示前均经过值级脱敏；输出尾部有固定长度上限。
- 确认超时按拒绝处理，与现有“非交互直接拒绝”语义一致；`git push` 等硬拒绝规则不变。

### Tests

- 新增覆盖：配置默认值与边界（`AGENT_CONFIRM_TIMEOUT_MS` / `AGENT_VERIFY_SKIP_STATIC`）、
  `isStaticOnlyDiff` 判定矩阵、任务静态跳过/混合改动/显式命令、CLI 确认超时（假计时器）、
  Web 会话确认超时与 `confirm_timeout` 事件、`tasks show` 失败输出尾部。
- 全量 848 项（843 通过 / 5 跳过）；覆盖率 95.57% 语句/行、90% 分支、99.75% 函数。

## [1.1.0] - 2026-11-16

阶段 9：本地 Web 网页操作界面——浏览器发任务、实时看执行、批准 Plan 与高风险确认、中止、任务查询。

### Added

- **`serve` 命令**：加载配置后在本机启动 Web 服务，打印带 token 的完整 URL；
  `AGENT_WEB_PORT`（默认 3210）/ `AGENT_WEB_HOST`（仅 127.0.0.1/localhost）可配。
- **Web 服务层（`src/web/`）**：
  - `server.ts`：静态单页 + `/api/*`。所有 API 强制 `x-agent-token`（启动时生成的 128 位
    随机 token）；Host 白名单阻断 DNS rebinding；静态文件名白名单 + resolve 双保险防穿越；
    JSON 请求体 ≤1MB（413/400 区分）；15s SSE 心跳。
  - `session.ts`：`RunSession` 状态机（idle → running → awaiting_plan/awaiting_confirm →
    finished），单任务互斥（409），事件缓冲（上限 5000，溢出丢弃计数），挂起决策的批准/拒绝，
    中止（含解除挂起决策），只读任务查询（每次调用新开只读 sql.js store）。
  - API：`GET /api/health`、`GET /api/events`（SSE，快照 + 增量）、`POST /api/run`、
    `POST /api/plan|/api/confirm`、`POST /api/abort`、`GET /api/tasks`、`GET /api/tasks/:id`。
  - 前端单页（原生 HTML/CSS/JS）：token 输入与 `?token=` 自动登录、状态徽章、事件流、
    Plan 卡片与决策按钮、任务列表/详情，fetch+ReadableStream 解析 SSE，断线 2s 自动重连。
- **run 事件化改造**：`RunEventSink`（`src/cli/run-events.ts`）+ `RunOptions.config` 注入
  （宿主可跳过环境变量/.env 解析）+ 外部 AbortSignal；CLI 不传 sink 时行为不变。

### Changed

- `runCommand` 事件外发与中止信号外置，为宿主（Web）复用完整执行链路提供入口；
  执行逻辑与 CLI 输出不变。

### Security

- Web 仅监听回环地址；token 校验覆盖全部 `/api/*`；Host 校验、静态白名单、请求体上限；
  单任务互斥防止并发写任务库。
- `pnpm verify` 的全量测试 gate 改为只匹配 vitest 汇总行（先剥离 ANSI 颜色码），
  避免测试日志中的业务文本（如 `step s1 failed`）误判。

### Tests

- 新增 `tests/unit/web-server.test.ts`（27 项：API 矩阵、SSE 快照帧、405/409/413/400 边界、
  clientError、token 生成）、`tests/unit/web-session.test.ts`（11 项：状态机、决策、中止、
  步骤失败、修复、订阅者异常）、`tests/unit/serve.test.ts`（启动健康检查 + 端口占用报错）、
  `tests/integration/web-flow.test.ts`（4 项端到端：完整流、确认批准/拒绝、等待 Plan 时中止）。
- 全量 828 测试通过；覆盖率 95.59% 语句/行、89.97% 分支、99.74% 函数（阈值 95/88/99 不降）。

### Known limitations

- Web 为本地单用户设计：token 明文出现在 URL 与 localStorage，无 HTTPS/多用户/会话历史回放。
- SSE 只推状态与摘要（工具结果预览 ≤400 字符）；`tokens` 事件在规划模式下不产生。
- `serve` 从当前工作目录读取 `.env`，与 CLI `run` 一致；宿主需注入配置时应使用
  `RunOptions.config` 跳过 `.env` 解析。

### Changed（阶段 9.1，2026-11-17）

- 前端改版为对话式布局（仅 `src/web/public/` 三个文件，后端 API 与 SSE 协议零变更）：
  - 任务历史移至左侧 300px 侧栏，标题 2 行截断（`-webkit-line-clamp:2`），详情手风琴
    默认收起、点击懒加载展开/收起
  - 运行事件改为双气泡对话流：用户任务靠右（accent 背景），Agent 事件靠左按 kind 着色，
    工具调用参数/结果默认折叠，最终回答绿色强调；发任务操作台停靠右侧底部
  - 决策按钮移入 Plan/确认气泡内，决策后禁用并保留 "✓ 已批准 / ✗ 已拒绝" 标记
- 刷新快照回放仅重建 Agent 侧气泡（用户提交气泡不进 SSE 事件流，属已知限制）。

## [1.0.0] - 2026-11-16

Coding Agent V1.0：从零实现的 TypeScript Single Coding Agent，手写核心循环，不依赖编排框架。

### Added

- **LLM 抽象层**：`LLMProvider` 契约、mock（可脚本化）与 OpenAI 兼容 provider（手写 fetch、
  SSE 流式、超时、重试、429 配额判定）、`chat` 多轮 REPL。
- **工具与沙箱**：`read_file` / `list_files` / `search_code` / `find_files` / `write_file` /
  `edit_file` / `run_command`；zod 参数校验与 JSON Schema 生成；PathGuard 读写沙箱、
  敏感文件规则、忽略规则、命令风险分级与审批、子进程环境净化。
- **Agent 核心**：单任务工具循环、结束判定、重复调用与连续失败熔断、迭代预算与中止。
- **上下文管理**：项目概览注入、启发式 token 预算、整组丢弃、工具输出头尾保留截断、
  顶层目录摘要、极小预算移除概览、裁剪统计与日志。
- **规划与执行**：Plan 生成与 zod/语义校验、失败自动修复一次、逐步执行、确认交互、
  写工具与命令执行。
- **任务可靠性**：sql.js 任务库（计划、步骤、验证、差异、事件）、显式状态机、单写者锁、
  原子快照、`--resume` 已完成步骤前缀恢复、验证命令执行与输出脱敏、git 差异检查、
  验证失败后的有界自动修复、`tasks list|show` 只读查看。
- **离线验收**：进程级 E2E 辅助与任务生命周期、LLM 异常、存储异常、SIGINT、权限矩阵测试；
  `pnpm verify` 一条命令跑门禁与 mock 演示。

### Changed

- `run` 默认流程升级为：规划 → 确认 → 任务落库 → 逐步执行 → 验证 →（可选）修复 → 汇总；
  `--no-plan` 保留轻量直接循环。
- 提示词结构化：系统提示按安全/工作流/工具/完成条件组织；规划与修复提示补充可执行性、
  最小改动、不重跑已完成步骤等约束，并新增不变量测试。
- 上下文裁剪从“只保留头部”改为头尾保留，避免丢失命令末尾错误信息。
- README、architecture 路线图、`.env.example` 与 `docs/testing.md` 对齐 V1.0；阶段 8 重定义为
  Release，原阶段 9 并入，聊天会话持久化顺延。

### Security

- 文件访问限制在 workspace 内；绝对路径、`..` 与符号链接逃逸均拒绝；写入校验最近存在祖先的
  realpath。
- 敏感文件读写拒绝；日志、验证输出、任务库与修复提示均做脱敏；子进程环境移除密钥类变量。
- 高风险命令必须确认，非 TTY 拒绝；`git push`、`sudo`、`shutdown`、`mkfs` 等硬拒绝；
  验证命令使用同一套分级与审批。
- 恢复任务校验 workspace 一致性；任务库损坏时报告错误且不覆盖原文件；写模式单写者锁。
- 不自动执行 `git commit` / `git push`，不自动发布。

### Tests

- 默认套件完全离线：mock provider + 临时 workspace + 本地假 HTTP 端点。
- 覆盖成功、失败、恢复、修复、异常、权限与脱敏路径；真实端点仅通过
  `ZHIPU_LIVE_TEST=1` 手工执行。
- 详细矩阵与发布检查清单见 [docs/testing.md](docs/testing.md)。

### Known limitations

- `chat` 不调用工具，也不持久化历史（后续版本）。
- 不做自动 replan；自动修复仅针对验证失败。
- 非 git 工作区无法做差异检查。
- 任务库为单进程单写者，sql.js 每次写事务重写整库。
- 安全依赖应用层沙箱与分级，不是 OS 级容器隔离。
- Windows 下进程级 SIGINT 测试采用进程内信号注入（平台信号语义差异）。
