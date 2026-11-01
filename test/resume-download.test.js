const test = require("node:test");
const assert = require("node:assert");

// Force in-memory fallbacks and a clean environment regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.RESUME_DOC_URL = "";
process.env.RESUME_PDF_DOC_URL = "";

const dl = require("../lib/sources/resume-download");
const tools = require("../lib/tools");
const app = require("../server");

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const DOC = `https://docs.google.com/document/d/${ID}/edit?usp=sharing`;
const EXPORT = `https://docs.google.com/document/d/${ID}/export?format=pdf`;
const SITE_LINK = "https://atharva-host.vercel.app/resume.pdf";

test.beforeEach(() => {
  process.env.RESUME_PDF_DOC_URL = "";
});
test.after(() => {
  process.env.RESUME_PDF_DOC_URL = "";
});

/* ---- link parsing ---- */
test("parseDocLink accepts normal share links and a bare id", () => {
  const ok = [
    DOC,
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com/document/d/${ID}/view`,
    `https://docs.google.com/document/d/${ID}`,
    `https://docs.google.com/document/d/${ID}/`,
    `https://docs.google.com/document/u/0/d/${ID}/edit?tab=t.0#heading=h.x`,
    `  ${DOC}  `,
    ID,
  ];
  for (const raw of ok) assert.equal(dl.parseDocLink(raw), ID, raw);
});

test("parseDocLink rejects the publish-to-web form, other hosts and anything unusual", () => {
  const bad = [
    "",
    undefined,
    null,
    42,
    "not a url",
    "https://docs.google.com/document/d/e/2PACX-1vRNiKCkjGj44iqXm2eOY50dA71KSGFpK6hUVaaY1MqPU3v1faUv7x35oeZyVwxwG7cX-k8QkHJvWZ67/pub", // cannot be exported
    "2PACX-1vRNiKCkjGj44iqXm2eOY50dA71KSGFpK6hUVaaY1MqPU3v1faUv7x35oeZyVwxwG7cX", // bare publish id
    `http://docs.google.com/document/d/${ID}/edit`,
    `https://evil.example.com/document/d/${ID}/edit`,
    `https://docs.google.com.evil.example/document/d/${ID}/edit`,
    `https://user:pw@docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com:8443/document/d/${ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com/document/d/${ID}/edit/extra`,
    `https://docs.google.com/document/d/short/edit`,
    `https://drive.google.com/file/d/${ID}/view`,
    `javascript:alert(1)`,
    `https://169.254.169.254/latest/meta-data/`,
    "short-id",
    `${ID}/../../etc`,
    `${ID}?format=docx`,
  ];
  for (const raw of bad) assert.equal(dl.parseDocLink(raw), null, String(raw));
});

/* ---- export + stable link ---- */
test("exportUrl is rebuilt from the id alone: extra query or fragment from the input never carries over", () => {
  assert.equal(dl.exportUrl({ RESUME_PDF_DOC_URL: DOC }), EXPORT);
  assert.equal(dl.exportUrl({ RESUME_PDF_DOC_URL: `${DOC}&format=docx&x=https://evil.example.com#frag` }), EXPORT);
  assert.equal(dl.exportUrl({ RESUME_PDF_DOC_URL: ID }), EXPORT);
  assert.equal(dl.exportUrl({}), null);
  assert.equal(dl.exportUrl({ RESUME_PDF_DOC_URL: "https://evil.example.com/x" }), null);
});

test("downloadUrl is the stable link on the portfolio site, or null when not configured/invalid", () => {
  assert.equal(dl.downloadUrl("https://atharva-host.vercel.app/", { RESUME_PDF_DOC_URL: DOC }), SITE_LINK);
  assert.equal(dl.downloadUrl("https://atharva-host.vercel.app", { RESUME_PDF_DOC_URL: DOC }), SITE_LINK);
  assert.equal(dl.downloadUrl("https://atharva-host.vercel.app/", {}), null);
  assert.equal(dl.downloadUrl("https://atharva-host.vercel.app/", { RESUME_PDF_DOC_URL: "nonsense" }), null);
  assert.equal(dl.downloadUrl("", { RESUME_PDF_DOC_URL: DOC }), null, "no site to link to");
  assert.equal(dl.downloadUrl(undefined, { RESUME_PDF_DOC_URL: DOC }), null);
});

/* ---- the tool ---- */
const ctx = () => ({ ...tools.defaultContext(), getResume: async () => ({ available: false }) });

