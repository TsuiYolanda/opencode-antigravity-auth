# opencode-antigravity-auth V2 移植设计（最小可用版）

日期：2026-10-07
分支：`v2-port`（基于上游 main `16e0056`）
状态：待用户评审

## 背景与目标

OpenCode 已升级到 V2（本机 v2.0.16），V2 插件 API 与 V1 断裂：入口必须是
`export default Plugin.define({ id, setup(ctx) })`。上游 `NoeFabris/opencode-antigravity-auth`
没有任何 V2 适配（全仓库 `Plugin.define` 零命中），npm 发版停在 2026-02-23，
但 main 分支活跃到 2026-08-27。因此 V2 下该插件加载失败，日志报
`Plugin must export a default definition ... Missing key ["default"]`。

目标：fork 到 `TsuiYolanda/opencode-antigravity-auth`，以最小改动让本机
opencode v2.0.16 重新可用以下 5 个模型（定义在 `~/.config/opencode/opencode.json`）：

- antigravity-gemini-3-pro
- antigravity-gemini-3.1-pro
- antigravity-gemini-3-flash
- antigravity-claude-sonnet-4-6
- antigravity-claude-opus-4-6-thinking

成功标准：插件在 V2 加载无 WARN；5 个模型各能正常完成一轮对话（含流式输出）；
现有 `~/.config/opencode/antigravity-accounts.json`（2026-09-14 登录）免重新登录直接复用。

## 上游 V1 机制（事实基础）

- V1 入口 `src/plugin.ts` 导出 Plugin 函数，返回
  `{ auth: { provider: "google", loader, methods }, event?, tool? }`。
- 拦截机制：`auth.loader` 返回 `{ apiKey, fetch }`，把**自定义 fetch 管线**
  挂到 google provider 上（`LoaderResult.fetch`，见 `src/plugin/types.ts:37`）。
- 管线内部（约 3451 行 `src/plugin.ts`）：多端点回退（`ANTIGRAVITY_ENDPOINT_FALLBACKS`）、
  多账号轮换（`AccountManager`）、429 限流处理与配额回退（antigravity ↔ gemini-cli）、
  thinking warmup、Claude↔Gemini 请求/响应转换（`prepareAntigravityRequest` /
  `transformAntigravityResponse`，含 SSE 流式转换）、token 刷新与退款。
- 判定请求是否拦截：`isGenerativeLanguageRequest()`（URL 指向
  `generativelanguage.googleapis.com`）。
- 账号存储：`~/.config/opencode/antigravity-accounts.json`（含 refresh token）；
  运行配置：`~/.config/opencode/antigravity.json`。
- 依赖：`@opencode-ai/plugin ^0.15.30`（V1 SDK）、zod 4、proper-lockfile、
  @openauthjs/openauth（仅登录流程用）。

## 方案：V2 http.request hook + loopback server（B'，2026-10-08 探针后修订）

核心思路：探针实证 V2 provider 运行时（Bun 打包）不走 `globalThis.fetch`，
globalThis 补丁无法拦截（方案 A 于 Task 1 gate 否决）；同时实证
`ctx.session.hook("http.request")` 可完整改写 provider 请求（URL/Request 替换生效，
响应可达）。因此：`setup()` 注册 `http.request` hook，把命中
`isGenerativeLanguageRequest()` 的请求**改道到插件自起的 loopback HTTP server**
（127.0.0.1 随机端口）；server handler 从 `x-antigravity-original-url` 头还原原始
Request，调用**原封不动的 V1 管线**（它本来就是 `fetch(input, init) → Response`
形状），把 Response（含 SSE 流）桥接回 loopback 连接。管线零改动、多端点重试与
账号切换语义完整保留；无需补丁全局、无需防递归。

被否决的备选：A）globalThis.fetch 补丁——探针否决（provider 运行时持有独立
fetch 引用）；B）把管线拆进 http.request/http.response 两个 hook——多端点重试
横跨请求全生命周期，response hook 无法重新发请求，需大改管线结构；C）V2
integration + provider transform 全原生重写——数周工作量，超出最小范围。

### 组件设计

1. **V2 入口 `src/v2/`（新增）**

   ```ts
   import { Plugin } from "@opencode/plugin"

   export default Plugin.define({
     id: "antigravity-auth",
     async setup(ctx) {
       // 1. loadConfig()/initRuntimeConfig() 读 antigravity.json
       // 2. initLogger / initializeDebug
       // 3. loadAccounts()；无账号 → pipeline 置空（请求返回指引性 503）
       // 4. initHealthTracker / initTokenTracker / initDiskSignatureCache
       // 5. pipeline = createAntigravityFetch(deps)（fetch 形状，内部用真实 fetch）
       // 6. 起 loopback HTTP server（127.0.0.1 随机端口，模块级单例）：
       //    handler 读 x-antigravity-original-url 头还原原始 Request，
       //    调 pipeline(request)，把 Response 桥接回连接（流式透传）
       // 7. ctx.session.hook("http.request")：命中 isGenerativeLanguageRequest 的
       //    请求改写为 loopback URL + 注入 x-antigravity-original-url 头
       // 8. token 主动刷新 interval（每 5 分钟检查临期 token 并调用现有
       //    refreshAccessToken；管线内按需刷新兜底）
       // return cleanup：关 loopback server、清 interval
     },
   })
   ```

