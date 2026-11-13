/* =====================================================================
   KNOWLEDGE BASE — kb/kb.json loader, validator and prompt renderer
   ---------------------------------------------------------------------
   kb.json is the single canonical record of everything the portfolio
   says about its owner. The assistant and the website are two views of it:
     profile, about, skills, experience, education, credentials  — owner content
     facts      — short statements the assistant may repeat
     projects   — details synced from GitHub
     linkedin   — snapshot imported from the LinkedIn data export
   The resume is read live from Google Docs (lib/sources/resume.js) and
   acts as a witness: lib/kb-check.js reports where it disagrees.

   Every entry carries an id, a source and an updated date so answers can
   be traced and stale data spotted. Text that the website renders is plain
   (no HTML) so it is safe in both places.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const projects = require("./projects");
const { ICON_RE } = require("./icons");
const { parseRepoLink, slug } = require("./kb-build");

const KB_PATH = path.join(__dirname, "..", "kb", "kb.json");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// "Jan 2026": the same display format already used by credentials and the LinkedIn snapshot.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_YEAR_RE = new RegExp(`^(${MONTHS.join("|")}) (\\d{4})$`);
const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];
// Site-facing copy is plain text. The only markup allowed is **bold** in about.paragraphs.
const MARKUP_RE = /[<>]/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const monthValue = (s) => {
  const m = MONTH_YEAR_RE.exec(s);
  return m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1]) : NaN;
};
/** "Jan 2026" -> "January 2026" (what the assistant says aloud); anything else is returned as is. */
const longMonth = (s) => {
  const m = MONTH_YEAR_RE.exec(s);
  return m ? `${LONG_MONTHS[MONTHS.indexOf(m[1])]} ${m[2]}` : String(s);
};

