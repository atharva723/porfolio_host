# Atharva Jadhav — Portfolio + AI Recruiter Chat

A personal portfolio website with an **"Ask about me"** AI assistant that lets
recruiters ask questions and get answers grounded in the portfolio content.

- **Frontend:** vanilla HTML/CSS/JS (no build step), content-driven from `public/js/data.js`.
- **Backend:** small Node.js/Express app exposing `POST /api/chat`.
- **AI:** RAG-lite — the knowledge base (portfolio data + `knowledge.md`) is
  injected into the system prompt of a swappable LLM provider.
- **Caching:** identical questions reuse a stored answer (in-memory + optional
  Upstash Redis) to cut redundant LLM calls.
- **Automation:** an n8n workflow keeps the project cards in sync with GitHub
  repos and writes `public/data/projects.json`.
- **Hosting:** Vercel serverless (`@vercel/node`).

---

## Features

- Full-screen animated "Ask about me" chat overlay in the site's brand colors.
- Provider-swappable LLM (Groq / Mistral / Gemini) via environment variables.
  Default model: Groq `openai/gpt-oss-20b`.
- **Response cache:** a two-tier cache (in-memory LRU + optional Upstash Redis)
  reuses the answer to an identical request, so repeat questions skip the LLM
  call. Replies served from cache show a small ⚡ "cached" badge, and the
  `/api/chat` response includes a `cached` boolean. The cache key hashes the
  system prompt, guard, full conversation, and model/params, so a cached answer
  is only ever reused when still valid — editing the knowledge base changes the
  prompt and transparently invalidates stale answers.
- Guardrails: prompt-injection filter, strict on-topic system prompt, input
  validation, body-size limits, and per-IP rate limiting (shared Redis
  counters, in-memory fallback).
- **Server-owned conversation memory:** the browser keeps only an opaque,
  HttpOnly session cookie; the conversation itself lives in Redis (in-memory
  fallback) for up to 1 hour of inactivity. Follow-up questions keep context,
  the transcript is restored after a page reload, "New chat" wipes it, and
  client-supplied history is ignored, so earlier turns can't be forged.
- Security headers via `helmet` (incl. a tuned Content-Security-Policy).
- Safe client rendering (HTML escaping + URL scheme validation).
- Project cards stay in sync with GitHub repos via an n8n automation
  (see [`automation/`](automation/)).

---

## Getting started (local)

Requirements: Node.js 18+.

```bash
npm install
cp .env.example .env   # then edit .env and add your API key
npm start              # http://localhost:5000
```

Run tests:

```bash
npm test               # node:test unit + API tests
```

---

## Environment variables

Set locally in `.env` (gitignored) and, for production, in
**Vercel → Settings → Environment Variables**.

| Variable       | Required | Description                                             |
| -------------- | -------- | ------------------------------------------------------- |
| `LLM_PROVIDER` | no       | `groq` (default), `mistral`, or `gemini`.               |
| `LLM_API_KEY`  | yes      | API key for the chosen provider.                        |
| `LLM_MODEL`    | no       | Override the default model (`openai/gpt-oss-20b` on Groq). |

Get a free Groq key at https://console.groq.com/keys (no credit card).

> **Note:** Groq periodically retires models. If the chat returns a 502
> "assistant is unavailable", check https://console.groq.com/docs/models and
> update `LLM_MODEL` (or the default in `lib/llm.js`).

### Response cache (optional)

