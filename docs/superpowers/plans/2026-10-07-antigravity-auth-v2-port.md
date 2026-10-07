# opencode-antigravity-auth V2 移植 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 fork（TsuiYolanda/opencode-antigravity-auth，分支 `v2-port`）改造成 OpenCode V2 插件，通过 globalThis.fetch 补丁复用上游 V1 请求管线，让 5 个 antigravity 模型在 opencode v2.0.16 下可用。

**Architecture:** 新增 V2 入口（`Plugin.define` 默认导出），在 `setup()` 里初始化配置/账号后补丁 `globalThis.fetch`；把 V1 `auth.loader` 闭包内的 fetch 管线（src/plugin.ts 1454–2499 行）机械抽取为可导出工厂 `createAntigravityFetch`，管线逻辑零改动；V2 侧用账号文件构造 `getAuth`，client 依赖用 no-op stub。

**Tech Stack:** TypeScript、@opencode/plugin ^2.0.24（V2 SDK）、@opencode-ai/plugin ^0.15.30（保留，plugin.ts 仍引用）、vitest、npm。

**Spec:** `docs/superpowers/specs/2026-10-07-antigravity-auth-v2-port-design.md`

## Global Constraints

- 目标运行时：opencode v2.0.16；V2 SDK 固定 `@opencode/plugin@^2.0.24`（2026-10-07 时 latest）。
- 抽取必须是"只搬位置"：管线循环体逐行保留，唯一允许的新增是工厂签名、deps 解构和 `const fetch = deps.rawFetch` 遮蔽（防止补丁后自递归）。
- 所有 commit 只进本地 `v2-port` 分支；**任何 push 必须先获得用户明确确认**（Task 8 有专门 gate）。
- 保留 `@opencode-ai/plugin` 依赖，不删除（`src/plugin.ts` 顶部 import 它）。
- Task 8 之前不改用户的 `~/.config/opencode/opencode.json`。
- 仓库用 npm（有 package-lock.json）；测试 `npm test`（vitest run）；类型检查 `npm run typecheck`。
- 插件 id 固定为 `antigravity-auth`（Plugin storage 与诊断按 id 归属）。

## Review Focus

1. **非 Google 请求被补丁破坏**（server 里 npm/registry/MCP 等所有 fetch）→ Task 2 步骤 1 的 passthrough 测试 + Task 4 步骤 1 的 wrapper passthrough 测试。
2. **插件被多 location 重复加载导致 wrapper 层层嵌套**（日志证实 server 会多次 load plugin）→ Task 4 步骤 4 的幂等测试（连续 install 两次，pipeline 只被调用一次）。
3. **账号文件缺失/为空时插件崩溃或请求泄漏到真 Google API** → Task 4 步骤 5 的 503 synthetic 响应测试 + Task 3 步骤 1 的空 snapshot 测试。
4. **SSE 流式响应被 wrapper 破坏**（5 个模型全部走 `:streamGenerateContent`）→ Task 7 对 5 个模型逐一真实请求验证。
5. **补丁后管线内部 fetch 自递归**（outbound 调用重入 wrapper）→ Task 2 的 `rawFetch` 遮蔽设计 + Task 2 步骤 1 测试断言 rawFetch 直达。

---

