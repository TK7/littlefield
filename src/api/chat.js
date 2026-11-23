// POST /api/chat  - ask the Operations Advisor (Phase 3).
// GET  /api/chatlog?format=json|md  - every question and answer, for the course's AI disclosure.
//
// The dashboard computes every number and sends it as telemetry; Claude only explains.
// Bindings: LF_KV (KV), ANTHROPIC_API_KEY (secret). Optional vars: ADVISOR_MODEL,
// ADVISOR_MAX_TOKENS, CHAT_DAILY_CAP, CHAT_DAILY_TOKENS, ACCESS_TEAM_DOMAIN + ACCESS_AUD
// (see access.js), PORTFOLIO_MODE ("1" turns the live advisor and the log off).

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, BRIEFINGS } from '../advisor/prompt.js';
import { identify } from '../access.js';

const MODEL = 'claude-sonnet-5-5';      // the team chose Sonnet; see docs/OPERATIONS.md
const MAX_TOKENS = 1500;                // cost cap per answer (thinking counts towards it)
const DAILY_CAP = 60;                   // questions per UTC day, for the whole team
const DAILY_TOKENS = 250_000;           // tokens per UTC day (input, cache and output), about $1.50
const LIMITS = { body: 64_000, question: 2_000, telemetry: 40_000, turns: 6, turnText: 4_000 };

export function portfolio(env) {
  return env.PORTFOLIO_MODE === '1' || env.PORTFOLIO_MODE === 'true';
}

const OFF = 'The live advisor is off in the portfolio version of this dashboard. Saved example answers are shown instead.';

// GET /api/config - what the page should offer: live advisor or saved examples.
export function onConfig({ env }) {
  return json({
    portfolio: portfolio(env),
    advisor: portfolio(env) ? null : {
      live: !!env.ANTHROPIC_API_KEY,
      maxTokensPerAnswer: Number(env.ADVISOR_MAX_TOKENS) || MAX_TOKENS,
      dailyQuestions: Number(env.CHAT_DAILY_CAP) || DAILY_CAP,
      dailyTokens: Number(env.CHAT_DAILY_TOKENS) || DAILY_TOKENS,
    },
  });
}

export async function onChat({ request, env, ctx }) {
  if (portfolio(env)) return json({ error: OFF }, 404);
  const who = await identify(request, env);
  if (!who.ok) return json({ error: who.reason }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'The advisor is not set up: the ANTHROPIC_API_KEY secret is missing.' }, 503);
  if (!env.LF_KV) return json({ error: 'Server not configured: LF_KV binding is missing.' }, 500);

  const text = await request.text();
  if (text.length > LIMITS.body) return json({ error: 'Request too large.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Body is not valid JSON.' }, 400); }
  const problem = check(body);
  if (problem) return json({ error: problem }, 400);

  // Daily cap, counted before the call so a runaway loop stops at the cap.
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.CHAT_DAILY_CAP) || DAILY_CAP;
  const countKey = 'chatcount:' + day;
  const used = Number(await env.LF_KV.get(countKey)) || 0;
  if (used >= cap) return json({ error: 'The daily limit of ' + cap + ' questions has been reached. It resets at midnight UTC.' }, 429);
  const tokenCap = Number(env.CHAT_DAILY_TOKENS) || DAILY_TOKENS;
  const tokenKey = 'chattokens:' + day;
  const tokensUsed = Number(await env.LF_KV.get(tokenKey)) || 0;
  if (tokensUsed >= tokenCap) {
    return json({ error: 'Today\'s advisor budget of ' + tokenCap.toLocaleString('en-US') + ' tokens is used up. It resets at midnight UTC.' }, 429);
  }
  await env.LF_KV.put(countKey, String(used + 1), { expirationTtl: 3 * 86400 });

  const question = body.briefing ? BRIEFINGS[body.briefing] : body.question.trim();
  const telemetry = body.telemetry;
  const messages = [];
  for (const turn of (body.history || []).slice(-LIMITS.turns)) {
    messages.push({ role: turn.role, content: String(turn.text).slice(0, LIMITS.turnText) });
  }
  messages.push({
    role: 'user',
    content: 'Telemetry from the dashboard (snapshot Day ' + telemetry.day + '):\n```json\n'
      + JSON.stringify(telemetry) + '\n```\n\n' + (body.briefing ? 'Briefing request: ' : 'Question: ') + question,
  });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: env.ANTHROPIC_FETCH, maxRetries: 1 });
  const model = env.ADVISOR_MODEL || MODEL;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n'));

  const work = (async () => {
    let answer = '', final = null, error = null;
    try {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: Number(env.ADVISOR_MAX_TOKENS) || MAX_TOKENS,
        // Server-side fallback: if a safety classifier declines, the API retries on its
        // recommended model inside the same call instead of returning a refusal.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },   // short explanatory answers
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          answer += event.delta.text;
          await send({ t: 'text', v: event.delta.text });
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      error = describe(err);
    }
    const stop = final ? final.stop_reason : null;
    const note = error ? error
      : stop === 'refusal' ? 'The model declined to answer this. Rephrase the question or use the Playbook.'
      : stop === 'max_tokens' ? 'The answer hit the length cap and is cut short.'
      : null;
    const usage = final ? {
      input: final.usage.input_tokens, output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens || 0, cacheWrite: final.usage.cache_creation_input_tokens || 0,
    } : null;
    const spent = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
    const tokensNow = (Number(await env.LF_KV.get(tokenKey)) || 0) + spent;
    if (spent) await env.LF_KV.put(tokenKey, String(tokensNow), { expirationTtl: 3 * 86400 });
    await send({ t: 'done', stop, note, error: !!error, model: final ? final.model : model, usage,
      remaining: Math.max(0, cap - used - 1), tokensLeft: Math.max(0, tokenCap - tokensNow) });
    await writer.close();

    const at = new Date().toISOString();
    const entry = {
      at, email: who.email, verified: who.verified, briefing: body.briefing || null, question,
      answer, stop, note, model: final ? final.model : model, usage,
      snapshotDay: telemetry.day, snapshotReceivedAt: telemetry.receivedAt || null, telemetry,
    };
    await env.LF_KV.put('log:' + at + ':' + Math.random().toString(36).slice(2, 6), JSON.stringify(entry));
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);

  return new Response(readable, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-snapshot-day': String(telemetry.day) },
  });
}

