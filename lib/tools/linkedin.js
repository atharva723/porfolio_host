module.exports = {
  name: "get_linkedin_profile",
  label: "LinkedIn export",
  topic: "linkedin",
  suggestion: "What does his LinkedIn say?",
  description: "His LinkedIn profile link and a dated snapshot from a LinkedIn data export: headline, location, positions and skills. The snapshot can lag the live profile.",
  parameters: { type: "object", properties: {} },

  async run(_args, ctx) {
    const li = ctx.kb.linkedin;
    const url = ctx.kb.profile.linkedin;
    if (!li) return { profile_url: url, snapshot_available: false, note: "No LinkedIn snapshot is stored; the live profile is at the link." };

    return {
      profile_url: url,
      snapshot_as_of: li.asOf,
      headline: li.headline,
      location: li.location,
      industry: li.industry,
      about: li.summary || undefined,
      positions: (li.positions || []).map((p) => `${p.title} at ${p.company} (${p.started || "?"} – ${p.finished || "present"})`),
      skills: li.skills || [],
      note: "This is a snapshot of a LinkedIn data export; the live profile may be newer.",
    };
  },
};
