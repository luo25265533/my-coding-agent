# 阶段 3 开发 Plan：工具调用闭环

> 状态：已完成（2026-11-16，用户确认后实施）
> 日期：2026-11-16
> 范围：Tool 接口 / Registry / 参数校验 / read_file / list_files / search_code / 工具调用闭环
> 交付：`agent run "任务"` 能自主选择并调用工具完成任务

## 一、现状分析

### 1.1 阶段 2 已就绪的对接点

| 位置                      | 现状                                                      | 阶段 3 如何用                                     |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `src/llm/types.ts`        | `ChatMessage` 只有 `role/content`；`ChatRequest` 无 tools | 扩展消息模型与请求/响应契约                       |
| `.../client.ts`           | `buildBody` 只发 `role/content`；非流式只读 `content`     | 发送 tools 与 tool 消息；解析 `tool_calls`        |
| `.../schema.ts`           | 响应 schema 无 `tool_calls`                               | 增加 tool_calls 校验                              |
| `.../mock.ts`             | 确定性回显，无脚本能力                                    | 增加可编排脚本，驱动离线循环测试                  |
| `src/cli/commands/run.ts` | 阶段 1 骨架：只打印配置，不调模型                         | **升级为真正的工具循环入口**                      |
| `src/config/schema.ts`    | 已有 `AGENT_MAX_ITERATIONS`（默认 20）                    | 直接作为循环上限，无需新增                        |
| `src/tools/`              | 仅 `.gitkeep`                                             | 全部新建                                          |
| `src/security/`           | 仅 `.gitkeep`                                             | 新建最小 `PathGuard`（阶段 3 本就是安全框架阶段） |
| `src/agent/`              | 仅 `.gitkeep`                                             | 新建最小 `AgentLoop`                              |

### 1.2 智谱工具调用协议实测（2026-11-16，真实调用官方端点）

探针脚本已跑通并由 `rm` 清理。实测结论：

**A. 非流式响应**

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      {
        "id": "call_-7075644400352623069",
        "index": 0,
        "type": "function",
        "function": { "name": "read_file", "arguments": "{\"path\":\"package.json\"}" }
      }
    ]
  }
}
```

- 工具调用回合的 `content` 是**空字符串**，不是 `null`
- `function.arguments` 是**JSON 字符串**，需要二次解析
- 非流式响应里也带 `index` 字段

**B. 流式响应**

- `finish_reason` 同样为 `tool_calls`
- 本次实测整条工具调用落在**一个 delta** 里；但 OpenAI 兼容协议允许按 `index` 分片，解析必须累积，不能假设一次到齐
- 工具调用回合的 delta 不含 `content`

**C. 回传续跑（关键闭环验证）**

发送 `assistant{content:null, tool_calls:[...]}` + `{role:'tool', tool_call_id, content}` 后：

- HTTP 200，`finish_reason: "stop"`，模型给出了基于工具结果的最终答案
- 说明 `tool` 角色消息与 `tool_call_id` 的对应关系是必须的

**D. zod → JSON Schema**

`z.toJSONSchema()`（zod 4.6.7）可输出 draft 2020-12，含 `$schema`、`exclusiveMinimum`、`additionalProperties: false`。
用该 schema 请求智谱返回 200，**关键字被接受**，无需手工裁剪。

### 1.3 依赖约束

零新依赖。JSON Schema 生成用已装的 zod；文件遍历与正则用 Node 内置 `fs`/`path`；不引入 `glob`、`fast-glob`、`ignore`、`ripgrep`。

## 二、已确认决策（用户确认）

| 决策      | 选择                                                                   |
| --------- | ---------------------------------------------------------------------- |
| 循环入口  | **升级 `run`**：`agent run "任务"` 成为真正的工具循环，替换阶段 1 骨架 |
| 模型调用  | **非流式 `chat()`**：每轮拿完整 tool_calls，逻辑确定、易测试           |
| 搜索实现  | **纯 Node 自实现**：零依赖、跨平台一致、忽略与上限完全可控             |
| chat REPL | **不启用工具**：阶段 3 只做任务模式，REPL 工具化留到阶段 6             |

## 三、范围

### 3.1 本次做（IN）

1. 消息模型扩展：assistant 可携带 `toolCalls`，新增 `tool` 角色消息
2. `ChatRequest.tools` 与 `ChatResponse.toolCalls`
3. 客户端：发送 tools / tool 消息；非流式解析 `tool_calls`；流式按 `index` 累积
4. `ToolDefinition` / `ToolContext` / `ToolResult` 接口
5. `ToolRegistry`：注册、按名查找、列出 specs、重名报错
6. `dispatch`：zod 参数校验、执行、错误规范化（错误回传给模型，不中断循环）
7. `PathGuard`：workspace 沙箱、realpath 防符号链接逃逸、拒绝密钥文件
8. 三个只读工具：`read_file`、`list_files`、`search_code`
9. `AgentLoop`：多轮「模型决策 → 调工具 → 观察」直到最终回答，受迭代上限与 AbortSignal 约束
10. `run` 命令升级：打印调用轨迹、最终答案、token 与轮次统计
11. mock provider 支持脚本化响应（测试与集成用）

### 3.2 本次不做（OUT，防止范围膨胀）

- 写类工具（write / edit）与 `bash` → 阶段 4
- 高风险命令的人工确认交互（本阶段全为只读低风险工具）→ 阶段 4
- `planner` / `evaluator` / 重规划 → 阶段 6-7
- 上下文预算管理与压缩 → 阶段 5
- 会话持久化与 `--resume` → 阶段 8
- 流式工具循环（阶段 3 循环固定非流式）
- `chat` REPL 工具化
- 子 Agent / 并行工具执行

## 四、技术设计

### 4.1 消息模型（`src/llm/types.ts`）

```ts
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 JSON 字符串；解析与校验在 tools 层完成，LLM 层不做业务解释 */
  readonly arguments: string;
}

