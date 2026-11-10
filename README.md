# Littlefield Simulation 2 dashboard (A Team)

Read-only dashboard for the team's Littlefield factory. The Google Sheet stays the
source of truth; this site shows what the Sheet says, plus the telemetry charts.

**Phase 1 (this code):** data sync from the Sheet, the Playbook statuses, and the
telemetry and stockout audit. Phase 2 adds the what-if simulator; Phase 3 adds the
advisor. Neither is in this repository yet, so no Claude API key is needed so far.

## What is in here

| Path | Purpose |
|---|---|
| `public/` | The site: `index.html`, `app.js`, `derive.js`, `styles.css`, `_headers` (security headers), and Chart.js 4.4.7 in `vendor/` |
| `src/worker.js` | Worker entry: sends `/api/*` to the two handlers, everything else to the static files |
| `src/api/ingest.js` | Receives a snapshot from the Sheet (shared secret), stores it in KV |
| `src/api/snapshot.js` | Returns the latest snapshot, a stored day, or the list of stored days |
| `wrangler.jsonc` | Worker settings: name, custom domain, KV binding, static assets |
| `apps-script/Code.gs` | Version 2 of the Sheet script: import from Drive, then push to the dashboard |
| `test/` | Tests, two sample snapshots, and a local preview server |

## Try it on your own computer first (no accounts needed)

Requires Node 18 or later.

```
npm test          # 9 checks on the Worker routes, the two handlers and the calculations
npm run preview   # then open http://localhost:8788
```

The preview loads the real Day 50 data. `node test/serve.mjs test/fixtures/day59-synthetic.json`
loads a made-up later day with machine purchases, a kit order and contract switches.

## Deploy (Cloudflare Worker at littlefield.jay.systems)

The site runs as one Cloudflare Worker with static assets, built by Workers Builds
from this GitHub repository. `wrangler.jsonc` holds every setting except the secret.

1. **Worker name.** The `name` in `wrangler.jsonc` (`littlefield`) must match the Worker's
   name in the Cloudflare dashboard. If yours is called something else, change it there.
2. **Build settings.** Worker > Settings > Build: repository `TK7/littlefield`, production
   branch `main`, build command empty, deploy command `npx wrangler deploy`, root directory `/`.
3. **KV.** Nothing to do: the first deploy creates the namespace and binds it as `LF_KV`.
   If you already made one by hand, put its id in `wrangler.jsonc` (`"id": "..."`) instead.
4. **Secret.** Make a long random string (30+ characters). Worker > Settings >
   Variables and Secrets > add a **Secret** named exactly `INGEST_SECRET`. Secrets survive
   later deploys. Without it, `/api/ingest` answers 500.
5. **Domain.** The deploy attaches `littlefield.jay.systems` as a custom domain. The
   `workers.dev` address and preview URLs are switched off, so the domain is the only way in.
6. **Access.** Zero Trust > Access > Applications > add a self-hosted application for
   `littlefield.jay.systems`, with an Allow policy listing the three team email addresses.
   Then add a second application for `littlefield.jay.systems/api/ingest` with a
   Bypass policy for Everyone. That path is protected by `INGEST_SECRET` instead,
   because the Google Sheet cannot sign in by email.
7. **Sheet.** In the Google Sheet: Extensions > Apps Script. Replace the whole script
   with `apps-script/Code.gs` and save. Reload the Sheet, then
   Littlefield > Set dashboard connection (paste `https://littlefield.jay.systems` and the
   secret), then Littlefield > Push to dashboard now.
8. Open `https://littlefield.jay.systems`. It should ask for your email, then show Day 50.

To deploy by hand instead: `npm install`, `npx wrangler login`, `npm run deploy`.

### Checks after deploying

- Signed out, the address must show the Cloudflare sign-in, not the dashboard.
- `https://littlefield.jay.systems/api/snapshot` in a private window must also ask for sign-in.
- A wrong secret must fail: the Sheet shows "the dashboard answered 401".
- If the Sheet shows "answered 302" or "403", the Bypass rule for `api/ingest` is not in effect.

## How updates flow

1. Someone drops a Littlefield download in the Drive source folder.
2. Within 15 minutes the Sheet imports it and pushes a snapshot here.
3. The Sheet also pushes when a yellow Settings cell changes, at the next 15-minute run.
4. Press Refresh on the dashboard. The "Snapshot" menu replays any earlier stored day.

## Notes

- Nothing secret is in this repository. The secret lives in Cloudflare and in the
  Sheet's document properties. If it leaks, change it in both places.
- The kit stock figures are estimates inferred from cash movements, as in the Sheet.
- KV is eventually consistent: a push can take up to about a minute to show after Refresh.
- AI disclosure: this code was written by Claude (Anthropic) in Cowork and Claude Code
  sessions, directed and reviewed by the team.
