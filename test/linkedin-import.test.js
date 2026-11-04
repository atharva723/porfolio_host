const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseCsv, parseCsvObjects } = require("../lib/csv");
const { readExport, mergeIntoKb, cleanUrl } = require("../lib/linkedin-import");
const { checkKb, resumeCertifications } = require("../lib/kb-check");
const kbLib = require("../lib/kb");
const config = require("../scripts/linkedin.config.json");

/* ---- CSV parser ---- */
test("parseCsv handles quotes, escaped quotes, commas, newlines, CRLF and a BOM", () => {
  const text = '\uFEFFName,Note\r\n"Smith, Jo","says ""hi"""\r\n"multi\nline",x\r\n';
  assert.deepEqual(parseCsv(text), [
    ["Name", "Note"],
    ["Smith, Jo", 'says "hi"'],
    ["multi\nline", "x"],
  ]);
});

test("parseCsvObjects keys rows by header, skips blank rows, fills missing cells", () => {
  const rows = parseCsvObjects("A,B,C\n1,2\n\n3,4,5\n");
  assert.deepEqual(rows, [
    { A: "1", B: "2", C: "" },
    { A: "3", B: "4", C: "5" },
  ]);
  assert.deepEqual(parseCsvObjects("Only header\n\n"), [], "header-only file");
  assert.deepEqual(parseCsvObjects(""), []);
});

test("parseCsv rejects an unterminated quoted field instead of swallowing the file", () => {
  assert.throws(() => parseCsv('a,b\n"oops,1\n'), /unterminated/);
});

/* ---- export fixture ---- */
const FIXTURE = {
  "Profile.csv":
    "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n" +
    'Atharva,Jadhav,,"SECRET-ADDRESS",1999-01-01,"Cloud & AI Engineer | Azure",,Artificial Intelligence,400706,"Navi Mumbai, Maharashtra, India",,,\n',
  "Positions.csv":
    "Company Name,Title,Description,Location,Started On,Finished On\n" +
    'LTM,Engineer - Cloud & Infra,"Built agents.\nCall +91 98765 43210 for details.",India,Jan 2026,\n',
  "Education.csv": "School Name,Start Date,End Date,Notes,Degree Name,Activities\nMgm College,2021,2025,,Bachelor of Engineering ,\n",
  "Skills.csv": "Name\nTerraform\nazure \nAzure\nPython\n",
  "Certifications.csv":
    "Name,Url,Authority,Started On,Finished On,License Number\n" +
    "Tata Group - Data Visualisation Job Simulation,https://forage.example/x.pdf,Forage,Jul 2024,,KFk\n" +
    "Microsoft Certified: Azure Fundamentals,https://learn.microsoft.com/api/credentials/share/en-us/u/4643C462FF5233C9?sharingId,Microsoft,Aug 2026,,4643C462FF5233C9\n" +
    "Microsoft Certified: Azure AI Fundamentals,https://learn.microsoft.com/api/credentials/share/en-us/u/493ADEA057BE4512?sharingId,Microsoft,Oct 2026,,493ADEA057BE4512\n" +
    "Claude Certified Associate - Foundations,https://www.credly.com/badges/abc/linked_in_profile,Anthropic,Oct 2026,Oct 2027,\n",
  // Must never be read:
  "Connections.csv": "First Name,Last Name,Email Address\nPOISON-CONNECTION,Person,poison@example.com\n",
  "PhoneNumbers.csv": "Extension,Number,Type\n,+91 99999 88888,Mobile\n",
  "Email Addresses.csv": "Email Address\nprivate@example.com\n",
  "Invitations.csv": "From,Message\nPOISON-INVITE,hi\n",
};

function makeExport(files = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "li-export-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

// The KB as it was BEFORE the first import: only the hand-written AZ-900, no LinkedIn snapshot.
const baseKb = () => {
  const kb = JSON.parse(JSON.stringify(kbLib.load()));
  kb.credentials = kb.credentials.filter((c) => c.code === "AZ-900");
  kb.linkedin = null;
  return kb;
};
const TODAY = "2026-11-02";

test("readExport opens only the five allow-listed files", () => {
  const dir = makeExport();
  const opened = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    opened.push(path.basename(String(p)));
    return realRead.call(this, p, ...rest);
  };
  try {
    readExport(dir);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.deepEqual(opened.sort(), ["Certifications.csv", "Education.csv", "Positions.csv", "Profile.csv", "Skills.csv"]);
});

test("readExport errors clearly for a missing folder, a file, or an unrelated folder", () => {
  assert.throws(() => readExport(path.join(os.tmpdir(), "does-not-exist-xyz")), /Extract the LinkedIn export zip/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "li-empty-"));
  assert.throws(() => readExport(empty), /None of the expected LinkedIn files/);
});

