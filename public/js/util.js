/* =====================================================================
   SHARED CLIENT UTILITIES
   ---------------------------------------------------------------------
   One place for HTML/URL safety helpers, used by render.js and chat.js
   so escaping behaves consistently across the whole client.
   ===================================================================== */

(function (root) {
  "use strict";

  // Escape text so it is safe to place inside HTML.
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Allow only safe URL schemes; block javascript:, data:, etc.
  // Returns a safe href string ("#" if the scheme is not allowed).
  function safeUrl(url) {
    const value = String(url == null ? "" : url).trim();
    if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
    // Allow relative/anchor links (no scheme).
    if (/^(\/|#|\.\/|\.\.\/)/.test(value) || !/:/.test(value)) return value;
    return "#";
  }

  // Text with **bold** markers -> safe HTML. The text is escaped FIRST, so the only tags that can
  // ever appear are the <strong> pairs created here, never anything from the data.
  function boldText(str) {
    return escapeHtml(str).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  // "Jane Doe" -> { first: "Jane ", last: "Doe" } (the hero types them separately).
  function splitName(name) {
    const full = String(name == null ? "" : name).trim();
    const at = full.lastIndexOf(" ");
    return at < 0 ? { first: "", last: full } : { first: full.slice(0, at + 1), last: full.slice(at + 1) };
  }

  root.PortfolioUtil = { escapeHtml: escapeHtml, safeUrl: safeUrl, boldText: boldText, splitName: splitName };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.PortfolioUtil;
  }
})(typeof window !== "undefined" ? window : globalThis);
