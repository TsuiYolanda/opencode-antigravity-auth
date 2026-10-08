import { describe, it, expect } from "vitest";
import { AccountManager } from "../plugin/accounts";
import { parseRefreshParts } from "../plugin/auth";
import { createAccountsGetAuth } from "./getauth";

const STORED = {
  version: 4,
  accounts: [
    {
      refreshToken: "rt-1",
      projectId: "p1",
      managedProjectId: "m1",
      email: "a@b.c",
      addedAt: 0,
      lastUsed: 0,
    },
  ],
  activeIndex: 0,
  activeIndexByFamily: { claude: 0, gemini: 0 },
} as never;

describe("createAccountsGetAuth", () => {
  it("returns OAuth-shaped auth built from the first stored account", async () => {
    const am = new AccountManager(undefined, STORED);
    const auth = await createAccountsGetAuth(am)();
    expect(auth.type).toBe("oauth");
    const parts = parseRefreshParts((auth as { refresh: string }).refresh);
    expect(parts.refreshToken).toBe("rt-1");
    expect(parts.projectId).toBe("p1");
  });

  it("returns an empty OAuth placeholder when no accounts exist", async () => {
    const emptyStored = { ...(STORED as object), accounts: [] } as never;
    const am = new AccountManager(undefined, emptyStored);
    const auth = await createAccountsGetAuth(am)();
    expect(auth.type).toBe("oauth");
    expect(parseRefreshParts((auth as { refresh: string }).refresh).refreshToken).toBe("");
  });
});
