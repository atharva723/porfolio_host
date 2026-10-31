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
     generate answer (sources in the prompt)
          ▼
     verify answer (deterministic grounding + LLM check)
          │ supported ─► cache + return
          │ not supported ─► regenerate ONCE with generic feedback ─► verify
          │                  still not supported ─► honest "can't confirm"
          ▼
     checks unavailable ─► 503 (never answers unchecked)

   Only verified answers are cached and only answered turns enter the
   session history (`store: true`); redirects, refusals and fallbacks do not.
   ===================================================================== */

const llm = require("./llm");
const cache = require("./cache");
const guard = require("./guard");
const verify = require("./verify");
const messages = require("./messages");
const { buildSystemPrompt, buildGuardReminder, buildEvidence, REGENERATE_FEEDBACK } = require("./knowledge");
const resumeSource = require("./sources/resume");

const CACHE_VERSION = `chat-v2|${guard.POLICY_VERSION}|${verify.VERIFY_VERSION}`;
// Skip the regeneration if there isn't enough time left to also re-verify it.
const MIN_RETRY_BUDGET_MS = 9000;

const budgetMs = () => {
  const n = Number(process.env.CHAT_BUDGET_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 25000;
};

/**
 * @param {{ message: string, history: Array<{role: string, content: string}>, deadline?: number }} input
 * @returns {Promise<{ kind: "answer"|"redirect"|"refusal"|"decline"|"unverified", reply: string, cached: boolean, store: boolean, trace: object }>}
 */
async function run({ message, history, deadline = Date.now() + budgetMs() }) {
  const conversation = [...history, { role: "user", content: message }];
  const trace = { guard: null, verify: [], regenerated: false };

  // The live resume is part of the system prompt, so it is also part of the cache
  // key: editing the Google Doc (or kb.json) transparently invalidates stale answers.
  const resume = await resumeSource.get();
  const systemPrompt = buildSystemPrompt({ resume });
  const reminder = buildGuardReminder();
  const evidence = buildEvidence({ resume });

  const cacheKey = cache.makeKey([CACHE_VERSION, llm.cacheSignature(), systemPrompt, reminder, JSON.stringify(conversation)]);
  const hit = await cache.get(cacheKey);
  if (hit) return { kind: "answer", reply: hit.value, cached: true, store: true, trace: { ...trace, cacheLayer: hit.layer } };

  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const verdict = await guard.check({ message, lastAssistant: lastAssistant && lastAssistant.content, deadline });
  trace.guard = { verdict: verdict.verdict, source: verdict.source, cached: verdict.cached };
  if (verdict.verdict === "off_topic") return { kind: "redirect", reply: messages.redirect(), cached: false, store: false, trace };
  if (verdict.verdict === "injection") return { kind: "refusal", reply: messages.refusal(), cached: false, store: false, trace };
  if (verdict.verdict === "unsafe") return { kind: "decline", reply: messages.decline(), cached: false, store: false, trace };

  let reply = await llm.generateReply(systemPrompt, conversation, reminder, { deadline });
  let result = await verify.check({ question: message, answer: reply, evidence, deadline });
  trace.verify.push({ supported: result.supported, via: result.via, problems: result.problems });

  if (!result.supported && deadline - Date.now() > MIN_RETRY_BUDGET_MS) {
    trace.regenerated = true;
    reply = await llm.generateReply(systemPrompt, conversation, `${reminder}\n\n${REGENERATE_FEEDBACK}`, { deadline });
    result = await verify.check({ question: message, answer: reply, evidence, deadline });
    trace.verify.push({ supported: result.supported, via: result.via, problems: result.problems });
  }

  if (!result.supported) return { kind: "unverified", reply: messages.unverified(), cached: false, store: false, trace };

  // Await the store so the durable (Redis) write finishes before a serverless
  // instance can freeze after the response is sent.
  await cache.set(cacheKey, reply);
  return { kind: "answer", reply, cached: false, store: true, trace };
}

module.exports = { run, CACHE_VERSION };
