/* =====================================================================
   SITE CONTENT
   ---------------------------------------------------------------------
   Projects kb/kb.json (plus the project cards) into exactly what the
   website needs. The website and the assistant read the same record, so
   they cannot tell different stories.

   This is a WHITELIST: a field reaches the browser only if it is named
   here. Agent-only data (quick facts, the LinkedIn snapshot, README
   excerpts) and bookkeeping (id, source, updated) never leave the server.
   ===================================================================== */

const kbLib = require("./kb");
const projects = require("./projects");
const credentials = require("./credentials");
const { redactPhones } = require("./text");

/** Drop keys whose value is missing, so the output has no `null`/`undefined` noise. */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/**
 * Defence in depth: a phone number is never part of the content, so even if one reached a
 * field (a project card written by the automation, a pasted README line) it is redacted
 * before anything leaves the server. Real values are unaffected (a test pins that).
 */
function redactDeep(value) {
  if (typeof value === "string") return redactPhones(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

const nowValue = (now) => now.getUTCFullYear() * 12 + now.getUTCMonth();

/**
 * Months worked across all roles (a current role counts up to `now`). Overlapping roles
 * (a second job, an internship alongside) are merged first, so time is never counted twice.
 */
function experienceMonths(experience, now) {
  const spans = experience
    .map((x) => [kbLib.monthValue(x.started), x.ended ? kbLib.monthValue(x.ended) : nowValue(now)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [from, to] = spans[0] || [0, 0];
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) to = Math.max(to, end);
    else {
      total += to - from;
      [from, to] = [start, end];
    }
  }
  return total + (to - from);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {{ kb?: object, now?: Date, projectCards?: ReturnType<typeof projects.load> }} [input]
 */
function build({ kb = kbLib.load(), now = new Date(), projectCards } = {}) {
  // The project cards come from the merged list the assistant reads too (kb.load()): one source.
  const cards = projectCards || { items: kb.projects.map(projects.clean).filter(Boolean) };
  const p = kb.profile;

  const body = {
    profile: compact({
      name: p.name,
      headline: p.headline,
      tagline: p.tagline,
      location: p.location,
      email: p.email,
      github: p.github,
      linkedin: p.linkedin,
    }),
    about: { paragraphs: [...kb.about.paragraphs] },
    // Counted from the data, so the numbers on the page can never be out of date.
    metrics: {
      certifications: kb.credentials.length,
      projects: cards.items.length,
      skills: kb.skills.length,
      experienceMonths: experienceMonths(kb.experience, now),
    },
    skills: kb.skills.map((s) => compact({ name: s.name, icon: s.icon, level: s.level })),
    projects: cards.items.map(({ order, ...card }) => compact(card)),
    certifications: credentials.newestFirst(kb.credentials).map((c) => {
      const validity = credentials.status(c, now);
      return compact({
        title: c.title,
        code: c.code,
        issuer: c.issuer,
        earned: c.earned,
        validity: validity.state === "none" ? undefined : capitalize(validity.label),
        credentialId: c.credentialId,
        icon: c.icon,
        verifyUrl: c.verifyUrl,
      });
    }),
    experience: kb.experience.map((x) =>
      compact({
        role: x.role,
        company: x.company,
        period: `${x.started} – ${x.ended || "Present"}`,
        engagement: x.engagement ? { name: x.engagement.name, since: x.engagement.started } : undefined,
        points: x.points ? [...x.points] : [],
      })
    ),
    education: kb.education.map((e) => compact({ degree: e.degree, institution: e.institution, affiliation: e.affiliation, period: e.period, score: e.score })),
  };

  // The version hash and date are machine values: they are added after the redaction pass.
  return { version: kbLib.version(kb), updated: kb.updated, ...redactDeep(body) };
}

/* ---------------- page rendering ---------------- */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * JSON that is safe inside an HTML <script type="application/json"> block: `<` and `>` can't
 * close the tag or open a comment, and U+2028/2029 can't break a line.
 */
const jsonForScript = (value) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const CONTENT_PLACEHOLDER = "<!--SITE_CONTENT-->";

/**
 * Fill the page template with the content: the inline JSON the page renders from, and the
 * title / description that crawlers and link previews read without running any script.
 * With `content` null (the KB could not be loaded) the page is served without data and shows
 * a notice instead of a blank screen.
 */
function renderPage(template, content) {
  if (!content) return template.replace(CONTENT_PLACEHOLDER, () => "");
  const title = `${content.profile.name} - ${content.profile.headline}`;
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, (_m, open, close) => `${open}${escapeHtml(content.profile.tagline)}${close}`)
    .replace(CONTENT_PLACEHOLDER, () => `<script id="site-content" type="application/json">${jsonForScript(content)}</script>`);
}

module.exports = { build, renderPage, jsonForScript, escapeHtml, experienceMonths, CONTENT_PLACEHOLDER };
