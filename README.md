# Littlefield Simulation 2 dashboard (A Team)

Read-only dashboard for the team's Littlefield factory. The Google Sheet stays the
source of truth; this site shows what the Sheet says, plus the telemetry charts.

## What is in here

| Path | Purpose |
|---|---|
| `public/` | The site: `index.html`, `app.js`, `derive.js`, `styles.css`, `_headers` (security headers), and Chart.js 4.4.7 in `vendor/` |
| `src/worker.js` | Worker entry: sends `/api/*` to the two handlers, everything else to the static files |
| `src/api/ingest.js` | Receives a snapshot from the Sheet (shared secret), stores it in KV |
| `src/api/snapshot.js` | Returns the latest snapshot, a stored day, or the list of stored days |
| `wrangler.jsonc` | Worker settings: name, custom domain, KV binding, static assets |
| `apps-script/Code.gs` | Version 2 of the Sheet script: import from Drive, then push to the dashboard |
| `public/whatif.js` | The what-if section: control deck, charts, final order table |
| `public/advisor.js` | The advisor drawer: builds the telemetry and briefing data, streams answers |
| `src/api/chat.js`, `src/advisor/prompt.js`, `src/access.js` | The advisor endpoint, its fixed system prompt, and the Cloudflare Access identity check |
| `public/sim/` | JavaScript port of the event simulation (`model.js`, `snapshot.js`, `analysis.js`), run in a background thread (`worker.js`) |
| `test/` | Tests, sample snapshots (Days 50, 59 synthetic, 64), Python reference results, and a local preview server |
| `sim/` | Python event simulation: the reference model for the Phase 2 what-if simulator (see `sim/README.md`) |

## Try it on your own computer first (no accounts needed)

Requires Node 18 or later.

```
npm test          # 27 checks: Worker routes, calculations, the simulator against the Python model, the advisor
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

## The advisor (Phase 3)

A button at the bottom right opens the drawer. Four one-click briefings (audit the latest
upload, contract switch readiness, competitor cash forensics, end-game kit order) and free
questions. The browser computes every number and sends it as telemetry (about 3-6 KB); the
Worker adds a fixed system prompt and calls Claude, which explains the numbers and is told
not to calculate any of its own. Answers stream into the drawer and show the snapshot day.

Set up once:

1. In the Anthropic Console, create an API key and set a spending limit ($50).
2. Worker > Settings > Variables and Secrets > Add, type **Secret**, name `ANTHROPIC_API_KEY`.
3. Optional but recommended: add two more Secrets so the Worker checks the Access token
   itself, not just the email header: `ACCESS_TEAM_DOMAIN` (for example
   `yourteam.cloudflareaccess.com`, from Zero Trust > Settings) and `ACCESS_AUD` (the
   Application Audience (AUD) tag of the dashboard's Access application).
4. Check the Access Bypass rule covers only `api/ingest`. `/api/chat` and `/api/chatlog`
   must stay behind sign-in.

| Setting | Value |
|---|---|
| Model | `claude-sonnet-5-5` (Sonnet, as the team decided), effort `low` |
| Answer cap | 4,000 tokens (thinking included); the prompt asks for about 200 words |
| Daily cap | 60 questions a day for the whole team (`CHAT_DAILY_CAP` to change) |
| Refusals | Server-side fallback (`fallbacks: "default"`): if a safety classifier declines, the API retries on its recommended model in the same call |
| Prompt caching | The system prompt is identical on every call and cached; the telemetry is not |
| Cost | Roughly $0.01 a question at Sonnet 5.5 prices ($2 / $10 per million tokens) |

Every question and answer is stored in KV with the time, who asked (from Cloudflare
Access), the snapshot day and the telemetry sent. Export it from the drawer (Markdown or
JSON) for the course's AI disclosure.

Locally, `npm run preview` answers with a canned local reply, so the drawer can be tried
without a key. With `ANTHROPIC_API_KEY` set in the shell it calls Claude and is billed.

## Keeping the simulator in step with the Python model

`public/sim/model.js` is a line-by-line port of `sim/littlefield/model.py`. They share a
random number generator, so the same seed gives the same run. After changing either model:

```
cd sim && python3 -m unittest discover -s tests && python3 -m littlefield.golden
cd .. && npm test
```

`npm test` fails if any simulated day differs from the Python results.

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
  sessions, directed and reviewed by the team. The advisor's answers are written by Claude
  at the time of asking; the exported log records each one.
