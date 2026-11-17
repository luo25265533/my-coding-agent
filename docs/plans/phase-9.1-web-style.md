# 阶段 9.1 开发 Plan：Web 界面改版（左侧历史 + 右下操作台 + 对话式事件流）

> 状态：已实施
> 日期：2026-11-17
> 类型：纯前端样式/交互改版（`src/web/public/` 三个文件），不改后端 API 与会话协议
> 前置：阶段 9（V1.1）已验收；改动叠加在同一工作区

## 一、需求（用户原话）

1. 历史记录移动到页面左侧宽度 300px，只展示记录标题超过 2 行溢出隐藏，详情默认收起来
2. 发起新任务操作台在右侧底部，运行事件采取对话式交互

## 二、已定决策（AskUserQuestion 确认）

| 决策         | 选择                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| 气泡布局     | 双气泡：用户任务靠右（强调色），Agent 事件靠左（中性/按结果着色），最终回答左侧绿色强调 |
| 历史详情交互 | 手风琴：点击标题在条目内展开/收起详情，默认收起                                         |

## 三、目标布局

```
┌──────────────────────────────────────────────────────┐
│ header：标题 | 状态徽章 | dropped | Token             │
├───────────┬──────────────────────────────────────────┤
│ 历史 300px│  对话区（flex:1 滚动）                     │
│ ┌────────┐│  ┌──────────────────────────────┐         │
│ │条目     ││  │            [用户任务气泡 →]  │         │
│ │标题≤2行 ││  │[← Agent 事件气泡]            │         │
│ │状态点   ││  │[← Plan 气泡 + 批准/拒绝按钮]  │         │
│ │────────││  │[← 最终回答（绿色强调）]        │         │
│ │详情收起 ││  └──────────────────────────────┘         │
│ │(点击展开)│  ├──────────────────────────────────────┤
│ └────────┘│  操作台（底部停靠）                        │
│ 刷新      │  [textarea 2-3行] [选项折叠行] [发送][中止]│
└───────────┴──────────────────────────────────────────┘
```

## 四、改动明细

### 4.1 `index.html`

- `main` 改为两栏：`aside.sidebar`（历史）+ `section.chat-main`（对话区 + 操作台）
- 历史：`h2 任务历史 + 刷新按钮` + `#task-list`（条目内含 `.task-head` 与 `.task-detail-accordion hidden`）
- 对话区：`#chat`（气泡容器，替换原 `#events`）
- 操作台：原 `#run-form`（textarea + 选项 + 发送/中止）移入 `.composer`，置于 chat-main 底部
- 删除原 `#decision` 独立盒子——决策 UI 改为对话区内气泡上的按钮

### 4.2 `app.js`

- `addEvent(kind, title, detail, preformatted)` → `addBubble(role, kind, title, detail, opts)`：
  - `role='user'`：右侧气泡（仅任务提交与用户视角消息）
  - `role='agent'`：左侧气泡，`kind` 决定描边/背景色（ok/error/plan/step/tool/info/answer）
  - 工具调用气泡默认收起参数预览（`<details>` 或点击展开），避免刷屏
- 决策流改造：`awaiting_plan` / `awaiting_confirm` 时在对应 Plan/确认气泡内追加
  批准/拒绝按钮；点击后按钮禁用，气泡保留作为对话记录（替代原 decision 盒子）
- 任务提交后追加一条右侧用户气泡（含时间），SSE 事件流全部落在左侧
- 历史条目：`taskRow` 改为手风琴——标题（`-webkit-line-clamp: 2`）+ 状态点 + 时间；
  点击切换展开，展开时按需 `GET /api/tasks/:id` 拉详情渲染（状态/步骤/验证/差异摘要），
  再点收起；默认全部收起
- `session_done` 后刷新历史并高亮当前任务条目；`showTaskDetail` 逻辑并入手风琴渲染
- 不变：token 逻辑、SSE 解析与重连、snapshot 回放（重建气泡）、`escapeHtml`、
  `describeToolResult/Verification/Diff`、事件类型映射

### 4.3 `style.css`

- `main` 改为 `grid-template-columns: 300px 1fr`；窄屏（≤900px）退化为上下堆叠
- 气泡样式：`.bubble-user`（右对齐、accent 背景）、`.bubble-agent`（左对齐、panel 背景、
  左描边按 kind 着色）、`.bubble-answer`（绿色强调）
- `.task-goal` 改为 2 行截断：`display:-webkit-box; -webkit-line-clamp:2; overflow:hidden`
- 手风琴样式与展开动画（简单 max-height/直接显示即可，不引动画库）
- `.composer` 底部停靠：`chat-main` 为 flex column，`#chat` flex:1 滚动
- 保持现有暗色主题变量与 badge 配色

