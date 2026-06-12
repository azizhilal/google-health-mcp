# Going fully public — roadmap

Goal: anyone can add the connector and use it after a single Google-consent
click, with no "unverified app" warning and no user cap.

## Reality check

The **code is already multi-tenant** — one deployed instance issues a separate
token per Google account and keys all storage per user. The gates to "fully
public" are **not** engineering; they are Google policy and the operating
responsibilities of holding other people's health data:

1. **Google Health API access** for your Cloud project (may require a request /
   approval — confirm yours is granted).
2. **A custom domain you own** — OAuth verification requires the app homepage and
   privacy policy to live on an authorized domain you control (a shared
   `*.pages.dev` / `*.workers.dev` is not sufficient for verification).
3. **OAuth app verification** for the sensitive/**restricted** `googlehealth.*`
   scopes.
4. **A CASA security assessment** (annual, paid) — required for restricted scopes.

Until 3 + 4 are done, an app using these scopes is limited to **100 users** and
shows an **"unverified app"** warning.

---

## Phase 0 — Launch now (unverified, ≤100 users)

You don't have to wait for verification to onboard real users.

- Set the OAuth consent screen to **In production** (still unverified).
- Up to **100 users** can connect; they'll see an "unverified app" warning they
  can click through.
- This validates demand before you spend anything on CASA.

## Phase 1 — Production readiness (code + content) — *I can build these*

- [ ] **Custom domain** for the site + worker (e.g. `app.example.com` for the
      MCP endpoint, `example.com` for the marketing site + privacy/terms).
- [ ] **Privacy policy + ToS on that domain**, with explicit Google
      **Limited Use** disclosure (we have drafts — move + strengthen).
- [ ] **Scope minimization** — request only the scopes the shipped tools use.
      Fewer restricted scopes = less verification + assessment burden.
- [ ] **Data deletion + disconnect** — a clear, documented way for a user to
      revoke access and delete their stored tokens/cache (Google requires this).
- [ ] **Security hardening for CASA/ASVS** — security headers, dependency
      hygiene, secret handling, request logging/monitoring, abuse/rate limiting,
      input validation review.

## Phase 2 — OAuth verification (you, with my prep)

- Complete the OAuth consent screen: app name, **logo**, authorized domains,
  homepage URL, privacy-policy URL.
- Submit each **restricted** scope with a written justification.
- Record a **demo video** showing the consent flow and how each scope is used.
- Submit for Google review (iterate on their feedback).

## Phase 3 — CASA security assessment (you)

- The `googlehealth.*` scopes are **restricted**, so exceeding 100 users
  requires an annual **CASA Tier 2** assessment via a Google-authorized
  assessor (OWASP ASVS-based).
- **Cost: ~$500–$4,500 USD per year** (App Defense Alliance pricing), ~2–3
  weeks, plus remediation effort. Only required to go beyond 100 users — not
  for personal use or the ≤100-user unverified launch.

## Phase 4 — Operate

- Monitoring + incident response, token rotation, rate limiting, a support
  channel, and **annual** CASA re-assessment + re-verification.

---

## Honest risks

- **Google may decline restricted health scopes** for an individual/hobby
  project without a clear business justification.
- **CASA cost/effort is the real barrier** — far more than hosting.
- As host you become the **data controller** for users' health data
  (GDPR/CCPA obligations if you have EU/California users).

## Recommendation

Do **Phase 0 now** (launch unverified, ≤100 users) and build **Phase 1**
readiness in parallel. **Don't pay for CASA until you have real demand** — let
usage justify the spend. Decide on verification once you've validated people
actually want it.