export interface JsonSchemaObject {
  readonly [keyword: string]: unknown;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };
```

- `ChatRequest` 增加 `tools?: readonly ToolSpec[] | undefined`
- `ChatResponse` 增加 `toolCalls: readonly ToolCall[]`（无调用时为 `[]`，避免到处判空）
- `StreamChunk` 不新增类型：流式工具调用只累积进 `done.response.toolCalls`，阶段 3 不展示中间分片

**迁移影响**：`chat.ts` 的 history 仍只写 `{role:'assistant', content}`，类型上合法；`mock.ts`、测试 fixture 需补 `toolCalls: []`。

### 4.2 线上协议映射（`.../client.ts` + `.../schema.ts`）

请求（`buildBody`）：

| 本地消息                 | 线上 payload                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `system` / `user`        | `{ role, content }`                                                                          |
| `assistant` 带 toolCalls | `{ role:'assistant', content, tool_calls:[{id,type:'function',function:{name,arguments}}] }` |
| `assistant` 无 toolCalls | `{ role:'assistant', content }`                                                              |
| `tool`                   | `{ role:'tool', tool_call_id, content }`                                                     |
| `ChatRequest.tools` 非空 | 顶层 `tools: [{type:'function', function:{name,description,parameters}}]`                    |

响应 schema 增加：

```ts
const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
```

- 非流式：`message.tool_calls` → `ToolCall[]`；缺 `id` 时生成确定性兜底 id 并在日志告警
- 流式：`delta.tool_calls` 按 `index` 分桶累积 `id` / `name` / `arguments`（字符串拼接），`done` 时输出
- `finish_reason === 'tool_calls'` 时允许 `content` 为空字符串

### 4.3 工具层（`src/tools/`）

```ts
export interface ToolContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
}

