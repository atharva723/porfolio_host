/* =====================================================================
   Minimal RFC 4180 CSV parser (no dependency).
   Handles quoted fields, escaped quotes (""), embedded commas/newlines,
   CRLF/LF line endings and a leading UTF-8 BOM — all of which appear in
   LinkedIn's data export.
   ===================================================================== */

/**
 * @param {string} text
 * @returns {string[][]} rows of fields
 */
function parseCsv(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error("Malformed CSV: unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a CSV whose first non-empty row is a header into objects keyed by
 * header name. Blank rows are skipped; missing cells become "".
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
function parseCsvObjects(text) {
  const rows = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ""));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] == null ? "" : r[i]])));
}

module.exports = { parseCsv, parseCsvObjects };
