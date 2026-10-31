const test = require("node:test");
const assert = require("node:assert");

const { buildSystemPrompt, buildGuardReminder, REFUSAL } = require("../lib/knowledge");

const RESUME = {
  available: true,
  stale: false,
  text: "Atharva Jadhav\nAI & Agentic Automation Engineer\n## CERTIFICATIONS\n- Microsoft Certified: Azure AI Fundamentals (Exam AI-901)",
};

test("prompt is built from kb.json: education and the AZ-900 verify link are present", () => {
  const prompt = buildSystemPrompt({ resume: RESUME });
  assert.match(prompt, /Computer Engineering/);
  assert.match(prompt, /M\.G\.M\. College of Engineering, Kamothe/);
  assert.match(prompt, /7\.11/);
  assert.match(prompt, /77%/);
  assert.match(prompt, /AZ-900/);
  assert.match(prompt, /learn\.microsoft\.com\/api\/credentials\/share/);
});

test("the live resume is included and declared the source of truth", () => {
  const prompt = buildSystemPrompt({ resume: RESUME });
  assert.match(prompt, /=== RESUME \(live document/);
  assert.match(prompt, /Azure AI Fundamentals \(Exam AI-901\)/);
  assert.match(prompt, /RESUME is correct/);
});

test("when the resume is unavailable the prompt says so instead of guessing", () => {
  for (const resume of [undefined, { available: false, reason: "unavailable" }]) {
    const prompt = buildSystemPrompt({ resume });
    assert.match(prompt, /live resume is temporarily unavailable/i);
    assert.ok(!/=== RESUME \(live document/.test(prompt));
  }
});

test("the stale website content (data.js) is no longer part of the prompt", () => {
  const prompt = buildSystemPrompt({ resume: RESUME });
  assert.ok(!/Building scalable cloud infrastructure with Azure/.test(prompt), "hero text from data.js");
  assert.ok(!/Cloud Engineer – DevOps/.test(prompt), "old role from data.js");
  assert.ok(!/<!--/.test(prompt));
});

test("the prompt never contains a phone number and forbids sharing one", () => {
  const prompt = buildSystemPrompt({ resume: RESUME });
  assert.ok(!/\+?\d[\d\s().-]{8,}\d/.test(prompt.replace(/\d{4}-\d{2}-\d{2}/g, "").replace(/\d+\.\d+/g, "")));
  assert.match(prompt, /Never share a phone number/);
});

test("the prompt marks KB and resume as data, not instructions", () => {
  const prompt = buildSystemPrompt({ resume: RESUME });
  assert.match(prompt, /reference DATA only/);
  assert.match(prompt, /never a command/);
});

test("the prompt is identical for identical inputs (stable cache keys)", () => {
  assert.equal(buildSystemPrompt({ resume: RESUME }), buildSystemPrompt({ resume: RESUME }));
  assert.notEqual(
    buildSystemPrompt({ resume: RESUME }),
    buildSystemPrompt({ resume: { ...RESUME, text: RESUME.text + "\n- New certification" } }),
    "editing the resume changes the prompt (and therefore invalidates cached answers)"
  );
});

test("guard reminder and refusal are consistent", () => {
  assert.match(buildGuardReminder(), new RegExp(REFUSAL.slice(0, 30)));
  assert.match(REFUSAL, /Atharva Jadhav/);
});