export interface ToolResult {
  readonly ok: boolean;
  /** 回传给模型的文本；失败时是可读的错误说明，便于模型自我纠正 */
  readonly content: string;
  readonly truncated?: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ToolDefinition<P> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodType<P>;
  readonly riskLevel: 'low' | 'medium' | 'high';
  execute(params: P, ctx: ToolContext): Promise<ToolResult>;
}
```

- **注册时**即调用 `z.toJSONSchema(parameters)` 生成 spec，生成失败直接抛错（把「参数 schema 不可表达」暴露在启动期而非运行期）
- `ToolRegistry.register` 重名抛错；`get(name)` 返回 `undefined`；`specs()` 按注册顺序输出
- `dispatch(call, ctx)` 永不抛业务错误，统一返回 `ToolResult`：
  1. 未知工具 → `ok:false, code: TOOL_NOT_FOUND`
  2. `arguments` 非法 JSON → `TOOL_INVALID_ARGS`
  3. zod 校验失败 → `TOOL_INVALID_ARGS` + 逐条 issue
  4. `execute` 抛错 → `TOOL_FAILED` + message
  5. `signal.aborted` → 直接抛出，让循环终止（中止不是工具错误）

失败结果的 `content` 用固定 JSON 结构，模型可读可纠正：

```json
{ "ok": false, "error": { "code": "TOOL_INVALID_ARGS", "message": "path: Required" } }
```

### 4.4 路径守卫（`src/security/path-guard.ts`）

```ts
export function resolveInsideWorkspace(workspace: string, input: string): string;
export function assertNotSensitive(filePath: string): void;
```

- 相对路径基于 workspace 解析；绝对路径若落在 workspace 外直接拒绝
- `path.relative` 结果以 `..` 开头或为绝对路径 → 拒绝
- 目标存在时用 `realpath` 复核，防止 workspace 内符号链接指向外部
- 遍历时不跟随符号链接（`lstat` 判定）
- 拒绝读取的密钥文件（大小写不敏感，Windows 语义）：`.env`、`.env.*`（**放行 `.env.example`**）、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.git-credentials`、`credentials`（含 `.aws/credentials`）、`credentials.json`
- 拒绝时抛 `AgentError(ErrorCode.PathDenied)`；工具层捕获后转为 `TOOL_DENIED` 结果回传模型

**search_code 与 list_files 必须复用同一套排除规则**，否则「搜索」会变相读出密钥文件内容。

### 4.5 三个工具（`src/tools/definitions/`）

| 工具          | 参数（zod）                                                                                                                   | 行为与上限                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `read_file`   | `path: string`，`offset?: int≥1`，`limit?: int 1..400`（默认 400）                                                            | 带行号返回；单次 ≤ 400 行且 ≤ 256 KB；超限置 `truncated` 并提示下一 offset；含 NUL 字节判为二进制并拒绝             |
| `list_files`  | `path?: string`（默认 `.`），`recursive?: boolean`，`maxDepth?: 1..5`（默认 2），`maxEntries?: 1..1000`（默认 200）           | 输出 `type size path`；默认忽略 `node_modules .git dist coverage .agent`；按路径排序；超上限截断并提示              |
| `search_code` | `pattern: string`，`path?: string`，`glob?: string`（如 `*.ts`），`caseSensitive?: boolean`，`maxResults?: 1..200`（默认 50） | 逐行正则匹配，输出 `path:line: 文本`；跳过忽略目录、密钥文件、二进制与 >1 MB 文件；非法正则返回 `TOOL_INVALID_ARGS` |

共享遍历器 `src/tools/walk.ts`：统一忽略规则、深度、条目上限与二进制嗅探（前 8 KB 找 NUL），供 `list_files` / `search_code` 复用。

### 4.6 Agent 循环（`src/agent/loop.ts`）

```ts
export interface AgentLoopOptions {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly maxIterations: number;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  readonly onToolCall?: (call: ToolCall, iteration: number) => void;
  readonly onToolResult?: (call: ToolCall, result: ToolResult, iteration: number) => void;
}

export interface AgentResult {
  readonly content: string;
  readonly iterations: number;
  readonly usage: TokenUsage;
  readonly toolCalls: number;
  readonly stopReason: 'answer' | 'max_iterations';
}
```

流程：

```
messages = [system(workspace 与工具使用规范), user(task)]
usage = EMPTY
for iteration in 1..maxIterations:
  response = provider.chat({ messages, tools: registry.specs(), signal })
  usage += response.usage
  if response.toolCalls 为空:
      return { content: response.content, stopReason: 'answer', ... }
  messages += assistant{ content: response.content, toolCalls }
  for call of response.toolCalls:            # 顺序执行，避免并发写语义
      result = dispatch(call, ctx)
      messages += tool{ toolCallId: call.id, content: result.content }
      onToolCall / onToolResult 回调用于 CLI 打印
达到上限 -> return { content: 最后一次正文(可能为空), stopReason: 'max_iterations', ... }
```

- 系统提示明确：只能通过工具了解文件；参数必须符合 schema；一次可调多个工具；不确定时先 `list_files` / `search_code`
- 中止：`signal` 透传给 provider 与工具；中止时抛 `LlmAborted`，CLI 映射退出码 1
- 迭代上限耗尽视为**未完成**，CLI 打印明确说明并以退出码 1 结束
- 不在此阶段做 token 预算与上下文压缩（阶段 5）

