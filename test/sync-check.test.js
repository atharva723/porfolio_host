const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const kbLib = require("../lib/kb");
const { main } = require("../scripts/sync-kb-projects");

/* A throw-away kb.json and projects.json, and a fake GitHub: nothing here touches the network or the real files. */

const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
});

const CARD = { repo: "alpha", order: 1, featured: true, title: "Alpha", description: "Alpha does a thing.", icon: "fas fa-code", tech: ["JavaScript"], link: "https://github.com/me/alpha" };
const ENTRY = { id: "proj-alpha", repo: "alpha", title: "Alpha", description: "Alpha does a thing.", tech: ["JavaScript"], link: "https://github.com/me/alpha", source: "github", updated: "2026-01-01", highlights: "old README text" };

function workspace({ cards = [CARD], entries = [ENTRY] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sync-"));
  const kbPath = path.join(dir, "kb.json");
  const projectsPath = path.join(dir, "projects.json");
  const kb = JSON.parse(fs.readFileSync(kbLib.KB_PATH, "utf8"));
  kb.projects = entries;
  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
  fs.writeFileSync(projectsPath, JSON.stringify({ items: cards }));
  return { dir, kbPath, projectsPath, before: fs.readFileSync(kbPath, "utf8") };
}

/** A fake GitHub. `answers` maps "repo" or "repo/readme" to a status or a handler. */
function fakeGitHub(answers = {}) {
  const asked = [];
  global.fetch = async (url) => {
    const m = /\/repos\/([^/]+)\/([^/]+)(\/readme)?$/.exec(url);
    const key = `${m[2]}${m[3] ? "/readme" : ""}`;
    asked.push(key);
    const answer = key in answers ? answers[key] : 200;
    if (typeof answer === "function") return answer(m);
    if (answer !== 200) return new Response("nope", { status: answer });
    if (m[3]) return new Response("# Alpha\n\nA readable README paragraph that is long enough to be kept as an excerpt for the project.", { status: 200 });
    return new Response(JSON.stringify({ name: m[2], html_url: `https://github.com/${m[1]}/${m[2]}` }), { status: 200 });
  };
  return asked;
}

const run = async (ws, options) => {
  const out = [];
  const err = [];
  const code = await main({ kbPath: ws.kbPath, projectsPath: ws.projectsPath, log: (s) => out.push(s), error: (s) => err.push(s), ...options });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("--check: kb.json that matches GitHub and the cards exits 0 and writes nothing", async () => {
  const ws = workspace();
  fakeGitHub();
  const r = await run(ws, { check: true });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /match GitHub/);
  assert.equal(fs.readFileSync(ws.kbPath, "utf8"), ws.before, "a check never writes");
});

test("--check: a repository renamed on GitHub is drift, exit 1, with the old and new address", async () => {
  const ws = workspace();
  fakeGitHub({ alpha: ({}) => new Response(JSON.stringify({ name: "alpha-v2", html_url: "https://github.com/me/alpha-v2" }), { status: 200 }) });
  const r = await run(ws, { check: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /DRIFT: "Alpha" changed: repo, link https:\/\/github\.com\/me\/alpha -> https:\/\/github\.com\/me\/alpha-v2/);
  assert.match(r.err, /npm run kb:sync/);
  assert.equal(fs.readFileSync(ws.kbPath, "utf8"), ws.before);
});

test("--check: a card that kb.json does not have yet, and one that was removed, are drift", async () => {
  const added = workspace({ cards: [CARD, { ...CARD, repo: "beta", order: 2, title: "Beta", link: "https://github.com/me/beta" }] });
  fakeGitHub();
  const a = await run(added, { check: true });
  assert.equal(a.code, 1);
  assert.match(a.err, /new project "Beta"/);

  const removed = workspace({ cards: [], entries: [ENTRY] });
  fakeGitHub();
  const b = await run(removed, { check: true });
  assert.equal(b.code, 1);
  assert.match(b.err, /"Alpha" is no longer on the site's cards/);
});

test("a rate limit or a server error stops the run with exit 2: on the repository call AND on the README call", async () => {
  for (const [label, answers] of [
    ["repo 403", { alpha: 403 }],
    ["repo 429", { alpha: 429 }],
    ["repo 503", { alpha: 503 }],
    ["README 403", { "alpha/readme": 403 }],
    ["README 429", { "alpha/readme": 429 }],
    ["README 502", { "alpha/readme": 502 }],
  ]) {
    const ws = workspace();
    fakeGitHub(answers);
    const r = await run(ws, { check: true });
    assert.equal(r.code, 2, `${label}: ${r.out}${r.err}`);
    assert.match(r.err, /Could not read 1 project.*Nothing was compared/, label);
    assert.ok(!/DRIFT/.test(r.err), `${label}: a failed read is never reported as drift`);
  }
});

test("a network failure also stops the run with exit 2", async () => {
  const ws = workspace();
  global.fetch = async () => {
    throw new Error("connect ETIMEDOUT");
  };
  const r = await run(ws, { check: true });
  assert.equal(r.code, 2);
});

test("a repository the public cannot read (404) is a note, not a failure; its card text is kept", async () => {
  const ws = workspace({ entries: [{ ...ENTRY, source: "projects.json", highlights: undefined }] });
  fakeGitHub({ alpha: 404 });
  const r = await run(ws, { check: true });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /NOTE: the link for "Alpha" \(https:\/\/github\.com\/me\/alpha\) is not readable by the public/);
});

test("a missing README (404) is fine: the project keeps no excerpt", async () => {
  const ws = workspace();
  fakeGitHub({ "alpha/readme": 404 });
  const r = await run(ws, { check: true });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /no README \(HTTP 404\)/);
});

test("writing: a clean run replaces the projects and keeps every other section", async () => {
  const ws = workspace({ entries: [{ ...ENTRY, title: "Old title", id: "proj-old" }] });
  fakeGitHub();
  const r = await run(ws);
  assert.equal(r.code, 0, r.out + r.err);
  const written = JSON.parse(fs.readFileSync(ws.kbPath, "utf8"));
  assert.deepEqual(written.projects.map((p) => p.title), ["Alpha"]);
  assert.match(written.projects[0].highlights, /readable README paragraph/);
  assert.equal(written.profile.email, JSON.parse(ws.before).profile.email, "other sections are untouched");
});

test("writing: when GitHub could not be read, nothing is written (no project is wiped or dropped)", async () => {
  const ws = workspace();
  fakeGitHub({ "alpha/readme": 403 });
  const r = await run(ws);
  assert.equal(r.code, 2);
  assert.match(r.err, /Nothing was written/);
  assert.equal(fs.readFileSync(ws.kbPath, "utf8"), ws.before, "the file is exactly as it was");
});

test("--dry: reports what would be written and writes nothing", async () => {
  const ws = workspace({ entries: [{ ...ENTRY, title: "Old title", id: "proj-old" }] });
  fakeGitHub();
  const r = await run(ws, { dry: true });
  assert.equal(r.code, 0);
  assert.match(r.out, /--dry: would write 1 projects/);
  assert.equal(fs.readFileSync(ws.kbPath, "utf8"), ws.before);
});
