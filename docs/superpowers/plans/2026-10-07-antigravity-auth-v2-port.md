# opencode-antigravity-auth V2 移植 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 fork（TsuiYolanda/opencode-antigravity-auth，分支 `v2-port`）改造成 OpenCode V2 插件，通过 globalThis.fetch 补丁复用上游 V1 请求管线，让 5 个 antigravity 模型在 opencode v2.0.16 下可用。

**Architecture:** 新增 V2 入口（`Plugin.define` 默认导出），在 `setup()` 里初始化配置/账号后补丁 `globalThis.fetch`；把 V1 `auth.loader` 闭包内的 fetch 管线（src/plugin.ts 1454–2499 行）机械抽取为可导出工厂 `createAntigravityFetch`，管线逻辑零改动；V2 侧用账号文件构造 `getAuth`，client 依赖用 no-op stub。

**Tech Stack:** TypeScript、@opencode/plugin ^2.0.24（V2 SDK）、@opencode-ai/plugin ^0.15.30（保留，plugin.ts 仍引用）、vitest、npm。

**Spec:** `docs/superpowers/specs/2026-10-07-antigravity-auth-v2-port-design.md`

## Global Constraints

- 目标运行时：opencode v2.0.16；V2 SDK 固定 `@opencode/plugin@^2.0.24`（2026-10-07 时 latest）。
- 抽取必须是"只搬位置"：管线循环体逐行保留，唯一允许的新增是工厂签名与 deps 解构。
- 拦截方式（2026-10-08 修订，B'）：`ctx.session.hook("http.request")` 改道到插件 loopback HTTP server；**禁止**补丁 `globalThis.fetch`（探针已证对 provider 流量无效）。
- 所有 commit 只进本地 `v2-port` 分支；**任何 push 必须先获得用户明确确认**（Task 8 有专门 gate）。
- 保留 `@opencode-ai/plugin` 依赖，不删除（`src/plugin.ts` 顶部 import 它）。
- Task 8 之前不改用户的 `~/.config/opencode/opencode.json`。
- 仓库用 npm（有 package-lock.json）；测试 `npm test`（vitest run）；类型检查 `npm run typecheck`。
- 插件 id 固定为 `antigravity-auth`（Plugin storage 与诊断按 id 归属）。

## Review Focus

1. **非 Google 请求被拦截破坏**（hook 误伤其他 provider 流量）→ Task 2 步骤 1 的 passthrough 测试 + Task 4 步骤 1 的 hook 非命中放行测试。
2. **插件被多 location 重复加载导致 hook 重复改道/嵌套**（日志证实 server 会多次 load plugin）→ Task 4 步骤 4 的幂等测试（改道后的 loopback URL 不再命中 isGenerativeLanguageRequest，二次 hook 自然跳过）。
3. **账号文件缺失/为空时插件崩溃或请求泄漏到真 Google API** → Task 4 步骤 5 的 503 synthetic 响应测试 + Task 3 步骤 1 的空 snapshot 测试。
4. **SSE 流式响应被 loopback 桥接破坏**（5 个模型全部走 `:streamGenerateContent`）→ Task 4 步骤 6 的流式透传单测 + Task 7 对 5 个模型逐一真实请求验证。
5. **原始 URL 信息在改道时丢失**（管线按 URL 解析 model/family/quota）→ Task 4 步骤 3 的 `x-antigravity-original-url` 还原测试。

---

### Task 1: 探针——验证 V2 server 的 provider 请求走 globalThis.fetch

> **结果（2026-10-08 已执行）**：gate 对方案 A 否决——provider 请求不走 `globalThis.fetch`（Bun 打包的 provider 运行时持有独立 fetch 引用），但实证 `http.request` hook 可完整改写 provider 请求与响应路径。用户已批准切换 B'（loopback server 形态）。本任务无需重跑。

**Files:**
- Create（仓库外，throwaway）: `$TMPDIR/opencode/aga-probe/package.json`、`$TMPDIR/opencode/aga-probe/index.mjs`、`$TMPDIR/opencode/aga-e2e-probe/opencode.json`

**Interfaces:**
- Consumes: 无
- Produces: 结论（gate）。补丁路径成立 → 继续 Task 2；不成立 → 停止，报告用户，退方案 B 重新设计。

- [ ] **Step 1: 创建探针插件目录**

```bash
probe="$TMPDIR/opencode/aga-probe"; mkdir -p "$probe"
cat > "$probe/package.json" <<'EOF'
{ "name": "aga-probe", "private": true, "type": "module" }
EOF
npm install --prefix "$probe" @opencode/plugin@2.0.24 --silent
cat > "$probe/index.mjs" <<'EOF'
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"

export default Plugin.define({
  id: "fetch-probe",
  setup() {
    const original = globalThis.fetch
    appendFileSync(`${tmpdir()}/aga-probe.log`, `loaded pid=${process.pid}\n`)
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input)
      appendFileSync(`${tmpdir()}/aga-probe.log`, `FETCH ${url}\n`)
      return original(input, init)
    }
  },
})
EOF
```