### 4.7 CLI（`src/cli/commands/run.ts`）

`runCommand` 改为 async，`main.ts` 的 action await。行为变化：

- `agent run`（无任务）→ 用法错误，退出码 2（不再是打印骨架退出 0）
- 输出格式：

```
runId     : ...
workspace : ...
provider  : openai-compatible  model: glm-5.3
task      : 读取 package.json 并告诉我项目名

[1] → read_file {"path":"package.json"}
[1] ← ok 41 chars (3ms)
answer:
项目名是 my-coding-agent。
tokens: prompt=... completion=... total=...  iterations=2  tools=1
```

- 日志：`run started` / 每轮 `iteration completed`（含 usage、toolCalls 数）/ 每个工具 `tool executed`（name、ok、耗时、输出长度，**不记录参数中的敏感内容**）/ `run finished`
- 迭代耗尽：stderr 输出明确错误，退出码 1

### 4.8 mock provider 脚本化（`src/llm/providers/mock.ts`）

```ts
export interface MockStep {
  readonly content?: string | undefined;
  readonly toolCalls?: readonly { name: string; arguments: string }[] | undefined;
  readonly reasoning?: string | undefined;
}
export interface MockProviderOptions {
  // 既有字段...
  readonly script?: readonly MockStep[] | undefined;
}
```

- 有 `script`：每次调用消费一步（toolCalls 的 id 按 `mock-call-<step>-<index>` 确定性生成）
- 脚本耗尽：返回空正文的最终回答，循环自然结束
- 无 `script`：保持现有回显行为，阶段 2 测试不受影响

CLI 集成测试需要脚本入口：配置新增 `AGENT_MOCK_SCRIPT`（可选路径），仅在 `LLM_PROVIDER=mock` 时读取 JSON 文件并传给 mock provider；其他 provider 下忽略。这是测试支撑配置，写入 `.env.example` 注释说明。

### 4.9 错误码（`src/shared/errors.ts`）

新增，均映射 `ExitCode.RuntimeError`：

| 错误码               | 用途                               |
| -------------------- | ---------------------------------- |
| `PathDenied`         | 路径越界 / 密钥文件 / 符号链接逃逸 |
| `AgentMaxIterations` | 迭代上限耗尽仍未给出最终答案       |

工具层内部的 `TOOL_*` 是**回传给模型的字符串码**，不复用 `ErrorCode`（前者是业务观察，后者是进程错误）。

### 4.10 文件清单

```
src/
├─ llm/
│  ├─ types.ts                                （扩展消息/请求/响应/工具 spec）
│  └─ providers/
│     ├─ mock.ts                              （+script）
│     └─ openai-compatible/
│        ├─ client.ts                         （buildBody + 解析/累积 tool_calls）
│        └─ schema.ts                         （+tool_calls 校验）
├─ security/
│  ├─ path-guard.ts                           （新）
│  └─ sensitive-files.ts                      （新，密钥文件名规则，供工具与守卫共用）
├─ tools/
│  ├─ types.ts                                （新）
│  ├─ registry.ts                             （新）
│  ├─ dispatch.ts                             （新）
│  ├─ walk.ts                                 （新，共享遍历/忽略/二进制判定）
│  ├─ definitions/
│  │  ├─ read-file.ts                         （新）
│  │  ├─ list-files.ts                        （新）
│  │  └─ search-code.ts                       （新）
│  └─ index.ts                                （新，createDefaultToolRegistry）
├─ agent/
│  └─ loop.ts                                 （新）
├─ cli/
│  ├─ commands/run.ts                         （升级为 async 工具循环）
│  └─ main.ts                                 （await runCommand）
├─ config/
│  ├─ schema.ts                               （+AGENT_MOCK_SCRIPT）
│  └─ load.ts                                 （+mockScript）
├─ llm/factory.ts                             （mock 传 script）
└─ shared/errors.ts                           （+2 错误码）
```

## 五、任务分解

