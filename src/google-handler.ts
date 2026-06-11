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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

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

// Connector icon. Referenced from the MCP serverInfo `icons` so clients that
// render server branding (e.g. Claude's connector list) can show a logo. A
// heart + ECG pulse in Google's palette — health/recovery at a glance.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-label="Google Health">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4285F4"/>
      <stop offset="0.5" stop-color="#34A853"/>
      <stop offset="1" stop-color="#FBBC04"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="40" fill="#fff"/>
  <path fill="url(#g)" d="M96 168C60 140 28 116 28 80a40 40 0 0 1 68-28 40 40 0 0 1 68 28c0 36-32 60-68 88z"/>
  <path fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"
        d="M44 100h26l12-26 16 46 12-20h38"/>
</svg>`;

app.get("/icon.svg", (c) =>
  c.body(ICON_SVG, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
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
