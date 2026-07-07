# Atharva Jadhav — Portfolio + AI Recruiter Chat

A personal portfolio website with an **"Ask about me"** AI assistant that lets
recruiters ask questions and get answers grounded in the portfolio content.

- **Frontend:** vanilla HTML/CSS/JS (no build step), content-driven from `public/js/data.js`.
- **Backend:** small Node.js/Express app exposing `POST /api/chat`.
- **AI:** RAG-lite — the knowledge base (portfolio data + `knowledge.md`) is
  injected into the system prompt of a swappable LLM provider.
- **Hosting:** Vercel serverless (`@vercel/node`).

---

## Features

- Full-screen animated "Ask about me" chat overlay in the site's brand colors.
- Provider-swappable LLM (Groq / Mistral / Gemini) via environment variables.
- Guardrails: prompt-injection filter, strict on-topic system prompt, input
  validation, body-size limits, and best-effort per-IP rate limiting.
- Security headers via `helmet` (incl. a tuned Content-Security-Policy).
- Safe client rendering (HTML escaping + URL scheme validation).

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
| `LLM_MODEL`    | no       | Override the default model for the provider.            |

Get a free Groq key at https://console.groq.com/keys (no credit card).

> **Security:** never commit a real key. Keep it only in `.env` (local) and
> Vercel env vars. If a key is ever exposed, rotate it in the provider console.

---

## Updating content

- **Portfolio content** (name, skills, projects, experience, contact):
  edit `public/js/data.js` only — the page renders from it.
- **Chat knowledge** (extra bio / FAQ the assistant can use):
  edit `knowledge.md`. In development the prompt is rebuilt each request; in
  production it is cached (a redeploy picks up changes).

---

## Project structure

```
server.js              Express app: static hosting + POST /api/chat
lib/
  llm.js               Provider abstraction (Groq/Mistral/Gemini) + timeouts
  knowledge.js         Builds the system prompt from data.js + knowledge.md
  guards.js            sanitize / injection detection / rate limiter
knowledge.md           Editable extra knowledge base
public/
  index.html
  css/{style,chat}.css
  js/
    config.js          Shared limits (server + client)
    util.js            Shared escapeHtml / safeUrl / sanitizeHtml
    data.js            Portfolio content (single source of truth)
    render.js          Renders the page from data.js
    script.js          Portfolio interactions/animations
    chat.js            "Ask about me" chat overlay
test/                  node:test suites
vercel.json            Vercel routing
```

---

## Deployment (Vercel)

1. Push to the connected Git repo (Vercel auto-deploys).
2. Set `LLM_PROVIDER` and `LLM_API_KEY` in the project's Environment Variables.
3. Redeploy so the variables take effect.

---

## Notes & limitations

- The rate limiter is in-memory and **best-effort**: on serverless it resets per
  cold start, so it guards against casual abuse but is not a hard quota. For
  strict limits, back it with a shared store (e.g. Upstash Redis / Vercel KV).
- Free LLM tiers have per-minute token limits; the app surfaces provider `429`s
  as a friendly "busy, try again" message.