test("import produces a clean snapshot and never leaks private columns or files", () => {
  const { raw } = readExport(makeExport());
  const { kb } = mergeIntoKb(baseKb(), raw, config, TODAY);
  const json = JSON.stringify(kb);

  assert.equal(kb.linkedin.headline, "Cloud & AI Engineer | Azure");
  assert.equal(kb.linkedin.location, "Navi Mumbai, Maharashtra, India");
  assert.equal(kb.linkedin.asOf, TODAY);
  assert.equal(kb.linkedin.positions[0].company, "LTIMindtree", "company alias from config");
  assert.equal(kb.linkedin.positions[0].finished, null);
  assert.deepEqual(kb.linkedin.skills, ["Terraform", "azure", "Python"], "trimmed and de-duplicated case-insensitively");

  for (const secret of ["SECRET-ADDRESS", "400706", "1999-01-01", "POISON", "poison@example.com", "private@example.com", "99999", "98765 43210"]) {
    assert.ok(!json.includes(secret), `"${secret}" must not appear in the KB`);
  }
  assert.match(kb.linkedin.positions[0].description, /\[phone number withheld\]/);
  assert.doesNotThrow(() => kbLib.validate(kb), "merged KB stays valid");
});

test("an import never touches the website-facing sections, and keeps hand-set credential icons", () => {
  const before = JSON.parse(JSON.stringify(kbLib.load()));
  const { raw } = readExport(makeExport());
  const { kb } = mergeIntoKb(JSON.parse(JSON.stringify(before)), raw, config, TODAY);

  for (const section of ["about", "experience", "skills", "education", "facts", "projects"]) {
    assert.deepEqual(kb[section], before[section], `${section} is untouched by the import`);
  }
  assert.equal(kb.profile.tagline, before.profile.tagline);
  for (const c of before.credentials.filter((x) => kb.credentials.some((n) => n.id === x.id))) {
    assert.equal(kb.credentials.find((n) => n.id === c.id).icon, c.icon, `${c.code || c.title} keeps its icon`);
  }
  assert.doesNotThrow(() => kbLib.validate(kb));
});

test("a credential added by an import has no icon and is still valid (the site falls back to a default)", () => {
  const { raw } = readExport(makeExport());
  const { kb } = mergeIntoKb(baseKb(), raw, config, TODAY);
  const added = kb.credentials.find((c) => c.code === "AI-901");
  assert.ok(added && added.icon === undefined);
  assert.doesNotThrow(() => kbLib.validate(kb));
});

test("credentials: excluded ones are dropped, codes come from config, new ones are added", () => {
  const { raw } = readExport(makeExport());
  const { kb, report } = mergeIntoKb(baseKb(), raw, config, TODAY);
  const titles = kb.credentials.map((c) => c.title);

  assert.ok(!titles.some((t) => /Tata|Forage/i.test(t)));
  assert.equal(report.credentials.excluded.length, 1);
  assert.deepEqual(report.credentials.added.sort(), ["Claude Certified Associate - Foundations", "Microsoft Certified: Azure AI Fundamentals"]);

  const ai901 = kb.credentials.find((c) => c.code === "AI-901");
  assert.equal(ai901.credentialId, "493ADEA057BE4512");
  assert.equal(ai901.verifyUrl, "https://learn.microsoft.com/api/credentials/share/en-us/u/493ADEA057BE4512", "truncated ?sharingId removed");
  const claude = kb.credentials.find((c) => c.code === "CCAO-F");
  assert.equal(claude.expires, "Oct 2027");
  assert.equal(claude.issuer, "Anthropic");
});

test("existing hand-set verify links and codes survive a re-import", () => {
  const { raw } = readExport(makeExport());
  const start = baseKb();
  const az = start.credentials.find((c) => c.code === "AZ-900");
  const { kb } = mergeIntoKb(start, raw, config, TODAY);
  const after = kb.credentials.find((c) => c.code === "AZ-900");
  assert.equal(after.verifyUrl, az.verifyUrl, "sharingId link kept");
  assert.equal(after.id, az.id);
});

test("importing twice is idempotent: no changes, dates untouched", () => {
  const { raw } = readExport(makeExport());
  const first = mergeIntoKb(baseKb(), raw, config, TODAY).kb;
  const second = mergeIntoKb(first, raw, config, "2027-01-01");
  assert.equal(second.report.linkedinChanged, false);
  assert.equal(second.report.credentials.added.length, 0);
  assert.equal(second.report.credentials.updated.length, 0);
  assert.deepEqual(second.kb, first, "nothing (including asOf/updated) changes on a no-op import");
});

