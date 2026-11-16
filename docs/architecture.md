# Single Coding Agent 总体方案

> 状态：已确认（2026-11-12）
> 已定决策：工具链走方案 A（保持 Node 20.18.1，锁兼容版本）；LLM 走 OpenAI 兼容优先；环境残留直接删除后重装；git init + 首次提交（不 push）
> 适用范围：D:\my-coding-agent，从零实现的 TypeScript Single Coding Agent

## 一、需求分析

### 1.1 功能需求（源自 AGENTS.md 核心目标）

| 编号 | 需求                                | 落地模块          | 验收阶段 |
| ---- | ----------------------------------- | ----------------- | -------- |
| FR1  | 理解用户开发需求，歧义时主动澄清    | agent + planner   | 6        |
| FR2  | 分析项目代码，检索并读取相关文件    | tools + context   | 4-5      |
| FR3  | 制定任务计划，拆解为可执行步骤      | planner           | 6        |
| FR4  | 统一注册、校验、调度工具            | tools             | 3-4      |
| FR5  | 修改代码（精确编辑/写入），路径受控 | tools + security  | 3-4      |
| FR6  | 执行测试与命令，捕获输出            | tools + evaluator | 4,7      |
| FR7  | 验证最终结果，失败可重规划          | evaluator + agent | 7        |

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

## 二、架构设计

### 2.1 分层与依赖方向

```
入口层    cli/                     命令解析、退出码、交互确认
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

### 2.2 模块职责与核心契约

| 模块      | 职责                                     | 关键契约                                                                                                   |
| --------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| agent     | 执行循环、迭代上限、中止、状态机         | `runAgentLoop(task, opts): Promise<AgentResult>`                                                           |
| llm       | 供应商适配、流式、重试、超时、token 统计 | `LLMProvider.chat(req): Promise<ChatResponse>` / `stream(req): AsyncIterable<StreamChunk>`                 |
| planner   | 任务拆解、重规划                         | `Planner.plan(task, ctx): Promise<Plan>`；`replan(plan, feedback)`                                         |
| tools     | 注册表、参数校验、分发、结果规范化       | `ToolRegistry.register(def)` / `specs()`；`dispatchToolCall(registry, call, ctx): Promise<ToolResult>`     |
| context   | 上下文组装、token 预算、截断/压缩        | `ContextManager.build(task, history): Promise<Prompt>`                                                     |
| memory    | 会话与长期记忆持久化                     | `MemoryStore.append(entry)`；`search(query)`                                                               |
| security  | 路径沙箱、权限决策、命令风险分级         | `resolveInsideWorkspace(root, p)`；`assertNotSensitive(path)`（PermissionGate 阶段 4）                     |
| evaluator | 跑验证命令、判定成败、给出重试建议       | `Evaluator.verify(plan, results): Promise<Verdict>`                                                        |
| config    | .env 加载 + zod 校验 + 冻结              | `loadConfig(env): Readonly<AppConfig>`                                                                     |
| logger    | 分级日志、脱敏、子 logger                | `createLogger(cfg, runId?): LoggerHandle`（`logger`/`logFile`/`close`）；`logger.child({ module, runId })` |

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
  │     ├─ pass -> 返回成功
  │     └─ fail -> planner.replan() 回到 4（受重试上限约束）
  └─ 6. memory.append(run) + 输出报告
```

阶段 3 已落地其中的最小子集：`llm.chat` 决策 → `security` 路径检查 → `tools.dispatch` →
观察结果回填，循环到最终回答。`context` 预算、`planner`、`evaluator`、`memory` 在后续阶段接入，
不改变本循环的骨架。

### 2.4 目录结构

```
src/
├─ index.ts          库入口（导出公共类型与工厂）
├─ cli/              main.ts + commands/
├─ config/           schema.ts + load.ts
├─ logger/           index.ts + redact.ts
├─ shared/           errors.ts + types.ts
├─ agent/            loop.ts + state.ts
├─ llm/              client.ts + providers/(mock, openai-compatible)
├─ planner/          planner.ts + prompt.ts
├─ tools/            registry.ts + dispatch.ts + definitions/
├─ context/          manager.ts + budget.ts
├─ memory/           store.ts + jsonl.ts
├─ security/         path-guard.ts + permission.ts + command-risk.ts
└─ evaluator/        evaluator.ts + runners/
tests/
├─ unit/             按模块分子目录
└─ integration/      跨模块与真实进程冒烟
```

## 三、开发路线图

