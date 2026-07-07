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

const { buildSystemPrompt, buildGuardReminder, REFUSAL } = require("./lib/knowledge");
const { generateReply, LLMError } = require("./lib/llm");
const { sanitize, looksLikeInjection, createRateLimiter } = require("./lib/guards");
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

// Best-effort in-memory rate limit. On Vercel serverless this resets per cold
// start (so it's a soft guard, not a hard quota), which is fine for a portfolio.
const RATE_LIMIT = { windowMs: CONFIG.ONE_MINUTE_MS, max: CONFIG.RATE_PER_MINUTE };
const DAILY_LIMIT = { windowMs: CONFIG.ONE_DAY_MS, max: CONFIG.RATE_PER_DAY };
const rateLimited = createRateLimiter();

app.post("/api/chat", async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";

    if (rateLimited(ip, RATE_LIMIT, "min") || rateLimited(ip, DAILY_LIMIT, "day")) {
      return res
        .status(429)
        .json({ error: "You're sending messages too quickly. Please wait a moment and try again." });
    }

    const { message, history } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Please enter a message." });
    }
    const cleanMessage = sanitize(message);
    if (cleanMessage.length > CONFIG.MAX_MESSAGE_CHARS) {
      return res
        .status(400)
        .json({ error: `Message is too long (max ${CONFIG.MAX_MESSAGE_CHARS} characters).` });
    }

    // Short-circuit obvious injection / out-of-scope generation attempts.
    if (looksLikeInjection(cleanMessage)) {
      return res.json({ reply: REFUSAL });
    }

    // Build a clean, validated conversation history.
    const safeHistory = Array.isArray(history)
      ? history
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim()
          )
          .slice(-CONFIG.MAX_HISTORY_TURNS)
          .map((m) => ({ role: m.role, content: sanitize(m.content).slice(0, CONFIG.MAX_MESSAGE_CHARS) }))
      : [];

    const conversation = [...safeHistory, { role: "user", content: cleanMessage }];

    const reply = await generateReply(buildSystemPrompt(), conversation, buildGuardReminder());
    return res.json({ reply });
  } catch (err) {
    const status = err instanceof LLMError ? err.status : 500;
    console.error("[/api/chat]", err.message);
    // Pass through our own safe LLMError messages (config/rate-limit); hide
    // raw upstream/internal details behind a generic message.
    const clientMessage =
      err instanceof LLMError && status !== 502
        ? err.message
        : "Sorry, the assistant is unavailable right now. Please try again later.";
    return res.status(status).json({ error: clientMessage });
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
