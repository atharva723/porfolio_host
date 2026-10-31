const { clip } = require("./util");
const { splitSections } = require("../sources/resume-sections");

module.exports = {
  name: "get_experience",
  label: "Experience",
  topic: "experience",
  suggestion: "What is his current role?",
  description: "Work experience: current role, employer, start dates and responsibilities (live resume first, then the LinkedIn snapshot), plus his employment timeline.",
  parameters: { type: "object", properties: {} },

  async run(_args, ctx) {
    const resume = await ctx.getResume();
    const sections = resume && resume.available ? splitSections(resume.text).sections : {};
    const li = ctx.kb.linkedin;

    return {
      resume_available: !!(resume && resume.available),
      resume_summary: sections.summary ? clip(sections.summary.lines.join(" "), 700) : undefined,
      resume_experience: sections.experience ? sections.experience.lines.join("\n") : undefined,
      timeline: (ctx.kb.facts || []).filter((f) => f.topic === "experience").map((f) => f.text),
      linkedin_snapshot_as_of: li ? li.asOf : undefined,
      linkedin_positions: li
        ? (li.positions || []).map((p) => ({
            title: p.title,
            company: p.company,
            started: p.started,
            ended: p.finished || "present",
            description: clip(p.description, 700),
          }))
        : undefined,
    };
  },
};
