/* =====================================================================
   DEPLOY READINESS CHECKS — "is my configuration right before I push?"
   ---------------------------------------------------------------------
   staticChecks(): looks only at environment variables and kb.json.
   liveChecks():   talks to the real services (model list, Redis, the resume
                   doc, the PDF export) so a retired model, a wrong share
                   setting or an unreachable doc is found BEFORE a visitor
                   hits it.

   Every row is { level: "ok"|"warn"|"fail"|"info", name, detail }.
   Secrets are never printed: keys, tokens, document ids and URLs are
   reported only as "set", "valid" or "invalid".
   ===================================================================== */

const kb = require("./kb");
const llm = require("./llm");
const download = require("./sources/resume-download");
const resumeSource = require("./sources/resume");
const { splitSections } = require("./sources/resume-sections");
const { getRedis } = require("./redis");
const { checkKb } = require("./kb-check");

const row = (level, name, detail) => ({ level, name, detail });
const STAGES = ["main", "guard", "plan", "verify", "promptguard"];
const MODEL_ENV = { main: "LLM_MODEL", guard: "GUARD_MODEL", plan: "PLAN_MODEL", verify: "VERIFY_MODEL", promptguard: "PROMPT_GUARD_MODEL" };
const looksLikePublishLink = (v) => /\/document\/d\/e\//.test(v) || /^2PACX/.test(v.trim());

/** @param {NodeJS.ProcessEnv} [env] */
function staticChecks(env = process.env) {
  const rows = [];
  const provider = (env.LLM_PROVIDER || "groq").toLowerCase();

  /* ---- LLM ---- */
  if (!["groq", "mistral", "gemini"].includes(provider)) {
    rows.push(row("fail", "LLM_PROVIDER", `"${provider}" is not supported (use groq, mistral or gemini)`));
  } else {
    rows.push(row("ok", "LLM_PROVIDER", provider));
  }
  rows.push(env.LLM_API_KEY ? row("ok", "LLM_API_KEY", "set (value hidden)") : row("fail", "LLM_API_KEY", "missing — the assistant cannot answer without it"));
  for (const stage of STAGES) rows.push(row("info", `model:${stage}`, llm.resolveModel(stage, provider) || "disabled"));

  /* ---- knowledge base ---- */
  let data = null;
  try {
    data = kb.load();
    rows.push(row("ok", "kb/kb.json", `valid (version ${kb.version(data)}, updated ${data.updated})`));
    for (const f of checkKb({ kb: data, resumeText: "" })) {
      if (f.level === "warn") rows.push(row("warn", "kb/kb.json", f.message));
    }
  } catch (err) {
    rows.push(row("fail", "kb/kb.json", String(err.message).split("\n").slice(0, 3).join(" ")));
  }

  /* ---- live resume (text) ---- */
  const resumeUrl = env.RESUME_DOC_URL;
  if (!resumeUrl) {
    rows.push(row("warn", "RESUME_DOC_URL", "not set — the assistant will answer from kb.json only and say the live resume is unavailable"));
  } else if (!resumeSource.parseResumeUrl(resumeUrl)) {
    rows.push(row("fail", "RESUME_DOC_URL", "invalid — it must be the Publish-to-web link: https://docs.google.com/document/d/e/<id>/pub"));
  } else {
    rows.push(row("ok", "RESUME_DOC_URL", "valid Publish-to-web link"));
  }

  /* ---- resume download (PDF) ---- */
  const pdfUrl = env.RESUME_PDF_DOC_URL;
  if (!pdfUrl) {
    rows.push(row("warn", "RESUME_PDF_DOC_URL", "not set — the download tool and /resume.pdf are disabled (set it to the doc's normal share link)"));
  } else if (looksLikePublishLink(pdfUrl)) {
    rows.push(row("fail", "RESUME_PDF_DOC_URL", "this is a Publish-to-web link, which cannot be exported — use the normal link: https://docs.google.com/document/d/<id>/edit"));
  } else if (!download.exportUrl(env)) {
    rows.push(row("fail", "RESUME_PDF_DOC_URL", "invalid — expected https://docs.google.com/document/d/<id>/edit"));
  } else if (data && !data.profile.website) {
    rows.push(row("fail", "RESUME_PDF_DOC_URL", "valid, but kb.json profile.website is empty, so there is no site to host the /resume.pdf link on"));
  } else {
    rows.push(row("ok", "RESUME_PDF_DOC_URL", "valid share link (PDF export enabled)"));
  }

  /* ---- shared state ---- */
  const hasUrl = !!env.UPSTASH_REDIS_REST_URL;
  const hasToken = !!env.UPSTASH_REDIS_REST_TOKEN;
  if (hasUrl && hasToken) rows.push(row("ok", "Upstash Redis", "URL and token set"));
  else if (hasUrl || hasToken) rows.push(row("fail", "Upstash Redis", "only one of UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN is set — both are required"));
  else rows.push(row("warn", "Upstash Redis", "not set — sessions, rate limits and the cache fall back to per-instance memory (resets on every cold start)"));

  rows.push(env.RATE_LIMIT_SALT ? row("ok", "RATE_LIMIT_SALT", "set (value hidden)") : row("warn", "RATE_LIMIT_SALT", "not set — client IPs are hashed with a built-in salt; set a secret value for better privacy"));
  return rows;
}

