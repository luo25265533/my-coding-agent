# 阶段 2 开发 Plan：接入大模型（智谱 GLM）

状态：**待用户确认**（尚未实施）
日期：2026-11-13
交付目标：**能够持续对话的 CLI**

## 一、现状分析（实测证据）

### 1.1 阶段 1 已就绪的对接点

| 文件                      | 现状                                                                                                                                      | 阶段 2 如何用                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `src/config/schema.ts`    | `LLM_PROVIDERS = ['mock','openai-compatible']`；`superRefine` 已要求非 mock 时必填 `LLM_API_KEY`、openai-compatible 时必填 `LLM_BASE_URL` | 追加「非 mock 时必填 `LLM_MODEL`」校验 |
| `src/config/load.ts`      | `AppConfig.llm` 含 provider/apiKey/baseUrl/model/timeoutMs/maxRetries，已冻结                                                             | 直接消费，无需改结构                   |
| `src/shared/errors.ts`    | `ErrorCode` 仅 4 项（Config/Usage/LogSetup/Internal）                                                                                     | 新增 LLM 错误码并扩展退出码映射        |
| `src/cli/main.ts`         | `buildProgram()` 只注册 `run`                                                                                                             | 新增 `chat` 子命令                     |
| `src/logger/redact.ts`    | 已脱敏 apiKey/token/authorization/password/secret                                                                                         | 复用；确保 Authorization 头绝不入日志  |
| `src/cli/commands/run.ts` | 阶段 1 骨架，不调模型                                                                                                                     | **保持不变**，避免破坏既有 78 个用例   |

### 1.2 智谱端点实测（2026-11-13，全部真实调用）

URL 来源均为智谱**官方**文档，逐字核对，未使用任何代理地址。

| 探测         | URL                                                            | 结果                                                                                  |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 通用端点     | `https://open.bigmodel.cn/api/paas/v4/chat/completions`        | **HTTP 429**，`{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}` |
| 编码套餐端点 | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` | **HTTP 200**，正常返回                                                                |
| 多轮历史     | 同上，4 条 messages                                            | **HTTP 200**，正确答出历史中的 `42`，`prompt_tokens: 51`                              |
| 流式         | 同上，`stream:true`                                            | SSE 正常，`data: [DONE]` 终止                                                         |

官方出处：

- 通用端点：`https://docs.bigmodel.cn/cn/guide/develop/http/introduction`、`https://docs.bigmodel.cn/cn/api/introduction`
- 编码套餐端点：`https://docs.bigmodel.cn/cn/coding-plan/quick-start`（「接入端点说明」节逐字给出 `https://open.bigmodel.cn/api/coding/paas/v4`）
- OpenAI 兼容说明：`https://docs.bigmodel.cn/cn/guide/develop/openai/introduction`
- 模型编码 `glm-5.3`：`https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3`（官方 curl 示例逐字确认，非推断）

**结论：该 key 属 GLM Coding Plan，配额只在专属 coding 端点可用。** 通用端点报 1113 并非 key 无效——鉴权已通过，否则不会返回业务错误码。

### 1.3 实测得到的协议细节（直接决定设计）

非流式响应体：

```json
{
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": { "content": "42", "reasoning_content": "...", "role": "assistant" }
    }
  ],
  "model": "glm-5.3",
  "usage": {
    "prompt_tokens": 51,
    "completion_tokens": 17,
    "total_tokens": 68,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 14 }
  }
}
```

流式分块：`object:"chat.completion.chunk"`，`delta` 中**先出现 `reasoning_content`，后出现 `content`**；末块带 `finish_reason` 与完整 `usage`；终止符 `data: [DONE]`。

三个必须纳入设计的实测发现：

