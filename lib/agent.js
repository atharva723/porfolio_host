/* =====================================================================
   AGENT PIPELINE — one chat turn, end to end
   ---------------------------------------------------------------------
     cache hit? ─────────────────────────────► answer (already verified)
          │ miss
          ▼
     input guard (LLM policy + Prompt Guard)
          │ allow            │ off_topic → redirect
          │                  │ injection → refusal
          │                  │ unsafe    → decline
          ▼
     planner  (small model picks tools + arguments as validated JSON)
          ▼
     tools    (read-only code over the KB + live resume, run in parallel)
          ▼
     answer model (no tools; sees only the results)
          ▼
     verifier (deterministic grounding + LLM check against the results)
          │ supported ──► cache + return
          │ not supported ─► regenerate ONCE with generic feedback ─► verify
          │                  still not supported ─► honest "can't confirm"
          ▼
     checks unavailable ─► 503 (never answers unchecked)

   If the planner cannot produce a usable plan the turn falls back to
   "context mode": the whole KB + resume go in the prompt (bigger, same
   guarantees). Only verified answers are cached and only answered turns
   enter the session history (`store: true`).
   ===================================================================== */

const crypto = require("crypto");
const llm = require("./llm");
const cache = require("./cache");
const guard = require("./guard");
const planner = require("./planner");
const verify = require("./verify");
const messages = require("./messages");
const tools = require("./tools");
const kbLib = require("./kb");
const { buildSystemPrompt, buildAnswerPrompt, buildGuardReminder, buildEvidence, profileCard, REGENERATE_FEEDBACK } = require("./knowledge");
const resumeSource = require("./sources/resume");

const CACHE_VERSION = `chat-v3|plan-v2|${guard.POLICY_VERSION}|${verify.VERIFY_VERSION}`;
// Skip the regeneration if there isn't enough time left to also re-verify it.
const MIN_RETRY_BUDGET_MS = 9000;
const SUGGESTION_COUNT = 3;

const budgetMs = () => {
  const n = Number(process.env.CHAT_BUDGET_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 25000;
};

/** Changes whenever the KB or the live resume changes, so stale cached answers can't be served. */
function dataFingerprint(resume) {
  const resumeText = resume && resume.available ? resume.text : "no-resume";
  return crypto.createHash("sha256").update(`${kbLib.version()}|${resumeText}`).digest("hex").slice(0, 16);
}

/** Earlier assistant replies were verified, so they may support a follow-up ("summarise that"). */
const earlierReplies = (history) =>
  history
    .filter((m) => m.role === "assistant")
    .slice(-2)
    .map((m) => ({ label: "earlier_reply", text: String(m.content).slice(0, 700) }));

const suggestionsFor = (topics) => tools.suggest(topics, SUGGESTION_COUNT).map((s) => s.text);

function parseCached(value) {
  try {
    const c = JSON.parse(value);
    if (c && typeof c.reply === "string" && Array.isArray(c.sources) && Array.isArray(c.topics)) return c;
  } catch {
    /* treat a corrupt entry as a miss */
  }
  return null;
}

/** Decide what the answer model gets to see: lookup results (default) or the whole KB (fallback). */
async function prepare({ message, lastAssistant, history, resume, deadline, trace }) {
  const planned = await timed(trace, "plan", () => planner.plan({ message, lastAssistant, deadline }));
  trace.planner = planned.ok ? "ok" : planned.reason;

  if (!planned.ok) {
    trace.mode = "context";
    return {
      systemPrompt: buildSystemPrompt({ resume }),
      evidence: buildEvidence({ resume }),
      sources: resume && resume.available ? ["Live resume", "Knowledge base"] : ["Knowledge base"],
      topics: [],
    };
  }

  trace.mode = "lookup";
  // The resume was already fetched for this turn; hand the same copy to the tools.
  const ctx = { ...tools.defaultContext(), getResume: async () => resume };
  const lookups = await timed(trace, "tools", () => tools.runAll(planned.calls, ctx));
  trace.tools = lookups.map((l) => ({ name: l.name, ok: l.ok }));

  return {
    systemPrompt: buildAnswerPrompt({ lookups }),
    evidence: [{ label: "profile", text: profileCard() }, ...lookups.map((l) => ({ label: l.name, text: l.text })), ...earlierReplies(history)],
    sources: tools.sourceLabels(lookups),
    topics: lookups.filter((l) => l.ok).map((l) => l.topic),
  };
}

/** Run `fn`, adding its wall-clock time to trace.ms[stage] (latency observability; no content). */
async function timed(trace, stage, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    trace.ms[stage] = (trace.ms[stage] || 0) + (Date.now() - t0);
  }
}

