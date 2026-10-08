import { type HeaderStyle } from "./constants";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { type ModelFamily } from "./plugin/accounts";
import { type AntigravityConfig } from "./plugin/config";
import type { AntigravityFetchDeps, PluginContext, PluginResult } from "./plugin/types";
export declare function buildAuthSuccessFromStoredAccount(account: {
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
    email?: string;
}): Extract<AntigravityTokenExchangeResult, {
    type: "success";
}>;
/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export declare function createAntigravityFetch(deps: AntigravityFetchDeps): (input: RequestInfo, init?: RequestInit) => Promise<Response>;
export declare const createAntigravityPlugin: (providerId: string) => ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const AntigravityCLIOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const GoogleOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
declare function resolveQuotaFallbackHeaderStyle(input: {
    family: ModelFamily;
    headerStyle: HeaderStyle;
    alternateStyle: HeaderStyle | null;
}): HeaderStyle | null;
type HeaderRoutingDecision = {
    cliFirst: boolean;
    preferredHeaderStyle: HeaderStyle;
    explicitQuota: boolean;
    allowQuotaFallback: boolean;
};
declare function resolveHeaderRoutingDecision(urlString: string, family: ModelFamily, config: AntigravityConfig): HeaderRoutingDecision;
declare function getHeaderStyleFromUrl(urlString: string, family: ModelFamily, cliFirst?: boolean): HeaderStyle;
export declare const __testExports: {
    getHeaderStyleFromUrl: typeof getHeaderStyleFromUrl;
    resolveHeaderRoutingDecision: typeof resolveHeaderRoutingDecision;
    resolveQuotaFallbackHeaderStyle: typeof resolveQuotaFallbackHeaderStyle;
};
export {};
//# sourceMappingURL=plugin.d.ts.map