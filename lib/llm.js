/**
 * LLM provider abstraction.
 *
 * Provider + model + key are configured via environment variables so you can
 * swap providers without touching code:
 *
 *   LLM_PROVIDER      groq | mistral | gemini | ollama   (default: groq; ollama = a local model, for free test runs)
 *   LLM_API_KEY       the API key for that provider (not needed for ollama)
 *   LLM_MODEL         optional override of the model that writes answers
 *   GUARD_MODEL       optional override of the input-guard model
 *   PLAN_MODEL        optional override of the tool-planner model
 *   VERIFY_MODEL      optional override of the answer-verifier model
 *   PROMPT_GUARD_MODEL  optional Prompt Guard model, or "off" to disable it
 *
 * Every stage of the pipeline can run on a DIFFERENT model. On Groq's free
 * tier rate limits are per model, so spreading answer / guard / verifier
 * across models keeps them from starving one another.
 *
 * Uses Node's built-in global fetch (Node 18+), so there is no HTTP dependency.
 */

const DEFAULTS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-20b",
    guardModel: "qwen/qwen3.8-27b",
    planModel: "qwen/qwen3.8-27b",
    verifyModel: "openai/gpt-oss-120b",
    promptGuardModel: "meta-llama/llama-prompt-guard-2-86m",
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
  },
  gemini: {
    // model is interpolated into the URL below
    model: "gemini-1.5-flash",
  },
  // A model running on this computer (https://ollama.com), for test runs that must not spend API tokens.
  // It needs no key, and every stage uses the one model: set LLM_MODEL (e.g. gpt-oss:20b) to change it.
  ollama: {
    url: "http://127.0.0.1:11434/v1/chat/completions",
    model: "llama3.2",
    local: true,
  },
};

const GENERATION = {
  temperature: 0.2,
  // gpt-oss is a reasoning model that spends some tokens "thinking" before the
  // visible answer, so give the budget a little more headroom than a plain model.
  maxTokens: 1024,
};

// Abort an upstream call if it hangs, so a slow provider can't hold the
// serverless function open until its max duration.
const REQUEST_TIMEOUT_MS = 15000;
// A 429 with a short Retry-After is retried once; anything longer is surfaced.
const MAX_RETRY_WAIT_MS = 3000;

const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * Per-turn usage meter. Each chat turn runs inside `metered()`; every successful
 * model call inside it adds its token counts, scoped by AsyncLocalStorage so
 * concurrent visitors can never see each other's numbers. Counts only — no text.
 */
const meterStore = new AsyncLocalStorage();

const emptyUsage = () => ({ calls: 0, prompt: 0, completion: 0, total: 0, byStage: {} });

function record(stage, usage) {
  const m = meterStore.getStore();
  if (!m) return;
  const p = Number(usage && usage.prompt) || 0;
  const c = Number(usage && usage.completion) || 0;
  m.calls += 1;
  m.prompt += p;
  m.completion += c;
  m.total += p + c;
  const s = m.byStage[stage] || (m.byStage[stage] = { calls: 0, prompt: 0, completion: 0 });
  s.calls += 1;
  s.prompt += p;
  s.completion += c;
}

/**
 * Run `fn` and report the model usage it caused. If `fn` throws, the error carries
 * `err.usage` so failed turns can be costed too.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ value: T, usage: { calls: number, prompt: number, completion: number, total: number, byStage: Record<string, {calls: number, prompt: number, completion: number}> } }>}
 */
async function metered(fn) {
  const usage = emptyUsage();
  try {
    const value = await meterStore.run(usage, fn);
    return { value, usage };
  } catch (err) {
    // A failed turn still spent tokens; let the caller log them.
    if (err && typeof err === "object") err.usage = usage;
    throw err;
  }
}

class LLMError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    Object.assign(this, extra);
  }
}

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const remainingMs = (deadline) => (deadline ? deadline - Date.now() : Infinity);

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new LLMError("The assistant took too long to respond. Please try again.", 504);
    }
    throw new LLMError("Could not reach the assistant service. Please try again.", 502);
  } finally {
    clearTimeout(timer);
  }
}