function check(b) {
  if (!b || typeof b !== 'object') return 'Body must be an object.';
  if (b.briefing !== undefined && b.briefing !== null && !(b.briefing in BRIEFINGS)) return 'Unknown briefing.';
  if (!b.briefing && (typeof b.question !== 'string' || !b.question.trim())) return 'Ask a question.';
  if (!b.briefing && b.question.length > LIMITS.question) return 'Question too long.';
  if (!b.telemetry || typeof b.telemetry !== 'object' || !Number.isFinite(b.telemetry.day)) return 'Telemetry with a snapshot day is required.';
  if (JSON.stringify(b.telemetry).length > LIMITS.telemetry) return 'Telemetry too large.';
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) return 'History must be a list.';
    for (const t of b.history) {
      if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string') return 'Bad history entry.';
    }
    if (b.history.length && b.history[0].role !== 'user') return 'History must start with a question.';
  }
  return null;
}

// Most specific first; the message is shown in the drawer and kept in the log.
function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Claude API rejected the key. Check the ANTHROPIC_API_KEY secret.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'The API key is not allowed to use this model.';
  if (err instanceof Anthropic.RateLimitError) return 'The Claude API is rate limiting or the spending limit is reached. Try again later.';
  if (err instanceof Anthropic.BadRequestError) return 'The Claude API refused the request: ' + err.message;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Try again.';
  if (err instanceof Anthropic.APIError) return 'The Claude API answered ' + err.status + '. Try again.';
  return 'The advisor failed: ' + (err && err.message ? err.message : String(err));
}

export async function onChatLog({ request, env }) {
  if (portfolio(env)) return json({ error: OFF }, 404);
  const who = await identify(request, env);
  if (!who.ok) return json({ error: who.reason }, 401);
  if (!env.LF_KV) return json({ error: 'Server not configured: LF_KV binding is missing.' }, 500);
  const entries = [];
  let cursor;
  do {
    const page = await env.LF_KV.list({ prefix: 'log:', cursor });
    for (const k of page.keys) {
      const v = await env.LF_KV.get(k.name);
      if (v) entries.push(JSON.parse(v));
    }
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  const format = new URL(request.url).searchParams.get('format');
  if (format === 'md') {
    const md = ['# Littlefield Simulation 2: AI advisor log (A Team)', '',
      'Every question asked of the dashboard advisor and its answer, in order. Model: Claude (Anthropic). '
      + 'The numbers in each answer came from the dashboard telemetry for the snapshot day shown.', ''];
    for (const e of entries) {
      md.push('## ' + e.at + ', snapshot Day ' + e.snapshotDay + ', asked by ' + e.email, '',
        '**' + (e.briefing ? 'Briefing (' + e.briefing + ')' : 'Question') + ':** ' + e.question, '',
        e.answer || '(no answer)', '');
      if (e.note) md.push('_' + e.note + '_', '');
      md.push('Model ' + e.model + (e.usage ? ', ' + e.usage.input + ' input / ' + e.usage.output + ' output tokens' : ''), '');
    }
    return new Response(md.join('\n'), { headers: {
      'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="littlefield-advisor-log.md"' } });
  }
  return new Response(JSON.stringify({ entries }, null, 1), { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': format === 'json' ? 'attachment; filename="littlefield-advisor-log.json"' : 'inline' } });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