1. **`reasoning_content` 是独立字段**，不是正文的一部分，必须分离处理。
2. **`thinking:{"type":"disabled"}` 不可靠**：同一参数下，一次探测 `reasoning_tokens: 0`，另一次仍产生 14 个 reasoning tokens。设计上必须假定思考流随时存在，不能依赖该参数关闭。
3. **429 有两种语义**：`code=1113`（余额不足，**永久失败，不可重试**）与真实限流（**可重试**）。二者 HTTP 状态码相同，必须按 body 里的 `code` 区分，否则会对配额耗尽做无意义重试。

### 1.4 依赖约束实测

`npm view openai version engines` → 最新 `7.56.0` 要求 **Node >=22**，与阶段 1 方案 A（Node 20.18.1）冲突；`6.49.0`/`6.39.0`/`5.0.0` 未声明 engines。

## 二、已确认决策（用户通过提问确认）

| 决策       | 选择                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 客户端实现 | **手写 fetch 客户端**，零新依赖，用 Node 20 原生 fetch/AbortSignal/ReadableStream + zod 校验 |
| 对话形态   | **交互式 REPL，历史仅内存**，不做会话落盘                                                    |
| 思考流     | **分离展示，不计入对话历史**                                                                 |

不引入 `openai` SDK。理由：契合「从零理解实现原理」的项目目标，且避免 Node 22 门槛与重依赖。

## 三、范围

### 3.1 本次做（IN）

- `LLMProvider` 接口与消息结构（system/user/assistant）
- 手写 OpenAI 兼容 provider：非流式 + 流式（SSE 解析）
- mock provider：离线确定性响应，供测试与无 key 场景
- API 错误分类、重试（指数退避 + 抖动 + Retry-After）、超时（AbortSignal）
- token 统计（含 reasoning/cached 明细）
- `agent chat` 交互式 REPL，多轮对话，流式输出，思考流分离展示
- 配置校验补全（非 mock 必填 model）
- 单元测试 + 集成测试 + 真实端点冒烟（**opt-in**）

### 3.2 本次不做（OUT，防止范围膨胀）

- 工具调用 / function calling（阶段 3）
- 会话持久化、`--resume`、memory 模块（用户已选仅内存）
- planner / evaluator / context 压缩与 token 预算截断（仅统计，不截断）
- Anthropic 协议端点
- 改动 `run` 命令的既有行为

## 四、技术设计

### 4.1 消息结构与 Provider 契约（`src/llm/types.ts`）

```ts
export type Role = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
}

export interface ChatResponse {
  readonly content: string;
  readonly reasoningContent: string | undefined;
  readonly finishReason: string;
  readonly usage: TokenUsage;
  readonly model: string;
}

export type StreamChunk =
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'content'; readonly text: string }
  | { readonly type: 'done'; readonly response: ChatResponse };

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}
```

`exactOptionalPropertyTypes` 已开启，可选字段一律用 `T | undefined` 而非 `?`（沿用阶段 1 `AppConfig.apiKey` 的写法）。

架构文档原契约写作 `LLMClient`，本次按用户要求命名为 `LLMProvider`，实施后同步更新 `docs/architecture.md` 第 2.2 节。

### 4.2 目录与文件清单

```
src/llm/
├─ types.ts                     消息结构 + LLMProvider 契约
├─ errors.ts                    LlmError 分类与可重试判定
├─ factory.ts                   createLLMProvider(config)
└─ providers/
   ├─ mock.ts                   离线确定性 provider
   └─ openai-compatible/
      ├─ client.ts              fetch + 重试 + 超时 + 错误映射
      ├─ schema.ts              zod 响应/分块校验（宽松剥离未知字段）
      └─ sse.ts                 SSE 增量解析器
src/cli/commands/chat.ts        REPL
```

新增测试：`tests/unit/llm-{types,errors,sse,schema,mock,client}.test.ts`、`tests/unit/chat.test.ts`、`tests/integration/chat-smoke.test.ts`、`tests/integration/zhipu-live.test.ts`（opt-in）。

### 4.3 错误分类（`src/llm/errors.ts`）

