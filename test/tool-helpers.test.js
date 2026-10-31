const test = require("node:test");
const assert = require("node:assert");

const { validate, signature } = require("../lib/tools/schema");
const { render } = require("../lib/tools/render");
const { hits, clip, monthYearEnd, monthYearValue } = require("../lib/tools/util");
const { splitSections, keyOf } = require("../lib/sources/resume-sections");

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 10 },
    section: { type: "string", enum: ["a", "b"] },
    limit: { type: "integer", minimum: 1, maximum: 5 },
    flag: { type: "boolean" },
  },
  required: [],
};

/* ---- argument validation ---- */
test("valid arguments pass, are trimmed, and unknown keys are dropped", () => {
  const r = validate(SCHEMA, { query: "  rag  ", section: "a", limit: 3, flag: true, extra: "ignored", __proto__x: 1 });
  assert.deepEqual(r, { ok: true, args: { query: "rag", section: "a", limit: 3, flag: true } });
});

test("missing, null and empty-string arguments are simply absent", () => {
  assert.deepEqual(validate(SCHEMA, undefined), { ok: true, args: {} });
  assert.deepEqual(validate(SCHEMA, null), { ok: true, args: {} });
  assert.deepEqual(validate(SCHEMA, { query: "", section: null }), { ok: true, args: {} });
});

test("wrong types, out-of-enum, too-long and out-of-range values are REJECTED, not coerced", () => {
  const bad = [
    [{ query: 5 }, /must be a string/],
    [{ query: "x".repeat(11) }, /too long/],
    [{ section: "c" }, /must be one of: a, b/],
    [{ limit: "3" }, /must be an integer/],
    [{ limit: 1.5 }, /must be an integer/],
    [{ limit: 0 }, />= 1/],
    [{ limit: 6 }, /<= 5/],
    [{ flag: "yes" }, /true or false/],
    [{ query: ["a"] }, /must be a string/],
    [{ query: { $ne: 1 } }, /must be a string/],
  ];
  for (const [input, message] of bad) {
    const r = validate(SCHEMA, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.error, message);
  }
});

test("non-object arguments are rejected", () => {
  for (const input of ["x", 5, true, ["a"]]) assert.equal(validate(SCHEMA, input).ok, false, JSON.stringify(input));
});

test("required arguments are enforced", () => {
  const schema = { properties: { q: { type: "string" } }, required: ["q"] };
  assert.match(validate(schema, {}).error, /"q" is required/);
  assert.equal(validate(schema, { q: "x" }).ok, true);
});

test("control characters are stripped from strings", () => {
  assert.equal(validate(SCHEMA, { query: "a\u0000b\nc" }).args.query, "a b c");
});

test("an unsupported schema type fails closed", () => {
  assert.equal(validate({ properties: { x: { type: "object" } } }, { x: {} }).ok, false);
});

test("signature renders a compact catalogue entry", () => {
  assert.equal(signature(SCHEMA), "query?: string, section?: a|b, limit?: integer, flag?: boolean");
  assert.equal(signature({ properties: { q: { type: "string" } }, required: ["q"] }), "q: string");
  assert.equal(signature({ type: "object", properties: {} }), "");
});

/* ---- renderer ---- */
test("render emits one fact per line: scalars, arrays, objects and multi-line text", () => {
  const text = render({
    total: 2,
    name: "Atharva",
    empty: [],
    nothing: null,
    blank: "",
    items: [{ a: 1 }, "plain"],
    nested: { k: "v" },
    body: "line one\n\nline two",
    flag: false,
  });
  assert.equal(
    text,
    ["total: 2", "name: Atharva", "empty: (none)", 'items:', '- {"a":1}', "- plain", 'nested: {"k":"v"}', "body:", "- line one", "- line two", "flag: false"].join("\n")
  );
  assert.equal(render(null), "");
});

/* ---- helpers ---- */
test("hits counts query words found in any field, case-insensitively", () => {
  assert.equal(hits("azure ai", "Microsoft Certified: Azure AI Fundamentals"), 2);
  assert.equal(hits("Terraform", ["Python", "terraform"]), 1);
  assert.equal(hits("rust", "Python Go"), 0);
  assert.equal(hits("", "anything"), 0);
  assert.equal(hits("a", "a b"), 0, "single-letter words are ignored");
});

test("clip shortens on a boundary with an ellipsis", () => {
  assert.equal(clip("short", 20), "short");
  assert.equal(clip("a ".repeat(50), 10).endsWith("…"), true);
  assert.ok(clip("x".repeat(500), 100).length <= 100);
  assert.equal(clip(null, 5), "");
});

test("month-year parsing yields the END of the month, or null", () => {
  assert.equal(monthYearEnd("Oct 2027").toISOString(), "2027-10-31T23:59:59.000Z");
  assert.equal(monthYearEnd("February 2028").toISOString(), "2028-02-29T23:59:59.000Z");
  for (const bad of ["", "2027", "Foo 2027", "Oct", null, "2027-10-31"]) assert.equal(monthYearEnd(bad), null, String(bad));
  assert.ok(monthYearValue("Oct 2026") > monthYearValue("Aug 2026"));
  assert.equal(monthYearValue("nope"), 0);
});

/* ---- resume sections ---- */
const RESUME = `Atharva Jadhav
AI & Agentic Automation Engineer
Mumbai, India

## PROFESSIONAL SUMMARY
Engineer at LTIMindtree.

## EXPERIENCE
Engineer, Cloud & Infra Management Apr 2026 – Present
- Built agents

## PROJECTS
Sentinel
## TECHNICAL SKILLS
Python

## CERTIFICATIONS
- AZ-900

## ADDITIONAL TECHNICAL STACK
FastAPI • Docker
## EDUCATION
Computer Engineering
## Some Custom Heading!
text`;

test("splitSections separates the header from sections and maps headings to stable keys", () => {
  const { header, sections } = splitSections(RESUME);
  assert.match(header, /^Atharva Jadhav\nAI & Agentic Automation Engineer\nMumbai, India$/);
  assert.deepEqual(Object.keys(sections), ["summary", "experience", "projects", "skills", "certifications", "additional_stack", "education", "some_custom_heading"]);
  assert.deepEqual(sections.experience.lines, ["Engineer, Cloud & Infra Management Apr 2026 – Present", "- Built agents"]);
  assert.equal(sections.skills.title, "TECHNICAL SKILLS");
  assert.deepEqual(sections.additional_stack.lines, ["FastAPI • Docker"]);
});

test("keyOf maps common heading variants", () => {
  const cases = {
    "PROFESSIONAL SUMMARY": "summary",
    "Work History": "experience",
    "Employment": "experience",
    "Personal Projects": "projects",
    "Academic Background": "education",
    "Licenses & Certifications": "certifications",
    "TECHNICAL SKILLS": "skills",
    "Additional Technical Stack": "additional_stack",
    "Hobbies": "hobbies",
  };
  for (const [title, key] of Object.entries(cases)) assert.equal(keyOf(title), key, title);
});

test("splitSections tolerates empty or null input and repeated headings", () => {
  assert.deepEqual(splitSections(""), { header: "", sections: {} });
  assert.deepEqual(splitSections(null), { header: "", sections: {} });
  const twice = splitSections("## SKILLS\na\n## SKILLS\nb");
  assert.deepEqual(twice.sections.skills.lines, ["a", "b"]);
});
