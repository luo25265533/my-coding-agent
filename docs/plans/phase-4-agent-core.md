# 阶段 4 开发 Plan：Agent Core 加固（多步任务闭环）

> 状态：已完成（2026-11-16，用户确认后实施）
> 日期：2026-11-16
> 范围：模型决策循环加固 / 结束判定 / 循环熔断 / 异常处理 / 多步任务验证
> 交付：能够自主、可靠地完成多步任务的 Agent

## 一、现状分析

阶段 3 已交付最小 `runAgentLoop`，你列的五项需求已有基础实现：

| 需求         | 现状                                                                          | 阶段 4 增量                                       |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| 模型决策循环 | 每轮 `provider.chat({messages, tools})`，工具串行执行，结果以 `tool` 消息回填 | 增加循环不变量与统一退出路径                      |
| 工具结果处理 | `dispatchToolCall` 归一化 `TOOL_*` 错误，模型可自我纠正                       | 增加「连续失败」判定                              |
| 最大执行次数 | `AGENT_MAX_ITERATIONS`（默认 20），超限返回 `max_iterations`，CLI 退出 1      | 保持，并与其他停止原因统一处理                    |
| 异常处理     | 工具业务错误不中断循环；中止信号透传；provider 错误冒泡                       | 增加重复调用熔断；新增 provider 异常传递测试      |
| 任务结束判断 | 仅「无工具调用」即视为答案；空答案也会被当成成功                              | 非空答案 + `finish_reason` 校验；新增多种停止原因 |

**结论**：阶段 4 不做重复实现，而是在现有循环上补齐健壮性、可诊断性与多步任务的真实测试。

## 二、已确认决策（用户确认）

| 决策     | 选择                                                                |
| -------- | ------------------------------------------------------------------- |
| 范围     | **强化 Agent Core**：结束判定、循环熔断、CLI 错误映射、多步任务测试 |
| 循环熔断 | **连续失败 + 重复调用**；阈值默认 3，可通过配置调整                 |
| 完成信号 | **无工具调用且答案非空**；不引入 `finish` 工具，兼容现有协议与脚本  |

## 三、范围

### 3.1 本次做（IN）

1. 扩展 `AgentStopReason`，覆盖全部正常/异常结束路径
2. 结束判定：无工具调用时区分 `answer` / `empty_answer` / `output_truncated`
3. 重复调用熔断：同一 `(name, arguments)` 连续出现达到阈值即停止
4. 连续失败熔断：连续 N 轮「所有工具调用均失败」即停止
5. 两个阈值进入配置：`AGENT_MAX_REPEATED_CALLS`、`AGENT_MAX_CONSECUTIVE_FAILURES`
6. CLI：所有非 `answer` 结束均打印统计后以退出码 1 结束，并给出可读原因
7. 单元测试：多步任务、空答案、截断、重复熔断、失败熔断、阈值覆盖、异常透传
8. 集成测试：真实子进程完成 3 步任务；重复调用与空答案的退出码与日志
9. 文档与验收报告

### 3.2 本次不做（OUT）

- 显式 `finish` 工具或「必须调用某工具才算完成」
- 写类工具、`bash`、权限确认（原路线图阶段 4 的内容，本阶段顺延）
- 上下文预算、压缩、planner、evaluator（阶段 5-7）
- 并行工具执行、子 Agent
- 会话持久化与断点续跑
- 真实端点大规模回归（仅保留既有 opt-in 用例）

## 四、技术设计

### 4.1 停止原因（`src/agent/loop.ts`）

```ts
export type AgentStopReason =
  | 'answer' // 无工具调用且答案非空
  | 'empty_answer' // 无工具调用但答案为空
  | 'output_truncated' // 无工具调用但 finish_reason === 'length'
  | 'repeated_tool_call' // 同一调用连续达到阈值
  | 'tool_failure_limit' // 连续多轮工具全部失败
  | 'max_iterations'; // 迭代预算耗尽
```

判定顺序（无工具调用的那一轮）：

```
content.trim() === ''            -> empty_answer
finishReason === 'length'        -> output_truncated
otherwise                        -> answer
```

`output_truncated` 优先于 `answer`，避免把被截断的答案当成成功交付。

### 4.2 重复调用熔断

