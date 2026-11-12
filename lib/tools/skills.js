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

// Whole-word matching: "git" must not match "GitHub" or "GitLab", and a one-letter query must not match
// every skill. Words are compared after a light plural strip ("LLMs" = "LLM").
const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const words = (s) => norm(s).split(/[^a-z0-9+#]+/).filter(Boolean).map(stem);
const hasRun = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));
/** The queried skill is this listed skill, or part of it, as whole words ("terraform" in "Terraform"). */
const matches = (name, query) => hasRun(words(name), words(query));
/** A listed skill appears INSIDE the query ("Azure" in "Azure Kubernetes Service"): related, not a match. */
const isRelated = (name, query) => !matches(name, query) && hasRun(words(query), words(name));

module.exports = {
  name: "get_skills",
  label: "Skills",
  topic: "skills",
  suggestion: "What are his main skills?",
  description: "His skills and tools, with the level he rates himself at. Pass query to check a specific skill (e.g. Terraform, Rust): the result says definitively whether it is listed in his profile, resume or LinkedIn.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 60, description: "a specific skill or tool to check" } },
  },

  async run(args, ctx) {
    // His profile's skills are the confirmed list (what the website shows). The resume and LinkedIn
    // only add detail beyond it, and every level is HIS OWN rating, named as such in the result.
    const profileSkills = ctx.kb.skills || [];
    const item = (s) => (s.level ? { name: s.name, self_rated_level: s.level } : { name: s.name });

    const resume = await ctx.getResume();
    const resumeChecked = !!(resume && resume.available);
    let core = [];
    let additional = [];
    if (resumeChecked) {
      const { sections } = splitSections(resume.text);
      core = flatten((sections.skills || { lines: [] }).lines);
      additional = flatten((sections.additional_stack || { lines: [] }).lines);
    }
    const linkedin = (ctx.kb.linkedin && ctx.kb.linkedin.skills) || [];
    const resumeSkills = unique([...core, ...additional]);

    if (args.query) {
      const q = args.query;
      const inProfile = profileSkills.filter((s) => matches(s.name, q)).map(item);
      const inResume = resumeSkills.filter((s) => matches(s, q));
      const inLinkedin = linkedin.filter((s) => matches(s, q));
      const listed = inProfile.length + inResume.length + inLinkedin.length > 0;
      const relatedSkills = listed ? [] : unique([...profileSkills.map((s) => s.name), ...resumeSkills, ...linkedin].filter((s) => isRelated(s, q)));
      const where = resumeChecked ? "profile, resume or LinkedIn skills" : "profile or LinkedIn skills (the resume could not be checked right now)";
      return {
        resume_available: resumeChecked,
        query: q,
        listed,
        matches_in_profile: inProfile,
        resume_matches: inResume,
        linkedin_matches: inLinkedin,
        related_skills: relatedSkills.length ? relatedSkills : undefined,
        note: listed ? undefined : `"${q}" is not listed in his ${where}.${relatedSkills.length ? ` Related skills he does list: ${relatedSkills.join(", ")}.` : ""}`,
      };
    }

    const known = new Set(profileSkills.map((s) => norm(s.name)));
    const extra = (list) => list.filter((s) => !known.has(norm(s)));
    const resumeExtra = extra(resumeSkills);
    const inResumeExtra = new Set(resumeExtra.map(norm));
    return {
      resume_available: resumeChecked,
      skills: profileSkills.map(item),
      note: profileSkills.some((s) => s.level) ? "self_rated_level is his own rating of himself, not an assessment." : undefined,
      resume_other_skills: resumeExtra,
      linkedin_other_skills: extra(linkedin).filter((s) => !inResumeExtra.has(norm(s))),
    };
  },
};
