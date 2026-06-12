/**
 * Default handler for the OAuth provider: drives the *upstream* Google consent
 * flow. workers-oauth-provider owns the Claude <-> Worker side (issuing tokens
 * to the MCP client); this handler bridges to Google so the user authorizes via
 * the real Google account-chooser — i.e. "grant the app access" as intended.
 *
 * Flow:
 *   GET /authorize  -> stash Claude's AuthRequest in `state`, redirect to Google
 *   GET /callback   -> exchange code at Google, read email, completeAuthorization
 *
 * Single-user note: we encode Claude's AuthRequest into the OAuth `state` param
 * rather than persisting it server-side, and rely on Google's own consent screen
 * as the approval gate (no separate local approval dialog).
 */
import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./types";
import { ICON_PNG_BASE64 } from "./icon";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// Baseline security headers on every response from this handler (consent,
// callback, icon). Helps satisfy the ASVS checks a CASA assessment runs.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
});

function encodeState(req: AuthRequest): string {
  return btoa(JSON.stringify(req)).replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeState(state: string): AuthRequest {
  const json = atob(state.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as AuthRequest;
}

function callbackUrl(reqUrl: string): string {
  return new URL("/callback", reqUrl).toString();
}

// Connector icon (the Google Health heart). Referenced from the MCP serverInfo
// `icons` so clients that render server branding (e.g. Claude's connector list)
// can show a logo. Decoded once from the base64-embedded PNG.
const ICON_PNG_BYTES = Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0));

app.get("/icon.png", (c) =>
  c.body(ICON_PNG_BYTES, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  }),
);

// Step 1: Claude hits /authorize. Parse its request, bounce to Google.
app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

  const scopes = `openid email ${c.env.GOOGLE_OAUTH_SCOPES}`.trim();
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: scopes,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh-token issuance on re-auth
    state: encodeState(oauthReq),
  });
  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

// Step 2: Google redirects back with ?code & ?state.
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.text("Missing code or state from Google", 400);
  }

  const oauthReq = decodeState(state);

  // Exchange the authorization code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return c.text(`Google token exchange failed: ${await tokenRes.text()}`, 502);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  // Identify the user (for the grant's userId) via the email scope.
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = (await userRes.json()) as { email?: string; sub?: string };
  const email = userInfo.email ?? userInfo.sub ?? "unknown";

  const props: Props = {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: email,
    scope: oauthReq.scope,
    metadata: { label: email },
    props,
  });

  return c.redirect(redirectTo);
});

export { app as GoogleHandler };
