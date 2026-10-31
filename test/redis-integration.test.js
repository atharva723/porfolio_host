const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

/* ---------------------------------------------------------------------
   A tiny fake of Upstash's REST API, so the REAL @upstash/redis client and
   our Redis code paths (sessions, rate limits, locks) are exercised without
   network access or credentials.
--------------------------------------------------------------------- */
const store = new Map(); // key -> { v, exp }
let failing = false;

function live(key) {
  const e = store.get(key);
  if (e && e.exp && Date.now() > e.exp) {
    store.delete(key);
    return undefined;
  }
  return e;
}

function runCommand([name, ...args]) {
  const cmd = String(name).toUpperCase();
  const key = args[0];
  const e = live(key);
  switch (cmd) {
    case "GET":
      return e ? e.v : null;
    case "SET": {
      const opts = args.slice(2).map((a) => String(a).toUpperCase());
      if (opts.includes("NX") && e) return null;
      const exIdx = opts.indexOf("EX");
      store.set(key, { v: String(args[1]), exp: exIdx >= 0 ? Date.now() + Number(args[2 + exIdx + 1]) * 1000 : 0 });
      return "OK";
    }
    case "DEL":
      return args.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0);
    case "INCR": {
      const n = (e ? Number(e.v) : 0) + 1;
      store.set(key, { v: String(n), exp: e ? e.exp : 0 });
      return n;
    }
    case "EXPIRE": {
      if (!e) return 0;
      if (String(args[2] || "").toUpperCase() === "NX" && e.exp) return 0;
      e.exp = Date.now() + Number(args[1]) * 1000;
      return 1;
    }
    case "TTL":
      return !e ? -2 : e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1;
    case "RPUSH": {
      const list = e ? e.v : [];
      list.push(...args.slice(1).map(String));
      store.set(key, { v: list, exp: e ? e.exp : 0 });
      return list.length;
    }
    case "LTRIM": {
      if (e) {
        const len = e.v.length;
        const start = Number(args[1]) < 0 ? Math.max(len + Number(args[1]), 0) : Number(args[1]);
        const stop = Number(args[2]) < 0 ? len + Number(args[2]) : Number(args[2]);
        e.v = e.v.slice(start, stop + 1);
      }
      return "OK";
    }
    case "LRANGE":
      return e ? e.v : [];
    default:
      throw new Error("unsupported command " + cmd);
  }
}

// The client asks for base64-encoded bulk strings; "OK" is sent as-is.
function encode(result, base64) {
  if (!base64) return result;
  if (typeof result === "string") return result === "OK" ? result : Buffer.from(result).toString("base64");
  if (Array.isArray(result)) return result.map((r) => encode(r, base64));
  return result;
}

let fake;

test.before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failing) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "simulated outage" }));
      }
      const base64 = String(req.headers["upstash-encoding"]).toLowerCase() === "base64";
      const payload = JSON.parse(body);
      const out = req.url.startsWith("/pipeline")
        ? payload.map((c) => ({ result: encode(runCommand(c), base64) }))
        : { result: encode(runCommand(payload), base64) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
});

test.after(() => fake && fake.close());
test.beforeEach(() => {
  store.clear();
  failing = false;
});

const session = () => require("../lib/session");
const rateLimit = () => require("../lib/ratelimit");
const CONFIG = require("../public/js/config.js");

test("sessions persist in Redis with an idle TTL and are trimmed", async () => {
  const s = session();
  const id = s.newId();
  for (let i = 0; i < CONFIG.MAX_HISTORY_TURNS; i++) {
    await s.append(id, [
      { role: "user", content: "q" + i },
      { role: "assistant", content: "a" + i },
    ]);
  }
  const turns = await s.load(id);
  assert.equal(turns.length, CONFIG.MAX_HISTORY_TURNS);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[turns.length - 1].content, "a" + (CONFIG.MAX_HISTORY_TURNS - 1));

  const ttl = runCommand(["TTL", `sess:${id}:turns`]);
  assert.ok(ttl > 0 && ttl <= 3600, `idle TTL set (${ttl}s)`);
  assert.equal(s.status().redis, true);
});

