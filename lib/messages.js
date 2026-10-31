/* =====================================================================
   USER-FACING MESSAGES FOR NON-ANSWERS
   ---------------------------------------------------------------------
   Short, honest, non-accusatory. None of them reveal how the guard works
   or quote any instruction. They are fixed strings (no model call), so
   a blocked message costs no tokens and cannot be talked around.
   ===================================================================== */

const kb = require("./kb");

const profile = () => kb.load().profile;
const first = () => profile().name.split(" ")[0];

/** Blatant prompt-injection attempts (caught before any model is called). */
function refusal() {
  return `I can only answer questions about ${profile().name} — his skills, experience, projects, and how to get in touch. Please ask me something about that!`;
}

/** Off-topic but harmless: redirect and show what IS possible. */
function redirect() {
  return [
    `That's outside what I can help with — I'm here to answer questions about ${first()}'s background, projects, skills and certifications, and how to reach him.`,
    "",
    "For example, you could ask:",
    `- What is ${first()} working on at LTIMindtree?`,
    "- Which certifications does he hold?",
    "- Tell me about one of his projects.",
  ].join("\n");
}

/** Harassment or requests for sensitive personal attributes. */
function decline() {
  return `I'm not able to help with that. I can share ${first()}'s professional background — skills, projects, experience, education and how to contact him.`;
}

/** The answer could not be verified against the sources. */
function unverified() {
  const p = profile();
  return `I couldn't confirm that from ${first()}'s profile, and I'd rather not guess. You can ask him directly at ${p.email} or on LinkedIn (${p.linkedin}).`;
}

/** The safety checks themselves are unavailable: say so instead of answering unchecked. */
const CHECKS_UNAVAILABLE = "I can't run my safety checks right now, so I'm unable to answer. Please try again in a moment.";

/** All fixed non-answers; the verifier treats these as always acceptable. */
function fixedMessages() {
  return [refusal(), redirect(), decline(), unverified()];
}

module.exports = { refusal, redirect, decline, unverified, fixedMessages, CHECKS_UNAVAILABLE };
