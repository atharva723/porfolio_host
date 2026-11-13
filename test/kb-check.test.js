const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { checkKb, failing, projectDiff, annotation, report, resumeRoleDates, resumeSkills, resumeProjects, resumeSections } = require("../lib/kb-check");

const NOW = Date.parse("2026-11-10T00:00:00Z");

/** A small, invented record that agrees with itself; each test breaks one thing. */
const record = () => ({
  profile: { name: "Jane Roe", email: "jane@example.com", linkedin: "https://www.linkedin.com/in/jane-roe-123/", github: "https://github.com/janeroe" },
  experience: [
    { role: "Engineer, Cloud & Infra Management", company: "Acme Corp", started: "Jan 2026", ended: null, engagement: { name: "Project X", started: "Apr 2026" } },
  ],
  education: [{ degree: "BE", institution: "M.G.M. College of Engineering, Kamothe", affiliation: "University of Mumbai", period: "2021–2025", graduated: "2025" }],
  skills: [
    { name: "Python", source: "owner" },
    { name: "LLMs / RAG", source: "resume" },
    { name: "Docker", source: "owner" },
  ],
  credentials: [],
  projects: [{ id: "proj-alpha", repo: "alpha-app", title: "Alpha App", link: "https://github.com/janeroe/alpha-app", updated: "2026-11-01" }],
  linkedin: {
    asOf: "2026-11-01",
    positions: [{ company: "Acme Corp", title: "Engineer - Cloud & Infra", started: "Jan 2026", finished: null }],
    education: [{ school: "Mgm College Of Engineering & Technology", degree: "BE", started: "2021", ended: "2025" }],
    skills: [],
  },
});

const RESUME = `Jane Roe
jane@example.com | linkedin.com/in/jane-roe-123

## EXPERIENCE
Engineer, Cloud & Infra Management Apr 2026 – Present
Acme Corp | Project X
- Built agents

## PROJECTS
Alpha App (https://github.com/janeroe/alpha-app)
Built a thing that does a thing.

## EDUCATION
Computer Engineering, University of Mumbai

## TECHNICAL SKILLS
Python
Retrieval-Augmented Generation (RAG)
Languages: Docker`;

const cards = (items) => ({ items, source: "projects.json", skipped: 0 });
const card = (over = {}) => ({ title: "Alpha App", link: "https://github.com/janeroe/alpha-app", ...over });
const run = (over = {}) => checkKb({ kb: record(), resumeText: RESUME, cards: cards([card()]), now: NOW, ...over });
const warns = (findings) => findings.filter((f) => f.level === "warn");

test("a record that agrees with its witnesses has no warnings", () => {
  assert.deepEqual(warns(run()), []);
});

/* ---------------- LinkedIn ---------------- */

test("LinkedIn: wording differences in a title or school name are tolerated", () => {
  const kb = record();
  kb.linkedin.positions[0].title = "Engineer - Cloud & Infra"; // vs "Engineer, Cloud & Infra Management"
  assert.deepEqual(warns(checkKb({ kb, now: NOW })), []);
});

test("LinkedIn: a role at a company kb.json does not have is a conflict; the reverse is only a gap", () => {
  const kb = record();
  kb.linkedin.positions.push({ company: "Globex", title: "Analyst", started: "Jan 2024", finished: "Dec 2024" });
  const f = checkKb({ kb, now: NOW });
  assert.ok(f.some((x) => x.level === "warn" && x.kind === "conflict" && /Globex/.test(x.message)));

  const kb2 = record();
  kb2.experience.push({ role: "Intern", company: "Initech", started: "Jan 2025", ended: "Jun 2025" });
  const g = checkKb({ kb: kb2, now: NOW });
  assert.deepEqual(warns(g), []);
  assert.ok(g.some((x) => x.kind === "gap" && /Initech/.test(x.message)));
});