- [ ] **Step 2: 创建临时项目并触发一次模型请求**

```bash
e2e="$TMPDIR/opencode/aga-e2e-probe"; mkdir -p "$e2e"
cat > "$e2e/opencode.json" <<EOF
{ "plugins": ["file://$probe"] }
EOF
rm -f "$TMPDIR/aga-probe.log" 2>/dev/null; rm -f /tmp/aga-probe.log 2>/dev/null
cd "$e2e" && opencode --standalone run "reply with exactly: ok" 2>&1 | tail -5
cat "$TMPDIR/aga-probe.log" /tmp/aga-probe.log 2>/dev/null | head -20
```

Expected: 日志出现 `loaded pid=...` 且至少一条 `FETCH <url>`，其中包含 zhipuai/bigmodel 或其他 LLM API 域名（证明 provider 请求经过 globalThis.fetch）。模型用默认（GLM）即可，本任务不涉及 antigravity。

- [ ] **Step 3: 判定 gate 并清理**

若看到 provider API 的 FETCH 行 → gate 通过。清理：

```bash
rm -rf "$TMPDIR/opencode/aga-probe" "$TMPDIR/opencode/aga-e2e-probe" "$TMPDIR/aga-probe.log" /tmp/aga-probe.log
```

若没有 loaded 行（插件没加载）→ 检查 file:// 引用格式后重试一次；若 provider 请求不走 globalThis.fetch → **停止并报告**（方案 A 前提不成立）。

---

### Task 2: 抽取 createAntigravityFetch 工厂（V1 行为不变）

**Files:**
- Modify: `src/plugin/types.ts`（文件末尾追加接口）
- Modify: `src/plugin.ts`（1413–1500 区域与 1454–2499 行迁移；860 行加 export）
- Test: `src/plugin/fetch-factory.test.ts`（新建）

**Interfaces:**
- Consumes: `GetAuth`、`AccountManager`（`src/plugin/accounts.ts:316` `static loadFromDisk(authFallback?)`）、`AntigravityConfig`（`loadConfig(directory)`）
- Produces:
  - `createAntigravityFetch(deps: AntigravityFetchDeps): (input: RequestInfo, init?: RequestInit) => Promise<Response>`
  - `AntigravityFetchDeps { getAuth: GetAuth; accountManager: AccountManager; client: PipelineClient; config: AntigravityConfig; providerId: string }`
  - `PipelineClient { tui: { showToast(i: { body: { message: string; variant: string } }): Promise<unknown> }; auth: { set(i: { path: { id: string }; body: { type: "oauth"; refresh: string; access: string; expires: number } }): Promise<unknown> } }`
  - `buildAuthSuccessFromStoredAccount(account: { refreshToken: string; projectId?: string; managedProjectId?: string; email?: string })`（从 plugin.ts 导出，Task 3/4 用）

- [ ] **Step 1: 写失败测试**

`src/plugin/fetch-factory.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAntigravityFetch } from "../plugin";
import { loadConfig } from "../plugin/config";
import type { AntigravityFetchDeps } from "../plugin/types";

let cfgDir: string;
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = (cfgDir = mkdtempSync(join(tmpdir(), "aga-cfg-")));
});
afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

const GENERATIVE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent";

function makeDeps(overrides: Partial<AntigravityFetchDeps> = {}): AntigravityFetchDeps {
  return {
    getAuth: vi.fn(async () => ({ type: "oauth", access: "a", expires: Date.now() + 3_600_000, refresh: "rt|p|m" })),
    accountManager: { getAccountCount: () => 1 } as unknown as AntigravityFetchDeps["accountManager"],
    client: { tui: { showToast: vi.fn() }, auth: { set: vi.fn() } } as unknown as AntigravityFetchDeps["client"],
    config: loadConfig(mkdtempSync(join(tmpdir(), "aga-proj-"))),
    providerId: "google",
    ...overrides,
  };
}

describe("createAntigravityFetch", () => {
  it("passes non-generative requests straight to global fetch without reading auth", async () => {
    const passthrough = vi.fn(async () => new Response("passthrough"));
    vi.stubGlobal("fetch", passthrough);
    try {
      const deps = makeDeps();
      const f = createAntigravityFetch(deps);
      await f("https://example.com/v1/x", { method: "GET" });
      expect(passthrough).toHaveBeenCalledWith("https://example.com/v1/x", { method: "GET" });
      expect(deps.getAuth).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes through when auth is not OAuth", async () => {
    const passthrough = vi.fn(async () => new Response("passthrough"));
    vi.stubGlobal("fetch", passthrough);
    try {
      const deps = makeDeps({ getAuth: vi.fn(async () => ({ type: "api", key: "k" })) });
      await createAntigravityFetch(deps)(GENERATIVE_URL);
      expect(passthrough).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws the actionable error when no accounts exist", async () => {
    const deps = makeDeps({ accountManager: { getAccountCount: () => 0 } as unknown as AntigravityFetchDeps["accountManager"] });
    await expect(createAntigravityFetch(deps)(GENERATIVE_URL)).rejects.toThrow(/No Antigravity accounts/);
  });
});
```

