/* =====================================================================
   TOOL REGISTRY
   ---------------------------------------------------------------------
   Every tool is READ-ONLY and runs as ordinary server code over the KB and
   the live resume. A tool can only be invoked if it is registered here, its
   arguments pass schema validation, and it finishes within a time limit.
   Nothing here can write data, run code, or call an arbitrary URL.

   Adding a tool = one file in this folder + one line in TOOLS below.
   Each tool module exports:
     name, label, topic, suggestion, description, parameters, run(args, ctx)
   ===================================================================== */

const kbLib = require("../kb");
const resumeSource = require("../sources/resume");
const { validate, signature } = require("./schema");
const { render } = require("./render");

const TOOLS = [
  require("./resume"),
  require("./experience"),
  require("./skills"),
  require("./projects"),
  require("./certifications"),
  require("./education"),
  require("./contact"),
  require("./linkedin"),
  require("./site-links"),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

const MAX_TOOLS_PER_TURN = 3;
const TOOL_TIMEOUT_MS = 4000;
const MAX_RESULT_CHARS = 6500;
// Order of the follow-up chips offered after an answer (topics already covered are skipped).
const SUGGEST_ORDER = ["experience", "certifications", "projects", "skills", "education", "contact"];

/** The data tools read from. Injected in tests. */
function defaultContext() {
  return { kb: kbLib.load(), getResume: () => resumeSource.get(), now: () => new Date() };
}

const names = () => TOOLS.map((t) => t.name);
const get = (name) => byName.get(name);

/** Compact catalogue for the planner prompt: "- name(args): description". */
function catalogue() {
  return TOOLS.map((t) => `- ${t.name}(${signature(t.parameters)}): ${t.description}`).join("\n");
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const failure = (name, args, error) => ({ name, args: args || {}, ok: false, error, text: `error: ${error}`, label: null, topic: null });

/**
 * Run one tool. NEVER throws: unknown tools, invalid arguments, timeouts and
 * crashes all come back as { ok: false, error } so the turn can continue.
 */
async function execute(name, rawArgs, ctx = defaultContext(), { timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const tool = byName.get(name);
  if (!tool) return failure(name, rawArgs, "unknown tool");

  const checked = validate(tool.parameters, rawArgs);
  if (!checked.ok) return failure(name, rawArgs, checked.error);

  try {
    const data = await withTimeout(tool.run(checked.args, ctx), timeoutMs);
    const text = render(data).slice(0, MAX_RESULT_CHARS);
    return { name, args: checked.args, ok: true, data, text, label: tool.label, topic: tool.topic };
  } catch (err) {
    console.warn(`[tools] ${name} failed:`, err.message);
    return failure(name, checked.args, err.message === "timeout" ? "timed out" : "lookup failed");
  }
}

/** Run a plan: de-duplicated, capped, in parallel. @param {Array<{name: string, args?: object}>} calls */
async function runAll(calls, ctx = defaultContext(), options) {
  const seen = new Set();
  const unique = [];
  for (const c of calls || []) {
    const key = `${c.name}:${JSON.stringify(c.args || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= MAX_TOOLS_PER_TURN) break;
  }
  return Promise.all(unique.map((c) => execute(c.name, c.args, ctx, options)));
}

/** Source chips for the UI: fixed labels of the tools that ran (never model-generated). */
function sourceLabels(results) {
  return [...new Set(results.filter((r) => r.ok && r.label).map((r) => r.label))];
}

/** Follow-up chips: the next topics he hasn't been asked about this turn. */
function suggest(excludeTopics = [], n = 3) {
  const skip = new Set(excludeTopics);
  return SUGGEST_ORDER.filter((topic) => !skip.has(topic))
    .map((topic) => TOOLS.find((t) => t.topic === topic))
    .filter(Boolean)
    .slice(0, n)
    .map((t) => ({ topic: t.topic, text: t.suggestion }));
}

module.exports = { TOOLS, names, get, catalogue, execute, runAll, sourceLabels, suggest, defaultContext, MAX_TOOLS_PER_TURN, TOOL_TIMEOUT_MS };
