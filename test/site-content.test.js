const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const kbLib = require("../lib/kb");
const projects = require("../lib/projects");
const credentials = require("../lib/credentials");
const siteContent = require("../lib/site-content");
const tools = require("../lib/tools");
const { profileCard } = require("../lib/knowledge");

const clone = (o) => JSON.parse(JSON.stringify(o));
const NOW = new Date("2026-11-04T05:00:00Z");
const realKb = () => clone(kbLib.load());
const tmpFile = (content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "projects-")), "projects.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
const card = (extra = {}) => ({ title: "Tool", description: "Does a thing.", tech: ["Python"], link: "https://github.com/o/r", icon: "fab fa-python", order: 1, ...extra });

/* ---------------- projection: what reaches the browser ---------------- */

test("the content has exactly the sections the page renders, and a version that tracks the KB", () => {
  const c = siteContent.build({ now: NOW });
  assert.deepEqual(Object.keys(c), ["version", "updated", "profile", "about", "metrics", "skills", "projects", "certifications", "experience", "education"]);
  assert.equal(c.version, kbLib.version());
  assert.equal(c.updated, kbLib.load().updated);
});

test("WHITELIST: agent-only data and bookkeeping never reach the browser (real project file AND the KB fallback)", () => {
  const kb = realKb();
  // Plant a marker in every place that must NOT be exposed, plus an unknown field everywhere.
  kb.profile.secretNote = "LEAK-profile";
  kb.facts[0].text = "LEAK-fact";
  kb.linkedin.summary = "LEAK-linkedin-summary";
  kb.linkedin.positions[0].description = "LEAK-linkedin-position";
  kb.projects.forEach((p) => {
    p.highlights = "LEAK-readme-excerpt";
    p.internal = "LEAK-project";
  });
  kb.skills[0].internal = "LEAK-skill";
  kb.experience[0].internal = "LEAK-exp";
  kb.education[0].internal = "LEAK-edu";
  kb.credentials[0].internal = "LEAK-cred";

  // The second run reads the KB's own project copy (the path used when projects.json is unusable):
  // that is where ids, sources, README excerpts and the repo name live.
  const missing = path.join(os.tmpdir(), "no-such-projects.json");
  const runs = {
    "projects.json": siteContent.build({ kb, now: NOW }),
    "kb fallback": siteContent.build({ kb, now: NOW, projectCards: projects.load({ file: missing, fallback: kb.projects }) }),
  };
  assert.equal(runs["kb fallback"].projects.length, kb.projects.length, "the fallback really was used");

  for (const [label, content] of Object.entries(runs)) {
    const { updated, ...rest } = content;
    assert.equal(updated, kb.updated, `${label}: only the top-level date is exposed`);
    const raw = JSON.stringify(rest);
    assert.ok(!raw.includes("LEAK"), `${label}: no planted marker leaked`);
    for (const key of ['"id"', '"source"', '"updated"', '"facts"', '"linkedin_', '"asOf"', '"highlights"', '"repo"', '"internal"', '"secretNote"']) {
      assert.ok(!raw.includes(key), `${label}: ${key} is not exposed`);
    }
  }
});

test("the content never carries a phone number: not from the KB, a project card, or any text field", () => {
  const phone = "call +91 98765 43210 or (022) 2345 6789";
  const realRaw = JSON.stringify(siteContent.build({ now: NOW }));
  assert.ok(!/\+?\d[\d\s().-]{8,}\d/.test(realRaw.replace(/\d{4}-\d{2}-\d{2}/g, "")), "the real content has no phone-like sequences");

  // 1. a project card written by the automation
  const file = tmpFile({ items: [card({ description: `Great project, ${phone}` })] });
  const viaCard = JSON.stringify(siteContent.build({ now: NOW, projectCards: projects.load({ file }) }));
  assert.ok(viaCard.includes("[phone number withheld]") && !/98765|2345 6789/.test(viaCard), "project card text is redacted");

  // 2. every text field of the KB, even if a number slipped past validation
  const kb = realKb();
  kb.about.paragraphs[0] = `About me, ${phone}`;
  kb.profile.tagline = `Tagline ${phone}`;
  kb.skills[0].name = `Python ${phone}`;
  kb.experience[0].points[0] = `Did things ${phone}`;
  kb.education[0].score = `Top marks ${phone}`;
  kb.credentials[0].title = `Cert ${phone}`;
  const raw = JSON.stringify(siteContent.build({ kb, now: NOW }));
  assert.equal((raw.match(/\[phone number withheld\]/g) || []).length, 12, "both numbers are redacted in each of the six fields");
  assert.ok(!/98765|43210|2345 6789/.test(raw), "no digit of either number survives");
});

