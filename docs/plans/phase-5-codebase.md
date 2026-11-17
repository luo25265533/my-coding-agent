# 阶段 5 开发 Plan：代码库理解（Codebase）

> 状态：已完成（2026-11-16）
> 日期：2026-11-16
> 范围：目录扫描 / 文件搜索 / 代码检索 / 上下文构建 / 忽略规则 / Token 预算
> 交付：能够理解现有项目的 Agent

## 一、现状分析

阶段 3-4 已具备按需探索能力，但缺少「项目级理解」：

| 需求         | 现状                                                                 | 阶段 5 增量                                             |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------- |
| 项目目录扫描 | `walkEntries` 只做目录遍历，固定忽略 5 个目录，无项目概览            | 新增仓库地图（RepoMap）生成器，扫描并汇总项目结构       |
| 文件搜索     | `list_files` 只能按目录列条目，无法按文件名/路径 glob 查找           | 新增 `find_files` 工具                                  |
| 代码检索     | `search_code` 支持正则与 glob，但只返回匹配行，缺少上下文            | 增加 `contextLines`，输出匹配行前后代码                 |
| 上下文构建   | `AgentLoop` 直接拼 system + task，项目信息全靠模型自己探索           | 新增 `ContextManager`，注入项目地图并统一组装消息       |
| 忽略规则     | 仅硬编码 `node_modules/.git/dist/coverage/.agent`，不读 `.gitignore` | 新增忽略规则模块：默认规则 + 根 `.gitignore` + 环境追加 |
| Token 预算   | 无估算、无裁剪；工具输出与历史可能无限增长                           | 启发式 token 估算 + 上下文预算 + 历史裁剪               |

**结论**：阶段 5 在现有只读工具之上，补「自动项目概览 + 更细的检索 + 预算受控的上下文」，
不引入写操作与命令执行。

## 二、已确认决策（用户确认）

| 决策       | 选择                                                               |
| ---------- | ------------------------------------------------------------------ |
| 上下文注入 | **自动注入项目概览**；run 启动时扫描工作区并写入 system prompt     |
| 忽略规则   | **根 `.gitignore` 简化解析**，零新依赖；嵌套 `.gitignore` 留待后续 |
| Token 估算 | **启发式估算**：CJK 约 1 token/字，其余约 4 字符/token             |
| 检索工具   | **`find_files` + `search_code` 上下文行**                          |

## 三、范围

### 3.1 本次做（IN）

1. 忽略规则模块：默认目录、根 `.gitignore`（通配/否定/目录/锚定）、`AGENT_IGNORE` 追加
2. `walkEntries` 接入忽略规则；遍历器从 `tools/` 迁到 `security/`，修正层级依赖
3. 新增 `find_files` 工具：按相对路径 glob 查找文件，受忽略规则与结果上限约束
4. `search_code` 增加 `contextLines`（0-5），输出匹配行前后代码
5. Token 估算：字符启发式 + 每条消息固定开销
6. 仓库地图：目录树、语言统计、`package.json` 名称/脚本，受 token 预算与条目上限约束
7. `ContextManager`：组装 system（基础提示 + 项目地图）+ user 任务；按预算裁剪历史
8. `AgentLoop` 接入上下文与忽略规则；每轮请求前执行预算裁剪
9. 配置：`AGENT_CONTEXT_BUDGET_TOKENS`、`AGENT_RESPECT_GITIGNORE`、`AGENT_IGNORE`
10. run CLI 展示上下文预算/地图规模；日志记录构建与裁剪事件
11. 单元 + 集成测试、文档、验收报告

### 3.2 本次不做（OUT）

- 写类工具、`bash`、权限确认（继续顺延）
- 嵌套 `.gitignore`、`.ignore`、git 全局忽略规则
- 精确分词（不引入 tiktoken 类依赖）
- 向量检索 / embedding / 语义搜索
- 代码结构解析（AST、符号索引、调用图）
- planner / evaluator / memory
- 并行工具、子 Agent、会话持久化
- chat REPL 接入项目上下文（仅 run 命令注入）

## 四、技术设计

### 4.1 忽略规则（`src/security/ignore.ts`）

```ts
export interface IgnoreMatcher {
  isIgnored(relativePath: string, isDir: boolean): boolean;
}

export interface IgnoreOptions {
  readonly workspace: string;
  readonly respectGitignore?: boolean | undefined; // 默认 true
  readonly extraPatterns?: readonly string[] | undefined;
}

export function createIgnoreMatcher(options: IgnoreOptions): IgnoreMatcher;
```

