/* =====================================================================
   KB DRIFT CHECK
   ---------------------------------------------------------------------
   kb.json is the confirmed record: the website and the assistant both
   show it. The live resume and the LinkedIn snapshot are witnesses, so
   this compares them and reports what to update, turning "is anything out
   of date?" into one command (`npm run kb:check`) instead of a manual audit.

   Every finding has a `kind`, which decides whether it can fail a build:
     conflict  a witness says something different (a date, a role, an
               employer, a school, a certificate, an e-mail address)
     stale     something is old, or an upstream copy lags (an old LinkedIn
               export, a project card that links to a renamed repository)
     gap       a witness has something the site does not show (a skill, a
               project). Often deliberate, so it is information only
     note      a check could not run (no resume, no LinkedIn snapshot)
   ===================================================================== */

const { monthValue, pairProjects } = require("./kb");

const DAY_MS = 24 * 60 * 60 * 1000;
const LINKEDIN_STALE_DAYS = 90;
const PROJECTS_STALE_DAYS = 60;
const MAX_LISTED = 8;

const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILLER = new Set(["of", "the", "and", "in", "at", "for", "a", "an"]);
// Words that many different employers and schools share. They must not make two different names look alike.
const NAME_NOISE = new Set([
  "limited", "ltd", "pvt", "private", "inc", "llc", "corp", "corporation", "company", "technologies", "technology", "services", "solutions", "systems",
  "college", "university", "school", "institute", "academy", "engineering", "high", "higher", "secondary", "junior", "jr",
]);

/**
 * "M.G.M. College of Engineering" -> {mgm, college, engineering}: for comparing names that are written differently.
 * With `names`, words that many employers and schools share ("college", "private", "limited") are left out,
 * so only the distinctive words are compared.
 */
const words = (s, names = false) =>
  new Set(
    norm(s)
      .replace(/\b([a-z])\./g, "$1")
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w && !FILLER.has(w) && !(names && (NAME_NOISE.has(w) || w.length < 2)))
  );