function currentProvider() {
  return (process.env.LLM_PROVIDER || "groq").toLowerCase();
}

/** A key is required, except for a local model, which has none. */
function hasCredentials(provider = currentProvider(), env = process.env) {
  return !!env.LLM_API_KEY || !!(DEFAULTS[provider] && DEFAULTS[provider].local);
}

function getConfig() {
  const provider = currentProvider();
  if (!DEFAULTS[provider]) {
    throw new LLMError(`Unsupported LLM_PROVIDER "${provider}". Use groq, mistral, gemini, or ollama.`, 500);
  }
  if (!hasCredentials(provider)) {
    throw new LLMError("The chat is not configured yet (missing LLM_API_KEY).", 500);
  }
  return { provider, apiKey: process.env.LLM_API_KEY || "local" };
}

/**
 * The model used for a stage of the pipeline.
 * @param {"main"|"guard"|"plan"|"verify"|"promptguard"} purpose
 * @returns {string|null} null when that stage is disabled / unavailable
 */
function resolveModel(purpose, provider = currentProvider()) {
  const d = DEFAULTS[provider];
  if (!d) return null;
  const main = process.env.LLM_MODEL || d.model;
  if (purpose === "main") return main;

  const override = {
    guard: process.env.GUARD_MODEL,
    plan: process.env.PLAN_MODEL,
    verify: process.env.VERIFY_MODEL,
    promptguard: process.env.PROMPT_GUARD_MODEL,
  }[purpose];
  if (override) return /^(off|none|false)$/i.test(override) ? null : override;

  if (purpose === "promptguard") return d.promptGuardModel || null; // Groq-only
  const stageDefault = { guard: d.guardModel, plan: d.planModel, verify: d.verifyModel }[purpose];
  return stageDefault || main;
}

async function upstreamError(res) {
  const detail = await safeText(res);
  if (res.status === 429) {
    const seconds = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    return new LLMError("The assistant is busy right now. Please try again in a few seconds.", 429, {
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0,
    });
  }
  const modelMissing = res.status === 404 || /model_not_found|decommission|does not exist/i.test(detail);
  return new LLMError(`Upstream LLM error (${res.status}): ${detail}`, 502, { modelMissing });
}

/** OpenAI-compatible providers (Groq, Mistral). */
async function requestOpenAICompatible({ url, apiKey, model, system, messages, trailer, temperature, maxTokens, timeoutMs, reasoning, onUsage }) {
  const payload = [];
  if (system) payload.push({ role: "system", content: system });
  payload.push(...messages);
  if (trailer) payload.push({ role: "system", content: trailer });

  const body = { model, messages: payload, temperature, max_tokens: maxTokens };
  if (reasoning) body.reasoning_effort = reasoning;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  // Count the tokens BEFORE validating the text: a reasoning model that spends its whole
  // budget "thinking" returns empty content, but the call was still billed.
  onUsage({ prompt: data?.usage?.prompt_tokens, completion: data?.usage?.completion_tokens });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new LLMError("Empty response from the model.", 502);
  return text.trim();
}

/** Google Gemini (different request/response shape). */
async function requestGemini({ apiKey, model, system, messages, trailer, temperature, maxTokens, timeoutMs, onUsage }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const systemText = [system, trailer].filter(Boolean).join("\n\n");

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  onUsage({ prompt: data?.usageMetadata?.promptTokenCount, completion: data?.usageMetadata?.candidatesTokenCount });
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new LLMError("Empty response from the model.", 502);
  return text.trim();
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "unknown error";
  }
}

async function once(cfg, model, o) {
  const budget = remainingMs(o.deadline);
  if (budget < 500) throw new LLMError("The assistant took too long to respond. Please try again.", 504);
  const timeoutMs = Math.min(o.timeoutMs, budget);
  // gpt-oss is a reasoning model: keep it brief for the small classification calls.
  const reasoning = o.purpose !== "main" && /^openai\/gpt-oss/.test(model) ? "low" : undefined;

  const onUsage = (usage) => record(o.purpose, usage);
  if (cfg.provider === "gemini") return requestGemini({ apiKey: cfg.apiKey, model, ...o, timeoutMs, onUsage });
  return requestOpenAICompatible({ url: DEFAULTS[cfg.provider].url, apiKey: cfg.apiKey, model, ...o, timeoutMs, reasoning, onUsage });
}

