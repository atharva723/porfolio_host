/* =====================================================================
   KB DRIFT CHECK
   ---------------------------------------------------------------------
   The live resume is the source of truth, so the KB must not drift from
   it. This compares them and reports what to update, so keeping the
   assistant current is one command (`npm run kb:check`) instead of a
   manual audit.
   ===================================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;
const LINKEDIN_STALE_DAYS = 90;
const PROJECTS_STALE_DAYS = 60;

const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Lines under the resume's "CERTIFICATIONS" heading (until the next heading). */
function resumeCertifications(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => /^##\s*certifications\b/i.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line.trim())) break;
    const t = line.replace(/^[-•*]\s*/, "").trim();
    if (t) out.push(t);
  }
  return out;
}

const ageDays = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY_MS);

/**
 * @param {{ kb: object, resumeText?: string, now?: number }} input
 * @returns {Array<{level: "warn"|"info", message: string}>}
 */
function checkKb({ kb, resumeText, now = Date.now() }) {
  const findings = [];
  const warn = (message) => findings.push({ level: "warn", message });
  const info = (message) => findings.push({ level: "info", message });

  if (!kb.linkedin) {
    info("No LinkedIn snapshot yet. Run: npm run kb:linkedin -- \"<export folder>\"");
  } else {
    const days = ageDays(kb.linkedin.asOf, now);
    if (days > LINKEDIN_STALE_DAYS) warn(`LinkedIn snapshot is ${days} days old (as of ${kb.linkedin.asOf}). Re-export and run: npm run kb:linkedin -- "<export folder>"`);
  }

  const projectDates = (kb.projects || []).map((p) => p.updated).sort();
  if (projectDates.length) {
    const days = ageDays(projectDates[projectDates.length - 1], now);
    if (days > PROJECTS_STALE_DAYS) info(`Project details are ${days} days old. Run: npm run kb:sync`);
  }

  if (resumeText) {
    const lines = resumeCertifications(resumeText);
    const matches = (line, c) => (c.code && norm(line).includes(norm(c.code))) || norm(line).includes(norm(c.title));
    for (const line of lines) {
      if (!(kb.credentials || []).some((c) => matches(line, c))) {
        warn(`Resume lists "${line}" but kb.json has no matching credential. Add it on LinkedIn and re-import, or add it to kb.json.`);
      }
    }
    for (const c of kb.credentials || []) {
      if (lines.length && !lines.some((l) => matches(l, c))) {
        warn(`kb.json has "${c.title}" but the live resume does not list it. The resume wins: update the resume or remove the credential.`);
      }
    }
  } else {
    info("Live resume not checked (RESUME_DOC_URL unset or unreachable).");
  }

  return findings;
}

module.exports = { checkKb, resumeCertifications };
