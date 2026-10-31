#!/usr/bin/env node
/* Check kb/kb.json for staleness and drift from the live resume.
   Usage: npm run kb:check   (exit code 1 only if kb.json is invalid) */

try {
  require("dotenv").config();
} catch {
  /* dotenv is optional */
}
const kbLib = require("../lib/kb");
const resume = require("../lib/sources/resume");
const { checkKb } = require("../lib/kb-check");

(async () => {
  let kb;
  try {
    kb = kbLib.load();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const r = await resume.get();
  const findings = checkKb({ kb, resumeText: r.available ? r.text : "" });
  console.log(`kb.json valid (version ${kbLib.version(kb)}, updated ${kb.updated}); resume ${r.available ? (r.stale ? "STALE copy" : "live") : "unavailable"}`);
  if (!findings.length) return console.log("No drift found.");
  findings.forEach((f) => console.log(`${f.level === "warn" ? "WARN" : "info"}: ${f.message}`));
})();