### Task 1: 探针——验证 V2 server 的 provider 请求走 globalThis.fetch

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
  - `AntigravityFetchDeps { getAuth: GetAuth; accountManager: AccountManager; client: PipelineClient; config: AntigravityConfig; providerId: string; rawFetch: typeof fetch }`
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
    rawFetch: vi.fn(async () => new Response("passthrough")) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("createAntigravityFetch", () => {
  it("passes non-generative requests straight to rawFetch without reading auth", async () => {
    const deps = makeDeps();
    const f = createAntigravityFetch(deps);
    await f("https://example.com/v1/x", { method: "GET" });
    expect(deps.rawFetch).toHaveBeenCalledWith("https://example.com/v1/x", { method: "GET" });
    expect(deps.getRawAuthNever as unknown as undefined).toBeUndefined();
    expect(deps.getAuth).not.toHaveBeenCalled();
  });

  it("passes through when auth is not OAuth", async () => {
    const deps = makeDeps({ getAuth: vi.fn(async () => ({ type: "api", key: "k" })) });
    await createAntigravityFetch(deps)(GENERATIVE_URL);
    expect(deps.rawFetch).toHaveBeenCalled();
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
  /** Pristine fetch captured before any globalThis patch; all pipeline I/O must go through it. */
  rawFetch: typeof fetch;
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
  // Shadow global fetch with the pristine reference: passthrough and outbound
  // calls (token refresh, endpoint requests) must never re-enter a patched
  // globalThis.fetch installed by the V2 entry.
  const fetch = deps.rawFetch;
  return async function antigravityPipelineFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    // === 原 loader fetch 方法体（现 1455–2498 行）原样移入，不改一字 ===
  };
}
```

4. 把现 1454–2499 行（`async fetch(input, init) {` 起到 2499 行 `},` 止）的方法体移入上面的工厂内层函数，然后在 loader 原位置替换为：

```ts
      return {
        apiKey: "",
        fetch: createAntigravityFetch({ getAuth, accountManager, client, config, providerId, rawFetch: globalThis.fetch }),
      };
```

（V1 进程从不补丁 fetch，`globalThis.fetch` 在 V1 下即 pristine fetch，行为等价。）

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

### Task 4: V2 入口 src/v2/index.ts（setup + fetch 补丁）

**Files:**
- Create: `src/v2/index.ts`
- Test: `src/v2/index.test.ts`
- Modify: `docs/superpowers/specs/2026-10-07-antigravity-auth-v2-port-design.md`（cleanup 措辞改为"清定时器；fetch 补丁按进程生命周期保留，幂等防嵌套"，与本任务实现一致）

**Interfaces:**
- Consumes: Task 2 的 `createAntigravityFetch`、`buildAuthSuccessFromStoredAccount`；Task 3 的 `createAccountsGetAuth`；`loadConfig/initRuntimeConfig`（`src/plugin/config`）、`initializeDebug`（`src/plugin/debug`）、`initLogger`（`src/plugin/logger`）、`initAntigravityVersion`（`src/plugin/version`）、`initHealthTracker/initTokenTracker`（`src/plugin/rotation`）、`initDiskSignatureCache`（`src/plugin/cache`）、`AccountManager`、`loadAccounts`（`src/plugin/storage`）、`refreshAccessToken`/`accessTokenExpired`/`isOAuthAuth`（`src/plugin/auth`、`src/plugin/token`）、`isGenerativeLanguageRequest`（`src/plugin/request`）、`ANTIGRAVITY_PROVIDER_ID`（`src/constants`）
- Produces: `installFetchIntercept(pipeline) => void`（导出供测试）；`default`（Plugin 定义，Task 5 接到根 index.ts）

- [ ] **Step 1: 写失败测试**

`src/v2/index.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installFetchIntercept } from "./index";

const GENERATIVE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

describe("installFetchIntercept", () => {
  let underlying: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    underlying = vi.fn(async () => new Response("raw"));
    pipeline = vi.fn(async () => new Response("pipeline"));
    vi.stubGlobal("fetch", underlying);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes non-matching URLs to the underlying fetch untouched", async () => {
    installFetchIntercept(pipeline);
    const res = await fetch("https://registry.npmjs.org/foo", { method: "HEAD" });
    expect(await res.text()).toBe("raw");
    expect(underlying).toHaveBeenCalledWith("https://registry.npmjs.org/foo", { method: "HEAD" });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("routes generative-language URLs into the pipeline", async () => {
    installFetchIntercept(pipeline);
    const res = await fetch(GENERATIVE_URL);
    expect(await res.text()).toBe("pipeline");
    expect(underlying).not.toHaveBeenCalled();
  });

  it("returns a guided 503 for intercepted requests when no pipeline exists", async () => {
    installFetchIntercept(null);
    const res = await fetch(GENERATIVE_URL);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/antigravity-auth/i);
  });

  it("installs at most once per process (idempotent, no wrapper chaining)", async () => {
    installFetchIntercept(pipeline);
    installFetchIntercept(pipeline);
    await fetch(GENERATIVE_URL);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/index.test.ts`
Expected: FAIL，无法解析 `./index`。

- [ ] **Step 3: 实现**

`src/v2/index.ts`：

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
import { isGenerativeLanguageRequest } from "../plugin/request";
import { accessTokenExpired, isOAuthAuth } from "../plugin/auth";
import { refreshAccessToken } from "../plugin/token";
import type { PluginClient } from "../plugin/types";
import { createAccountsGetAuth } from "./getauth";

const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const PATCH_MARKER = Symbol.for("antigravity-auth.fetch-patch");

type PipelineFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

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

/**
 * Patches globalThis.fetch for the server process lifetime. Idempotent via a
 * symbol marker: opencode loads one plugin instance per location, so setup may
 * run repeatedly in the same process. The disposer intentionally does not
 * unpatch — sibling instances still depend on the wrapper; the process exit
 * is the only unload boundary that matters here.
 */
export function installFetchIntercept(pipeline: PipelineFetch | null): void {
  const current = globalThis.fetch as typeof fetch & { [PATCH_MARKER]?: true };
  if (current[PATCH_MARKER]) return;
  const rawFetch = current.bind(globalThis);
  const wrapper: PipelineFetch & { [PATCH_MARKER]?: true } = async (input, init) => {
    if (!isGenerativeLanguageRequest(input)) return rawFetch(input, init);
    if (!pipeline) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "opencode-antigravity-auth (V2): no accounts configured. " +
              "Re-login needs the V1 flow until the V2 login port lands (see docs/superpowers/specs).",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    return pipeline(input, init);
  };
  wrapper[PATCH_MARKER] = true;
  globalThis.fetch = wrapper as typeof fetch;
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

    let pipeline: PipelineFetch | null = null;
    if (accounts.length > 0) {
      const authFallback = buildAuthSuccessFromStoredAccount(accounts[0]);
      const accountManager = await AccountManager.loadFromDisk(authFallback);
      if (accountManager.getAccountCount() > 0) accountManager.requestSaveToDisk();
      const getAuth = createAccountsGetAuth(accountManager);
      // Capture rawFetch BEFORE installing the intercept.
      const rawFetch = globalThis.fetch.bind(globalThis);
      pipeline = createAntigravityFetch({
        getAuth,
        accountManager,
        client: makeStubClient(),
        config,
        providerId: ANTIGRAVITY_PROVIDER_ID,
        rawFetch: rawFetch as typeof fetch,
      });

      // Best-effort proactive refresh (per-request refresh inside the
      // pipeline remains the load-bearing path).
      const timer = setInterval(() => {
        void (async () => {
          try {
            const auth = await getAuth();
            if (!isOAuthAuth(auth) || !accessTokenExpired(auth)) return;
            await refreshAccessToken(auth, makeStubClient(), ANTIGRAVITY_PROVIDER_ID);
          } catch {
            /* refresh failure surfaces per-request via the pipeline */
          }
        })();
      }, REFRESH_CHECK_INTERVAL_MS);

      installFetchIntercept(pipeline);
      return () => clearInterval(timer);
    }

    installFetchIntercept(null);
    return () => {};
  },
});
```

注意：`installFetchIntercept` 内部自己再取 `current` 做 `rawFetch`（marker 命中时直接 return，不会二次包）；setup 里传入 pipeline 前捕获的 rawFetch 仅给管线内部使用。若 `isGenerativeLanguageRequest` 的入参类型是 `RequestInfo` 之外的形状（如只收 string），在 wrapper 里先转成 `toUrlString` 等价逻辑（对照 `src/plugin/request.ts` 签名）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/index.test.ts && npm run typecheck`
Expected: 4 支全 PASS。

- [ ] **Step 5: 同步 spec 措辞并 Commit**

编辑 spec 中「返回的 cleanup 恢复原始 fetch」段落为：「cleanup 仅清理刷新定时器；fetch 补丁以幂等 marker 保证进程内只装一次、不嵌套，随进程生命周期存在」。

```bash
git add src/v2/index.ts src/v2/index.test.ts docs/superpowers/specs/2026-10-07-antigravity-auth-v2-port-design.md
git commit -m "feat(v2): Plugin.define entry with idempotent fetch intercept"
```

---

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

- Spec 覆盖：入口/补丁/抽取/getAuth/配置迁移/错误处理/验证四阶段/风险项 → Task 4/2/2/3/7+8/4/1+7/（风险表为文档性内容，无任务需要）。spec 的"cleanup 恢复 fetch"在 Task 4 Step 5 同步修正为幂等保留语义（设计修正，理由已注明：多 location 实例共存）。
- 占位符扫描：Task 2 Step 1 测试代码中的 `getRawAuthNever` 行已标注删除；其余无 TBD。
- 类型一致性：`AntigravityFetchDeps`（Task 2 定义）在 Task 4 Step 3 以相同字段名消费；`installFetchIntercept` 签名在 Task 4 测试与实现一致；`createAccountsGetAuth` 签名在 Task 3/4 一致。
- Review Focus 五项均有对应测试任务（见各条目）。