## 五、不做（OUT）

- 不改后端：`server.ts`/`session.ts`/API 契约/SSE 协议零变更
- 不做历史会话回放到对话区（点历史只展开摘要详情）
- 不引入框架、打包器、新依赖；不改测试断言（现有测试均不触碰前端 DOM）

## 六、测试计划

1. `pnpm typecheck / lint / format:check / build` 全绿（app.js 在 eslint browser globals 范围内）
2. 真实浏览器验收（mock provider，零配额）：
   - 发任务 → 右侧用户气泡 + 左侧事件气泡实时滚动
   - Plan 确认：气泡内批准/拒绝按钮可用；高风险确认同样
   - 中止按钮出现在 running/awaiting_* 状态
   - 左侧历史：标题 2 行截断；默认收起；点击展开摘要、再点收起
   - 刷新页面：snapshot 回放重建气泡；历史高亮当前任务
3. `pnpm verify` 全绿（35 项，确认无回归）

## 七、交付清单

- [ ] Plan 文件（本文件）
- [ ] 代码变更（index.html / app.js / style.css）
- [ ] 浏览器验收记录（回填第九节）
- [ ] 文档更新（README Web 界面描述、CHANGELOG 1.1.0 条目补充、阶段 9.1 验收回填）
- [ ] git diff 检查
- [ ] 开发报告

## 八、风险

| 风险                          | 应对                                                    |
| ----------------------------- | ------------------------------------------------------- |
| snapshot 回放重建气泡顺序错乱 | 沿用现有 handleEvent 单一入口，只换渲染函数             |
| 决策按钮重复渲染              | 每次事件到达先清理旧按钮，`awaiting_*` 状态驱动重新挂载 |
| 历史条目点击与展开冲突        | 手风琴状态存 DOM（classList），点击仅切换               |
| 窄屏布局                      | 保留 ≤900px 媒体查询降级为堆叠                          |

## 九、验收结果（实施后回填）

### 9.1 门禁（真实执行）

| 门禁          | 结果                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| typecheck     | PASS（tsc --noEmit 无输出）                                                          |
| lint          | PASS（eslint . 无告警）                                                              |
| format:check  | 首跑 phase-9.1-web-style.md 格式告警 → `prettier --write` 修复后 PASS                |
| build         | PASS（tsc + copy-public）                                                            |
| test:coverage | 828 测试全过，覆盖率 95.59% statements / 89.96% branches / 99.74% functions（≥阈值） |
| verify        | PASS 35/35（阶段 8 离线验收，无回归）                                                |

### 9.2 浏览器验收（mock provider + AGENT_MOCK_SCRIPT，零配额）

serve 于 127.0.0.1:3211（临时工作区 `D:\tmp\agent-demo-91`，git 仓库）启动，逐项验证：

- 布局：`main` 网格实测 `300px / 1fr`（getComputedStyle），侧栏宽 300px；composer 底部停靠（bottom ≥ viewport-60）
- 发任务：右侧用户气泡（justify-content: flex-end，accent 背景）+ 左侧 banner/plan 等事件气泡按 kind 着色，实时滚动
- Plan 确认：按钮直接挂在 Plan 气泡内；批准后按钮禁用并追加 "✓ 已批准" 标记；拒绝路径验证 "✗ 已拒绝"
- 高风险确认：覆盖写 hello.txt 触发 `awaiting_confirm`，确认气泡（红色描边）含命令摘要与批准执行/拒绝按钮，批准后任务继续完成
- 中止：`awaiting_confirm` 时点中止 → 确认被解析为拒绝 → 工具失败 "operation aborted" → 会话结束，历史条目更新
- 历史：3 条任务条目渲染正常，标题 2 行截断（-webkit-line-clamp:2 生效），默认全部收起；点击展开懒加载详情（dataset.loaded 缓存），再点收起
- 刷新页面：snapshot 回放重建上一会话全部气泡与 finished 状态

### 9.3 实施中发现与修复

- 决策标记竞态：POST `/api/plan` 应答返回前，后续 SSE 事件先触发 `clearDecisionRef` 导致
  "✓ 已批准" 丢失。修复：`decide()` 点击时捕获气泡引用，应答后直接在该气泡上标记
  （`markDecision` → `noteDecision(bubble, approved)`）。

### 9.4 残余风险与已知限制

- snapshot 回放不含用户提交气泡（服务端事件流中无此事件），刷新后对话区只回放 Agent 侧气泡
- 历史详情为摘要文本（步骤/验证/diff 行），不提供 diff 全文与日志
- 窄屏（≤900px）为简单上下堆叠，未做移动端深度优化
