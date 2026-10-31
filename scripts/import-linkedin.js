#!/usr/bin/env node
/* =====================================================================
   Import a LinkedIn "Basic" data export into kb/kb.json.
   ---------------------------------------------------------------------
   1. LinkedIn -> Settings -> Data privacy -> Get a copy of your data ->
      "Download larger data archive" (Basic is enough). Extract the zip.
   2. npm run kb:linkedin -- "C:\path\to\extracted\folder"
      Add --dry to preview without writing.
   3. Review `git diff kb/kb.json`, then commit.

   Only Profile, Positions, Education, Skills and Certifications are read.
   Things to leave out / exam codes live in scripts/linkedin.config.json.
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const kbLib = require("../lib/kb");
const { readExport, mergeIntoKb } = require("../lib/linkedin-import");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dir = args.find((a) => !a.startsWith("--"));

function main() {
  if (!dir) {
    console.error('Usage: npm run kb:linkedin -- "<extracted export folder>" [--dry]');
    process.exit(2);
  }
  if (/\.zip$/i.test(dir) && fs.existsSync(dir) && fs.statSync(dir).isFile()) {
    console.error("That is a .zip file. Extract it first, then pass the extracted folder.");
    process.exit(2);
  }

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "linkedin.config.json"), "utf8"));
  const { raw, warnings } = readExport(dir);
  const current = JSON.parse(fs.readFileSync(kbLib.KB_PATH, "utf8"));
  const { kb, report } = mergeIntoKb(current, raw, config);
  kbLib.validate(kb);

  const li = kb.linkedin;
  const c = report.credentials;
  console.log(`LinkedIn snapshot: ${li.positions.length} position(s), ${li.education.length} education, ${li.skills.length} skills${report.linkedinChanged ? "" : " (unchanged)"}`);
  console.log(`Credentials: ${c.added.length} added, ${c.updated.length} updated, ${c.unchanged.length} unchanged`);
  c.added.forEach((t) => console.log(`  + ${t}`));
  c.updated.forEach((t) => console.log(`  ~ ${t}`));
  c.excluded.forEach((t) => console.log(`  - left out (scripts/linkedin.config.json): ${t}`));
  c.notInExport.forEach((t) => console.log(`  ! in kb.json but not in the export (kept): ${t}`));
  warnings.forEach((w) => console.log(`  warning: ${w}`));

  if (dry) return console.log("\n--dry: nothing written");
  fs.writeFileSync(kbLib.KB_PATH, JSON.stringify(kb, null, 2) + "\n");
  console.log("\nWrote kb/kb.json. Review with: git diff kb/kb.json");
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
