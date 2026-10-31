/* =====================================================================
   LINKEDIN EXPORT IMPORT
   ---------------------------------------------------------------------
   Turns LinkedIn's "Basic" data export into kb.json content.

   Privacy by construction:
   - Only five files are ever opened (Profile, Positions, Education,
     Skills, Certifications) and only named columns are read. Connections,
     invitations, messages, phone numbers, e-mail addresses, birth date,
     address and zip code are never touched.
   - Every string is cleaned (control characters, length cap, phone
     redaction) because the export is treated as untrusted data.

   Decisions that must survive re-imports (which certifications to leave
   out, exam codes, company display names) live in
   scripts/linkedin.config.json.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const { parseCsvObjects } = require("./csv");
const { cleanText } = require("./text");
const { slug } = require("./kb-build");

const FILES = {
  profile: "Profile.csv",
  positions: "Positions.csv",
  education: "Education.csv",
  skills: "Skills.csv",
  certifications: "Certifications.csv",
};

const MAX = { positions: 20, education: 10, skills: 60, credentials: 40 };

const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Read the five allow-listed files from an extracted export folder. */
function readExport(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`"${dir}" is not a folder. Extract the LinkedIn export zip first, then pass the folder.`);
  }
  const raw = {};
  const warnings = [];
  let found = 0;
  for (const [key, name] of Object.entries(FILES)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      raw[key] = [];
      warnings.push(`${name} not found in the export`);
      continue;
    }
    found++;
    raw[key] = parseCsvObjects(fs.readFileSync(file, "utf8"));
  }
  if (!found) throw new Error(`None of the expected LinkedIn files (${Object.values(FILES).join(", ")}) were found in "${dir}".`);
  return { raw, warnings };
}

/** Drop LinkedIn's truncated, value-less "?sharingId" and keep only http(s) links. */
function cleanUrl(value) {
  try {
    const u = new URL(String(value == null ? "" : value).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (u.searchParams.get("sharingId") === "") u.searchParams.delete("sharingId");
    return u.toString();
  } catch {
    return "";
  }
}

function buildSnapshot(raw, config, today, profileUrl) {
  const profile = (raw.profile && raw.profile[0]) || {};
  const companyNames = {};
  for (const [k, v] of Object.entries(config.companyNames || {})) companyNames[norm(k)] = v;

  const positions = (raw.positions || []).slice(0, MAX.positions).map((p) => {
    const company = cleanText(p["Company Name"], 120);
    return {
      company: companyNames[norm(company)] || company,
      title: cleanText(p.Title, 160),
      description: cleanText(p.Description, 1500),
      location: cleanText(p.Location, 120),
      started: cleanText(p["Started On"], 30),
      finished: cleanText(p["Finished On"], 30) || null,
    };
  });

  const education = (raw.education || []).slice(0, MAX.education).map((e) => ({
    school: cleanText(e["School Name"], 160),
    degree: cleanText(e["Degree Name"], 160),
    started: cleanText(e["Start Date"], 30),
    ended: cleanText(e["End Date"], 30),
  }));

  const skills = [];
  for (const s of raw.skills || []) {
    const name = cleanText(s.Name, 80);
    if (name && !skills.some((x) => norm(x) === norm(name))) skills.push(name);
    if (skills.length >= MAX.skills) break;
  }

  const summary = cleanText(profile.Summary, 2000);
  return {
    id: "linkedin",
    source: "linkedin-export",
    updated: today,
    asOf: today,
    url: profileUrl,
    headline: cleanText(profile.Headline, 300),
    location: cleanText(profile["Geo Location"], 120),
    industry: cleanText(profile.Industry, 120),
    ...(summary ? { summary } : {}),
    positions,
    education,
    skills,
  };
}

function freshCredential(row, config, today) {
  const title = cleanText(row.Name, 200);
  const codes = {};
  for (const [k, v] of Object.entries(config.credentialCodes || {})) codes[norm(k)] = v;
  const credentialId = cleanText(row["License Number"], 80);
  const code = codes[norm(title)] || "";
  const earned = cleanText(row["Started On"], 30);
  const expires = cleanText(row["Finished On"], 30);
  const verifyUrl = cleanUrl(row.Url);
  return {
    id: `cred-${slug(code || credentialId || title)}`,
    source: "linkedin-export",
    updated: today,
    ...(code ? { code } : {}),
    title,
    issuer: cleanText(row.Authority, 120),
    ...(earned ? { earned } : {}),
    ...(expires ? { expires } : {}),
    ...(credentialId ? { credentialId } : {}),
    ...(verifyUrl ? { verifyUrl } : {}),
  };
}

const sameCredential = (a, b) =>
  (a.credentialId && b.credentialId && norm(a.credentialId) === norm(b.credentialId)) || norm(a.title) === norm(b.title);

/**
 * Merge an export into a KB object. Returns a NEW kb plus a change report;
 * the input is not modified.
 *
 * Rules for credentials already in the KB: the export is authoritative for
 * title / issuer / dates / credential id; hand-set `code` and `verifyUrl`
 * are kept. KB credentials missing from the export are kept and reported.
 */
function mergeIntoKb(kb, raw, config = {}, today = new Date().toISOString().slice(0, 10)) {
  const next = JSON.parse(JSON.stringify(kb));
  const report = { credentials: { added: [], updated: [], unchanged: [], notInExport: [], excluded: [] }, warnings: [] };

  next.linkedin = buildSnapshot(raw, config, today, kb.profile.linkedin);
  const old = kb.linkedin ? { ...kb.linkedin, updated: null, asOf: null } : null;
  const fresh = { ...next.linkedin, updated: null, asOf: null };
  report.linkedinChanged = JSON.stringify(old) !== JSON.stringify(fresh);
  if (!report.linkedinChanged) next.linkedin = { ...kb.linkedin }; // keep dates when nothing changed

  const excludes = (config.excludeCredentials || []).map(norm);
  const seen = new Set();
  const merged = [];

  for (const row of (raw.certifications || []).slice(0, MAX.credentials)) {
    const f = freshCredential(row, config, today);
    if (!f.title) continue;
    if (excludes.some((x) => norm(f.title).includes(x))) {
      report.credentials.excluded.push(f.title);
      continue;
    }
    const existing = (kb.credentials || []).find((c) => sameCredential(c, f));
    if (!existing) {
      merged.push(f);
      report.credentials.added.push(f.title);
      continue;
    }
    seen.add(existing.id);
    const m = { ...existing, title: f.title, issuer: f.issuer || existing.issuer };
    if (f.earned) m.earned = f.earned;
    if (f.expires) m.expires = f.expires;
    else delete m.expires;
    if (f.credentialId) m.credentialId = f.credentialId;
    if (!m.code && f.code) m.code = f.code;
    if (!m.verifyUrl && f.verifyUrl) m.verifyUrl = f.verifyUrl;
    if (JSON.stringify(m) !== JSON.stringify(existing)) {
      m.updated = today;
      report.credentials.updated.push(m.title);
    } else {
      report.credentials.unchanged.push(m.title);
    }
    merged.push(m);
  }

  for (const c of kb.credentials || []) {
    if (!seen.has(c.id) && !merged.some((m) => m.id === c.id)) {
      merged.push(c);
      report.credentials.notInExport.push(c.title);
    }
  }

  next.credentials = merged;
  if (report.linkedinChanged || report.credentials.added.length || report.credentials.updated.length) next.updated = today;
  return { kb: next, report };
}

module.exports = { readExport, buildSnapshot, mergeIntoKb, cleanUrl, FILES };
