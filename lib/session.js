/* =====================================================================
   CHAT SESSIONS — server-owned, short-lived conversation memory
   ---------------------------------------------------------------------
   The browser holds only an opaque, unguessable session id (HttpOnly
   cookie). The conversation itself lives server-side in Redis, so a
   visitor can never inject or forge earlier "assistant" turns.

   - Memory is temporary: a sliding TTL (default 1 hour) after the last
     message; nothing is kept longer.
   - Only successful exchanges are stored (blocked/failed messages never
     enter the history).
   - Graceful degradation: when Redis is unconfigured or erroring, the
     same API is served from a bounded in-memory store.

   Config (optional):
     SESSION_TTL_SECONDS   idle lifetime of a session (default 3600)
   ===================================================================== */

const crypto = require("crypto");
const { getRedis } = require("./redis");
const CONFIG = require("../public/js/config.js");

const COOKIE_NAME = "sid";
const ID_RE = /^[a-f0-9]{32}$/;
const TTL_SECONDS = toPositiveInt(process.env.SESSION_TTL_SECONDS, 60 * 60);
const MAX_TURNS = CONFIG.MAX_HISTORY_TURNS;
// A request holds the session lock only while it runs; the TTL is a safety net
// so a crashed/frozen function can never lock a visitor out for long. It must
// comfortably exceed the pipeline's time budget (CHAT_BUDGET_MS, default 25 s).
const LOCK_TTL_SECONDS = 60;
const MEM_MAX_SESSIONS = 1000;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const turnsKey = (id) => `sess:${id}:turns`;
const lockKey = (id) => `sess:${id}:lock`;

/* ---------------------------------------------------------------------
   In-memory fallback store
--------------------------------------------------------------------- */
const mem = new Map(); // id -> { turns: [], expires: number, lock: { token, expires } | null }

function memEntry(id, create) {
  const now = Date.now();
  let entry = mem.get(id);
  if (entry && now > entry.expires && !(entry.lock && now < entry.lock.expires)) {
    mem.delete(id);
    entry = undefined;
  }
  if (!entry && create) {
    entry = { turns: [], expires: now + TTL_SECONDS * 1000, lock: null };
    mem.set(id, entry);
    if (mem.size > MEM_MAX_SESSIONS) sweepMemory(now);
  }
  return entry;
}

function sweepMemory(now) {
  for (const [k, v] of mem) {
    if (now > v.expires) mem.delete(k);
  }
  // Still over the cap: evict oldest-inserted sessions.
  while (mem.size > MEM_MAX_SESSIONS) {
    mem.delete(mem.keys().next().value);
  }
}

/* ---------------------------------------------------------------------
   Id + cookie helpers
--------------------------------------------------------------------- */
function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function readCookie(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** The session id from the request cookie, or null if absent/malformed. */
function idFromRequest(req) {
  const id = readCookie(req.headers && req.headers.cookie, COOKIE_NAME);
  return isValidId(id) ? id : null;
}

/** (Re)issue the session cookie; it is inaccessible to page scripts. */
function setCookie(res, id, secure) {
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "strict",
    secure: !!secure,
    path: "/api/chat",
    maxAge: TTL_SECONDS * 1000,
  });
}

function clearCookie(res, secure) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: !!secure, path: "/api/chat" });
}

/* ---------------------------------------------------------------------
   Turns
--------------------------------------------------------------------- */
function normalizeTurns(items) {
  const turns = [];
  for (let item of items || []) {
    if (typeof item === "string") {
      try {
        item = JSON.parse(item);
      } catch {
        continue;
      }
    }
    if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
      turns.push({ role: item.role, content: item.content });
    }
  }
  // A conversation must start with a user turn.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

/**
 * Load the stored conversation for a session.
 * @param {string} id
 * @returns {Promise<Array<{role: "user"|"assistant", content: string}>>}
 */
async function load(id) {
  const redis = getRedis();
  if (redis) {
    try {
      return normalizeTurns(await redis.lrange(turnsKey(id), 0, -1));
    } catch (err) {
      console.warn("[session] redis load failed (using memory):", err.message);
    }
  }
  const entry = memEntry(id, false);
  return entry ? normalizeTurns(entry.turns) : [];
}

/**
 * Append one finished exchange and refresh the idle TTL.
 * @param {string} id
 * @param {Array<{role: string, content: string}>} turns
 */
async function append(id, turns) {
  const clean = turns.map((t) => ({ role: t.role, content: t.content }));
  const redis = getRedis();
  if (redis) {
    try {
      const pipe = redis.pipeline();
      pipe.rpush(turnsKey(id), ...clean);
      pipe.ltrim(turnsKey(id), -MAX_TURNS, -1);
      pipe.expire(turnsKey(id), TTL_SECONDS);
      await pipe.exec();
      return;
    } catch (err) {
      console.warn("[session] redis append failed (using memory):", err.message);
    }
  }
  const entry = memEntry(id, true);
  entry.turns.push(...clean);
  entry.turns = entry.turns.slice(-MAX_TURNS);
  entry.expires = Date.now() + TTL_SECONDS * 1000;
}

/** Forget a session's conversation ("new chat" / privacy). */
async function clear(id) {
  mem.delete(id);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(turnsKey(id), lockKey(id));
    } catch (err) {
      console.warn("[session] redis clear failed:", err.message);
    }
  }
}

/* ---------------------------------------------------------------------
   Per-session lock: one in-flight message per session, so concurrent
   requests can't interleave or double-spend LLM calls.
--------------------------------------------------------------------- */
/** @returns {Promise<string|null>} a release token, or null if already locked. */
async function acquire(id) {
  const token = crypto.randomBytes(8).toString("hex");
  const redis = getRedis();
  if (redis) {
    try {
      const ok = await redis.set(lockKey(id), token, { nx: true, ex: LOCK_TTL_SECONDS });
      return ok ? token : null;
    } catch (err) {
      console.warn("[session] redis lock failed (using memory):", err.message);
    }
  }
  const entry = memEntry(id, true);
  const now = Date.now();
  if (entry.lock && now < entry.lock.expires) return null;
  entry.lock = { token, expires: now + LOCK_TTL_SECONDS * 1000 };
  return token;
}

async function release(id, token) {
  if (!token) return;
  const redis = getRedis();
  if (redis) {
    try {
      if ((await redis.get(lockKey(id))) === token) await redis.del(lockKey(id));
    } catch (err) {
      console.warn("[session] redis unlock failed (lock expires on its own):", err.message);
    }
  }
  const entry = mem.get(id);
  if (entry && entry.lock && entry.lock.token === token) entry.lock = null;
}

function status() {
  return { redis: !!getRedis(), ttlSeconds: TTL_SECONDS, maxTurns: MAX_TURNS, memSessions: mem.size };
}

/** Clear the in-memory store (used by tests). */
function _resetMemory() {
  mem.clear();
}

module.exports = {
  COOKIE_NAME,
  newId,
  isValidId,
  idFromRequest,
  setCookie,
  clearCookie,
  load,
  append,
  clear,
  acquire,
  release,
  status,
  _resetMemory,
};
