const test = require("node:test");
const assert = require("node:assert");

const kb = require("../lib/kb");
const { cleanReadme, parseRepoLink, slug } = require("../lib/kb-build");

test("committed kb/kb.json is valid", () => {
  assert.doesNotThrow(() => kb.load());
});

test("every KB entry has a unique id, a source and an updated date", () => {
  const data = kb.load();
  const all = [data.profile, ...data.education, ...data.credentials, ...data.facts, ...data.projects];
  const ids = all.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const e of all) {
    assert.ok(e.source, `${e.id} has a source`);
    assert.match(e.updated, /^\d{4}-\d{2}-\d{2}$/, `${e.id} has an updated date`);
  }
});

test("validate rejects malformed knowledge bases", () => {
  const good = JSON.parse(JSON.stringify(kb.load()));
  const break_ = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return () => kb.validate(copy);
  };
  assert.throws(break_((k) => delete k.profile.email), /email/);
  assert.throws(break_((k) => (k.education[0].updated = "yesterday")), /updated/);
  assert.throws(break_((k) => (k.facts[0].id = k.education[0].id)), /duplicate id/);
  assert.throws(break_((k) => delete k.projects[0].link), /link/);
  assert.throws(break_((k) => (k.facts = "nope")), /facts/);
  assert.throws(() => kb.validate(null), /not an object/);
});

test("KB text carries education, the AZ-900 verify link, projects and facts", () => {
  const text = kb.toText();
  assert.match(text, /M\.G\.M\. College of Engineering, Kamothe/);
  assert.match(text, /University of Mumbai/);
  assert.match(text, /7\.11/);
  assert.match(text, /8\.21/);
  assert.match(text, /77%/);
  assert.match(text, /AZ-900/);
  assert.match(text, /learn\.microsoft\.com\/api\/credentials\/share/);
  assert.match(text, /Projects \(from GitHub\)/);
  assert.match(text, /phone number is never shared/i);
});

test("version changes when the KB changes", () => {
  const a = kb.version();
  const changed = JSON.parse(JSON.stringify(kb.load()));
  changed.facts[0].text += " extra";
  assert.equal(kb.version(), a, "stable for identical content");
  assert.notEqual(kb.version(changed), a);
});

test("the KB never contains a phone number", () => {
  const raw = JSON.stringify(kb.load());
  assert.ok(!/\+?\d[\d\s().-]{8,}\d/.test(raw.replace(/\d{4}-\d{2}-\d{2}/g, "")), "no phone-like sequences");
});

/* ---- README cleaning ---- */
test("cleanReadme removes badges, images, code, html and link targets", () => {
  const md = `# Project X
[![Build](https://img.shields.io/badge/a-b.svg)](https://ci.example.com)
![logo](./logo.png)
<div align="center"><b>Hi</b></div>
A **fast** tool for [testing](https://example.com/docs). See https://example.com/more.

\`\`\`bash
npm install secret-token-123
\`\`\`

| a | b |
|---|---|
| 1 | 2 |
`;
  const out = cleanReadme(md);
  assert.match(out, /Project X/);
  assert.match(out, /A fast tool for testing\./);
  for (const noise of ["shields.io", "logo.png", "<div", "https://", "npm install", "secret-token", "```", "|---|"]) {
    assert.ok(!out.includes(noise), `no "${noise}"`);
  }
});

test("cleanReadme truncates on a word boundary with an ellipsis", () => {
  const out = cleanReadme("word ".repeat(500), 100);
  assert.ok(out.length <= 101);
  assert.ok(out.endsWith("…"));
  assert.equal(cleanReadme("short text"), "short text");
  assert.equal(cleanReadme(null), "");
});

test("parseRepoLink only accepts github.com/<owner>/<repo>", () => {
  assert.deepEqual(parseRepoLink("https://github.com/atharva723/my-repo"), { owner: "atharva723", repo: "my-repo" });
  for (const bad of ["http://github.com/a/b", "https://evil.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "", null]) {
    assert.equal(parseRepoLink(bad), null, String(bad));
  }
  assert.equal(slug("n8n_and_backend-LLM-DB-_Maps-agent"), "n8n-and-backend-llm-db-maps-agent");
});