function validate(kb) {
  const errors = [];
  const ids = new Set();
  const entry = (where, item, required) => {
    if (!item || typeof item !== "object") return errors.push(`${where}: not an object`);
    if (!isStr(item.id)) errors.push(`${where}: missing id`);
    else if (ids.has(item.id)) errors.push(`${where}: duplicate id "${item.id}"`);
    else ids.add(item.id);
    if (!isStr(item.source)) errors.push(`${where}: missing source`);
    if (!DATE_RE.test(item.updated || "")) errors.push(`${where}: updated must be YYYY-MM-DD`);
    for (const field of required) if (!isStr(item[field])) errors.push(`${where}: missing "${field}"`);
  };
  // Copy that the website renders and the assistant repeats: bounded, plain, no HTML.
  const plain = (where, value, max, { bold = false } = {}) => {
    if (!isStr(value)) return errors.push(`${where}: must be a non-empty string`);
    if (value.length > max) errors.push(`${where}: longer than ${max} characters`);
    if (MARKUP_RE.test(value)) errors.push(`${where}: must be plain text (no < or >)`);
    if (bold && (value.match(/\*\*/g) || []).length % 2) errors.push(`${where}: unbalanced ** markers`);
    if (!bold && value.includes("**")) errors.push(`${where}: ** markers are only allowed in about.paragraphs`);
  };
  const monthYear = (where, value) => {
    if (!MONTH_YEAR_RE.test(value || "")) errors.push(`${where}: must look like "Jan 2026"`);
  };

  if (!kb || typeof kb !== "object") throw new Error("kb.json is not an object");
  if (!DATE_RE.test(kb.updated || "")) errors.push("kb.updated must be YYYY-MM-DD");

  entry("profile", kb.profile, ["name", "headline", "location", "email", "github", "linkedin"]);
  if (kb.profile && typeof kb.profile === "object") plain("profile.tagline", kb.profile.tagline, 200);
  const lists = {
    education: ["degree", "institution"],
    credentials: ["title", "issuer"],
    facts: ["text"],
    // A project needs no link (the card then has no "View Code" button); the icon is for the site.
    projects: ["repo", "title", "description"],
    skills: ["name"],
    experience: ["role", "company", "started"],
  };
  for (const [key, required] of Object.entries(lists)) {
    if (!Array.isArray(kb[key])) errors.push(`${key}: must be an array`);
    else kb[key].forEach((item, i) => entry(`${key}[${i}]`, item, required));
  }

  // Website-facing sections: the same record feeds the site and the assistant.
  entry("about", kb.about, []);
  if (kb.about && typeof kb.about === "object") {
    const paragraphs = kb.about.paragraphs;
    if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.length > 6) errors.push("about.paragraphs: must be 1-6 paragraphs");
    else paragraphs.forEach((p, i) => plain(`about.paragraphs[${i}]`, p, 700, { bold: true }));
  }

  (Array.isArray(kb.skills) ? kb.skills : []).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const where = `skills[${i}]`;
    plain(`${where}.name`, s.name, 60);
    // Levels are the owner's own rating; the assistant presents them as self-rated.
    if (s.level !== undefined && !LEVELS.includes(s.level)) errors.push(`${where}.level: must be one of ${LEVELS.join(", ")}`);
    if (s.icon !== undefined && !ICON_RE.test(s.icon)) errors.push(`${where}.icon: must be a Font Awesome 6 class like "fab fa-python"`);
  });

  (Array.isArray(kb.credentials) ? kb.credentials : []).forEach((c, i) => {
    if (c && typeof c === "object" && c.icon !== undefined && !ICON_RE.test(c.icon)) {
      errors.push(`credentials[${i}].icon: must be a Font Awesome 6 class like "fab fa-microsoft"`);
    }
  });

  (Array.isArray(kb.projects) ? kb.projects : []).forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    if (p.link !== undefined && typeof p.link !== "string") errors.push(`projects[${i}].link: must be a string`);
    if (p.icon !== undefined && !ICON_RE.test(p.icon)) errors.push(`projects[${i}].icon: must be a Font Awesome 6 class like "fab fa-python"`);
  });

  (Array.isArray(kb.experience) ? kb.experience : []).forEach((x, i) => {
    if (!x || typeof x !== "object") return;
    const where = `experience[${i}]`;
    plain(`${where}.role`, x.role, 120);
    plain(`${where}.company`, x.company, 120);
    // e.g. "Full-time": how he is employed there. Optional.
    if (x.type !== undefined) plain(`${where}.type`, x.type, 40);
    monthYear(`${where}.started`, x.started);
    if (x.ended !== null && x.ended !== undefined) {
      monthYear(`${where}.ended`, x.ended);
      if (monthValue(x.ended) < monthValue(x.started)) errors.push(`${where}: ended is before started`);
    }
    if (x.engagement !== undefined) {
      if (!x.engagement || typeof x.engagement !== "object") errors.push(`${where}.engagement: must be an object`);
      else {
        plain(`${where}.engagement.name`, x.engagement.name, 160);
        monthYear(`${where}.engagement.started`, x.engagement.started);
        if (monthValue(x.engagement.started) < monthValue(x.started)) errors.push(`${where}: the engagement starts before the role`);
      }
    }
    if (x.points !== undefined) {
      if (!Array.isArray(x.points) || x.points.length > 10) errors.push(`${where}.points: must be a list of at most 10`);
      else x.points.forEach((p, j) => plain(`${where}.points[${j}]`, p, 300));
    }
  });
  // Newest first: the site lists roles in this order, and the assistant says "current role" for the first.
  const roles = Array.isArray(kb.experience) ? kb.experience : [];
  for (let i = 1; i < roles.length; i++) {
    if (roles[i - 1] && roles[i] && monthValue(roles[i - 1].started) < monthValue(roles[i].started)) {
      errors.push(`experience[${i}]: roles must be listed newest first, but this one started after the role above it`);
    }
  }

  if (kb.linkedin !== null && kb.linkedin !== undefined) {
    entry("linkedin", kb.linkedin, []);
    if (!DATE_RE.test((kb.linkedin && kb.linkedin.asOf) || "")) errors.push("linkedin.asOf must be YYYY-MM-DD");
    for (const key of ["positions", "education", "skills"]) {
      if (kb.linkedin && kb.linkedin[key] !== undefined && !Array.isArray(kb.linkedin[key])) errors.push(`linkedin.${key}: must be an array`);
    }
  }

  if (errors.length) throw new Error("Invalid kb/kb.json:\n- " + errors.join("\n- "));
  return kb;
}

const slugOr = (s) => slug(s) || "project";

