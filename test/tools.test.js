const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const tools = require("../lib/tools");
const kbLib = require("../lib/kb");

const RESUME_TEXT = `Atharva Jadhav
AI & Agentic Automation Engineer

## PROFESSIONAL SUMMARY
Engineer at LTIMindtree working on enterprise Agentic AI for a Microsoft project.

## EXPERIENCE
Engineer, Cloud & Infra Management Apr 2026 – Present
LTIMindtree | Microsoft Project: Agentic Factory Operations
- Developed Copilot Studio agents

## PROJECTS
Omnichannel AI Support Sentinel (https://github.com/atharva723/multi-channel_support_system)
Built a multi-tenant support-triage platform using tenant-specific RAG.

## EDUCATION
Computer Engineering University of Mumbai

## TECHNICAL SKILLS
Python
Agentic AI
Copilot Studio

## CERTIFICATIONS
- Microsoft Certified: Azure Fundamentals (Exam AZ-900)

## ADDITIONAL TECHNICAL STACK
FastAPI • Ollama • Docker • Terraform`;

const kb = () => JSON.parse(JSON.stringify(kbLib.load()));
const LIVE = { available: true, text: RESUME_TEXT, fetchedAt: "2026-10-31T00:00:00.000Z" };
const ctx = (over = {}) => ({ kb: kb(), getResume: async () => LIVE, now: () => new Date("2026-11-01T00:00:00Z"), ...over });
const run = (name, args = {}, c = ctx()) => tools.get(name).run(tools.get(name).parameters && args, c);

/* ---- registry ---- */
test("the registry exposes exactly the nine read-only tools, each fully described", () => {
  assert.deepEqual(tools.names().sort(), [
    "get_certifications",
    "get_contact_info",
    "get_education",
    "get_experience",
    "get_linkedin_profile",
    "get_projects",
    "get_resume",
    "get_site_links",
    "get_skills",
  ]);
  for (const t of tools.TOOLS) {
    assert.match(t.name, /^get_[a-z_]+$/, "read-only naming");
    for (const field of ["label", "topic", "suggestion", "description"]) assert.ok(t[field], `${t.name}.${field}`);
    assert.equal(t.parameters.type, "object");
    assert.equal(typeof t.run, "function");
    assert.ok(t.description.length <= 260, `${t.name} description stays short (token cost in the planner prompt)`);
  }
  assert.equal(new Set(tools.TOOLS.map((t) => t.topic)).size, tools.TOOLS.length, "topics are unique");
});

test("the catalogue lists every tool with its argument signature", () => {
  const c = tools.catalogue();
  for (const n of tools.names()) assert.match(c, new RegExp(`- ${n}\\(`));
  assert.match(c, /get_skills\(query\?: string\)/);
  assert.match(c, /get_resume\(section\?: summary\|experience\|projects\|education\|skills\|certifications\|additional_stack\|all\)/);
  assert.ok(c.length < 2200, "catalogue stays small");
});

test("no tool can write, run code or fetch arbitrary URLs: modules only touch the KB and the resume source", () => {
  for (const file of fs.readdirSync(path.join(__dirname, "..", "lib", "tools"))) {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "tools", file), "utf8");
    assert.ok(!/child_process|writeFile|appendFile|unlink|eval\(|new Function|fetch\(|https?\.request|require\("net"\)/.test(src), `${file} has no side-effect APIs`);
  }
});

