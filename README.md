# Atharva Jadhav — Portfolio + AI Recruiter Chat

A personal portfolio website with an **"Ask about me"** AI assistant that lets
recruiters ask questions and get answers grounded in the portfolio content.

- **Frontend:** vanilla HTML/CSS/JS (no build step). The page renders from the same
  content record as the assistant (`kb/kb.json`), which the server inlines into the
  page; headings and layout live in `public/js/layout.js`.
- **Backend:** small Node.js/Express app exposing `POST /api/chat` and the site
  content (`GET /` and `GET /data/site.json`).
- **AI:** the assistant answers from the same knowledge base (`kb/kb.json`), which
  is its confirmed record, plus your **live resume** (a published Google Doc) and a
  LinkedIn snapshot as supporting detail, through a swappable LLM provider. The
  website and the assistant read the same record, so they cannot disagree.
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

**No setting lives in a code file.** The code only reads them from the process
environment (for example `process.env.RESUME_DOC_URL` in
[`lib/sources/resume.js`](lib/sources/resume.js) and `RESUME_PDF_DOC_URL` in
[`lib/sources/resume-download.js`](lib/sources/resume-download.js)). You provide
the values in two places:

| Where | How |
| --- | --- |
| **Local development** | Put them in `.env` (gitignored). Copy `.env.example` for the full list. |
| **Production (Vercel)** | **Project → Settings → Environment Variables**, then **redeploy** (Vercel only injects variables into new deployments). |

