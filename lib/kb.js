/* =====================================================================
   KNOWLEDGE BASE — kb/kb.json loader, validator and prompt renderer
   ---------------------------------------------------------------------
   kb.json is the single canonical record of everything the portfolio
   says about Atharva. The assistant and the website are two views of it:
     profile, about, skills, experience, education, credentials  — owner content
     facts      — short statements the assistant may repeat
     projects   — details synced from GitHub
     linkedin   — snapshot imported from the LinkedIn data export
   The resume is read live from Google Docs (lib/sources/resume.js) and
   acts as a witness: lib/kb-check.js reports where it disagrees.

   Every entry carries an id, a source and an updated date so answers can
   be traced and stale data spotted. Text that the website renders is plain
   (no HTML) so it is safe in both places.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KB_PATH = path.join(__dirname, "..", "kb", "kb.json");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// "Jan 2026": the same display format already used by credentials and the LinkedIn snapshot.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_YEAR_RE = new RegExp(`^(${MONTHS.join("|")}) (\\d{4})$`);
// Font Awesome 6 classes only (the site loads FA 6.4); never free text that ends up in a class attribute.
const ICON_RE = /^fa[srb] fa-[a-z0-9-]{1,40}$/;
const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];
// Site-facing copy is plain text. The only markup allowed is **bold** in about.paragraphs.
const MARKUP_RE = /[<>]/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const monthValue = (s) => {
  const m = MONTH_YEAR_RE.exec(s);
  return m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1]) : NaN;
};

function validate(kb) {
  const errors = [];
  const ids = new Set();
  const entry = (where, item, required) => {
    if (!item || typeof item !== "object") return errors.push(`${where}: not an object`);
    if (!isStr(item.id)) errors.push(`${where}: missing id`);
    else if (ids.has(item.id)) errors.push(`${where}: duplicate id "${item.id}"`);
    else ids.add(item.id);
    if (!isStr(item.source)) errors.push(`${where}: missing source`);
    if (!DATE_RE.test(item.updated || "")) errors.push(`${where}: updated must be YYYY-MM-DD`);
    for (const field of required) if (!isStr(item[field])) errors.push(`${where}: missing "${field}"`);
  };
  // Copy that the website renders and the assistant repeats: bounded, plain, no HTML.
  const plain = (where, value, max, { bold = false } = {}) => {
    if (!isStr(value)) return errors.push(`${where}: must be a non-empty string`);
    if (value.length > max) errors.push(`${where}: longer than ${max} characters`);
    if (MARKUP_RE.test(value)) errors.push(`${where}: must be plain text (no < or >)`);
    if (bold && (value.match(/\*\*/g) || []).length % 2) errors.push(`${where}: unbalanced ** markers`);
    if (!bold && value.includes("**")) errors.push(`${where}: ** markers are only allowed in about.paragraphs`);
  };
  const monthYear = (where, value) => {
    if (!MONTH_YEAR_RE.test(value || "")) errors.push(`${where}: must look like "Jan 2026"`);
  };

  if (!kb || typeof kb !== "object") throw new Error("kb.json is not an object");
  if (!DATE_RE.test(kb.updated || "")) errors.push("kb.updated must be YYYY-MM-DD");

  entry("profile", kb.profile, ["name", "headline", "location", "email", "github", "linkedin"]);
  if (kb.profile && typeof kb.profile === "object") plain("profile.tagline", kb.profile.tagline, 200);
  const lists = {
    education: ["degree", "institution"],
    credentials: ["title", "issuer"],
    facts: ["text"],
    projects: ["repo", "title", "description", "link"],
    skills: ["name"],
    experience: ["role", "company", "started"],
  };
  for (const [key, required] of Object.entries(lists)) {
    if (!Array.isArray(kb[key])) errors.push(`${key}: must be an array`);
    else kb[key].forEach((item, i) => entry(`${key}[${i}]`, item, required));
  }

  // Website-facing sections: the same record feeds the site and the assistant.
  entry("about", kb.about, []);
  if (kb.about && typeof kb.about === "object") {
    const paragraphs = kb.about.paragraphs;
    if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.length > 6) errors.push("about.paragraphs: must be 1-6 paragraphs");
    else paragraphs.forEach((p, i) => plain(`about.paragraphs[${i}]`, p, 700, { bold: true }));
  }

  (Array.isArray(kb.skills) ? kb.skills : []).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const where = `skills[${i}]`;
    plain(`${where}.name`, s.name, 60);
    // Levels are the owner's own rating; the assistant presents them as self-rated.
    if (s.level !== undefined && !LEVELS.includes(s.level)) errors.push(`${where}.level: must be one of ${LEVELS.join(", ")}`);
    if (s.icon !== undefined && !ICON_RE.test(s.icon)) errors.push(`${where}.icon: must be a Font Awesome 6 class like "fab fa-python"`);
  });

  (Array.isArray(kb.credentials) ? kb.credentials : []).forEach((c, i) => {
    if (c && typeof c === "object" && c.icon !== undefined && !ICON_RE.test(c.icon)) {
      errors.push(`credentials[${i}].icon: must be a Font Awesome 6 class like "fab fa-microsoft"`);
    }
  });

  (Array.isArray(kb.experience) ? kb.experience : []).forEach((x, i) => {
    if (!x || typeof x !== "object") return;
    const where = `experience[${i}]`;
    plain(`${where}.role`, x.role, 120);
    plain(`${where}.company`, x.company, 120);
    monthYear(`${where}.started`, x.started);
    if (x.ended !== null && x.ended !== undefined) {
      monthYear(`${where}.ended`, x.ended);
      if (monthValue(x.ended) < monthValue(x.started)) errors.push(`${where}: ended is before started`);
    }
    if (x.engagement !== undefined) {
      if (!x.engagement || typeof x.engagement !== "object") errors.push(`${where}.engagement: must be an object`);
      else {
        plain(`${where}.engagement.name`, x.engagement.name, 160);
        monthYear(`${where}.engagement.started`, x.engagement.started);
        if (monthValue(x.engagement.started) < monthValue(x.started)) errors.push(`${where}: the engagement starts before the role`);
      }
    }
    if (x.points !== undefined) {
      if (!Array.isArray(x.points) || x.points.length > 10) errors.push(`${where}.points: must be a list of at most 10`);
      else x.points.forEach((p, j) => plain(`${where}.points[${j}]`, p, 300));
    }
  });
  if (kb.linkedin !== null && kb.linkedin !== undefined) {
    entry("linkedin", kb.linkedin, []);
    if (!DATE_RE.test((kb.linkedin && kb.linkedin.asOf) || "")) errors.push("linkedin.asOf must be YYYY-MM-DD");
    for (const key of ["positions", "education", "skills"]) {
      if (kb.linkedin && kb.linkedin[key] !== undefined && !Array.isArray(kb.linkedin[key])) errors.push(`linkedin.${key}: must be an array`);
    }
  }

  if (errors.length) throw new Error("Invalid kb/kb.json:\n- " + errors.join("\n- "));
  return kb;
}

