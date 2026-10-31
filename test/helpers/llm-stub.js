/* Test helper: replaces every LLM call with a deterministic, inspectable stub.
   Modules call `llm.generateReply` / `llm.complete` through the module object,
   so patching the exports here is picked up everywhere. Never touches the network. */

const llm = require("../../lib/llm");

const ALLOW = () => ({ verdict: "allow", reason: "ok" });
const SUPPORTED = () => ({ supported: true, issues: [] });

/**
 * @param {{
 *   reply?: string | ((ctx: {conversation: object[], trailer: string, n: number}) => string),
 *   guard?: (o: object) => object | string,
 *   verify?: (o: object) => object | string,
 *   promptGuard?: (o: object) => number | string,
 * }} [opts]
 * Handlers may throw to simulate an outage. Returns a state object with `calls`.
 */
function installLlmStub(opts = {}) {
  const state = {
    calls: [],
    reply: opts.reply === undefined ? "MOCKED_REPLY" : opts.reply,
    guard: opts.guard || ALLOW,
    verify: opts.verify || SUPPORTED,
    promptGuard: opts.promptGuard || (() => 0.001),
    count: (purpose) => state.calls.filter((c) => c.purpose === purpose).length,
    reset() {
      state.calls.length = 0;
    },
  };

  llm.generateReply = async (system, conversation, trailer, options) => {
    state.calls.push({ purpose: "main", system, conversation, trailer, options });
    const n = state.count("main");
    return typeof state.reply === "function" ? state.reply({ conversation, trailer, n }) : state.reply;
  };

  llm.complete = async (o) => {
    state.calls.push({ ...o });
    const handler = { guard: state.guard, verify: state.verify, promptguard: state.promptGuard }[o.purpose];
    if (!handler) throw new Error(`unexpected purpose ${o.purpose}`);
    const out = handler(o);
    return typeof out === "string" ? out : o.purpose === "promptguard" ? String(out) : JSON.stringify(out);
  };

  return state;
}

module.exports = { installLlmStub, ALLOW, SUPPORTED };