test("credentials already in the KB but absent from the export are kept and reported", () => {
  const { raw } = readExport(makeExport({ ...FIXTURE, "Certifications.csv": "Name,Url,Authority,Started On,Finished On,License Number\n" }));
  const { kb, report } = mergeIntoKb(baseKb(), raw, config, TODAY);
  assert.ok(kb.credentials.some((c) => c.code === "AZ-900"));
  assert.ok(report.credentials.notInExport.includes("Microsoft Certified: Azure Fundamentals"));
});

test("the input KB object is not mutated", () => {
  const { raw } = readExport(makeExport());
  const start = baseKb();
  const before = JSON.stringify(start);
  mergeIntoKb(start, raw, config, TODAY);
  assert.equal(JSON.stringify(start), before);
});

test("cleanUrl keeps real tokens, drops empty sharingId, rejects non-http(s)", () => {
  assert.equal(cleanUrl("https://x.example/a?sharingId"), "https://x.example/a");
  assert.equal(cleanUrl("https://x.example/a?sharingId=ABC"), "https://x.example/a?sharingId=ABC");
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x/y", "not a url", "", null]) assert.equal(cleanUrl(bad), "", String(bad));
});

/* ---- committed KB after the real import ---- */
test("committed KB lists the four certifications, each with a verify link", () => {
  const codes = kbLib.load().credentials.map((c) => c.code).sort();
  assert.deepEqual(codes, ["AI-103", "AI-901", "AZ-900", "CCAO-F"]);
  for (const c of kbLib.load().credentials) assert.match(c.verifyUrl, /^https:\/\//, c.code);
  assert.ok(!kbLib.load().credentials.some((c) => /forage|tata/i.test(c.title)), "Forage simulation excluded");
});

test("KB text exposes the employment timeline and LinkedIn snapshot with its date", () => {
  const text = kbLib.toText();
  assert.match(text, /joined LTIMindtree full-time in January 2026/);
  assert.match(text, /April 2026/);
  assert.match(text, /LinkedIn profile snapshot \(as of \d{4}-\d{2}-\d{2}; the live resume wins/);
  assert.match(text, /Skills listed on LinkedIn:.*Terraform/);
  assert.match(text, /studied 2021–2025/);
  assert.match(text, /valid until Oct 2027/);
});

/* ---- drift check ---- */
const RESUME = `## CERTIFICATIONS
- Microsoft Certified: Azure Fundamentals (Exam AZ-900)
- Microsoft Certified: Azure AI Fundamentals (Exam AI-901)
- Microsoft Certified: Azure AI Apps and Agents Developer Associate (Exam AI-103)
- Claude Certified Associate – Foundations (CCAO-F)

## ADDITIONAL TECHNICAL STACK
Docker`;

test("resumeCertifications reads only the certifications section", () => {
  assert.equal(resumeCertifications(RESUME).length, 4);
  assert.deepEqual(resumeCertifications("no such section"), []);
});

test("checkKb finds no drift when the KB matches the resume", () => {
  const now = Date.parse(kbLib.load().linkedin.asOf) + 5 * 86400000;
  const findings = checkKb({ kb: kbLib.load(), resumeText: RESUME, now });
  assert.deepEqual(findings.filter((f) => f.level === "warn"), []);
});

test("checkKb warns about a resume certification missing from the KB, and the reverse", () => {
  const now = Date.parse(kbLib.load().linkedin.asOf) + 5 * 86400000;
  const added = checkKb({ kb: kbLib.load(), resumeText: RESUME.replace("\n\n## ADDITIONAL", "\n- Brand New Cert (Exam XX-100)\n\n## ADDITIONAL"), now });
  assert.ok(added.some((f) => f.level === "warn" && /Brand New Cert/.test(f.message)));

  const trimmed = RESUME.replace(/- Claude.*\n/, "");
  const removed = checkKb({ kb: kbLib.load(), resumeText: trimmed, now });
  assert.ok(removed.some((f) => f.level === "warn" && /Claude Certified Associate/.test(f.message) && /resume wins/i.test(f.message)));
});

test("checkKb flags a stale LinkedIn snapshot and tolerates a missing resume", () => {
  const kb = kbLib.load();
  const later = Date.parse(kb.linkedin.asOf) + 120 * 86400000;
  const findings = checkKb({ kb, resumeText: "", now: later });
  assert.ok(findings.some((f) => f.level === "warn" && /120 days old/.test(f.message)));
  assert.ok(findings.some((f) => /Live resume not checked/.test(f.message)));
  assert.ok(checkKb({ kb: { ...kb, linkedin: null }, resumeText: "", now: later }).some((f) => /No LinkedIn snapshot/.test(f.message)));
});
