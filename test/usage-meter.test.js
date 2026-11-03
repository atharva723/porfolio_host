const test = require("node:test");
const assert = require("node:assert");

for (const k of ["LLM_MODEL", "GUARD_MODEL", "PLAN_MODEL", "VERIFY_MODEL", "PROMPT_GUARD_MODEL", "LLM_PROVIDER"]) delete process.env[k];
process.env.LLM_API_KEY = "test-key-not-real";

const llm = require("../lib/llm");

const realFetch = global.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const openai = (content, usage) => json({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

// Token counts depend on the last user message ("A" or "B"), so concurrent runs can be told apart.
function installFetch(handler) {
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const last = body.messages ? body.messages[body.messages.length - 1].content : "";
    return handler({ url, body, last });
  };
}
test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LLM_PROVIDER;
});

const call = (purpose, text) => llm.complete({ purpose, system: "S", messages: [{ role: "user", content: text }] });

test("metered() sums calls and prompt/completion tokens, overall and per stage", async () => {
  installFetch(() => openai("ok", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }));
  const { value, usage } = await llm.metered(async () => {
    await call("guard", "A");
    await call("plan", "A");
    await llm.generateReply("SYS", [{ role: "user", content: "A" }], "REMINDER");
    await call("verify", "A");
    return "done";
  });
  assert.equal(value, "done");
  assert.deepEqual(usage, {
    calls: 4,
    prompt: 400,
    completion: 40,
    total: 440,
    byStage: {
      guard: { calls: 1, prompt: 100, completion: 10 },
      plan: { calls: 1, prompt: 100, completion: 10 },
      main: { calls: 1, prompt: 100, completion: 10 },
      verify: { calls: 1, prompt: 100, completion: 10 },
    },
  });
});

test("concurrent turns are isolated: one visitor's usage never leaks into another's", async () => {
  installFetch(({ last }) => openai("ok", last === "A" ? { prompt_tokens: 100, completion_tokens: 10 } : { prompt_tokens: 200, completion_tokens: 20 }));
  const turn = (label, pauseMs) =>
    llm.metered(async () => {
      await call("guard", label);
      await sleep(pauseMs); // interleave the two turns
      await call("verify", label);
    });
  const [a, b] = await Promise.all([turn("A", 30), turn("B", 5)]);
  assert.deepEqual([a.usage.calls, a.usage.prompt, a.usage.completion], [2, 200, 20]);
  assert.deepEqual([b.usage.calls, b.usage.prompt, b.usage.completion], [2, 400, 40]);
});

test("calls outside metered() are simply not counted (and do not fail)", async () => {
  installFetch(() => openai("ok", { prompt_tokens: 5, completion_tokens: 1 }));
  assert.equal(await call("guard", "A"), "ok");
  const { usage } = await llm.metered(async () => {});
  assert.equal(usage.calls, 0);
});

test("a provider that omits usage still counts the call, with zero tokens", async () => {
  installFetch(() => openai("ok"));
  const { usage } = await llm.metered(() => call("guard", "A"));
  assert.deepEqual([usage.calls, usage.total], [1, 0]);
});

test("failed calls are not counted as usage", async () => {
  installFetch(() => new Response("{}", { status: 500 }));
  const { usage } = await llm.metered(async () => {
    await call("guard", "A").catch(() => {});
  });
  assert.equal(usage.calls, 0);
});

test("a retried 429 counts only the call that succeeded", async () => {
  llm._setSleep(async () => {});
  let n = 0;
  installFetch(() => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : openai("ok", { prompt_tokens: 7, completion_tokens: 3 })));
  const { usage } = await llm.metered(() => call("guard", "A"));
  assert.deepEqual([usage.calls, usage.prompt, usage.completion], [1, 7, 3]);
});

test("Gemini usage metadata is understood too", async () => {
  process.env.LLM_PROVIDER = "gemini";
  installFetch(() => json({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } }));
  const { usage } = await llm.metered(() => llm.generateReply("SYS", [{ role: "user", content: "A" }], "R"));
  assert.deepEqual([usage.calls, usage.prompt, usage.completion], [1, 50, 5]);
});

test("usage carries only counts: no prompt or reply text", async () => {
  installFetch(() => openai("SECRET-REPLY-TEXT", { prompt_tokens: 9, completion_tokens: 2 }));
  const { usage } = await llm.metered(() => call("guard", "SECRET-VISITOR-TEXT"));
  assert.ok(!JSON.stringify(usage).includes("SECRET"));
});

test("an EMPTY reply that was billed (a reasoning model that spent its whole budget thinking) still counts its tokens", async () => {
  installFetch(() => openai("", { prompt_tokens: 120, completion_tokens: 1024 }));
  const { usage } = await llm.metered(async () => {
    await assert.rejects(call("guard", "A"), (e) => e.status === 502 && /Empty response/.test(e.message));
  });
  assert.deepEqual([usage.calls, usage.prompt, usage.completion, usage.total], [1, 120, 1024, 1144]);
});

test("a turn that FAILS carries its usage on the error, so failed turns can be costed", async () => {
  installFetch(() => openai("ok", { prompt_tokens: 50, completion_tokens: 5 }));
  let caught;
  try {
    await llm.metered(async () => {
      await call("guard", "A");
      await call("verify", "A");
      throw new Error("later stage failed");
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.message, "later stage failed");
  assert.deepEqual([caught.usage.calls, caught.usage.prompt, caught.usage.completion], [2, 100, 10]);
  assert.deepEqual(Object.keys(caught.usage.byStage).sort(), ["guard", "verify"]);
});

test("a thrown non-object value is passed through unchanged", async () => {
  await assert.rejects(llm.metered(async () => { throw "plain string"; }), (e) => e === "plain string");
});
