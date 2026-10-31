/* =====================================================================
   TOOL ARGUMENT VALIDATION
   ---------------------------------------------------------------------
   A deliberately small JSON-Schema subset (string / integer / boolean,
   enum, maxLength, min / max, required). Arguments come from a model that
   read untrusted text, so they are validated before any tool runs:
   wrong types, out-of-range values and values outside an enum are
   REJECTED; unknown keys are dropped; strings are trimmed and stripped of
   control characters.
   ===================================================================== */

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * @param {object} schema  { type: "object", properties, required? }
 * @param {unknown} input
 * @returns {{ ok: true, args: object } | { ok: false, error: string }}
 */
function validate(schema, input) {
  const props = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "arguments must be an object" };

  const args = {};
  for (const [name, def] of Object.entries(props)) {
    let v = input[name];
    if (typeof v === "string") v = v.replace(CONTROL_RE, " ").trim();
    if (v === undefined || v === null || v === "") {
      if (required.includes(name)) return { ok: false, error: `"${name}" is required` };
      continue;
    }

    if (def.type === "string") {
      if (typeof v !== "string") return { ok: false, error: `"${name}" must be a string` };
      if (def.enum && !def.enum.includes(v)) return { ok: false, error: `"${name}" must be one of: ${def.enum.join(", ")}` };
      if (def.maxLength && v.length > def.maxLength) return { ok: false, error: `"${name}" is too long (max ${def.maxLength})` };
    } else if (def.type === "integer") {
      if (!Number.isInteger(v)) return { ok: false, error: `"${name}" must be an integer` };
      if (def.minimum !== undefined && v < def.minimum) return { ok: false, error: `"${name}" must be >= ${def.minimum}` };
      if (def.maximum !== undefined && v > def.maximum) return { ok: false, error: `"${name}" must be <= ${def.maximum}` };
    } else if (def.type === "boolean") {
      if (typeof v !== "boolean") return { ok: false, error: `"${name}" must be true or false` };
    } else {
      return { ok: false, error: `"${name}" has an unsupported type` };
    }
    args[name] = v;
  }
  return { ok: true, args };
}

/** Compact "name?: type" signature used in the planner's tool catalogue. */
function signature(schema) {
  const props = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  return Object.entries(props)
    .map(([name, def]) => `${name}${required.includes(name) ? "" : "?"}: ${def.enum ? def.enum.join("|") : def.type}`)
    .join(", ");
}

module.exports = { validate, signature };
