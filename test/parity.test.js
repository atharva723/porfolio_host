/* =====================================================================
   PARITY: the website and the assistant can never tell different stories
   ---------------------------------------------------------------------
   kb/kb.json is the one record. These tests compare what the site SHOWS
   with what the assistant's tools SAY and what its prompt CONTAINS, and
   scan the code for copies of the owner's facts typed in by hand. If one
   of them fails, two places have started to disagree.
   ===================================================================== */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// A clean environment regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const kbLib = require("../lib/kb");
const siteContent = require("../lib/site-content");
const tools = require("../lib/tools");
const { RESUME_TEXT } = require("./helpers/fixtures");
const app = require("../server");

const ROOT = path.join(__dirname, "..");
const NOW = new Date("2026-11-04T05:00:00Z");

/* ---------------- helpers ---------------- */

const site = () => siteContent.build({ now: NOW });
const context = () => ({ ...tools.defaultContext(), getResume: async () => ({ available: true, text: RESUME_TEXT }), now: () => NOW });

async function toolData(name, args = {}) {
  const r = await tools.execute(name, args, context());
  assert.ok(r.ok, `${name} ran: ${r.error}`);
  return r.data;
}

const byKey = (items, key) => new Map(items.map((i) => [i[key], i]));
const squash = (s) => String(s).replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function* strings(value, at = "") {
  if (typeof value === "string") yield [at, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${at}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* strings(v, at ? `${at}.${k}` : k);
}

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

/* ---------------- one version everywhere ---------------- */

test("the page, /data/site.json, /api/health and the answer cache all carry the same content version", async () => {
  const page = await (await fetch(`${base}/`)).text();
  const inline = JSON.parse(/<script id="site-content" type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]);
  const json = await (await fetch(`${base}/data/site.json`)).json();
  const health = await (await fetch(`${base}/api/health`)).json();

  const version = kbLib.version();
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.equal(inline.version, version, "the inline block of the page");
  assert.equal(json.version, version, "/data/site.json");
  assert.equal(health.kb.version, version, "/api/health");
  assert.equal(health.kb.valid, true);
  assert.equal(health.kb.updated, kbLib.load().updated);
  assert.equal(json.updated, health.kb.updated);
});

/* ---------------- the same facts, site vs tools ---------------- */

test("contact details: the site, the contact tool and the links tool give the same address, profiles and name", async () => {
  const s = site().profile;
  const c = await toolData("get_contact_info");
  for (const field of ["name", "email", "github", "linkedin", "location"]) assert.equal(c[field], s[field], field);
  assert.equal(c.portfolio_site, kbLib.load().profile.website);
  const links = await toolData("get_site_links");
  assert.equal(links.site, kbLib.load().profile.website);
});

test("certifications: same set, codes, issuers, dates, credential IDs and verify links", async () => {
  const onSite = site().certifications;
  const said = await toolData("get_certifications");
  assert.equal(said.total_held, onSite.length);
  assert.equal(said.certifications.length, onSite.length);
  assert.equal(site().metrics.certifications, onSite.length);
  const tool = byKey(said.certifications, "title");
  for (const c of onSite) {
    const t = tool.get(c.title);
    assert.ok(t, `the tool lists "${c.title}"`);
    for (const f of ["code", "issuer", "earned", "credentialId", "verifyUrl"]) assert.equal(t[f], c[f], `${c.title}: ${f}`);
  }
});

test("education: same schools, degrees, years, grades and university", async () => {
  const onSite = site().education;
  const said = await toolData("get_education");
  assert.equal(said.education.length, onSite.length);
  const tool = byKey(said.education, "institution");
  for (const e of onSite) {
    const t = tool.get(e.institution);
    assert.ok(t, `the tool lists ${e.institution}`);
    assert.equal(t.degree, e.degree);
    assert.equal(t.studied || undefined, e.period);
    assert.equal(t.grades || undefined, e.score);
    assert.equal(t.university || undefined, e.affiliation);
  }
});

test("skills: same names, same order, and a level is the same self-rating on both sides", async () => {
  const onSite = site().skills;
  const said = (await toolData("get_skills")).skills;
  assert.deepEqual(said.map((s) => s.name), onSite.map((s) => s.name));
  for (const [i, s] of onSite.entries()) assert.equal(said[i].self_rated_level, s.level, s.name);
  assert.equal(site().metrics.skills, onSite.length);
});

