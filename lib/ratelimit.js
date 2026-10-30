/* =====================================================================
   RATE LIMITING — shared Redis counters with in-memory fallback
   ---------------------------------------------------------------------
   Fixed-window counters (INCR + EXPIRE NX in one pipeline) so limits hold
   across all Vercel instances and cold starts. If Redis is unconfigured or
   erroring, falls back to the per-instance limiter in guards.js.

   Privacy: client IPs are salted + hashed before they are used in a key,
   so raw IP addresses are never stored.
     RATE_LIMIT_SALT   optional secret salt for the IP hash
   ===================================================================== */

const crypto = require("crypto");
const { getRedis } = require("./redis");
const { createRateLimiter } = require("./guards");

const SALT = process.env.RATE_LIMIT_SALT || "portfolio-chat-rl";
const memLimiter = createRateLimiter();

function hashIp(ip) {
  return crypto.createHash("sha256").update(`${SALT}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * Count one hit against a single window.
 * @returns {Promise<{ limited: boolean, retryAfterSeconds: number }>}
 */
async function hit(ip, { bucket, windowMs, max }) {
  const windowSeconds = Math.ceil(windowMs / 1000);
  const redis = getRedis();

  if (redis) {
    try {
      const key = `rl:${bucket}:${hashIp(ip)}`;
      const pipe = redis.pipeline();
      pipe.incr(key);
      pipe.expire(key, windowSeconds, "NX");
      pipe.ttl(key);
      const [count, , ttl] = await pipe.exec();
      return {
        limited: Number(count) > max,
        retryAfterSeconds: Number(ttl) > 0 ? Number(ttl) : windowSeconds,
      };
    } catch (err) {
      console.warn("[ratelimit] redis failed (using in-memory limiter):", err.message);
    }
  }

  return {
    limited: memLimiter(hashIp(ip), { windowMs, max }, bucket),
    retryAfterSeconds: windowSeconds,
  };
}

/**
 * Check every limit in order; stops at the first one that is exceeded.
 * @param {string} ip
 * @param {Array<{ bucket: string, windowMs: number, max: number }>} limits
 */
async function check(ip, limits) {
  for (const limit of limits) {
    const result = await hit(ip, limit);
    if (result.limited) return result;
  }
  return { limited: false, retryAfterSeconds: 0 };
}

module.exports = { check, hashIp };
