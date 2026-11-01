# Atharva Jadhav — Portfolio + AI Recruiter Chat

A personal portfolio website with an **"Ask about me"** AI assistant that lets
recruiters ask questions and get answers grounded in the portfolio content.

- **Frontend:** vanilla HTML/CSS/JS (no build step), content-driven from `public/js/data.js`.
- **Backend:** small Node.js/Express app exposing `POST /api/chat`.
- **AI:** the assistant answers from its own knowledge base (`kb/kb.json`) plus
  your **live resume** (a published Google Doc), injected into the system prompt
  of a swappable LLM provider. It does not read the website's `data.js`.
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
- Guardrails (see "How a message is handled" below): an **LLM input guard**
  (scope / prompt-injection / safety, with Meta's Prompt Guard as a second
  signal), an **answer verifier** (deterministic grounding checks + an LLM check
  against the sources), input validation, body-size limits, and per-IP rate
  limiting (shared Redis counters, in-memory fallback). If a safety check can't
  run, the visitor gets a clear error — the bot never answers unchecked.
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
| `LLM_MODEL`    | no       | Model that writes answers (`openai/gpt-oss-20b` on Groq). |
| `GUARD_MODEL`  | no       | Input-guard model (`qwen/qwen3.8-27b` on Groq).         |
| `PLAN_MODEL`   | no       | Tool-planner model (`qwen/qwen3.8-27b` on Groq).        |
| `VERIFY_MODEL` | no       | Answer-verifier model (`openai/gpt-oss-120b` on Groq).  |
| `PROMPT_GUARD_MODEL` | no | Prompt Guard model (`meta-llama/llama-prompt-guard-2-86m`, Groq only); set `off` to disable. |
| `CHAT_BUDGET_MS` | no     | Time budget for one chat turn (default `25000`).        |

Get a free Groq key at https://console.groq.com/keys (no credit card).

Each pipeline stage runs on a **different model on purpose**: Groq's free-tier
rate limits are per model (about 8,000 tokens/minute for the answer, guard and
verifier models; 2,000 for `gpt-oss-safeguard`, which is why it isn't used), so
sharing one model would let the stages starve each other. If the guard or
verifier model is retired, the call falls back to `LLM_MODEL` automatically and
logs a warning.

> **Note:** Groq periodically retires models. If the chat returns a 502
> "assistant is unavailable", check https://console.groq.com/docs/models and
> update `LLM_MODEL` (or the default in `lib/llm.js`).

### How a message is handled

```
cache hit? ──yes──► answer (it was verified when first stored)
   │ no
   ▼
input guard ─ off-topic ─► friendly redirect      (nothing is answered or remembered)
   │          injection ─► refusal                (policy model, or Prompt Guard >= 0.99)
   │          unsafe    ─► polite decline
   │ allow
   ▼
planner   a small model picks which lookup tools the message needs, as JSON
   ▼
tools     read-only code over the KB + live resume (certifications, education,
          projects, skills, experience, contact, LinkedIn snapshot, resume,
          resume download link, site links)
   ▼
answer model   sees ONLY the lookup results and cannot call tools itself
   ▼
verifier: links / e-mails / numbers must appear in the lookup results (free), then
          an LLM check of every claim against them
   │ supported ──► cached + returned (with source labels and follow-up chips)
   │ not supported ─► regenerate once with generic feedback ─► verify again
   │                  still not supported ─► "I couldn't confirm that" + contact details
   ▼
guard or verifier unavailable ─► 503 "can't run my safety checks" (never unchecked)
```

**Why the answering model has no tools ("plan, then execute").** A native
tool-calling loop re-sends the prompt on every round (little token saving), and
text injected into a tool result (e.g. a poisoned resume) could make the model
call more tools. Here the planner's JSON is validated against the registry
(unknown names and bad arguments are dropped, at most 3 tools run) and the tools
run as plain code, so tool output can never trigger another tool. If the planner
can't produce a usable plan, the turn falls back to **context mode** (the whole
KB + resume in the prompt: bigger, same guarantees).

