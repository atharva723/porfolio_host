#!/usr/bin/env node
/* Check that the environment is ready to deploy.
   Usage:  npm run check:env              static checks (env vars + kb.json)
           npm run check:env -- --live    also test the real services: model list,
                                          Redis, the resume doc, the PDF export
   Reads .env locally. Secrets are never printed. Exit code 1 if anything FAILED. */

try {
  require("dotenv").config();
} catch {
  /* dotenv is optional */
}
const { staticChecks, liveChecks, exitCode } = require("../lib/env-check");

const TAGS = { ok: "OK  ", warn: "WARN", fail: "FAIL", info: "    " };

(async () => {
  const live = process.argv.includes("--live");
  const rows = staticChecks();
  if (live) rows.push(...(await liveChecks()));

  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) console.log(`${TAGS[r.level]}  ${r.name.padEnd(width)}  ${r.detail}`);

  const count = (level) => rows.filter((r) => r.level === level).length;
  console.log(`\n${count("ok")} ok, ${count("warn")} warning(s), ${count("fail")} failure(s)${live ? "" : "  (add -- --live to test the real services)"}`);
  if (count("fail")) console.log("Fix the FAIL lines before deploying.");
  process.exit(exitCode(rows));
})().catch((err) => {
  console.error("check failed:", err.message);
  process.exit(1);
});
