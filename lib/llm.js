/**
 * LLM provider abstraction.
 *
 * Provider + model + key are configured via environment variables so you can
 * swap providers without touching code:
 *
 *   LLM_PROVIDER  groq | mistral | gemini      (default: groq)
 *   LLM_API_KEY   the API key for that provider
 *   LLM_MODEL     optional model override
 *
 * Recommended free tier: Groq (https://console.groq.com) — no credit card,
 * very high daily limits, fast Llama 3.3 70B.
 *
 * Uses Node's built-in global fetch (Node 18+), so there is no HTTP dependency.
 */

const DEFAULTS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.1-8b-instant",
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
  },
  gemini: {
    // model is interpolated into the URL below
    model: "gemini-1.5-flash",
  },
};

const GENERATION = {
  temperature: 0.4,
  maxTokens: 600,
};

class LLMError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
}

function getConfig() {
  const provider = (process.env.LLM_PROVIDER || "groq").toLowerCase();
  const apiKey = process.env.LLM_API_KEY;
  if (!DEFAULTS[provider]) {
    throw new LLMError(`Unsupported LLM_PROVIDER "${provider}". Use groq, mistral, or gemini.`, 500);
  }
  if (!apiKey) {
    throw new LLMError("The chat is not configured yet (missing LLM_API_KEY).", 500);
  }
  const model = process.env.LLM_MODEL || DEFAULTS[provider].model;
  return { provider, apiKey, model };
}

/**
 * OpenAI-compatible providers (Groq, Mistral).
 */
async function callOpenAICompatible({ url, apiKey, model, systemPrompt, history }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: GENERATION.temperature,
      max_tokens: GENERATION.maxTokens,
    }),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 429) {
      throw new LLMError("The assistant is busy right now. Please try again in a few seconds.", 429);
    }
    throw new LLMError(`Upstream LLM error (${res.status}): ${detail}`, 502);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new LLMError("Empty response from the model.", 502);
  return text.trim();
}

/**
 * Google Gemini (different request/response shape).
 */
async function callGemini({ apiKey, model, systemPrompt, history }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: GENERATION.temperature,
        maxOutputTokens: GENERATION.maxTokens,
      },
    }),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 429) {
      throw new LLMError("The assistant is busy right now. Please try again in a few seconds.", 429);
    }
    throw new LLMError(`Upstream LLM error (${res.status}): ${detail}`, 502);
  }
  const data = await res.json();
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

/**
 * Generate an assistant reply.
 * @param {string} systemPrompt - knowledge base + guardrails.
 * @param {Array<{role: "user"|"assistant", content: string}>} history
 * @returns {Promise<string>}
 */
async function generateReply(systemPrompt, history) {
  const { provider, apiKey, model } = getConfig();
  if (provider === "gemini") {
    return callGemini({ apiKey, model, systemPrompt, history });
  }
  return callOpenAICompatible({
    url: DEFAULTS[provider].url,
    apiKey,
    model,
    systemPrompt,
    history,
  });
}

module.exports = { generateReply, LLMError };
