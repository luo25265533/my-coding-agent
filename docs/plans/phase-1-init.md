# 阶段 1 开发 Plan：项目初始化

> 状态：**决策已确认（2026-11-12），待实施**
> 已定决策：方案 A 锁兼容版本 / 残留直接删除重装 / OpenAI 兼容优先 / git init + 首次提交
> 上游文档：[docs/architecture.md](../architecture.md)
> 目标交付：**一个能启动的 Agent 项目骨架** —— CLI 可运行、配置可加载校验、日志可落盘、lint/format/typecheck/test 四条命令全绿。

## 一、现状分析（实测证据）

### 1.1 仓库现有内容

```
D:\my-coding-agent\
├─ AGENTS.md            项目开发规范（内容完整，但 markdown 被反斜杠转义：\# \- \.）
├─ package.json         默认 npm init 产物 + 3 个 devDependencies
├─ pnpm-lock.yaml       lockfileVersion 6.1
├─ node_modules         符号链接 -> /d/my-coding-agent/   ← 指向项目根，自指循环
├─ .pnpm/               10 个目录，内部只有空的 node_modules 壳，无包实体
├─ .ignored_node_modules/  9 个符号链接，指向 .pnpm 下不存在的路径
└─ .modules.yaml        pnpm 安装元数据
```

无 `src/`、无 `tsconfig.json`、无 ESLint/Prettier 配置、无 `.gitignore`、无 `.env`、**不是 git 仓库**。

### 1.2 三个必须先修的问题

**问题 1：依赖全部无法解析（实测）**

```
node -e "require.resolve(...)"
typescript -> FAIL MODULE_NOT_FOUND
vitest     -> FAIL MODULE_NOT_FOUND
tsx        -> FAIL MODULE_NOT_FOUND
commander  -> FAIL MODULE_NOT_FOUND
zod        -> FAIL MODULE_NOT_FOUND
pino       -> FAIL MODULE_NOT_FOUND
dotenv     -> FAIL MODULE_NOT_FOUND
openai     -> FAIL MODULE_NOT_FOUND
```

`node_modules` 是指向项目根自身的符号链接，`ls node_modules/` 列出的是 `AGENTS.md / package.json / ...`；`.pnpm/typescript@7.0.2/node_modules/typescript/` 内只有一个空 `node_modules` 目录，没有 package.json 和任何代码。**这是一次失败/中断的安装留下的空壳，不是可用环境。**

**问题 2：package.json 含非法依赖项**

```json
"devDependencies": {
  "": "link:/",          ← 空包名，链接到文件系统根，必须删除
  "tsx": "^4.23.15",
  "typescript": "^7.0.2",
  "vitest": "^5.1.0"
}
```

lockfile 中对应 `'': { specifier: link:/, version: link:.. }`，是 node_modules 自指链接的来源。

**问题 3：锁定的版本跑在当前 Node 上会失败**

Node 实测 v20.18.1，而 vitest 5.1.0 要求 `^22.12 || ^24 || >=26`，typescript 7.0.2 超出 typescript-eslint 的 peer 上限 `<6.1.0`。详见 architecture.md 第四节实测矩阵。

### 1.3 预置依赖线索

`.ignored_node_modules` 里的符号链接名暗示了原本打算用的栈：commander / dotenv / zod / pino / openai / better-sqlite3 / tsx / typescript / vitest。本 Plan 采纳其中除 better-sqlite3（native 构建风险，推迟到阶段 8 评估）与 openai（阶段 2 再引入）之外的部分。

## 二、范围

### 2.1 本次做（IN）

1. 环境修复：清理空壳依赖目录、重写 package.json、重装依赖
2. TypeScript 项目骨架：strict + ESM + nodenext，src/ -> dist/
3. 八个业务模块目录占位（agent/llm/planner/tools/context/memory/security/evaluator）
4. 环境变量：`.env.example` + dotenv 加载 + zod 校验 + 只读配置对象
5. ESLint 9 flat config + typescript-eslint + Prettier 3
6. Vitest 3 + 首批单元测试与集成冒烟测试
7. CLI：commander 实现 `run` 骨架命令、全局 flag、规范退出码
8. 日志系统：pino 分级 + 控制台美化 + JSONL 落盘 + 密钥脱敏 + 子 logger
9. git 初始化 + `.gitignore`（满足 AGENTS.md 的 diff 检查要求）
10. 文档：architecture.md、本 Plan、README 启动说明