（第一支测试里 `deps.getRawAuthNever` 行是笔误防护可有可无——删掉它，只保留 `expect(deps.getAuth).not.toHaveBeenCalled()`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugin/fetch-factory.test.ts`
Expected: FAIL，`createAntigravityFetch is not a function`（未导出）。

- [ ] **Step 3: 实施抽取**

`src/plugin/types.ts` 末尾追加（需要的话在文件头部补 `import type { AccountManager } from "./accounts"; import type { AntigravityConfig } from "./config";`，必须用 `import type` 防运行时循环依赖）：

```ts
/** The minimal client surface the request pipeline needs. V1 PluginClient satisfies this structurally. */
export interface PipelineClient {
  tui: {
    showToast(input: { body: { message: string; variant: string } }): Promise<unknown>;
  };
  auth: {
    set(input: {
      path: { id: string };
      body: { type: "oauth"; refresh: string; access: string; expires: number };
    }): Promise<unknown>;
  };
}

export interface AntigravityFetchDeps {
  getAuth: GetAuth;
  accountManager: AccountManager;
  client: PipelineClient;
  config: AntigravityConfig;
  providerId: string;
}
```

`src/plugin.ts`：

1. 顶部 import 增加 `AntigravityFetchDeps`（from "./plugin/types" 的既有 import 里加）。
2. 860 行 `function buildAuthSuccessFromStoredAccount` 前加 `export`。
3. 在 `createAntigravityPlugin` 定义之前（建议紧跟 `resetAllRateLimitStateForAccount` 等辅助函数区之后）新增工厂：

```ts
export function createAntigravityFetch(
  deps: AntigravityFetchDeps,
): (input: RequestInfo, init?: RequestInit) => Promise<Response> {
  const { getAuth, accountManager, client, config, providerId } = deps;
  return async function antigravityPipelineFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    // === 原 loader fetch 方法体（现 1455–2498 行）原样移入，不改一字 ===
  };
}
```

4. 把现 1454–2499 行（`async fetch(input, init) {` 起到 2499 行 `},` 止）的方法体移入上面的工厂内层函数，然后在 loader 原位置替换为：

```ts
      return {
        apiKey: "",
        fetch: createAntigravityFetch({ getAuth, accountManager, client, config, providerId }),
      };
```

- [ ] **Step 4: 跑新测试与全量回归**

Run: `npx vitest run src/plugin/fetch-factory.test.ts && npm run typecheck`
Expected: 3 支全 PASS，typecheck 无错。

Run: `npm test`
Expected: 全量通过（上游约 40+ 测试文件）。若个别测试因 import 结构变化失败，修 import 不改断言。

- [ ] **Step 5: Commit**

```bash
git add src/plugin.ts src/plugin/types.ts src/plugin/fetch-factory.test.ts
git commit -m "refactor: extract createAntigravityFetch factory from auth loader"
```

---

### Task 3: createAccountsGetAuth——账号文件 → V1 形状的 getAuth

**Files:**
- Create: `src/v2/getauth.ts`
- Test: `src/v2/getauth.test.ts`

**Interfaces:**
- Consumes: `AccountManager`（constructor `(authFallback?: OAuthAuthDetails, stored?: AccountStorageV4 | null)`）、`formatRefreshParts`（`src/plugin/auth.ts`）、`ManagedAccount.parts: RefreshParts`
- Produces: `createAccountsGetAuth(accountManager: AccountManager): GetAuth`（Task 4 用）

- [ ] **Step 1: 写失败测试**

`src/v2/getauth.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { AccountManager } from "../plugin/accounts";
import { parseRefreshParts } from "../plugin/auth";
import { createAccountsGetAuth } from "./getauth";

const STORED = {
  version: 4,
  accounts: [
    { refreshToken: "rt-1", projectId: "p1", managedProjectId: "m1", email: "a@b.c" },
  ],
  activeIndex: 0,
  activeIndexByFamily: { claude: 0, gemini: 0 },
};

