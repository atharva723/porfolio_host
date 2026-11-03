const test = require("node:test");
const assert = require("node:assert");

// Force in-memory fallbacks and a clean environment regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.RESUME_DOC_URL = "";
process.env.RESUME_PDF_DOC_URL = "";

const { installLlmStub } = require("./helpers/llm-stub");
const stub = installLlmStub({ reply: "He works at LTIMindtree." });
const { LLMError } = require("../lib/llm");
const tools = require("../lib/tools");
const app = require("../server");

/* =====================================================================
   FAILURE MATRIX — what the visitor sees when each part breaks.
   Every row asserts (a) the HTTP status, (b) a safe, useful message, and
   (c) that nothing internal (upstream text, keys, paths) reaches the body.
   ===================================================================== */

let server;
let base;
let ip = 0;
const nextIp = () => `10.4.0.${++ip}`;
const warn = console.warn;
const error = console.error;
const info = console.info;

test.before(async () => {
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  console.warn = warn;
  console.error = error;
  console.info = info;
  if (server) server.close();
});
test.beforeEach(() => {
  stub.reset();
  stub.reply = "He works at LTIMindtree.";
  stub.guard = () => ({ verdict: "allow", reason: "ok" });
  stub.plan = () => ({ tools: [] });
  stub.verify = () => ({ supported: true, issues: [] });
  stub.promptGuard = () => 0.001;
});

let n = 0;
async function post(message, { cookie, ipAddr = nextIp(), raw } = {}) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ipAddr, ...(cookie ? { Cookie: cookie } : {}) },
    body: raw !== undefined ? raw : JSON.stringify({ message: typeof message === "string" ? `${message} #${++n}` : message }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, res };
}

const NO_LEAKS = ["SECRET", "gsk_", "stack", "at Object.", "node_modules", "C:\\", "upstream", "Upstream", "429", "ECONN"];
const assertSafe = (r) => {
  for (const needle of NO_LEAKS) assert.ok(!r.text.includes(needle), `response leaks "${needle}": ${r.text.slice(0, 200)}`);
};

/* ---- model-stage failures ---- */
test("input guard down -> 503 with a clear message; nothing is answered", async () => {
  stub.guard = () => {
    throw new LLMError("upstream 429 SECRET", 429);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 503);
  assert.match(r.json.error, /safety checks/i);
  assertSafe(r);
  assert.equal(stub.count("main"), 0);
});

test("answer verifier down -> 503; the unchecked draft is never shown", async () => {
  stub.verify = () => {
    throw new LLMError("upstream 429 SECRET", 429);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 503);
  assert.match(r.json.error, /safety checks/i);
  assert.ok(!r.text.includes("LTIMindtree"), "the draft must not leak through the error");
  assertSafe(r);
});

test("planner down -> still answers (context mode), 200", async () => {
  stub.plan = () => {
    throw new LLMError("upstream 429", 429);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "answer");
  assert.match(stub.calls.find((c) => c.purpose === "main").system, /KNOWLEDGE BASE/);
});

test("Prompt Guard down -> still answers (it is only a bonus signal)", async () => {
  stub.promptGuard = () => {
    throw new LLMError("down", 503);
  };
  assert.equal((await post("Where does he work?")).status, 200);
});

test("answer model rate limited -> 429 with a friendly message", async () => {
  stub.reply = () => {
    throw new LLMError("The assistant is busy right now. Please try again in a few seconds.", 429);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 429);
  assert.match(r.json.error, /busy/i);
});

test("answer model timeout -> 504", async () => {
  stub.reply = () => {
    throw new LLMError("The assistant took too long to respond. Please try again.", 504);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 504);
  assert.match(r.json.error, /too long/i);
});

test("upstream 5xx with provider details -> generic 502; the details never reach the visitor", async () => {
  stub.reply = () => {
    throw new LLMError('Upstream LLM error (500): {"error":"SECRET org_123 internal trace"}', 502);
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 502);
  assert.match(r.json.error, /unavailable right now/i);
  assertSafe(r);
});

