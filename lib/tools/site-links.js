// Section ids that exist in public/index.html. Keep in sync with the page (a test checks it).
const SECTIONS = {
  about: "An overview of who he is and what he does",
  skills: "His skills and tools",
  projects: "Featured projects",
  certifications: "His certifications with verification links",
  experience: "Professional experience",
  contact: "How to get in touch",
};

module.exports = {
  name: "get_site_links",
  label: "Portfolio site",
  topic: "site",
  suggestion: "Where can I see his work?",
  description: "Links to sections of his portfolio website (about, skills, projects, certifications, experience, contact). Use when a visitor wants to see something on the site.",
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