describe("createAccountsGetAuth", () => {
  it("returns OAuth-shaped auth built from the first stored account", async () => {
    const am = new AccountManager(undefined, STORED as never);
    const auth = await createAccountsGetAuth(am)();
    expect(auth.type).toBe("oauth");
    const parts = parseRefreshParts((auth as { refresh: string }).refresh);
    expect(parts.refreshToken).toBe("rt-1");
    expect(parts.projectId).toBe("p1");
  });

  it("returns an empty OAuth placeholder when no accounts exist", async () => {
    const am = new AccountManager(undefined, { ...STORED, accounts: [] } as never);
    const auth = await createAccountsGetAuth(am)();
    expect(auth.type).toBe("oauth");
    expect(parseRefreshParts((auth as { refresh: string }).refresh).refreshToken).toBe("");
  });
});
```

（执行时先对照 `src/plugin/storage.ts` 的 `AccountStorageV4` 字段名，若 fixture 字段有出入以 storage.ts 为准修正 fixture，不改被测代码意图。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/getauth.test.ts`
Expected: FAIL，无法解析 `./getauth`。

- [ ] **Step 3: 实现**

`src/v2/getauth.ts`：

```ts
import type { AccountManager } from "../plugin/accounts";
import { formatRefreshParts } from "../plugin/auth";
import type { AuthDetails, GetAuth, OAuthAuthDetails } from "../plugin/types";

/**
 * V2 replacement for V1's opencode-auth-store getAuth(): derives the
 * OAuth details from the accounts file via AccountManager. The pipeline
 * only uses getAuth() as an OAuth gate (line ~1459) plus cold-start
 * refresh; per-request auth is managed inside the pipeline itself.
 */
export function createAccountsGetAuth(accountManager: AccountManager): GetAuth {
  return async (): Promise<AuthDetails> => {
    const snapshot = accountManager.getAccountsSnapshot();
    const account = snapshot[0];
    if (!account) {
      // OAuth-shaped placeholder with empty parts: the pipeline's own
      // account-count check throws the actionable error message.
      return { type: "oauth", access: "", expires: 0, refresh: formatRefreshParts({}) } as OAuthAuthDetails;
    }
    return {
      type: "oauth",
      access: account.access ?? "",
      expires: account.expires ?? 0,
      refresh: formatRefreshParts(account.parts),
    } as OAuthAuthDetails;
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/getauth.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/v2/getauth.ts src/v2/getauth.test.ts
git commit -m "feat(v2): accounts-file backed getAuth adapter"
```

---

### Task 4: V2 入口 src/v2/index.ts（loopback server + http.request hook）

**Files:**
- Create: `src/v2/index.ts`、`src/v2/loopback.ts`
- Test: `src/v2/index.test.ts`、`src/v2/loopback.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createAntigravityFetch`、`buildAuthSuccessFromStoredAccount`；Task 3 的 `createAccountsGetAuth`；`loadConfig/initRuntimeConfig`（`src/plugin/config`）、`initializeDebug`（`src/plugin/debug`）、`initLogger`（`src/plugin/logger`）、`initAntigravityVersion`（`src/plugin/version`）、`initHealthTracker/initTokenTracker`（`src/plugin/rotation`）、`initDiskSignatureCache`（`src/plugin/cache`）、`AccountManager`、`loadAccounts`（`src/plugin/storage`）、`refreshAccessToken`（`src/plugin/token`）、`accessTokenExpired/isOAuthAuth`（`src/plugin/auth`）、`isGenerativeLanguageRequest`（`src/plugin/request`）、`ANTIGRAVITY_PROVIDER_ID`（`src/constants`）
- Produces: `createLoopbackServer(pipeline)`（loopback.ts，Task 4 内部用 + 测试用）、`rewriteRequestToLoopback(request, port)`（loopback.ts）、`default`（Plugin 定义，Task 5 接到根 index.ts）

**设计要点（锁定）：**
- hook 改道：`event.request = new Request(loopbackUrl, event.request)` + 追加头 `x-antigravity-original-url: <原始 URL>`。改道后的 URL 不命中 `isGenerativeLanguageRequest`，重复注册的 hook 自然跳过（幂等免费获得）。
- loopback handler：读出请求体 → 用原始 URL 头重建 `Request` → `pipeline(request)` → 把 Response 的 status/headers/body（含 web ReadableStream）桥接回 node:http 的 res。
- 单例：server 与 pipeline 模块级共享（多个 location 实例复用同一个）。

- [ ] **Step 1: 写 loopback 的失败测试**

`src/v2/loopback.test.ts`：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createLoopbackServer, rewriteRequestToLoopback, ORIGINAL_URL_HEADER } from "./loopback";

const servers: Array<ReturnType<typeof createLoopbackServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const GENERATIVE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

