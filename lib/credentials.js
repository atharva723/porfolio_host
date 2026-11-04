/* =====================================================================
   CREDENTIAL RULES shared by the website and the assistant
   ---------------------------------------------------------------------
   Whether a certification is still valid, and the order they are listed
   in, are decided here once. The certifications tool and the website
   content both call these, so the page and the chat can't disagree.
   ===================================================================== */

const { monthYearEnd, monthYearValue } = require("./tools/util");

/**
 * Validity of a credential at `now`.
 * @returns {{ state: "valid"|"expired"|"none", label: string }}
 */
function status(credential, now = new Date()) {
  if (!credential.expires) return { state: "none", label: "no expiry listed" };
  const end = monthYearEnd(credential.expires);
  return end && end < now
    ? { state: "expired", label: `expired ${credential.expires}` }
    : { state: "valid", label: `valid until ${credential.expires}` };
}

/** Newest first, by the month the credential was earned. */
const newestFirst = (list) => [...list].sort((a, b) => monthYearValue(b.earned) - monthYearValue(a.earned));

module.exports = { status, newestFirst };
