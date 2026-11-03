const test = require("node:test");
const assert = require("node:assert");

// Force the in-memory fallbacks regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.RESUME_DOC_URL = "";
process.env.RESUME_PDF_DOC_URL = "";

const { installLlmStub } = require("./helpers/llm-stub");
const { FAKE_PUBLISH_URL, FAKE_DOC_ID, FAKE_DOWNLOAD_URL } = require("./helpers/fixtures");
const MARK_VISITOR = "ZZ-UNIQUE-VISITOR-TEXT-424242";
const MARK_REPLY = "QQ-UNIQUE-REPLY-TEXT-717171";
const stub = installLlmStub({ reply: `He works at LTIMindtree. ${MARK_REPLY}` });
const { LLMError } = require("../lib/llm");
const health = require("../lib/health");
const rateLimit = require("../lib/ratelimit");
const app = require("../server");

let server;
let base;
let ipCounter = 0;
const nextIp = () => `10.3.0.${++ipCounter}`;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function post(message) {
  const ip = nextIp();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ message }),
  });
  return { status: res.status, json: await res.json(), ip };
}

/** Capture console.<level> output as parsed JSON lines while `fn` runs. */
async function capture(level, fn) {
  const original = console[level];
  const lines = [];
  console[level] = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console[level] = original;
  }
  return lines;
}

/* ---- the per-turn log line ---- */
test("each answered turn logs ONE structured line with stage latency and usage, and no content", async () => {
  stub.reset();
  const ip = { value: null };
  const lines = await capture("info", async () => {
    const r = await post(`${MARK_VISITOR} where does he work?`);
    ip.value = r.ip;
    assert.equal(r.status, 200);
  });
  const chat = lines.filter((l) => l.includes('"evt":"chat"'));
  assert.equal(chat.length, 1);

  const entry = JSON.parse(chat[0]);
  assert.equal(entry.evt, "chat");
  assert.equal(entry.kind, "answer");
  assert.equal(entry.cached, false);
  assert.equal(entry.mode, "lookup");
  assert.equal(entry.guard, "allow");
  assert.deepEqual(entry.tools, []);
  assert.equal(typeof entry.ms, "number");
  for (const stage of ["cache", "guard", "plan", "tools", "answer", "verify"]) {
    assert.equal(typeof entry.stages[stage], "number", `stage ${stage}`);
    assert.ok(entry.stages[stage] >= 0 && entry.stages[stage] <= entry.ms);
  }
  assert.equal(typeof entry.calls, "number");
  assert.deepEqual(Object.keys(entry.tokens).sort(), ["in", "out"]);

  assert.ok(!chat[0].includes(MARK_VISITOR), "the visitor's message is never logged");
  assert.ok(!chat[0].includes(MARK_REPLY), "the reply is never logged");
  assert.ok(!chat[0].includes(ip.value), "the IP is never logged");
  assert.ok(!/sid=|cookie/i.test(chat[0]), "no session identifiers");
});

test("cached turns are logged as cached, with no model stages", async () => {
  stub.reset();
  const message = `cache-log-probe ${Date.now()}`;
  const ip = nextIp();
  const send = () => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ message }) });
  await (await send()).json();
  const lines = await capture("info", async () => {
    await (await send()).json();
  });
  const entry = JSON.parse(lines.find((l) => l.includes('"evt":"chat"')));
  assert.equal(entry.cached, true);
  assert.equal(entry.stages.guard, undefined);
  assert.equal(entry.stages.answer, undefined);
});

test("blocked turns are logged by outcome only", async () => {
  stub.reset();
  stub.guard = () => ({ verdict: "off_topic", reason: "x" });
  const lines = await capture("info", async () => {
    await post(`${MARK_VISITOR} write me a poem`);
  });
  stub.guard = () => ({ verdict: "allow", reason: "ok" });
  const entry = JSON.parse(lines.find((l) => l.includes('"evt":"chat"')));
  assert.equal(entry.kind, "redirect");
  assert.equal(entry.guard, "off_topic");
  assert.equal(entry.mode, null);
  assert.ok(!JSON.stringify(entry).includes(MARK_VISITOR));
});