### 2.2 本次不做（OUT，防止范围膨胀）

- 真实 LLM 调用与 provider 实现 -> 阶段 2
- 任何工具实现、PathGuard、PermissionGate -> 阶段 3-4
- AgentLoop / Planner / Evaluator 逻辑 -> 阶段 6-7
- Memory 持久化 -> 阶段 8
- REPL 交互、流式输出 -> 阶段 9

阶段 1 的 `run` 命令行为：加载并校验配置 -> 初始化 logger -> 打印骨架就绪信息与脱敏配置摘要 -> 写一条日志 -> 退出码 0。**不调用模型，不执行任何工具，不读写用户代码文件。**

## 三、技术选型（方案 A，已确认）

| 用途     | 选型                       | 版本                | 理由                                               |
| -------- | -------------------------- | ------------------- | -------------------------------------------------- |
| 语言     | TypeScript                 | 5.9.3               | typescript-eslint peer 上限 <6.1.0，TS7 不可用     |
| 开发运行 | tsx                        | 4.23.15             | 免编译直跑 TS，Node ≥18                            |
| CLI      | commander                  | 14.0.3              | 15.x 要 Node ≥22.12                                |
| 校验     | zod                        | 4.6.7               | 配置与后续工具参数统一 schema 源                   |
| 环境变量 | dotenv                     | 18.0.10             | 事实标准                                           |
| 日志     | pino + pino-pretty         | 10.4.0 / 安装时校验 | 结构化 JSON、性能好、原生支持 redact               |
| 测试     | vitest + vite              | 3.2.7 / 6.4.6       | vitest 5 要 Node ≥22；显式锁 vite 6 避免解析到 7.x |
| Lint     | eslint + typescript-eslint | 9.39.5 / 8.72.2     | eslint 10 要 Node ≥20.19                           |
| 格式化   | prettier                   | 3.10.0              | —                                                  |
| 包管理   | pnpm                       | 8.6.0（已装）       | 现有 lockfile 即 pnpm 格式                         |

`package.json` 关键字段：

```json
{
  "name": "my-coding-agent",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agent": "dist/cli/main.js" },
  "engines": { "node": ">=20.18.0" },
  "scripts": {
    "dev": "tsx src/cli/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/cli/main.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "check": "pnpm typecheck && pnpm lint && pnpm test"
  }
}
```

## 四、文件清单

```
my-coding-agent/
├─ package.json              重写（删除 "" 依赖，补 scripts/bin/engines）
├─ pnpm-lock.yaml            重装后重新生成
├─ tsconfig.json             strict 全开，含 tests
├─ tsconfig.build.json       继承，exclude tests，outDir dist
├─ eslint.config.js          flat config + typescript-eslint recommendedTypeChecked
├─ .prettierrc.json          semi/singleQuote/printWidth 100/trailingComma all
├─ .prettierignore           dist/ coverage/ pnpm-lock.yaml .agent/
├─ .gitignore                node_modules dist coverage .env .agent *.log
├─ .env.example              全部变量 + 注释，不含真实密钥
├─ vitest.config.ts          node 环境、include tests/**、coverage provider v8
├─ README.md                 安装/启动/四条检查命令
├─ docs/
│  ├─ architecture.md        已产出
│  └─ plans/phase-1-init.md  本文件
├─ src/
│  ├─ index.ts               库入口：导出 APP_VERSION 与公共类型
│  ├─ cli/
│  │  ├─ main.ts             shebang + commander 装配 + 顶层错误处理 + 退出码
│  │  └─ commands/run.ts     run 骨架命令
│  ├─ config/
│  │  ├─ schema.ts           zod env schema + 类型推导
│  │  └─ load.ts             dotenv -> 校验 -> 绝对路径化 -> Object.freeze
│  ├─ logger/
│  │  ├─ index.ts            createLogger(config)，multistream 控制台+文件
│  │  └─ redact.ts           脱敏路径清单
│  ├─ shared/
│  │  ├─ errors.ts           AgentError 基类 + ErrorCode 枚举 + 退出码映射
│  │  └─ types.ts            RunId、LogLevel 等跨模块公共类型
│  ├─ agent/.gitkeep
│  ├─ llm/.gitkeep
│  ├─ planner/.gitkeep
│  ├─ tools/.gitkeep
│  ├─ context/.gitkeep
│  ├─ memory/.gitkeep
│  ├─ security/.gitkeep
│  └─ evaluator/.gitkeep
└─ tests/
   ├─ unit/config.test.ts
   ├─ unit/logger.test.ts
   ├─ unit/errors.test.ts
   ├─ unit/cli.test.ts
   └─ integration/cli-smoke.test.ts
```

