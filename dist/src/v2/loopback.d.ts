export declare const ORIGINAL_URL_HEADER = "x-antigravity-original-url";
export type PipelineFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;
export interface LoopbackHandle {
    listen(): Promise<number>;
    close(): Promise<void>;
}
/**
 * Redirect a generative-language request to the loopback origin, carrying the
 * original URL in a header so the handler can rebuild the call. Non-generative
 * requests are returned untouched (idempotent under repeated hooks). Hostname
 * must match exactly — a substring match would let crafted URLs through and
 * leak the bearer token to third-party hosts.
 */
export declare function rewriteRequestToLoopback(request: Request, port: number): Request;
/**
 * Bridges node:http req/res to the fetch-shaped pipeline. The pipeline is
 * invoked as (originalUrlString, init) because its first-line guard
 * (isGenerativeLanguageRequest) only admits string URLs.
 */
export declare function createLoopbackServer(pipeline: PipelineFetch | null): LoopbackHandle;
//# sourceMappingURL=loopback.d.ts.map