test("LinkedIn: the start date may be the job's OR the project's, but nothing else", () => {
  const ok = record();
  ok.linkedin.positions[0].started = "Apr 2026"; // the project start: accepted
  assert.deepEqual(warns(checkKb({ kb: ok, now: NOW })), []);

  const bad = record();
  bad.linkedin.positions[0].started = "Jun 2026";
  const f = warns(checkKb({ kb: bad, now: NOW }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /started Jun 2026.*Jan 2026 for the role and Apr 2026 for the project/);
});

test("LinkedIn: a role shown as ended on one side and current on the other is a conflict", () => {
  const kb = record();
  kb.linkedin.positions[0].finished = "Sep 2026";
  assert.match(warns(checkKb({ kb, now: NOW }))[0].message, /LinkedIn shows the role at Acme Corp as ended \(Sep 2026\), but kb\.json shows it as current/);
  const kb2 = record();
  kb2.experience[0].ended = "Sep 2026";
  assert.match(warns(checkKb({ kb: kb2, now: NOW }))[0].message, /LinkedIn shows the role at Acme Corp as current, but kb\.json says it ended Sep 2026/);
});

test("LinkedIn: two roles at one employer (a promotion) are each compared with their own role", () => {
  const kb = record();
  kb.experience = [
    { role: "Senior Engineer", company: "Acme Corp", started: "Jan 2025", ended: null },
    { role: "Engineer", company: "Acme Corp", started: "Jan 2023", ended: "Dec 2024" },
  ];
  kb.linkedin.positions = [
    { company: "Acme Corp", title: "Senior Engineer", started: "Jan 2025", finished: null },
    { company: "Acme Corp", title: "Engineer", started: "Jan 2023", finished: "Dec 2024" },
  ];
  assert.deepEqual(warns(checkKb({ kb, now: NOW })), []);

  kb.linkedin.positions[1].started = "Mar 2023"; // a real difference in the older role is still caught
  const f = warns(checkKb({ kb, now: NOW }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /started Mar 2023, but kb\.json has Jan 2023 for the role/);
});

test("LinkedIn: a role LinkedIn lacks is a gap even when another role at the same employer exists", () => {
  const kb = record();
  kb.experience.push({ role: "Intern", company: "Acme Corp", started: "Jan 2024", ended: "Jun 2024" });
  const f = checkKb({ kb, now: NOW });
  assert.deepEqual(warns(f), []);
  assert.ok(f.some((x) => x.kind === "gap" && /"Intern" at Acme Corp that LinkedIn does not list/.test(x.message)));
});

test("LinkedIn: when both sides have ended, the end months must agree", () => {
  const kb = record();
  kb.experience[0].ended = "Mar 2027";
  kb.linkedin.positions[0].finished = "Dec 2026";
  const f = warns(checkKb({ kb, now: NOW }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /ended Dec 2026, but kb\.json says Mar 2027/);
  kb.linkedin.positions[0].finished = "Mar 2027";
  assert.deepEqual(warns(checkKb({ kb, now: NOW })), []);
});

test("names that only share words like College, Private or Limited are different names", () => {
  const school = record();
  school.linkedin.education[0].school = "Pillai College of Engineering";
  assert.ok(warns(checkKb({ kb: school, now: NOW })).some((x) => /Pillai/.test(x.message)), "a different college is not the same college");

  const employer = record();
  employer.experience[0].company = "Acme Private Limited";
  employer.linkedin.positions[0].company = "Initech Private Limited";
  assert.ok(warns(checkKb({ kb: employer, now: NOW })).some((x) => /Initech Private Limited.*no role at that company/.test(x.message)));

  const same = record();
  same.experience[0].company = "Acme Private Limited";
  same.linkedin.positions[0].company = "Acme Pvt. Ltd.";
  assert.deepEqual(warns(checkKb({ kb: same, now: NOW })), [], "the same employer written two ways still matches");
});

test("LinkedIn: an unrelated job title is a conflict", () => {
  const kb = record();
  kb.linkedin.positions[0].title = "Head of Sales";
  assert.match(warns(checkKb({ kb, now: NOW }))[0].message, /calls the role.*"Head of Sales".*kb\.json wins/);
});

test("LinkedIn education: an unknown school or different years is a conflict", () => {
  const school = record();
  school.linkedin.education[0].school = "Hogwarts";
  assert.ok(warns(checkKb({ kb: school, now: NOW })).some((x) => /Hogwarts/.test(x.message)));
  const years = record();
  years.linkedin.education[0].ended = "2026";
  assert.ok(warns(checkKb({ kb: years, now: NOW })).some((x) => /2026/.test(x.message) && /2021–2025/.test(x.message)));
});

/* ---------------- the resume ---------------- */

test("resume: a date range that is the project's start (Apr 2026 – Present) is accepted", () => {
  assert.deepEqual(warns(run()), []);
});

test("resume: a start date nobody has, an end for a current role, or a missing employer is a conflict", () => {
  const start = warns(run({ resumeText: RESUME.replace("Apr 2026 – Present", "Jun 2026 – Present") }));
  assert.match(start[0].message, /Jun 2026 – Present.*no role or project starting then/);

  const ended = warns(run({ resumeText: RESUME.replace("Apr 2026 – Present", "Apr 2026 – Sep 2026") }));
  assert.match(ended[0].message, /ends differently/);

  const employer = warns(run({ resumeText: RESUME.replace("Acme Corp | Project X", "Initech | Project X") }));
  assert.match(employer[0].message, /Acme Corp.*does not mention it/);
});

test("resume: sections that are absent are skipped, not reported", () => {
  assert.deepEqual(run({ resumeText: "## CERTIFICATIONS\n" }).filter((f) => f.level === "warn"), []);
});

test("resume skills: extras are a gap (never a warning); a name written another way still matches", () => {
  const f = run({ resumeText: RESUME.replace("Languages: Docker", "Languages: Docker, Go") });
  const gap = f.find((x) => /skill/.test(x.message));
  assert.equal(gap.level, "info");
  assert.equal(gap.kind, "gap");
  assert.match(gap.message, /\bGo\b/);
  assert.ok(!/Retrieval|Docker|Python/.test(gap.message), "'Retrieval-Augmented Generation (RAG)' matches 'LLMs / RAG'");
});

test("resume skills: a skill credited to the resume that it no longer mentions is a gap", () => {
  const f = run({ resumeText: RESUME.replace("Retrieval-Augmented Generation (RAG)", "") });
  assert.ok(f.some((x) => x.kind === "gap" && /LLMs \/ RAG/.test(x.message)));
});

test("resume projects: names stay out of the message (shared logs) and appear only in the detail", () => {
  const f = run({ resumeText: RESUME.replace("## EDUCATION", "Secret Internal Tool\n\n## EDUCATION") });
  const gap = f.find((x) => /does not show/.test(x.message) && /project/.test(x.message));
  assert.equal(gap.level, "info");
  assert.ok(!/Secret Internal Tool/.test(gap.message));
  assert.match(gap.detail, /Secret Internal Tool/);
});

test("resume projects: a project the resume does not list is a gap that names the site's project", () => {
  const f = run({ resumeText: RESUME.replace("Alpha App (https://github.com/janeroe/alpha-app)", "Some Other Thing") });
  assert.ok(f.some((x) => x.kind === "gap" && /site shows 1 project.*Alpha App/.test(x.message)));
});

test("resume contact: a different e-mail or LinkedIn profile is a conflict and the value is not in the message", () => {
  const email = warns(run({ resumeText: RESUME.replace("jane@example.com", "someone@work.example") }));
  assert.equal(email.length, 1);
  assert.ok(!/someone@work/.test(email[0].message));
  assert.match(email[0].detail, /someone@work\.example/);

  assert.deepEqual(warns(run({ resumeText: RESUME.replace("jane@example.com", "JANE@Example.com") })), [], "case does not matter");

  const linkedin = warns(run({ resumeText: RESUME.replace("jane-roe-123", "someone-else-9") }));
  assert.match(linkedin[0].message, /different LinkedIn/);
  assert.ok(!/someone-else/.test(linkedin[0].message));
});

test("resume parsing: dates, skills and project headings", () => {
  const dates = resumeRoleDates("## WORK EXPERIENCE\nDev  January 2024 - Mar 2025\nOther Sept 2022 to Dec 2022\nNow Apr 2026 – Current\n## EDUCATION\n2021 – 2025");
  assert.deepEqual(dates.map((d) => d.label), ["January 2024 - Mar 2025", "Sept 2022 to Dec 2022", "Apr 2026 – Current"]);
  assert.equal(dates[2].end, null);
  assert.ok(Number.isFinite(dates[0].start) && dates[0].end > dates[0].start);
  assert.deepEqual(resumeSkills("## TECHNICAL SKILLS\nLanguages: Python, Go\n- Docker • Terraform\n## ABOUT\nignored, text"), ["Python", "Go", "Docker", "Terraform"]);
  assert.deepEqual(resumeProjects("## PROJECTS\nAlpha App (https://x.test)\nBuilt it.\n- a bullet\nBeta Tool"), ["Alpha App (https://x.test)", "Beta Tool"]);
  assert.deepEqual(resumeSections("no headings at all"), []);
});

/* ---------------- the project cards ---------------- */

test("project cards: a link that GitHub has since changed is a stale warning, not a conflict", () => {
  const f = run({ cards: cards([card({ link: "https://github.com/janeroe/alpha-apps" })]) });
  const w = warns(f);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "stale");
  assert.match(w[0].message, /alpha-apps.*alpha-app/);
});

test("project cards: a card with no kb.json entry, and an entry with no card, are gaps", () => {
  const f = run({ cards: cards([card({ title: "Brand New", link: "https://github.com/janeroe/brand-new" })]) });
  assert.deepEqual(warns(f), []);
  assert.ok(f.some((x) => x.kind === "gap" && /"Brand New".*kb:sync/.test(x.message)));
  assert.ok(f.some((x) => x.kind === "gap" && /Alpha App.*kb:sync/.test(x.message)));
});

test("project cards: a missing or partly invalid projects.json is reported", () => {
  const fallback = warns(run({ cards: { items: [], source: "kb", skipped: 0 } }));
  assert.match(fallback[0].message, /missing or has no usable project/);
  const skipped = warns(run({ cards: { items: [card()], source: "projects.json", skipped: 2 } }));
  assert.match(skipped[0].message, /2 project cards.*invalid/);
  assert.equal(run({ cards: undefined }).filter((x) => /project card/.test(x.message)).length, 0, "no cards given: skipped");
});

/* ---------------- what fails a build ---------------- */

test("failing(): nothing fails without --strict; conflicts fail; staleness only with --stale; info never", () => {
  const findings = [
    { level: "warn", kind: "conflict", message: "c" },
    { level: "warn", kind: "stale", message: "s" },
    { level: "info", kind: "gap", message: "g" },
    { level: "info", kind: "stale", message: "i" },
  ];
  assert.deepEqual(failing(findings), []);
  assert.deepEqual(failing(findings, { stale: true }), [], "--stale alone does nothing");
  assert.deepEqual(failing(findings, { strict: true }).map((f) => f.message), ["c"]);
  assert.deepEqual(failing(findings, { strict: true, stale: true }).map((f) => f.message), ["c", "s"]);
});

test("report(): the exit code follows --strict / --stale, and info never fails a run", () => {
  const conflict = { level: "warn", kind: "conflict", message: "c" };
  const stale = { level: "warn", kind: "stale", message: "s" };
  const gap = { level: "info", kind: "gap", message: "g" };
  assert.equal(report([conflict, stale, gap]).code, 0, "without --strict nothing fails");
  assert.equal(report([conflict, stale, gap], { strict: true }).code, 1);
  assert.equal(report([stale, gap], { strict: true }).code, 0, "staleness alone does not fail --strict");
  assert.equal(report([stale, gap], { strict: true, stale: true }).code, 1, "but it does with --stale");
  assert.equal(report([gap], { strict: true, stale: true }).code, 0, "a gap never fails");
  assert.deepEqual(report([conflict], { strict: true }).failed, [conflict]);
  assert.deepEqual(report([]).lines, ["No drift found."]);
});

test("report(): details and annotations appear only when asked for", () => {
  const f = [
    { level: "warn", kind: "conflict", message: "a conflict", detail: "private text" },
    { level: "info", kind: "gap", message: "a gap", detail: "more private text" },
  ];
  const plain = report(f).lines.join("\n");
  assert.ok(!/private text/.test(plain), "details are hidden by default");
  assert.ok(!plain.includes("::warning"));

  const shown = report(f, { details: true, actions: true }).lines;
  assert.ok(shown.includes("      private text") && shown.includes("      more private text"));
  assert.deepEqual(shown.filter((l) => l.startsWith("::warning")), ["::warning title=KB drift (conflict)::a conflict"], "an annotation per WARNING, not per info");
  assert.ok(shown.includes("WARN [conflict]: a conflict") && shown.includes("info [gap]: a gap"));
});

test("an annotation is one line: %, newlines and carriage returns in the message are escaped", () => {
  assert.equal(annotation({ level: "warn", kind: "conflict", message: "100% sure\nand\r\nmore" }), "::warning title=KB drift (conflict)::100%25 sure%0Aand%0D%0Amore");
});

test("the committed kb.json passes `kb:check --offline --strict` (the CI gate)", () => {
  const script = path.join(__dirname, "..", "scripts", "check-kb.js");
  const r = spawnSync(process.execPath, [script, "--offline", "--strict"], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /kb\.json valid \(version [0-9a-f]{12}/);
  assert.match(r.stdout, /resume not checked \(--offline\)/);
});

/* ---------------- kb:sync --check ---------------- */

test("projectDiff: no difference, a renamed repository, a new project, and a removed one", () => {
  const base = { id: "proj-a", repo: "a", title: "Alpha", link: "https://github.com/me/a", description: "d", tech: ["JS"], highlights: "old", updated: "2026-01-01" };
  assert.deepEqual(projectDiff([base], [{ ...base, highlights: "new README text", updated: "2026-11-01", icon: "fas fa-x" }]), [], "README excerpts, dates and icons are not drift");
  assert.match(projectDiff([base], [{ ...base, id: "proj-b", repo: "b", link: "https://github.com/me/b" }])[0], /"Alpha" changed: id, repo, link https:\/\/github\.com\/me\/a -> https:\/\/github\.com\/me\/b/);
  assert.match(projectDiff([base], [base, { ...base, title: "Beta" }])[0], /new project "Beta"/);
  assert.match(projectDiff([base], [])[0], /"Alpha" is no longer on the site's cards/);
  assert.match(projectDiff([base], [{ ...base, description: "changed" }])[0], /description/);
  assert.match(projectDiff([base], [{ ...base, tech: ["JS", "CSS"] }])[0], /tech/);
});
