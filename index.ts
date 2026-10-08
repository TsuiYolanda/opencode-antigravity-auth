import v2Plugin from "./src/v2";

export default v2Plugin;

export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";

export { authorizeAntigravity, exchangeAntigravity } from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";
