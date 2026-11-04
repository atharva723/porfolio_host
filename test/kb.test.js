const test = require("node:test");
const assert = require("node:assert");

const kb = require("../lib/kb");
const { cleanReadme, parseRepoLink, slug } = require("../lib/kb-build");

test("committed kb/kb.json is valid", () => {
  assert.doesNotThrow(() => kb.load());
});

test("every KB entry has a unique id, a source and an updated date", () => {
  const data = kb.load();
  const all = [data.profile, data.about, ...data.experience, ...data.skills, ...data.education, ...data.credentials, ...data.facts, ...data.projects];
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

/* ---- website-facing sections (the same record feeds the site and the assistant) ---- */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longMonth = (s) => {
  const [m, y] = s.split(" ");
  return `${MONTH_NAMES.find((n) => n.startsWith(m))} ${y}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test("the KB holds everything the website shows: tagline, about, experience, skills, credentials", () => {
  const d = kb.load();
  assert.ok(d.profile.tagline.length > 20, "hero tagline");
  assert.ok(d.about.paragraphs.length >= 1, "about paragraphs");
  assert.ok(d.experience.length >= 1, "experience");
  assert.ok(d.skills.length >= 1, "skills");
  assert.ok(d.credentials.length >= 1, "credentials (icons are optional: the importer adds new ones without)");
});

test("experience is newest first, the current role matches the profile, and nothing starts after it ends", () => {
  const d = kb.load();
  const [current] = d.experience;
  assert.equal(current.ended, null, "the first entry is the current role");
  assert.equal(current.company, d.profile.employer, "profile.employer is the current company");
  const starts = d.experience.map((x) => x.started);
  const value = (s) => Number(s.split(" ")[1]) * 12 + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(s.split(" ")[0]);
  assert.deepEqual([...starts].sort((a, b) => value(b) - value(a)), starts, "newest first");
});

test("the employment-timeline fact and the structured experience tell the same dates", () => {
  const d = kb.load();
  const fact = d.facts.find((f) => f.id === "fact-employment-timeline");
  const role = d.experience[0];
  assert.ok(fact.text.includes(longMonth(role.started)), `fact mentions ${longMonth(role.started)}`);
  assert.ok(fact.text.includes(longMonth(role.engagement.started)), `fact mentions ${longMonth(role.engagement.started)}`);
  assert.ok(fact.text.includes(role.engagement.name.replace(/^Microsoft Project:\s*/, "")), "fact names the engagement");
});

test("skill levels are only ever the owner's own rating: an import can't invent them", () => {
  for (const s of kb.load().skills) {
    if (s.level !== undefined) assert.equal(s.source, "owner", `${s.name} has a level, so its source must be "owner"`);
  }
});

test("the website copy is plain text: no HTML, and ** is the only markup (about paragraphs only)", () => {
  const d = kb.load();
  const copy = [
    ["tagline", d.profile.tagline],
    ...d.about.paragraphs.map((p, i) => [`about[${i}]`, p]),
    ...d.skills.map((s) => [`skill ${s.name}`, s.name]),
    ...d.experience.flatMap((x) => [[`role ${x.role}`, x.role], [`company ${x.company}`, x.company], ...(x.points || []).map((p, i) => [`${x.id} point ${i}`, p])]),
  ];
  for (const [where, text] of copy) assert.ok(!/[<>]/.test(text), `${where} has no HTML`);
  assert.ok(!d.profile.tagline.includes("**"));
  assert.ok(d.experience.every((x) => (x.points || []).every((p) => !p.includes("**"))));
});

test("validate rejects malformed website sections with a precise message", () => {
  const good = clone(kb.load());
  const bad = (mutate) => {
    const copy = clone(good);
    mutate(copy);
    return () => kb.validate(copy);
  };
  assert.throws(bad((k) => delete k.profile.tagline), /profile\.tagline/);
  assert.throws(bad((k) => (k.profile.tagline = "<b>Hi</b>")), /plain text/);
  assert.throws(bad((k) => delete k.about), /about/);
  assert.throws(bad((k) => (k.about.paragraphs = [])), /about\.paragraphs/);
  assert.throws(bad((k) => (k.about.paragraphs[0] = "Half **bold")), /unbalanced/);
  assert.throws(bad((k) => (k.about.paragraphs[0] = '<img src=x onerror="alert(1)">')), /plain text/);
  assert.throws(bad((k) => (k.skills[0].level = "Guru")), /skills\[0\]\.level/);
  assert.throws(bad((k) => (k.skills[0].icon = 'fa-x" onclick="evil()')), /skills\[0\]\.icon/);
  assert.throws(bad((k) => (k.skills[0].name = "**Python**")), /\*\* markers/);
  assert.throws(bad((k) => (k.credentials[0].icon = "javascript:alert(1)")), /credentials\[0\]\.icon/);
  assert.throws(bad((k) => (k.experience[0].started = "2026-01")), /Jan 2026/);
  assert.throws(bad((k) => (k.experience[0].ended = "Dec 2025")), /ended is before started/);
  assert.throws(bad((k) => (k.experience[0].engagement.started = "Jan 2025")), /engagement starts before the role/);
  assert.throws(bad((k) => (k.experience[0].points = Array(11).fill("x"))), /at most 10/);
  assert.throws(bad((k) => delete k.experience), /experience/);
  assert.throws(bad((k) => (k.skills[1].id = k.skills[0].id)), /duplicate id/);
});

test("optional website fields stay optional: no level, no icon, no engagement, an ended role", () => {
  const k = clone(kb.load());
  delete k.skills[1].icon;
  delete k.skills[1].level;
  delete k.experience[0].engagement;
  delete k.experience[0].points;
  k.experience[0].ended = "Mar 2026";
  assert.doesNotThrow(() => kb.validate(k));
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