/* ---- certifications ---- */
test("get_certifications returns all four, newest first, with computed status and links", async () => {
  const r = await run("get_certifications");
  assert.equal(r.total_held, 4);
  assert.equal(r.matched, 4);
  assert.equal(r.certifications[r.certifications.length - 1].code, "AZ-900", "Aug 2026 is the oldest");
  assert.ok(r.certifications.every((c) => /^https:\/\//.test(c.verifyUrl)));
  const byCode = Object.fromEntries(r.certifications.map((c) => [c.code, c]));
  assert.equal(byCode["AZ-900"].status, "no expiry listed");
  assert.equal(byCode["AI-103"].status, "valid until Oct 2027");
  assert.equal(byCode["CCAO-F"].status, "valid until Oct 2027");
  assert.equal(byCode["AI-901"].credentialId, "493ADEA057BE4512");
});

test("expiry status is COMPUTED from the clock, not guessed by a model", async () => {
  const later = ctx({ now: () => new Date("2028-03-01T00:00:00Z") });
  const r = await run("get_certifications", {}, later);
  assert.equal(r.certifications.find((c) => c.code === "AI-103").status, "expired Oct 2027");
  const sameMonth = ctx({ now: () => new Date("2027-10-15T00:00:00Z") });
  assert.equal((await run("get_certifications", {}, sameMonth)).certifications.find((c) => c.code === "AI-103").status, "valid until Oct 2027");
});

test("get_certifications filters by query and reports a definitive miss", async () => {
  const claude = await run("get_certifications", { query: "claude" });
  assert.equal(claude.matched, 1);
  assert.equal(claude.certifications[0].issuer, "Anthropic");
  assert.equal(claude.total_held, 4);

  const ms = await run("get_certifications", { query: "AZ-900" });
  assert.deepEqual(ms.certifications.map((c) => c.code), ["AZ-900"]);

  const none = await run("get_certifications", { query: "Kubernetes" });
  assert.equal(none.matched, 0);
  assert.match(none.note, /No certification matches "Kubernetes"\. He holds 4 in total/);
});

/* ---- education ---- */
test("get_education returns degrees with grades, years and university", async () => {
  const r = await run("get_education");
  assert.equal(r.education.length, 2);
  assert.deepEqual(r.education[0], {
    degree: "Bachelor of Engineering (B.E.) in Computer Engineering",
    institution: "M.G.M. College of Engineering, Kamothe",
    university: "University of Mumbai",
    studied: "2021–2025",
    graduated: "2025",
    grades: "7.11 CGPA overall, 8.21 CGPA in the final semester",
  });
  assert.match(r.education[1].grades, /77%/);
});

/* ---- projects ---- */
test("get_projects lists projects with links and bounded descriptions", async () => {
  const r = await run("get_projects");
  assert.equal(r.total_projects, 8);
  assert.equal(r.projects.length, 6, "capped");
  for (const p of r.projects) {
    assert.match(p.link, /^https:\/\/github\.com\//);
    assert.ok(p.description.length <= 300);
    assert.ok(!p.details || p.details.length <= 280);
  }
  assert.match(r.resume_projects, /Omnichannel AI Support Sentinel/);
});

test("get_projects ranks by query, includes matching resume projects, and reports a miss", async () => {
  const rag = await run("get_projects", { query: "RAG" });
  assert.ok(rag.matched >= 1);
  assert.match(rag.projects[0].description + rag.projects[0].details + rag.projects[0].title, /RAG/);
  assert.match(rag.resume_projects, /tenant-specific RAG/);

  const none = await run("get_projects", { query: "cobol mainframe" });
  assert.equal(none.matched, 0);
  assert.equal(none.resume_projects, undefined);
  assert.match(none.note, /No project matches/);
});

test("get_projects works without the live resume", async () => {
  const r = await run("get_projects", {}, ctx({ getResume: async () => ({ available: false }) }));
  assert.equal(r.resume_projects, undefined);
  assert.equal(r.projects.length, 6);
});

/* ---- skills ---- */
test("get_skills lists resume skills, the additional stack and LinkedIn skills", async () => {
  const r = await run("get_skills");
  assert.deepEqual(r.resume_skills, ["Python", "Agentic AI", "Copilot Studio"]);
  assert.deepEqual(r.resume_additional_stack, ["FastAPI", "Ollama", "Docker", "Terraform"]);
  assert.ok(r.linkedin_skills.includes("Terraform"));
  assert.equal(r.resume_available, true);
});

test("get_skills answers 'does he know X' definitively", async () => {
  const yes = await run("get_skills", { query: "terraform" });
  assert.equal(yes.listed, true);
  assert.deepEqual(yes.matches_in_resume, ["Terraform"]);
  assert.deepEqual(yes.matches_in_linkedin, ["Terraform"]);
  assert.equal(yes.note, undefined);
  assert.equal(yes.resume_skills, undefined, "only the answer, not every list (token cost)");

  const no = await run("get_skills", { query: "Rust" });
  assert.equal(no.listed, false);
  assert.match(no.note, /"Rust" is not listed in his resume or LinkedIn skills/);
});

test("get_skills still answers from LinkedIn when the resume is unavailable", async () => {
  const r = await run("get_skills", { query: "terraform" }, ctx({ getResume: async () => ({ available: false }) }));
  assert.equal(r.resume_available, false);
  assert.equal(r.listed, true);
  assert.deepEqual(r.matches_in_resume, []);
});

/* ---- experience ---- */
test("get_experience combines the live resume, the employment timeline and the LinkedIn snapshot", async () => {
  const r = await run("get_experience");
  assert.match(r.resume_summary, /Engineer at LTIMindtree/);
  assert.match(r.resume_experience, /Apr 2026 – Present/);
  assert.deepEqual(r.timeline, ["Atharva joined LTIMindtree full-time in January 2026. His work as an AI engineer on the Microsoft project (Agentic Factory Operations) began in April 2026."]);
  assert.equal(r.linkedin_positions[0].company, "LTIMindtree");
  assert.equal(r.linkedin_positions[0].ended, "present");
  assert.equal(r.linkedin_snapshot_as_of, kb().linkedin.asOf);
});

test("get_experience degrades gracefully without the resume", async () => {
  const r = await run("get_experience", {}, ctx({ getResume: async () => ({ available: false }) }));
  assert.equal(r.resume_available, false);
  assert.equal(r.resume_experience, undefined);
  assert.ok(r.timeline.length === 1 && r.linkedin_positions.length === 1);
});

/* ---- contact ---- */
test("get_contact_info gives channels and policy notes, and never a phone number", async () => {
  const r = await run("get_contact_info");
  assert.equal(r.email, "atharvajadhav968@gmail.com");
  assert.match(r.linkedin, /linkedin\.com\/in\//);
  assert.equal(r.github, "https://github.com/atharva723");
  assert.equal(r.portfolio_site, "https://atharva-host.vercel.app/");
  assert.equal(r.location, "Mumbai, India");
  const notes = r.notes.join(" ");
  assert.match(notes, /Salary expectations are not listed/);
  assert.match(notes, /phone number is never shared/);
  assert.ok(!/\+?\d[\d\s().-]{8,}\d/.test(JSON.stringify(r)), "no phone-like digits");
});

/* ---- linkedin ---- */
test("get_linkedin_profile returns a dated snapshot and says it may lag the live profile", async () => {
  const r = await run("get_linkedin_profile");
  assert.match(r.profile_url, /linkedin\.com\/in\//);
  assert.match(r.snapshot_as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.headline, /Cloud & AI Engineer/);
  assert.ok(r.skills.length > 10);
  assert.match(r.note, /may be newer/);
});

test("get_linkedin_profile without a snapshot still returns the link", async () => {
  const bare = kb();
  bare.linkedin = null;
  const r = await run("get_linkedin_profile", {}, ctx({ kb: bare }));
  assert.equal(r.snapshot_available, false);
  assert.match(r.profile_url, /linkedin\.com\/in\//);
});

/* ---- resume ---- */
test("get_resume returns the whole resume or a single section", async () => {
  const all = await run("get_resume");
  assert.equal(all.available, true);
  assert.equal(all.section, "all");
  assert.match(all.text, /Agentic Factory Operations/);
  assert.equal(all.as_of, "2026-10-31T00:00:00.000Z");

  const edu = await run("get_resume", { section: "education" });
  assert.match(edu.text, /^EDUCATION\nComputer Engineering University of Mumbai$/);

  const missing = await run("get_resume", { section: "summary" }, ctx({ getResume: async () => ({ ...LIVE, text: "Atharva\n## EXPERIENCE\nx" }) }));
  assert.match(missing.note, /no "summary" section/);
});

test("get_resume reports stale copies, truncation and unavailability honestly", async () => {
  const stale = await run("get_resume", {}, ctx({ getResume: async () => ({ ...LIVE, stale: true }) }));
  assert.equal(stale.stale, true);

  const long = "Atharva Jadhav\n" + "line of resume text\n".repeat(600);
  const big = await run("get_resume", {}, ctx({ getResume: async () => ({ ...LIVE, text: long }) }));
  assert.equal(big.truncated, true);
  assert.ok(big.text.length <= 6000);

  const down = await run("get_resume", {}, ctx({ getResume: async () => ({ available: false }) }));
  assert.deepEqual(down, { available: false, note: "The live resume is temporarily unavailable." });
});

/* ---- site links ---- */
test("get_site_links only points at sections that exist on the page", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const r = await run("get_site_links");
  assert.equal(r.sections.length, 6);
  for (const id of Object.keys(require("../lib/tools/site-links").SECTIONS)) assert.match(html, new RegExp(`<section[^>]*id="${id}"`), `#${id} exists in index.html`);
  assert.match(r.sections[0], /^about: https:\/\/atharva-host\.vercel\.app\/#about — /);

  const one = await run("get_site_links", { section: "projects" });
  assert.deepEqual(one.sections, ["projects: https://atharva-host.vercel.app/#projects — Featured projects"]);
});

/* ---- executor ---- */
test("execute validates, runs and renders; it NEVER throws", async () => {
  const ok = await tools.execute("get_education", {}, ctx());
  assert.equal(ok.ok, true);
  assert.equal(ok.label, "Education");
  assert.match(ok.text, /^education:\n- \{"degree"/);

  const unknown = await tools.execute("rm_rf", {}, ctx());
  assert.deepEqual([unknown.ok, unknown.error, unknown.text], [false, "unknown tool", "error: unknown tool"]);

  const badArgs = await tools.execute("get_resume", { section: "../../etc/passwd" }, ctx());
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.error, /must be one of/);

  const tooLong = await tools.execute("get_skills", { query: "x".repeat(200) }, ctx());
  assert.equal(tooLong.ok, false);
});

test("a crashing tool becomes a generic failure without leaking its error message", async () => {
  const warn = console.warn;
  console.warn = () => {};
  const t = tools.get("get_education");
  const real = t.run;
  t.run = async () => {
    throw new Error("SECRET internal path C:\\prod\\db.sqlite");
  };
  try {
    const r = await tools.execute("get_education", {}, ctx());
    assert.equal(r.ok, false);
    assert.equal(r.error, "lookup failed");
    assert.ok(!/SECRET|prod/.test(JSON.stringify(r)));
  } finally {
    t.run = real;
    console.warn = warn;
  }
});

test("a hanging tool is cut off by the timeout", async () => {
  const warn = console.warn;
  console.warn = () => {};
  const t = tools.get("get_education");
  const real = t.run;
  t.run = () => new Promise(() => {});
  try {
    const started = Date.now();
    const r = await tools.execute("get_education", {}, ctx(), { timeoutMs: 40 });
    assert.equal(r.error, "timed out");
    assert.ok(Date.now() - started < 1000);
  } finally {
    t.run = real;
    console.warn = warn;
  }
});

test("oversized results are truncated to a hard cap", async () => {
  const t = tools.get("get_education");
  const real = t.run;
  t.run = async () => ({ blob: "x".repeat(50000) });
  try {
    const r = await tools.execute("get_education", {}, ctx());
    assert.ok(r.text.length <= 6500);
  } finally {
    t.run = real;
  }
});

test("runAll de-duplicates, caps at three and runs in parallel", async () => {
  const calls = [
    { name: "get_education", args: {} },
    { name: "get_education", args: {} },
    { name: "get_certifications", args: {} },
    { name: "get_projects", args: { query: "RAG" } },
    { name: "get_contact_info", args: {} },
  ];
  const results = await tools.runAll(calls, ctx());
  assert.deepEqual(results.map((r) => r.name), ["get_education", "get_certifications", "get_projects"]);

  const slow = tools.get("get_education");
  const real = slow.run;
  slow.run = () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 120));
  try {
    const started = Date.now();
    await tools.runAll([{ name: "get_education", args: {} }, { name: "get_certifications", args: {} }, { name: "get_contact_info", args: {} }], ctx());
    assert.ok(Date.now() - started < 400, "not serial");
  } finally {
    slow.run = real;
  }
});

test("source labels are the fixed labels of successful tools only", async () => {
  const results = await tools.runAll([{ name: "get_certifications", args: {} }, { name: "nope", args: {} }, { name: "get_resume", args: {} }], ctx());
  assert.deepEqual(tools.sourceLabels(results), ["Certifications", "Live resume"]);
});

test("suggestions skip covered topics and keep a stable order", () => {
  assert.deepEqual(tools.suggest([], 3).map((s) => s.topic), ["experience", "certifications", "projects"]);
  assert.deepEqual(tools.suggest(["experience", "projects"], 3).map((s) => s.topic), ["certifications", "skills", "education"]);
  assert.equal(tools.suggest(["experience", "certifications", "projects", "skills", "education", "contact"], 3).length, 0);
  assert.equal(tools.suggest([], 3)[0].text, "What is his current role?");
});
