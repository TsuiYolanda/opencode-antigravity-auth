import { describe, it, expect } from "vitest";
import { buildRequestHook } from "./index";
import { ORIGINAL_URL_HEADER } from "./loopback";

const GENERATIVE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

describe("buildRequestHook", () => {
  it("rewrites generative requests to the loopback origin with the original-url header", () => {
    const port = 37899;
    const hook = buildRequestHook(port);
    const event = {
      request: new Request(GENERATIVE_URL, { method: "POST", body: "{}" }),
      kind: "primary",
      sessionID: "s",
      headers: {},
    } as never;
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