/**
 * @param {{ message: string, history: Array<{role: string, content: string}>, deadline?: number }} input
 * @returns {Promise<{ kind: "answer"|"redirect"|"refusal"|"decline"|"unverified", reply: string, cached: boolean,
 *                     store: boolean, sources: string[], suggestions: string[], trace: object }>}
 *   trace.ms = milliseconds per stage; trace.usage = model calls and tokens for the whole turn.
 */
async function run(input) {
  const { value, usage } = await llm.metered(() => runTurn(input));
  value.trace.usage = usage;
  return value;
}

async function runTurn({ message, history, deadline = Date.now() + budgetMs() }) {
  const conversation = [...history, { role: "user", content: message }];
  const trace = { mode: null, guard: null, planner: null, tools: [], verify: [], regenerated: false, ms: {} };

  const resume = await resumeSource.get();
  const reminder = buildGuardReminder();

  // The key covers the rules, model settings, KB + resume content and the whole conversation.
  const cacheKey = cache.makeKey([CACHE_VERSION, llm.cacheSignature(), buildAnswerPrompt(), reminder, dataFingerprint(resume), JSON.stringify(conversation)]);
  const hit = await timed(trace, "cache", () => cache.get(cacheKey));
  const cached = hit && parseCached(hit.value);
  if (cached) {
    return { kind: "answer", reply: cached.reply, cached: true, store: true, sources: cached.sources, suggestions: suggestionsFor(cached.topics), trace: { ...trace, cacheLayer: hit.layer } };
  }

  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const verdict = await timed(trace, "guard", () => guard.check({ message, lastAssistant: lastAssistant && lastAssistant.content, deadline }));
  trace.guard = { verdict: verdict.verdict, source: verdict.source, cached: verdict.cached };

  const notAnswered = (kind, reply) => ({ kind, reply, cached: false, store: false, sources: [], suggestions: suggestionsFor([]), trace });
  if (verdict.verdict === "off_topic") return notAnswered("redirect", messages.redirect());
  if (verdict.verdict === "injection") return notAnswered("refusal", messages.refusal());
  if (verdict.verdict === "unsafe") return notAnswered("decline", messages.decline());

  const turn = await prepare({ message, lastAssistant: lastAssistant && lastAssistant.content, history, resume, deadline, trace });

  let reply = await timed(trace, "answer", () => llm.generateReply(turn.systemPrompt, conversation, reminder, { deadline }));
  let result = await timed(trace, "verify", () => verify.check({ question: message, answer: reply, evidence: turn.evidence, deadline }));
  trace.verify.push({ supported: result.supported, via: result.via, problems: result.problems });

  if (!result.supported && deadline - Date.now() > MIN_RETRY_BUDGET_MS) {
    trace.regenerated = true;
    reply = await timed(trace, "answer", () => llm.generateReply(turn.systemPrompt, conversation, `${reminder}\n\n${REGENERATE_FEEDBACK}`, { deadline }));
    result = await timed(trace, "verify", () => verify.check({ question: message, answer: reply, evidence: turn.evidence, deadline }));
    trace.verify.push({ supported: result.supported, via: result.via, problems: result.problems });
  }

  if (!result.supported) return notAnswered("unverified", messages.unverified());

  // Await the store so the durable (Redis) write finishes before a serverless
  // instance can freeze after the response is sent.
  await cache.set(cacheKey, JSON.stringify({ reply, sources: turn.sources, topics: turn.topics }));
  return { kind: "answer", reply, cached: false, store: true, sources: turn.sources, suggestions: suggestionsFor(turn.topics), trace };
}

module.exports = { run, CACHE_VERSION, dataFingerprint };
