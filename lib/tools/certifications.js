const { hits } = require("./util");
const credentials = require("../credentials");

module.exports = {
  name: "get_certifications",
  label: "Certifications",
  topic: "certifications",
  suggestion: "Which certifications does he hold?",
  description: "Certifications he holds: title, exam code, issuer, earned date, expiry status, credential ID and verification link. Optional query filters by name, code or issuer.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 60, description: "optional filter, e.g. AZ-900 or Microsoft" } },
  },

  async run(args, ctx) {
    const all = ctx.kb.credentials || [];
    const now = ctx.now ? ctx.now() : new Date();

    let list = all;
    if (args.query) list = all.filter((c) => hits(args.query, c.title, c.code, c.issuer) > 0);

    // Order and validity come from lib/credentials.js, the same rules the website uses.
    const certifications = credentials.newestFirst(list).map((c) => ({
      title: c.title,
      code: c.code || null,
      issuer: c.issuer,
      earned: c.earned || null,
      status: credentials.status(c, now).label,
      credentialId: c.credentialId || null,
      verifyUrl: c.verifyUrl || null,
    }));

    return {
      total_held: all.length,
      matched: certifications.length,
      certifications,
      note: args.query && !certifications.length ? `No certification matches "${args.query}". He holds ${all.length} in total.` : undefined,
      linkedin_snapshot_as_of: ctx.kb.linkedin ? ctx.kb.linkedin.asOf : undefined,
    };
  },
};
