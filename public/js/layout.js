/* =====================================================================
   PAGE LAYOUT — section headings, labels and which stats / links to show
   ---------------------------------------------------------------------
   This file holds NO facts about the owner (no name, role, e-mail, link,
   skill or certificate). All of that comes from kb/kb.json, the record the
   chat assistant also uses, via the server (lib/site-content.js).
   To change what the site says about you, edit kb/kb.json.

   Headings below are deliberately generic: a topic claim written here
   could go stale without anything noticing.
   ===================================================================== */

window.portfolioLayout = {
  sections: {
    about: { tag: "About Me", title: "Who I am and what I build" },
    skills: { tag: "Capabilities", title: "What I bring to the table", description: "Tools and technologies I work with." },
    projects: { tag: "Projects", title: "Featured work", description: "Selected projects and experiments." },
    certifications: { tag: "Certifications", title: "Credentials & proof of skill", description: "Industry-recognized certifications and credentials." },
    experience: { tag: "Experience", title: "Professional journey" },
    education: { tag: "Education", title: "Where I studied" },
    contact: { tag: "Get In Touch", title: "Let's create something amazing together", description: "I'm open to discussing new opportunities and tech collaborations." }
  },

  // `metric` names a number the server counts from the data (site.json -> metrics).
  // The numbers animate up from 0 when scrolled into view. Remove a line to hide a stat.
  stats: [
    { metric: "certifications", label: "Certifications" },
    { metric: "projects", label: "Projects" },
    { metric: "skills", label: "Skills & tools" },
    { metric: "experienceMonths", label: "Months of experience" }
  ],

  // `kind` picks the value from the profile: email, linkedin or github.
  contactLinks: [
    { kind: "email", icon: "fas fa-envelope", label: "Email Me" },
    { kind: "linkedin", icon: "fab fa-linkedin", label: "LinkedIn" },
    { kind: "github", icon: "fab fa-github", label: "GitHub" }
  ],

  footer: "© {year} {name}. Crafted with passion and precision."
};
