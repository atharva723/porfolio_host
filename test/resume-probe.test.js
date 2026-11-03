const test = require("node:test");
const assert = require("node:assert");

// No Redis and no real URL: everything here is local.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.RESUME_DOC_URL = "";

const resume = require("../lib/sources/resume");
const { RESUME_TEXT, resumeHtml, FAKE_PUBLISH_URL } = require("./helpers/fixtures");

const html = () => new Response(resumeHtml(RESUME_TEXT), { status: 200, headers: { "content-type": "text/html" } });
const env = { RESUME_DOC_URL: FAKE_PUBLISH_URL };

test.beforeEach(() => resume._reset());
test.after(() => resume._reset());

test("probe returns the extracted document text (phone redacted) and caches nothing", async () => {
  let calls = 0;
  resume._setFetch(async () => {
    calls++;
    return html();
  });
  const r = await resume.probe(env);
  assert.equal(r.ok, true);
  assert.match(r.text, /Agentic Factory Operations/);
  assert.ok(!r.text.includes("90000"), "the phone number is redacted");

  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  try {
    await resume.get();
    assert.equal(calls, 2, "probe left no cached copy: get() had to download again");
  } finally {
    process.env.RESUME_DOC_URL = "";
  }
});

test("probe ignores a previously cached copy and reports what Google serves right now", async () => {
  process.env.RESUME_DOC_URL = FAKE_PUBLISH_URL;
  const warn = console.warn;
  console.warn = () => {};
  try {
    resume._setFetch(async () => html());
    assert.equal((await resume.get()).available, true, "cache is warm");
    resume._setFetch(async () => new Response("gone", { status: 404 }));
    assert.deepEqual(await resume.probe(env), { ok: false, reason: "HTTP 404" });
    const stale = await resume.get();
    assert.equal(stale.available, true, "the app's own cached copy is unaffected");
  } finally {
    console.warn = warn;
    process.env.RESUME_DOC_URL = "";
  }
});

test("probe reports a precise reason for each failure and never throws", async () => {
  const cases = [
    [() => new Response("x", { status: 500 }), /HTTP 500/],
    [() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), /content type/],
    [() => new Response('<div id="contents"><p>Atharva Jadhav</p></div>', { status: 200, headers: { "content-type": "text/html" } }), /empty/],
    [() => new Response(`<div id="contents"><p>${"Lorem ipsum dolor sit amet. ".repeat(20)}</p></div>`, { status: 200, headers: { "content-type": "text/html" } }), /does not look like the resume/],
  ];
  for (const [make, reason] of cases) {
    resume._setFetch(async () => make());
    const r = await resume.probe(env);
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  }
  resume._setFetch(async () => {
    throw new Error("network down");
  });
  assert.equal((await resume.probe(env)).ok, false);
});

test("probe refuses anything but a valid Publish-to-web link (no SSRF surface)", async () => {
  resume._setFetch(async () => assert.fail("must not fetch"));
  for (const bad of [undefined, "", "https://evil.example.com/x", "http://docs.google.com/document/d/e/2PACX-1vFixtureFixtureFixtureFixtureFixtureFixtureFixture12345/pub", "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/edit"]) {
    assert.deepEqual(await resume.probe({ RESUME_DOC_URL: bad }), { ok: false, reason: "not-configured" }, String(bad));
  }
});