After changing either, run `npm run check:env -- --live` (see
[Testing & operations](#testing--operations)): it tells you which settings are
missing or wrong, and whether the models, Redis, the resume doc and the PDF export
actually work, without printing any secret.

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
is judged by the models. Each turn logs one JSON line (see
[Testing & operations](#testing--operations)); test the real models with
`npm run eval:live`.

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

**One content record feeds both the website and the assistant.** Edit
`kb/kb.json` and both change together; nothing about you is typed into the page
itself. Each request, the server projects the record into exactly what the page
needs (`lib/site-content.js`, a whitelist: quick facts, the LinkedIn snapshot and
README excerpts never leave the server, and any phone number is redacted) and
inlines it in the page template (`views/index.html`). The same
object is served at `GET /data/site.json`. Redeploy after editing the file.

| `kb.json` section | Holds | Rules (enforced when the file loads) |
| --- | --- | --- |
| `profile` | name, headline, `tagline` (hero subtitle), location, e-mail, GitHub, LinkedIn, site URL | one place for contact details: the contact buttons are built from it |
| `about` | the about paragraphs | plain text; `**bold**` is the only markup |
| `experience` | roles, `Mon YYYY` dates (`ended: null` = current), optional `engagement` (project + start), bullet points | newest first; no end before start |
| `skills` | name, optional `icon`, optional `level` | a `level` is the **owner's own rating** (the assistant presents it as self-rated), so only `source: "owner"` entries carry one |
| `education`, `credentials`, `facts` | degrees and scores; certifications with verify links (optional `icon`); short statements the assistant may repeat (`facts` stay server-side) | certificate validity and order come from `lib/credentials.js`, which the assistant's tool uses too |
| `projects`, `linkedin` | GitHub details; the LinkedIn snapshot (both server-side only) | refreshed by `kb:sync` / `kb:linkedin`, which never touch the other sections |

The stats on the About section (certifications, projects, skills, months of
experience) are **counted from this data** (overlapping roles are not counted
twice), so they can't go out of date;
`public/js/layout.js` only chooses which to show. Everything the site renders is
plain text (no `<` or `>`) and icons must be Font Awesome 6 classes such as
`fab fa-python`, so a typo in `kb.json` can't inject markup. A malformed file
fails fast with a precise message (`npm test`, `npm run check:env`), and if the
content can't be loaded at all the page still opens and shows a notice instead of
a blank screen (`/api/health` reports the problem).

- **What the page says about you:** `kb/kb.json` (above).
- **Section headings, which stats and contact buttons to show:** `public/js/layout.js`.
  It holds no facts (a test fails if a name, link, skill, certificate or date is
  typed into it or any other file under `public/`).
- **Project cards** come from `public/data/projects.json` (kept up to date by the
  n8n automation in [`automation/`](automation/)): it decides which projects show,
  their order and icons. Each card is validated (https links only, bad items
  skipped), and if the file is missing or unusable the GitHub-synced projects in
  `kb.json` are used instead.
- **What the chat assistant knows** besides `kb.json`:
  - **Resume** and **LinkedIn snapshot** — supporting detail, never the authority.
    Edit your Google Doc and the assistant picks it up within an hour
    (`RESUME_CACHE_SECONDS`), no redeploy. It is what "summarise his resume" reads,
    and it adds skills and project lines that `kb.json` doesn't list. Phone numbers
    in the doc are redacted before the model sees it.
  - The system prompt includes `kb.json` and the resume, so both are part of the
    cache key: editing either one invalidates cached replies automatically.

#### Which source wins

| Question | Answered from | If another source disagrees |
| --- | --- | --- |
| Role, employer, dates, employment type, what he does | `kb.json` `experience` (+ `about`) | `kb.json` wins; the resume and LinkedIn are not even shown for these |
| Skills and levels | `kb.json` `skills` first, then resume / LinkedIn as "also listed" | `kb.json` wins; a level is always described as **his own rating**, never an assessment |
| Certifications, education, contact | `kb.json` | `kb.json` wins |
| Projects | the website's project cards (`projects.json`) merged with GitHub details | the card list wins; GitHub's canonical repo link replaces a stale one |
| "Summarise / read his resume" | the live resume document, shown together with his profile's current role and dates | it is a supporting document: where it differs from `kb.json`, `kb.json` is correct |

So a visitor never sees the site say one thing and the assistant another. When the
resume or LinkedIn disagrees with `kb.json`, `npm run kb:check` tells you, and you
decide which is right and update it.

### Keeping the knowledge base current

| What changed | What to do | Effort |
| --- | --- | --- |
| Resume (extra skills, project lines, what "summarise his resume" shows) | Edit the Google Doc. Role, dates, skills and certifications that visitors see come from `kb.json`, not the resume. | Live, nothing else |
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
server.js              Express app: the page (content inlined), /data/site.json, POST /api/chat, health, /resume.pdf
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
  kb.js                Loads/validates kb/kb.json, merges in the live project cards, renders it as prompt text
  site-content.js      kb.json -> what the page needs (whitelist) + safe inlining into the page template
  projects.js          Project cards: validates public/data/projects.json, falls back to kb.json
  icons.js             The one accepted Font Awesome class shape
  credentials.js       Certificate validity + ordering, shared by the page and the assistant's tool
  kb-build.js          README cleaning + repo-link helpers for the KB sync
  kb-check.js          Drift check: KB vs live resume, snapshot staleness
  linkedin-import.js   LinkedIn export -> kb.json (allow-listed files/columns only)
  csv.js               Dependency-free CSV parser
  text.js              Shared text cleaning + phone redaction
  sources/resume.js    Live resume: published Google Doc -> text (cached, safe)
  sources/resume-download.js  Validates the doc link and builds the /resume.pdf redirect target
  sources/resume-sections.js  Splits the resume text into sections for the tools
  guards.js            sanitize / blatant-injection pre-filter / in-memory limiter (fallback)
  health.js            Config readiness snapshot (booleans only) for /api/health
  env-check.js         Deploy-readiness checks (static + live) behind `npm run check:env`
  cache.js             Response cache (in-memory LRU + optional Upstash Redis)
  redis.js             Shared Upstash Redis client (null when unconfigured)
  session.js           Server-owned chat sessions (cookie id, Redis memory, lock)
  ratelimit.js         Redis rate limits with hashed IPs + in-memory fallback
kb/kb.json             Canonical content record (profile, about, experience, skills, education, credentials, facts, projects, LinkedIn)
views/index.html       Page template. Deliberately NOT under public/, so no URL can serve it unprocessed
scripts/
  sync-kb-projects.js  `npm run kb:sync` — refresh kb.json projects from GitHub
  import-linkedin.js   `npm run kb:linkedin` — import a LinkedIn export
  linkedin.config.json Import decisions that survive re-imports
  check-kb.js          `npm run kb:check` — staleness / drift report
  check-env.js         `npm run check:env [-- --live]` — is the configuration ready to deploy?
  eval-live.js         `npm run eval:live` — real-model evaluation with release gates
public/
  css/{style,chat}.css
  js/
    config.js          Shared limits (server + client)
    util.js            Shared escapeHtml / safeUrl / boldText / splitName
    layout.js          Section headings and layout choices (no facts)
    render.js          Renders the page from the inlined site content
    script.js          Portfolio interactions/animations
    chat.js            "Ask about me" chat overlay (+ cached badge)
  data/
    projects.json      Project cards (auto-generated by the n8n automation)
automation/            n8n workflow + launcher that syncs project cards from GitHub
test/                  node:test suites (+ helpers/ stub + fixtures, golden/*.json cases)
.github/workflows/     ci.yml (offline tests on push/PR) and eval.yml (live model evaluation)
vercel.json            Vercel routing
```

---

## Testing & operations

### What runs where

| Command | Needs keys? | What it checks |
| --- | --- | --- |
| `npm test` | no | ~400 offline tests: units, integration against a fake Upstash, the **golden set**, the failure matrix, observability, the site content and the front end (rendering and XSS safety). All model calls are stubbed. Runs on every push/PR in CI (Node 20 and 22). |
| `npm run check:env` | no | Environment variables and `kb.json`: what is missing or malformed. |
| `npm run check:env -- --live` | yes | Also the real services: key accepted, every configured model still available (catches a **retired model**), Redis reachable, the resume doc fetchable and its sections found, the PDF export returning a real PDF, drift between the resume and `kb.json`. It always downloads the doc fresh (never the app's cached copy) and has no side effects. |
| `npm run eval:live` | yes | The golden cases against the **real models** (about 15–20 min, paced for free-tier limits) with release gates. Also a manual/weekly GitHub workflow. |

### The golden set (`test/golden/`)

| File | Measures |
| --- | --- |
| `guard-cases.json` | Input guard: allow / off-topic / injection / unsafe (incl. follow-ups and look-alike phrases like "ignore my last question"). |
| `plan-cases.json` | **Tool selection**: which lookups a message needs, incl. follow-ups and "no tool". |
| `retrieval-cases.json` | **Retrieval quality**: for each tool, the facts its output must contain and must not contain. Runs offline on every `npm test`. |
| `verify-cases.json` | **Answer accuracy**: supported answers vs invented certifications, employers, seniority, links, grades, dates, and capabilities. |
| `e2e-cases.json` | The whole pipeline on real questions (answer / redirect / refusal / decline; no phone leak). |
| `conversation-cases.json` | **Continuity**: follow-ups, an off-topic turn and an injection turn in the middle of a chat, then recovery. |
| `poison-cases.json` | **Indirect injection**: instructions hidden inside the resume document must not be obeyed. Each case must make the pipeline actually read the resume, or it fails as vacuous. |

`test/golden.test.js` keeps the set honest on every run: well-formed files, every
tool covered by retrieval and planning cases, the free regex pre-filter never
blocks a legitimate message, and no supported answer is wrongly rejected by the
deterministic grounding layer. The live evaluator uses a **fixed fixture resume**
(`test/helpers/fixtures.js`) so results never depend on today's Google Doc; add
`--live-resume` to use the real one.

### Release gates (`npm run eval:live`, exit code 1 if any fails)

1. Every case marked *critical* passes: injection/unsafe recall, rejecting every
   hallucinated answer, no phone-number leak, resisting the poisoned document.
2. Each suite passes at least 90% of its cases.
3. p95 latency of an answered turn is at most 12 s. It is measured on the
   successful attempt only: when the free tier answers 429/503, the evaluator
   waits 25 s and retries once, and that wait is not counted as latency.
4. Average tokens per answered turn (all stages) are at most 7,000.

The evaluator is hermetic: it clears the Upstash settings first (so it can never
touch the production resume copy or rate-limit counters), disables the response
cache, and uses the fixture resume. Run it before a deploy and after changing a
prompt, a model or a tool. Options: `npm run eval:live -- guard plan` (only some
suites), `-- --report eval-report.json` (JSON report, git-ignored; the weekly
workflow uploads it as an artifact), `-- --live-resume` (use the real document;
the poison suite is skipped because it needs the poisoned fixture).

A full run is large: every answer is checked by the verifier model, so it uses most
of Groq's free-tier allowance for `openai/gpt-oss-120b` (200,000 tokens per day,
about 8,000 per minute). Run the suites you changed, not everything, and don't
repeat a full run within a day. When the allowance is gone, the evaluator stops
with a "rate limit" error instead of reporting false failures.

### CI (GitHub Actions)

- **`ci.yml`**: `npm test` on Node 20 and 22 for every push and pull request.
  Offline, no secrets, so forks work.
- **`eval.yml`**: the live evaluation, **manual or Mondays 05:00 UTC** (catches
  retired models and provider drift). Needs a repository secret `LLM_API_KEY`
  (and optionally `LLM_MODEL`, `GUARD_MODEL`, `PLAN_MODEL`, `VERIFY_MODEL`). It never
  runs on pull requests, so a fork can't reach the secret.

### Monitoring in production

- **Logs (Vercel → Logs).** Every chat turn writes one JSON line and **never the
  visitor's message, the reply, an IP address or a session id**:

  ```json
  {"evt":"chat","kind":"answer","cached":false,"mode":"lookup","guard":"allow",
   "tools":["get_certifications"],"regenerated":false,"ms":2310,
   "stages":{"cache":1,"guard":182,"plan":205,"tools":2,"answer":1140,"verify":690},
   "calls":4,"tokens":{"in":3120,"out":410}}
  ```

  Other events: `chat_error` (status + error class), `request_error`, `resume_download`,
  `health_error`. Things worth watching: the share of `kind` = `unverified`
  (answers rejected as ungrounded), `mode` = `context` (planner fallback, costs more
  tokens), `regenerated` = true, `cached` hit rate, `chat_error` with status 429/503
  (provider limits or safety checks down), and `ms`/`tokens` trends.
- **Health check.** `GET /api/health` returns `200` when the assistant can answer
  and `503` when it can't (missing LLM key or invalid `kb.json`). The body holds
  booleans only (`checks.llm|kb|redis|resume|download`) plus the KB version and
  date; it never returns a key, a URL or a document id. Point an uptime monitor
    (UptimeRobot, Better Stack, Vercel checks) at it. It makes no network or Redis
    calls (its own small rate limit is in-memory), so polling it costs nothing.
- **Errors never leak internals.** Provider error text, stack traces and paths are
  logged server-side only; visitors get a short generic message (a JSON error
  handler also covers malformed or oversized request bodies).

---

## Deployment (Vercel)

1. Run `npm run check:env -- --live` with the production values in a temporary
   `.env` (copy them from Vercel; delete the file afterwards) and fix any `FAIL`.
2. Push to the connected Git repo (Vercel auto-deploys); CI runs the tests.
3. In **Vercel → Settings → Environment Variables** set at least `LLM_API_KEY`, and
   for the full experience `RESUME_DOC_URL`, `RESUME_PDF_DOC_URL`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `RATE_LIMIT_SALT`.
4. Redeploy so the variables take effect (Vercel only injects env vars into
   new deployments), then check `https://<your-site>/api/health` and `/resume.pdf`.

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