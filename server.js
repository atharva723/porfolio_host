const express = require("express");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv").config();
  } catch {
    /* dotenv is optional; only used for local development */
  }
}

const { buildSystemPrompt, buildGuardReminder, REFUSAL } = require("./lib/knowledge");
const { generateReply, LLMError } = require("./lib/llm");

const app = express();

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "16kb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Recruiter chat API ----

const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY_TURNS = 12; // user + assistant messages kept for context

// Best-effort in-memory rate limit. On Vercel serverless this resets per cold
// start (so it's a soft guard, not a hard quota), which is fine for a portfolio.
const RATE_LIMIT = { windowMs: 60 * 1000, max: 12 }; // per IP per minute
const DAILY_LIMIT = { windowMs: 24 * 60 * 60 * 1000, max: 200 }; // per IP per day
const hits = new Map();

function rateLimited(ip, limit, bucketName) {
  const now = Date.now();
  const key = `${bucketName}:${ip}`;
  const entry = hits.get(key);

  // Opportunistically drop expired entries so the map can't grow unbounded.
  if (hits.size > 5000) {
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
}

function sanitize(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

// Cheap first line of defense: catch blatant jailbreak / prompt-injection /
// system-prompt-extraction / off-topic-generation attempts and refuse them
// WITHOUT spending an LLM call. These patterns are extremely unlikely in a
// genuine question about a person, so false positives are rare.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|above|prior|your)\s+/i,
  /forget\s+(everything|all|your)\s+(you\s+know|instructions?|rules?|above)/i,
  /\b(system|developer)\s*(prompt|message|instructions?)\b/i,
  /\b(reveal|show|print|repeat|output|display|tell me|give me)\b.{0,40}\b(prompt|instructions?|rules?|system message|knowledge base)\b/i,
  /\b(repeat|print|echo|say)\b.{0,30}\b(the\s+)?(text|words|everything)\s+above\b/i,
  /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+to\s+be\b|\bfrom\s+now\s+on\b/i,
  /\b(developer|dan|jailbreak|god|admin|sudo|root)\s*mode\b|\bdo\s+anything\s+now\b|\bDAN\b/,
  /\b(write|generate|create|give|show|fix|debug|explain|complete)\b.{0,30}\b(code|program|script|function|snippet|algorithm|regex|sql query)\b/i,
  /\b(translate|rewrite|summarize|paraphrase)\b.{0,30}\b(this|the following|above|into)\b/i,
  /override\s+(your|the|all)\s+(instructions?|rules?|settings?)/i,
];

function looksLikeInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

app.post("/api/chat", async (req, res) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

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
    if (cleanMessage.length > MAX_MESSAGE_CHARS) {
      return res
        .status(400)
        .json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` });
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
          .slice(-MAX_HISTORY_TURNS)
          .map((m) => ({ role: m.role, content: sanitize(m.content).slice(0, MAX_MESSAGE_CHARS) }))
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

module.exports = app;
