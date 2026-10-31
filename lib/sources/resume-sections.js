/* =====================================================================
   RESUME SECTION PARSER
   ---------------------------------------------------------------------
   The live resume arrives as plain text with "## HEADING" lines (see
   lib/sources/resume.js). Tools need individual sections (experience,
   skills, certifications ...), so split the text by heading and map each
   heading to a stable key.
   ===================================================================== */

const SECTION_KEYS = ["summary", "experience", "projects", "education", "skills", "certifications", "additional_stack"];

function keyOf(title) {
  const t = String(title).toLowerCase();
  if (/summary|profile|objective/.test(t)) return "summary";
  if (/experience|employment|work history/.test(t)) return "experience";
  if (/project/.test(t)) return "projects";
  if (/education|academic/.test(t)) return "education";
  if (/certif|licen[cs]e/.test(t)) return "certifications";
  if (/additional|other.*(stack|tools|technolog)/.test(t)) return "additional_stack";
  if (/skill|technolog|stack/.test(t)) return "skills";
  return t.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "other";
}

/**
 * @param {string} text resume text with "## HEADING" lines
 * @returns {{ header: string, sections: Record<string, {title: string, lines: string[]}> }}
 */
function splitSections(text) {
  const out = { header: "", sections: {} };
  const headerLines = [];
  let current = null;

  for (const raw of String(text == null ? "" : text).split("\n")) {
    const line = raw.trim();
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      const key = keyOf(m[1]);
      current = out.sections[key] || (out.sections[key] = { title: m[1].trim(), lines: [] });
      continue;
    }
    if (!line) continue;
    (current ? current.lines : headerLines).push(line);
  }
  out.header = headerLines.join("\n");
  return out;
}

module.exports = { splitSections, keyOf, SECTION_KEYS };
