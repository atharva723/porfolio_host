const test = require("node:test");
const assert = require("node:assert");

const { checkGrounding } = require("../lib/grounding");

const EVIDENCE = `Name: Atharva Jadhav
Contact: email atharvajadhav968@gmail.com; GitHub https://github.com/atharva723; LinkedIn https://www.linkedin.com/in/atharva-jadhav-b122102b3/
- B.E. Computer Engineering — studied 2021–2025; graduated 2025; 7.11 CGPA overall, 8.21 CGPA in the final semester
- HSC — 77% in the HSC board exams
- Microsoft Certified: Azure Fundamentals (AZ-900) — earned Aug 2026
    Verify: https://learn.microsoft.com/api/credentials/share/en-us/u/4643C462FF5233C9?sharingId=454FAFEA6CCB7145`;

const check = (answer) => checkGrounding(answer, EVIDENCE);

test("answers whose links, e-mails, numbers and years are all in the sources pass", () => {
  const r = check(
    "He graduated in 2025 with a 7.11 CGPA (8.21 in the final semester) and scored 77% in the HSC. Email atharvajadhav968@gmail.com or see https://github.com/atharva723."
  );
  assert.deepEqual(r, { ok: true, problems: [], details: [] });
});

test("an invented link is caught, and trailing punctuation does not cause false alarms", () => {
  assert.deepEqual(check("See https://github.com/atharva723.").problems, []);
  assert.deepEqual(check("See https://github.com/atharva723/secret-repo for more.").problems, ["link"]);
  assert.deepEqual(check("Try https://evil.example.com/login").problems, ["link"]);
});

test("a long verify link is accepted only when it is exact", () => {
  const good = "Verify: https://learn.microsoft.com/api/credentials/share/en-us/u/4643C462FF5233C9?sharingId=454FAFEA6CCB7145";
  assert.equal(check(good).ok, true);
  assert.deepEqual(check(good.replace("4643C462FF5233C9", "0000000000000000")).problems, ["link"]);
});

test("an invented or altered e-mail address is caught", () => {
  assert.deepEqual(check("Write to atharva.jadhav968@gmail.com").problems, ["email"]);
  assert.equal(check("Write to ATHARVAJADHAV968@gmail.com").ok, true, "case-insensitive");
});

test("phone-like numbers are never allowed", () => {
  assert.deepEqual(check("Call +91 98765 43210").problems, ["phone"]);
  assert.deepEqual(check("His number is 9876543210.").problems, ["phone"]);
});

test("invented decimals, percentages and years are caught", () => {
  assert.deepEqual(check("He scored 9.1 CGPA").problems, ["number"]);
  assert.deepEqual(check("He scored 91% in the HSC").problems, ["number"]);
  assert.deepEqual(check("He joined in 2019").problems, ["number"]);
  assert.equal(check("He scored 77 % in the HSC").ok, true, "spacing before % is normalised");
});

test("typographic dashes and non-breaking hyphens do not cause false alarms", () => {
  assert.equal(check("He studied 2021\u20132025 and holds AZ\u2011900.").ok, true);
});

test("digits inside links are not double-checked as numbers", () => {
  assert.equal(check("Profile: https://www.linkedin.com/in/atharva-jadhav-b122102b3/").ok, true);
});

test("problems are reported as categories only (never echoing the offending text)", () => {
  const r = check("Visit https://evil.example.com and email x@evil.example.com, scored 99.9%");
  assert.deepEqual(r.problems.sort(), ["email", "link", "number"]);
  assert.ok(!JSON.stringify(r.problems).includes("evil"));
});

test("empty answers and null input are handled", () => {
  assert.equal(check("").ok, true);
  assert.equal(checkGrounding(null, EVIDENCE).ok, true);
  assert.equal(checkGrounding("2019", "").ok, false);
});