/** Share of the shorter text's words that the other text also has (0 to 1). */
function overlap(a, b, names = false) {
  const A = words(a, names);
  const B = words(b, names);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** For the name of an employer or a school. */
const sameName = (a, b) => overlap(a, b, true);

const wholeWord = (haystack, needle) => new RegExp(`(^|[^a-z0-9+#])${escapeRe(needle)}($|[^a-z0-9+#])`).test(haystack);
const bullet = (line) => line.replace(/^[-•*]\s*/, "").trim();
const isBullet = (line) => /^[-•*]\s/.test(line);
const list = (items) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(", ")} and ${items.length - MAX_LISTED} more` : items.join(", "));
const ageDays = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY_MS);

/* ---------------- reading the resume ---------------- */

/** The resume as [{ heading, lines }]; a heading is a "## NAME" line. Lines keep their bullets. */
function resumeSections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const heading = /^#{2}(?!#)\s*(.+)$/.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
    } else if (current && line) current.lines.push(line);
  }
  return sections;
}

const sectionsLike = (text, re) => resumeSections(text).filter((s) => re.test(s.heading));

/** Lines under the resume's "CERTIFICATIONS" heading (until the next heading). */
function resumeCertifications(text) {
  const section = sectionsLike(text, /^certifications\b/i)[0];
  return section ? section.lines.map(bullet).filter(Boolean) : [];
}

const MONTH_NAME = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const RANGE_RE = new RegExp(`${MONTH_NAME}\\s+(\\d{4})\\s*(?:-|–|—|to)\\s*(?:(Present|Current|Now)|${MONTH_NAME}\\s+(\\d{4}))`, "gi");
const monthOf = (name, year) => monthValue(`${name.charAt(0).toUpperCase()}${name.slice(1, 3).toLowerCase()} ${year}`);

/** Date ranges written like "Apr 2026 – Present" in the resume's experience section. end is null for "Present". */
function resumeRoleDates(text) {
  const out = [];
  for (const section of sectionsLike(text, /experience\b/i)) {
    for (const line of section.lines) {
      for (const m of line.matchAll(RANGE_RE)) {
        out.push({ label: m[0], start: monthOf(m[1], m[2]), end: m[3] ? null : monthOf(m[4], m[5]) });
      }
    }
  }
  return out;
}

/** Individual skills named in the resume's skills / technical stack sections. */
function resumeSkills(text) {
  const seen = new Map();
  for (const section of sectionsLike(text, /skills|technical stack|technologies|tools/i)) {
    for (const line of section.lines) {
      const body = bullet(line).replace(/^[^:,]{1,30}:\s*/, "");
      for (const part of body.split(/[,•|;]/)) {
        const skill = part.trim();
        if (skill.length >= 2 && skill.length <= 40 && !seen.has(norm(skill))) seen.set(norm(skill), skill);
      }
    }
  }
  return [...seen.values()];
}

/** Project headings in the resume's projects section: lines that are not bullets or full sentences. */
function resumeProjects(text) {
  const out = [];
  for (const section of sectionsLike(text, /^(personal |key |selected )?projects?\b/i)) {
    for (const line of section.lines) if (!isBullet(line) && line.length <= 140 && !/[.!]$/.test(line)) out.push(line);
  }
  return out;
}

/* ---------------- the checks ---------------- */

/** "Jan 2026 for the role and Apr 2026 for the project": the two start dates kb.json may hold for one job. */
const describeStarts = (x) => `${x.started} for the role${x.engagement ? ` and ${x.engagement.started} for the project` : ""}`;
/** The months a role may be said to have started: the job's own start, or its project's. */
const startValues = (x) => [monthValue(x.started), x.engagement && monthValue(x.engagement.started)].filter(Number.isFinite);

/**
 * Pairs each LinkedIn position with the kb.json role it describes: same employer, then the same start,
 * then a similar title. A role is used once, so two positions at one employer (a promotion) are not
 * both compared with the first role.
 */
function pairRoles(kb, positions) {
  const used = new Set();
  return positions.map((p) => {
    const same = kb.experience.filter((x) => sameName(p.company, x.company) >= 0.6);
    const pool = same.filter((x) => !used.has(x));
    const score = (x) => (startValues(x).includes(monthValue(p.started)) ? 2 : 0) + (overlap(p.title, x.role) >= 0.5 ? 1 : 0);
    const best = [...(pool.length ? pool : same)].sort((a, b) => score(b) - score(a))[0] || null;
    if (best) used.add(best);
    return best;
  });
}

function checkLinkedInRoles(kb, add) {
  const positions = kb.linkedin.positions || [];
  const paired = pairRoles(kb, positions);
  positions.forEach((p, i) => {
    const role = paired[i];
    if (!role) return add("warn", "conflict", `LinkedIn lists "${p.title}" at ${p.company}, but kb.json has no role at that company. Add it to kb.json, or fix LinkedIn.`);
    if (overlap(p.title, role.role) < 0.5) add("warn", "conflict", `LinkedIn calls the role at ${p.company} "${p.title}", but kb.json says "${role.role}". kb.json wins, so the site and the assistant use it.`);

    const liStart = monthValue(p.started);
    if (Number.isFinite(liStart) && !startValues(role).includes(liStart)) {
      add("warn", "conflict", `LinkedIn says the role at ${p.company} started ${p.started}, but kb.json has ${describeStarts(role)}. kb.json wins.`);
    }
    if (!p.finished !== !role.ended) {
      add("warn", "conflict", p.finished ? `LinkedIn shows the role at ${p.company} as ended (${p.finished}), but kb.json shows it as current.` : `LinkedIn shows the role at ${p.company} as current, but kb.json says it ended ${role.ended}.`);
    } else if (p.finished && monthValue(p.finished) !== monthValue(role.ended) && Number.isFinite(monthValue(p.finished)) && Number.isFinite(monthValue(role.ended))) {
      add("warn", "conflict", `LinkedIn says the role at ${p.company} ended ${p.finished}, but kb.json says ${role.ended}. kb.json wins.`);
    }
  });
  if (positions.length) {
    for (const x of kb.experience) {
      if (!paired.includes(x)) add("info", "gap", `kb.json has the role "${x.role}" at ${x.company} that LinkedIn does not list. Add it on LinkedIn if it is real.`);
    }
  }
}

function checkLinkedInEducation(kb, add) {
  for (const e of kb.linkedin.education || []) {
    const match = kb.education.find((x) => sameName(e.school, x.institution) >= 0.6 || sameName(e.school, x.affiliation) >= 0.6);
    if (!match) {
      add("warn", "conflict", `LinkedIn lists education at ${e.school}, but kb.json has no school like that.`);
      continue;
    }
    const written = `${match.period || ""} ${match.graduated || ""}`;
    for (const year of [e.started, e.ended].filter(Boolean)) {
      if (written.trim() && !written.includes(String(year))) add("warn", "conflict", `LinkedIn shows ${year} for ${e.school}, but kb.json has "${written.trim()}".`);
    }
  }
}

function checkResumeRoles(kb, resumeText, add) {
  const sections = sectionsLike(resumeText, /experience\b/i);
  if (!sections.length) return;
  const body = norm(sections.flatMap((s) => s.lines).join(" "));
  for (const x of kb.experience) {
    if (!body.includes(norm(x.company))) add("warn", "conflict", `kb.json has a role at ${x.company}, but the resume's experience section does not mention it.`);
  }

  const startsOf = (x) => startValues(x);
  for (const range of resumeRoleDates(resumeText)) {
    const role = kb.experience.find((x) => startsOf(x).includes(range.start));
    if (!role) {
      add("warn", "conflict", `The resume shows something starting "${range.label}", but kb.json has no role or project starting then (it has ${kb.experience.map(describeStarts).join("; ")}). kb.json wins.`);
      continue;
    }
    const kbEnd = role.ended ? monthValue(role.ended) : null;
    if (range.end !== kbEnd) add("warn", "conflict", `The resume's "${range.label}" ends differently from kb.json (${role.ended || "current"}) for the role at ${role.company}. kb.json wins.`);
  }
}

