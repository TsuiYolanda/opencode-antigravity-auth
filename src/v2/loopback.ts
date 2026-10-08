import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export const ORIGINAL_URL_HEADER = "x-antigravity-original-url";

export type PipelineFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export interface LoopbackHandle {
  listen(): Promise<number>;
  close(): Promise<void>;
}

function isGenerativeLanguageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "generativelanguage.googleapis.com"
    );
  } catch {
    return false;
  }
}

/**
 * Redirect a generative-language request to the loopback origin, carrying the
 * original URL in a header so the handler can rebuild the call. Non-generative
 * requests are returned untouched (idempotent under repeated hooks). Hostname
 * must match exactly — a substring match would let crafted URLs through and
 * leak the bearer token to third-party hosts.
 */
export function rewriteRequestToLoopback(request: Request, port: number): Request {
  if (!isGenerativeLanguageUrl(request.url)) return request;
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
      // Sink dest-side socket errors so they never become unhandled.
      res.on("error", () => {});
      // Client disconnect at ANY stage (before or mid response) aborts the
      // upstream pipeline: frees the Google connection and quota.
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort(new Error("client disconnected"));
      });
      try {
        const originalUrl = req.headers[ORIGINAL_URL_HEADER];
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        if (process.env.AGA_DUMP_BODY) {
          try {
            const { appendFileSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            appendFileSync(`${tmpdir()}/aga-loopback-dump.json`, `${originalUrl ?? "?"}\n${body.toString("utf8")}\n\n`);
          } catch {
            /* dump is best-effort */
          }
        }

        if (!pipeline || typeof originalUrl !== "string") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "opencode-antigravity-auth (V2): no accounts configured. " +
                  "Re-login needs the V1 flow until the V2 login port lands (see docs/superpowers/specs). " +
                  "Restart opencode after adding accounts.",
              },
            }),
          );
          return;
        }

        if (!isGenerativeLanguageUrl(originalUrl)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "loopback rejected non-generative original URL" },
            }),
          );
          return;
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || HOP_BY_HOP_OR_META.has(name)) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }

        // prepareAntigravityRequest transforms string bodies only; a Buffer
        // would bypass the Gemini→Antigravity rewrite and fail at the endpoint.
        const response = await pipeline(originalUrl, {
          method: req.method,
          headers,
          body: body.length > 0 ? body.toString("utf8") : undefined,
          signal: abort.signal,
        });

        const outHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (k === "content-length" || k === "transfer-encoding" || k === "content-encoding") return;
          outHeaders[k] = v;
        });
        res.writeHead(response.status, outHeaders);
        if (!response.body) {
          res.end();
          return;
        }
        const source = Readable.fromWeb(response.body as never);
        // A failing upstream body must tear down this response, never the
        // host process: without this listener the 'error' event is unhandled.
        source.on("error", (err) => {
          if (!res.writableEnded) res.destroy(err instanceof Error ? err : new Error(String(err)));
        });
        source.pipe(res);
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
