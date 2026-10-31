/* =====================================================================
   KB BUILD HELPERS — turn raw GitHub README markdown into a short,
   plain-text excerpt that is safe and cheap to put in the prompt.
   ===================================================================== */

/**
 * @param {string} markdown
 * @param {number} [maxChars]
 * @returns {string}
 */
function cleanReadme(markdown, maxChars = 600) {
  let t = String(markdown || "")
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ") // badge links
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ") // table rules / hr
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/[*_`>|]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (t.length <= maxChars) return t;
  t = t.slice(0, maxChars);
  const cut = Math.max(t.lastIndexOf(". "), t.lastIndexOf(" "));
  return (cut > maxChars * 0.6 ? t.slice(0, cut) : t).replace(/[\s,;:.-]+$/, "") + "…";
}

/** Parse "https://github.com/<owner>/<repo>" into its parts, or null. */
function parseRepoLink(link) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(String(link || ""));
  return m ? { owner: m[1], repo: m[2] } : null;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

module.exports = { cleanReadme, parseRepoLink, slug };
