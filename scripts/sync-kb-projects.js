#!/usr/bin/env node
/* =====================================================================
   Sync the "projects" section of kb/kb.json from GitHub.
   ---------------------------------------------------------------------
   Reads the repo list from public/data/projects.json, asks the GitHub API
   for each repo's current URL and README, and writes a clean excerpt into
   kb.json. Other sections (profile, education, facts, ...) are untouched.

   Usage:  npm run kb:sync            write kb/kb.json
           npm run kb:sync -- --dry   print what would change
   Env:    GITHUB_TOKEN  optional; raises the API rate limit.

   Repos that can't be read (private, renamed away, no README) keep the
   text from projects.json and are marked source "projects.json".
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const { cleanReadme, parseRepoLink, slug } = require("../lib/kb-build");
const kbLib = require("../lib/kb");

const PROJECTS_JSON = path.join(__dirname, "..", "public", "data", "projects.json");
const TIMEOUT_MS = 10000;
const dry = process.argv.includes("--dry");

async function gh(pathname, accept) {
  const headers = { "User-Agent": "portfolio-kb-sync", Accept: accept || "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res;
}

async function readProject(item, today) {
  const base = {
    id: `proj-${slug(item.repo)}`,
    repo: item.repo,
    title: item.title,
    description: item.description,
    tech: Array.isArray(item.tech) ? item.tech : [],
    link: item.link,
    source: "projects.json",
    updated: today,
  };

  const parts = parseRepoLink(item.link);
  if (!parts) return { entry: base, note: "link is not a github.com repo URL" };

  const meta = await gh(`/repos/${parts.owner}/${parts.repo}`);
  if (!meta.ok) return { entry: base, note: `repo not readable (HTTP ${meta.status}); kept projects.json text` };
  const info = await meta.json();
  base.repo = info.name || base.repo;
  base.link = info.html_url || base.link;
  base.source = "github";

  const readme = await gh(`/repos/${parts.owner}/${parts.repo}/readme`, "application/vnd.github.raw+json");
  if (!readme.ok) return { entry: base, note: `no README (HTTP ${readme.status})` };
  const excerpt = cleanReadme(await readme.text());
  if (excerpt) base.highlights = excerpt;
  return { entry: base, note: excerpt ? "ok" : "README had no usable text" };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, "utf8"));
  const items = (projects.items || [])
    .filter((p) => p && p.repo && p.title && p.featured !== false)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  const entries = [];
  for (const item of items) {
    let result;
    try {
      result = await readProject(item, today);
    } catch (err) {
      result = { entry: null, note: `error: ${err.message}` };
    }
    console.log(`${item.repo.padEnd(48)} ${result.note}`);
    if (result.entry) entries.push(result.entry);
  }

  const kb = JSON.parse(fs.readFileSync(kbLib.KB_PATH, "utf8"));
  kb.projects = entries;
  kb.updated = today;
  kbLib.validate(kb);

  if (dry) return console.log(`\n--dry: would write ${entries.length} projects`);
  fs.writeFileSync(kbLib.KB_PATH, JSON.stringify(kb, null, 2) + "\n");
  console.log(`\nWrote ${entries.length} projects to kb/kb.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