- 默认目录（保留现有 5 个）不可被否定规则重新包含
- 规则来源顺序：默认 → `.gitignore` → `AGENT_IGNORE`；同一路径后匹配者生效
- 支持：注释/空行、`!` 否定、尾部 `/` 仅目录、前导 `/` 锚定、含 `/` 锚定根、
  `*`、`?`、`**`；不支持字符类、转义与嵌套 `.gitignore`（文档标注）
- 敏感文件名仍由 `sensitive-files.ts` 独立拦截，忽略规则无法放开

### 4.2 遍历器迁移与接入

- `src/tools/walk.ts` → `src/security/walk.ts`（security 是纯守卫，可被 tools/context 调用）
- `WalkOptions` 增加 `ignore?: IgnoreMatcher`；未传时只用默认规则
- 工具通过 `ToolContext.ignore` 获取 matcher，目录被忽略时直接剪枝，不递归

### 4.3 检索工具

**`find_files`**（`src/tools/definitions/find-files.ts`）

| 参数         | 默认 | 约束       | 说明                            |
| ------------ | ---- | ---------- | ------------------------------- |
| `path`       | `.`  | 工作区内   | 起始目录                        |
| `glob`       | —    | 1-128 字符 | 相对路径 glob，如 `src/**/*.ts` |
| `maxResults` | 100  | 1-500      | 最大返回条目                    |
| `maxDepth`   | 20   | 1-20       | 遍历深度                        |

输出每行 `路径  (字节数)`；截断时附提示并标记 `truncated`；跳过敏感文件与符号链接。
glob 编译逻辑从 `search-code.ts` 抽到 `src/tools/glob.ts`，两处复用。

**`search_code`**

- 新增 `contextLines`（0-5，默认 0）
- 匹配行输出 `path:line: text`，上下文行输出 `path-line- text`
- `maxResults` 仍只统计匹配行；单行 300 字符截断规则不变

### 4.4 Token 估算（`src/context/token-budget.ts`）

```ts
export function estimateTokens(text: string): number;
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number;
```

- CJK 字符（中日韩统一表意文字、假名、谚文、全角符号）按 1 token
- 其余字符按 0.25 token，向上取整
- 每条消息附加 4 token 固定开销（role/分隔符）
- 定位为**保守估算**，用于预算控制，不承诺与供应商计费一致

### 4.5 仓库地图（`src/context/repo-map.ts`）

```ts
export interface RepoMapResult {
  readonly text: string;
  readonly filesScanned: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export function buildRepoMap(options: {
  workspace: string;
  budgetTokens: number;
  ignore: IgnoreMatcher;
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<RepoMapResult>;
```

内容（纯名称，不读文件正文）：

1. 头部：扫描到的文件数、是否受预算截断
2. 语言统计：按扩展名计数，取前 10
3. `package.json`：`name`、`version`、`main`、脚本名列表（最多 8 个）
4. 目录树：深度 ≤ 3、最多 300 条，目录带 `/`，按路径排序

- 扫描上限 2000 个条目，超出停止并标记截断
- 树按行累积，达到地图预算即停止并追加截断提示
- 根目录不可读等错误不阻断任务：返回最小地图并记录 warn
- 尊重忽略规则；敏感文件不出现

### 4.6 上下文管理器（`src/context/manager.ts`）

```ts
export interface ContextStats {
  readonly budgetTokens: number;
  readonly repoMapTokens: number;
  readonly repoMapFiles: number;
  readonly repoMapTruncated: boolean;
  readonly initialTokens: number;
  readonly droppedMessages: number;
  readonly truncatedToolMessages: number;
  readonly lastRequestTokens: number;
}

export interface ContextManager {
  readonly budgetTokens: number;
  buildMessages(task: string): Promise<readonly ChatMessage[]>;
  fit(messages: readonly ChatMessage[]): readonly ChatMessage[];
  stats(): ContextStats;
}
```

**构建**

- system = 基础提示 + 项目地图；user = 原始任务
- 地图预算 = `min(总预算 30%, 总预算 - 基础提示 - 任务 - 保留量)`，下限 200
- 预算不足时省略地图并写明确提示，不截断用户任务
- 地图构建失败：降级为仅基础提示，日志 warn