test("errors are logged as a structured line with status and class, never the visitor's text", async () => {
  const realReply = stub.reply;
  stub.reply = () => {
    throw new LLMError("The assistant is busy right now.", 429);
  };
  const lines = await capture("error", async () => {
    // Unique text: an identical earlier message would be served from the cache instead.
    const r = await post(`${MARK_VISITOR} error-probe ${Date.now()}`);
    assert.equal(r.status, 429);
  });
  stub.reply = realReply;
  const entry = JSON.parse(lines.find((l) => l.includes('"evt":"chat_error"')));
  assert.equal(entry.status, 429);
  assert.equal(entry.name, "LLMError");
  assert.ok(entry.message.length <= 160);
  assert.equal(entry.calls, 0, "usage before the failure is reported (the stub spends none)");
  assert.deepEqual(entry.tokens, { in: 0, out: 0 });
  assert.ok(!lines.join("\n").includes(MARK_VISITOR));
});

/* ---- health snapshot ---- */
test("snapshot reports readiness from booleans only", () => {
  const env = { LLM_API_KEY: "k" };
  const s = health.snapshot(env);
  assert.equal(s.ready, true);
  assert.deepEqual(s.checks, { llm: true, kb: true, redis: false, resume: false, download: false });
  assert.equal(s.kb.valid, true);
  assert.match(s.kb.version, /^[0-9a-f]{12}$/);
  assert.match(s.kb.updated, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(health.snapshot({}).ready, false, "no LLM key => not ready");
  assert.equal(health.snapshot({}).checks.llm, false);
  assert.equal(health.snapshot({ LLM_API_KEY: "k", LLM_PROVIDER: "bogus" }).checks.llm, false, "unsupported provider => not ready");
});

test("optional features show up as configured only when their links are valid", () => {
  const s = health.snapshot({ LLM_API_KEY: "k", RESUME_DOC_URL: FAKE_PUBLISH_URL, RESUME_PDF_DOC_URL: FAKE_DOWNLOAD_URL });
  assert.equal(s.checks.resume, true);
  assert.equal(s.checks.download, true);
  const bad = health.snapshot({ LLM_API_KEY: "k", RESUME_DOC_URL: "https://evil.example.com/x", RESUME_PDF_DOC_URL: FAKE_PUBLISH_URL });
  assert.equal(bad.checks.resume, false);
  assert.equal(bad.checks.download, false, "the publish-to-web form cannot be exported");
  assert.equal(bad.ready, true, "optional features never make the assistant unavailable");
});

/* ---- GET /api/health ---- */
test("GET /api/health is 200 when ready, never exposes values, and is not cacheable", async () => {
  process.env.LLM_API_KEY = "SECRET-KEY-VALUE-DO-NOT-LEAK";
  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  process.env.RESUME_PDF_DOC_URL = FAKE_DOWNLOAD_URL;
  try {
    const res = await fetch(`${base}/api/health`, { headers: { "X-Forwarded-For": nextIp() } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = JSON.parse(text);
    assert.equal(body.status, "ok");
    assert.equal(body.ready, true);
    assert.equal(body.checks.resume, true);
    assert.equal(body.checks.download, true);
    for (const secret of ["SECRET-KEY-VALUE", FAKE_DOC_ID, "docs.google.com", "2PACX", "gsk_", "UPSTASH"]) {
      assert.ok(!text.includes(secret), `health must not expose "${secret}"`);
    }
  } finally {
    process.env.RESUME_DOC_URL = "";
    process.env.RESUME_PDF_DOC_URL = "";
  }
});

test("GET /api/health is 503 (so monitors alert) when the assistant cannot answer", async () => {
  const saved = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    const res = await fetch(`${base}/api/health`, { headers: { "X-Forwarded-For": nextIp() } });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "unavailable");
    assert.equal(body.checks.llm, false);
  } finally {
    if (saved !== undefined) process.env.LLM_API_KEY = saved;
  }
});

test("GET /api/health never touches Redis (a slow or dead Redis must not delay a monitor)", async () => {
  process.env.LLM_API_KEY = "k";
  const realCheck = rateLimit.check;
  rateLimit.check = async () => {
    throw new Error("health must not use the Redis-backed limiter");
  };
  try {
    const res = await fetch(`${base}/api/health`, { headers: { "X-Forwarded-For": nextIp() } });
    assert.equal(res.status, 200);
  } finally {
    rateLimit.check = realCheck;
  }
});

test("GET /api/health is rate limited", async () => {
  process.env.LLM_API_KEY = "k";
  const ip = nextIp();
  let last;
  for (let i = 0; i < 61; i++) last = await fetch(`${base}/api/health`, { headers: { "X-Forwarded-For": ip } });
  assert.equal(last.status, 429);
});
