module.exports = {
  name: "get_contact_info",
  label: "Contact details",
  topic: "contact",
  suggestion: "How can I contact him?",
  description: "How to reach him: e-mail, LinkedIn, GitHub, portfolio site and location, plus what is known about availability, relocation, salary and phone policy.",
  parameters: { type: "object", properties: {} },

  async run(_args, ctx) {
    const p = ctx.kb.profile;
    return {
      name: p.name,
      email: p.email,
      linkedin: p.linkedin,
      github: p.github,
      portfolio_site: p.website || null,
      location: p.location,
      notes: (ctx.kb.facts || []).filter((f) => f.topic === "contact").map((f) => f.text),
    };
  },
};
