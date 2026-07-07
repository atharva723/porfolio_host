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

// Cheap first line of defense: catch blatant jailbreak / prompt-injection /
// system-prompt-extraction / off-topic-generation attempts and refuse them
// WITHOUT spending an LLM call. Patterns are tuned toward imperative phrasing
// so genuine recruiter questions are not blocked (see guards.test.js).
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|above|prior|your)\s+/i,
  /forget\s+(everything|all|your)\s+(you\s+know|instructions?|rules?|above)/i,
  /\b(system|developer)\s*(prompt|message|instructions?)\b/i,
  /\b(reveal|show|print|repeat|output|display|tell me|give me)\b.{0,40}\b(prompt|instructions?|rules?|system message|knowledge base)\b/i,
  /\b(repeat|print|echo|say)\b.{0,30}\b(the\s+)?(text|words|everything)\s+above\b/i,
  /\byou\s+are\s+now\b|\bact\s+as\s+(an?|the)\b|\bpretend\s+to\s+be\b|\bfrom\s+now\s+on\s+you\b/i,
  /\b(developer|dan|jailbreak|god|admin|sudo|root)\s*mode\b|\bdo\s+anything\s+now\b|\bDAN\b/,
  // Code generation — requires an imperative "make" verb near a code noun.
  // "explain/show" are intentionally excluded to avoid blocking questions like
  // "explain Atharva's code review experience".
  /\b(write|generate|create|build|make|produce|complete|fix|debug|refactor|implement|code)\b.{0,30}\b(code|program|script|function|snippet|algorithm|regex|sql\s+query|class|method)\b/i,
  /\b(translate|rewrite|summarize|paraphrase)\b.{0,30}\b(this|the following|above|into)\b/i,
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