八个业务模块阶段 1 只放 `.gitkeep` 占位，接口契约写在 architecture.md，代码从阶段 2 起逐步落地——避免提前写出没有实现的空接口。

## 五、任务分解

| #   | 任务                 | 产出                                      | 依赖                          |
| --- | -------------------- | ----------------------------------------- | ----------------------------- |
| T1  | 环境清理与依赖重装   | 可用的 node_modules、新 lockfile          | 已授权直接删除                |
| T2  | TS 骨架与工具链配置  | tsconfig×2、eslint、prettier、vitest 配置 | T1                            |
| T3  | shared 基础设施      | errors.ts、types.ts                       | T2                            |
| T4  | 配置模块             | schema.ts、load.ts、.env.example          | T3                            |
| T5  | 日志模块             | logger/index.ts、redact.ts                | T4                            |
| T6  | CLI                  | main.ts、commands/run.ts、bin 链接        | T5                            |
| T7  | 单元测试 + 集成冒烟  | tests/ 下 5 个文件                        | T6                            |
| T8  | git 初始化与首次提交 | .gitignore、仓库、commit                  | 已授权 init + commit，不 push |
| T9  | 文档与验收           | README、四条检查真实输出、开发报告        | T7                            |

### T1 环境清理具体动作（用户已授权直接删除）

```
1. 删除 node_modules 自指符号链接
2. 删除 .pnpm/ 与 .ignored_node_modules/ 空壳目录
3. 删除 .modules.yaml
4. 重写 package.json（移除 "" 依赖）
5. 删除旧 pnpm-lock.yaml，pnpm install 重新生成
6. require.resolve 复验 8 个包全部可解析
```

这些目录均为失败安装的残留、不含用户代码，用户已确认直接删除。删除范围严格限定为上述 5 项，逐项记录到开发报告；`AGENTS.md` 与 `docs/` 不在删除范围内。

### T4 配置设计

`.env.example`：

```
# ---- LLM（阶段 2 启用；阶段 1 只校验格式，不测连通性）----
LLM_PROVIDER=mock              # mock | openai-compatible
LLM_API_KEY=                   # provider=mock 时可空，其余必填
LLM_BASE_URL=                  # openai-compatible 时必填
LLM_MODEL=
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=2

# ---- Agent ----
AGENT_WORKSPACE=.              # 沙箱根，加载时解析为绝对路径
AGENT_MAX_ITERATIONS=20
AGENT_CONFIRM_HIGH_RISK=true

# ---- 日志 ----
AGENT_LOG_LEVEL=info           # trace|debug|info|warn|error|fatal|silent
AGENT_LOG_DIR=.agent/logs
AGENT_LOG_PRETTY=true
```

规则：

- 用 zod 校验，失败抛 `ConfigError`（退出码 2），错误信息列出具体字段与原因
- 条件校验：`provider !== 'mock'` 时 `LLM_API_KEY` 必填；`provider === 'openai-compatible'` 时 `LLM_BASE_URL` 必填
- `AGENT_WORKSPACE` / `AGENT_LOG_DIR` 解析为绝对路径；日志目录必须位于 workspace 内
- 返回 `Object.freeze` 后的只读对象；提供 `toRedactedJSON()` 供 CLI 打印，密钥恒为 `[REDACTED]`
- 优先级：进程环境变量 > `.env` 文件 > 默认值

### T5 日志设计

- `createLogger(config)` 返回 pino logger，`base: { app: 'my-coding-agent', version }`
- 双输出：控制台（`AGENT_LOG_PRETTY=true` 走 pino-pretty，否则 JSON）+ 文件 `<logDir>/agent-<date>.jsonl`（始终 JSON）
- 目录用 `fs.mkdirSync(recursive: true)` 创建
- `redact` 覆盖：`apiKey`、`*.apiKey`、`token`、`*.token`、`authorization`、`*.authorization`、`LLM_API_KEY`、`password`、`*.password`，censor 为 `[REDACTED]`
- `logger.child({ module, runId })` 供各模块使用，runId 贯穿一次运行
- 日志模块自身不得打印完整配置对象，只允许脱敏摘要

