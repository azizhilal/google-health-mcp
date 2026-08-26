import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Props are produced during the OAuth callback, encrypted into the issued
 * token by workers-oauth-provider, and handed back to the MCP agent on every
 * authenticated request via `this.props`.
 */
export type Props = {
  email: string;
  accessToken: string;
  refreshToken: string;
};

/** Worker bindings. Mirrors wrangler.jsonc; `wrangler types` regenerates this. */
export interface Env {
  OAUTH_KV: KVNamespace;
  /** Cache for immutable past-day API responses. */
  HEALTH_CACHE: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_OBJECT: DurableObjectNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  GOOGLE_OAUTH_SCOPES: string;
  /** Public origin of this Worker (for serverInfo icons/websiteUrl). */
  PUBLIC_URL: string;
  /** IANA tz used to resolve "today"/"last night" for date defaults. */
  TIME_ZONE: string;
}
