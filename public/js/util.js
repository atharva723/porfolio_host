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

  // Minimal allowlist sanitizer for rich text (e.g. about paragraphs that
  // intentionally contain <strong>). Escapes everything, then re-enables a
  // tiny set of formatting tags. No attributes are ever allowed.
  function sanitizeHtml(str) {
    let html = escapeHtml(str);
    html = html
      .replace(/&lt;(\/?)(strong|b|em|i|br)\s*&gt;/gi, "<$1$2>")
      .replace(/&lt;br\s*\/&gt;/gi, "<br>");
    return html;
  }

  root.PortfolioUtil = { escapeHtml: escapeHtml, safeUrl: safeUrl, sanitizeHtml: sanitizeHtml };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.PortfolioUtil;
  }
})(typeof window !== "undefined" ? window : globalThis);
