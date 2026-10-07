import { describe, it, expect, afterEach } from "vitest";
import { createLoopbackServer, rewriteRequestToLoopback, ORIGINAL_URL_HEADER } from "./loopback";

const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
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
    expect(rewritten.url).toBe(
      "http://127.0.0.1:37899/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
    );
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
  it("rebuilds the original request (url string + init) and returns the pipeline response", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    const pipeline = async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "?";
      seenBody = init?.body ? String(init.body) : "";
      return new Response("pipeline-says", { status: 299, headers: { "content-type": "text/plain" } });
    };
    const handle = createLoopbackServer(pipeline);
    handles.push(handle);
    const port = await handle.listen();
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/v1beta/models/x:generateContent`, {
      method: "POST",
      headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL, "content-type": "application/json" },
      body: "hello-body",
    });
    expect(res.status).toBe(299);
    await expect(res.text()).resolves.toBe("pipeline-says");
    expect(seenUrl).toBe(GENERATIVE_URL);
    expect(seenMethod).toBe("POST");
    expect(seenBody).toBe("hello-body");
  });

  it("streams SSE bodies through chunk by chunk", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"a":2}\n\n'];
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
    const handle = createLoopbackServer(pipeline);
    handles.push(handle);
    const port = await handle.listen();
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await expect(res.text()).resolves.toBe(chunks.join(""));
  });

  it("responds 503 with guidance when pipeline is absent", async () => {
    const handle = createLoopbackServer(null);
    handles.push(handle);
    const port = await handle.listen();
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { [ORIGINAL_URL_HEADER]: GENERATIVE_URL },
    });
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toMatch(/antigravity-auth/i);
  });
});