**Tools** live one-per-file in [`lib/tools/`](lib/tools/); each exports
`name, label, topic, suggestion, description, parameters, run(args, ctx)` and is
registered in `lib/tools/index.js`. Results are computed by code (counts, expiry
status from the clock, "is X listed?" as a definite yes/no), then rendered as
one fact per line for both the answering model and the verifier.

`POST /api/chat` returns `{ reply, cached, kind, sources, suggestions }`:
`kind` is `answer`, `redirect`, `refusal`, `decline` or `unverified`; `sources`
are fixed labels of the lookups that ran; `suggestions` are follow-up questions
chosen by code from the topics not yet covered. Only `answer` turns are
remembered in the session. A cheap regex still rejects blatant phrases such as
"ignore all previous instructions" before any model is called; everything else
is judged by the models. Try the real models on the golden cases with
`npm run eval:live -- guard|plan|verify|e2e` (spends API tokens). Each turn logs
one JSON line (kind, mode, tools, timing, never message text) for Vercel logs.

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

### Live resume

| Variable               | Required | Description                                                                  |
| ---------------------- | -------- | ---------------------------------------------------------------------------- |
| `RESUME_DOC_URL`       | no       | Published-to-web link of the resume Google Doc (`.../document/d/e/<id>/pub`). |
| `RESUME_CACHE_SECONDS` | no       | How long a fetched copy is reused (default `3600`).                          |

Google Doc → **File → Share → Publish to web → Document → Publish**, then copy
the link. Only `docs.google.com` published links are accepted. If the doc can't
be fetched the assistant uses the last good copy, or says the resume is
unavailable; it never guesses. Set the variable in Vercel too.

### Resume download

| Variable             | Required | Description                                                                 |
| -------------------- | -------- | --------------------------------------------------------------------------- |
| `RESUME_PDF_DOC_URL` | no       | The resume Google Doc's normal share link (`.../document/d/<id>/edit`). Enables the download. |

The "Publish to web" link above can't be exported, so the download needs the
document's normal link, and the doc must be shared as **Anyone with the link →
Viewer**. Visitors (and the assistant) only ever see `https://<your-site>/resume.pdf`;
that route redirects to Google's PDF export of the doc, so it is always the
latest version. The target is rebuilt from the validated document id, never from
the request, so it can't be used as an open redirect; the route is rate limited
(20/minute per IP). Without the variable, the assistant says the download isn't
set up and offers no link.

> **Privacy:** the PDF is the document itself, so it contains whatever is in the
> doc, including your phone number (the chat redacts it from the text the model
> sees, but not from the PDF). If you don't want it public, point
> `RESUME_PDF_DOC_URL` at a copy of the resume without it.

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

- **Website content** (name, skills, projects, experience, certifications,
  contact): edit `public/js/data.js` only — the page renders from it.
- **Project cards** are rendered from `public/data/projects.json` when present
  (kept up to date by the n8n automation in [`automation/`](automation/)), and
  fall back to `public/js/data.js` if that file is missing or invalid.
- **What the chat assistant knows** is separate from the website:
  - **Resume** — edit your Google Doc; the assistant picks it up within an hour
    (`RESUME_CACHE_SECONDS`), no redeploy. It is the source of truth for current
    role, experience, skills and certifications. Phone numbers in the doc are
    redacted before the model sees it.
  - **`kb/kb.json`** — everything not in the resume: profile basics, education,
    certification details and verify links, quick facts, project details, and the
    LinkedIn snapshot. Each entry has an `id`, `source` and `updated` date.
  - The system prompt includes both, so it is part of the cache key: editing
    either one invalidates cached replies automatically.

### Keeping the knowledge base current

| What changed | What to do | Effort |
| --- | --- | --- |
| Resume (role, skills, certs) | Edit the Google Doc. | Live, nothing else |
| New certification / job / skill on LinkedIn | Download LinkedIn's **Basic** data export, extract it, run `npm run kb:linkedin -- "<folder>"`, review `git diff kb/kb.json`, commit. | About 2 min |
| New or changed GitHub repo | `npm run kb:sync` (add `-- --dry` to preview). | 1 command |
| "Is anything out of date?" | `npm run kb:check` — flags a LinkedIn snapshot older than 90 days and any difference between the live resume and the KB's certifications. | 1 command |

