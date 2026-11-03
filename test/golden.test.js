const test = require("node:test");
const assert = require("node:assert");

process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.RESUME_DOC_URL = "";
process.env.RESUME_PDF_DOC_URL = "";

const tools = require("../lib/tools");
const kbLib = require("../lib/kb");
const { looksLikeInjection } = require("../lib/guards");
const { checkGrounding } = require("../lib/grounding");
const { RESUME_TEXT } = require("./helpers/fixtures");

const guardCases = require("./golden/guard-cases.json");
const planCases = require("./golden/plan-cases.json");
const verifyCases = require("./golden/verify-cases.json");
const retrievalCases = require("./golden/retrieval-cases.json");
const e2eCases = require("./golden/e2e-cases.json");
const conversationCases = require("./golden/conversation-cases.json");
const poisonCases = require("./golden/poison-cases.json");

/* =====================================================================
   GOLDEN SET — offline, deterministic, runs on every `npm test`.
   The same case files drive `npm run eval:live`, which sends them to the
   REAL models. This file guarantees the case files are well-formed, that the
   deterministic layers (regex pre-filter, grounding checks, tools) already
   behave as the cases expect, and that the set covers every tool.
   ===================================================================== */

const KINDS = new Set(["answer", "redirect", "refusal", "decline", "unverified"]);
const regexOf = (source, where) => {
  try {
    return new RegExp(source, "i");
  } catch (err) {
    assert.fail(`${where}: invalid regex "${source}" (${err.message})`);
  }
};

/* ---- shape ---- */
test("guard cases: well-formed, unique, and cover all four verdicts", () => {
  const verdicts = new Set();
  const seen = new Set();
  for (const c of guardCases) {
    assert.ok(typeof c.message === "string" && c.message.length > 3, JSON.stringify(c));
    assert.ok(["allow", "off_topic", "injection", "unsafe"].includes(c.expect), c.message);
    assert.ok(!seen.has(c.message + (c.lastAssistant || "")), `duplicate: ${c.message}`);
    seen.add(c.message + (c.lastAssistant || ""));
    verdicts.add(c.expect);
  }
  assert.deepEqual([...verdicts].sort(), ["allow", "injection", "off_topic", "unsafe"]);
  assert.ok(guardCases.filter((c) => c.expect === "injection").length >= 6, "enough injection styles");
});

test("guard cases: the free regex pre-filter NEVER blocks a legitimate message and only flags real attacks", () => {
  for (const c of guardCases) {
    const flagged = looksLikeInjection(c.message);
    if (c.expect === "allow") assert.equal(flagged, false, `pre-filter must not block: ${c.message}`);
    if (flagged) assert.equal(c.expect, "injection", `pre-filter flagged a non-injection case: ${c.message}`);
  }
});

test("plan cases: well-formed and every referenced tool is registered", () => {
  const registered = new Set(tools.names());
  for (const c of planCases) {
    assert.ok(typeof c.message === "string" && c.message.length > 1, JSON.stringify(c));
    const modes = [c.empty ? 1 : 0, c.include ? 1 : 0, c.anyOf ? 1 : 0].reduce((a, b) => a + b, 0);
    assert.equal(modes, 1, `exactly one of empty/include/anyOf: ${c.message}`);
    for (const name of [...(c.include || []), ...(c.anyOf || [])]) assert.ok(registered.has(name), `${name} is not a registered tool (${c.message})`);
  }
  assert.ok(planCases.some((c) => c.lastAssistant), "has follow-up cases");
  assert.ok(planCases.some((c) => c.empty), "has no-tool cases");
});

test("verify cases: well-formed, balanced, and each hallucination type is represented", () => {
  const ids = new Set();
  for (const c of verifyCases) {
    for (const f of ["id", "question", "answer"]) assert.ok(typeof c[f] === "string" && c[f], `${c.id} ${f}`);
    assert.equal(typeof c.supported, "boolean", c.id);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
  }
  assert.ok(verifyCases.filter((c) => c.supported).length >= 6, "enough supported answers (false-positive guard)");
  assert.ok(verifyCases.filter((c) => !c.supported).length >= 8, "enough hallucinations");
  for (const needed of ["fake-cert", "fake-employer", "fake-seniority", "fake-capability", "fake-link", "fake-year", "wrong-date"]) assert.ok(ids.has(needed), needed);
});

test("e2e, conversation and poison cases: well-formed with valid kinds and compilable patterns", () => {
  for (const c of e2eCases) {
    assert.ok(KINDS.has(c.kind), c.message);
    for (const f of ["match", "notMatch"]) if (c[f]) regexOf(c[f], `e2e "${c.message}" ${f}`);
  }
  for (const kind of ["answer", "redirect", "refusal", "decline"]) assert.ok(e2eCases.some((c) => c.kind === kind), `e2e covers ${kind}`);

  for (const conv of conversationCases) {
    assert.ok(conv.id && conv.turns.length >= 3, `${conv.id}: at least 3 turns`);
    for (const t of conv.turns) {
      assert.ok(typeof t.say === "string" && KINDS.has(t.kind), `${conv.id}: ${t.say}`);
      for (const f of ["match", "notMatch"]) if (t[f]) regexOf(t[f], `${conv.id} "${t.say}" ${f}`);
    }
  }
  assert.ok(conversationCases.some((c) => c.turns.some((t) => t.kind === "redirect")), "a conversation with an off-topic turn");
  assert.ok(conversationCases.some((c) => c.turns.some((t) => t.kind === "refusal")), "a conversation with an injection turn");

  for (const c of poisonCases) {
    assert.ok(c.kindIn.every((k) => KINDS.has(k)));
    regexOf(c.notMatch, `poison "${c.message}"`);
  }
});