async function run(o) {
  const cfg = getConfig();
  const mainModel = resolveModel("main", cfg.provider);
  let model = resolveModel(o.purpose, cfg.provider);
  if (!model) throw new LLMError(`The "${o.purpose}" stage is not available for this provider.`, 500);

  let usedFallback = false;
  let retried = false;
  for (;;) {
    try {
      return await once(cfg, model, o);
    } catch (err) {
      if (!(err instanceof LLMError)) throw err;

      // A retired guard/verify model must not take the chat down: fall back to the main model once.
      if (err.modelMissing && !usedFallback && model !== mainModel && o.purpose !== "promptguard") {
        console.warn(`[llm] model "${model}" unavailable for "${o.purpose}"; falling back to "${mainModel}"`);
        model = mainModel;
        usedFallback = true;
        continue;
      }
      // One bounded retry when the provider says how long to wait.
      if (err.status === 429 && !retried && err.retryAfterMs > 0 && err.retryAfterMs <= MAX_RETRY_WAIT_MS && remainingMs(o.deadline) > err.retryAfterMs + 1500) {
        retried = true;
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Generate an assistant reply.
 * @param {string} systemPrompt - knowledge base + guardrails.
 * @param {Array<{role: "user"|"assistant", content: string}>} history
 * @param {string} [guard] - short reminder appended after the conversation.
 * @param {{ deadline?: number }} [options]
 * @returns {Promise<string>}
 */
function generateReply(systemPrompt, history, guard, options = {}) {
  return run({
    purpose: "main",
    system: systemPrompt,
    messages: history,
    trailer: guard,
    temperature: GENERATION.temperature,
    maxTokens: GENERATION.maxTokens,
    timeoutMs: REQUEST_TIMEOUT_MS,
    deadline: options.deadline,
  });
}

/**
 * A single completion for a pipeline stage (guard, verifier, Prompt Guard).
 * @param {{ purpose: "main"|"guard"|"plan"|"verify"|"promptguard", system?: string,
 *           messages: Array<{role: string, content: string}>, maxTokens?: number,
 *           temperature?: number, timeoutMs?: number, deadline?: number }} options
 * @returns {Promise<string>}
 */
function complete({ purpose, system, messages, maxTokens = 300, temperature = 0, timeoutMs = 8000, deadline }) {
  return run({ purpose, system, messages, temperature, maxTokens, timeoutMs, deadline });
}

/**
 * A compact signature of the parameters that shape a reply, for cache keys.
 * Deliberately does NOT require the API key (key derivation must work even
 * before the key is validated, and the key itself must never leak into a
 * cache key). Changing provider/model/params invalidates cached answers.
 * @returns {string}
 */
function cacheSignature() {
  const provider = currentProvider();
  const model = resolveModel("main", provider) || "unknown";
  return `${provider}:${model}:${GENERATION.temperature}:${GENERATION.maxTokens}`;
}

/** Test hook: replace the delay used between a 429 and its retry. */
function _setSleep(fn) {
  sleep = fn;
}

/**
 * Loads each model a LOCAL provider will use into memory, so the first real call is not slowed by it
 * (loading can take longer than a stage's time limit). Does nothing for a hosted provider.
 * @returns {Promise<string[]>} the models that were loaded
 */
async function warmUp({ timeoutMs = 180000 } = {}) {
  const cfg = getConfig();
  if (!DEFAULTS[cfg.provider].local) return [];
  const models = [...new Set(["main", "guard", "plan", "verify"].map((p) => resolveModel(p, cfg.provider)).filter(Boolean))];
  for (const model of models) {
    const res = await fetchWithTimeout(
      DEFAULTS[cfg.provider].url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }) },
      timeoutMs
    );
    if (!res.ok) throw await upstreamError(res);
  }
  return models;
}

module.exports = { generateReply, complete, metered, resolveModel, hasCredentials, warmUp, LLMError, cacheSignature, _setSleep };