describe("rewriteRequestToLoopback", () => {
  it("redirects a generative request to the loopback origin and preserves method/headers/body", async () => {
    const req = new Request(GENERATIVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer placeholder" },
      body: JSON.stringify({ contents: [] }),
    });
    const rewritten = rewriteRequestToLoopback(req, 37899);
    expect(rewritten.url).toBe("http://127.0.0.1:37899/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get(ORIGINAL_URL_HEADER)).toBe(GENERATIVE_URL);
    expect(rewritten.headers.get("authorization")).toBe("Bearer placeholder");
    await expect(rewritten.text()).resolves.toContain("contents");
  });

  it("leaves non-generative requests untouched", () => {
    const req = new Request("https://example.com/v1/x");
    expect(rewriteRequestToLoopback(req, 37899)).toBe(req);
  });
});

describe("createLoopbackServer", () => {
  it("rebuilds the original request and returns the pipeline response", async () => {
    let seen: { url: string; method: string; body: string } | null = null;
    const pipeline = async (input: RequestInfo): Promise<Response> => {
      const r = input as Request;
      seen = { url: r.url, method: r.method, body: await r.text() };
      return new Response("pipeline-says", { status: 299, headers: { "content-type": "text/plain" } });
    };
    const server = createLoopbackServer(pipeline as never);
    servers.push(server);
    const port = await server.listen();
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/v1beta/models/x:generateContent`, {
      method: "POST",
      headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL, "content-type": "application/json" },
      body: "hello-body",
    });
    expect(res.status).toBe(299);
    await expect(res.text()).resolves.toBe("pipeline-says");
    expect(seen).not.toBeNull();
    expect((seen as NonNullable<typeof seen>).url).toBe(GENERATIVE_URL);
    expect((seen as NonNullable<typeof seen>).body).toBe("hello-body");
  });

  it("streams SSE bodies through chunk by chunk", async () => {
    const chunks = ["data: {\"a\":1}\n\n", "data: {\"a\":2}\n\n"];
    const pipeline = async (): Promise<Response> =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const server = createLoopbackServer(pipeline as never);
    servers.push(server);
    const port = await server.listen();
    const res = await fetch(`http://127.0.0.1:${port}/x`, { headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL } });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await expect(res.text()).resolves.toBe(chunks.join(""));
  });

  it("responds 503 with guidance when pipeline is absent", async () => {
    const server = createLoopbackServer(null);
    servers.push(server);
    const port = await server.listen();
    const res = await fetch(`http://127.0.0.1:${port}/x`, { headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL } });
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toMatch(/antigravity-auth/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/loopback.test.ts`
Expected: FAIL，无法解析 `./loopback`。

- [ ] **Step 3: 实现 loopback.ts**

`src/v2/loopback.ts`：

```ts
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export const ORIGINAL_URL_HEADER = "x-antigravity-original-url";

export type PipelineFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/** Redirect a generative-language request to the loopback origin, carrying the
 *  original URL in a header; non-generative requests are returned untouched. */
export function rewriteRequestToLoopback(request: Request, port: number): Request {
  if (!isGenerativeLanguageRequestUrl(request.url)) return request;
  const original = new URL(request.url);
  const target = new URL(request.url);
  target.protocol = "http:";
  target.host = `127.0.0.1:${port}`;
  const headers = new Headers(request.headers);
  headers.set(ORIGINAL_URL_HEADER, request.url);
  return new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    duplex: "half",
  } as RequestInit);
}

export interface LoopbackHandle {
  port: number;
  close(): Promise<void>;
}

function isGenerativeLanguageRequestUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

/** Bridges node:http req/res to the fetch-shaped pipeline. */
export function createLoopbackServer(pipeline: PipelineFetch | null): LoopbackHandle & { listen(): Promise<number> } {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const originalUrl = req.headers[ORIGINAL_URL_HEADER];
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);

        if (!pipeline || typeof originalUrl !== "string") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "opencode-antigravity-auth (V2): no accounts configured. " +
                  "Re-login needs the V1 flow until the V2 login port lands (see docs/superpowers/specs).",
              },
            }),
          );
          return;
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (name === ORIGINAL_URL_HEADER || name === "host" || name === "connection" || name === "content-length") continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }

        const request = new Request(originalUrl, {
          method: req.method,
          headers,
          body: body.length > 0 ? body : undefined,
        });

        const response = await pipeline(request);
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (k === "content-length" || k === "transfer-encoding" || k === "connection" || k === "content-encoding") return;
          outHeaders[k] = v;
        });
        res.writeHead(response.status, outHeaders);
        if (!response.body) {
          res.end();
          return;
        }
        Readable.fromWeb(response.body as never).pipe(res);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `loopback failure: ${String(error)}` } }));
      }
    })();
  });

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("no port"));
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
```

（注意：`isGenerativeLanguageRequest` 若在 `src/plugin/request.ts` 的导出签名可直接复用，则用它替换本地的 `isGenerativeLanguageRequestUrl`——实现时核对签名后择一，删除另一个。）

- [ ] **Step 4: 跑 loopback 测试确认通过**

Run: `npx vitest run src/v2/loopback.test.ts && npm run typecheck`
Expected: 5 支全 PASS。

- [ ] **Step 5: 写 v2 入口的失败测试**

`src/v2/index.test.ts`（只测可纯测的部分：hook 的注册与改道委托。setup 的端到端在 Task 7 E2E 覆盖）：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildRequestHook } from "./index";
import { ORIGINAL_URL_HEADER } from "./loopback";

const GENERATIVE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

describe("buildRequestHook", () => {
  it("rewrites generative requests to the loopback origin with the original-url header", () => {
    const port = 37899;
    const hook = buildRequestHook(port);
    const event = { request: new Request(GENERATIVE_URL, { method: "POST", body: "{}" }), kind: "primary", sessionID: "s", headers: {} } as never;
    hook(event);
    const req = (event as { request: Request }).request;
    expect(req.url).toContain(`http://127.0.0.1:${port}/`);
    expect(req.headers.get(ORIGINAL_URL_HEADER)).toBe(GENERATIVE_URL);
  });

  it("leaves non-generative requests untouched", () => {
    const hook = buildRequestHook(37899);
    const original = new Request("https://api.example.com/v1/x");
    const event = { request: original, kind: "primary", sessionID: "s", headers: {} } as never;
    hook(event);
    expect((event as { request: Request }).request).toBe(original);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run src/v2/index.test.ts`
Expected: FAIL，无法解析 `./index`（或 buildRequestHook 未导出）。

- [ ] **Step 7: 实现 src/v2/index.ts**

```ts
import { Plugin } from "@opencode/plugin";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { initDiskSignatureCache } from "../plugin/cache";
import { loadConfig, initRuntimeConfig, type AntigravityConfig } from "../plugin/config";
import { initializeDebug } from "../plugin/debug";
import { initLogger } from "../plugin/logger";
import { initAntigravityVersion } from "../plugin/version";
import { initHealthTracker, initTokenTracker } from "../plugin/rotation";
import { AccountManager } from "../plugin/accounts";
import { loadAccounts } from "../plugin/storage";
import { createAntigravityFetch, buildAuthSuccessFromStoredAccount } from "../plugin";
import { accessTokenExpired, isOAuthAuth } from "../plugin/auth";
import { refreshAccessToken } from "../plugin/token";
import type { PluginClient } from "../plugin/types";
import { createAccountsGetAuth } from "./getauth";
import { createLoopbackServer, rewriteRequestToLoopback, type PipelineFetch } from "./loopback";

const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function makeStubClient(): PluginClient {
  return {
    tui: { showToast: async () => {} },
    auth: { set: async () => {} },
    app: { log: async () => {} },
  } as unknown as PluginClient;
}

function initTrackers(config: AntigravityConfig): void {
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score,
    });
  }
  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens,
    });
  }
  if (config.keep_thinking) {
    initDiskSignatureCache(config.signature_cache);
  }
}

