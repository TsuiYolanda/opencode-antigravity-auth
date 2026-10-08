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

const GENERATIVE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent";

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
    const deps = makeDeps({
      accountManager: { getAccountCount: () => 0 } as unknown as AntigravityFetchDeps["accountManager"],
    });
    await expect(createAntigravityFetch(deps)(GENERATIVE_URL)).rejects.toThrow(/No Antigravity accounts/);
  });
});
