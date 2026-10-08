import type { AccountManager } from "../plugin/accounts";
import type { GetAuth } from "../plugin/types";
/**
 * V2 replacement for V1's opencode-auth-store getAuth(): derives the
 * OAuth details from the accounts file via AccountManager. The pipeline
 * only uses getAuth() as an OAuth gate plus cold-start refresh;
 * per-request auth is managed inside the pipeline itself.
 */
export declare function createAccountsGetAuth(accountManager: AccountManager): GetAuth;
//# sourceMappingURL=getauth.d.ts.map