/**
 * Pairing a project card with its kb.json entry is deliberately conservative, because a wrong
 * pairing would give one project another's link and README text:
 *   1. the same GitHub repository (owner AND name, case-insensitive);
 *   2. otherwise the same title, but only with an entry that no other card claimed, which is how a
 *      renamed repository is recognised.
 * Each kb.json entry is used at most once, and a card without a link never matches by link.
 * Shared by the merge below and by the drift check (lib/kb-check.js), so both agree on who is who.
 *
 * @returns {Array<object|null>} for each card, in order, its kb.json entry or null
 */
function pairProjects(ownProjects, cardItems) {
  const lower = (s) => String(s || "").trim().toLowerCase();
  const repoKey = (link) => {
    const parts = parseRepoLink(link);
    return parts ? `${parts.owner}/${parts.repo}`.toLowerCase() : "";
  };
  const byRepo = new Map();
  for (const p of ownProjects) {
    const key = repoKey(p.link);
    if (key && !byRepo.has(key)) byRepo.set(key, p);
  }

  const used = new Set();
  const matches = new Array(cardItems.length).fill(null);
  cardItems.forEach((card, i) => {
    const key = repoKey(card.link);
    const entry = key ? byRepo.get(key) : null;
    if (entry && !used.has(entry)) {
      matches[i] = entry;
      used.add(entry);
    }
  });
  cardItems.forEach((card, i) => {
    if (matches[i]) return;
    const entry = ownProjects.find((p) => !used.has(p) && lower(p.title) === lower(card.title));
    if (entry) {
      matches[i] = entry;
      used.add(entry);
    }
  });
  return matches;
}

/**
 * The project list the whole app uses. public/data/projects.json decides which projects exist, in
 * what order, with which text and icon (it is exactly what the website shows). kb.json's own copy
 * (synced from GitHub) adds the README excerpts, supplies the CANONICAL repository link (a repo that
 * was renamed on GitHub still has its old name in projects.json), and IS the list when that file is
 * unusable. Merging here means the assistant can never lag behind the site, even before
 * `npm run kb:sync` is run.
 */