test("redaction never alters real values: every field matches the KB exactly", () => {
  const kb = kbLib.load();
  const c = siteContent.build({ now: NOW });
  assert.deepEqual(c.about.paragraphs, kb.about.paragraphs);
  assert.deepEqual(c.skills.map((s) => s.name), kb.skills.map((s) => s.name));
  assert.deepEqual(c.experience[0].points, kb.experience[0].points);
  assert.deepEqual(c.education.map((e) => [e.degree, e.institution, e.score]), kb.education.map((e) => [e.degree, e.institution, e.score]));
  for (const cert of c.certifications) {
    const source = kb.credentials.find((k) => k.title === cert.title);
    assert.equal(cert.credentialId, source.credentialId);
    assert.equal(cert.verifyUrl, source.verifyUrl);
    assert.equal(cert.earned, source.earned);
  }
  assert.equal(c.version, kbLib.version(kb), "the version hash is never run through redaction");
});

test("profile details come from kb.json: one place for contact details", () => {
  const kb = kbLib.load();
  const { profile } = siteContent.build({ now: NOW });
  assert.deepEqual(profile, {
    name: kb.profile.name,
    headline: kb.profile.headline,
    tagline: kb.profile.tagline,
    location: kb.profile.location,
    email: kb.profile.email,
    github: kb.profile.github,
    linkedin: kb.profile.linkedin,
  });
});

test("the site and the assistant agree: same e-mail and LinkedIn as the profile card the model is given", () => {
  const { profile } = siteContent.build({ now: NOW });
  const card = profileCard();
  assert.ok(card.includes(profile.email), "e-mail");
  assert.ok(card.includes(profile.linkedin), "LinkedIn");
});

test("the site and the assistant agree on certifications: same list, same order, same links, same validity", async () => {
  const site = siteContent.build({ now: NOW }).certifications;
  const ctx = { ...tools.defaultContext(), now: () => NOW };
  const result = await tools.get("get_certifications").run({}, ctx);
  assert.equal(site.length, result.certifications.length);
  site.forEach((c, i) => {
    const t = result.certifications[i];
    assert.equal(c.title, t.title, `title #${i}`);
    assert.equal(c.code, t.code || undefined, `code #${i}`);
    assert.equal(c.verifyUrl, t.verifyUrl || undefined, `verify link #${i}`);
    assert.equal(c.credentialId, t.credentialId || undefined, `credential id #${i}`);
    assert.equal(c.validity ? c.validity.charAt(0).toLowerCase() + c.validity.slice(1) : "no expiry listed", t.status, `validity #${i}`);
  });
});

test("metrics are counted from the data, never typed in", () => {
  const kb = realKb();
  const m = siteContent.build({ kb, now: NOW }).metrics;
  assert.equal(m.certifications, kb.credentials.length);
  assert.equal(m.skills, kb.skills.length);
  assert.equal(m.projects, projects.load({ fallback: kb.projects }).items.length);

  kb.credentials.pop();
  kb.skills.push({ id: "skill-new", source: "owner", updated: "2026-11-04", name: "Rust" });
  const after = siteContent.build({ kb, now: NOW }).metrics;
  assert.equal(after.certifications, m.certifications - 1);
  assert.equal(after.skills, m.skills + 1);
});

test("experience months: a current role counts up to now, an ended role to its end, never negative", () => {
  const role = (started, ended) => ({ started, ended });
  assert.equal(siteContent.experienceMonths([role("Jan 2026", null)], NOW), 10, "Jan -> Nov 2026");
  assert.equal(siteContent.experienceMonths([role("Jan 2026", "Mar 2026")], NOW), 2);
  assert.equal(siteContent.experienceMonths([role("Jan 2026", "Mar 2026"), role("Apr 2026", null)], NOW), 2 + 7, "separate roles add up");
  assert.equal(siteContent.experienceMonths([role("Jan 2026", "Mar 2026"), role("Mar 2026", "May 2026")], NOW), 4, "back-to-back roles add up");
  assert.equal(siteContent.experienceMonths([role("Dec 2026", null)], NOW), 0, "a future start never goes negative");
  assert.equal(siteContent.experienceMonths([], NOW), 0);
});

test("experience months: overlapping roles are merged, so time is never counted twice", () => {
  const role = (started, ended) => ({ started, ended });
  assert.equal(siteContent.experienceMonths([role("Jan 2026", "Dec 2026"), role("Mar 2026", "Oct 2026")], NOW), 11, "a role inside another adds nothing");
  assert.equal(siteContent.experienceMonths([role("Jan 2026", "Jun 2026"), role("Apr 2026", "Sep 2026")], NOW), 8, "a partial overlap counts once");
  assert.equal(siteContent.experienceMonths([role("Apr 2026", null), role("Jan 2026", "Jun 2026")], NOW), 10, "order in the KB does not matter");
  assert.equal(siteContent.experienceMonths([role("Jan 2025", "Mar 2025"), role("Jan 2026", null), role("Mar 2026", "Jun 2026")], NOW), 2 + 10, "gaps are not counted");
});