**裁剪（每轮请求前）**

1. 未超预算：原样返回
2. 保留 system 与首个 user 任务
3. 历史按「assistant(含 tool_calls) + 后续 tool 消息」分组，从最新往前保留，整组丢弃
4. 若最新组仍超预算：反复截短最长的 tool 输出（保留 200 字符下限并附标记）
5. 有丢弃时插入一条 system 提示，说明早期历史因预算被省略
6. 永不拆散 tool_calls 与 tool 响应，保证供应商协议合法

### 4.7 AgentLoop 与工具上下文

`AgentLoopOptions` 新增：

```ts
readonly context?: ContextManager | undefined;
readonly ignore?: IgnoreMatcher | undefined;
```

- 有 `context` 时用 `buildMessages(task)` 初始化消息，否则沿用现有 system + user
- 每次 `provider.chat` 前调用 `context.fit(messages)`，只影响本次请求，不破坏完整历史
- `ignore` 透传到 `ToolContext`，供三个检索工具共享
- `ToolContext` 新增 `ignore?: IgnoreMatcher | undefined`

### 4.8 配置（`src/config/schema.ts`、`load.ts`）

| 变量                          | 默认  | 范围        | 说明                        |
| ----------------------------- | ----- | ----------- | --------------------------- |
| `AGENT_CONTEXT_BUDGET_TOKENS` | 16000 | 1000-200000 | 单次请求的估算 token 上限   |
| `AGENT_RESPECT_GITIGNORE`     | true  | true/false  | 是否解析根 `.gitignore`     |
| `AGENT_IGNORE`                | 空    | 文本        | 逗号/换行分隔的追加忽略规则 |

`AppConfig.agent` 对应新增 `contextBudgetTokens`、`respectGitignore`、`ignorePatterns`。

### 4.9 CLI（`src/cli/commands/run.ts`）

- 启动横幅新增：`context   : budget=16000 tokens  repo-map≈1234  files=57`
- 日志新增模块 `context`：`context built`、`context trimmed`（只有计数，无文件内容）
- 构造 `IgnoreMatcher` 与 `ContextManager` 后注入循环
- `RunResult` 增加 `context: ContextStats`
- AbortController 提前到上下文构建之前，扫描期间 Ctrl+C 同样可中止

## 五、任务分解

| #   | 任务                                              | 依赖  |
| --- | ------------------------------------------------- | ----- |
| P1  | 忽略规则模块 + 遍历器迁移 + walk 接入             | —     |
| P2  | `find_files` + glob 抽取 + `search_code` 上下文行 | P1    |
| P3  | token 估算 + 仓库地图                             | P1    |
| P4  | ContextManager（构建 + 裁剪）                     | P3    |
| P5  | 配置接线、AgentLoop/ToolContext、run CLI、文档    | P2-P4 |
| P6  | 单元与集成测试、验收门、开发报告                  | P5    |

## 六、测试计划（必须真实执行）

- **忽略规则**：默认目录；根 `.gitignore` 的锚定、目录、通配、否定、后匹配覆盖；
  `AGENT_IGNORE` 追加；默认目录不可被否定；敏感文件名不受规则影响
- **遍历器**：`.gitignore` 与追加规则生效；未传 matcher 时保持旧行为；敏感文件、符号链接仍跳过
- **find_files**：glob 匹配、大小写、目录剪枝、`maxResults` 截断、敏感文件不出现、越界路径拒绝
- **search_code**：`contextLines=1/2` 的输出格式与行号；截断与既有行为不回归
- **token 估算**：ASCII/CJK/混合文本；消息固定开销；估算随长度单调不减
- **仓库地图**：树/语言/`package.json` 内容；忽略规则与敏感文件；预算截断；不可读根目录降级；
  同一工作区多次生成结果一致
- **ContextManager**：初始消息包含基础提示、地图、任务；小预算省略地图；历史按组裁剪且保留
  tool_calls 配对；超大 tool 输出被截短；丢弃提示插入；统计字段正确
- **AgentLoop**：注入 context 后使用其消息；每轮调用 `fit`；`ignore` 传入工具上下文
- **集成（离线 mock）**：`find_files → read_file → answer` 多步任务；stdout 含 context 横幅；
  小预算下仍能完成任务并产生裁剪日志（日志按 runId 过滤）