test("projects: same total and order; the tool says when it shows only some; every site project can be reached", async () => {
  const onSite = site().projects;
  assert.equal(site().metrics.projects, onSite.length);

  const all = await toolData("get_projects");
  assert.equal(all.total_projects, onSite.length);
  assert.deepEqual(all.projects.map((p) => p.title), onSite.slice(0, all.projects.length).map((p) => p.title), "same order");
  if (all.projects.length < onSite.length) assert.match(all.note, new RegExp(`Showing ${all.projects.length} of ${onSite.length}`), "a shortened list says so");

  // The list is capped, so check each project through a lookup by its own title.
  for (const p of onSite) {
    const found = (await toolData("get_projects", { query: p.title })).projects.find((t) => t.title === p.title);
    assert.ok(found, `the tool finds "${p.title}"`);
    assert.equal(found.link, p.link, p.title);
    assert.deepEqual(found.tech || [], p.tech || [], p.title);
  }
});

test("experience: same roles, employers, start and end dates, project, and responsibilities", async () => {
  const onSite = site().experience;
  const said = await toolData("get_experience");
  assert.equal(said.roles.length, onSite.length);
  const long = kbLib.longMonth;
  for (const [i, role] of onSite.entries()) {
    const raw = kbLib.load().experience[i];
    const line = said.roles[i];
    assert.ok(line.includes(role.role) && line.includes(role.company), `role ${i}: ${line}`);
    assert.ok(line.includes(long(raw.started)), `the start date ${raw.started} in: ${line}`);
    assert.equal(role.period, `${raw.started} – ${raw.ended || "Present"}`);
    if (raw.ended) assert.ok(line.includes(long(raw.ended)), `the end date in: ${line}`);
    else assert.ok(/present/.test(line), "a current role is said to be current");
    if (raw.engagement) {
      assert.ok(line.includes(raw.engagement.name) && line.includes(long(raw.engagement.started)), `the project in: ${line}`);
      assert.equal(role.engagement.name, raw.engagement.name);
      assert.equal(role.engagement.since, raw.engagement.started);
    }
    for (const point of role.points) assert.ok(said.responsibilities.includes(point), `the tool lists: ${point}`);
  }
});

/* ---------------- everything on the site is something the assistant knows ---------------- */

// Derived or purely visual values, which are not facts to remember: icons, the content hash and date,
// the "Valid" badge (computed from dates), the marketing tagline, and the two date strings that are the
// raw dates written another way (checked against the experience tool above).
const NOT_A_FACT = /(^|\.)(icon|version|updated|validity|tagline)$|^experience\[\d+\]\.(period|engagement\.since)$/;

// The part of the assistant's knowledge text that must carry each part of the site. Checking a fact
// against the WHOLE text proves little: "Python" or "Advanced" appear in many places.
const SECTION = {
  profile: /^Name:/,
  about: /^About him/,
  experience: /^Experience/,
  skills: /^Skills/,
  education: /^Education/,
  certifications: /^Certifications and credentials/,
  projects: /^Projects/,
};
const knowledge = () => {
  const blocks = kbLib.toText().split("\n\n");
  return Object.fromEntries(Object.entries(SECTION).map(([key, re]) => [key, blocks.find((b) => re.test(b)) || ""]));
};

test("every fact the site shows is in the matching section of the assistant's knowledge text, word for word", () => {
  const text = Object.fromEntries(Object.entries(knowledge()).map(([k, v]) => [k, squash(v)]));
  for (const [key, block] of Object.entries(text)) assert.ok(block.length > 20, `the assistant's text has a ${key} section`);
  let checked = 0;
  for (const [at, value] of strings(site())) {
    if (NOT_A_FACT.test(at) || at.startsWith("metrics")) continue;
    const key = /^[a-z]+/.exec(at)[0];
    assert.ok(text[key] !== undefined, `${at}: the site has a "${key}" section the assistant's text does not`);
    checked++;
    assert.ok(text[key].includes(squash(value)), `${at} ("${value.slice(0, 60)}") is on the site but not in the assistant's ${key} section`);
  }
  assert.ok(checked > 60, `walked ${checked} values: more than a handful, so the check is not vacuous`);
});