- 签名：`name + '\n' + arguments`（原始 JSON 字符串，不做二次解析）
- 统计：连续相同签名计数；出现不同签名即重置为 1
- 阈值：`maxRepeatedCalls`（默认 3，最小 2）
- 触发时机：**执行前**判断。第 N 次相同调用不再执行，立即返回 `repeated_tool_call`
- 结果：`toolCalls` 只统计实际执行的调用；已执行的调用结果仍写入消息与回调

设计理由：只拦截「连续」重复，模型穿插不同工具时不会被误判；阈值 3 给模型留出重试空间。

### 4.3 连续失败熔断

- 统计单位是「轮」：某轮所有工具调用 `ok === false` 计 1 次；任一成功即清零
- 阈值：`maxConsecutiveFailures`（默认 3，最小 1）
- 触发时机：该轮所有工具执行完毕后判断，达到阈值返回 `tool_failure_limit`
- 与重复熔断相互独立；重复检查先于执行，失败统计在轮末

### 4.4 配置与选项

`AgentLoopOptions` 新增：

```ts
readonly maxRepeatedCalls?: number | undefined; // 默认 3
readonly maxConsecutiveFailures?: number | undefined; // 默认 3
```

`AppConfig.agent` 新增并接线到 CLI：

| 变量                             | 默认 | 范围  |
| -------------------------------- | ---- | ----- |
| `AGENT_MAX_REPEATED_CALLS`       | 3    | 2–100 |
| `AGENT_MAX_CONSECUTIVE_FAILURES` | 3    | 1–100 |

### 4.5 CLI（`src/cli/commands/run.ts`）

- `stopReason === 'answer'`：打印答案与统计，退出 0
- `stopReason === 'max_iterations'`：保持 `AgentMaxIterations` 错误，退出 1
- 其余停止原因：新增 `ErrorCode.AgentIncomplete`（`AGENT_INCOMPLETE`），消息包含原因与迭代数，退出 1
- 所有路径都先打印 `tokens: ...` 统计，再抛错，保留现场
- 日志记录 `stopReason`；不记录工具参数内容

### 4.6 错误码（`src/shared/errors.ts`）

新增 `AgentIncomplete: 'AGENT_INCOMPLETE'`，映射 `ExitCode.RuntimeError`。

## 五、任务分解

| #   | 任务                                                | 依赖  |
| --- | --------------------------------------------------- | ----- |
| P1  | `AgentStopReason` + 结束判定（空答案/截断）         | —     |
| P2  | 重复调用熔断 + 阈值选项                             | P1    |
| P3  | 连续失败熔断 + 配置字段（schema/load/.env.example） | P2    |
| P4  | CLI 停止原因映射与日志                              | P3    |
| P5  | 单元 + 集成测试（含多步任务）                       | P1–P4 |
| P6  | 覆盖率、验收门、文档、开发报告                      | P5    |

## 六、测试计划（必须真实执行）

- **结束判定**：正常答案；空字符串/纯空白 → `empty_answer`；`finish_reason=length` → `output_truncated`
- **重复熔断**：同一调用重复 3 次 → `repeated_tool_call`，只执行 2 次；穿插不同调用不误判；阈值改为 2 生效
- **失败熔断**：连续 3 轮全部失败 → `tool_failure_limit`；中间出现成功清零；阈值改为 1 立即触发
- **多步任务**：`list_files → search_code → read_file → answer` 共 4 轮，断言消息序列、`iterations=4`、`toolCalls=3`
- **异常透传**：provider 抛非中止错误时循环不吞异常；已中止信号仍抛 `LLM_ABORTED`
- **配置**：两个新变量的默认值、边界（1/2/100/101）、非法值报错
- **集成（离线）**：mock 脚本驱动 3 步任务成功；重复调用退出 1 且 stderr 含原因；空答案退出 1
- **回归**：阶段 1-3 全部用例保持通过；`zhipu-live` 保持默认跳过
- **验收门**：`typecheck` / `lint` / `format:check` / `build` / `test:coverage` 全 0，语句覆盖率不低于 96.1%（阶段 3 基线 96.63%）

## 七、安全约束