2. **管线抽取（`src/plugin.ts` 唯一改动）**

   V1 管线是 `auth.loader` 闭包内的匿名 fetch 函数。抽取为可导出工厂：

   ```ts
   export function createAntigravityFetch(deps: PipelineDeps): typeof fetch
   ```

   闭包内对 V1 `client`（toast/事件）的依赖改为通过 `deps` 注入 stub：
   toast → 写入现有 debug 日志文件。循环体（端点回退、账号切换、warmup、
   流转换、429 处理）逐行保留，不改语义。V1 Plugin 函数本身保留并改用
   同一工厂，保证 V1 行为不回归（上游 vitest 套件可继续跑）。管线内部
   的出站请求直接用真实 `globalThis.fetch`（无补丁、无递归风险）。

3. **`index.ts`（改动）**：保留原命名导出，追加
   `export { default } from "./src/v2"`。

4. **依赖**：新增 `@opencode/plugin`（V2 SDK，版本对齐 opencode v2.0.x）；
   保留 `@opencode-ai/plugin`（`src/plugin.ts` 顶部 import `tool`，
   不动该文件其余部分）。

### 配置迁移（用户侧 `~/.config/opencode/opencode.json`）

- `"plugin"` → `"plugins"`（V2 规范键名）。
- 条目改为 git 引用，与 superpowers 同款：
  `"antigravity-auth@git+https://github.com/TsuiYolanda/opencode-antigravity-auth.git"`。
- 5 个模型定义原样保留。
- 待验证点：V2 下 google provider 无凭据可能被标记不可用。对策：provider
  settings 放占位 apiKey。占位 key 不会真的上网——命中拦截的请求被
  `prepareAntigravityRequest` 整体重写 URL 与 headers。实现时以 V2 配置
  文档实测为准。

## 错误处理

- 无账号文件 / 账号解析失败：插件照常加载；拦截到的请求经
  `createSyntheticErrorResponse` 返回带指引的错误（提示用 V1 opencode
  重新登录，或等待后续版本补登录流程）。
- token 刷新失败：沿用现有 `AntigravityTokenRefreshError` 路径与重试语义。
- loopback server 生命周期：模块级单例（多个 location 实例共享一个 server），
  cleanup 关闭 server 与刷新定时器；端口用 `listen(0)` 随机分配，避免冲突。
- hook 幂等：`http.request` 改道后 URL 已非 generativelanguage，重复注册的
  hook 自然跳过，无需额外防护。

## 明确不移植（最小版边界）

OAuth 登录流程（含 CLI 菜单与 OAuth listener）、google_search 自定义工具、
TUI toast（改日志 stub）、会话恢复 hook（tool_result_missing 自动恢复）、
自动更新检查器。

已知限制：
1. refresh token 彻底失效时无法重新登录（后续版本或临时回 V1 登录一次）。
2. Claude 模型下打断工具调用后可能报 tool_result_missing，重发一条消息恢复。
3. **拦截范围**：hook 会拦截本机发往 generativelanguage.googleapis.com 的全部
   provider 请求（含 title 生成等辅助请求），一律改走 Antigravity 管线。若日后
   同时在 google provider 上使用真实付费 API key 的普通 Gemini 模型，会被静默
   劫持到 Antigravity 配额——本 fork 假定 google provider 专用于 antigravity 模型。
4. **运行环境**：本机直连 Google 不通，opencode 进程需带 `HTTPS_PROXY`
   （如 `http://127.0.0.1:7890`）启动，否则 token 刷新与模型请求会陷入静默重试。
5. **进程级资源**：loopback server 为模块级单例，随 opencode server 进程存活，
   cleanup 只清理定时器并 dispose 各实例的 hook registration（多 location 实例
   共享 server，关闭会破坏兄弟实例）。
6. **调试开关**：环境变量 `AGA_DUMP_BODY=1` 会把命中拦截的原始请求体追加写入
   `$TMPDIR/aga-loopback-dump.json`（含对话内容，仅调试用）。

## 验证方案

1. **探针（前置门槛，已完成）**：实证 V2 provider 请求不走 `globalThis.fetch`
   （方案 A 否决），实证 `http.request` hook 可改写 URL 且响应可达（B' 依据）。
2. **单测**：跑上游 vitest 全量套件（约 40+ 测试文件），验证抽取重构
   无回归；为 `src/v2/` 补最小单测（无账号 503 路径、非 Google URL 放行、
   loopback 还原原始 URL、流式桥接）。
3. **本地实测**：`file://` 引用 dist 路径，5 个模型各发一条（含流式与
   工具调用至少一轮）。
4. **收尾**：改 git 引用 + `opencode service restart`，确认日志无
   failed-to-load WARN，`ctx.plugin.list()` 可见插件。

## 风险与回退

| 风险 | 概率 | 缓解 |
| --- | --- | --- |
| loopback 桥接破坏 SSE 流（node/http ↔ web stream） | 中 | Task 4 单测覆盖流式透传；E2E 实测 5 模型 |
| 抽取重构破坏 V1 管线 | 低 | vitest 全量 + 行为对照 |
| provider 无凭据被禁用 | 中 | 占位 apiKey，实测确认 |
| Bun 的 node:http 行为差异 | 低 | server 实现只用稳定 API（createServer/Readable.fromWeb） |
| 上游 main 后续大改难合并 | 中 | 独立 `v2-port` 分支，按需 rebase |

## 后续路线（本次不做）

1. V2 登录流程（`ctx.integration` OAuth method 或自定义 command）。
2. 会话恢复 hook 移植（`ctx.session.hook("context")` 修 messages）。
3. google_search 工具（`ctx.tool.transform`）。
4. 视情况向上游提 PR 或长期自维护。