新增 `ErrorCode`：`LlmAuth` / `LlmQuota` / `LlmRateLimit` / `LlmTimeout` / `LlmNetwork` / `LlmBadResponse` / `LlmAborted`，全部映射 `ExitCode.RuntimeError`（1）；配置缺失仍走既有 `ConfigInvalid`（2）。

| 情况                          | 判定                     | 可重试                   |
| ----------------------------- | ------------------------ | ------------------------ |
| 401 / 403                     | LlmAuth                  | 否                       |
| 429 且 body `code === '1113'` | **LlmQuota**             | **否**                   |
| 429 其他                      | LlmRateLimit             | 是（优先 `Retry-After`） |
| 400 / 404 / 422               | LlmBadResponse           | 否                       |
| 5xx                           | LlmBadResponse（服务端） | 是                       |
| fetch 抛错 / 连接失败         | LlmNetwork               | 是                       |
| 超时 abort                    | LlmTimeout               | 是                       |
| 用户 Ctrl+C                   | LlmAborted               | 否                       |
| zod 校验失败                  | LlmBadResponse           | 否                       |

错误消息**不得包含 key 或 Authorization 头**；只保留状态码、业务 code、服务端 message。

### 4.4 重试与超时

- 超时：`AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])`（Node 20.18.1 支持）。
- 退避：`min(base * 2^attempt, cap)` + 随机抖动；有 `Retry-After` 则优先。
- 次数：`config.llm.maxRetries`（默认 2）。
- **关键约束：流式一旦开始产出分块，就不再重试**——否则用户会看到重复输出。重试只发生在首字节之前。
- 每次重试写 `warn` 日志（含 attempt、原因、延迟），不含敏感头。

### 4.5 SSE 解析（`sse.ts`）

必须处理的真实情况：一个 TCP chunk 不等于一个事件；事件可能跨 chunk 截断；`\r\n` 与 `\n` 混用；`data:` 多行；空行分隔；`[DONE]` 终止；末块才带 `usage`。

实现：`TextDecoder` 增量解码 → 缓冲 → 按空行切分完整事件 → 逐条 `JSON.parse` → zod 校验 → 产出 `StreamChunk`。解析器做成纯函数式增量接口，便于用构造的分片做单测，不依赖网络。

### 4.6 REPL（`src/cli/commands/chat.ts`）

- `node:readline/promises` 逐轮读取；历史 `ChatMessage[]` 仅存内存。
- 每轮：追加 user → `provider.stream()` → 实时输出 → 结束后**只把 `content` 追加进历史**，`reasoning_content` 不入历史（避免污染下一轮 prompt 并节省 token）。
- 思考流用灰色 + 前缀区分正文；正文原样输出。
- 内置命令：`/exit` `/quit` `/clear` `/help`。
- Ctrl+C：第一次 abort 当前请求并回到提示符，第二次退出。
- 单轮出错**不终止 REPL**：打印错误、保留历史、继续下一轮。
- 每轮结束展示 token 用量（含 reasoning）。
- 退出时 `close()` 释放日志句柄（沿用阶段 1 `LoggerHandle` 契约）。

### 4.7 配置变更

`schema.ts` 的 `superRefine` 追加：`LLM_PROVIDER !== 'mock'` 时 `LLM_MODEL` 必填。`.env.example` 增加智谱官方端点示例（**用占位 key，绝不写真实 key**）。

## 五、任务分解

| #   | 任务                                                 | 依赖  |
| --- | ---------------------------------------------------- | ----- |
| P1  | 消息结构 + LLMProvider 契约 + 错误分类               | —     |
| P2  | zod 响应/分块 schema                                 | P1    |
| P3  | SSE 增量解析器                                       | P2    |
| P4  | mock provider                                        | P1    |
| P5  | openai-compatible client（fetch/重试/超时/错误映射） | P2 P3 |
| P6  | factory + 配置校验补全 + .env.example                | P4 P5 |
| P7  | chat REPL + CLI 注册                                 | P6    |
| P8  | 单元测试补齐                                         | P1–P7 |
| P9  | 集成冒烟（mock 离线）+ 真实端点 opt-in 冒烟          | P7    |
| P10 | 验收门 + 文档更新 + git diff + 开发报告              | P8 P9 |

