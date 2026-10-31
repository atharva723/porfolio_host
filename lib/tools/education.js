module.exports = {
  name: "get_education",
  label: "Education",
  topic: "education",
  suggestion: "Where did he study?",
  description: "Degrees and schools: degree, institution, university, years studied, graduation year and grades.",
  parameters: { type: "object", properties: {} },

  async run(_args, ctx) {
    return {
      education: (ctx.kb.education || []).map((e) => ({
        degree: e.degree,
        institution: e.institution,
        university: e.affiliation || null,
        studied: e.period || null,
        graduated: e.graduated || null,
        grades: e.score || null,
      })),
    };
  },
};
