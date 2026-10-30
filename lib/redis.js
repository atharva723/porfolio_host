/* =====================================================================
   SHARED REDIS CLIENT (Upstash REST) — used by cache, sessions, rate limits
   ---------------------------------------------------------------------
   Returns null when UPSTASH_REDIS_REST_URL / _TOKEN are not set, so every
   caller can degrade to an in-memory fallback instead of failing.
   ===================================================================== */

let client;
let resolved = false;

function getRedis() {
  if (resolved) return client;
  resolved = true;
  client = null;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const { Redis } = require("@upstash/redis");
    client = new Redis({ url, token });
  } catch (err) {
    console.warn("[redis] Upstash configured but @upstash/redis unavailable; using in-memory only:", err.message);
    client = null;
  }
  return client;
}

module.exports = { getRedis };
