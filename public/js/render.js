/* =====================================================================
   RENDER — builds the page from the site content
   ---------------------------------------------------------------------
   The facts (profile, skills, projects, certifications, experience,
   education) come from the JSON the server inlines in index.html
   (<script id="site-content">), projected from kb/kb.json by
   lib/site-content.js: the same record the chat assistant answers from.
   Headings and layout choices come from layout.js.

   Everything from the content is escaped before it becomes HTML.
   You normally never need to touch this file: edit kb/kb.json for facts
   and layout.js for headings.
   ===================================================================== */

(function renderPortfolio() {
  const layout = window.portfolioLayout;

  // Shared safety helpers (from util.js — must load before this file).
  const U = window.PortfolioUtil || {};
  const esc = U.escapeHtml || ((s) => String(s == null ? "" : s));
  const safeUrl = U.safeUrl || ((s) => String(s == null ? "" : s));
  const boldText = U.boldText || esc;

  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el && value != null) el.textContent = value; };
  const setHTML = (id, value) => { const el = $(id); if (el) el.innerHTML = value; };

  /** The inlined content, or null when it is missing or unreadable. */
  function readContent() {
    const el = $("site-content");
    if (!el) return null;
    try {
      const parsed = JSON.parse(el.textContent);
      return parsed && parsed.profile && parsed.profile.name ? parsed : null;
    } catch {
      return null;
    }
  }

  /** No content: say so instead of showing empty sections (and buttons that lead to them). */
  function showUnavailable() {
    const note = $("contentUnavailable");
    if (note) note.hidden = false;
    document.querySelectorAll("section[id]:not(#home)").forEach((s) => { s.hidden = true; });
    document.querySelectorAll(".hero-content").forEach((s) => { s.hidden = true; });
  }

  const c = readContent();
  window.siteContent = c; // script.js and chat.js read the name from here
  if (!layout || !c) {
    console.error("Portfolio content is unavailable (missing layout.js or the inlined site content).");
    showUnavailable();
    return;
  }

  const heading = (key) => {
    const h = (layout.sections || {})[key];
    if (!h) return;
    setText(`${key}Tag`, h.tag);
    setText(`${key}Title`, h.title);
    setText(`${key}Desc`, h.description);
  };
  const list = (value) => (Array.isArray(value) ? value : []);
  const p = c.profile;

  /* ---- Branding & hero ---- */
  document.title = `${p.name} - ${p.headline}`;
  setText("navLogo", p.name);
  setText("heroTag", p.headline);
  setText("heroSubtitle", p.tagline);
  // The name itself is typed in by script.js from the same profile.

  /* ---- About ---- */
  heading("about");
  setHTML("aboutText", list(c.about && c.about.paragraphs).map((t) => `<p>${boldText(t)}</p>`).join(""));

  // Stats are counted from the data (c.metrics); layout.js only chooses which to show.
  setHTML(
    "statsGrid",
    list(layout.stats)
      .filter((s) => Number.isFinite(c.metrics && c.metrics[s.metric]))
      .map((s) => `
        <div class="stat-item">
          <h3 data-count="${Number(c.metrics[s.metric])}" data-suffix="">0</h3>
          <p>${esc(s.label)}</p>
        </div>`)
      .join("")
  );

  /* ---- Skills (a level is the owner's own rating and is optional) ---- */
  heading("skills");
  setHTML(
    "skillsGrid",
    list(c.skills).map((s) => `
        <div class="skill-card">
          <div class="skill-icon"><i class="${esc(s.icon || "fas fa-code")}"></i></div>
          <div class="skill-name">${esc(s.name)}</div>
          ${s.level ? `<div class="skill-level">${esc(s.level)}</div>` : ""}
        </div>`).join("")
  );

  /* ---- Projects ---- */
  heading("projects");
  const projectItems = list(c.projects);
  setHTML(
    "projectsGrid",
    projectItems.map((item, i) => {
      const tech = list(item.tech).map((t) => `<span class="tech-tag">${esc(t)}</span>`).join("");
      const button = item.link
        ? `<a href="${esc(safeUrl(item.link))}" target="_blank" rel="noopener" class="pearl-button" aria-label="View ${esc(item.title)} on GitHub">
             <span class="pearl-wrap">
               <i class="fab fa-github"></i>
               <span class="pearl-label">View Code</span>
             </span>
           </a>`
        : "";
      return `
        <div class="project-stack-item" style="--i:${i};">
          <div class="project-card" data-stack-index="${i}" data-stack-total="${projectItems.length}">
            <div class="project-info">
              <h3>${esc(item.title)}</h3>
              <p>${esc(item.description)}</p>
              <div class="tech-stack">${tech}</div>
              ${button}
            </div>
            <div class="project-visual">
              <i class="${esc(item.icon || "fas fa-code")}"></i>
            </div>
          </div>
        </div>`;
    }).join("")
  );
  if (projectItems.length) document.dispatchEvent(new CustomEvent("projects:rendered"));

  /* ---- Certifications ---- */
  heading("certifications");
  setHTML(
    "certificationsGrid",
    list(c.certifications).map((cert) => {
      const meta = [];
      if (cert.issuer) meta.push(`<span class="cert-issuer"><i class="fas fa-building-shield" aria-hidden="true"></i>${esc(cert.issuer)}</span>`);
      if (cert.earned) meta.push(`<span class="cert-date"><i class="fas fa-calendar-check" aria-hidden="true"></i>${esc(cert.earned)}</span>`);
      if (cert.validity) meta.push(`<span class="cert-validity"><i class="fas fa-hourglass-half" aria-hidden="true"></i>${esc(cert.validity)}</span>`);
      return `
          <article class="cert-card">
            <div class="cert-top">
              <span class="cert-badge"><i class="${esc(cert.icon || "fas fa-certificate")}" aria-hidden="true"></i></span>
              ${cert.code ? `<span class="cert-code">${esc(cert.code)}</span>` : ""}
            </div>
            <h3 class="cert-title">${esc(cert.title)}</h3>
            ${meta.length ? `<div class="cert-meta">${meta.join("")}</div>` : ""}
            ${cert.credentialId ? `<p class="cert-credential">Credential ID <span>${esc(cert.credentialId)}</span></p>` : ""}
            ${cert.verifyUrl
              ? `<a href="${esc(safeUrl(cert.verifyUrl))}" target="_blank" rel="noopener" class="cert-verify" aria-label="Verify ${esc(cert.title)} credential">
                   <span>Verify Credential</span>
                   <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>
                 </a>`
              : ""}
          </article>`;
    }).join("")
  );

  /* ---- Experience ---- */
  heading("experience");
  setHTML(
    "experienceList",
    list(c.experience).map((x) => `
          <div class="experience-card reveal">
            <div class="experience-header">
              <div>
                <h3>${esc(x.role)}</h3>
                <h4>${esc(x.company)}</h4>
                ${x.engagement ? `<p>${esc(x.engagement.name)} &middot; since ${esc(x.engagement.since)}</p>` : ""}
              </div>
              <span class="experience-date">${esc(x.period || "")}</span>
            </div>
            <ul>${list(x.points).map((pt) => `<li>${esc(pt)}</li>`).join("")}</ul>
          </div>`).join("")
  );

  /* ---- Education ---- */
  heading("education");
  setHTML(
    "educationGrid",
    list(c.education).map((e) => `
          <article class="cert-card edu-card">
            <div class="cert-top">
              <span class="cert-badge"><i class="fas fa-graduation-cap" aria-hidden="true"></i></span>
              ${e.period ? `<span class="cert-code">${esc(e.period)}</span>` : ""}
            </div>
            <h3 class="cert-title">${esc(e.degree)}</h3>
            <div class="cert-meta">
              <span><i class="fas fa-building-columns" aria-hidden="true"></i>${esc(e.institution)}</span>
              ${e.affiliation ? `<span><i class="fas fa-landmark" aria-hidden="true"></i>${esc(e.affiliation)}</span>` : ""}
            </div>
            ${e.score ? `<p class="edu-score"><i class="fas fa-award" aria-hidden="true"></i>${esc(e.score)}</p>` : ""}
          </article>`).join("")
  );

  /* ---- Contact (links are derived from the profile: one place for contact details) ---- */
  heading("contact");
  const contactValue = { email: p.email ? `mailto:${p.email}` : "", linkedin: p.linkedin, github: p.github };
  setHTML(
    "contactLinks",
    list(layout.contactLinks)
      .filter((l) => contactValue[l.kind])
      .map((l) => `<a href="${esc(safeUrl(contactValue[l.kind]))}"${l.kind === "email" ? "" : ' target="_blank" rel="noopener"'} class="contact-link">
            <i class="${esc(l.icon)}"></i>
            ${esc(l.label)}
          </a>`)
      .join("")
  );

  /* ---- Footer ---- */
  setText(
    "footerText",
    String(layout.footer || "").replace("{year}", () => String(new Date().getFullYear())).replace("{name}", () => p.name)
  );
})();
