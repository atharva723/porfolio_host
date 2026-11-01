const express = require("express");
const path = require("path");
const helmet = require("helmet");

if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv").config();
  } catch {
    /* dotenv is optional; only used for local development */
  }
}

const { REFUSAL } = require("./lib/knowledge");
const { LLMError } = require("./lib/llm");
const { sanitize, looksLikeInjection } = require("./lib/guards");
const session = require("./lib/session");
const rateLimit = require("./lib/ratelimit");
const agent = require("./lib/agent");
const resumeDownload = require("./lib/sources/resume-download");
const CONFIG = require("./public/js/config.js");

const app = express();

// Trust the first proxy hop (Vercel) so req.ip reflects the real client and
// isn't blindly taken from a client-spoofable X-Forwarded-For.
app.set("trust proxy", 1);

// Security headers. CSP is tuned for the site's external assets (Google Fonts,
// Font Awesome CDN) and its inline style attributes; all scripts are local.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "16kb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Recruiter chat API ----

// Limits are enforced with shared Redis counters (see lib/ratelimit.js), so
// they hold across serverless instances; they fall back to per-instance memory
// if Redis is unavailable.
const RATE_LIMITS = [
  { bucket: "min", windowMs: CONFIG.ONE_MINUTE_MS, max: CONFIG.RATE_PER_MINUTE },
  { bucket: "day", windowMs: CONFIG.ONE_DAY_MS, max: CONFIG.RATE_PER_DAY },
];
// Reading/clearing the transcript is cheap but still bounded.
const HISTORY_LIMITS = [{ bucket: "hist", windowMs: CONFIG.ONE_MINUTE_MS, max: 30 }];

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

function tooManyRequests(res, limit) {
  res.set("Retry-After", String(limit.retryAfterSeconds));
  return res
    .status(429)
    .json({ error: "You're sending messages too quickly. Please wait a moment and try again." });
}

// ---- Resume download ----
// A stable link on this site that sends the visitor to the PDF export of the resume
// Google Doc. The target is rebuilt from a validated document id in the environment and
// never from the request, so it cannot be used as an open redirect.
const RESUME_LIMITS = [{ bucket: "resume", windowMs: CONFIG.ONE_MINUTE_MS, max: 20 }];

app.get(resumeDownload.ROUTE, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const limit = await rateLimit.check(clientIp(req), RESUME_LIMITS);
    if (limit.limited) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).type("text/plain").send("Too many requests. Please try again in a moment.");
    }
    const target = resumeDownload.exportUrl();
    console.info(JSON.stringify({ evt: "resume_download", available: !!target }));
    if (!target) return res.status(404).type("text/plain").send("The resume download is not available right now.");
    return res.redirect(302, target);
  } catch (err) {
    console.error("[/resume.pdf]", err.message);
    return res.status(500).type("text/plain").send("Could not start the download. Please try again.");
  }
});

// Restore the visitor's transcript (e.g. after a page reload). The session id
// comes from an HttpOnly cookie; no id means no history.
app.get("/api/chat/history", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const limit = await rateLimit.check(clientIp(req), HISTORY_LIMITS);
    if (limit.limited) return tooManyRequests(res, limit);

    const id = session.idFromRequest(req);
    const messages = id ? await session.load(id) : [];
    return res.json({ messages });
  } catch (err) {
    console.error("[/api/chat/history]", err.message);
    return res.status(500).json({ error: "Could not load the conversation." });
  }
});

// "New chat": forget the conversation server-side and drop the cookie.
app.delete("/api/chat/history", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const limit = await rateLimit.check(clientIp(req), HISTORY_LIMITS);
    if (limit.limited) return tooManyRequests(res, limit);

    const id = session.idFromRequest(req);
    if (id) await session.clear(id);
    session.clearCookie(res, req.secure);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[/api/chat/history]", err.message);
    return res.status(500).json({ error: "Could not clear the conversation." });
  }
});

app.post("/api/chat", async (req, res) => {
  let sessionId = null;
  let lockToken = null;

  // Release the session lock BEFORE responding: a serverless instance may be
  // frozen as soon as the response is sent.
  const respond = async (status, body) => {
    if (lockToken) {
      await session.release(sessionId, lockToken);
      lockToken = null;
    }
    return res.status(status).json(body);
  };

  try {
    const limit = await rateLimit.check(clientIp(req), RATE_LIMITS);
    if (limit.limited) return tooManyRequests(res, limit);

    // The client sends only the new message. Conversation history is owned by
    // the server (Redis), so a visitor cannot forge earlier assistant turns.
    const { message } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      return respond(400, { error: "Please enter a message." });
    }
    const cleanMessage = sanitize(message);
    if (cleanMessage.length > CONFIG.MAX_MESSAGE_CHARS) {
      return respond(400, { error: `Message is too long (max ${CONFIG.MAX_MESSAGE_CHARS} characters).` });
    }

    // Short-circuit blatant prompt-injection phrases for free (no model call).
    // Everything subtler is judged by the LLM guard inside agent.run().
    // Blocked messages are never stored in the session history.
    if (looksLikeInjection(cleanMessage)) {
      return respond(200, { reply: REFUSAL, cached: false, kind: "refusal" });
    }

    sessionId = session.idFromRequest(req) || session.newId();
    session.setCookie(res, sessionId, req.secure);

    lockToken = await session.acquire(sessionId);
    if (!lockToken) {
      return respond(409, { error: "I'm still answering your previous message. Please wait a moment." });
    }

    const history = await session.load(sessionId);
    const started = Date.now();
    const out = await agent.run({ message: cleanMessage, history });

    // One structured line per turn for Vercel logs: counts and names only, never message text.
    console.info(
      JSON.stringify({
        evt: "chat",
        kind: out.kind,
        cached: out.cached,
        mode: out.trace.mode,
        guard: out.trace.guard && out.trace.guard.verdict,
        tools: (out.trace.tools || []).map((t) => t.name),
        regenerated: out.trace.regenerated,
        ms: Date.now() - started,
      })
    );

    // Only answered turns enter the conversation memory; redirects, refusals and
    // "couldn't confirm" replies are shown to the visitor but never remembered.
    if (out.store) {
      await session.append(sessionId, [
        { role: "user", content: cleanMessage },
        { role: "assistant", content: out.reply },
      ]);
    }
    return respond(200, { reply: out.reply, cached: out.cached, kind: out.kind, sources: out.sources, suggestions: out.suggestions });
  } catch (err) {
    const status = err instanceof LLMError ? err.status : 500;
    console.error("[/api/chat]", err.message);
    // Pass through our own safe LLMError messages (config/rate-limit); hide
    // raw upstream/internal details behind a generic message.
    const clientMessage =
      err instanceof LLMError && status !== 502
        ? err.message
        : "Sorry, the assistant is unavailable right now. Please try again later.";
    return respond(status, { error: clientMessage });
  }
});

// Azure assigns a PORT dynamically
const PORT = process.env.PORT || 5000;

// Only start listening when run directly (`node server.js`), so tests can
// import the app without opening a port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