function checkResumeEducation(kb, resumeText, add) {
  const sections = sectionsLike(resumeText, /^education\b/i);
  if (!sections.length) return;
  const body = sections.flatMap((s) => s.lines).join(" ");
  const found = kb.education.some((x) => sameName(body, x.institution) >= 0.5 || sameName(body, x.affiliation) >= 0.5);
  if (!found) add("info", "gap", "The resume's education section does not seem to mention any school or university kb.json lists.");
}

function checkSkills(kb, resumeText, add) {
  const keys = (name) => [name, ...name.split("/")].map(norm).filter((k) => k.length >= 2);
  const known = kb.skills.flatMap((s) => keys(s.name));
  const body = norm(resumeText);

  const extra = resumeSkills(resumeText).filter((r) => {
    const n = norm(r);
    return !known.some((k) => n === k || wholeWord(n, k) || wholeWord(k, n));
  });
  if (extra.length) add("info", "gap", `The resume lists ${extra.length} skill${extra.length === 1 ? "" : "s"} the site does not show: ${list(extra)}. Add them to kb.json if you want them shown.`);

  const missing = kb.skills.filter((s) => s.source === "resume" && !keys(s.name).some((k) => wholeWord(body, k))).map((s) => s.name);
  if (missing.length) add("info", "gap", `kb.json credits the resume for ${list(missing)}, but the resume does not mention ${missing.length === 1 ? "it" : "them"} any more.`);
}

function checkResumeProjects(kb, resumeText, add) {
  const entries = resumeProjects(resumeText);
  if (!entries.length) return;
  const same = (line, p) => norm(line).includes(norm(p.title)) || overlap(line.replace(/\(?https?:\/\/\S+\)?/g, ""), p.title) >= 0.75 || (p.repo && norm(line).includes(norm(p.repo)));

  const unlisted = entries.filter((line) => !kb.projects.some((p) => same(line, p)));
  if (unlisted.length) {
    const many = unlisted.length === 1 ? ["project", "it"] : ["projects", "them"];
    add(
      "info",
      "gap",
      `The resume lists ${unlisted.length} ${many[0]} the site does not show. Ignore this if you left ${many[1]} out on purpose (run with --details to see which).`,
      // Project names from the resume stay off shared logs unless asked for.
      list(unlisted.map((l) => l.replace(/\s*\(?https?:\/\/\S+\)?/g, "").trim()))
    );
  }
  const notOnResume = kb.projects.filter((p) => !entries.some((line) => same(line, p))).map((p) => p.title);
  if (notOnResume.length) add("info", "gap", `The site shows ${notOnResume.length} project${notOnResume.length === 1 ? "" : "s"} the resume does not list: ${list(notOnResume)}.`);
}

