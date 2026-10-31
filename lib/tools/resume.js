const { splitSections, SECTION_KEYS } = require("../sources/resume-sections");

const MAX_CHARS = 6000;

module.exports = {
  name: "get_resume",
  label: "Live resume",
  topic: "resume",
  suggestion: "Give me a summary of his resume",
  description: "His live resume text, whole or one section. Use for broad questions such as 'tell me about him' or 'summarise his resume'.",
  parameters: {
    type: "object",
    properties: {
      section: { type: "string", enum: [...SECTION_KEYS, "all"], description: "which part of the resume (default all)" },
    },
  },

  async run(args, ctx) {
    const resume = await ctx.getResume();
    if (!resume || !resume.available) {
      return { available: false, note: "The live resume is temporarily unavailable." };
    }
    const section = args.section || "all";
    let text = resume.text;
    if (section !== "all") {
      const { sections } = splitSections(resume.text);
      if (!sections[section]) return { available: true, section, note: `The resume has no "${section}" section.` };
      text = `${sections[section].title}\n${sections[section].lines.join("\n")}`;
    }
    const truncated = text.length > MAX_CHARS;
    return {
      available: true,
      stale: resume.stale || undefined,
      as_of: resume.fetchedAt,
      section,
      text: truncated ? text.slice(0, text.lastIndexOf("\n", MAX_CHARS)) : text,
      truncated: truncated || undefined,
    };
  },
};