function mergeProjects(raw, options = {}) {
  const cards = projects.load({ fallback: raw.projects, ...options });
  if (cards.source === "kb") return raw.projects;

  const matches = pairProjects(raw.projects, cards.items);

  const seen = new Set();
  return cards.items.map(({ order, ...card }, i) => {
    const match = matches[i];
    const parts = parseRepoLink(card.link);
    const base = match ? match.id : `proj-${slugOr(card.title)}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    const link = (match && match.link) || card.link;
    return {
      id,
      repo: match ? match.repo : parts ? parts.repo : slugOr(card.title),
      title: card.title,
      description: card.description,
      tech: card.tech,
      ...(link ? { link } : {}),
      icon: card.icon,
      ...(match && match.highlights ? { highlights: match.highlights } : {}),
      source: match ? "projects.json+github" : "projects.json",
      updated: match ? match.updated : raw.updated,
    };
  });
}

/** The file exactly as written, validated. For scripts that rewrite kb.json: never save `load()`'s merged view. */
function loadRaw() {
  return validate(JSON.parse(fs.readFileSync(KB_PATH, "utf8")));
}

let cached = { key: "", kb: null };

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Load the KB (validated) with the live project list merged in. In development, edits to either file are picked up without a restart. */
function load() {
  const prod = process.env.NODE_ENV === "production";
  if (cached.kb && prod) return cached.kb;
  const key = `${mtime(KB_PATH)}:${mtime(projects.currentFile())}`;
  if (cached.kb && cached.key === key) return cached.kb;
  const raw = loadRaw();
  const kb = { ...raw, projects: mergeProjects(raw) };
  cached = { key, kb };
  return kb;
}

/** Short content hash; changes whenever the KB (or the project cards) change. */
function version(kb = load()) {
  return crypto.createHash("sha256").update(JSON.stringify(kb)).digest("hex").slice(0, 12);
}

const plainText = (s) => String(s).replace(/\*\*/g, "");
const clipText = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n - 1).trimEnd()}…`);

/** One role as a sentence: "Engineer at ACME — Full-time, January 2026 – present". Shared by the prompt text and the tools. */
function describeRole(x) {
  const span = `${longMonth(x.started)} – ${x.ended ? longMonth(x.ended) : "present"}`;
  return `${x.role} at ${x.company} — ${[x.type, span].filter(Boolean).join(", ")}`;
}

/** The project a role is on, or "" */
const describeEngagement = (x) => (x.engagement ? `${x.engagement.name} (since ${longMonth(x.engagement.started)})` : "");

/** Flatten the KB into readable text for the model. */
function toText(kb = load()) {
  const p = kb.profile;
  const lines = [
    `Name: ${p.name}`,
    `Headline: ${p.headline}`,
    p.employer ? `Employer: ${p.employer}` : "",
    `Location: ${p.location}`,
    `Contact: email ${p.email}; GitHub ${p.github}; LinkedIn ${p.linkedin}${p.website ? `; portfolio ${p.website}` : ""}`,
  ].filter(Boolean);

  if (kb.about && kb.about.paragraphs && kb.about.paragraphs.length) {
    lines.push("\nAbout him (his own words):");
    kb.about.paragraphs.forEach((t) => lines.push(plainText(t)));
  }

  if (kb.experience && kb.experience.length) {
    lines.push("\nExperience (his confirmed record, newest first):");
    kb.experience.forEach((x) => {
      lines.push(`- ${describeRole(x)}`);
      if (x.engagement) lines.push(`    Project: ${describeEngagement(x)}`);
      (x.points || []).forEach((pt) => lines.push(`    • ${pt}`));
    });
  }

  if (kb.skills && kb.skills.length) {
    lines.push("\nSkills (a level is his OWN rating of himself, not an assessment):");
    lines.push(kb.skills.map((s) => (s.level ? `${s.name} (${s.level}, self-rated)` : s.name)).join("; "));
  }
  if (kb.education.length) {
    lines.push("\nEducation:");
    kb.education.forEach((e) => {
      const parts = [e.institution, e.affiliation, e.period ? `studied ${e.period}` : "", e.graduated ? `graduated ${e.graduated}` : "", e.score].filter(Boolean);
      lines.push(`- ${e.degree} — ${parts.join("; ")}`);
    });
  }

  if (kb.credentials.length) {
    lines.push("\nCertifications and credentials, with verification links:");
    kb.credentials.forEach((c) => {
      const parts = [
        c.issuer,
        c.earned ? `earned ${c.earned}` : "",
        c.expires ? `valid until ${c.expires}` : "",
        c.credentialId ? `credential ID ${c.credentialId}` : "",
      ].filter(Boolean);
      lines.push(`- ${c.title}${c.code ? ` (${c.code})` : ""} — ${parts.join("; ")}`);
      if (c.verifyUrl) lines.push(`    Verify: ${c.verifyUrl}`);
    });
  }

  if (kb.projects.length) {
    lines.push("\nProjects (as shown on his portfolio, with GitHub details):");
    kb.projects.forEach((pr) => {
      lines.push(`- ${pr.title}${pr.link ? ` (${pr.link})` : ""}: ${pr.description}`);
      if (pr.tech && pr.tech.length) lines.push(`    Tech: ${pr.tech.join(", ")}`);
      if (pr.highlights) lines.push(`    Details: ${pr.highlights}`);
    });
  }

  if (kb.facts.length) {
    lines.push("\nQuick facts:");
    kb.facts.forEach((f) => lines.push(`- ${f.text}`));
  }

  const li = kb.linkedin;
  if (li) {
    lines.push(`\nLinkedIn profile snapshot (as of ${li.asOf}; it can lag, and the profile above wins if they differ):`);
    if (li.headline) lines.push(`Headline: ${li.headline}`);
    if (li.location || li.industry) lines.push(`Location: ${li.location || "n/a"}; industry: ${li.industry || "n/a"}`);
    // The snapshot only supports the profile above, so its long free text is clipped (prompt and verifier budget).
    if (li.summary) lines.push(`About: ${clipText(li.summary, 500)}`);
    (li.positions || []).forEach((r) => {
      const span = `${r.started || "?"} – ${r.finished || "present"}`;
      lines.push(`- ${r.title} at ${r.company} (${span})${r.description ? `: ${clipText(r.description, 400)}` : ""}`);
    });
    if (li.skills && li.skills.length) lines.push(`Skills listed on LinkedIn: ${li.skills.join(", ")}`);
  }

  return lines.join("\n");
}

module.exports = { load, loadRaw, validate, mergeProjects, pairProjects, version, toText, KB_PATH, ICON_RE, monthValue, longMonth, describeRole, describeEngagement, plainText };
