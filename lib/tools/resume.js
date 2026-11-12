const { splitSections, SECTION_KEYS } = require("../sources/resume-sections");
const { describeRole, describeEngagement } = require("../kb");

const MAX_CHARS = 6000;

module.exports = {
  name: "get_resume",
  label: "Live resume",
  topic: "resume",
  suggestion: "Give me a summary of his resume",
  description: "The text of his live resume document, whole or one section. Use when asked to read or summarise the resume itself. For his role, skills, certifications or education prefer the specific lookups: his profile is the confirmed record.",
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
    // The profile's own role and dates travel with the document, so even a turn that only reads the
    // resume has the confirmed record in front of it to resolve a disagreement.
    const current = (ctx.kb.experience || [])[0];
    const engagement = current && describeEngagement(current);
    return {
      available: true,
      stale: resume.stale || undefined,
      as_of: resume.fetchedAt,
      section,
      profile_current_role: current ? [describeRole(current), engagement && `Project: ${engagement}`].filter(Boolean).join(". ") : undefined,
      note: "A supporting document. Where it differs from his profile data (profile_current_role here, or any other lookup), the profile data is correct.",
      text: truncated ? text.slice(0, text.lastIndexOf("\n", MAX_CHARS)) : text,
      truncated: truncated || undefined,
    };
  },
};
