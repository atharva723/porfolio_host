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
  validation, body-size limits, and best-effort per-IP rate limiting.
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

---

## Updating content

- **Portfolio content** (name, skills, projects, experience, contact):
  edit `public/js/data.js` only — the page renders from it.
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
  guards.js            sanitize / injection detection / rate limiter
  cache.js             Response cache (in-memory LRU + optional Upstash Redis)
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

- The rate limiter is in-memory and **best-effort**: on serverless it resets per
  cold start, so it guards against casual abuse but is not a hard quota. For
  strict limits, back it with a shared store (e.g. Upstash Redis / Vercel KV).
- Without Upstash configured, the **response cache is in-memory only**, so hits
  are limited to a single warm instance and reset on cold starts. Configure
  Upstash for durable, cross-instance (and cross-visitor) cache hits.
- The cache matches on the **whole conversation**, so re-asking within one chat
  session is a miss (correct for multi-turn context). The big wins are common
  opening questions with empty history, which are shared across all visitors.
- Free LLM tiers have per-minute token limits; the app surfaces provider `429`s
  as a friendly "busy, try again" message.