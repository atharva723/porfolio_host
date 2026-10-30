/* =====================================================================
   RESPONSE CACHE — two-tier (in-memory L1 + optional Upstash Redis L2)
   ---------------------------------------------------------------------
   Purpose: avoid redundant LLM calls by remembering the answer to an
   identical request. The cache key is a hash of everything that shapes
   the reply (system prompt, guard, full conversation, provider/model/
   params), so a cached answer is only ever reused when it is 100% valid.

   Design goals (production-quality):
   - Correctness first: exact-match only, no fuzzy/semantic guessing.
   - Graceful degradation: if Redis isn't configured or is unreachable,
     silently fall back to the in-memory layer. Caching must NEVER break
     the chat — every cache error is swallowed and treated as a miss.
   - Serverless-friendly: L2 (Upstash Redis over HTTP) is shared across
     all function instances and survives cold starts; L1 speeds up warm
     instances and shields Redis from repeated identical reads.
   - Bounded memory: L1 is a small LRU with per-entry TTL.

   Configuration (all optional — absence just disables L2):
     UPSTASH_REDIS_REST_URL     Upstash REST endpoint
     UPSTASH_REDIS_REST_TOKEN   Upstash REST token
     CHAT_CACHE_TTL_SECONDS     entry lifetime (default 2592000 = 30 days)
     CHAT_CACHE_MEM_MAX         max L1 entries (default 500)
     CHAT_CACHE_DISABLED        set to "1"/"true" to bypass the cache
   ===================================================================== */

const crypto = require("crypto");
const { getRedis } = require("./redis");

const TTL_DEFAULT = toPositiveInt(process.env.CHAT_CACHE_TTL_SECONDS, 30 * 24 * 60 * 60);
const MEM_MAX = toPositiveInt(process.env.CHAT_CACHE_MEM_MAX, 500);
const DISABLED = /^(1|true|yes)$/i.test(process.env.CHAT_CACHE_DISABLED || "");

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* ---------------------------------------------------------------------
   L1: in-memory LRU with TTL.
   A Map preserves insertion order, so the first key is the oldest; we
   re-insert on read to make it "most recently used".
--------------------------------------------------------------------- */
const mem = new Map(); // key -> { value: string, expires: number }

function memGet(key) {
  const entry = mem.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    mem.delete(key);
    return null;
  }
  // Refresh recency.
  mem.delete(key);
  mem.set(key, entry);
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  mem.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  // Evict least-recently-used entries beyond the cap.
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    mem.delete(oldest);
  }
}

/* L2 is the shared Upstash client (lib/redis.js); null when unconfigured. */

/* ---------------------------------------------------------------------
   Public API
--------------------------------------------------------------------- */

/**
 * Build a stable, compact cache key from the parts that determine a reply.
 * Everything is hashed, so raw user text never becomes a literal key
 * (prevents cache poisoning / oversized keys).
 * @param {Array<string>} parts
 * @returns {string}
 */
function makeKey(parts) {
  const hash = crypto.createHash("sha256");
  // NUL separator can't appear in normal text, so parts can't collide.
  hash.update(parts.join("\u0000"));
  return "chat:" + hash.digest("hex");
}

/**
 * Look up a cached reply. Returns null on miss (or when disabled/errored).
 * @param {string} key
 * @returns {Promise<{ value: string, layer: "memory"|"redis" } | null>}
 */
async function get(key) {
  if (DISABLED) return null;

  const local = memGet(key);
  if (local != null) return { value: local, layer: "memory" };

  const redis = getRedis();
  if (redis) {
    try {
      const value = await redis.get(key);
      if (typeof value === "string" && value.length) {
        memSet(key, value, TTL_DEFAULT); // warm L1 for subsequent hits
        return { value, layer: "redis" };
      }
    } catch (err) {
      console.warn("[cache] redis get failed (treating as miss):", err.message);
    }
  }
  return null;
}

/**
 * Store a reply in both layers. Awaits the Redis write so it completes
 * before a serverless function can freeze after responding.
 * @param {string} key
 * @param {string} value
 * @param {number} [ttlSeconds]
 * @returns {Promise<void>}
 */
async function set(key, value, ttlSeconds = TTL_DEFAULT) {
  if (DISABLED || typeof value !== "string" || !value.length) return;

  memSet(key, value, ttlSeconds);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, value, { ex: ttlSeconds });
    } catch (err) {
      console.warn("[cache] redis set failed (entry kept in memory only):", err.message);
    }
  }
}

/**
 * Snapshot of cache configuration/state — handy for a health endpoint.
 * @returns {{ enabled: boolean, redis: boolean, memEntries: number, ttlSeconds: number, memMax: number }}
 */
function status() {
  return {
    enabled: !DISABLED,
    redis: !!getRedis(),
    memEntries: mem.size,
    ttlSeconds: TTL_DEFAULT,
    memMax: MEM_MAX,
  };
}

/** Clear the in-memory layer (used by tests). Does not touch Redis. */
function _resetMemory() {
  mem.clear();
}

module.exports = { makeKey, get, set, status, TTL_DEFAULT, _resetMemory };