test("each item on the site appears WHOLE in the assistant's text: a skill with its level, a project with its link and tech, a certificate with its ID and verify link", () => {
  const s = site();
  const k = knowledge();
  const line = (section, starts) => k[section].split("\n").findIndex((l) => l.startsWith(starts));
  const lines = (section) => k[section].split("\n");

  const contact = lines("profile").find((l) => l.startsWith("Contact:"));
  assert.ok(contact.includes(`email ${s.profile.email}`) && contact.includes(`GitHub ${s.profile.github}`) && contact.includes(`LinkedIn ${s.profile.linkedin}`), "contact line");

  for (const sk of s.skills) assert.ok(k.skills.includes(sk.level ? `${sk.name} (${sk.level}, self-rated)` : sk.name), `skill ${sk.name} with its level`);

  for (const p of s.projects) {
    const i = line("projects", `- ${p.title} (${p.link})`);
    assert.ok(i >= 0, `project ${p.title}`);
    assert.ok(lines("projects")[i].includes(p.description), `${p.title}: its description is on the same line`);
    if (p.tech && p.tech.length) assert.equal(lines("projects")[i + 1].trim(), `Tech: ${p.tech.join(", ")}`, `${p.title}: its tech is on the next line`);
  }

  for (const e of s.education) {
    const l = lines("education").find((x) => x.startsWith(`- ${e.degree} —`));
    assert.ok(l, `education ${e.degree}`);
    for (const part of [e.institution, e.affiliation, e.period && `studied ${e.period}`, e.score]) if (part) assert.ok(l.includes(part), `${e.degree}: ${part}`);
  }

  for (const c of s.certifications) {
    const all = lines("certifications");
    const i = all.findIndex((x) => x.startsWith(`- ${c.title}`));
    assert.ok(i >= 0, `certificate ${c.title}`);
    for (const part of [c.code && `(${c.code})`, c.issuer, c.earned && `earned ${c.earned}`, c.credentialId && `credential ID ${c.credentialId}`]) if (part) assert.ok(all[i].includes(part), `${c.title}: ${part}`);
    if (c.verifyUrl) assert.equal(all[i + 1].trim(), `Verify: ${c.verifyUrl}`, `${c.title}: its verify link is on the next line`);
  }

  for (const x of s.experience) {
    const i = line("experience", `- ${x.role} at ${x.company}`);
    assert.ok(i >= 0, `role ${x.role}`);
    const rest = lines("experience").slice(i + 1);
    if (x.engagement) assert.ok(rest[0].includes(`Project: ${x.engagement.name}`), "its project is on the next line");
    for (const point of x.points) assert.ok(rest.some((l) => l.trim() === `• ${point}`), `responsibility: ${point.slice(0, 40)}`);
  }
});

test("the exemptions above are not hiding a fact: each exempt path really is derived or decorative", () => {
  const exempt = [...strings(site())].filter(([at]) => NOT_A_FACT.test(at)).map(([at]) => at.replace(/\[\d+\]/g, "[]"));
  const kinds = new Set(exempt.map((p) => p.split(".").pop()));
  for (const k of kinds) assert.ok(["icon", "version", "updated", "validity", "tagline", "period", "since"].includes(k), `unexpected exemption: ${k}`);
});

/* ---------------- no hand-typed copies of the owner's facts ---------------- */

function walk(dir, accept) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, accept) : accept(full) ? [full] : [];
  });
}

test("no server code, script, page or stylesheet holds a typed-in copy of a fact that lives in kb.json", () => {
  const kb = kbLib.load();
  const p = kb.profile;
  const first = p.name.split(" ")[0];
  const last = p.name.split(" ").slice(-1)[0];
  // Skill names are left out on purpose: they are ordinary technology words that prompts use as examples.
  const needles = new Map();
  const add = (kind, value) => value && String(value).length >= 4 && needles.set(String(value).toLowerCase(), kind);
  [p.name, first, last, p.email, p.email.split("@")[0], p.github, p.linkedin, p.website, p.employer, p.location, p.headline].forEach((v) => add("profile", v));
  if (p.website) add("site host", new URL(p.website).hostname);
  for (const x of kb.experience) [x.role, x.company, x.engagement && x.engagement.name].forEach((v) => add("experience", v));
  for (const e of kb.education) [e.institution, e.degree, e.affiliation].forEach((v) => add("education", v));
  for (const c of kb.credentials) [c.title, c.code, c.credentialId, c.verifyUrl].forEach((v) => add("certification", v));
  for (const pr of kb.projects) [pr.title, pr.repo, pr.link].forEach((v) => add("project", v));

  const code = (f) => /\.(js|css|html)$/.test(f);
  const files = [
    ...walk(path.join(ROOT, "lib"), code),
    ...walk(path.join(ROOT, "public"), code),
    ...walk(path.join(ROOT, "views"), code),
    ...walk(path.join(ROOT, "scripts"), code),
    path.join(ROOT, "server.js"),
  ];
  assert.ok(files.length > 40, `scanned ${files.length} files`);

  const found = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    for (const [needle, kind] of needles) if (text.includes(needle)) found.push(`${path.relative(ROOT, file)} contains the ${kind} "${needle}"`);
  }
  assert.deepEqual(found, [], "read these from kb.json (kb.load()) instead of typing them in");
});

test("scripts/linkedin.config.json (the importer's own notes) never disagrees with kb.json about a certificate code", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "linkedin.config.json"), "utf8"));
  const credentials = kbLib.load().credentials;
  for (const [title, code] of Object.entries(config.credentialCodes)) {
    assert.ok(credentials.some((c) => c.title === title && c.code === code), `${title} (${code}) is in kb.json with that code`);
  }
  for (const title of config.excludeCredentials) assert.ok(!credentials.some((c) => c.title === title), `${title} is excluded, so kb.json must not have it`);
});
