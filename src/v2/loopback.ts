import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export const ORIGINAL_URL_HEADER = "x-antigravity-original-url";

export type PipelineFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export interface LoopbackHandle {
  listen(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Redirect a generative-language request to the loopback origin, carrying the
 * original URL in a header so the handler can rebuild the call. Non-generative
 * requests are returned untouched (idempotent under repeated hooks).
 */
export function rewriteRequestToLoopback(request: Request, port: number): Request {
  if (!request.url.includes("generativelanguage.googleapis.com")) return request;
  const target = new URL(request.url);
  target.protocol = "http:";
  target.host = `127.0.0.1:${port}`;
  const rewritten = new Request(target.toString(), request);
  rewritten.headers.set(ORIGINAL_URL_HEADER, request.url);
  return rewritten;
}

const HOP_BY_HOP_OR_META = new Set([
  ORIGINAL_URL_HEADER,
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

/**
 * Bridges node:http req/res to the fetch-shaped pipeline. The pipeline is
 * invoked as (originalUrlString, init) because its first-line guard
 * (isGenerativeLanguageRequest) only admits string URLs.
 */
export function createLoopbackServer(pipeline: PipelineFetch | null): LoopbackHandle {
  const server: Server = createServer((req, res) => {
    void (async () => {
      let settled = false;
      const abort = new AbortController();
      req.on("close", () => {
        if (!settled) abort.abort(new Error("client disconnected"));
      });
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
          if (value === undefined || HOP_BY_HOP_OR_META.has(name)) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }

        const response = await pipeline(originalUrl, {
          method: req.method,
          headers,
          body: body.length > 0 ? body : undefined,
          signal: abort.signal,
        });

        const outHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (k === "content-length" || k === "transfer-encoding" || k === "content-encoding") return;
          outHeaders[k] = v;
        });
        res.writeHead(response.status, outHeaders);
        settled = true;
        if (!response.body) {
          res.end();
          return;
        }
        Readable.fromWeb(response.body as never).pipe(res);
      } catch (error) {
        settled = true;
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
          else reject(new Error("loopback server has no port"));
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
