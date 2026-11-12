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
  assert.throws(break_((k) => delete k.projects[0].repo), /repo/);
  assert.throws(break_((k) => (k.facts = "nope")), /facts/);
  assert.throws(() => kb.validate(null), /not an object/);
});

/* ---- website-facing sections (the same record feeds the site and the assistant) ---- */
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

test("the employment dates live in ONE place: the duplicate timeline fact is retired", () => {
  const d = kb.load();
  assert.ok(!d.facts.some((f) => f.id === "fact-employment-timeline" || f.topic === "experience"), "no free-text copy of the dates to drift from the structured experience");
  const role = d.experience[0];
  assert.equal(role.type, "Full-time");
  const text = kb.toText(d);
  assert.ok(text.includes(`${role.type}, ${kb.longMonth(role.started)} – present`), "the prompt states the start date in words");
  assert.ok(text.includes(`since ${kb.longMonth(role.engagement.started)}`), "and the project's start date");
  assert.ok(text.includes(role.engagement.name));
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

test("project and employment fields: link is optional, icon and type are validated", () => {
  const good = clone(kb.load());
  const bad = (mutate) => {
    const copy = clone(good);
    mutate(copy);
    return () => kb.validate(copy);
  };
  const noLink = clone(good);
  delete noLink.projects[0].link;
  assert.doesNotThrow(() => kb.validate(noLink), "a project without a link is valid (its card has no button)");
  assert.throws(bad((k) => (k.projects[0].link = 42)), /projects\[0\]\.link/);
  assert.throws(bad((k) => (k.projects[0].icon = 'fa-x" onclick="evil()')), /projects\[0\]\.icon/);
  assert.throws(bad((k) => (k.experience[0].type = "<b>Full-time</b>")), /experience\[0\]\.type: must be plain text/);
  assert.throws(bad((k) => (k.experience[0].type = "x".repeat(41))), /longer than 40/);
  const noType = clone(good);
  delete noType.experience[0].type;
  assert.doesNotThrow(() => kb.validate(noType), "the employment type is optional");
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
  assert.match(text, /Projects \(as shown on his portfolio, with GitHub details\)/);
  assert.match(text, /phone number is never shared/i);
});

test("KB text carries what the website says: about, experience and skills (levels named as self-rated)", () => {
  const d = kb.load();
  const text = kb.toText(d);
  assert.ok(text.includes("About him (his own words):"));
  assert.ok(text.includes(kb.plainText(d.about.paragraphs[0])), "the first about paragraph, without ** markers");
  assert.ok(!text.includes("**"), "no markup characters");
  assert.match(text, /Experience \(his confirmed record, newest first\):/);
  for (const point of d.experience[0].points) assert.ok(text.includes(point), `experience point: ${point.slice(0, 40)}`);
  assert.match(text, /Skills \(a level is his OWN rating of himself, not an assessment\):/);
  assert.match(text, /Python \(Advanced, self-rated\)/);
  assert.match(text, /Agentic AI;/, "a skill without a level has no rating attached");
  assert.ok(!/Agentic AI \(/.test(text), "no level is invented");
  for (const s of d.skills) assert.ok(text.includes(s.name), s.name);
});

test("KB text says the profile wins over the LinkedIn snapshot, which can lag", () => {
  assert.match(kb.toText(), /LinkedIn profile snapshot \(as of \d{4}-\d{2}-\d{2}; it can lag, and the profile above wins if they differ\)/);
});

test("describeRole: type, dates in words, and 'present' for a current role", () => {
  assert.equal(kb.describeRole({ role: "Dev", company: "Acme", type: "Full-time", started: "Jan 2026", ended: null }), "Dev at Acme — Full-time, January 2026 – present");
  assert.equal(kb.describeRole({ role: "Intern", company: "Acme", started: "Jun 2025", ended: "Dec 2025" }), "Intern at Acme — June 2025 – December 2025");
  assert.equal(kb.describeEngagement({ engagement: { name: "Project X", started: "Apr 2026" } }), "Project X (since April 2026)");
  assert.equal(kb.describeEngagement({}), "");
  assert.equal(kb.longMonth("Sep 2024"), "September 2024");
  assert.equal(kb.longMonth("not a month"), "not a month");
});

/* ---- projects: one list for the site and the assistant ---- */
const os = require("node:os");
const fsx = require("node:fs");
const pathx = require("node:path");
const cardsFile = (items) => {
  const file = pathx.join(fsx.mkdtempSync(pathx.join(os.tmpdir(), "kbproj-")), "projects.json");
  fsx.writeFileSync(file, typeof items === "string" ? items : JSON.stringify({ items }));
  return file;
};

test("the assistant's project list is the website's: same projects, same order, same text and icons", () => {
  const raw = kb.loadRaw();
  const merged = kb.load().projects;
  const file = JSON.parse(fsx.readFileSync(require("../lib/projects").FILE, "utf8")).items.filter((p) => p.featured !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
  assert.deepEqual(merged.map((p) => p.title), file.map((p) => p.title));
  assert.deepEqual(merged.map((p) => p.description), file.map((p) => p.description));
  assert.deepEqual(merged.map((p) => p.icon), file.map((p) => p.icon));
  assert.equal(merged.length, raw.projects.length, "and kb.json's own copy covers every one of them");
  assert.ok(merged.every((p) => p.source === "projects.json+github"), "each is enriched with its GitHub details");
});

test("a project added to projects.json shows up for the assistant at once, before kb:sync", () => {
  const raw = kb.loadRaw();
  const file = cardsFile([
    { title: "Brand New", description: "Just added by the automation.", tech: ["Go"], link: "https://github.com/atharva723/brand-new", icon: "fab fa-golang", order: 1 },
    { title: raw.projects[0].title, description: raw.projects[0].description, tech: [], link: raw.projects[0].link, icon: "fab fa-python", order: 2 },
  ]);
  const merged = kb.mergeProjects(raw, { file });
  assert.deepEqual(merged.map((p) => p.title), ["Brand New", raw.projects[0].title], "order comes from the file");
  assert.equal(merged[0].id, "proj-brand-new");
  assert.equal(merged[0].repo, "brand-new");
  assert.equal(merged[0].source, "projects.json");
  assert.equal(merged[0].highlights, undefined, "no GitHub details yet: kb:sync adds them");
  assert.equal(merged[1].highlights, raw.projects[0].highlights, "an existing project keeps its GitHub details");
  assert.ok(kb.version({ ...kb.load(), projects: merged }) !== kb.version(), "the content version (and so the answer cache) changes with the cards");
});

test("a project removed from the site is removed for the assistant too", () => {
  const raw = kb.loadRaw();
  const file = cardsFile([{ title: raw.projects[1].title, description: raw.projects[1].description, link: raw.projects[1].link, order: 1 }]);
  const merged = kb.mergeProjects(raw, { file });
  assert.deepEqual(merged.map((p) => p.title), [raw.projects[1].title]);
});

test("a repository renamed on GitHub is matched by title, and the CANONICAL link wins over the old one", () => {
  const raw = kb.loadRaw();
  const renamed = raw.projects.find((p) => p.repo === "CodeAuditor_copilot_CLI_agent");
  const oldLink = renamed.link.replace("_agent", "_agnet");
  const file = cardsFile([{ title: renamed.title, description: renamed.description, tech: [], link: oldLink, icon: "fab fa-python", order: 1 }]);
  const [p] = kb.mergeProjects(raw, { file });
  assert.equal(p.link, renamed.link, "the verified GitHub link, not the stale one");
  assert.equal(p.repo, renamed.repo);
  assert.equal(p.highlights, renamed.highlights, "details are kept");
  assert.equal(p.source, "projects.json+github");
});

test("when projects.json is missing, broken or empty, kb.json's own GitHub-synced list is used as is", () => {
  const raw = kb.loadRaw();
  for (const file of [pathx.join(os.tmpdir(), "nope-projects.json"), cardsFile("{ broken"), cardsFile([])]) {
    assert.deepEqual(kb.mergeProjects(raw, { file }), raw.projects);
  }
});

test("merged projects stay valid KB entries (unique ids, link optional) and a hostile card cannot get through", () => {
  const raw = kb.loadRaw();
  const file = cardsFile([
    { title: "Same", description: "one", link: "https://github.com/o/a", order: 1 },
    { title: "Same", description: "two", link: "https://github.com/o/b", order: 2 },
    { title: "Evil", description: "x", link: "javascript:alert(1)", icon: 'x" onclick="y', order: 3 },
  ]);
  const merged = kb.mergeProjects(raw, { file });
  assert.equal(new Set(merged.map((p) => p.id)).size, 3, "title collisions get distinct ids");
  assert.equal(merged[2].link, undefined, "a non-https link is dropped");
  assert.equal(merged[2].icon, "fas fa-code", "a bad icon becomes the default");
  assert.doesNotThrow(() => kb.validate({ ...raw, projects: merged }));
});

test("pairing a card with its kb.json entry is conservative: a wrong pairing would give a project another's link and README", () => {
  const raw = kb.loadRaw();
  const first = raw.projects[0];

  // 1. A link-less kb.json entry must not attract unrelated link-less cards.
  const withPrivate = { ...raw, projects: [...raw.projects, { id: "proj-private-tool", repo: "private-tool", title: "Private Tool", description: "d", highlights: "SECRET README EXCERPT", source: "github", updated: "2026-11-01" }] };
  const linkless = kb.mergeProjects(withPrivate, { file: cardsFile([{ title: "Totally Different", description: "x", order: 1 }, { title: "Another One", description: "y", order: 2 }]) });
  assert.equal(linkless.length, 2);
  for (const p of linkless) {
    assert.equal(p.highlights, undefined, "no README excerpt borrowed from another project");
    assert.equal(p.source, "projects.json");
    assert.notEqual(p.id, "proj-private-tool");
  }

  // 2. A NEW repository that reuses an existing title keeps its OWN link (the title only pairs unclaimed entries).
  const [a, b] = kb.mergeProjects(raw, {
    file: cardsFile([
      { title: first.title, description: first.description, link: first.link, order: 1 },
      { title: first.title, description: "A different project with the same title", link: "https://github.com/atharva723/brand_new_repo", order: 2 },
    ]),
  });
  assert.equal(a.link, first.link);
  assert.equal(a.highlights, first.highlights);
  assert.equal(b.link, "https://github.com/atharva723/brand_new_repo", "its own repository, not the old one");
  assert.equal(b.highlights, undefined);
  assert.equal(b.source, "projects.json");
  assert.notEqual(a.id, b.id);

  // 3. The same repository NAME under a different OWNER is a different repository.
  const [c] = kb.mergeProjects(raw, { file: cardsFile([{ title: "A fork", description: "d", link: `https://github.com/someone-else/${first.repo}`, order: 1 }]) });
  assert.equal(c.link, `https://github.com/someone-else/${first.repo}`);
  assert.equal(c.highlights, undefined);
  assert.equal(c.source, "projects.json");

  // 4. Each kb.json entry is used at most once, even if two cards point at the same repository.
  const [d1, d2] = kb.mergeProjects(raw, { file: cardsFile([{ title: "A", description: "a", link: first.link, order: 1 }, { title: "B", description: "b", link: first.link, order: 2 }]) });
  assert.equal(d1.source, "projects.json+github");
  assert.equal(d2.source, "projects.json", "the second card does not also claim the entry");
  assert.equal(d2.highlights, undefined);

  // 5. Matching is case-insensitive on owner and repository, and tolerates a trailing slash.
  const [e] = kb.mergeProjects(raw, { file: cardsFile([{ title: "Renamed card", description: "d", link: first.link.toUpperCase().replace("HTTPS", "https") + "/", order: 1 }]) });
  assert.equal(e.highlights, first.highlights);
  assert.equal(e.link, first.link, "and the canonical link is used");
});

test("a card whose title is not Latin still gets a usable id and repo", () => {
  const [p] = kb.mergeProjects(kb.loadRaw(), { file: cardsFile([{ title: "日本語", description: "d", order: 1 }]) });
  assert.equal(p.id, "proj-project");
  assert.equal(p.repo, "project");
});

test("load() refreshes when projects.json changes, without a restart (the cache keys on BOTH files)", () => {
  const projectsLib = require("../lib/projects");
  const file = cardsFile([{ title: "First Card", description: "one", link: "https://github.com/o/first", order: 1 }]);
  projectsLib._setFile(file);
  try {
    assert.deepEqual(kb.load().projects.map((p) => p.title), ["First Card"]);
    const before = kb.version();
    fsx.writeFileSync(file, JSON.stringify({ items: [{ title: "Second Card", description: "two", link: "https://github.com/o/second", order: 1 }] }));
    const later = new Date(Date.now() + 10000); // move the mtime even on a coarse-grained filesystem
    fsx.utimesSync(file, later, later);
    assert.deepEqual(kb.load().projects.map((p) => p.title), ["Second Card"], "the change is picked up");
    assert.notEqual(kb.version(), before, "and the content version (the answer cache key) changes with it");
  } finally {
    projectsLib._setFile(null);
  }
  assert.ok(kb.load().projects.length >= 8, "back on the real project cards");
});

test("experience must be listed newest first (the site and the assistant both treat the first as current)", () => {
  const good = clone(kb.load());
  const older = { id: "exp-old", source: "owner", updated: "2026-11-04", role: "Intern", company: "Acme", started: "Jun 2025", ended: "Dec 2025" };
  const newer = { id: "exp-new", source: "owner", updated: "2026-11-04", role: "Lead", company: "Zed", started: "Mar 2027" };
  assert.doesNotThrow(() => kb.validate({ ...good, experience: [...good.experience, older] }), "an older role after the current one is fine");
  assert.throws(() => kb.validate({ ...good, experience: [...good.experience, newer] }), /experience\[1\]: roles must be listed newest first/);
  assert.throws(() => kb.validate({ ...good, experience: [older, ...good.experience] }), /newest first/);
});

test("the prompt text stays within the verifier's budget (a context-mode check must see the whole KB plus the resume)", () => {
  const FULL_CHARS = 18000; // lib/verify.js: what the verifier reads in one pass
  const text = kb.toText();
  assert.ok(text.length <= 13500, `KB text is ${text.length} chars; keep it under 13500 so a ~4.5k-char resume still fits in ${FULL_CHARS}`);
  assert.ok(text.includes("…") || kb.load().linkedin.positions.every((r) => (r.description || "").length <= 400), "long LinkedIn text is clipped");
});

test("loadRaw is the file exactly as written (scripts that rewrite kb.json must never save the merged view)", () => {
  const raw = kb.loadRaw();
  assert.deepEqual(raw, JSON.parse(fsx.readFileSync(kb.KB_PATH, "utf8")));
  assert.ok(raw.projects.every((p) => p.source !== "projects.json+github"), "no merged source labels in the file");
  assert.notDeepEqual(raw.projects, kb.load().projects);
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
