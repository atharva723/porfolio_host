const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const tools = require("../lib/tools");
const kbLib = require("../lib/kb");
const { RESUME_TEXT } = require("./helpers/fixtures");
process.env.RESUME_PDF_DOC_URL = ""; // chips and links must not depend on a developer's local .env

const kb = () => JSON.parse(JSON.stringify(kbLib.load()));
const LIVE = { available: true, text: RESUME_TEXT, fetchedAt: "2026-10-31T00:00:00.000Z" };
const ctx = (over = {}) => ({ kb: kb(), getResume: async () => LIVE, resumeDownload: () => ({ url: null }), now: () => new Date("2026-11-01T00:00:00Z"), ...over });
const run = (name, args = {}, c = ctx()) => tools.get(name).run(tools.get(name).parameters && args, c);

/* ---- registry ---- */
test("the registry exposes exactly the ten read-only tools, each fully described", () => {
  assert.deepEqual(tools.names().sort(), [
    "get_certifications",
    "get_contact_info",
    "get_education",
    "get_experience",
    "get_linkedin_profile",
    "get_projects",
    "get_resume",
    "get_resume_download",
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
test("get_skills: his profile's skills come first, and every level is named as his own rating", async () => {
  const r = await run("get_skills");
  const profile = kb().skills;
  assert.deepEqual(r.skills.map((s) => s.name), profile.map((s) => s.name), "exactly the skills the website shows, in order");
  const python = r.skills.find((s) => s.name === "Python");
  assert.equal(python.self_rated_level, "Advanced");
  assert.equal("level" in python, false, "the field name itself says the level is self-rated");
  assert.equal(r.skills.find((s) => s.name === "Agentic AI").self_rated_level, undefined, "no level is invented for a skill without one");
  assert.match(r.note, /his own rating of himself, not an assessment/);
  assert.equal(r.resume_available, true);
});

test("get_skills: the resume and LinkedIn only add what the profile does not already list", async () => {
  const r = await run("get_skills");
  assert.deepEqual(r.resume_other_skills, ["FastAPI", "Ollama"], "Docker and Terraform are already in the profile");
  const known = new Set(kb().skills.map((s) => s.name.toLowerCase()));
  for (const s of [...r.resume_other_skills, ...r.linkedin_other_skills]) assert.ok(!known.has(s.toLowerCase()), `${s} is not a duplicate of a profile skill`);
  assert.ok(r.linkedin_other_skills.includes("Machine Learning"));
  assert.ok(!r.linkedin_other_skills.includes("Terraform") && !r.linkedin_other_skills.includes("FastAPI"));
});

test("get_skills answers 'does he know X' definitively, naming where it is listed", async () => {
  const yes = await run("get_skills", { query: "terraform" });
  assert.equal(yes.listed, true);
  assert.deepEqual(yes.matches_in_profile, [{ name: "Terraform", self_rated_level: "Intermediate" }]);
  assert.deepEqual(yes.resume_matches, ["Terraform"]);
  assert.deepEqual(yes.linkedin_matches, ["Terraform"]);
  assert.equal(yes.note, undefined);
  assert.equal(yes.related_skills, undefined);
  assert.equal(yes.skills, undefined, "only the answer, not every list (token cost)");

  const no = await run("get_skills", { query: "Rust" });
  assert.equal(no.listed, false);
  assert.match(no.note, /^"Rust" is not listed in his profile, resume or LinkedIn skills\.$/);
});

test("get_skills: a skill is listed when his profile has it, even if the resume and LinkedIn do not (the profile is the record)", async () => {
  const r = await run("get_skills", { query: "Power Platform" });
  assert.equal(r.listed, true);
  assert.deepEqual(r.matches_in_profile, [{ name: "Power Platform" }]);
  assert.deepEqual(r.resume_matches, []);
  assert.deepEqual(r.linkedin_matches, []);
});

test("get_skills: a skill only the resume lists is still reported, as resume-only", async () => {
  const r = await run("get_skills", { query: "fastapi" });
  assert.equal(r.listed, true);
  assert.deepEqual(r.matches_in_profile, []);
  assert.deepEqual(r.resume_matches, ["FastAPI"]);
});

test("get_skills matches WHOLE WORDS: 'GitLab' is not 'Git', 'R' is not every skill, 'LLM' is 'LLMs'", async () => {
  const gitlab = await run("get_skills", { query: "GitLab" });
  assert.equal(gitlab.listed, false, "GitLab is not listed just because Git is");
  assert.deepEqual(gitlab.matches_in_profile, []);

  const r = await run("get_skills", { query: "R" });
  assert.equal(r.listed, false, "a one-letter query must not match Docker, Terraform, ...");
  assert.deepEqual([r.matches_in_profile, r.resume_matches, r.linkedin_matches], [[], [], []]);

  const git = await run("get_skills", { query: "git" });
  assert.deepEqual(git.matches_in_profile, [{ name: "Git", self_rated_level: "Advanced" }], "an exact skill still matches");
  assert.ok(!JSON.stringify(git.matches_in_profile).includes("GitHub Copilot"), "'git' is not 'GitHub'");

  const llm = await run("get_skills", { query: "LLM" });
  assert.equal(llm.listed, true);
  assert.ok(llm.matches_in_profile.some((s) => s.name === "LLMs / RAG"), "plural and word order: LLMs / RAG");
  assert.equal((await run("get_skills", { query: "RAG" })).matches_in_profile[0].name, "LLMs / RAG");
  assert.equal((await run("get_skills", { query: "devops" })).matches_in_profile[0].name, "Azure DevOps", "a word inside a listed skill");
});

test("get_skills: a broader listed skill inside the query is 'related', never a match", async () => {
  const r = await run("get_skills", { query: "Azure Kubernetes Service" });
  assert.equal(r.listed, false, "he lists Azure, not Azure Kubernetes Service");
  assert.deepEqual(r.matches_in_profile, []);
  assert.ok(r.related_skills.includes("Azure"));
  assert.match(r.note, /^"Azure Kubernetes Service" is not listed in his profile, resume or LinkedIn skills\. Related skills he does list: .*Azure/);
});

test("get_skills answers from his profile and LinkedIn when the resume is unavailable, and says the resume was not checked", async () => {
  const down = ctx({ getResume: async () => ({ available: false }) });
  const r = await run("get_skills", { query: "terraform" }, down);
  assert.equal(r.resume_available, false);
  assert.equal(r.listed, true);
  assert.equal(r.matches_in_profile.length, 1);
  assert.deepEqual(r.resume_matches, []);

  const miss = await run("get_skills", { query: "FastAPI" }, down);
  assert.equal(miss.listed, false, "FastAPI is only in the resume, which could not be read");
  assert.match(miss.note, /not listed in his profile or LinkedIn skills \(the resume could not be checked right now\)/);
  assert.ok(!/profile, resume or LinkedIn/.test(miss.note), "it must not claim the resume was checked");

  const all = await run("get_skills", {}, down);
  assert.equal(all.skills.length, kb().skills.length, "the profile list does not need the resume");
  assert.deepEqual(all.resume_other_skills, []);
});

test("PROVENANCE CONTRACT: fields starting resume_ or linkedin_ are supporting detail, and nothing else is named that way", async () => {
  const outputs = {
    get_experience: await run("get_experience"),
    get_skills: await run("get_skills"),
    "get_skills(q)": await run("get_skills", { query: "terraform" }),
    get_projects: await run("get_projects"),
    get_certifications: await run("get_certifications"),
    get_education: await run("get_education"),
    get_contact_info: await run("get_contact_info"),
    get_resume: await run("get_resume"),
    get_linkedin_profile: await run("get_linkedin_profile"),
  };
  for (const [tool, out] of Object.entries(outputs)) {
    for (const key of Object.keys(out)) {
      if (/resume|linkedin/i.test(key)) {
        const allowed = /^(resume|linkedin)_/.test(key) || (tool === "get_contact_info" && key === "linkedin") || key === "profile_url";
        assert.ok(allowed, `${tool}.${key} mentions resume/linkedin but is not prefixed resume_/linkedin_`);
      }
    }
  }
  // The profile's own facts never wear the supporting-detail prefix.
  for (const tool of ["get_experience", "get_education", "get_contact_info"]) {
    assert.ok(Object.keys(outputs[tool]).every((k) => !/^(resume|linkedin)_/.test(k)), `${tool} holds profile data only`);
  }
  assert.ok("profile_current_role" in outputs.get_resume, "the resume tool carries the profile's role so a resume-only turn can resolve a disagreement");
  assert.ok(!/resume|linkedin/i.test("profile_current_role"));
  assert.match(outputs.get_resume.profile_current_role, /LTIMindtree — Full-time, January 2026 – present\. Project: .*\(since April 2026\)/);
  assert.match(outputs.get_resume.note, /profile data is correct/);
});

test("get_skills: a profile without any level carries no self-rating note", async () => {
  const k = kb();
  k.skills.forEach((s) => delete s.level);
  const r = await run("get_skills", {}, ctx({ kb: k }));
  assert.equal(r.note, undefined);
  assert.ok(r.skills.every((s) => !("self_rated_level" in s)));
});

/* ---- experience ---- */
test("get_experience is his confirmed record: role, type, dates, project and responsibilities", async () => {
  const r = await run("get_experience");
  assert.deepEqual(r.roles, ["Engineer, Cloud & Infra Management at LTIMindtree — Full-time, January 2026 – present. Project: Microsoft Project: Agentic Factory Operations (since April 2026)"]);
  assert.deepEqual(r.responsibilities, kb().experience[0].points, "the same bullets the website shows");
  assert.equal(r.about_in_his_words.length, kb().about.paragraphs.length);
  assert.ok(r.about_in_his_words.every((p) => !p.includes("**")), "no markup characters reach the model");
});

test("get_experience never mixes in the resume or LinkedIn, so two versions of a date cannot reach an answer", async () => {
  const r = await run("get_experience");
  assert.deepEqual(Object.keys(r).sort(), ["about_in_his_words", "responsibilities", "roles"]);
  const text = JSON.stringify(r);
  assert.ok(!/Apr 2026 – Present/.test(text), "the resume's own wording of the start date is not in it");
  assert.ok(!/Engineer - Cloud & Infra/.test(text), "nor is LinkedIn's wording of the title");
});

test("get_experience does not depend on the live resume", async () => {
  const withResume = await run("get_experience");
  const without = await run("get_experience", {}, ctx({ getResume: async () => ({ available: false }) }));
  assert.deepEqual(without, withResume);
});

test("get_experience with several roles: newest first, an ended role says when, responsibilities name the company", async () => {
  const k = kb();
  k.experience.push({ id: "exp-old", source: "owner", updated: "2026-11-04", role: "Intern", company: "Acme", started: "Jun 2025", ended: "Dec 2025", points: ["Fixed bugs."] });
  const r = await run("get_experience", {}, ctx({ kb: k }));
  assert.equal(r.roles.length, 2);
  assert.match(r.roles[0], /LTIMindtree — Full-time, January 2026 – present/);
  assert.equal(r.roles[1], "Intern at Acme — June 2025 – December 2025");
  assert.ok(r.responsibilities.includes("Acme: Fixed bugs."));
  assert.ok(r.responsibilities.every((l) => l.startsWith("LTIMindtree: ") || l.startsWith("Acme: ")));
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
test("get_site_links matches the page exactly: every linked section exists, and no section is missing", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "index.html"), "utf8");
  const onPage = [...html.matchAll(/<section[^>]*\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => id !== "home");
  const linked = Object.keys(require("../lib/tools/site-links").SECTIONS);
  assert.deepEqual([...linked].sort(), [...onPage].sort(), "SECTIONS and the <section id> list in index.html are identical");
  assert.ok(linked.includes("education"), "the Education section is linkable");

  const r = await run("get_site_links");
  assert.equal(r.sections.length, onPage.length);
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