/** Module-level singleton: opencode loads one plugin instance per location,
 *  and every instance must share one loopback server and pipeline. */
const state: { pipeline: PipelineFetch | null; handle: Awaited<ReturnType<typeof startLoopback>> | null } = {
  pipeline: null,
  handle: null,
};

async function startLoopback(pipeline: PipelineFetch | null) {
  const server = createLoopbackServer(pipeline);
  const port = await server.listen();
  return { port, close: server.close };
}

/** Exported for tests: the raw hook body. */
export function buildRequestHook(port: number) {
  return (event: { request: Request }) => {
    event.request = rewriteRequestToLoopback(event.request, port);
  };
}

export default Plugin.define({
  id: "antigravity-auth",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const config = loadConfig(directory);
    initRuntimeConfig(config);
    initializeDebug(config);
    initLogger(makeStubClient());
    await initAntigravityVersion();
    initTrackers(config);

    const stored = await loadAccounts();
    const accounts = stored?.accounts ?? [];

    if (!state.handle) {
      if (accounts.length > 0) {
        const authFallback = buildAuthSuccessFromStoredAccount(accounts[0]);
        const accountManager = await AccountManager.loadFromDisk(authFallback);
        if (accountManager.getAccountCount() > 0) accountManager.requestSaveToDisk();
        const getAuth = createAccountsGetAuth(accountManager);
        state.pipeline = createAntigravityFetch({
          getAuth,
          accountManager,
          client: makeStubClient(),
          config,
          providerId: ANTIGRAVITY_PROVIDER_ID,
        });

        const timer = setInterval(() => {
          void (async () => {
            try {
              const auth = await getAuth();
              if (!isOAuthAuth(auth) || !accessTokenExpired(auth)) return;
              await refreshAccessToken(auth, makeStubClient(), ANTIGRAVITY_PROVIDER_ID);
            } catch {
              /* per-request refresh inside the pipeline is the load-bearing path */
            }
          })();
        }, REFRESH_CHECK_INTERVAL_MS);

        state.handle = await startLoopback(state.pipeline);
        const handle = state.handle;
        await ctx.session.hook("http.request", buildRequestHook(handle.port));
        return () => {
          clearInterval(timer);
        };
      }
      state.handle = await startLoopback(null);
    }
    const handle = state.handle;
    await ctx.session.hook("http.request", buildRequestHook(handle.port));
    return () => {};
  },
});
```

（实现时以 typecheck 为准对齐 `ctx.session.hook` 的事件类型；hook 回调里只改 `event.request`。）

- [ ] **Step 8: 跑入口测试与全量类型检查**

Run: `npx vitest run src/v2/index.test.ts && npm run typecheck`
Expected: 2 支 PASS，typecheck 无错。

- [ ] **Step 9: Commit**

```bash
git add src/v2/index.ts src/v2/index.test.ts src/v2/loopback.ts src/v2/loopback.test.ts
git commit -m "feat(v2): loopback server + http.request hook entry"
```


### Task 5: 构建接线——SDK 依赖、根入口、产物验证

**Files:**
- Modify: `package.json`（dependencies 加 `"@opencode/plugin": "^2.0.24"`）
- Modify: `index.ts`（根入口）

**Interfaces:**
- Consumes: Task 4 的 `src/v2/index.ts` default 导出
- Produces: `dist/index.js` 含合法 default 导出（`{ id: "antigravity-auth", ... }`）

- [ ] **Step 1: 加依赖**

```bash
npm install @opencode/plugin@^2.0.24
```

- [ ] **Step 2: 改根入口**

`index.ts` 全文替换为：

```ts
import v2Plugin from "./src/v2";

