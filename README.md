# Google Health MCP — recovery data for your Claude training coach

A remote [MCP](https://modelcontextprotocol.io) server, deployed on Cloudflare
Workers, that exposes your **Fitbit** recovery data — sleep, resting heart rate,
**HRV**, skin temperature, HR zones, workouts, and more — to Claude via the
[Google Health API v4](https://developers.google.com/health).
Add it once as a custom connector and it works on Claude **web, desktop, and
mobile**. Pairs with the Strava connector so your coach sees both training load
and recovery.

> **Data source:** the Google Health API only serves data originating from
> **Fitbit** devices and **Google Pixel Watches**. Garmin/Apple/Whoop/Oura are
> not covered.

## Tools

| Tool | What it answers |
|------|-----------------|
| `get_recovery_snapshot` | "Am I recovered enough to train today?" — last night's sleep + resting HR + HRV + skin-temp variation |
| `get_hrv_trend` | HRV over the last N days (autonomic recovery trend) |
| `get_resting_hr_trend` | Resting HR over N days (rising = fatigue/illness) |
| `get_sleep` | Nightly sleep duration + stages over a range |
| `get_daily_summary` | Active-zone-minutes, steps, distance, calories + resting HR over a range |
| `get_activity_detail` | Floors, active minutes, active energy, sedentary time, swim lengths, altitude |
| `get_exercise_sessions` | Watch-logged workouts (type, duration, stats) over a range |
| `get_heart_rate_zones` | Daily HR zone boundaries + time (and calories) in each zone |
| `get_body_composition` | Weight, body-fat %, and height over a range |
| `get_vitals_trend` | Respiratory rate, SpO2, skin temp, core body temp, blood glucose, VO2 max over a range |
| `get_nutrition` | Calories, macros, and hydration over a range (needs the nutrition scope) |
| `get_cardiac_events` | ECG recordings + irregular-rhythm (AFib) notifications (needs ecg/irn scopes) |
| `query_data_type` | Escape hatch: query **any** v4 data type by ID (incl. future ones) |
| `run_diagnostics` | Probes every metric and reports per-metric `ok` / `empty` / `error` |

> **Troubleshooting:** if anything stops returning data, run `run_diagnostics`
> first. It hits each data type directly and reports the exact API error per
> metric — so you isolate the failing data type/method/filter immediately
> instead of inferring it from a downstream symptom.

---

## Data type mapping (Google Health API v4)

This is the non-obvious part of the v4 API and the source of most integration
bugs. Each data type supports only certain methods, and the filterable time
member differs by type. The mapping below is what this server uses (see
[`src/tools.ts`](src/tools.ts) and [`src/google-health.ts`](src/google-health.ts)):

| Metric | Data type ID | Method | Filter member |
|--------|--------------|--------|---------------|
| Sleep | `sleep` | `reconcile` | `sleep.interval.end_time` (physical `Timestamp`, RFC3339-`Z`) |
| Resting HR | `daily-resting-heart-rate` | `reconcile` | `daily_resting_heart_rate.date` (civil date) |
| HRV | `daily-heart-rate-variability` | `reconcile` | `daily_heart_rate_variability.date` (civil date) |
| Active-zone-min | `active-zone-minutes` | `dailyRollUp` | — (civil `range` in body) |
| Heart rate | `heart-rate` | `dailyRollUp` | — (civil `range` in body) |
| Steps | `steps` | `dailyRollUp` | — (civil `range` in body) |
| Distance | `distance` | `dailyRollUp` | — (civil `range` in body) |
| Total calories | `total-calories` | `dailyRollUp` | — (civil `range` in body) |
| Weight | `weight` | `dailyRollUp` | — (civil `range` in body) |
| Body fat | `body-fat` | `dailyRollUp` | — (civil `range` in body) |
| Respiratory rate | `daily-respiratory-rate` | `reconcile` | `daily_respiratory_rate.date` (civil date) |
| Oxygen saturation | `daily-oxygen-saturation` | `reconcile` | `daily_oxygen_saturation.date` (civil date) |
| VO2 max | `daily-vo2-max` | `reconcile` | `daily_vo2_max.date` (civil date) |
| Run VO2 max | `run-vo2-max` | `dailyRollUp` | — (civil `range` in body) |
| Skin temperature | `daily-sleep-temperature-derivations` | `reconcile` | `daily_sleep_temperature_derivations.date` (civil date) |
| Core body temp | `core-body-temperature` | `dailyRollUp` | — (civil `range` in body) |
| Blood glucose | `blood-glucose` | `dailyRollUp` | — (civil `range` in body) |
| HR zones (daily) | `daily-heart-rate-zones` | `reconcile` | `daily_heart_rate_zones.date` (civil date) |
| Time in HR zone | `time-in-heart-rate-zone` | `dailyRollUp` | — (civil `range` in body) |
| Calories in HR zone | `calories-in-heart-rate-zone` | `dailyRollUp` | — (civil `range` in body, **max 14 days**) |
| Exercise sessions | `exercise` | `reconcile` | `exercise.interval.civil_start_time` (civil date) |
| Floors | `floors` | `dailyRollUp` | — (civil `range` in body) |
| Active minutes | `active-minutes` | `dailyRollUp` | — (civil `range` in body, **max 14 days**) |
| Active energy | `active-energy-burned` | `dailyRollUp` | — (civil `range` in body) |
| Sedentary time | `sedentary-period` | `dailyRollUp` | — (civil `range` in body) |
| Swim lengths | `swim-lengths-data` | `dailyRollUp` | — (civil `range` in body) |
| Altitude | `altitude` | `dailyRollUp` | — (civil `range` in body) |
| Height | `height` | `reconcile` | `height.sample_time.physical_time` (physical `Timestamp`) |
| RR sleep summary | `respiratory-rate-sleep-summary` | `reconcile` | `respiratory_rate_sleep_summary.sample_time.physical_time` (physical) |
| ECG | `electrocardiogram` | `list` | `electrocardiogram.interval.start_time` (physical `Timestamp`) |
| Irregular rhythm | `irregular-rhythm-notification` | `list` | `irregular_rhythm_notification.sample_time.physical_time` (physical) |
| Nutrition | `nutrition-log` | `dailyRollUp` | — (civil `range` in body) |
| Hydration | `hydration-log` | `dailyRollUp` | — (civil `range` in body) |

Rules of thumb:

- **Resting HR and HRV only exist as `daily-` computed types** (`list`/`reconcile`
  only — they do **not** support `dailyRollUp`), and they expose a flat **`date`**
  field rather than an interval.
- **Sleep is a session type**: bucketed by wake time, so it filters on
  `interval.end_time` as a **physical** timestamp (RFC3339 with `Z`), not a civil
  date. `start_time` and `session_time_interval` are rejected.
- **Other interval types** (e.g. `exercise`) filter on `interval.civil_start_time`
  with a plain `YYYY-MM-DD` value.
- **Measurement (sample) types** — `height`, `irregular-rhythm-notification`,
  `respiratory-rate-sleep-summary` — filter on `sample_time.physical_time`
  (physical `Timestamp`). ECG is the odd one out: it filters on
  `interval.start_time` as a **physical** timestamp.
- **ECG and irregular-rhythm** support `list` only (not `reconcile`), so the
  client has a `listByDate` helper that applies the same filter grammar to the
  plain list endpoint.
- Filter field names are **snake_case** (`daily_resting_heart_rate`), while the
  data type ID in the URL path is **kebab-case** (`daily-resting-heart-rate`).
- Ranges/filters are **closed-open** (start inclusive, end exclusive); the
  inclusive end the tools accept is advanced one day internally.
- **Query range caps:** `heart-rate`, `total-calories`, `active-minutes`, and
  `calories-in-heart-rate-zone` are limited to **14 days** per query; all other
  data types to **90 days**. Tools fetch the capped types best-effort so a long
  range degrades gracefully instead of failing the whole call.

### Caching

Completed days are immutable, so responses for date ranges that end **before
today** (in the user's timezone) are cached in the `HEALTH_CACHE` KV namespace
for 30 days, keyed per user. Any range touching today is always fetched live,
and cache read/write failures fall back to a live request — caching can never
break a call. Provision the namespace once with
`wrangler kv namespace create HEALTH_CACHE` and put its id in `wrangler.jsonc`.

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
   - `.../auth/googlehealth.nutrition.readonly`
   - `.../auth/googlehealth.ecg.readonly` (for `get_cardiac_events`)
   - `.../auth/googlehealth.irn.readonly` (for `get_cardiac_events`)
4. **Create credentials** → OAuth client ID → **Web application**.
   - Authorized redirect URI: `https://<your-worker>.workers.dev/callback`
     (you'll know `<your-worker>` after the first `wrangler deploy`; come back
     and add it, then redeploy is not needed — just save in Google).
   - Copy the **Client ID** and **Client Secret**.

## Deploy

Three ways, easiest first.

### Option A — Deploy to Cloudflare (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/a1dancole/google-health-mcp)

Forks this repo into your own GitHub, provisions the Worker and KV namespaces,
and deploys — all inside the Cloudflare dashboard, so **no API tokens are ever
pasted anywhere**. After it finishes:

1. **Set the app secrets** in *Workers & Pages → your worker → Settings →
   Variables and Secrets* (type **Secret**): `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, and `COOKIE_ENCRYPTION_KEY` (any long random string).
2. **Note your Worker URL** (shown after deploy) and set the Google OAuth client's
   redirect URI to `https://<your-worker>.workers.dev/callback`.

You still need the Google OAuth client from the step above — that part can't be
automated. (Requires the repo to be public.)

### Option B — GitHub Actions (no local wrangler)

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
deploys on every push to `master` (and on demand via "Run workflow"). Like the
replite setup, the **app secrets live in Cloudflare**, not GitHub — GitHub only
holds the Cloudflare API token + account id.

**One-time setup:**

1. **Create the KV namespace** in the Cloudflare dashboard: *Storage & Databases
   → KV → Create namespace* named `OAUTH_KV`. Copy its **ID** into
   `wrangler.jsonc` (replace `REPLACE_WITH_KV_NAMESPACE_ID`) and commit.
2. **Create a Cloudflare API token**: dashboard → *My Profile → API Tokens →
   Create Token → "Edit Cloudflare Workers" template*. Also note your
   **Account ID** (Workers & Pages → right sidebar).
3. **Add GitHub repo secrets** (*Settings → Secrets and variables → Actions →
   New repository secret*): just `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. **Push to `master`.** This creates the Worker. The Actions log prints its URL
   (`https://google-health-mcp.<subdomain>.workers.dev`).
5. **Set the app secrets in Cloudflare** (after the Worker exists): *Workers &
   Pages → google-health-mcp → Settings → Variables and Secrets → Add*, type
   **Secret** (encrypted), for each of:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `COOKIE_ENCRYPTION_KEY` (any long random string)

   These persist across deploys, so you set them once. (Or use
   `wrangler secret put <NAME>` locally if you prefer the CLI.)

### Option C — local wrangler

```sh
npm install
npx wrangler kv namespace create OAUTH_KV   # paste the printed id into wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any long random string
npx wrangler deploy
```

### After the first deploy (either option)

You'll have `https://google-health-mcp.<subdomain>.workers.dev`. Go back to the
Google OAuth client and set the redirect URI to
`https://google-health-mcp.<subdomain>.workers.dev/callback`.

## Connect in Claude

1. **Settings → Connectors → Add custom connector.**
2. URL: `https://google-health-mcp.<subdomain>.workers.dev/mcp`
3. Click **Connect** → you'll be sent to Google to grant access → done.
4. Repeat the "add connector" step on mobile if it doesn't sync automatically.

Then ask your coach: *"Check my recovery — should I do today's hard session?"*

## Connector icon

The Worker advertises `PUBLIC_URL/icon.png` in its MCP `serverInfo.icons`
(and `websiteUrl`), so clients that render server branding show it in the
connector list. `assets/icon.png` is the source of truth; to swap it (e.g. for
the official Google Health app icon from the Play Store listing):

```sh
npm run icon:embed -- ~/Downloads/google-health-icon.png   # writes src/icon.ts + assets/icon.png
npx wrangler deploy
```

(Official marks are their owners' trademarks — fine for a personal deployment,
not for redistribution.)

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
- **Skin temperature** (`daily-sleep-temperature-derivations`) is the nightly
  *variation from your personal baseline* computed during sleep — the same
  number the Fitbit app shows — not an absolute reading. It needs a device that
  records sleep temperature and ~3 nights of wear to establish a baseline.
- **Adding the ecg/irn scopes** to an existing deployment requires a
  reconnect: remove the connector's access at
  <https://myaccount.google.com/permissions>, then disconnect/reconnect the
  connector in Claude so Google re-prompts consent with the new scopes.
- **Not in the v4 API** (so not in this MCP): stress scores, readiness/daily
  readiness score, sleep score, mindfulness sessions, and menstrual-cycle
  logs. If Google adds them, `query_data_type` can reach them without a
  redeploy.
