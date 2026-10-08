import { formatRefreshParts } from "../plugin/auth";
/**
 * V2 replacement for V1's opencode-auth-store getAuth(): derives the
 * OAuth details from the accounts file via AccountManager. The pipeline
 * only uses getAuth() as an OAuth gate plus cold-start refresh;
 * per-request auth is managed inside the pipeline itself.
 */
export function createAccountsGetAuth(accountManager) {
    return async () => {
        const snapshot = accountManager.getAccountsSnapshot();
        const account = snapshot[0];
        if (!account) {
            // OAuth-shaped placeholder with empty parts: the pipeline's own
            // account-count check throws the actionable error message.
            return { type: "oauth", access: "", expires: 0, refresh: formatRefreshParts({ refreshToken: "" }) };
        }
        return {
            type: "oauth",
            access: account.access ?? "",
            expires: account.expires ?? 0,
            refresh: formatRefreshParts(account.parts),
        };
    };
}
//# sourceMappingURL=getauth.js.map