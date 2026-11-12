const { describeRole, describeEngagement, plainText } = require("../kb");

module.exports = {
  name: "get_experience",
  label: "Experience",
  topic: "experience",
  suggestion: "What is his current role?",
  description: "His work experience from his profile: current role, employer, employment type, start date, the project he works on and what he does there, plus his own short About text. Use for 'tell me about him' as well.",
  parameters: { type: "object", properties: {} },

  // His confirmed record only (the same data the website shows). The resume and LinkedIn are
  // available through their own tools, so two versions of a date can never reach the answer.
  async run(_args, ctx) {
    const kb = ctx.kb;
    const roles = kb.experience || [];
    const several = roles.length > 1;
    return {
      roles: roles.map((x) => (x.engagement ? `${describeRole(x)}. Project: ${describeEngagement(x)}` : describeRole(x))),
      responsibilities: roles.flatMap((x) => (x.points || []).map((pt) => (several ? `${x.company}: ${pt}` : pt))),
      about_in_his_words: ((kb.about && kb.about.paragraphs) || []).map(plainText),
    };
  },
};