test("experience: period text, the engagement, and the points", () => {
  const [x] = siteContent.build({ now: NOW }).experience;
  assert.equal(x.period, "Jan 2026 – Present");
  assert.deepEqual(x.engagement, { name: "Microsoft Project: Agentic Factory Operations", since: "Apr 2026" });
  assert.ok(x.points.length >= 1);

  const kb = realKb();
  kb.experience[0].ended = "Jun 2026";
  delete kb.experience[0].engagement;
  const ended = siteContent.build({ kb, now: NOW }).experience[0];
  assert.equal(ended.period, "Jan 2026 – Jun 2026");
  assert.equal("engagement" in ended, false);
});

test("skills: a level and an icon appear only when the KB has them", () => {
  const kb = realKb();
  delete kb.skills[0].level;
  delete kb.skills[0].icon;
  const [first] = siteContent.build({ kb, now: NOW }).skills;
  assert.deepEqual(first, { name: kb.skills[0].name });
});

test("education carries degrees and scores from the KB", () => {
  const edu = siteContent.build({ now: NOW }).education;
  assert.equal(edu.length, kbLib.load().education.length);
  assert.match(edu[0].score, /7\.11/);
  assert.equal(edu[0].affiliation, "University of Mumbai");
  assert.equal("period" in edu[1], false, "optional fields are omitted, not null");
});

test("the output is deterministic for the same input", () => {
  assert.deepEqual(siteContent.build({ now: NOW }), siteContent.build({ now: NOW }));
});

/* ---------------- credential rules shared with the assistant ---------------- */

test("credentials.status: valid, expired and no-expiry", () => {
  const c = (expires) => ({ expires });
  assert.deepEqual(credentials.status(c("Oct 2027"), NOW), { state: "valid", label: "valid until Oct 2027" });
  assert.deepEqual(credentials.status(c("Oct 2026"), NOW), { state: "expired", label: "expired Oct 2026" });
  assert.deepEqual(credentials.status(c("Nov 2026"), NOW), { state: "valid", label: "valid until Nov 2026" }, "valid through the end of the month");
  assert.deepEqual(credentials.status({}, NOW), { state: "none", label: "no expiry listed" });
});

test("credentials.newestFirst sorts by earned month and does not mutate its input", () => {
  const list = [{ t: "a", earned: "Aug 2026" }, { t: "b", earned: "Oct 2026" }, { t: "c" }, { t: "d", earned: "Oct 2025" }];
  assert.deepEqual(credentials.newestFirst(list).map((x) => x.t), ["b", "a", "d", "c"]);
  assert.deepEqual(list.map((x) => x.t), ["a", "b", "c", "d"]);
});

test("an expired credential is shown as expired on the site too", () => {
  const kb = realKb();
  const later = new Date("2028-01-15T00:00:00Z");
  const certs = siteContent.build({ kb, now: later }).certifications;
  assert.ok(certs.some((c) => /^Expired Oct 2027$/.test(c.validity || "")));
});

/* ---------------- project cards ---------------- */

test("projects: the authority file decides what shows, in order, and hidden ones are dropped", () => {
  const file = tmpFile({ items: [card({ title: "Second", order: 2 }), card({ title: "Hidden", order: 0, featured: false }), card({ title: "First", order: 1 })] });
  const r = projects.load({ file });
  assert.deepEqual(r.items.map((p) => p.title), ["First", "Second"]);
  assert.equal(r.source, "projects.json");
  assert.equal(r.skipped, 0, "a deliberately hidden project is not 'skipped'");
});

test("projects: untrusted input is cleaned, bad items skipped, and limits enforced", () => {
  const file = tmpFile({
    items: [
      card({ title: "Unsafe link", link: "javascript:alert(1)" }),
      card({ title: "Plain http", link: "http://github.com/o/r" }),
      card({ title: "Bad icon", icon: 'fa-x" onclick="evil()' }),
      card({ title: "x".repeat(500), description: "d".repeat(2000), tech: Array(30).fill("t".repeat(100)) }),
      { description: "no title" },
      null,
      "string",
    ],
  });
  const r = projects.load({ file });
  const by = (t) => r.items.find((p) => p.title.startsWith(t));
  assert.equal(by("Unsafe link").link, null, "javascript: link dropped");
  assert.equal(by("Plain http").link, null, "only https links");
  assert.equal(by("Bad icon").icon, projects.DEFAULT_ICON, "icon that is not a Font Awesome class replaced");
  const long = by("xxxx");
  assert.ok(long.title.length <= 120 && long.description.length <= 700 && long.tech.length <= 12 && long.tech.every((t) => t.length <= 40));
  assert.equal(r.skipped, 3, "the title-less item, null and a string are skipped");
});