## 六、测试计划（必须真实执行）

- **单元**：错误分类（含 429+1113 与 429 限流的区分）、退避与 Retry-After（fake timers）、超时 abort、SSE 分片/跨块/CRLF/多行 data/[DONE]/末块 usage、zod 缺字段与非法体、mock 确定性、REPL 历史追加与「reasoning 不入历史」、/clear、单轮报错不退出。
- **集成（默认套件，离线）**：真实子进程启动 `chat`，用 mock provider 喂入多轮输入，断言多轮上下文、退出码、日志落盘、**stdout 与日志均无密钥明文**。
- **真实端点冒烟（opt-in，默认跳过）**：仅当显式设置 `ZHIPU_LIVE_TEST=1` 时运行，key 只从环境变量读取。默认套件**不联网、不消耗配额**，避免网络抖动导致 CI 不稳定。
- **验收门**：`typecheck` / `lint` / `format:check` / `test` / `build` 全 0 error，覆盖率不低于阶段 1（94.93%）。
- 严禁把未执行的测试描述为已通过。

## 七、安全约束（AGENTS.md 第五节）

- 真实 key **只存在于 gitignored 的 `.env`**（已验证 `.gitignore:5` 命中，`git status` 未列出）。不写入源码、测试、fixture、文档、提交。
- 日志与错误消息绝不输出 Authorization 头或 key；沿用并必要时扩展 `REDACT_PATHS`。
- `.env.example` 只用占位符。
- 不执行 git push。
- 不改动 `run` 命令既有行为，避免破坏阶段 1 的 78 个用例。

## 八、风险与应对

| 风险                     | 说明                                                                                                      | 应对                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Coding Plan 合规限制** | 官方文档明示「GLM Coding Plan 仅限在官方支持的指定工具与产品环境中使用」，接入自建 Agent 可能不在许可范围 | 已如实告知用户，由用户判断；如需完全合规可改通用端点 + 按量充值 |
| **key 已明文暴露**       | key 出现在对话记录中                                                                                      | 建议用完在智谱控制台轮换；本地仅存 gitignored `.env`            |
| 429 语义歧义             | 1113 与限流同码                                                                                           | 按 body `code` 区分，配额错误不重试                             |
| thinking 参数不可靠      | 实测无法稳定关闭思考                                                                                      | 不依赖该参数；始终分离处理 reasoning_content                    |
| 流式重试重复输出         | 首字节后重试会重复                                                                                        | 仅在首字节前重试                                                |
| 真实网络测试不稳定       | 依赖外网与配额                                                                                            | 真实冒烟 opt-in，默认套件全离线                                 |
| 配额耗尽                 | 通用端点已实测 1113                                                                                       | 错误消息给出可读提示与充值指引，不静默失败                      |

## 九、交付清单（AGENTS.md 第七节）

- [x] Plan 文件（本文件）
- [x] 代码变更
- [x] 测试结果（真实执行数据，见第十节）
- [x] 风险说明（第八节 + 第十节新增风险）
- [x] 完成情况（第十节）
- [x] 文档更新（architecture.md 契约行与路线图、README 用法、.env.example）
- [x] git diff 检查
- [x] 开发报告

## 十、验收结果（2026-11-13 实测）

### 10.1 验收门

