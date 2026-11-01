/* =====================================================================
   RESUME DOWNLOAD — PDF export of the resume Google Doc
   ---------------------------------------------------------------------
   The "Publish to web" link used for the live resume text cannot be
   exported (it hides the real document id), so the download is configured
   with the document's normal share link:

     RESUME_PDF_DOC_URL   https://docs.google.com/document/d/<id>/edit
                          (the doc must be shared as "Anyone with the link:
                          Viewer"). A bare document id is also accepted.

   Visitors and the assistant only ever see a stable link on THIS site
   (/resume.pdf). The route redirects to Google's PDF export, and the
   target is rebuilt from the validated document id, never from the
   request, so it cannot become an open redirect.
   ===================================================================== */

const HOST = "docs.google.com";
const ROUTE = "/resume.pdf";
const ID_RE = /^[A-Za-z0-9_-]{20,200}$/;
const PATH_RE = /^\/document(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{20,200})(?:\/[A-Za-z]*)?\/?$/;

/**
 * Document id from a normal Google Doc link (or a bare id).
 * Returns null for anything else, including the "publish to web" form (/d/e/2PACX-...),
 * other hosts, http, ports, credentials and other Google products.
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseDocLink(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();

  if (!/^https?:/i.test(value)) return ID_RE.test(value) && !value.startsWith("2PACX") ? value : null;

  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== HOST || u.port || u.username || u.password) return null;
  const m = PATH_RE.exec(u.pathname);
  return m ? m[1] : null;
}

const configuredId = (env = process.env) => parseDocLink(env.RESUME_PDF_DOC_URL);

/** Google's PDF export link for the configured doc, or null when unset/invalid. */
function exportUrl(env = process.env) {
  const id = configuredId(env);
  return id ? `https://${HOST}/document/d/${id}/export?format=pdf` : null;
}

/** The stable link to offer visitors (on this site), or null when no download is configured. */
function downloadUrl(website, env = process.env) {
  if (!configuredId(env)) return null;
  try {
    return new URL(ROUTE.slice(1), website).toString();
  } catch {
    return null;
  }
}

module.exports = { parseDocLink, exportUrl, downloadUrl, ROUTE };
