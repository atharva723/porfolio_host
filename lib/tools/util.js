/* Shared helpers for tool modules. */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const clip = (s, n) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
};

/** How many words of the query appear in the combined fields (case-insensitive substring). */
function hits(query, ...fields) {
  const words = norm(query).split(" ").filter((w) => w.length >= 2);
  if (!words.length) return 0;
  const haystack = norm(fields.flat().join(" "));
  return words.filter((w) => haystack.includes(w)).length;
}

/** "Oct 2027" / "October 2027" -> Date at the END of that month (UTC), or null. */
function monthYearEnd(text) {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(String(text || "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[2]), month + 1, 0, 23, 59, 59));
}

/** Total order for "Mon YYYY" strings (newest first when compared descending). */
const monthYearValue = (text) => {
  const d = monthYearEnd(text);
  return d ? d.getTime() : 0;
};

module.exports = { norm, clip, hits, monthYearEnd, monthYearValue };
