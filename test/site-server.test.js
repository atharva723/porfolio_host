const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// A clean environment regardless of any local .env.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

const siteContent = require("../lib/site-content");
const kbLib = require("../lib/kb");
const app = require("../server");

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const get = (p, headers = {}) => fetch(base + p, { redirect: "manual", headers });
const inlined = (html) => JSON.parse(/<script id="site-content" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
// The month counter is the only time-dependent field; ignore it so a month boundary can't flake the test.
const stable = (c) => ({ ...c, metrics: { ...c.metrics, experienceMonths: 0 } });

test("GET / serves the page with the content inlined, never the raw template", async () => {
  const res = await get("/");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.ok(!html.includes("<!--SITE_CONTENT-->"), "placeholder is replaced");
  assert.match(html, /<title>Atharva Jadhav - AI &amp; Agentic Automation Engineer<\/title>/);
  assert.equal(inlined(html).profile.email, kbLib.load().profile.email);
});

test("/index.html is the same page, not the static file with an unfilled placeholder", async () => {
  const a = await (await get("/")).text();
  const b = await get("/index.html");
  assert.equal(b.status, 200);
  const html = await b.text();
  assert.ok(!html.includes("<!--SITE_CONTENT-->"));
  assert.deepEqual(stable(inlined(html)), stable(inlined(a)));
});

test("GET /data/site.json is exactly the content the page renders from", async () => {
  const page = inlined(await (await get("/")).text());
  const res = await get("/data/site.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const json = await res.json();
  assert.deepEqual(stable(json), stable(page));
  assert.equal(json.version, kbLib.version(), "carries the KB version the assistant's cache is keyed on");
});

test("the content is revalidated cheaply: an unchanged page answers 304", async () => {
  const first = await get("/data/site.json");
  const etag = first.headers.get("etag");
  assert.ok(etag, "has an ETag");
  // Raw http: Node's fetch adds "Cache-Control: no-cache" to conditional requests, which defeats the check.
  const status = await new Promise((resolve, reject) => {
    http.get(base + "/data/site.json", { headers: { "If-None-Match": etag } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(status, 304);
});

test("security headers still apply to the dynamic page (CSP keeps scripts local)", async () => {
  const csp = (await get("/")).headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "the inlined JSON needs no inline-script allowance");
  assert.equal((await get("/data/site.json")).headers.get("x-content-type-options"), "nosniff");
});

test("the n8n-managed projects file and the page scripts are still served statically", async () => {
  assert.equal((await get("/data/projects.json")).status, 200);
  for (const file of ["render.js", "layout.js", "util.js", "script.js", "chat.js", "config.js"]) {
    assert.equal((await get(`/js/${file}`)).status, 200, file);
  }
  assert.equal((await get("/js/data.js")).status, 404, "the old hard-coded content file is gone");
});

test("if the KB cannot be loaded the page still opens (without data) and says nothing about why", async () => {
  const original = siteContent.build;
  const logged = [];
  const realError = console.error;
  console.error = (line) => logged.push(String(line));
  siteContent.build = () => {
    throw new Error("Invalid kb/kb.json: SECRET-DETAIL-FROM-THE-KB");
  };
  try {
    const page = await get("/");
    const html = await page.text();
    assert.equal(page.status, 200, "the shell, nav and chat button still load");
    assert.equal(page.headers.get("cache-control"), "no-store", "a degraded page is never cached");
    assert.ok(!html.includes('id="site-content"') && !html.includes("<!--SITE_CONTENT-->"), "no data block, no leftover placeholder");
    assert.ok(html.includes('id="contentUnavailable"'), "the notice element is in the page");

    const json = await get("/data/site.json");
    assert.equal(json.status, 503);
    assert.equal(json.headers.get("cache-control"), "no-store");
    assert.deepEqual(await json.json(), { error: "The site content is temporarily unavailable." });

    const log = logged.join("\n");
    assert.match(log, /"evt":"site_content_error"/);
    assert.ok(!log.includes("SECRET-DETAIL"), "the error message (which can quote the KB) is never logged");
    assert.ok(!html.includes("SECRET-DETAIL") && !JSON.stringify(logged).includes("SECRET-DETAIL"));
  } finally {
    siteContent.build = original;
    console.error = realError;
  }
  assert.equal((await get("/data/site.json")).status, 200, "and it recovers as soon as the KB loads again");
});

test("the served template always contains the placeholder and the notice (so the page can't ship without them)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "views", "index.html"), "utf8");
  assert.equal(html.split("<!--SITE_CONTENT-->").length - 1, 1, "exactly one placeholder");
  assert.ok(html.includes('id="contentUnavailable"'));
  assert.match(html, /<title>[^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]*">/);
});

test("the raw template is not under the static root, so no URL trick can serve it unprocessed", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "public", "index.html")), "public/index.html must not exist");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "views", "index.html")));
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const include = vercel.builds[0].config.includeFiles;
  assert.ok(include.includes("views/**") && include.includes("kb/**"), "the deployment bundles the template and the KB");
});

test("no path variant (extra slashes, %-encoding, casing, dot segments) returns the unprocessed template", async () => {
  const raw = (p) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: server.address().port, path: p }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .on("error", reject);
    });
  const variants = ["//index.html", "///index.html", "/%69ndex.html", "/INDEX.HTML", "/index.html/", "/./index.html", "/css/../index.html", "/../index.html", "/%2e%2e/views/index.html", "/views/index.html", "/public/index.html", "/index.html%00", "/%5cindex.html", "/index.html?x=1"];
  for (const p of variants) {
    const { status, body } = await raw(p);
    assert.ok(!body.includes("<!--SITE_CONTENT-->"), `${p}: no placeholder in the response`);
    assert.ok(!body.includes("<title>Portfolio</title>"), `${p}: not the raw template`);
    if (status === 200) assert.ok(body.includes('id="site-content"'), `${p}: a 200 is always the real page, with data`);
    else assert.ok([301, 302, 400, 404].includes(status), `${p}: other responses are redirects or errors, got ${status}`);
  }
});
