const test = require("node:test");
const assert = require("node:assert");

// No Upstash env vars in the test environment, so this exercises the
// in-memory (L1) path and the graceful "Redis disabled" fallback.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
const cache = require("../lib/cache");

test.beforeEach(() => cache._resetMemory());

test("makeKey is deterministic for identical parts", () => {
  const a = cache.makeKey(["chat-v1", "groq:model:0.2:1024", "prompt", "guard", "[]"]);
  const b = cache.makeKey(["chat-v1", "groq:model:0.2:1024", "prompt", "guard", "[]"]);
  assert.equal(a, b);
  assert.match(a, /^chat:[0-9a-f]{64}$/);
});

test("makeKey differs when any part changes", () => {
  const base = ["chat-v1", "sig", "prompt", "guard", "[]"];
  const key = cache.makeKey(base);
  assert.notEqual(key, cache.makeKey(["chat-v1", "sig", "prompt-2", "guard", "[]"]));
  assert.notEqual(key, cache.makeKey(["chat-v1", "sig-2", "prompt", "guard", "[]"]));
  assert.notEqual(key, cache.makeKey(["chat-v1", "sig", "prompt", "guard", '[{"x":1}]']));
});

test("separator prevents part-boundary collisions", () => {
  // ["ab","c"] must not collide with ["a","bc"].
  assert.notEqual(cache.makeKey(["ab", "c"]), cache.makeKey(["a", "bc"]));
});

test("set then get returns the stored value from memory", async () => {
  const key = cache.makeKey(["k1"]);
  await cache.set(key, "hello");
  const hit = await cache.get(key);
  assert.ok(hit);
  assert.equal(hit.value, "hello");
  assert.equal(hit.layer, "memory");
});

test("get returns null on miss", async () => {
  const hit = await cache.get(cache.makeKey(["never-stored"]));
  assert.equal(hit, null);
});

test("empty or non-string values are not cached", async () => {
  const key = cache.makeKey(["empty"]);
  await cache.set(key, "");
  assert.equal(await cache.get(key), null);
});

test("entries expire after their TTL", async () => {
  const key = cache.makeKey(["ttl"]);
  await cache.set(key, "temp", 1); // 1 second
  assert.ok(await cache.get(key), "present immediately");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await cache.get(key), null, "gone after TTL");
});

test("LRU cap evicts the oldest entries", async () => {
  // Not asserting an exact cap (configurable); just that the map stays bounded
  // and recently-set keys survive while very old ones can be evicted.
  const keys = [];
  for (let i = 0; i < 600; i++) {
    const k = cache.makeKey(["lru", String(i)]);
    keys.push(k);
    await cache.set(k, "v" + i);
  }
  const s = cache.status();
  assert.ok(s.memEntries <= s.memMax, `memEntries ${s.memEntries} <= memMax ${s.memMax}`);
  // The most recently stored key should still be present.
  assert.ok(await cache.get(keys[keys.length - 1]));
});

test("status reports disabled Redis when unconfigured", () => {
  const s = cache.status();
  assert.equal(s.enabled, true);
  assert.equal(s.redis, false);
  assert.equal(typeof s.ttlSeconds, "number");
});