test("the tool is registered, read-only, and described for the planner", () => {
  const t = tools.get("get_resume_download");
  assert.ok(t);
  assert.match(t.description, /download.*PDF/i);
  assert.ok(t.description.length <= 260);
  assert.equal(t.topic, "resume_download");
});

test("not configured: the tool says so honestly and offers NO link", async () => {
  const r = await tools.execute("get_resume_download", {}, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.data.available, false);
  assert.ok(!/https?:\/\//.test(r.text), "no link at all");
  assert.match(r.text, /not set up right now/);
  assert.match(r.text, /contacted directly/);
});

test("configured: the tool returns only the stable site link, never the Google URL or the doc id", async () => {
  process.env.RESUME_PDF_DOC_URL = DOC;
  const r = await tools.execute("get_resume_download", {}, ctx());
  assert.equal(r.data.available, true);
  assert.equal(r.data.download_pdf, SITE_LINK);
  assert.match(r.text, /download_pdf: https:\/\/atharva-host\.vercel\.app\/resume\.pdf/);
  assert.ok(!r.text.includes(ID), "the doc id never reaches the model");
  assert.ok(!/google/i.test(r.text), "nor the Google host");
  assert.equal(r.label, "Resume download");
});

test("an invalid configuration behaves like 'not configured'", async () => {
  process.env.RESUME_PDF_DOC_URL = "https://docs.google.com/document/d/e/2PACX-publishformcannotbeexported12345/pub";
  assert.equal((await tools.execute("get_resume_download", {}, ctx())).data.available, false);
});

/* ---- follow-up chip ---- */
test("the 'download his resume' chip appears only when a download is configured", () => {
  const without = tools.suggest([], 5).map((s) => s.text);
  assert.ok(!without.includes("Can I download his resume?"));

  process.env.RESUME_PDF_DOC_URL = DOC;
  const withIt = tools.suggest([], 5).map((s) => s.text);
  assert.deepEqual(withIt.slice(0, 3), ["What is his current role?", "Which certifications does he hold?", "Can I download his resume?"]);
  assert.ok(!tools.suggest(["resume_download"], 5).some((s) => s.topic === "resume_download"), "not repeated once covered");
});

/* ---- the /resume.pdf route ---- */
let server;
let base;
let ip = 0;
const nextIp = () => `10.2.0.${++ip}`;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const get = (path = "/resume.pdf", { method = "GET", ipAddr = nextIp() } = {}) =>
  fetch(base + path, { method, redirect: "manual", headers: { "X-Forwarded-For": ipAddr } });

test("route: not configured -> 404 with a plain message and no redirect", async () => {
  const res = await get();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("location"), null);
  assert.match(await res.text(), /not available/i);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("route: configured -> 302 straight to Google's PDF export of that document", async () => {
  process.env.RESUME_PDF_DOC_URL = DOC;
  const res = await get();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), EXPORT);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("route: HEAD requests behave the same", async () => {
  process.env.RESUME_PDF_DOC_URL = DOC;
  const res = await get("/resume.pdf", { method: "HEAD" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), EXPORT);
});

test("route: NOT an open redirect — nothing in the request can change the target", async () => {
  process.env.RESUME_PDF_DOC_URL = DOC;
  for (const path of ["/resume.pdf?url=https://evil.example.com", "/resume.pdf?next=//evil.example.com&redirect=http://evil.example.com", "/resume.pdf?format=docx&id=other"]) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), EXPORT, path);
  }
});

test("route: a malicious or malformed environment value never redirects anywhere", async () => {
  for (const bad of ["https://evil.example.com/document/d/" + ID, "javascript:alert(1)", "//evil.example.com", "2PACX-publishformcannotbeexported12345678"]) {
    process.env.RESUME_PDF_DOC_URL = bad;
    const res = await get();
    assert.equal(res.status, 404, bad);
    assert.equal(res.headers.get("location"), null, bad);
  }
});

test("route: rate limited per IP with Retry-After", async () => {
  process.env.RESUME_PDF_DOC_URL = DOC;
  const who = nextIp();
  let last;
  for (let i = 0; i < 21; i++) last = await get("/resume.pdf", { ipAddr: who });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.match(await last.text(), /Too many requests/);
  assert.equal((await get("/resume.pdf", { ipAddr: nextIp() })).status, 302, "other visitors are unaffected");
});