/* ---------------------------------------------------------------------
   Live checks
--------------------------------------------------------------------- */
async function checkModels(env, fetchImpl) {
  const provider = (env.LLM_PROVIDER || "groq").toLowerCase();
  if (!env.LLM_API_KEY) return [row("fail", "LLM (live)", "skipped: no LLM_API_KEY")];
  if (provider !== "groq") return [row("info", "LLM (live)", `model availability is only checked for groq (provider is ${provider})`)];

  let res;
  try {
    res = await fetchImpl("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${env.LLM_API_KEY}` }, signal: AbortSignal.timeout(10000) });
  } catch {
    return [row("warn", "LLM (live)", "could not reach Groq to verify the key and models")];
  }
  if (res.status === 401 || res.status === 403) return [row("fail", "LLM_API_KEY", "rejected by Groq (revoked or wrong key)")];
  if (!res.ok) return [row("warn", "LLM (live)", `could not verify models (HTTP ${res.status})`)];

  const body = await res.json().catch(() => ({}));
  const available = new Set((body.data || []).filter((m) => m.active !== false).map((m) => m.id));
  const rows = [row("ok", "LLM_API_KEY", "accepted by Groq")];
  for (const stage of STAGES) {
    const model = llm.resolveModel(stage, provider);
    if (!model) continue;
    // Prompt Guard is an optional extra signal: the assistant keeps answering without it.
    const missing = stage === "promptguard" ? "warn" : "fail";
    const advice = stage === "promptguard" ? ` — optional: the assistant works without it; set ${MODEL_ENV[stage]} to a current model or "off"` : ` — set ${MODEL_ENV[stage]} to a current model`;
    rows.push(available.has(model) ? row("ok", `model:${stage}`, `${model} is available`) : row(missing, `model:${stage}`, `${model} is NOT available (retired?)${advice}`));
  }
  return rows;
}

async function checkRedis() {
  const redis = getRedis();
  if (!redis) return [];
  try {
    await redis.ping();
    return [row("ok", "Upstash Redis (live)", "reachable")];
  } catch {
    return [row("fail", "Upstash Redis (live)", "configured but not reachable — check the URL/token and the database region")];
  }
}

async function checkResume(env) {
  if (!resumeSource.parseResumeUrl(env.RESUME_DOC_URL)) return [];
  // probe() reads straight from Google: a cached or stale copy must never make this check pass.
  const r = await resumeSource.probe(env);
  if (!r.ok) return [row("fail", "Live resume (live)", `Google did not serve the document (${r.reason}) — is it still published to the web?`)];

  const rows = [row("ok", "Live resume (live)", `fetched ${r.text.length} characters directly from Google`)];
  const keys = Object.keys(splitSections(r.text).sections);
  for (const needed of ["experience", "skills", "certifications", "education"]) {
    if (!keys.includes(needed)) rows.push(row("warn", "Live resume (live)", `no "${needed}" section found — the tools for it will return nothing (headings need "## "-style structure from Google Docs headings)`));
  }
  try {
    for (const f of checkKb({ kb: kb.load(), resumeText: r.text })) if (f.level === "warn") rows.push(row("warn", "KB vs resume", f.message));
  } catch {
    /* an invalid kb.json is already reported by the static checks */
  }
  return rows;
}

async function checkDownload(env, fetchImpl) {
  const url = download.exportUrl(env);
  if (!url) return [];
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "portfolio-env-check" } });
  } catch {
    return [row("warn", "Resume PDF (live)", "could not reach Google to test the PDF export")];
  }
  if (!res.ok) {
    return [row("fail", "Resume PDF (live)", `Google returned HTTP ${res.status} — is the doc shared as "Anyone with the link: Viewer"?`)];
  }
  let head = "";
  try {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    head = Buffer.from(value || []).toString("latin1", 0, 8);
    await reader.cancel();
  } catch {
    /* treated as not-a-PDF below */
  }
  if (!head.startsWith("%PDF")) {
    return [row("fail", "Resume PDF (live)", `Google did not return a PDF (content-type ${res.headers.get("content-type") || "unknown"}) — usually the doc is not shared as "Anyone with the link: Viewer"`)];
  }
  return [row("ok", "Resume PDF (live)", "the export returns a real PDF")];
}

/** @param {NodeJS.ProcessEnv} [env] @param {{ fetchImpl?: typeof fetch }} [deps] */
async function liveChecks(env = process.env, { fetchImpl = fetch } = {}) {
  const groups = await Promise.all([checkModels(env, fetchImpl), checkRedis(), checkResume(env), checkDownload(env, fetchImpl)]);
  return groups.flat();
}

/** Process exit code for a list of rows: 1 if any check failed. */
const exitCode = (rows) => (rows.some((r) => r.level === "fail") ? 1 : 0);

module.exports = { staticChecks, liveChecks, exitCode, looksLikePublishLink };