### T6 CLI 设计

```
agent --version              输出版本号，退出 0
agent --help                 输出用法，退出 0
agent run [task...]          骨架运行
  --workspace <path>         覆盖 AGENT_WORKSPACE
  --log-level <level>        覆盖 AGENT_LOG_LEVEL
  --verbose                  等价 --log-level debug
```

退出码约定：`0` 成功 / `1` 运行时错误 / `2` 参数或配置错误。
顶层捕获异常 -> 记录 error 日志 -> 按 ErrorCode 映射退出码，禁止裸抛导致堆栈直喷用户。

## 六、测试计划（必须真实执行）

| 文件                          | 用例                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit/config.test.ts           | 默认值生效；非法 log level 报错；provider≠mock 缺 key 报错；openai-compatible 缺 baseUrl 报错；workspace 解析为绝对路径；日志目录越界被拒；进程 env 覆盖 .env；返回对象已冻结；toRedactedJSON 不含明文密钥 |
| unit/logger.test.ts           | level 过滤（info 时 debug 不输出）；apiKey/token 被脱敏；JSONL 文件按行可解析；child 的 runId/module 透传；日志目录自动创建                                                                                |
| unit/errors.test.ts           | AgentError 携带 code；ErrorCode -> 退出码映射正确；cause 链保留                                                                                                                                            |
| unit/cli.test.ts              | run 解析 task 与 flag；--verbose 等价 debug；未知命令/非法 level 退出码 2；--version 输出与 package.json 一致                                                                                              |
| integration/cli-smoke.test.ts | 用 child_process 真实启动 `tsx src/cli/main.ts run "demo"`：退出码 0、stdout 含就绪标识、日志文件生成且含 runId、stdout 与日志均无密钥明文                                                                 |

验收门（四条全绿 + 手工验证）：

```
pnpm typecheck    # 0 error
pnpm lint         # 0 error
pnpm test         # 全部通过，输出真实统计
pnpm build && node dist/cli/main.js --version
git diff          # 人工复核
```

手工验收：`pnpm dev run "hello"` 能启动、能看到日志、`.agent/logs/*.jsonl` 有内容。

## 七、风险与应对

| 编号  | 风险                                             | 应对                                                                                                                   |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| P1-R1 | 删除残留目录不可逆                               | 用户已授权；删除范围严格限定为 node_modules / .pnpm / .ignored_node_modules / .modules.yaml / pnpm-lock.yaml，逐项记录 |
| P1-R2 | pnpm install 拉取失败/网络受限                   | registry 已实测可达；失败则报告具体包与错误，不静默降级                                                                |
| P1-R3 | vite 被解析到 7.x 触发 Node 20.19 门槛           | 显式声明 `vite: 6.4.6`，安装后 `pnpm why vite` 复核                                                                    |
| P1-R4 | pino-pretty 引擎不兼容                           | 安装前 `npm view pino-pretty engines` 校验，不兼容则退化为纯 JSON 控制台输出                                           |
| P1-R5 | nodenext 下相对 import 缺 `.js` 后缀导致运行失败 | 统一带后缀；lint 规则 + 冒烟测试兜住                                                                                   |
| P1-R6 | Windows 下 bin 链接与 shebang                    | 冒烟测试同时覆盖 tsx 直跑与 `node dist/cli/main.js`                                                                    |
| P1-R7 | .env 误提交                                      | .gitignore 先行；T8 提交前 `git status` 复核暂存内容                                                                   |
| P1-R8 | AGENTS.md markdown 被转义影响阅读                | 仅提示，不在本阶段擅自修改用户规范文件                                                                                 |

## 八、交付清单（AGENTS.md 第七节）

- [ ] Plan 文件（本文件）
- [ ] 代码变更（src/ + tests/ + 配置文件）
- [ ] 测试结果（四条命令的真实输出）
- [ ] 风险说明（第七节 + 实施中新发现）
- [ ] 完成情况（开发报告，含未完成项与原因）
