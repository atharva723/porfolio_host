const test = require("node:test");
const assert = require("node:assert");

const { buildSystemPrompt } = require("../lib/knowledge");

const prompt = buildSystemPrompt();

test("knowledge base includes education details", () => {
  assert.match(prompt, /Computer Engineering/);
  assert.match(prompt, /M\.G\.M\. College of Engineering, Kamothe/);
  assert.match(prompt, /7\.11/);
  assert.match(prompt, /8\.21/);
  assert.match(prompt, /77%/);
  assert.match(prompt, /P\.E\. Society's High School/);
});

test("knowledge base includes certifications with the verify link", () => {
  assert.match(prompt, /AZ-900/);
  assert.match(prompt, /Azure Fundamentals/);
  assert.match(prompt, /learn\.microsoft\.com\/api\/credentials\/share/);
});

test("HTML comments in knowledge.md do not leak into the prompt", () => {
  assert.ok(!/<!--/.test(prompt));
  assert.ok(!/TIP: Add Q&A/.test(prompt));
});