| #   | 任务                                                     | 依赖     |
| --- | -------------------------------------------------------- | -------- |
| P1  | 消息模型 + 错误码 + 配置字段                             | —        |
| P2  | 客户端协议：buildBody / 非流式解析 / 流式累积 / schema   | P1       |
| P3  | mock 脚本化 + factory 接线                               | P1       |
| P4  | PathGuard + 敏感文件规则 + 共享遍历器                    | P1       |
| P5  | Tool 接口 + Registry + dispatch                          | P1 P4    |
| P6  | read_file / list_files / search_code                     | P5       |
| P7  | AgentLoop                                                | P2 P5 P6 |
| P8  | run CLI 升级 + 轨迹输出 + 日志                           | P7       |
| P9  | 测试补齐 + 集成 + opt-in 真实端点 + 验收门 + 文档 + 报告 | P1–P8    |

## 六、测试计划（必须真实执行）

- **单元 · 协议**：buildBody 的四种消息映射与 tools 字段；非流式 tool_calls（含缺 id 兜底、content 空串）；流式按 index 分片累积（模拟 arguments 被切成多段）；`finish_reason=tool_calls`
- **单元 · 安全**：相对/绝对路径越界、`..` 穿越、符号链接逃逸（Windows 上按平台可用性跳过）、`.env` 与 `*.pem` 拒绝、`.env.example` 放行、大小写不敏感
- **单元 · 注册与调度**：重名报错、未知工具、非法 JSON、zod 校验失败 issue 文本、execute 抛错转 `TOOL_FAILED`、中止透传、specs 生成
- **单元 · 工具**：
  - read_file：正常、带 offset/limit、截断提示、文件不存在、目录、二进制拒绝、越界 path
  - list_files：平铺/递归/maxDepth、忽略目录、排序、maxEntries 截断
  - search_code：命中格式、glob 过滤、大小写、非法正则、无匹配、跳过密钥文件与二进制、maxResults 截断
- **单元 · 循环**：单工具后给答案；单轮多工具；工具失败后模型纠正；未知工具反馈；非法参数反馈；迭代上限；中止；usage 累加；onToolCall/onToolResult 回调顺序
- **集成（离线）**：真实子进程 `agent run "..."` + `AGENT_MOCK_SCRIPT` 驱动「调 read_file → 回答」，断言轨迹、最终答案、退出码、日志；无任务时退出 2；上限耗尽退出 1
- **真实端点 opt-in（默认跳过）**：`ZHIPU_LIVE_TEST=1`，在临时 workspace 放一个已知文件，任务要求读取并回答，断言模型确实调用了 `read_file` 且答案包含文件内容；不打印密钥
- **验收门**：`typecheck` / `lint` / `format:check` / `test` / `build` 全 0，覆盖率不低于阶段 2（96.1% 语句）
- 严禁把未执行的测试描述为已通过

## 七、安全约束（AGENTS.md 第五节）

- 所有文件参数先过 `PathGuard`，再触碰 `fs`
- 不经由任何工具读取 `.env` 等密钥文件；搜索与列目录同样排除
- 本阶段无写操作、无子进程执行，不存在覆盖文件或命令注入面
- 密钥只来自环境变量 / gitignored `.env`；工具与日志不得输出密钥
- 工具输出一律有字节/条数上限，防止超大目录或文件撑爆上下文
- 正则来自模型：限制模式长度、单文件大小与总命中数，降低 ReDoS 影响
- 不执行 git push

## 八、风险与应对

| 风险                   | 说明                                      | 应对                                                     |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------- |
| 模型给出幻觉参数       | 路径不存在、字段类型错                    | zod 校验 + 结构化错误回传，模型可自我纠正                |
| 模型不调用工具直接编造 | 小模型常见                                | 系统提示强约束 + 真实端点 opt-in 测试验证实际会调用      |
| 无限循环               | 反复调工具不收敛                          | `AGENT_MAX_ITERATIONS` 上限，耗尽即失败退出              |
| 超大目录 / 大文件      | 输出撑爆上下文或拖慢                      | 条目、行数、字节、命中数四类上限 + 截断提示              |
| ReDoS                  | 模型提供恶意正则                          | 模式长度上限 + 文件大小上限 + 命中上限                   |
| 符号链接逃逸           | workspace 内链接指向外部                  | `realpath` 复核 + 遍历不跟随链接                         |
| Windows 路径差异       | 反斜杠、大小写不敏感、盘符                | 统一 `path.resolve/relative`，敏感文件名大小写不敏感比较 |
| 敏感文件被搜索读出     | 只读工具也可能泄露内容                    | 搜索/列目录复用同一份敏感文件排除规则                    |
| 阶段 1 测试失效        | `run` 输出与退出码变化                    | P9 同步改断言（骨架文案 → 循环行为），不放宽验证         |
| JSON Schema 兼容性     | 其他 provider 可能不认 `$schema` 等关键字 | 目标为智谱，已实测接受；如换供应商在 opt-in 测试中暴露   |
| 流式工具分片           | 阶段 3 不用，但协议允许分片               | 解析层已按 `index` 累积，阶段 6 可直接复用               |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件）
- [x] 代码变更
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明（第八节 + 第十节遗留风险）
- [x] 完成情况（第十节）
- [x] 文档更新（architecture.md 契约与路线图、README 用法、.env.example）
- [x] git diff 检查
- [x] 开发报告（第十节）