- **回归**：阶段 1-4 全部用例保持通过；`zhipu-live` 默认跳过
- **验收门**：`typecheck` / `lint` / `format:check` / `build` / `test:coverage` 全绿；
  语句覆盖率不低于阶段 4 基线 96.75%（目标 ≥96%）

## 七、安全约束

- 所有扫描仍限制在 workspace 内；不跟随符号链接；敏感文件永不出现
- 项目地图只包含路径与元数据，不读文件正文；`package.json` 仅提取白名单字段
- 忽略规则不能覆盖敏感文件拦截
- 预算裁剪与日志不输出文件内容或密钥；失败日志只含计数与错误摘要
- 不新增写操作与命令执行；不执行 git push

## 八、风险与应对

| 风险                    | 说明                                  | 应对                                               |
| ----------------------- | ------------------------------------- | -------------------------------------------------- |
| 启发式估算偏差          | 与真实 token 有误差，可能仍超模型上限 | 预算保守（默认 16000）；实测 usage 持续可观测      |
| 大地图拖慢启动          | 大仓库扫描与树生成耗时                | 深度 ≤3、条目 ≤300、扫描 ≤2000、支持中止           |
| 简化 gitignore 语义偏差 | 嵌套/转义/字符类不生效                | 文档明确边界；默认目录始终生效；后续可换 ignore 包 |
| 裁剪破坏工具协议        | 单独丢弃 tool 消息会导致供应商报错    | 按 assistant+tool 整组裁剪，禁止拆散               |
| 额外 system 消息兼容性  | 部分供应商对多 system 消息敏感        | 仅在发生裁剪时插入一条；真实端点验收时复核         |
| 默认注入增加每轮 token  | 简单任务也会携带项目地图              | 地图仅占预算 30%；可用小预算或空地图降级           |
| 目录层级判断失误        | `walk.ts` 迁移可能遗漏引用            | 全局搜索引用，typecheck + 全量测试兜底             |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件）
- [x] 代码变更
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明（见第十节）
- [x] 完成情况
- [x] 文档更新（architecture.md、README、.env.example）
- [x] git diff 检查
- [x] 开发报告

## 十、验收结果（2026-11-16 实测）

### 10.1 实现范围

| 模块                                    | 变更                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `security/ignore.ts`（新）              | 默认目录、根 `.gitignore` 解析（`!`、目录、锚定、`*`、`?`、`**`）、`AGENT_IGNORE` 追加 |
| `security/walk.ts`（迁移）              | 从 `tools/walk.ts` 迁入；新增 `ignore` 选项；默认目录与敏感文件规则保持                |
| `tools/glob.ts`（新）                   | 从 search-code 抽出的 glob 编译器，大小写不敏感                                        |
| `tools/definitions/find-files.ts`（新） | 按相对路径 glob 查找，处理文件/目录起点、截断、忽略规则                                |
| `tools/definitions/search-code.ts`      | 新增 `contextLines`（0–5），输出 `path-line- text` 上下文行，去重重叠行                |
| `context/token-budget.ts`（新）         | CJK/非 CJK 启发式估算 + 消息/工具调用固定开销                                          |
| `context/repo-map.ts`（新）             | 文件数、语言统计、`package.json` 白名单字段、目录树；扫描/条目/行数上限                |
| `context/manager.ts`（新）              | 注入项目概览、按任务缓存、整组裁剪、工具输出截短、统计与日志                           |
| `agent/loop.ts`                         | 接受 `context` 与 `ignore`；每轮请求前 `fit`；工具上下文透传忽略规则                   |
| `config/`                               | `AGENT_CONTEXT_BUDGET_TOKENS`、`AGENT_RESPECT_GITIGNORE`、`AGENT_IGNORE`               |
| `cli/commands/run.ts`                   | 启动横幅新增 `context` 行；`RunResult.context`；日志记录 `context built/trimmed`       |
| `shared/ignore-patterns.ts`（新）       | `AGENT_IGNORE` 逗号/换行拆分与裁剪                                                     |

### 10.2 测试结果（真实命令输出）

环境：Windows 10.0.26300，Node v20.18.1，pnpm 8.6.0。

