const { norm } = require("./util");
const { splitSections } = require("../sources/resume-sections");

const unique = (list) => {
  const seen = new Set();
  return list.filter((s) => {
    const k = norm(s);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const flatten = (lines) =>
  unique(
    lines
      .flatMap((l) => l.split(/[•·|,]/))
      .map((s) => s.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean)
  );

module.exports = {
  name: "get_skills",
  label: "Skills",
  topic: "skills",
  suggestion: "What are his main skills?",
  description: "His skills and tools from the resume and LinkedIn. Pass query to check a specific skill (e.g. Terraform, Rust): the result says definitively whether it is listed.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 60, description: "a specific skill or tool to check" } },
  },

  async run(args, ctx) {
    const resume = await ctx.getResume();
    let core = [];
    let additional = [];
    if (resume && resume.available) {
      const { sections } = splitSections(resume.text);
      core = flatten((sections.skills || { lines: [] }).lines);
      additional = flatten((sections.additional_stack || { lines: [] }).lines);
    }
    const linkedin = (ctx.kb.linkedin && ctx.kb.linkedin.skills) || [];

    if (args.query) {
      const q = norm(args.query);
      const pick = (list) => list.filter((s) => norm(s).includes(q) || q.includes(norm(s)));
      const inResume = pick([...core, ...additional]);
      const inLinkedin = pick(linkedin);
      const listed = inResume.length + inLinkedin.length > 0;
      return {
        resume_available: !!(resume && resume.available),
        query: args.query,
        listed,
        matches_in_resume: inResume,
        matches_in_linkedin: inLinkedin,
        note: listed ? undefined : `"${args.query}" is not listed in his resume or LinkedIn skills.`,
      };
    }

    return {
      resume_available: !!(resume && resume.available),
      resume_skills: core,
      resume_additional_stack: additional,
      linkedin_skills: linkedin,
    };
  },
};
