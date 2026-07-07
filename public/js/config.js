/* =====================================================================
   SHARED APP CONFIG
   ---------------------------------------------------------------------
   Single source of truth for limits used by BOTH the server (server.js)
   and the browser (chat.js). Works in Node (module.exports) and the
   browser (window.APP_CONFIG) via the dual-export at the bottom.
   ===================================================================== */

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const APP_CONFIG = {
  // Max characters accepted for a single chat message.
  MAX_MESSAGE_CHARS: 1000,
  // How many past user+assistant messages to keep for context.
  MAX_HISTORY_TURNS: 12,
  // Best-effort per-IP rate limits (see server.js for caveats).
  RATE_PER_MINUTE: 12,
  RATE_PER_DAY: 200,
  ONE_MINUTE_MS,
  ONE_DAY_MS,
};

if (typeof window !== "undefined") {
  window.APP_CONFIG = APP_CONFIG;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = APP_CONFIG;
}