export default v2Plugin;

export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";

export { authorizeAntigravity, exchangeAntigravity } from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";
```

- [ ] **Step 3: 构建并验证产物**

```bash
npm run build
node --input-type=module -e "import('./dist/index.js').then(m => { const d = m.default; if (!d || d.id !== 'antigravity-auth') throw new Error('bad default: ' + JSON.stringify(d)?.slice(0,120)); console.log('dist default ok:', d.id); })"
```

Expected: `dist default ok: antigravity-auth`。tsconfig.build.json 的 include 是 `src/**/*.ts` + `index.ts`，`src/v2/` 自动覆盖，无需改。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json index.ts
git commit -m "feat(v2): wire V2 default export into package entrypoint"
```

---

### Task 6: 全量回归

**Files:** 无新增（验证性任务）

**Interfaces:**
- Consumes: Task 2–5 全部产物
- Produces: 绿色基线结论

- [ ] **Step 1: 类型检查 + 全量测试 + 构建**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 全部通过。若上游测试因新 import 路径失败，只修 import/fixture，不改断言语义。

- [ ] **Step 2: （仅在有修复时）Commit**

```bash
git add -A && git commit -m "fix: regression adjustments after V2 port wiring"
```

---

### Task 7: 本地 E2E——file:// 引用 + 5 个真实模型

**Files:**
- Create（仓库外）: `$TMPDIR/opencode/aga-e2e/opencode.json`

**Interfaces:**
- Consumes: `dist/index.js`（Task 5 产物）、真实账号 `~/.config/opencode/antigravity-accounts.json`
- Produces: 5 个模型可用性证据（含流式 + token 刷新路径——9月14日的 access token 必然已过期，首个请求即触发 refresh）

- [ ] **Step 1: 查 V2 配置文档确认 provider 凭据字段**

Fetch `https://opencode.ai/v2/docs/config` 的 provider 章节，确认静态 apiKey 的确切字段（候选：`provider.google.options.apiKey` 或 `provider.google.settings` 下的等价物）。以下按 `options.apiKey` 书写，若文档不同以文档为准。

- [ ] **Step 2: 写临时项目配置**

```bash
e2e="$TMPDIR/opencode/aga-e2e"; mkdir -p "$e2e"
cat > "$e2e/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///Users/saiu/develop/2026AIAgent/opencode-antigravity-auth/dist/index.js"],
  "provider": {
    "google": {
      "npm": "@ai-sdk/google",
      "options": { "apiKey": "antigravity-v2-placeholder" },
      "models": {
        "antigravity-gemini-3-pro": { "name": "Gemini 3 Pro (Antigravity)", "limit": { "context": 1048576, "output": 65535 } },
        "antigravity-gemini-3.1-pro": { "name": "Gemini 3.1 Pro (Antigravity)", "limit": { "context": 1048576, "output": 65535 } },
        "antigravity-gemini-3-flash": { "name": "Gemini 3 Flash (Antigravity)", "limit": { "context": 1048576, "output": 65535 } },
        "antigravity-claude-sonnet-4-6": { "name": "Claude Sonnet 4.6 (Antigravity)", "limit": { "context": 200000, "output": 65535 } },
        "antigravity-claude-opus-4-6-thinking": { "name": "Claude Opus 4.6 Thinking (Antigravity)", "limit": { "context": 200000, "output": 65535 } }
      }
    }
  }
}
EOF
```

