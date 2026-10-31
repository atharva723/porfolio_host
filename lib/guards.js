/* =====================================================================
   GUARDS — request sanitizing, injection detection, rate limiting
   ---------------------------------------------------------------------
   Pure, dependency-free helpers extracted from server.js so they can be
   unit-tested in isolation and reused.
   ===================================================================== */

// Collapse whitespace and trim.
function sanitize(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

// A FREE pre-filter, not the real defence: it only catches blatant, unambiguous
// prompt-injection phrases so they cost no model call. Scope (off-topic code,
// translation, trivia ...) and subtler attacks are judged by the LLM guard
// (lib/guard.js); keeping this list narrow avoids blocking genuine questions
// such as "has he written system prompts for agents?" (see guards.test.js).
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|above|prior|your)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(everything|all|your)\s+(you\s+know|instructions?|rules?|above)/i,
  /\b(reveal|show|print|repeat|output|display|tell me|give me)\b.{0,40}\b(your|system|hidden|initial|original)\s+(prompt|instructions?|rules|system message|knowledge base)\b/i,
  /\b(repeat|print|echo|say)\b.{0,30}\b(the\s+)?(text|words|everything)\s+above\b/i,
  /\bpretend\s+to\s+be\b|\bfrom\s+now\s+on\s+you\b/i,
  /\b(developer|dan|jailbreak|god|sudo)\s*mode\b|\bdo\s+anything\s+now\b|\bDAN\b/,
  /override\s+(your|the|all)\s+(instructions?|rules?|settings?)/i,
];

function looksLikeInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Create a best-effort in-memory rate limiter. Each instance owns its own
 * store. On serverless the store resets per cold start, so this is a soft
 * guard rather than a hard quota.
 *
 * @param {number} [maxEntries=5000] - size at which expired entries are swept.
 * @returns {(ip: string, limit: {windowMs:number, max:number}, bucket: string) => boolean}
 *          returns true when the caller is OVER the limit.
 */
function createRateLimiter(maxEntries = 5000) {
  const hits = new Map();

  return function rateLimited(ip, limit, bucketName) {
    const now = Date.now();
    const key = `${bucketName}:${ip}`;
    const entry = hits.get(key);

    // Opportunistically drop expired entries so the map can't grow unbounded.
    if (hits.size > maxEntries) {
      for (const [k, v] of hits) {
        if (now > v.reset) hits.delete(k);
      }
    }

    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + limit.windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > limit.max;
  };
}

module.exports = { sanitize, looksLikeInjection, INJECTION_PATTERNS, createRateLimiter };