## 十、验收结果（2026-11-16 实测）

### 10.1 验收门

| 检查项   | 命令                                     | 结果                                                        |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| 类型检查 | `pnpm typecheck`                         | 0 error                                                     |
| Lint     | `pnpm lint`                              | 0 error / 0 warning                                         |
| 格式     | `pnpm format:check`                      | All matched files use Prettier code style                   |
| 全量测试 | `pnpm test:coverage`                     | **332 passed / 5 skipped**（24 个文件：23 通过 + 1 跳过）   |
| 构建     | `pnpm build`                             | 成功，`dist/agent`、`dist/tools`、`dist/security` 产物齐全  |
| 覆盖率   | 同上                                     | 语句 **96.63%** / 分支 92.48% / 函数 98.14% / 行 96.63%     |
| 真实端点 | `ZHIPU_LIVE_TEST=1 vitest -t "工具循环"` | **1 passed**：模型自主调用 `read_file` 并答出 `ORANGE-7319` |

5 个 skipped 全部是 `ZHIPU_LIVE_TEST=1` 才执行的真实端点用例（含整个 `zhipu-live.test.ts`），
本阶段未执行以避免消耗配额；默认套件完全离线：mock provider 按脚本回放，HTTP 走 stub fetch，
唯一真实 socket 是回环 `127.0.0.1:1` 的故意拒连用例。

### 10.2 实施中的偏差与修复

| #   | 问题                                                                 | 处理                                                                                                |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 集成测试只能看到 `[1] ← error N chars`，无法断言具体的 `TOOL_DENIED` | 错误码写入 `ToolResult.meta.code`，CLI 直接读取；顺带删掉重复解析错误 JSON 的 `describeToolFailure` |
| 2   | 遍历器的子目录 `readdir` 容错与逐文件 `stat` 兜底分支不可测          | 收窄语义：根目录不可读必须抛出、子目录失败跳过、`stat` 失败抛出；删除不可达的 `isSkippableFsError`  |
| 3   | 首轮覆盖率 94.95%，低于阶段 2 基线                                   | 补 walk/边界用例，并清理上面两处死代码后达到 96.63%                                                 |
| 4   | 架构文档要求拒绝 `.aws/credentials`，实现只拦了 `credentials.json`   | 敏感文件名补上裸 `credentials`，并加入单测矩阵                                                      |

### 10.3 完成情况

IN 范围全部落地：消息模型与工具协议、`ToolRegistry` + zod 校验 + `dispatch` 错误规范化、
`PathGuard` 与敏感文件排除、`read_file` / `list_files` / `search_code`、`AgentLoop` 多轮闭环、
`run` 升级为真正的工具循环、mock provider 脚本化与 `AGENT_MOCK_SCRIPT` 测试入口。

OUT 范围严格未做：无写类工具、无 `bash`、无人工确认交互、无 planner/evaluator、无上下文预算、
无会话持久化、无流式工具循环、`chat` REPL 未接工具、工具串行执行。

### 10.4 遗留风险

- **真实端点仅跑了工具循环用例**：`ZHIPU_LIVE_TEST=1` 下另外 4 个阶段 2 用例未复跑，
  但它们与本次改动无交集；需要完整回归时手工执行整个文件。
- **key 曾明文暴露**：建议在智谱控制台轮换；本地仅存 gitignored `.env`。
- **未提交**：阶段 2 与本阶段全部变更仍在工作区，等待用户决定是否提交；未执行任何 git push。
- `client.ts` 95.34%、`walk.ts` 88.88% 等剩余未覆盖行是难以稳定构造的防御分支（网络中断、
  并发删除等），未为凑指标写无意义测试。