- 本阶段不新增文件写操作与命令执行，安全面不变
- 新日志字段只含 `stopReason`、计数与耗时，不含工具参数
- 配置校验沿用 zod，新增变量有范围限制
- 不执行 git push

## 八、风险与应对

| 风险                   | 说明                                | 应对                                           |
| ---------------------- | ----------------------------------- | ---------------------------------------------- |
| 重复检测误伤           | 模型合理地连续重试同一工具          | 仅连续计数，默认阈值 3，可配置                 |
| 失败熔断过早           | 模型正在根据错误自我纠正            | 连续「全部失败」才计数，任一成功清零，可配置   |
| 空答案判定改变既有行为 | mock 脚本耗尽原本会以空答案成功结束 | 视为未完成并退出 1；测试脚本都显式给出最终答案 |
| 配置面扩大             | 新增两个环境变量                    | 给默认值与范围，文档与 .env.example 同步       |
| 结束原因增多           | CLI/测试需要覆盖更多分支            | 统一映射到一个新错误码，集中断言               |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件）
- [x] 代码变更
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明（第八节 + 第十节遗留风险）
- [x] 完成情况（第十节）
- [x] 文档更新（architecture.md、README、.env.example）
- [x] git diff 检查
- [x] 开发报告（第十节）

## 十、验收结果（2026-11-16 实测）

### 10.1 验收门

| 检查项   | 命令                 | 结果                                                      |
| -------- | -------------------- | --------------------------------------------------------- |
| 类型检查 | `pnpm typecheck`     | 0 error                                                   |
| Lint     | `pnpm lint`          | 0 error / 0 warning                                       |
| 格式     | `pnpm format:check`  | All matched files use Prettier code style                 |
| 全量测试 | `pnpm test:coverage` | **347 passed / 5 skipped**（24 个文件：23 通过 + 1 跳过） |
| 构建     | `pnpm build`         | 成功                                                      |
| 覆盖率   | 同上                 | 语句 **96.75%** / 分支 92.74% / 函数 98.18% / 行 96.75%   |

5 个 skipped 仍为 `ZHIPU_LIVE_TEST=1` 的真实端点用例，本阶段未执行；默认套件完全离线。
`src/agent/loop.ts` 语句/分支/函数/行均为 **100%**；`run.ts` 仅剩 SIGINT 注册行未覆盖。

### 10.2 实施中的偏差与修复

| #   | 问题                                                    | 处理                                                             |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | 重复熔断在「第 N 次执行前」触发，`toolCalls` 比阈值少 1 | 按设计保留并写进测试断言（`maxRepeatedCalls=3` 时实际执行 2 次） |
| 2   | 子进程集成测试的执行不计入本进程覆盖率                  | 补进程内 `runCommand` 的空答案用例覆盖 `AgentIncomplete` 分支    |
| 3   | 熔断日志分支在单测中因未传 logger 而未覆盖              | 相关用例传入 silent pino logger，`loop.ts` 达到 100%             |
| 4   | `empty_answer` 改变了 mock 脚本耗尽时的旧语义           | 视为未完成并退出 1；所有脚本用例均显式给出最终答案，未放宽断言   |

### 10.3 完成情况

IN 范围全部落地：6 种停止原因、空答案/截断判定、重复调用熔断、连续失败熔断、
两个阈值进入配置并与 CLI 接线、非正常结束统一退出 1、4 轮多步任务集成测试。

OUT 范围严格未做：未引入 `finish` 工具、无写类工具/`bash`/权限确认、无上下文预算与
planner/evaluator、无并行执行、无会话持久化。

### 10.4 遗留风险

- **真实端点未在本阶段复跑**：循环正常路径未改动，既有 opt-in 用例仍可用于回归。
- **阈值默认值 3**：对特别复杂的任务可能偏紧或偏松，可通过两个环境变量调整。
- **一次不可复现的验收失败**：首次 `pnpm verify` 中 `test:coverage` 偶发失败，随后单独
  `test:coverage` 与再次 `pnpm verify` 均全通过；疑为 Windows 临时目录/子进程竞态，
  若后续复现需抓取完整输出定位。
- **key 曾明文暴露**：建议在智谱控制台轮换；本地仅存 gitignored `.env`。
- **未提交**：本阶段变更仍在工作区，等待用户决定是否提交；未执行任何 git push。
