#!/usr/bin/env node
/* =====================================================================
   Sync the "projects" section of kb/kb.json from GitHub.
   ---------------------------------------------------------------------
   Reads the repo list from public/data/projects.json, asks the GitHub API
   for each repo's current URL and README, and writes a clean excerpt into
   kb.json. Other sections (profile, education, facts, ...) are untouched.

   Usage:  npm run kb:sync            write kb/kb.json
           npm run kb:sync -- --dry   print what would change
           npm run kb:sync -- --check compare with GitHub and the site's cards; exit 1 on drift
   Env:    GITHUB_TOKEN  optional; raises the API rate limit.

   Repos that can't be read (private, renamed away, no README) keep the
   text from projects.json and are marked source "projects.json". A rate
   limit or a GitHub error is different: it stops the run (exit 2) instead
   of being mistaken for "nothing changed" or wiping a project's details.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const { cleanReadme, parseRepoLink, slug } = require("../lib/kb-build");
const { ICON_RE } = require("../lib/icons");
const { projectDiff } = require("../lib/kb-check");
const kbLib = require("../lib/kb");

const PROJECTS_JSON = path.join(__dirname, "..", "public", "data", "projects.json");
const TIMEOUT_MS = 10000;
// Only these mean "the public cannot read this repository". Anything else (a rate limit, a server
// error, a bad token) says nothing about the repository, so the run stops instead of guessing.
const NOT_READABLE = new Set([404, 410, 451]);

async function gh(pathname, accept) {
  const headers = { "User-Agent": "portfolio-kb-sync", Accept: accept || "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res;
}

/** Throws for any failed response that is not a plain "not readable / not found" answer. */
function mustBeAnswer(res) {
  if (res.ok || NOT_READABLE.has(res.status)) return res;
  if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit reached (set GITHUB_TOKEN to raise it)");
  throw new Error(`GitHub answered HTTP ${res.status}`);
}

async function readProject(item, today) {
  const base = {
    id: `proj-${slug(item.repo)}`,
    repo: item.repo,
    title: item.title,
    description: item.description,
    tech: Array.isArray(item.tech) ? item.tech : [],
    link: item.link,
    // Kept so the fallback list (used when projects.json is unusable) still shows the right icon.
    ...(ICON_RE.test(item.icon || "") ? { icon: item.icon } : {}),
    source: "projects.json",
    updated: today,
  };

  const parts = parseRepoLink(item.link);
  if (!parts) return { entry: base, note: "link is not a github.com repo URL" };

  const meta = mustBeAnswer(await gh(`/repos/${parts.owner}/${parts.repo}`));
  if (!meta.ok) return { entry: base, unreadable: true, note: `repo not readable (HTTP ${meta.status}); kept projects.json text` };
  const info = await meta.json();
  base.repo = info.name || base.repo;
  base.link = info.html_url || base.link;
  base.source = "github";

  const readme = mustBeAnswer(await gh(`/repos/${parts.owner}/${parts.repo}/readme`, "application/vnd.github.raw+json"));
  if (!readme.ok) return { entry: base, note: `no README (HTTP ${readme.status})` };
  const excerpt = cleanReadme(await readme.text());
  if (excerpt) base.highlights = excerpt;
  return { entry: base, note: excerpt ? "ok" : "README had no usable text" };
}

/**
 * @returns {Promise<0|1|2>} 0 = done / no drift, 1 = drift found (--check), 2 = GitHub could not be read
 *   (nothing is compared or written). Paths and output are injectable for tests.
 */
async function main({ check = false, dry = false, kbPath = kbLib.KB_PATH, projectsPath = PROJECTS_JSON, log = console.log, error = console.error } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const projects = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  const items = (projects.items || [])
    .filter((p) => p && p.repo && p.title && p.featured !== false)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  const entries = [];
  const failed = [];
  const unreadable = [];
  for (const item of items) {
    let result;
    try {
      result = await readProject(item, today);
    } catch (err) {
      result = { entry: null, note: `error: ${err.message}` };
      failed.push(item.title);
    }
    log(`${item.repo.padEnd(48)} ${result.note}`);
    if (result.entry) entries.push(result.entry);
    if (result.unreadable) unreadable.push(item);
  }
  if (failed.length) {
    error(`\nCould not read ${failed.length} project${failed.length === 1 ? "" : "s"} (${failed.join(", ")}). Nothing was ${check ? "compared" : "written"}; try again later.`);
    return 2;
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
  if (check) {
    // Not a failure (a repository can be private on purpose), but visitors would see a broken link.
    unreadable.forEach((p) => log(`NOTE: the link for "${p.title}" (${p.link}) is not readable by the public; visitors may get a "not found" page.`));
    const diff = projectDiff(kb.projects, entries);
    if (!diff.length) {
      log("\nkb.json's projects match GitHub and the site's cards.");
      return 0;
    }
    diff.forEach((d) => error(`DRIFT: ${d}`));
    error("\nRun: npm run kb:sync");
    return 1;
  }
  kb.projects = entries;
  kb.updated = today;
  kbLib.validate(kb);

  if (dry) {
    log(`\n--dry: would write ${entries.length} projects`);
    return 0;
  }
  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2) + "\n");
  log(`\nWrote ${entries.length} projects to kb/kb.json`);
  return 0;
}

if (require.main === module) {
  const flags = new Set(process.argv.slice(2));
  main({ check: flags.has("--check"), dry: flags.has("--dry") }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { main };
