/* =====================================================================
   KNOWLEDGE BASE — kb/kb.json loader, validator and prompt renderer
   ---------------------------------------------------------------------
   kb.json holds ONLY facts that are not already covered by another
   source: profile basics, education, credential links, quick facts,
   project details synced from GitHub, and (later) the LinkedIn export.
   The resume is read live from Google Docs (lib/sources/resume.js).

   Every entry carries an id, a source and an updated date so answers can
   be traced and stale data spotted.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KB_PATH = path.join(__dirname, "..", "kb", "kb.json");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

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

  if (!kb || typeof kb !== "object") throw new Error("kb.json is not an object");
  if (!DATE_RE.test(kb.updated || "")) errors.push("kb.updated must be YYYY-MM-DD");

  entry("profile", kb.profile, ["name", "headline", "location", "email", "github", "linkedin"]);
  const lists = {
    education: ["degree", "institution"],
    credentials: ["title", "issuer"],
    facts: ["text"],
    projects: ["repo", "title", "description", "link"],
  };
  for (const [key, required] of Object.entries(lists)) {
    if (!Array.isArray(kb[key])) errors.push(`${key}: must be an array`);
    else kb[key].forEach((item, i) => entry(`${key}[${i}]`, item, required));
  }
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

module.exports = { load, validate, version, toText, KB_PATH };