let cached = { mtimeMs: 0, kb: null };

/** Load and validate the KB. In development, edits are picked up without a restart. */
function load() {
  const prod = process.env.NODE_ENV === "production";
  if (cached.kb && prod) return cached.kb;
  const mtimeMs = fs.statSync(KB_PATH).mtimeMs;
  if (cached.kb && cached.mtimeMs === mtimeMs) return cached.kb;
  const kb = validate(JSON.parse(fs.readFileSync(KB_PATH, "utf8")));
  cached = { mtimeMs, kb };
  return kb;
}

/** Short content hash; changes whenever the KB changes. */
function version(kb = load()) {
  return crypto.createHash("sha256").update(JSON.stringify(kb)).digest("hex").slice(0, 12);
}

/** Flatten the KB into readable text for the model. */
function toText(kb = load()) {
  const p = kb.profile;
  const lines = [
    `Name: ${p.name}`,
    `Headline: ${p.headline}`,
    p.employer ? `Employer: ${p.employer}` : "",
    `Location: ${p.location}`,
    `Contact: email ${p.email}; GitHub ${p.github}; LinkedIn ${p.linkedin}${p.website ? `; portfolio ${p.website}` : ""}`,
  ].filter(Boolean);

  if (kb.education.length) {
    lines.push("\nEducation:");
    kb.education.forEach((e) => {
      const parts = [e.institution, e.affiliation, e.period ? `studied ${e.period}` : "", e.graduated ? `graduated ${e.graduated}` : "", e.score].filter(Boolean);
      lines.push(`- ${e.degree} — ${parts.join("; ")}`);
    });
  }

  if (kb.credentials.length) {
    lines.push("\nCertifications and credentials, with verification links:");
    kb.credentials.forEach((c) => {
      const parts = [
        c.issuer,
        c.earned ? `earned ${c.earned}` : "",
        c.expires ? `valid until ${c.expires}` : "",
        c.credentialId ? `credential ID ${c.credentialId}` : "",
      ].filter(Boolean);
      lines.push(`- ${c.title}${c.code ? ` (${c.code})` : ""} — ${parts.join("; ")}`);
      if (c.verifyUrl) lines.push(`    Verify: ${c.verifyUrl}`);
    });
  }

  if (kb.projects.length) {
    lines.push("\nProjects (from GitHub):");
    kb.projects.forEach((pr) => {
      lines.push(`- ${pr.title} (${pr.link}): ${pr.description}`);
      if (pr.tech && pr.tech.length) lines.push(`    Tech: ${pr.tech.join(", ")}`);
      if (pr.highlights) lines.push(`    Details: ${pr.highlights}`);
    });
  }

  if (kb.facts.length) {
    lines.push("\nQuick facts:");
    kb.facts.forEach((f) => lines.push(`- ${f.text}`));
  }

  const li = kb.linkedin;
  if (li) {
    lines.push(`\nLinkedIn profile snapshot (as of ${li.asOf}; the live resume wins if they differ):`);
    if (li.headline) lines.push(`Headline: ${li.headline}`);
    if (li.location || li.industry) lines.push(`Location: ${li.location || "n/a"}; industry: ${li.industry || "n/a"}`);
    if (li.summary) lines.push(`About: ${li.summary}`);
    (li.positions || []).forEach((r) => {
      const span = `${r.started || "?"} – ${r.finished || "present"}`;
      lines.push(`- ${r.title} at ${r.company} (${span})${r.description ? `: ${r.description}` : ""}`);
    });
    if (li.skills && li.skills.length) lines.push(`Skills listed on LinkedIn: ${li.skills.join(", ")}`);
  }

  return lines.join("\n");
}

module.exports = { load, validate, version, toText, KB_PATH, ICON_RE, monthValue };
