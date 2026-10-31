/* =====================================================================
   Small text helpers shared by every ingestion path (live resume,
   LinkedIn import). Imported text is untrusted DATA: strip control
   characters, collapse whitespace, cap length, and redact phone numbers
   before anything is stored or shown to a model.
   ===================================================================== */

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Replace phone-number-like sequences (10+ digits) so they never reach the model. */
function redactPhones(text) {
  return String(text).replace(/(?<![\w])(?:\+|\()?\d[\d\s().-]{7,}\d(?![\w])/g, (m) =>
    m.replace(/\D/g, "").length >= 10 ? "[phone number withheld]" : m
  );
}

/** One-line, length-capped, phone-redacted text. */
function cleanText(value, max = 500) {
  const t = String(value == null ? "" : value).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return redactPhones(t).slice(0, max);
}

module.exports = { redactPhones, cleanText, CONTROL_RE };
