# Google Reviews — Setup & Maintenance

How the reviews on the site (Hero rating badge + Reviews carousel) are populated,
and what to do to switch from the **5-review Places API** fallback to **all reviews
via the Business Profile API**.

---

## Current state

- The site fetches reviews at **build time** via `scripts/fetch-reviews.mjs` (wired
  into the `build` script in `package.json`).
- Result is written to `src/config/reviews.generated.json`, which the components read
  (`src/config/reviews.ts`). The manual list in `reviews.ts` is a last-resort fallback.
- A daily GitHub Action (`.github/workflows/update-reviews.yml`) pings a **Vercel Deploy
  Hook** so the site rebuilds once a day and the reviews refresh. No git commits are made.
- **Today it uses the Places API → max 5 reviews.** To get *all* reviews, finish the
  Business Profile API setup below.

### The fetch script tries two sources, in order
1. **Business Profile API** — ALL reviews. Used when the `GOOGLE_OAUTH_*` env vars are set.
2. **Places API** — up to 5 reviews. Used as fallback when `GOOGLE_PLACES_API_KEY` is set.
3. If neither works, the committed JSON is left untouched (build never breaks).

---

## Reference values (not secret)

| Thing | Value |
|---|---|
| Business | Taxi München – Flughafen Transfer |
| Google Cloud project number | `489280889671` |
| OAuth Client ID | `489280889671-o0e79iku8o1hkilhrovpq57q1e3q1la9.apps.googleusercontent.com` |
| Places Place ID (fallback) | `ChIJrQdHWnrXnUcRXYXRkpcV9EM` |
| Google account (owns everything) | the account that **manages the business profile** |
| Vercel project | the one serving `airporttransfer-muc.de` (customer's account) |

---

## ✅ Already done

- [x] OAuth client created (Desktop-App / "Nutzerdaten").
- [x] Vercel env var `GOOGLE_PLACES_API_KEY` set (powers the 5-review fallback).
- [x] Vercel Deploy Hook created; URL stored as GitHub secret `VERCEL_DEPLOY_HOOK_URL`
      in the dev repo (`aturancetin/taxi-website`).
- [x] Daily GitHub Action live.

## ⏳ Blocked on

- [ ] **Business Profile API access approval.** Until granted, calls return
      `429 RESOURCE_EXHAUSTED` with `quota_limit_value: 0`. That is the access gate,
      not a real rate limit.

---

## Step 1 — Request Business Profile API access (the long pole)

1. Submit the access request form: <https://support.google.com/business/contact/api_default>
   - Project number: `489280889671`
   - Describe the use case (display the business's own Google reviews on its website).
2. Wait for approval (usually a few days; Google emails you).
3. In Google Cloud Console, make sure these APIs are **enabled** for the project:
   - Google My Business API  *(serves reviews — the `mybusiness.googleapis.com/v4` endpoint)*
   - My Business Account Management API
   - My Business Business Information API

**How to know it's approved:** the local test in Step 4 returns reviews instead of a
`429 / quota_limit_value: 0`.

---

## Step 2 — Make sure the OAuth consent screen is production-ready

(So the refresh token is permanent and you never have to redo this.)

- **User type / Zielgruppe = External.** (If it's "Internal" you get
  `Error 403: org_internal` during capture.)
- **Publishing status = In production / Published.** (If left in "Testing", refresh
  tokens **expire after 7 days** and the daily build breaks weekly.)
- Scope used: `https://www.googleapis.com/auth/business.manage`.

---

## Step 3 — Capture a refresh token (one time)

Get the **Client Secret** from Cloud Console → APIs & Services → Credentials →
the `AirportTransferMuc` OAuth client. (If it was ever leaked, reset it there first.)

Run locally, signed in as the **owner** account:

```bash
cd /path/to/taxi-website
GOOGLE_OAUTH_CLIENT_ID="489280889671-o0e79iku8o1hkilhrovpq57q1e3q1la9.apps.googleusercontent.com" \
GOOGLE_OAUTH_CLIENT_SECRET="<client-secret>" \
node scripts/get-refresh-token.mjs
```

- A browser opens → sign in as the owner account.
- If you see an "unverified app" warning: **Advanced → continue**.
- The terminal prints a **refresh token**. Keep it secret (do NOT paste it anywhere public).

---

## Step 4 — Test it works (locally)

```bash
cd /path/to/taxi-website
GOOGLE_OAUTH_CLIENT_ID="489280889671-o0e79iku8o1hkilhrovpq57q1e3q1la9.apps.googleusercontent.com" \
GOOGLE_OAUTH_CLIENT_SECRET="<client-secret>" \
GOOGLE_OAUTH_REFRESH_TOKEN="<refresh-token>" \
node scripts/fetch-reviews.mjs
```

- ✅ Success → `Wrote N reviews · rating X · N total (source: business-profile)` and
  `src/config/reviews.generated.json` is updated with all reviews.
- ❌ `429 ... quota_limit_value: 0` → access still not approved (back to Step 1).
- The log lines start with `[reviews]` and contain **no secrets**.

> Optional: if the wrong location is picked (more than one business on the account),
> pin it with `GOOGLE_LOCATION_NAME="accounts/<id>/locations/<id>"`.

---

## Step 5 — Store the secrets in Vercel (so production uses Business Profile)

In the **customer's Vercel project** (serves `airporttransfer-muc.de`) →
**Settings → Environment Variables** (Production + Preview), add:

| Name | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | the Client ID above |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the Client Secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | the refresh token from Step 3 |

Keep `GOOGLE_PLACES_API_KEY` too — it stays as the automatic fallback.

These env vars must live in whichever repo/project Vercel **builds** (the customer's
fork). The build runs `scripts/fetch-reviews.mjs`, sees the OAuth vars, and pulls all
reviews. The daily Deploy Hook keeps them fresh.

---

## Step 6 — Ship & verify

1. Make sure the code (this branch) is in the **customer's fork** (sync the fork).
2. Trigger a deploy (push, fork sync, or the GitHub Action → "Refresh reviews").
3. Check the live site: the Hero badge count and the carousel should now show all reviews.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `429 ... quota_limit_value: 0` | API access not approved yet → Step 1. |
| `403 org_internal` during capture | Consent screen is "Internal" → switch to **External** (Step 2). |
| Refresh token stops working after ~7 days | Consent screen still in "Testing" → **Publish** it (Step 2), recapture. |
| `token refresh failed` | Refresh token revoked/expired → recapture (Step 3). |
| Build shows only 5 reviews | OAuth env vars missing in Vercel, or Business Profile call failed → it fell back to Places. Check Vercel build logs for `[reviews]` lines. |

---

## Files involved

- `scripts/fetch-reviews.mjs` — fetches reviews (Business Profile → Places fallback), writes the JSON.
- `scripts/get-refresh-token.mjs` — one-time OAuth refresh-token capture helper.
- `src/config/reviews.generated.json` — generated data (also the offline fallback).
- `src/config/reviews.ts` — reads generated data; manual list = last-resort fallback.
- `.github/workflows/update-reviews.yml` — daily Deploy Hook ping.
- `package.json` — `build` runs the fetch script before `astro build`.