| 检查项          | 命令                       | 结果                                                          |
| --------------- | -------------------------- | ------------------------------------------------------------- |
| 类型检查        | `pnpm typecheck`           | 0 error                                                       |
| Lint            | `pnpm lint`                | 0 error / 0 warning                                           |
| 格式            | `pnpm format:check`        | All matched files use Prettier code style                     |
| 全量测试        | `pnpm test:coverage`       | **231 passed / 4 skipped**（17 个文件：16 通过 + 1 跳过）     |
| 构建            | `pnpm build`               | 成功，`dist/llm`、`dist/cli/commands/chat.js` 产物齐全        |
| 覆盖率          | 同上                       | 语句 **96.1%** / 分支 92.11% / 函数 **98.52%**（基线 94.93%） |
| 真实端点 opt-in | `ZHIPU_LIVE_TEST=1 vitest` | **4 passed**，打到官方 `open.bigmodel.cn/api/coding/paas/v4`  |

默认套件完全离线：provider 用 mock、HTTP 用 stub fetch，唯一真实 socket 是回环 `127.0.0.1:1`
（故意制造拒连以验证「单轮失败不退出 REPL」）。4 个真实端点用例默认 skipped，不消耗配额。

### 10.2 实施中发现并修复的真实缺陷

| #   | 缺陷                             | 症状                                                                                          | 修复                                                       |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | SSE 解析器无条件扣留末尾 `\r`    | `\r\r` 分隔的事件被延迟一个分片产出                                                           | 仅当末尾 `\r` 可能是跨分片 `\r\n` 前半时才扣留（`sse.ts`） |
| 2   | mock provider `chat` 同步抛错    | 声明返回 `Promise` 却同步 throw，`.catch()` 调用方接不到                                      | 改为 `async`，与真实客户端一致地 reject                    |
| 3   | REPL 逐轮 `rl.question` **丢行** | 管道输入一次性送达多行时，第二轮之后全部被丢弃                                                | 改用 `for await (const line of rl)` 异步迭代器             |
| 4   | REPL **EOF 不收尾**              | stdin 结束后待决 question 永不 settle，`finally` 不执行，`chat finished` 不落盘、日志流不关闭 | 同上；迭代器在 close 时正常结束                            |
| 5   | TTY 下 Ctrl+C 无效               | 原始模式 Ctrl+C 由 readline 截获，不产进程信号                                                | 额外注册 `rl.on('SIGINT', ...)`                            |

缺陷 3/4 由集成测试暴露：断言 `chat finished` 与第二轮输出时失败，实测复现后修实现，未削弱断言。

### 10.3 覆盖率补齐

首轮全量覆盖率仅 84.49%，低于基线。原因是真实缺口而非统计口径问题：

- `factory.ts` 16% → **100%**：此前完全没有单测。补 `llm-factory.test.ts`，并厘清分层——
  三个必填字段由 config 层 zod 先拦截，factory 的兜底判断只在程序化构造 `AppConfig` 时可达，
  两层分别用 `loadConfig` 与直接构造 `AppConfig` 覆盖。
- `chat.ts` 27.32% → **94.76%**：集成测试走子进程，v8 统计不到。补 `chat-command.test.ts`
  在进程内直接驱动 `chatCommand`（假 readline + 可控 provider），覆盖 /help、/clear、空行、
  EOF、--system/--model、思考流分离展示、单轮失败续跑、Ctrl+C 中止在飞请求与空闲退出。

### 10.4 完成情况

IN 范围全部落地：`LLMProvider` 契约与消息结构、智谱 OpenAI 兼容接入、错误分类与重试/超时、
流式 SSE、多轮对话 REPL。OUT 范围严格未做：未引入 openai SDK、未做会话落盘与 `--resume`、
未实现任何工具执行、未改动 `run` 命令行为（阶段 1 用例全部仍通过）。

### 10.5 遗留风险

- **Coding Plan 合规**：官方限定使用环境，自建 Agent 是否合规需用户自行确认（第八节）。
- **key 已明文暴露**：建议在智谱控制台轮换；本地仅存 gitignored `.env`。
- **未提交**：阶段 1 的 3 个文件与本阶段全部变更仍在工作区，等待用户决定是否提交；未执行任何 git push。
- `client.ts` 93.99%、`main.ts` 93.75% 的剩余未覆盖行是难以触发的防御分支与进程入口守卫，未为凑指标写无意义测试。