| 阶段 | 主题             | 交付物                                                                               | 关键验收                                    |
| ---- | ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| 1    | 项目初始化       | TS 骨架、config、logger、CLI、lint/format/test 工具链                                | `agent run` 可启动，四类检查全绿            |
| 2    | LLM 抽象层       | LLMProvider 接口 + mock provider + OpenAI 兼容 provider、流式、重试、超时、chat REPL | mock 下可复现对话；真实 provider 可流式返回 |
| 3    | 安全与工具框架   | PathGuard、敏感文件排除、ToolRegistry、zod 校验、三只读工具、AgentLoop、run 工具循环 | 模型自主调工具；越界路径/密钥读取被拒       |
| 4    | 写工具与命令执行 | write/edit/bash 等工具、PermissionGate、命令风险分级                                 | 高风险命令触发确认；edit 失败可报错         |
| 5    | 上下文管理       | ContextManager、token 预算、截断与压缩                                               | 超预算不崩溃；关键信息保留                  |
| 6    | 规划与核心循环   | Planner + AgentLoop，端到端打通                                                      | mock LLM 驱动完成一个真实改码任务           |
| 7    | 结果验证         | Evaluator、测试执行、重规划                                                          | 故意写坏代码时能判定失败并重试              |
| 8    | 记忆持久化       | MemoryStore（JSONL 起步）、会话恢复                                                  | 重启后可恢复上一次会话                      |
| 9    | CLI 体验与总验收 | REPL、流式输出、确认交互、成本统计                                                   | 真实供应商完成一个端到端任务并产出报告      |

阶段 1 只交付基础设施，`run` 命令为骨架（不调用模型、不执行工具），避免提前扩大范围。

阶段 2 按需求交付「能够持续对话的 CLI」，因此 REPL 与流式输出提前在此落地（原列于阶段 9）；
历史仅存内存，会话落盘与 `--resume` 仍留到阶段 8。阶段 9 余下确认交互、成本统计与端到端总验收。

阶段 3 已交付工具调用闭环：`read_file` / `list_files` / `search_code` 三个只读工具、最小 AgentLoop、
`run` 升级为真正的任务入口。`PermissionGate` 与写类、命令执行工具顺延到阶段 4；
`chat` REPL 工具化仍按原计划留到阶段 6。

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
- **memory 先用 JSONL 文件，不引入 better-sqlite3**：native 模块在 Windows + Node 20 上有预编译/构建失败风险，会阻塞学习主线；阶段 8 再评估是否换 sqlite。
- **provider 抽象优先 mock**：保证无网络、无密钥也能跑完整循环测试（NFR3）。
- **真实 provider 只做 OpenAI 兼容一家**：`openai` SDK + 可配 `baseURL`，一套实现覆盖 OpenAI / DeepSeek / Kimi / 通义 / Ollama 本地，换供应商只改 `.env`。Anthropic 适配不在当前范围，接口预留扩展位但不提前实现。
- **zod 作为单一 schema 源**：同一份定义既做运行时校验又导出 JSON Schema 给模型，避免两处维护。

## 五、测试与验收策略

### 5.1 分层

| 层     | 范围                                                  | 工具                   | 是否依赖网络 |
| ------ | ----------------------------------------------------- | ---------------------- | ------------ |
| 单元   | config/logger/security/tools/planner/evaluator 纯逻辑 | vitest                 | 否           |
| 集成   | 模块协作、mock LLM 驱动的完整循环                     | vitest + mock provider | 否           |
| 冒烟   | 真实进程启动 CLI、退出码、日志落盘                    | vitest + child_process | 否           |
| 端到端 | 真实供应商完成一个改码任务                            | 手工 + 脚本            | 是（阶段 9） |

### 5.2 每阶段统一验收门（AGENTS.md 第六节）

```
pnpm typecheck   # tsc --noEmit，0 error
pnpm lint        # eslint，0 error
pnpm test        # vitest run，全绿
pnpm build       # 产物可执行
git diff         # 人工复核变更
```

禁止把未执行的测试描述为已通过；每次交付附真实命令输出。

### 5.3 安全验收用例（阶段 3 起强制）

- 越界路径：`../../etc/passwd`、绝对路径指向 workspace 外、符号链接逃逸 -> 必须拒绝
- 密钥文件：`.env`、`id_rsa`、`*.pem`、`.aws/credentials` -> 必须拒绝读取
- 高风险命令：`rm -rf`、`git push`、`curl | sh`、重定向覆盖 -> 必须人工确认
- 日志脱敏：任何含 apiKey/token 的对象写入日志后不得出现明文

## 六、风险登记

| 编号 | 风险                                   | 影响                            | 应对                                                       |
| ---- | -------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| R1   | 现有 node_modules 为空壳且自指符号链接 | 依赖全部无法解析，项目无法启动  | 阶段 1 第一步清理重装（需授权）                            |
| R2   | Node 20.18.1 与最新工具链不兼容        | 装得上但跑不起来                | 方案 A 锁版本 / 方案 B 升级 Node                           |
| R3   | TS 7 与 typescript-eslint 冲突         | lint 直接报 peer 错误           | 选 TS 5.9.3                                                |
| R4   | 无 git 仓库                            | 无法满足 AGENTS.md 的 diff 检查 | 阶段 1 git init（需授权）                                  |
| R5   | Windows 路径与符号链接                 | 沙箱绕过风险                    | PathGuard 用 realpath + 前缀校验，阶段 3 专项测试          |
| R6   | .env 密钥泄露                          | 安全事故                        | .gitignore + 日志 redact + .env.example 只放占位           |
| R7   | native 依赖构建失败                    | 阻塞进度                        | 阶段 1-7 不引入 native 模块                                |
| R8   | 模型输出不稳定导致测试不可复现         | CI 抖动                         | 单测/集成一律用 mock provider，真实调用只在阶段 9 手工验收 |