test("clear removes the conversation from Redis", async () => {
  const s = session();
  const id = s.newId();
  await s.append(id, [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
  await s.clear(id);
  assert.deepEqual(await s.load(id), []);
});

test("session lock is exclusive in Redis and expires on its own", async () => {
  const s = session();
  const id = s.newId();
  const token = await s.acquire(id);
  assert.ok(token);
  assert.equal(await s.acquire(id), null);
  const ttl = runCommand(["TTL", `sess:${id}:lock`]);
  assert.ok(ttl > 0 && ttl <= 30, "lock has a safety TTL");
  await s.release(id, token);
  assert.ok(await s.acquire(id), "re-acquirable after release");
});

test("rate limits are shared counters in Redis, keyed by hashed IP, with a window TTL", async () => {
  const limit = { bucket: "int", windowMs: 60000, max: 2 };
  const ip = "198.51.100.77";
  const r = rateLimit();
  assert.equal((await r.check(ip, [limit])).limited, false);
  assert.equal((await r.check(ip, [limit])).limited, false);
  const blocked = await r.check(ip, [limit]);
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);

  const keys = [...store.keys()].filter((k) => k.startsWith("rl:int:"));
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes("198.51"), "raw IP is never stored");
  assert.ok(runCommand(["TTL", keys[0]]) > 0, "counter always expires");
});

const resumeUrl = "https://docs.google.com/document/d/e/2PACX-1vRNiKCkjGj44iqXm2eOY50dA71KSGFpK6hUVaaY1MqPU3v1faUv7x35oeZyVwxwG7cX-k8QkHJvWZ67/pub";
const resumeHtml = `<div id="contents"><p>Atharva Jadhav</p><p>${"Engineer working on agentic automation. ".repeat(10)}</p></div>`;
const htmlOk = () => new Response(resumeHtml, { status: 200, headers: { "content-type": "text/html" } });

test("resume: a fetched copy is shared through Redis (fresh + last-good keys with TTLs)", async () => {
  const resume = require("../lib/sources/resume");
  process.env.RESUME_DOC_URL = resumeUrl;
  resume._reset();
  let calls = 0;
  resume._setFetch(async () => {
    calls++;
    return htmlOk();
  });

  const first = await resume.get();
  assert.equal(first.available, true);
  assert.equal(calls, 1);
  const freshTtl = runCommand(["TTL", "kb:resume"]);
  assert.ok(freshTtl > 0 && freshTtl <= 3600, `fresh copy expires (${freshTtl}s)`);
  assert.ok(runCommand(["TTL", "kb:resume:last"]) > 3600, "last-good copy outlives the fresh window");

  // A different serverless instance (empty memory) reads Redis instead of Google.
  resume._reset();
  resume._setFetch(async () => assert.fail("must not hit Google when Redis has a fresh copy"));
  const second = await resume.get();
  assert.equal(second.available, true);
  assert.equal(second.stale, false);
  assert.equal(second.text, first.text);
  delete process.env.RESUME_DOC_URL;
  resume._reset();
});

test("resume: when Google fails and the fresh key has expired, Redis last-good is served as stale", async () => {
  const resume = require("../lib/sources/resume");
  const warn = console.warn;
  console.warn = () => {};
  try {
    process.env.RESUME_DOC_URL = resumeUrl;
    resume._reset();
    resume._setFetch(async () => htmlOk());
    const good = await resume.get();

    store.delete("kb:resume"); // fresh window over
    resume._reset(); // new instance, empty memory
    resume._setFetch(async () => {
      throw new Error("google down");
    });
    const r = await resume.get();
    assert.equal(r.available, true);
    assert.equal(r.stale, true);
    assert.equal(r.text, good.text);
  } finally {
    console.warn = warn;
    delete process.env.RESUME_DOC_URL;
    resume._reset();
  }
});

test("a Redis outage degrades to in-memory instead of failing", async () => {
  failing = true;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const s = session();
    const id = s.newId();
    await s.append(id, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
    assert.equal((await s.load(id)).length, 2, "served from memory during the outage");
    assert.ok(await s.acquire(id), "lock still works");

    const limit = { bucket: "outage", windowMs: 60000, max: 1 };
    assert.equal((await rateLimit().check("203.0.113.50", [limit])).limited, false);
    assert.equal((await rateLimit().check("203.0.113.50", [limit])).limited, true);
  } finally {
    console.warn = originalWarn;
  }
});