- [ ] **Step 3: 逐模型实测**

```bash
cd "$e2e"
for m in antigravity-gemini-3-flash antigravity-gemini-3-pro antigravity-gemini-3.1-pro antigravity-claude-sonnet-4-6 antigravity-claude-opus-4-6-thinking; do
  echo "=== $m ==="
  opencode --standalone run "Reply with exactly: ok" --model "google/$m" 2>&1 | tail -3
done
```

Expected: 每个模型的输出包含 `ok`（thinking 模型输出可能带推理前缀，含 ok 即可）。

- [ ] **Step 4: 检查证据链**

```bash
grep -c "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail -1   # 记录基线值
ls -t ~/.config/opencode/antigravity-logs/ 2>/dev/null | head -3                     # 管线 debug 日志有新文件
```

Expected: 本次运行时段无新增 failed-to-load（对比运行前基线）；antigravity-logs 出现今天的日志且含 `request=generativelanguage...` 行。若 401/invalid_grant：refresh token 已失效，最小版无登录能力——记录并报告用户（这是已知边界，非本任务 bug）。

- [ ] **Step 5: 清理临时项目**

```bash
rm -rf "$TMPDIR/opencode/aga-e2e"
```

（无需 commit——本任务无仓库改动。）

---

### Task 8: 发布切换（两处用户 gate）

**Files:**
- Modify（gate 1 通过后）: fork 远端 `main`（合并 `v2-port`）
- Modify（gate 2）: `~/.config/opencode/opencode.json`

**Interfaces:**
- Consumes: Task 5–7 的绿色产物
- Produces: 用户正式配置走 git 引用，服务重启后无加载告警

- [ ] **Step 1: ⛔ 用户 gate 1——请求推送授权**

向用户展示 Task 6/7 结果，请求确认：`git checkout main && git merge v2-port && git push origin main`（origin = TsuiYolanda fork，绝不 push upstream）。用户明确同意前不得执行。

- [ ] **Step 2: 合并推送（仅 gate 1 通过后）**

```bash
git checkout main && git merge --no-ff v2-port -m "merge: V2 port (minimal viable)" && git push origin main
```

- [ ] **Step 3: ⛔ 用户 gate 2——修改全局配置**

向用户展示拟修改 diff：`"plugin"` 键改名 `"plugins"`；`"opencode-antigravity-auth@latest"` 替换为 `"antigravity-auth@git+https://github.com/TsuiYolanda/opencode-antigravity-auth.git"`；`provider.google` 加 Task 7 验证过的占位凭据字段；5 个模型定义原样保留。确认后手工编辑（保持文件内其余内容不变）。

- [ ] **Step 4: 重启验证**

```bash
opencode service restart && sleep 3 && opencode service status
tail -50 ~/.local/share/opencode/log/opencode.log | grep -i "antigravity"
```

Expected: 出现 `loading plugin ... antigravity-auth@git+...` 且无紧随的 `failed to load plugin`。再跑一次 `opencode run "reply ok" --model google/antigravity-gemini-3-flash`（在任意临时目录）确认端到端。

- [ ] **Step 5: 收尾报告**

`git log --oneline main -6` + `git status`（应 clean）；向用户报告：分支/提交清单、配置变更、验证结果、已知限制（无登录流程、无会话恢复 hook）。

---

## Self-Review 记录

- 2026-10-08 B' 修订：方案 A 否决（探针证据），Task 2 去掉 rawFetch（无补丁即无递归），Task 4 重写为 loopback server + http.request hook。spec 同步修订。
- Spec 覆盖：入口/loopback+hook/抽取/getAuth/配置迁移/错误处理/验证四阶段/风险项 → Task 4/4/2/3/7+8/4/1+7/（风险表为文档性内容，无任务需要）。
- 占位符扫描：无 TBD；所有代码块完整。
- 类型一致性：`AntigravityFetchDeps`（Task 2 定义，无 rawFetch）在 Task 4 Step 7 以相同字段名消费；`createAccountsGetAuth`（Task 3）与 Task 4 一致；`rewriteRequestToLoopback`/`createLoopbackServer`/`ORIGINAL_URL_HEADER`（Task 4 loopback.ts）在 index.ts 与两个测试文件中一致。
- Review Focus 五项均有对应测试任务（见各条目）。