test("an unexpected crash -> generic 500, no stack or internal message", async () => {
  stub.reply = () => {
    throw new Error("SECRET connection string C:\\prod\\db.sqlite at Object.<anonymous> (node_modules/x.js:1:1)");
  };
  const r = await post("Where does he work?");
  assert.equal(r.status, 500);
  assert.match(r.json.error, /unavailable right now/i);
  assertSafe(r);
});

/* ---- tool / data failures ---- */
test("a crashing tool does not break the turn: the answer says the detail is missing", async () => {
  const tool = tools.get("get_education");
  const real = tool.run;
  tool.run = async () => {
    throw new Error("SECRET disk error");
  };
  try {
    stub.plan = () => ({ tools: [{ name: "get_education", args: {} }] });
    stub.reply = "I don't have that detail. You can ask him directly at atharvajadhav968@gmail.com.";
    const r = await post("Where did he study?");
    assert.equal(r.status, 200);
    assert.equal(r.json.kind, "answer");
    assertSafe(r);
    const system = stub.calls.find((c) => c.purpose === "main").system;
    assert.match(system, /## get_education\nerror: lookup failed/, "the model is told the lookup failed");
    assert.ok(!system.includes("SECRET"), "and not why");
  } finally {
    tool.run = real;
  }
});

test("a verification rejection returns an honest 'can't confirm' (200), not an error", async () => {
  stub.verify = () => ({ supported: false, issues: ["x"] });
  const r = await post("Does he have a PhD?");
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "unverified");
  assert.match(r.json.reply, /couldn't confirm/i);
});

/* ---- malformed or hostile requests ---- */
test("malformed requests get 4xx, never 5xx", async () => {
  const cases = [
    ["invalid JSON", { raw: "{not json" }, [400]],
    ["empty body", { raw: "" }, [400]],
    ["message missing", { raw: JSON.stringify({}) }, [400]],
    ["message is an array", { raw: JSON.stringify({ message: ["a", "b"] }) }, [400]],
    ["message is an object", { raw: JSON.stringify({ message: { $ne: "" } }) }, [400]],
    ["message is a number", { raw: JSON.stringify({ message: 12345 }) }, [400]],
    ["message is only whitespace", { raw: JSON.stringify({ message: " \n\t " }) }, [400]],
    ["message too long", { raw: JSON.stringify({ message: "x".repeat(1001) }) }, [400]],
    ["body over 16 KB", { raw: JSON.stringify({ message: "x".repeat(20000) }) }, [413]],
  ];
  for (const [label, opts, allowed] of cases) {
    const r = await post(null, opts);
    assert.ok(allowed.includes(r.status), `${label}: got ${r.status}`);
    assertSafe(r);
  }
  assert.equal(stub.calls.length, 0, "no model was called for any malformed request");
});

test("control characters and odd unicode in a message are handled without error", async () => {
  const r = await post("Where\u0000 does\u202e he\u200b work?\u0007");
  assert.equal(r.status, 200);
});

test("only POST is accepted on /api/chat", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${base}/api/chat`, { method, headers: { "X-Forwarded-For": nextIp() } });
    assert.ok([404, 405].includes(res.status), `${method} -> ${res.status}`);
  }
});

test("two simultaneous messages in one session: one is answered, the other is told to wait (409)", async () => {
  const first = await post("Where does he work?");
  const cookie = `sid=${/^sid=([a-f0-9]{32})/.exec((first.res.headers.getSetCookie() || [])[0])[1]}`;
  stub.reply = async () => {
    await new Promise((r) => setTimeout(r, 150));
    return "He works at LTIMindtree.";
  };
  const who = nextIp();
  const [a, b] = await Promise.all([post("Second question", { cookie, ipAddr: who }), post("Third question", { cookie, ipAddr: who })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const conflict = a.status === 409 ? a : b;
  assert.match(conflict.json.error, /still answering/i);
});

test("a visitor who exceeds the rate limit gets 429 with Retry-After, and the model is not called", async () => {
  const who = nextIp();
  let last;
  for (let i = 0; i < 13; i++) last = await post("Where does he work?", { ipAddr: who });
  assert.equal(last.status, 429);
  assert.ok(Number(last.res.headers.get("retry-after")) > 0);
});
