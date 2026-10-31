/* =====================================================================
   LIVE RESUME SOURCE — published Google Doc -> clean text
   ---------------------------------------------------------------------
   Edit the Google Doc and the assistant picks the change up within the
   cache window; no redeploy. Config:
     RESUME_DOC_URL        the "Publish to web" link of the doc, e.g.
                           https://docs.google.com/document/d/e/<id>/pub
     RESUME_CACHE_SECONDS  Redis freshness window (default 3600)

   Safety:
   - The URL is validated and REBUILT from its id: https, host
     docs.google.com, path /document/d/e/<id>/pub only. Nothing a visitor
     says can change what is fetched (no SSRF surface).
   - Redirects are refused, the download is time- and size-capped.
   - The document is UNTRUSTED text: it is stripped to plain text,
     length-capped, and phone numbers are redacted here (data
     minimisation) before the model ever sees it.
   - Never throws. On failure it serves the last good copy (flagged
     stale) or reports the resume as unavailable; failures are backed off
     so a Google outage can't slow every chat request.
   ===================================================================== */

const { getRedis } = require("../redis");
const { redactPhones } = require("../text");
const kb = require("../kb");

const HOST = "docs.google.com";
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 15000;
const MIN_TEXT_CHARS = 200;
const L1_TTL_MS = 5 * 60 * 1000;
const FAIL_BACKOFF_MS = 60 * 1000;
const LAST_GOOD_TTL_SECONDS = 30 * 24 * 60 * 60;
const KEY_FRESH = "kb:resume";
const KEY_LAST = "kb:resume:last";

const freshSeconds = () => {
  const n = Number(process.env.RESUME_CACHE_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
};

let fetchImpl = (...args) => fetch(...args);
let l1 = null; // { text, fetchedAt, expires }
let lastGood = null; // { text, fetchedAt }
let failedUntil = 0;
let inflight = null;

/**
 * Validate the configured link and rebuild it from its id.
 * @returns {string|null} canonical URL, or null when invalid/unset.
 */
function parseResumeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== HOST || u.port || u.username || u.password) return null;
  const m = /^\/document\/d\/e\/([A-Za-z0-9_-]{20,200})\/pub\/?$/.exec(u.pathname);
  return m ? `https://${HOST}/document/d/e/${m[1]}/pub` : null;
}

/* ---------------------------------------------------------------------
   HTML -> plain text
--------------------------------------------------------------------- */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

// Google wraps outbound links as https://www.google.com/url?q=<real>&sa=...
function unwrapLink(href) {
  try {
    const u = new URL(decodeEntities(href));
    const target = u.hostname.endsWith("google.com") && u.pathname === "/url" ? u.searchParams.get("q") : u.href;
    return target && /^https?:\/\//i.test(target) ? target : "";
  } catch {
    return "";
  }
}

/* The phone-number redaction lives in lib/text.js (shared with the LinkedIn import). */

function extractText(html) {
  let h = String(html);
  const start = h.indexOf('id="contents"');
  if (start >= 0) h = h.slice(start).replace(/^[^>]*>/, "");
  const footer = h.search(/<div[^>]+id="footer"/i);
  if (footer >= 0) h = h.slice(0, footer);

  h = h
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const label = decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
      const url = unwrapLink(href);
      return label && url ? `${label} (${url})` : label;
    })
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|td|th|div|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  const text = decodeEntities(h)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}(?=- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return redactPhones(text).slice(0, MAX_TEXT_CHARS);
}

/* ---------------------------------------------------------------------
   Download (time + size capped, no redirects)
--------------------------------------------------------------------- */
async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("document too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "text/html", "User-Agent": "portfolio-assistant" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/text\/html/i.test(res.headers.get("content-type") || "")) throw new Error("unexpected content type");
    return await readCapped(res, MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------
   Redis helpers (best effort)
--------------------------------------------------------------------- */
async function redisRead(key) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    let v = await redis.get(key);
    if (typeof v === "string") v = JSON.parse(v);
    return v && typeof v.text === "string" && v.text ? { text: v.text, fetchedAt: v.fetchedAt } : null;
  } catch (err) {
    console.warn("[resume] redis read failed:", err.message);
    return null;
  }
}

async function redisWrite(doc) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const value = JSON.stringify(doc);
    await redis.set(KEY_FRESH, value, { ex: freshSeconds() });
    await redis.set(KEY_LAST, value, { ex: LAST_GOOD_TTL_SECONDS });
  } catch (err) {
    console.warn("[resume] redis write failed:", err.message);
  }
}

/* ---------------------------------------------------------------------
   Public API
--------------------------------------------------------------------- */
async function refresh(url) {
  const text = extractText(await download(url));
  if (text.length < MIN_TEXT_CHARS) throw new Error("document looks empty");
  const name = kb.load().profile.name;
  if (!text.toLowerCase().includes(name.toLowerCase())) throw new Error("document does not look like the resume");

  const doc = { text, fetchedAt: new Date().toISOString() };
  lastGood = doc;
  l1 = { ...doc, expires: Date.now() + L1_TTL_MS };
  failedUntil = 0;
  await redisWrite(doc);
  return doc;
}

async function fallback() {
  const doc = lastGood || (await redisRead(KEY_LAST));
  if (doc) {
    lastGood = doc;
    return { available: true, stale: true, text: doc.text, fetchedAt: doc.fetchedAt };
  }
  return { available: false, reason: "unavailable" };
}

/**
 * @returns {Promise<{available: true, stale: boolean, text: string, fetchedAt: string}
 *   | {available: false, reason: "not-configured"|"unavailable"}>}
 */
async function get() {
  const url = parseResumeUrl(process.env.RESUME_DOC_URL);
  if (!url) return { available: false, reason: "not-configured" };

  const now = Date.now();
  if (l1 && now < l1.expires) return { available: true, stale: false, text: l1.text, fetchedAt: l1.fetchedAt };

  const shared = await redisRead(KEY_FRESH);
  if (shared) {
    lastGood = shared;
    l1 = { ...shared, expires: now + L1_TTL_MS };
    return { available: true, stale: false, text: shared.text, fetchedAt: shared.fetchedAt };
  }

  if (now < failedUntil) return fallback();

  if (!inflight) inflight = refresh(url).finally(() => (inflight = null));
  try {
    const doc = await inflight;
    return { available: true, stale: false, text: doc.text, fetchedAt: doc.fetchedAt };
  } catch (err) {
    failedUntil = Date.now() + FAIL_BACKOFF_MS;
    console.warn("[resume] refresh failed, using last good copy if any:", err.message);
    return fallback();
  }
}

/** Test hooks. */
function _reset() {
  l1 = null;
  lastGood = null;
  failedUntil = 0;
  inflight = null;
  fetchImpl = (...args) => fetch(...args);
}
function _setFetch(fn) {
  fetchImpl = fn;
}

module.exports = { get, parseResumeUrl, extractText, redactPhones, _reset, _setFetch };
