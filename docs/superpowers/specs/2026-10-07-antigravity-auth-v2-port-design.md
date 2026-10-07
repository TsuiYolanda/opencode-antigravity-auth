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

## 方案：V2 入口 + globalThis.fetch 补丁（已选定，方案 A）

核心思路：插件确认在 V2 server 进程内加载（日志 role=server 可见 entrypoint）。
在 `setup()` 里猴补丁 `globalThis.fetch`，只拦截
`isGenerativeLanguageRequest()` 命中的请求进入原有管线，其余原样放行。
原有管线代码零行为改动，仅做一次位置抽取。

被否决的备选：B）改用 V2 `http.request`/`http.response` hook 重写传输层——
多端点重试/账号切换横跨请求全生命周期，response hook 无法重新发请求，
3451 行管线需大改；C）V2 integration + provider transform 全原生重写——
数周工作量，超出最小范围。

### 组件设计

1. **V2 入口 `src/v2.ts`（新增，约 200-400 行）**

   ```ts
   import { Plugin } from "@opencode/plugin"

   export default Plugin.define({
     id: "antigravity-auth",
     async setup(ctx) {
       // 1. loadConfig()/initRuntimeConfig() 读 antigravity.json
       // 2. initLogger / initializeDebug
       // 3. loadAccounts()；无账号 → 记录错误，仍继续装补丁（请求返回指引性错误）
       // 4. initHealthTracker / initTokenTracker / initDiskSignatureCache
       // 5. const pipeline = createAntigravityFetch(deps)  // deps 含 toast stub
       // 6. 补丁 globalThis.fetch（幂等保护，防重复装载）
       // 7. token 主动刷新定时器：简化 interval（每 5 分钟检查临期 token 并
       //    调用现有 refreshAccessToken；管线内按需刷新兜底），不移植完整
       //    refresh-queue 模块
       // return cleanup：恢复原始 fetch、清定时器
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
   同一工厂，保证 V1 行为不回归（上游 vitest 套件可继续跑）。

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
- fetch 补丁冲突：装载前检测是否已被本插件补丁过（幂等）；cleanup 恢复
  原始引用。

## 明确不移植（最小版边界）

OAuth 登录流程（含 CLI 菜单与 OAuth listener）、google_search 自定义工具、
TUI toast（改日志 stub）、会话恢复 hook（tool_result_missing 自动恢复）、
自动更新检查器。

已知限制：
1. refresh token 彻底失效时无法重新登录（后续版本或临时回 V1 登录一次）。
2. Claude 模型下打断工具调用后可能报 tool_result_missing，重发一条消息恢复。

## 验证方案

1. **探针（前置门槛）**：10 行临时 V2 插件补丁 `globalThis.fetch` 并打日志，
   以 `opencode --standalone` + 任意模型请求确认 V2 server 的 provider 请求
   走 `globalThis.fetch`。失败则整个方案 A 作废，退方案 B 并重新设计。
2. **单测**：跑上游 vitest 全量套件（约 40+ 测试文件），验证抽取重构
   无回归；为 `src/v2.ts` 补最小单测（无账号报错路径、非 Google URL 放行）。
3. **本地实测**：`file://` 引用 dist 路径，5 个模型各发一条（含流式与
   工具调用至少一轮）。
4. **收尾**：改 git 引用 + `opencode service restart`，确认日志无
   failed-to-load WARN，`ctx.plugin.list()` 可见插件。

## 风险与回退

| 风险 | 概率 | 缓解 |
| --- | --- | --- |
| V2 provider 请求不走 globalThis.fetch | 低 | 探针先行；失败退方案 B |
| 抽取重构破坏 V1 管线 | 低 | vitest 全量 + 行为对照 |
| V2 server 用 undici dispatcher 绕过补丁 | 低 | wrapper 透传 init，不改 dispatcher |
| provider 无凭据被禁用 | 中 | 占位 apiKey，实测确认 |
| 上游 main 后续大改难合并 | 中 | 独立 `v2-port` 分支，按需 rebase |

## 后续路线（本次不做）

1. V2 登录流程（`ctx.integration` OAuth method 或自定义 command）。
2. 会话恢复 hook 移植（`ctx.session.hook("context")` 修 messages）。
3. google_search 工具（`ctx.tool.transform`）。
4. 视情况向上游提 PR 或长期自维护。
