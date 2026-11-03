const test = require("node:test");
const assert = require("node:assert");

process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const { staticChecks, liveChecks, exitCode, looksLikePublishLink } = require("../lib/env-check");
const resume = require("../lib/sources/resume");
const { FAKE_PUBLISH_URL, FAKE_DOWNLOAD_URL, RESUME_TEXT, resumeHtml } = require("./helpers/fixtures");

const GOOD = { LLM_API_KEY: "SECRET-KEY-VALUE", RESUME_DOC_URL: FAKE_PUBLISH_URL, RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL, UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "SECRET-TOKEN", RATE_LIMIT_SALT: "SECRET-SALT" };
const by = (rows, name) => rows.find((r) => r.name === name);

for (const k of ["LLM_MODEL", "GUARD_MODEL", "PLAN_MODEL", "VERIFY_MODEL", "PROMPT_GUARD_MODEL", "LLM_PROVIDER"]) delete process.env[k];

/* ---- static ---- */
test("a complete configuration has no failures and no warnings", () => {
  const rows = staticChecks(GOOD);
  // The KB's snapshot-age warning depends on today's date, so it is excluded from this fixed-input check.
  const problems = rows.filter((r) => (r.level === "fail" || r.level === "warn") && r.name !== "kb/kb.json");
  assert.equal(problems.length, 0, JSON.stringify(problems));
  assert.equal(by(rows, "kb/kb.json").level === "fail", false);
  assert.equal(exitCode(rows.filter((r) => r.name !== "kb/kb.json" || r.level !== "warn")), 0);
  assert.match(by(rows, "kb/kb.json").detail, /valid \(version [0-9a-f]{12}|days old/);
  assert.equal(by(rows, "model:guard").detail, "qwen/qwen3.8-27b");
});

test("secrets, tokens and document ids are never printed", () => {
  const text = JSON.stringify(staticChecks(GOOD));
  for (const secret of ["SECRET-KEY-VALUE", "SECRET-TOKEN", "SECRET-SALT", "upstash.io", "2PACX", "1AbCdEfGhIj", "docs.google.com"]) {
    assert.ok(!text.includes(secret), `output must not contain "${secret}"`);
  }
});

test("a missing LLM key is a failure; a missing optional setting is only a warning", () => {
  const rows = staticChecks({ ...GOOD, LLM_API_KEY: "" });
  assert.equal(by(rows, "LLM_API_KEY").level, "fail");
  assert.equal(exitCode(rows), 1);

  const optional = staticChecks({ LLM_API_KEY: "k" });
  assert.equal(exitCode(optional), 0, "optional settings never block a deploy");
  for (const name of ["RESUME_DOC_URL", "RESUME_PDF_DOC_URL", "Upstash Redis", "RATE_LIMIT_SALT"]) assert.equal(by(optional, name).level, "warn", name);
});

test("an unsupported provider fails", () => {
  assert.equal(by(staticChecks({ ...GOOD, LLM_PROVIDER: "bogus" }), "LLM_PROVIDER").level, "fail");
});

test("RESUME_PDF_DOC_URL: the publish-to-web link is rejected with the exact fix", () => {
  for (const wrong of [FAKE_PUBLISH_URL, "2PACX-1vFixtureFixtureFixtureFixtureFixtureFixtureFixture12345"]) {
    const r = by(staticChecks({ ...GOOD, RESUME_PDF_DOC_URL: wrong }), "RESUME_PDF_DOC_URL");
    assert.equal(r.level, "fail");
    assert.match(r.detail, /cannot be exported/);
    assert.match(r.detail, /\/document\/d\/<id>\/edit/);
  }
  assert.equal(by(staticChecks({ ...GOOD, RESUME_PDF_DOC_URL: "https://evil.example.com/x" }), "RESUME_PDF_DOC_URL").level, "fail");
  assert.ok(looksLikePublishLink(FAKE_PUBLISH_URL));
  assert.ok(!looksLikePublishLink(FAKE_DOWNLOAD_URL));
});

test("RESUME_DOC_URL: a normal share link (not the publish form) is rejected", () => {
  const r = by(staticChecks({ ...GOOD, RESUME_DOC_URL: FAKE_DOWNLOAD_URL }), "RESUME_DOC_URL");
  assert.equal(r.level, "fail");
  assert.match(r.detail, /Publish-to-web/);
});

test("Upstash: half a configuration is a failure (it would silently fall back to memory)", () => {
  const r = by(staticChecks({ ...GOOD, UPSTASH_REDIS_REST_TOKEN: "" }), "Upstash Redis");
  assert.equal(r.level, "fail");
  assert.match(r.detail, /both are required/);
});

/* ---- live (with fakes) ---- */
const groqList = (ids) => new Response(JSON.stringify({ data: ids.map((id) => ({ id, active: true })) }), { status: 200 });
const ALL_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b", "openai/gpt-oss-120b", "meta-llama/llama-prompt-guard-2-86m"];

test("live: a healthy Groq account passes every stage", async () => {
  const rows = await liveChecks({ LLM_API_KEY: "k" }, { fetchImpl: async () => groqList(ALL_MODELS) });
  assert.equal(by(rows, "LLM_API_KEY").level, "ok");
  for (const stage of ["main", "guard", "plan", "verify", "promptguard"]) assert.equal(by(rows, `model:${stage}`).level, "ok", stage);
});

test("live: a retired model is a failure that names the variable to change", async () => {
  const rows = await liveChecks({ LLM_API_KEY: "k" }, { fetchImpl: async () => groqList(ALL_MODELS.filter((m) => m !== "qwen/qwen3.8-27b")) });
  assert.equal(by(rows, "model:guard").level, "fail");
  assert.match(by(rows, "model:guard").detail, /set GUARD_MODEL/);
  assert.match(by(rows, "model:plan").detail, /set PLAN_MODEL/);
  assert.equal(exitCode(rows), 1);
});

test("live: a retired Prompt Guard model is only a warning (the assistant works without it)", async () => {
  const rows = await liveChecks({ LLM_API_KEY: "k" }, { fetchImpl: async () => groqList(ALL_MODELS.filter((m) => !/prompt-guard/.test(m))) });
  const r = by(rows, "model:promptguard");
  assert.equal(r.level, "warn");
  assert.match(r.detail, /optional/);
  assert.equal(exitCode(rows), 0, "must not block a deploy");
});

test("live: a rejected key is a failure; an unreachable Groq is only a warning", async () => {
  assert.equal(by(await liveChecks({ LLM_API_KEY: "bad" }, { fetchImpl: async () => new Response("{}", { status: 401 }) }), "LLM_API_KEY").level, "fail");
  const down = await liveChecks({ LLM_API_KEY: "k" }, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(by(down, "LLM (live)").level, "warn");
  assert.equal(exitCode(down), 0);
});

const pdf = (body = "%PDF-1.7 fake", type = "application/pdf") => new Response(body, { status: 200, headers: { "content-type": type } });

test("live: a real PDF export passes", async () => {
  const rows = await liveChecks({ RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL }, { fetchImpl: async () => pdf() });
  assert.equal(by(rows, "Resume PDF (live)").level, "ok");
});

test("live: an HTML sign-in page instead of a PDF is a failure that explains the sharing setting", async () => {
  const rows = await liveChecks({ RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL }, { fetchImpl: async () => pdf("<html>Sign in</html>", "text/html") });
  const r = by(rows, "Resume PDF (live)");
  assert.equal(r.level, "fail");
  assert.match(r.detail, /Anyone with the link: Viewer/);
  assert.equal(by(await liveChecks({ RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL }, { fetchImpl: async () => new Response("no", { status: 404 }) }), "Resume PDF (live)").level, "fail");
});

test("live: the resume check reports structure and drift against kb.json", async () => {
  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  resume._reset();
  resume._setFetch(async () => new Response(resumeHtml(RESUME_TEXT), { status: 200, headers: { "content-type": "text/html" } }));
  try {
    const rows = await liveChecks({ RESUME_DOC_URL: FAKE_PUBLISH_URL }, { fetchImpl: async () => groqList(ALL_MODELS) });
    assert.equal(by(rows, "Live resume (live)").level, "ok");
    // The fixture resume lists only AZ-900, while kb.json holds four credentials: drift must be flagged.
    const drift = rows.filter((r) => r.name === "KB vs resume").map((r) => r.detail).join(" ");
    assert.match(drift, /AI-901|Azure AI Fundamentals|Claude/);
  } finally {
    resume._reset();
    delete process.env.RESUME_DOC_URL;
  }
});

test("live: a CACHED copy (memory or Redis) can never make the resume check pass: it asks Google directly", async () => {
  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  resume._reset();
  const html = () => new Response(resumeHtml(RESUME_TEXT), { status: 200, headers: { "content-type": "text/html" } });
  resume._setFetch(async () => html());
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await resume.get()).available, true, "the app now holds a fresh cached copy");

    let googleCalls = 0;
    resume._setFetch(async () => {
      googleCalls++;
      return new Response("gone", { status: 404 });
    });
    const rows = await liveChecks({ RESUME_DOC_URL: FAKE_PUBLISH_URL }, { fetchImpl: async () => groqList(ALL_MODELS) });
    const r = by(rows, "Live resume (live)");
    assert.equal(r.level, "fail", "the doc is gone, whatever the cache says");
    assert.match(r.detail, /HTTP 404/);
    assert.equal(googleCalls, 1, "Google was actually asked");
    assert.equal((await resume.get()).available, true, "and the app's own cached copy is untouched");
  } finally {
    console.warn = warn;
    resume._reset();
    delete process.env.RESUME_DOC_URL;
  }
});

test("live: an unreachable resume document is a failure", async () => {
  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  resume._reset();
  resume._setFetch(async () => new Response("gone", { status: 404 }));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const rows = await liveChecks({ RESUME_DOC_URL: FAKE_PUBLISH_URL }, { fetchImpl: async () => groqList(ALL_MODELS) });
    assert.equal(by(rows, "Live resume (live)").level, "fail");
  } finally {
    console.warn = warn;
    resume._reset();
    delete process.env.RESUME_DOC_URL;
  }
});

test("live checks print no secrets either", async () => {
  const rows = await liveChecks({ LLM_API_KEY: "SECRET-KEY-VALUE", RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL }, { fetchImpl: async () => pdf() });
  const text = JSON.stringify(rows);
  for (const secret of ["SECRET-KEY-VALUE", "1AbCdEfGhIj", "docs.google.com"]) assert.ok(!text.includes(secret), secret);
});
