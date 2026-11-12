/* =====================================================================
   PROJECT CARDS
   ---------------------------------------------------------------------
   public/data/projects.json is the authority for which projects the
   portfolio shows, in what order, and with which icon. The n8n workflow
   keeps writing it, so this loader never writes anything.

   The file is treated as untrusted input: every item is validated and
   cleaned, and a bad item is skipped instead of breaking the page. If the
   file is missing or has no usable item, the GitHub-synced copy in
   kb.json is used, so the site never falls back to hand-written text.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const { cleanText } = require("./text");
const { ICON_RE, DEFAULT_ICON } = require("./icons");

const FILE = path.join(__dirname, "..", "public", "data", "projects.json");
const MAX_ITEMS = 24;

let activeFile = FILE;
/** The file the cards are read from (kb.load() watches it to refresh its cache). */
const currentFile = () => activeFile;
/** Tests only: read the cards from another file; no argument restores the real one. */
function _setFile(file) {
  activeFile = file || FILE;
}

/** https links only: the card button opens the repository. */
function httpsUrl(value) {
  try {
    const u = new URL(String(value == null ? "" : value).trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** @returns {{ title: string, description: string, tech: string[], link: string|null, icon: string, order: number }|null} */
function clean(item) {
  if (!item || typeof item !== "object") return null;
  const title = cleanText(item.title, 120);
  const description = cleanText(item.description, 700);
  if (!title || !description) return null;
  const order = Number(item.order);
  return {
    title,
    description,
    tech: (Array.isArray(item.tech) ? item.tech : []).map((t) => cleanText(t, 40)).filter(Boolean).slice(0, 12),
    link: httpsUrl(item.link),
    icon: ICON_RE.test(item.icon || "") ? item.icon : DEFAULT_ICON,
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
  };
}

const byOrder = (a, b) => a.order - b.order;

/**
 * The project cards to show.
 * @param {{ file?: string, fallback?: object[] }} [options] `fallback`: kb.json projects, used when the file has nothing usable
 * @returns {{ items: ReturnType<typeof clean>[], source: "projects.json"|"kb", skipped: number }}
 */
function load({ file = activeFile, fallback = [] } = {}) {
  let skipped = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const listed = (Array.isArray(raw && raw.items) ? raw.items : []).filter((p) => !(p && p.featured === false));
    const items = listed.map(clean).filter(Boolean);
    skipped = listed.length - items.length;
    if (items.length) return { items: items.sort(byOrder).slice(0, MAX_ITEMS), source: "projects.json", skipped };
  } catch {
    /* missing or unreadable: fall through to the KB copy */
  }
  const items = (Array.isArray(fallback) ? fallback : []).map(clean).filter(Boolean);
  return { items: items.slice(0, MAX_ITEMS), source: "kb", skipped };
}

module.exports = { load, clean, FILE, currentFile, _setFile, DEFAULT_ICON };