LinkedIn cannot be read automatically (its API exposes only name/headline to an
app like this, and scraping is against its terms), so the export is the
supported path. The importer opens only `Profile`, `Positions`, `Education`,
`Skills` and `Certifications` and only named columns; connections, messages,
phone numbers, e-mail, birth date, address and zip code are never read. Choices
that must survive re-imports (certifications to leave out, exam codes, company
display names) live in `scripts/linkedin.config.json`; hand-set `verifyUrl` and
`code` values in `kb.json` are kept. Re-importing an unchanged export changes
nothing.

---

## Project structure

```
server.js              Express app: static hosting + POST /api/chat
lib/
  agent.js             One chat turn: cache -> guard -> plan -> tools -> answer -> verify -> reply
  planner.js           Picks tools + arguments as validated JSON (never throws)
  tools/               Read-only tools, one file each + registry (index.js), schema.js, render.js
  guard.js             LLM input guard (+ Prompt Guard), fail-closed, verdict cache
  verify.js            Answer verifier: grounding + LLM check, single pass or excerpt + full
  grounding.js         Deterministic checks: links, e-mails, phones, numbers, years
  messages.js          Fixed redirect / refusal / decline / "can't confirm" replies
  llm.js               Provider abstraction + per-stage models, retries, deadlines
  knowledge.js         Prompts: lean lookup prompt + full-context fallback prompt
  kb.js                Loads/validates kb/kb.json and renders it as prompt text
  kb-build.js          README cleaning + repo-link helpers for the KB sync
  kb-check.js          Drift check: KB vs live resume, snapshot staleness
  linkedin-import.js   LinkedIn export -> kb.json (allow-listed files/columns only)
  csv.js               Dependency-free CSV parser
  text.js              Shared text cleaning + phone redaction
  sources/resume.js    Live resume: published Google Doc -> text (cached, safe)
  sources/resume-download.js  Validates the doc link and builds the /resume.pdf redirect target
  sources/resume-sections.js  Splits the resume text into sections for the tools
  guards.js            sanitize / blatant-injection pre-filter / in-memory limiter (fallback)
  cache.js             Response cache (in-memory LRU + optional Upstash Redis)
  redis.js             Shared Upstash Redis client (null when unconfigured)
  session.js           Server-owned chat sessions (cookie id, Redis memory, lock)
  ratelimit.js         Redis rate limits with hashed IPs + in-memory fallback
kb/kb.json             Assistant knowledge base (profile, education, facts, projects)
scripts/
  sync-kb-projects.js  `npm run kb:sync` — refresh kb.json projects from GitHub
  import-linkedin.js   `npm run kb:linkedin` — import a LinkedIn export
  linkedin.config.json Import decisions that survive re-imports
  check-kb.js          `npm run kb:check` — staleness / drift report
  eval-live.js         `npm run eval:live` — real-model evaluation of guard / verifier / pipeline
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
test/                  node:test suites (+ helpers/llm-stub.js, golden/*.json eval cases)
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
- Free LLM tiers have per-minute token limits (Groq: ~8,000 tokens/min per
  model). Each stage runs on its own model, and the lookup prompt is small, so a
  typical answered turn costs roughly 0.4k (guard) + 0.9k (planner), both on the
  Qwen bucket, ~1.3–2k on the answer model and ~1–1.5k on the verifier. That fits
  about 4 answered turns per minute across ALL visitors on the free tier (the
  context-mode fallback is ~3.5k on the answer model, about 2 per minute). The app
  surfaces provider `429`s as a friendly "busy, try again" message; a paid Groq
  tier removes the limit.
- Vercel Hobby with Fluid compute allows 300 s per request; a chat turn runs a few
  seconds, and `CHAT_BUDGET_MS` (default 25 s) caps the pipeline and skips the
  regeneration when time is short.