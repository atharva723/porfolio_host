/* =====================================================================
   HEALTH SNAPSHOT — configuration readiness, no secrets, no network
   ---------------------------------------------------------------------
   Used by GET /api/health (uptime monitors) and scripts/check-env.js.
   Everything here is a boolean or a content hash/date: it never returns an
   environment value, a key, or an error message, so it is safe to expose.
   It performs no network calls, so it is cheap and cannot be slowed down
   by Google, Redis or the LLM provider.
   ===================================================================== */

const kb = require("./kb");
const llm = require("./llm");
const { getRedis } = require("./redis");
const resume = require("./sources/resume");
const download = require("./sources/resume-download");

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ready: boolean, checks: Record<string, boolean>, kb: object }}
 */
function snapshot(env = process.env) {
  let kbInfo;
  try {
    const k = kb.load();
    kbInfo = { valid: true, updated: k.updated, version: kb.version(k), linkedinAsOf: k.linkedin ? k.linkedin.asOf : null };
  } catch {
    kbInfo = { valid: false };
  }

  const provider = (env.LLM_PROVIDER || "groq").toLowerCase();
  const checks = {
    llm: !!env.LLM_API_KEY && !!llm.resolveModel("main", provider),
    kb: kbInfo.valid,
    redis: !!getRedis(),
    resume: !!resume.parseResumeUrl(env.RESUME_DOC_URL),
    download: !!download.exportUrl(env),
  };

  // "ready" = the assistant can answer. Redis, the live resume and the download are optional.
  return { ready: checks.llm && checks.kb, checks, kb: kbInfo };
}

module.exports = { snapshot };
