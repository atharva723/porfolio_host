// Section ids that exist in views/index.html. A test keeps this list and the page identical in BOTH
// directions, so the assistant never links to a section that is gone or misses one that was added.
const SECTIONS = {
  about: "An overview of who he is and what he does",
  skills: "His skills and tools",
  projects: "Featured projects",
  certifications: "His certifications with verification links",
  experience: "Professional experience",
  education: "His education and academic scores",
  contact: "How to get in touch",
};

module.exports = {
  name: "get_site_links",
  label: "Portfolio site",
  topic: "site",
  suggestion: "Where can I see his work?",
  description: "Links to sections of his portfolio website (about, skills, projects, certifications, experience, education, contact). Use when a visitor wants to see something on the site.",
  parameters: {
    type: "object",
    properties: { section: { type: "string", enum: Object.keys(SECTIONS), description: "optional: one section" } },
  },
  SECTIONS,

  async run(args, ctx) {
    const base = (ctx.kb.profile.website || "").replace(/\/+$/, "");
    const pick = args.section ? [args.section] : Object.keys(SECTIONS);
    return {
      site: ctx.kb.profile.website || null,
      sections: pick.map((id) => `${id}: ${base}/#${id} — ${SECTIONS[id]}`),
    };
  },
};
