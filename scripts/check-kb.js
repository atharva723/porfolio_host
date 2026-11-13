#!/usr/bin/env node
/* Check kb/kb.json for staleness and for drift from the resume, LinkedIn and the project cards.

   Usage:  npm run kb:check                    report everything
           npm run kb:check -- --details       also show text from the resume (names, addresses)
           npm run kb:check -- --offline       skip the live resume (nothing is fetched)
           npm run kb:check -- --strict        exit 1 if a witness CONTRADICTS kb.json
           npm run kb:check -- --strict --stale  also exit 1 for old or lagging data
   Exit code 1 also means kb.json itself is invalid.

   On GitHub Actions every warning is also shown as an annotation. */

try {
  require("dotenv").config();
} catch {
  /* dotenv is optional */
}
const kbLib = require("../lib/kb");
const projects = require("../lib/projects");
const resume = require("../lib/sources/resume");
const { checkKb, report } = require("../lib/kb-check");

const args = new Set(process.argv.slice(2));

(async () => {
  let raw;
  try {
    raw = kbLib.loadRaw();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let resumeText = "";
  let resumeState = "not checked (--offline)";
  if (!args.has("--offline")) {
    const r = await resume.get();
    resumeText = r.available ? r.text : "";
    resumeState = r.available ? (r.stale ? "STALE copy" : "live") : "unavailable";
  }

  const cards = projects.load({ fallback: raw.projects });
  const findings = checkKb({ kb: raw, resumeText, cards });
  console.log(`kb.json valid (version ${kbLib.version(kbLib.load())}, updated ${raw.updated}); resume ${resumeState}`);

  const out = report(findings, {
    strict: args.has("--strict"),
    stale: args.has("--stale"),
    details: args.has("--details"),
    actions: process.env.GITHUB_ACTIONS === "true",
  });
  out.lines.forEach((l) => console.log(l));
  if (out.code) {
    console.error(`\n${out.failed.length} finding${out.failed.length === 1 ? "" : "s"} to fix (--strict).`);
    process.exit(out.code);
  }
})();
