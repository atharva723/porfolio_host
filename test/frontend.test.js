const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const kbLib = require("../lib/kb");
const siteContent = require("../lib/site-content");

const PUBLIC = path.join(__dirname, "..", "public");
const VIEWS = path.join(__dirname, "..", "views");
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), "utf8");
const html = fs.readFileSync(path.join(VIEWS, "index.html"), "utf8");
const NOW = new Date("2026-11-04T05:00:00Z");
const realContent = () => siteContent.build({ now: NOW });
const clone = (o) => JSON.parse(JSON.stringify(o));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------------- the page shell ---------------- */

test("every nav link points at a section that exists, and every section is in the nav", () => {
  const sections = [...html.matchAll(/<section[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
  const nav = [...html.matchAll(/<a href="#([a-z]+)">/g)].map((m) => m[1]).filter((id) => id !== "contact" || sections.includes("contact"));
  for (const id of nav) assert.ok(sections.includes(id), `#${id} exists`);
  for (const id of sections) assert.ok(nav.includes(id), `${id} has a nav link`);
});

test("scripts load in dependency order, with the content block before render.js", () => {
  const order = ["<!--SITE_CONTENT-->", "./js/util.js", "./js/config.js", "./js/layout.js", "./js/render.js", "./js/script.js", "./js/smooth-caret.js", "./js/chat.js"].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i > 0), "all present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in this order");
});

test("every element render.js fills exists in index.html", () => {
  const source = read("js", "render.js");
  const layout = loadLayout();
  const ids = new Set([...source.matchAll(/setHTML\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
  for (const key of Object.keys(layout.sections)) {
    ids.add(`${key}Tag`);
    ids.add(`${key}Title`);
  }
  for (const id of ["heroTag", "heroSubtitle", "footerText", "contentUnavailable", "first-name", "last-name"]) ids.add(id);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} is in index.html`);
});

/* ---------------- no facts hard-coded in the public files ---------------- */

function loadLayout() {
  const sandbox = { window: {} };
  vm.runInNewContext(read("js", "layout.js"), sandbox);
  return sandbox.window.portfolioLayout;
}

test("the public page, scripts and styles hold NO facts about the owner (they all come from kb.json)", () => {
  const kb = kbLib.load();
  const host = new URL(kb.profile.website).hostname;
  const needles = [kb.profile.name, ...kb.profile.name.split(" "), kb.profile.email, kb.profile.email.split("@")[0], kb.profile.github, kb.profile.linkedin, host, kb.profile.employer].filter(Boolean);
  const files = [path.join(VIEWS, "index.html"), ...fs.readdirSync(path.join(PUBLIC, "js")).map((f) => path.join(PUBLIC, "js", f)), ...fs.readdirSync(path.join(PUBLIC, "css")).map((f) => path.join(PUBLIC, "css", f))];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    for (const needle of needles) assert.ok(!text.includes(needle.toLowerCase()), `${path.basename(file)} must not contain "${needle}"`);
  }
});

test("layout.js is only headings and layout choices: it names no skill, certificate, school, role or project", () => {
  const kb = kbLib.load();
  const text = JSON.stringify(loadLayout());
  const facts = [
    ...kb.skills.map((s) => s.name),
    ...kb.credentials.flatMap((c) => [c.code, c.title, c.issuer]),
    ...kb.education.map((e) => e.institution),
    ...kb.experience.flatMap((x) => [x.role, x.company]),
    ...kb.projects.map((p) => p.title),
  ].filter(Boolean);
  for (const fact of facts) assert.ok(!new RegExp(`\\b${escapeRe(fact)}\\b`, "i").test(text), `layout.js must not mention "${fact}"`);
  assert.ok(!/@|https?:\/\//.test(text), "no e-mail address or URL");
  assert.ok(!/\d{4}/.test(text.replace(/\{year\}/g, "")), "no years or dates typed in");
});

test("the stats layout only names metrics the server really computes", () => {
  const known = Object.keys(realContent().metrics);
  for (const s of loadLayout().stats) assert.ok(known.includes(s.metric), `${s.metric} is a computed metric`);
  for (const l of loadLayout().contactLinks) assert.ok(["email", "linkedin", "github"].includes(l.kind), `${l.kind} is a profile field`);
});

/* ---------------- util.js ---------------- */

test("boldText escapes first, so only the <strong> pairs it creates can ever be tags", () => {
  const { boldText, splitName, safeUrl } = require("../public/js/util.js");
  assert.equal(boldText("a **b** c"), "a <strong>b</strong> c");
  assert.equal(boldText("**x** and **y**"), "<strong>x</strong> and <strong>y</strong>");
  assert.equal(boldText("<b>no</b> <img src=x onerror=1>"), "&lt;b&gt;no&lt;/b&gt; &lt;img src=x onerror=1&gt;");
  assert.equal(boldText("**<i>x</i>**"), "<strong>&lt;i&gt;x&lt;/i&gt;</strong>");
  assert.equal(boldText("3 ** 2"), "3 ** 2", "a lone ** pair is left as text");
  assert.equal(boldText(null), "");
  assert.equal(safeUrl("javascript:alert(1)"), "#");
  assert.deepEqual(splitName("Jane Q Doe"), { first: "Jane Q ", last: "Doe" });
  assert.deepEqual(splitName("Madonna"), { first: "", last: "Madonna" });
  assert.deepEqual(splitName(""), { first: "", last: "" });
  assert.deepEqual(splitName(undefined), { first: "", last: "" });
});

/* ---------------- render.js in a stub DOM ---------------- */

/** Run util.js, layout.js and render.js against a minimal fake document. */
function renderWith(contentJson) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { id, textContent: "", innerHTML: "", hidden: id === "contentUnavailable" });
    return elements.get(id);
  };
  const hiddenSections = [{ id: "about", hidden: false }, { id: "skills", hidden: false }, { id: "contact", hidden: false }];
  const heroContent = { hidden: false };
  const events = [];
  const errors = [];
  const document = {
    title: "",
    getElementById: (id) => (id === "site-content" ? (contentJson == null ? null : { textContent: contentJson }) : get(id)),
    querySelectorAll: (sel) => (sel === "section[id]:not(#home)" ? hiddenSections : sel === ".hero-content" ? [heroContent] : []),
    dispatchEvent: (e) => events.push(e.type),
  };
  const window = {};
  const sandbox = { window, document, console: { error: (m) => errors.push(String(m)) }, CustomEvent: class { constructor(type) { this.type = type; } } };
  for (const f of ["util.js", "layout.js", "render.js"]) vm.runInNewContext(read("js", f), sandbox);
  return {
    get, window, document, hiddenSections, heroContent, events, errors,
    // innerHTML is the only sink that can create tags; textContent is inert by definition.
    markup: () => [...elements.values()].map((e) => e.innerHTML).join("\n"),
  };
}

test("render.js builds every section from the content", () => {
  const c = realContent();
  const r = renderWith(JSON.stringify(c));
  const count = (id, re) => (r.get(id).innerHTML.match(re) || []).length;

  assert.equal(r.document.title, `${c.profile.name} - ${c.profile.headline}`);
  assert.equal(r.get("heroTag").textContent, c.profile.headline);
  assert.equal(r.get("heroSubtitle").textContent, c.profile.tagline);
  assert.equal(count("skillsGrid", /class="skill-card"/g), c.skills.length);
  assert.equal(count("projectsGrid", /class="project-card"/g), c.projects.length);
  assert.equal(count("certificationsGrid", /class="cert-card"/g), c.certifications.length);
  assert.equal(count("experienceList", /class="experience-card/g), c.experience.length);
  assert.equal(count("educationGrid", /edu-card/g), c.education.length);
  assert.equal(count("aboutText", /<p>/g), c.about.paragraphs.length);
  assert.ok(r.events.includes("projects:rendered"));
  assert.equal(r.window.siteContent.profile.name, c.profile.name, "script.js and chat.js read the name from here");
  assert.equal(r.errors.length, 0);
  assert.equal(r.get("contentUnavailable").hidden, true);
});

test("render.js: headings come from layout.js, stats from the computed metrics, contact links from the profile", () => {
  const c = realContent();
  const r = renderWith(JSON.stringify(c));
  assert.equal(r.get("educationTitle").textContent, loadLayout().sections.education.title);

  const escapeText = (s) => s.replace(/&/g, "&amp;");
  const stats = [...r.get("statsGrid").innerHTML.matchAll(/data-count="(\d+)"[^>]*>0<\/h3>\s*<p>([^<]+)</g)].map((m) => [m[2], Number(m[1])]);
  assert.deepEqual(stats, loadLayout().stats.map((s) => [escapeText(s.label), c.metrics[s.metric]]));

  const links = [...r.get("contactLinks").innerHTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [`mailto:${c.profile.email}`, c.profile.linkedin, c.profile.github]);
  assert.ok(!/target="_blank"[^>]*href="mailto/.test(r.get("contactLinks").innerHTML), "the e-mail link opens in place");
  assert.match(r.get("footerText").textContent, new RegExp(`${new Date().getFullYear()} ${c.profile.name}`));
});

test("render.js: a stat whose metric is missing is left out instead of showing 0 or NaN", () => {
  const c = realContent();
  delete c.metrics.experienceMonths;
  const r = renderWith(JSON.stringify(c));
  assert.equal((r.get("statsGrid").innerHTML.match(/stat-item/g) || []).length, loadLayout().stats.length - 1);
  assert.ok(!/NaN|undefined/.test(r.markup()));
});

test("render.js: **bold** works and nothing else from the data can become markup", () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>"><svg onload=alert(3)>';
  const c = realContent();
  c.profile = { ...c.profile, name: hostile, headline: hostile, tagline: hostile, email: `a@b.c"><script>alert(4)</script>`, github: "javascript:alert(5)", linkedin: "data:text/html,<script>alert(6)</script>" };
  c.about.paragraphs = [`**bold** ${hostile}`, "<b>x</b>"];
  c.skills = [{ name: hostile, icon: `fas fa-x" onclick="alert(7)`, level: hostile }];
  c.projects = [{ title: hostile, description: hostile, tech: [hostile], link: "javascript:alert(8)", icon: `x" onmouseover="alert(9)` }];
  c.certifications = [{ title: hostile, code: hostile, issuer: hostile, earned: hostile, validity: hostile, credentialId: hostile, icon: `x" onclick="alert(10)`, verifyUrl: "javascript:alert(11)" }];
  c.experience = [{ role: hostile, company: hostile, period: hostile, engagement: { name: hostile, since: hostile }, points: [hostile] }];
  c.education = [{ degree: hostile, institution: hostile, affiliation: hostile, period: hostile, score: hostile }];
  const r = renderWith(JSON.stringify(c));
  const markup = r.markup();

  assert.match(r.get("aboutText").innerHTML, /<p><strong>bold<\/strong> &lt;img/);
  assert.ok(r.get("aboutText").innerHTML.includes("&lt;b&gt;x&lt;/b&gt;"), "<b> from the data is shown as text");
  assert.ok(!/<img|<script|<svg|<b>/i.test(markup.replace(/<\/?strong>/g, "")), "no tag created from the data");
  assert.ok(!/href="(javascript|data):/i.test(markup), "script URLs in links become #");
  assert.ok(!/" on[a-z]+="/i.test(markup), "no attribute can be injected through an icon class or a value");
  assert.ok(markup.includes("&lt;img src=x onerror=alert(1)&gt;"), "the hostile text is still shown, as text");
  assert.equal(r.errors.length, 0);
});

test("render.js: optional fields are simply left out", () => {
  const c = realContent();
  c.skills = [{ name: "Plain" }];
  c.projects = [{ title: "No link", description: "d", tech: [], icon: "fas fa-code" }];
  c.certifications = [{ title: "Bare cert", issuer: "Someone" }];
  c.experience = [{ role: "R", company: "C", period: "2020", points: [] }];
  c.education = [{ degree: "D", institution: "I" }];
  const r = renderWith(JSON.stringify(c));
  assert.ok(!r.get("skillsGrid").innerHTML.includes("skill-level"), "no level line");
  assert.ok(!r.get("projectsGrid").innerHTML.includes("pearl-button"), "no button without a link");
  const cert = r.get("certificationsGrid").innerHTML;
  assert.ok(!cert.includes("cert-verify") && !cert.includes("cert-code") && !cert.includes("cert-credential") && !cert.includes("cert-validity"));
  assert.ok(cert.includes("fa-certificate"), "default badge icon");
  assert.ok(!r.get("experienceList").innerHTML.includes("since"), "no engagement line");
  const edu = r.get("educationGrid").innerHTML;
  assert.ok(!edu.includes("edu-score") && !edu.includes("fa-landmark"));
});

test("render.js: with no usable content the page says so, hides what would be empty, and never throws", () => {
  const good = realContent();
  const cases = {
    "no content element": null,
    "invalid JSON": "{ not json",
    "empty object": "{}",
    "profile without a name": JSON.stringify({ ...good, profile: { headline: "x" } }),
    "JSON null": "null",
  };
  for (const [label, json] of Object.entries(cases)) {
    const r = renderWith(json);
    assert.equal(r.get("contentUnavailable").hidden, false, `${label}: notice shown`);
    assert.ok(r.hiddenSections.every((s) => s.hidden), `${label}: content sections hidden`);
    assert.equal(r.heroContent.hidden, true, `${label}: hero text and buttons hidden`);
    assert.equal(r.window.siteContent, null, `${label}: no content published to other scripts`);
    assert.equal(r.get("skillsGrid").innerHTML, "", `${label}: nothing rendered`);
    assert.equal(r.errors.length, 1, `${label}: one console error`);
  }
});