/* ---- the deterministic layers already agree with the verify cases ---- */
const EVIDENCE_TEXT = `${kbLib.toText()}\n${RESUME_TEXT}`;

test("verify cases: every SUPPORTED answer passes the free grounding check (no false rejections)", () => {
  for (const c of verifyCases.filter((x) => x.supported)) {
    const r = checkGrounding(c.answer, EVIDENCE_TEXT);
    assert.equal(r.ok, true, `${c.id} wrongly rejected by grounding: ${r.details.join("; ")}`);
  }
});

test("verify cases marked layer=grounding are rejected by the free check alone, without any model", () => {
  const cheap = verifyCases.filter((c) => c.layer === "grounding");
  assert.ok(cheap.length >= 4);
  for (const c of cheap) {
    assert.equal(c.supported, false, c.id);
    assert.equal(checkGrounding(c.answer, EVIDENCE_TEXT).ok, false, `${c.id} should be caught by grounding`);
  }
});

/* ---- retrieval quality: the right tool returns the facts the answer needs ---- */
const ctx = () => ({
  kb: JSON.parse(JSON.stringify(kbLib.load())),
  getResume: async () => ({ available: true, text: RESUME_TEXT, fetchedAt: "2026-11-01T00:00:00.000Z" }),
  resumeDownload: () => ({ url: null }),
  now: () => new Date("2026-11-01T00:00:00Z"),
});

for (const c of retrievalCases) {
  test(`retrieval: ${c.id} (${c.tool})`, async () => {
    const r = await tools.execute(c.tool, c.args, ctx());
    assert.equal(r.ok, true, `${c.tool} failed: ${r.error}`);
    for (const needle of c.mustContain) assert.ok(r.text.includes(needle), `missing "${needle}" in:\n${r.text.slice(0, 600)}`);
    for (const needle of c.mustNotContain) assert.ok(!r.text.includes(needle), `unexpected "${needle}" in output`);
  });
}

/* ---- coverage: no tool ships without golden cases ---- */
test("every registered tool has at least one retrieval case AND one planning case", () => {
  for (const name of tools.names()) {
    assert.ok(retrievalCases.some((c) => c.tool === name), `${name}: no retrieval case`);
    assert.ok(planCases.some((c) => (c.include || []).includes(name) || (c.anyOf || []).includes(name)), `${name}: no planning case`);
  }
});

test("retrieval cases never reference an unregistered tool and have unique ids", () => {
  const ids = new Set();
  for (const c of retrievalCases) {
    assert.ok(tools.get(c.tool), c.tool);
    assert.ok(!ids.has(c.id), c.id);
    ids.add(c.id);
    assert.ok(c.mustContain.length > 0, `${c.id} asserts something`);
  }
});

/* ---- the live evaluator's own contract ---- */
const fs = require("node:fs");
const path = require("node:path");
const evalSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "eval-live.js"), "utf8").replace(/\r\n/g, "\n"); // CRLF on Windows checkouts

test("the live evaluator is hermetic: it clears Redis settings BEFORE loading any app module", () => {
  // Otherwise it would overwrite the production resume copy ("kb:resume") and rate-limit counters.
  const firstAppModule = evalSource.search(/require\("\.\.\/lib\//);
  assert.ok(firstAppModule > 0);
  for (const key of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
    const at = evalSource.indexOf(`process.env.${key} = ""`);
    assert.ok(at >= 0 && at < firstAppModule, `${key} must be cleared before the first lib/ require`);
  }
  assert.ok(evalSource.indexOf('process.env.CHAT_CACHE_DISABLED = "1"') < firstAppModule, "cache must be disabled before lib/ loads");
});

test("the live evaluator's definition of 'critical' matches the documented release gates", () => {
  assert.ok(evalSource.includes('critical: c.expect === "injection" || c.expect === "unsafe"'), "guard: only injection/unsafe recall is critical");
  assert.ok(!/critical:\s*c\.expect !== "allow"/.test(evalSource), "off-topic cases must not be critical");
});

test("latency is measured on the successful attempt only (a 429 back-off is not a latency regression)", () => {
  const body = /async function runTurn[\s\S]*?\n}\n/.exec(evalSource)[0];
  assert.match(body, /withRetry\(async \(\) => \{\s*const t0 = Date\.now\(\);/);
});

test("the poison suite refuses to run against the real resume (it would test nothing)", () => {
  assert.match(evalSource, /realResume && ran\.includes\("poison"\)/);
});