test("projects: a missing, broken or empty file falls back to the KB's GitHub-synced copy", () => {
  const fallback = realKb().projects;
  for (const file of [path.join(os.tmpdir(), "does-not-exist-projects.json"), tmpFile("{ not json"), tmpFile({ items: [] }), tmpFile({ items: [{ title: "" }] })]) {
    const r = projects.load({ file, fallback });
    assert.equal(r.source, "kb");
    assert.equal(r.items.length, fallback.length);
    assert.equal(r.items[0].title, fallback[0].title);
    assert.equal(r.items[0].icon, projects.DEFAULT_ICON);
  }
});

test("projects: the real file loads and matches what the site content shows", () => {
  const real = projects.load({ fallback: kbLib.load().projects });
  assert.equal(real.source, "projects.json");
  assert.ok(real.items.length >= 1);
  assert.equal(real.skipped, 0, "every item in the real file is valid");
  assert.deepEqual(siteContent.build({ now: NOW }).projects.map((p) => p.title), real.items.map((p) => p.title));
});

/* ---------------- page rendering ---------------- */

const TEMPLATE = `<head><meta name="description" content=""><title>Portfolio</title></head><body><!--SITE_CONTENT--><script src="x.js"></script></body>`;
const contentWith = (patch = {}) => {
  const c = siteContent.build({ now: NOW });
  return { ...c, profile: { ...c.profile, ...patch } };
};
const inlined = (html) => JSON.parse(/<script id="site-content" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

test("renderPage inlines the content and sets the title and description for crawlers", () => {
  const c = contentWith();
  const html = siteContent.renderPage(TEMPLATE, c);
  assert.ok(!html.includes("SITE_CONTENT"), "placeholder replaced");
  assert.deepEqual(inlined(html), c, "the inlined JSON is exactly the content");
  assert.match(html, /<title>Atharva Jadhav - AI &amp; Agentic Automation Engineer<\/title>/);
  assert.match(html, /<meta name="description" content="Building enterprise AI agents/);
  assert.ok(html.indexOf("site-content") < html.indexOf("x.js"), "content comes before the scripts that read it");
});

test("renderPage: hostile content cannot break out of the script block, the title or the attribute", () => {
  const evil = '</script><script>alert(1)</script><!-- "><img src=x onerror=alert(1)> \u2028 $& $1 $`';
  const c = contentWith({ name: evil, headline: evil, tagline: `"><script>alert(2)</script>${evil}` });
  const html = siteContent.renderPage(TEMPLATE, c);

  assert.equal((html.match(/<script/g) || []).length, 2, "only our data block and the template's own script");
  assert.ok(!html.includes("<img"), "no raw tag from the data");
  assert.ok(!html.includes("</script><script>"), "cannot close the data block");
  const block = /<script id="site-content" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(!/[\u2028\u2029<>&]/.test(block), "inside the data block, line separators and angle brackets are escaped");
  assert.deepEqual(inlined(html), c, "and the data still parses back to exactly what it was");

  const title = /<title>([^<]*)<\/title>/.exec(html)[1];
  assert.ok(title.includes("&lt;/script&gt;") && !title.includes("<"), "title is HTML-escaped");
  const meta = /<meta name="description" content="([^"]*)"/.exec(html)[1];
  assert.ok(meta.includes("&quot;&gt;&lt;script&gt;") && !meta.includes("<"), "attribute cannot be closed early");
  assert.ok(title.includes("$&") && title.includes("$1") && title.includes("$`"), "$-patterns in the data are copied literally, not interpreted");
});

test("renderPage with no content serves the page without data and keeps the default title", () => {
  const html = siteContent.renderPage(TEMPLATE, null);
  assert.ok(!html.includes("SITE_CONTENT") && !html.includes("site-content"));
  assert.match(html, /<title>Portfolio<\/title>/);
});

test("jsonForScript escapes the characters that can end or confuse an inline script", () => {
  const out = siteContent.jsonForScript({ a: "</script><!--&\u2028\u2029" });
  assert.ok(!/[<>&\u2028\u2029]/.test(out));
  assert.deepEqual(JSON.parse(out), { a: "</script><!--&\u2028\u2029" });
});
