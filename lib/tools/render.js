/* =====================================================================
   TOOL RESULT RENDERER
   ---------------------------------------------------------------------
   Turns a tool's plain-object result into compact, LINE-BASED text. The
   same text is shown to the answering model and used as verifier
   evidence, so every fact sits on its own line (the verifier selects and
   tags evidence line by line).
   ===================================================================== */

const line = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
function render(data) {
  const out = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (!value.length) {
        out.push(`${key}: (none)`);
        continue;
      }
      out.push(`${key}:`);
      for (const item of value) out.push(`- ${line(item)}`);
    } else if (typeof value === "string" && value.includes("\n")) {
      out.push(`${key}:`);
      for (const l of value.split("\n")) if (l.trim()) out.push(`- ${l.trim()}`);
    } else if (typeof value === "object") {
      out.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      out.push(`${key}: ${value}`);
    }
  }
  return out.join("\n");
}

module.exports = { render };
