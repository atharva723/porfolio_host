const test = require("node:test");
const assert = require("node:assert");

// Force the in-memory fallbacks regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const session = require("../lib/session");
const rateLimit = require("../lib/ratelimit");
const CONFIG = require("../public/js/config.js");

test.beforeEach(() => session._resetMemory());

test("newId produces unguessable 128-bit hex ids", () => {
  const a = session.newId();
  const b = session.newId();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
  assert.ok(session.isValidId(a));
});

test("isValidId rejects malformed ids (no key injection)", () => {
  for (const bad of ["", "abc", "g".repeat(32), "a".repeat(31), "a".repeat(33), "x:y", null, undefined, 42, "../etc"]) {
    assert.equal(session.isValidId(bad), false, String(bad));
  }
});

test("idFromRequest reads only a valid sid cookie", () => {
  const id = session.newId();
  assert.equal(session.idFromRequest({ headers: { cookie: `a=1; sid=${id}; b=2` } }), id);
  assert.equal(session.idFromRequest({ headers: { cookie: "sid=not-valid" } }), null);
  assert.equal(session.idFromRequest({ headers: {} }), null);
});

test("append then load round-trips a conversation", async () => {
  const id = session.newId();
  await session.append(id, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.deepEqual(await session.load(id), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("history is capped to MAX_HISTORY_TURNS, keeping the newest", async () => {
  const id = session.newId();
  for (let i = 0; i < CONFIG.MAX_HISTORY_TURNS; i++) {
    await session.append(id, [
      { role: "user", content: "q" + i },
      { role: "assistant", content: "a" + i },
    ]);
  }
  const turns = await session.load(id);
  assert.equal(turns.length, CONFIG.MAX_HISTORY_TURNS);
  assert.equal(turns[0].role, "user", "starts on a user turn");
  assert.equal(turns[turns.length - 1].content, "a" + (CONFIG.MAX_HISTORY_TURNS - 1));
});

test("sessions are isolated from each other", async () => {
  const a = session.newId();
  const b = session.newId();
  await session.append(a, [{ role: "user", content: "secret-a" }, { role: "assistant", content: "ok" }]);
  assert.deepEqual(await session.load(b), []);
});

test("clear forgets the conversation", async () => {
  const id = session.newId();
  await session.append(id, [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
  await session.clear(id);
  assert.deepEqual(await session.load(id), []);
});

test("only one request can hold the session lock at a time", async () => {
  const id = session.newId();
  const first = await session.acquire(id);
  assert.ok(first);
  assert.equal(await session.acquire(id), null, "second acquire is refused");
  await session.release(id, "wrong-token");
  assert.equal(await session.acquire(id), null, "wrong token does not release");
  await session.release(id, first);
  assert.ok(await session.acquire(id), "can acquire after release");
});

test("rate limiter blocks after max hits and reports Retry-After", async () => {
  const limit = { bucket: "unit", windowMs: 60000, max: 2 };
  const ip = "203.0.113.7";
  assert.equal((await rateLimit.check(ip, [limit])).limited, false);
  assert.equal((await rateLimit.check(ip, [limit])).limited, false);
  const blocked = await rateLimit.check(ip, [limit]);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal((await rateLimit.check("203.0.113.8", [limit])).limited, false, "other IPs unaffected");
});

test("rate limit keys never contain the raw IP", () => {
  const hashed = rateLimit.hashIp("198.51.100.23");
  assert.match(hashed, /^[a-f0-9]{32}$/);
  assert.ok(!hashed.includes("198"));
});