function checkContact(kb, resumeText, add) {
  const emails = [...new Set((resumeText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((e) => e.toLowerCase()))];
  if (emails.length && !emails.includes(kb.profile.email.toLowerCase())) {
    add("warn", "conflict", "The resume shows a different e-mail address from the one on the site and in the assistant (run with --details to see it).", emails.join(", "));
  }
  const handle = (url) => (/linkedin\.com\/in\/([^/?#\s)]+)/i.exec(url || "") || [])[1];
  const resumeHandle = handle(resumeText);
  const kbHandle = handle(kb.profile.linkedin);
  if (resumeHandle && kbHandle && resumeHandle.toLowerCase() !== kbHandle.toLowerCase()) {
    add("warn", "conflict", "The resume links to a different LinkedIn profile from the one in kb.json (run with --details to see it).", resumeHandle);
  }
}

const sameLink = (a, b) => String(a || "").trim().toLowerCase().replace(/\/+$/, "") === String(b || "").trim().toLowerCase().replace(/\/+$/, "");

/** Compares the project cards the site is built from with kb.json's GitHub-synced entries. */
function checkProjectCards(kb, cards, add) {
  if (cards.source === "kb") {
    add("warn", "stale", "public/data/projects.json is missing or has no usable project, so the site shows kb.json's own project list.");
    return;
  }
  if (cards.skipped) add("warn", "stale", `${cards.skipped} project card${cards.skipped === 1 ? "" : "s"} in public/data/projects.json ${cards.skipped === 1 ? "is" : "are"} invalid and not shown on the site.`);
  const matches = pairProjects(kb.projects, cards.items);
  cards.items.forEach((card, i) => {
    const entry = matches[i];
    if (!entry) return add("info", "gap", `The project card "${card.title}" has no GitHub details in kb.json yet. Run: npm run kb:sync`);
    if (card.link && entry.link && !sameLink(card.link, entry.link)) {
      add("warn", "stale", `The project card "${card.title}" links to ${card.link}, but GitHub now says ${entry.link}. The site and the assistant already use the new address; fix public/data/projects.json (or the workflow that writes it).`);
    }
  });
  const used = new Set(matches.filter(Boolean));
  const orphans = kb.projects.filter((p) => !used.has(p)).map((p) => p.title);
  if (orphans.length) add("info", "gap", `kb.json has ${orphans.length === 1 ? "a project" : "projects"} the site's cards do not list: ${list(orphans)}. Run: npm run kb:sync`);
}

/**
 * @param {{ kb: object, resumeText?: string, cards?: { items: object[], source?: string, skipped?: number }, now?: number }} input
 *   kb: the file as written (kbLib.loadRaw()), so project links are the GitHub-synced ones.
 *   cards: the site's project cards (projects.load()); omit to skip the card comparison.
 * @returns {Array<{level: "warn"|"info", kind: "conflict"|"stale"|"gap"|"note", message: string, detail?: string}>}
 */
function checkKb({ kb, resumeText, cards, now = Date.now() }) {
  const findings = [];
  const add = (level, kind, message, detail) => findings.push(detail ? { level, kind, message, detail } : { level, kind, message });

  if (!kb.linkedin) {
    add("info", "note", 'No LinkedIn snapshot yet. Run: npm run kb:linkedin -- "<export folder>"');
  } else {
    const days = ageDays(kb.linkedin.asOf, now);
    if (days > LINKEDIN_STALE_DAYS) add("warn", "stale", `LinkedIn snapshot is ${days} days old (as of ${kb.linkedin.asOf}). Re-export and run: npm run kb:linkedin -- "<export folder>"`);
    checkLinkedInRoles(kb, add);
    checkLinkedInEducation(kb, add);
  }

  const projectDates = (kb.projects || []).map((p) => p.updated).sort();
  if (projectDates.length) {
    const days = ageDays(projectDates[projectDates.length - 1], now);
    if (days > PROJECTS_STALE_DAYS) add("info", "stale", `Project details are ${days} days old. Run: npm run kb:sync`);
  }
  if (cards) checkProjectCards(kb, cards, add);

  if (resumeText) {
    const lines = resumeCertifications(resumeText);
    const matches = (line, c) => (c.code && norm(line).includes(norm(c.code))) || norm(line).includes(norm(c.title));
    for (const line of lines) {
      if (!(kb.credentials || []).some((c) => matches(line, c))) {
        add("warn", "conflict", `Resume lists "${line}" but kb.json has no matching credential. Add it on LinkedIn and re-import, or add it to kb.json.`);
      }
    }
    for (const c of kb.credentials || []) {
      if (lines.length && !lines.some((l) => matches(l, c))) {
        add("warn", "conflict", `kb.json has "${c.title}" but the live resume does not list it. kb.json wins, so the website and the assistant show it: add it to the resume, or remove it from kb.json if it is wrong.`);
      }
    }
    checkResumeRoles(kb, resumeText, add);
    checkResumeEducation(kb, resumeText, add);
    checkSkills(kb, resumeText, add);
    checkResumeProjects(kb, resumeText, add);
    checkContact(kb, resumeText, add);
  } else {
    add("info", "note", "Live resume not checked (RESUME_DOC_URL unset or unreachable).");
  }

  return findings;
}

/**
 * The findings that should fail a run. A conflict is always one when `strict` is set;
 * staleness only when `stale` is set too (so a pull request is never blocked by a date passing).
 */
function failing(findings, { strict = false, stale = false } = {}) {
  if (!strict) return [];
  return findings.filter((f) => f.level === "warn" && (f.kind === "conflict" || (stale && f.kind === "stale")));
}

/** One finding as a GitHub Actions annotation line. `%` and line breaks must be escaped or they end the message early. */
const annotation = (f) => `::warning title=KB drift (${f.kind})::${f.message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;

/**
 * What `npm run kb:check` prints and how it exits, as data, so it can be tested without a process.
 * `details` also shows text taken from the resume; `actions` adds a GitHub annotation per warning.
 * @returns {{ lines: string[], failed: object[], code: 0|1 }}
 */
function report(findings, { strict = false, stale = false, details = false, actions = false } = {}) {
  const lines = [];
  if (!findings.length) lines.push("No drift found.");
  for (const f of findings) {
    lines.push(`${f.level === "warn" ? "WARN" : "info"} [${f.kind}]: ${f.message}`);
    if (f.detail && details) lines.push(`      ${f.detail}`);
    if (actions && f.level === "warn") lines.push(annotation(f));
  }
  const failed = failing(findings, { strict, stale });
  return { lines, failed, code: failed.length ? 1 : 0 };
}

const FIELDS = ["id", "repo", "title", "link", "description", "tech"];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What `npm run kb:sync` would change in the projects that matter to the site and the assistant
 * (a renamed repository, new text, an added or removed project). README excerpts and dates are
 * ignored: they change on every sync and are not drift.
 * @returns {string[]} human-readable differences; empty when kb.json is up to date
 */
function projectDiff(current, next) {
  const out = [];
  const byTitle = new Map(current.map((p) => [norm(p.title), p]));
  const seen = new Set();
  for (const n of next) {
    const key = norm(n.title);
    seen.add(key);
    const c = byTitle.get(key);
    if (!c) {
      out.push(`new project "${n.title}"`);
      continue;
    }
    const changed = FIELDS.filter((f) => !equal(c[f], n[f]));
    if (changed.length) out.push(`"${n.title}" changed: ${changed.map((f) => (f === "link" ? `link ${c.link} -> ${n.link}` : f)).join(", ")}`);
  }
  for (const c of current) if (!seen.has(norm(c.title))) out.push(`project "${c.title}" is no longer on the site's cards`);
  return out;
}

module.exports = { checkKb, failing, annotation, report, projectDiff, resumeCertifications, resumeSections, resumeRoleDates, resumeSkills, resumeProjects };
