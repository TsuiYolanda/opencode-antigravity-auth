import { Plugin } from "@opencode/plugin";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { initDiskSignatureCache } from "../plugin/cache";
import { loadConfig, initRuntimeConfig } from "../plugin/config";
import { initializeDebug } from "../plugin/debug";
import { initLogger } from "../plugin/logger";
import { initAntigravityVersion } from "../plugin/version";
import { initHealthTracker, initTokenTracker } from "../plugin/rotation";
import { AccountManager } from "../plugin/accounts";
import { loadAccounts } from "../plugin/storage";
import { createAntigravityFetch } from "../plugin";
import { accessTokenExpired, formatRefreshParts, isOAuthAuth } from "../plugin/auth";
import { refreshAccessToken } from "../plugin/token";
import { createAccountsGetAuth } from "./getauth";
import { createLoopbackServer, rewriteRequestToLoopback } from "./loopback";
const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
function makeStubClient() {
    return {
        tui: { showToast: async () => { } },
        auth: { set: async () => { } },
        app: { log: async () => { } },
    };
}
function initTrackers(config) {
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
 * Module-level singleton: opencode loads one plugin instance per location,
 * and every instance must share one loopback server and pipeline. The server
 * listens once; later instances reuse the resolved port.
 */
const state = { pipeline: null, handle: null, port: 0 };
/** Exported for tests: the raw http.request hook body. */
export function buildRequestHook(port) {
    return (event) => {
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
        if (!state.handle) {
            const stored = await loadAccounts();
            const accounts = stored?.accounts ?? [];
            if (accounts.length > 0 && accounts[0]) {
                const first = accounts[0];
                const authFallback = {
                    type: "oauth",
                    access: "",
                    expires: 0,
                    refresh: formatRefreshParts({
                        refreshToken: first.refreshToken,
                        projectId: first.projectId,
                        managedProjectId: first.managedProjectId,
                    }),
                };
                const accountManager = await AccountManager.loadFromDisk(authFallback);
                if (accountManager.getAccountCount() > 0)
                    accountManager.requestSaveToDisk();
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
                            if (!isOAuthAuth(auth) || !accessTokenExpired(auth))
                                return;
                            await refreshAccessToken(auth, makeStubClient(), ANTIGRAVITY_PROVIDER_ID);
                        }
                        catch {
                            /* per-request refresh inside the pipeline is the load-bearing path */
                        }
                    })();
                }, REFRESH_CHECK_INTERVAL_MS);
                state.handle = createLoopbackServer(state.pipeline);
                state.port = await state.handle.listen();
                const registration = await ctx.session.hook("http.request", buildRequestHook(state.port));
                return () => {
                    clearInterval(timer);
                    void registration.dispose?.();
                };
            }
            state.handle = createLoopbackServer(null);
            state.port = await state.handle.listen();
        }
        const registration = await ctx.session.hook("http.request", buildRequestHook(state.port));
        return () => {
            void registration.dispose?.();
        };
    },
});
//# sourceMappingURL=index.js.map