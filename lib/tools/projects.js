const { hits, clip } = require("./util");
const { splitSections } = require("../sources/resume-sections");

const MAX_RESULTS = 6;

module.exports = {
  name: "get_projects",
  label: "Projects",
  topic: "projects",
  suggestion: "What projects has he built?",
  description: "His projects as shown on his portfolio: title, link, tech stack and description with details from GitHub, plus project lines from the resume. Optional query filters by keyword or technology (e.g. RAG, Flask, Docker).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 60, description: "optional keyword or technology" } },
  },

  async run(args, ctx) {
    const all = ctx.kb.projects || [];
    let ranked = all.map((p, i) => ({ p, i, score: args.query ? hits(args.query, p.title, p.tech, p.description, p.highlights, p.repo) : 1 }));
    if (args.query) ranked = ranked.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);

    const resume = await ctx.getResume();
    let resumeProjects;
    if (resume && resume.available) {
      const lines = (splitSections(resume.text).sections.projects || { lines: [] }).lines;
      const text = lines.join("\n");
      if (!args.query || hits(args.query, text) > 0) resumeProjects = clip(text, 1500);
    }

    return {
      total_projects: all.length,
      matched: ranked.length,
      projects: ranked.slice(0, MAX_RESULTS).map(({ p }) => ({
        title: p.title,
        link: p.link,
        tech: p.tech && p.tech.length ? p.tech : null,
        description: clip(p.description, 300),
        details: p.highlights ? clip(p.highlights, 280) : null,
      })),
      resume_projects: resumeProjects,
      note: args.query && !ranked.length && !resumeProjects ? `No project matches "${args.query}".` : ranked.length > MAX_RESULTS ? `Showing ${MAX_RESULTS} of ${ranked.length} projects; ask about a specific project or technology to see the others.` : undefined,
    };
  },
};