| 命令                 | 结果                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `pnpm typecheck`     | 通过，0 error                                                               |
| `pnpm lint`          | 通过，0 error                                                               |
| `pnpm format:check`  | 通过，All matched files use Prettier code style                             |
| `pnpm build`         | 通过                                                                        |
| `pnpm test:coverage` | **27 个测试文件通过 + 1 个跳过（live）**；**404 passed / 5 skipped（409）** |
| 覆盖率               | Stmts **96.84%**，Branch **92.39%**，Funcs **98.56%**，Lines **96.84%**     |
| `pnpm verify`        | **10/10 通过**（5 项门禁 + 5 项 REPL 演示），全程离线                       |

> 执行过程中 `pnpm verify` 曾出现一次 `test:coverage` 偶发失败，单独重跑与再次 `pnpm verify`
> 均全绿，未能复现；与阶段 2-4 记录过的同类抖动一致，未定位到具体用例。

新增/更新的关键用例：

- `ignore.test.ts`（13）：默认目录不可反选、`.gitignore` 锚定/目录/`**`/否定、`?`、结尾 `**`、空模式、`AGENT_IGNORE`
- `token-budget.test.ts`（7）：ASCII/CJK/混合、消息与工具调用开销、单调性
- `repo-map.test.ts`（8）：概览/语言/`package.json`/树、忽略与敏感文件、确定性、预算截断、预算 0、非法 `package.json`、空工作区、根目录不可读降级
- `context-manager.test.ts`（10）：注入/缓存/省略地图、整组丢弃、截短、丢弃最新组、无工具消息、空数组
- `tools-definitions.test.ts`（34）：`find_files` glob/锚定/结尾 `**`/文件起点/截断/忽略；`search_code` 上下文行
- `tools-walk.test.ts`（12）：自定义 matcher、根 `.gitignore`、符号链接与中止
- `agent-loop.test.ts`（18）：context 初始化与每轮 `fit`、`ignore` 透传
- `run-tools.test.ts`（10）：`find_files → read_file → answer`、横幅统计、`context built` 日志、小预算省略地图
- `config.test.ts` / `run.test.ts` / `tools-registry.test.ts`：新配置项、`context` 日志模块、四个默认工具

未覆盖项均为不可达或平台相关分支：`walk.ts` 的非 file/dir 起点与不可读子目录、Windows 无权限时的符号链接用例、`translateGlob` 的 `char === undefined` 防御分支、`find_files` 的非目录起点（FIFO/socket）。

### 10.3 实现偏差与说明

1. `createContextManager` 为同步工厂（内部 `buildMessages` 异步），避免 ESLint `require-await`。
2. 横幅格式为 `context   : budget=16000 tokens  repo-map=34 tokens  files=4`，未使用计划中的 `≈`。
3. 当截短到 200 字符下限仍超预算时，会丢弃最新组（保留 system + user + 省略提示），以保证请求不超预算。
4. 裁剪会插入一条额外 system 提示；真实供应商兼容性未在本次离线验收中验证（留待阶段 9 端到端）。
5. `find_files` 不输出目录条目（未启用 `includeDirs`），因此删除了不可达的目录过滤分支。

### 10.4 风险与缓解（实测后）

| 风险                    | 现状                                                | 缓解                                                                           |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 启发式估算偏差          | 未与真实计费对比                                    | 默认预算保守；`run finished` 记录 `lastRequestTokens` 与真实 usage，可持续校准 |
| `.gitignore` 语义不完整 | 不支持字符类、转义、嵌套 `.gitignore`               | 文档明确边界；默认目录始终生效；后续可替换为成熟 ignore 库                     |
| 多 system 消息兼容性    | 仅裁剪时插入一条 system 提示                        | 离线测试通过；真实端点留待阶段 9 验证                                          |
| 启动扫描开销            | 深度 ≤3、扫描 ≤2000、树 ≤300 行；实测小仓库 <100 ms | 支持 AbortSignal；预算不足时跳过扫描                                           |
| 覆盖率略降              | 新增模块后 96.84%，仍高于阶段 4 基线 96.75%         | 新增用例覆盖主要路径；不可达分支已记录                                         |

### 10.5 完成情况

阶段 5 六项交付全部完成：目录扫描（仓库地图）、文件搜索（`find_files`）、代码检索（`search_code`
上下文行）、上下文构建（`ContextManager` 自动注入）、忽略规则（默认 + 根 `.gitignore` + 追加）、
Token 预算控制（估算 + 整组裁剪 + 工具输出截短）。`run` 启动即可理解项目结构，并在预算内完成
多步任务。未提交 git，未 push。