The cache works with **no configuration** (in-memory only). For a shared,
durable cache across serverless instances, add a free
[Upstash Redis](https://upstash.com) database and set its REST credentials.
Without these, the app silently falls back to in-memory caching.

| Variable                   | Required | Description                                                        |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | no       | Upstash Redis REST endpoint (enables the shared/durable L2 cache). |
| `UPSTASH_REDIS_REST_TOKEN` | no       | Upstash Redis REST token.                                          |
| `CHAT_CACHE_TTL_SECONDS`   | no       | Entry lifetime in seconds (default `2592000` = 30 days).          |
| `CHAT_CACHE_MEM_MAX`       | no       | Max in-memory entries (default `500`).                            |
| `CHAT_CACHE_DISABLED`      | no       | Set to `1` to bypass the cache entirely.                          |

> **Upstash setup:** create a **Regional** Redis DB (pick the region nearest your
> Vercel deployment, e.g. `us-east-1`), copy `UPSTASH_REDIS_REST_URL` and
> `UPSTASH_REDIS_REST_TOKEN` from its REST section into Vercel env vars, then
> **redeploy** (Vercel only injects env vars into new deployments). The free tier
> (256 MB, 500K commands/month, no card) is far beyond a portfolio's needs.

> **Security:** never commit a real key. Keep it only in `.env` (local) and
> Vercel env vars. If a key is ever exposed, rotate it in the provider console.

### Sessions & rate limiting

Both use the same Upstash Redis credentials as the cache and fall back to
per-instance memory when Redis is missing or erroring (the chat never fails
because of them).

| Variable              | Required | Description                                                           |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `SESSION_TTL_SECONDS` | no       | Idle lifetime of a chat session (default `3600` = 1 hour).            |
| `RATE_LIMIT_SALT`     | no       | Secret salt for hashing client IPs; raw IPs are never stored in Redis. |

Redis keys: `sess:<id>:turns` (last 12 messages, sliding TTL), `sess:<id>:lock`
(one in-flight message per session, 30 s safety TTL), `rl:<bucket>:<hash>`
(fixed-window counters). API: `POST /api/chat` (body: `{ message }`),
`GET /api/chat/history` (restore transcript), `DELETE /api/chat/history`
(new chat).

---

## Updating content

- **Portfolio content** (name, skills, projects, experience, education,
  certifications, contact): edit `public/js/data.js` only — the page renders
  from it, and the chat assistant reads the same data (education is used by the
  assistant but not rendered on the page).
- **Project cards** are rendered from `public/data/projects.json` when present
  (kept up to date by the n8n automation in [`automation/`](automation/)), and
  fall back to `public/js/data.js` if that file is missing or invalid.
- **Chat knowledge** (extra bio / FAQ the assistant can use):
  edit `knowledge.md`. In development the prompt is rebuilt each request; in
  production it is cached (a redeploy picks up changes). Because the system
  prompt is part of the cache key, editing it also invalidates cached replies.

---

## Project structure

```
server.js              Express app: static hosting + POST /api/chat
lib/
  llm.js               Provider abstraction (Groq/Mistral/Gemini) + timeouts
  knowledge.js         Builds the system prompt from data.js + knowledge.md
  guards.js            sanitize / injection detection / in-memory limiter (fallback)
  cache.js             Response cache (in-memory LRU + optional Upstash Redis)
  redis.js             Shared Upstash Redis client (null when unconfigured)
  session.js           Server-owned chat sessions (cookie id, Redis memory, lock)
  ratelimit.js         Redis rate limits with hashed IPs + in-memory fallback
knowledge.md           Editable extra knowledge base
public/
  index.html
  css/{style,chat}.css
  js/
    config.js          Shared limits (server + client)
    util.js            Shared escapeHtml / safeUrl / sanitizeHtml
    data.js            Portfolio content (single source of truth)
    render.js          Renders the page (project cards from data/projects.json)
    script.js          Portfolio interactions/animations
    chat.js            "Ask about me" chat overlay (+ cached badge)
  data/
    projects.json      Project cards (auto-generated by the n8n automation)
automation/            n8n workflow + launcher that syncs project cards from GitHub
test/                  node:test suites
vercel.json            Vercel routing
```

---

## Deployment (Vercel)

1. Push to the connected Git repo (Vercel auto-deploys).
2. Set `LLM_PROVIDER` and `LLM_API_KEY` in the project's Environment Variables.
   Optionally add the Upstash Redis vars to enable the shared cache.
3. Redeploy so the variables take effect (Vercel only injects env vars into
   new deployments).

---

## Notes & limitations

- Rate limits and sessions are shared across serverless instances **only when
  Upstash is configured**. Without it they fall back to per-instance memory,
  which resets on cold starts (fine locally, a soft guard in production).
- Without Upstash configured, the **response cache is in-memory only**, so hits
  are limited to a single warm instance and reset on cold starts. Configure
  Upstash for durable, cross-instance (and cross-visitor) cache hits.
- The cache matches on the **whole conversation** (now loaded from the server
  session), so a follow-up in an ongoing chat is a miss (correct for multi-turn
  context). The big wins are common opening questions, which are shared across
  all visitors.
- Chat text is stored in Redis for up to the session TTL (default 1 hour of
  inactivity) so follow-ups work; visitors can wipe it with "New chat".
- Free LLM tiers have per-minute token limits; the app surfaces provider `429`s
  as a friendly "busy, try again" message.