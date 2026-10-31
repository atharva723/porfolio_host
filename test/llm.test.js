const test = require("node:test");
const assert = require("node:assert");

for (const k of ["LLM_MODEL", "GUARD_MODEL", "PLAN_MODEL", "VERIFY_MODEL", "PROMPT_GUARD_MODEL", "LLM_PROVIDER"]) delete process.env[k];
process.env.LLM_API_KEY = "test-key-not-real";

const llm = require("../lib/llm");

const realFetch = global.fetch;
let calls;
let script; // queue of responses/functions

const ok = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status, body = "{}", headers = {}) => new Response(body, { status, headers });

test.beforeEach(() => {
  calls = [];
  script = [];
  llm._setSleep(async () => {});
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    const next = script.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return typeof next === "function" ? next() : next;
  };
});
test.afterEach(() => {
  global.fetch = realFetch;
  for (const k of ["LLM_MODEL", "GUARD_MODEL", "PLAN_MODEL", "VERIFY_MODEL", "PROMPT_GUARD_MODEL"]) delete process.env[k];
});

const guardCall = (extra = {}) => llm.complete({ purpose: "guard", system: "S", messages: [{ role: "user", content: "hi" }], ...extra });

/* ---- model routing ---- */
test("each stage resolves to its own model by default (separate Groq rate-limit buckets)", () => {
  assert.equal(llm.resolveModel("main"), "openai/gpt-oss-20b");
  assert.equal(llm.resolveModel("guard"), "qwen/qwen3.8-27b");
  assert.equal(llm.resolveModel("plan"), "qwen/qwen3.8-27b");
  assert.equal(llm.resolveModel("verify"), "openai/gpt-oss-120b");
  assert.equal(llm.resolveModel("promptguard"), "meta-llama/llama-prompt-guard-2-86m");
  // guard + planner share a model on purpose; the others are all different buckets
  const models = new Set(["main", "guard", "verify", "promptguard"].map((p) => llm.resolveModel(p)));
  assert.equal(models.size, 4);
});

test("env overrides apply per stage and Prompt Guard can be switched off", () => {
  process.env.LLM_MODEL = "m-main";
  process.env.GUARD_MODEL = "m-guard";
  process.env.PLAN_MODEL = "m-plan";
  process.env.VERIFY_MODEL = "m-verify";
  assert.deepEqual(["main", "guard", "plan", "verify"].map((p) => llm.resolveModel(p)), ["m-main", "m-guard", "m-plan", "m-verify"]);
  process.env.PROMPT_GUARD_MODEL = "off";
  assert.equal(llm.resolveModel("promptguard"), null);
});

test("other providers use their main model for every stage and have no Prompt Guard", () => {
  assert.equal(llm.resolveModel("guard", "mistral"), "mistral-small-latest");
  assert.equal(llm.resolveModel("plan", "mistral"), "mistral-small-latest");
  assert.equal(llm.resolveModel("verify", "mistral"), "mistral-small-latest");
  assert.equal(llm.resolveModel("promptguard", "mistral"), null);
  assert.equal(llm.resolveModel("guard", "nonsense"), null);
});

test("cacheSignature is derived from the main model and never includes the key", () => {
  assert.match(llm.cacheSignature(), /^groq:openai\/gpt-oss-20b:0\.2:1024$/);
  assert.ok(!llm.cacheSignature().includes("test-key"));
});

/* ---- request shape ---- */
test("complete sends the stage model, a Bearer key, and low reasoning for gpt-oss classifiers only", async () => {
  process.env.VERIFY_MODEL = "openai/gpt-oss-120b";
  script.push(ok("{}"), ok("{}"), ok("0.1"));
  await llm.complete({ purpose: "verify", system: "S", messages: [{ role: "user", content: "x" }] });
  await guardCall(); // qwen
  await llm.complete({ purpose: "promptguard", messages: [{ role: "user", content: "x" }], maxTokens: 8 });

  assert.equal(calls[0].body.model, "openai/gpt-oss-120b");
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[1].body.model, "qwen/qwen3.8-27b");
  assert.equal(calls[1].body.reasoning_effort, undefined);
  assert.equal(calls[2].body.model, "meta-llama/llama-prompt-guard-2-86m");
  assert.equal(calls[2].body.max_tokens, 8);
  assert.equal(calls[0].headers.Authorization, "Bearer test-key-not-real");
  assert.deepEqual(calls[1].body.messages.map((m) => m.role), ["system", "user"]);
});

test("generateReply keeps the main model, sandwiches the reminder last, and does not force reasoning effort", async () => {
  script.push(ok("hello"));
  const out = await llm.generateReply("SYSTEM", [{ role: "user", content: "q" }], "REMINDER");
  assert.equal(out, "hello");
  assert.equal(calls[0].body.model, "openai/gpt-oss-20b");
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.deepEqual(calls[0].body.messages.map((m) => m.content), ["SYSTEM", "q", "REMINDER"]);
});

/* ---- resilience ---- */
test("a retired guard model falls back to the main model once instead of taking the chat down", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    script.push(fail(404, '{"error":{"code":"model_not_found"}}'), ok("fine"));
    assert.equal(await guardCall(), "fine");
    assert.deepEqual(calls.map((c) => c.body.model), ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
  } finally {
    console.warn = warn;
  }
});

test("Prompt Guard never falls back to the main model", async () => {
  script.push(fail(404, "{}"));
  await assert.rejects(llm.complete({ purpose: "promptguard", messages: [{ role: "user", content: "x" }] }), (e) => e.status === 502);
  assert.equal(calls.length, 1);
});

test("a 429 with a short Retry-After is retried once; the second 429 is surfaced", async () => {
  script.push(fail(429, "{}", { "retry-after": "2" }), ok("recovered"));
  assert.equal(await guardCall(), "recovered");
  assert.equal(calls.length, 2);

  calls.length = 0;
  script.push(fail(429, "{}", { "retry-after": "1" }), fail(429, "{}", { "retry-after": "1" }));
  await assert.rejects(guardCall(), (e) => e.status === 429 && /busy/i.test(e.message));
  assert.equal(calls.length, 2, "only one retry");
});

test("429s without Retry-After, or with a long one, are not retried", async () => {
  script.push(fail(429, "{}"));
  await assert.rejects(guardCall(), (e) => e.status === 429);
  script.push(fail(429, "{}", { "retry-after": "30" }));
  await assert.rejects(guardCall(), (e) => e.status === 429);
  assert.equal(calls.length, 2);
});

test("upstream error details are not exposed in the client-facing message path of 429/timeouts", async () => {
  script.push(fail(500, "SECRET-UPSTREAM-DETAIL"));
  await assert.rejects(guardCall(), (e) => e.status === 502 && !e.modelMissing);
});

test("an exhausted deadline fails fast without calling the provider", async () => {
  await assert.rejects(guardCall({ deadline: Date.now() + 100 }), (e) => e.status === 504);
  assert.equal(calls.length, 0);
});

test("missing key or unsupported provider fail with a clear configuration error", async () => {
  const key = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  await assert.rejects(guardCall(), (e) => e.status === 500 && /LLM_API_KEY/.test(e.message));
  process.env.LLM_API_KEY = key;
  process.env.LLM_PROVIDER = "bogus";
  await assert.rejects(guardCall(), (e) => e.status === 500 && /Unsupported LLM_PROVIDER/.test(e.message));
  delete process.env.LLM_PROVIDER;
});
