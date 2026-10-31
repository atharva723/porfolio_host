/* =====================================================================
   DETERMINISTIC GROUNDING CHECKS
   ---------------------------------------------------------------------
   Cheap, model-free checks that run BEFORE the LLM verifier. Anything the
   assistant says that is easy to verify mechanically must literally appear
   in the sources:
     - links and e-mail addresses
     - phone numbers (never allowed: they are redacted from the sources)
     - decimals, percentages and four-digit years (CGPA, scores, dates)
   Returns problem CATEGORIES only; the offending text is never echoed
   back to the model, so a poisoned draft can't smuggle instructions into
   the retry prompt.
   ===================================================================== */

const { redactPhones } = require("./text");

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DECIMAL_RE = /\b\d+\.\d+\b/g;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s?%/g;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

// Normalise typography so "AZ‑900", "77 %" and curly quotes compare equal.
const normalize = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+%/g, "%")
    .replace(/\s+/g, " ");

const trimUrl = (u) => u.replace(/[.,;:!?]+$/, "");

/**
 * @param {string} answer
 * @param {string} evidenceText  everything the model was allowed to use
 * @returns {{ ok: boolean, problems: Array<"link"|"email"|"phone"|"number">, details: string[] }}
 */
function checkGrounding(answer, evidenceText) {
  const text = String(answer == null ? "" : answer);
  const evidence = normalize(evidenceText);
  const problems = new Set();
  const details = [];
  const flag = (kind, what) => {
    problems.add(kind);
    details.push(`${kind}: ${what}`);
  };

  for (const m of text.match(URL_RE) || []) {
    const url = normalize(trimUrl(m));
    if (!evidence.includes(url) && !evidence.includes(url.replace(/\/$/, ""))) flag("link", m);
  }

  for (const m of text.match(EMAIL_RE) || []) {
    if (!evidence.includes(normalize(m))) flag("email", m);
  }

  // Strip links and e-mails first so their digits (ids, hosts) aren't mistaken for
  // phone numbers or double-checked as numbers.
  const prose = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  if (redactPhones(prose) !== prose) flag("phone", "phone-like number");

  for (const re of [DECIMAL_RE, PERCENT_RE, YEAR_RE]) {
    for (const m of prose.match(re) || []) {
      if (!evidence.includes(normalize(m))) flag("number", m);
    }
  }

  return { ok: problems.size === 0, problems: [...problems], details };
}

module.exports = { checkGrounding };
