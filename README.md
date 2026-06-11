# Google Health MCP — recovery data for your Claude training coach

A remote [MCP](https://modelcontextprotocol.io) server, deployed on Cloudflare
Workers, that exposes your **Fitbit** recovery data — sleep, resting heart rate,
and **HRV** — to Claude via the [Google Health API v4](https://developers.google.com/health).
Add it once as a custom connector and it works on Claude **web, desktop, and
mobile**. Pairs with the Strava connector so your coach sees both training load
and recovery.

> **Data source:** the Google Health API only serves data originating from
> **Fitbit** devices and **Google Pixel Watches**. Garmin/Apple/Whoop/Oura are
> not covered.

## Tools

| Tool | What it answers |
|------|-----------------|
| `get_recovery_snapshot` | "Am I recovered enough to train today?" — last night's sleep + resting HR + HRV |
| `get_hrv_trend` | HRV over the last N days (autonomic recovery trend) |
| `get_resting_hr_trend` | Resting HR over N days (rising = fatigue/illness) |
| `get_sleep` | Nightly sleep duration + stages over a range |
| `get_daily_summary` | Active-zone-minutes + resting HR over a range |

---

## One-time Google Cloud setup (~15 min)

You can't skip this — Google requires an OAuth client. But for personal use
(just you) there is **no security review**: that only applies above 100 users.

1. **Create a project** at <https://console.cloud.google.com/> and **enable the
   Google Health API** (APIs & Services → Library → "Google Health API").
2. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: **External**.
   - Add your own Google account under **Test users**.
   - **Publish the app to Production.** It stays *unverified* (fine under 100
     users) but this is important: in Testing mode refresh tokens **expire after
     7 days**, which would log you out weekly. Production = long-lived tokens.
3. **Add scopes** (these are "Restricted", which is expected — no review needed
   at your scale):
   - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
   - `.../auth/googlehealth.sleep.readonly`
   - `.../auth/googlehealth.activity_and_fitness.readonly`
4. **Create credentials** → OAuth client ID → **Web application**.
   - Authorized redirect URI: `https://<your-worker>.workers.dev/callback`
     (you'll know `<your-worker>` after the first `wrangler deploy`; come back
     and add it, then redeploy is not needed — just save in Google).
   - Copy the **Client ID** and **Client Secret**.

## Deploy to Cloudflare

```sh
npm install

# Create the KV namespace and paste the printed id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# Secrets
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any long random string

npx wrangler deploy
```

After the first deploy you'll get `https://google-health-mcp.<subdomain>.workers.dev`.
Go back to the Google OAuth client and set the redirect URI to
`https://google-health-mcp.<subdomain>.workers.dev/callback`.

## Connect in Claude

1. **Settings → Connectors → Add custom connector.**
2. URL: `https://google-health-mcp.<subdomain>.workers.dev/mcp`
3. Click **Connect** → you'll be sent to Google to grant access → done.
4. Repeat the "add connector" step on mobile if it doesn't sync automatically.

Then ask your coach: *"Check my recovery — should I do today's hard session?"*

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in your client id/secret
npx wrangler dev
```

Test the flow with the MCP Inspector (set redirect URI to
`http://localhost:8787/callback` on a separate dev OAuth client):

```sh
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP → http://localhost:8787/mcp → Connect
```

## How it works

```
Claude (web/desktop/mobile)
  └─ custom connector → /mcp
       └─ workers-oauth-provider  (this Worker IS Claude's OAuth server)
            └─ GoogleHandler      (redirects you to real Google consent)
                 └─ GoogleHealthMCP (Durable Object) → Google Health API v4 → Fitbit
```

- `src/index.ts` — wires `OAuthProvider` + the `McpAgent` Durable Object.
- `src/google-handler.ts` — upstream Google OAuth (`/authorize`, `/callback`).
- `src/google-health.ts` — Health API v4 client with transparent token refresh.
- `src/tools.ts` — the coaching tools above.

## Notes & limits

- **Single user.** Anyone you add as a Google test user could connect; keep it
  to your own account.
- **Token longevity** depends on the "Publish to Production" step (see setup #2).
- **Data lag:** Fitbit data appears after your device syncs to the Google/Fitbit
  cloud; very recent nights may not be present until the app syncs.
- Exact rollup field names per data type may evolve; tools pass the API JSON
  through so Claude can adapt. If a data type returns empty, confirm your Fitbit
  actually records it (e.g. HRV needs sleep tracking enabled).
