/* =====================================================================
   RENDER — builds the page from data.js
   ---------------------------------------------------------------------
   You normally never need to touch this file. It reads `portfolioData`
   (from data.js) and fills in the page. Edit content in data.js instead.
   ===================================================================== */

(function renderPortfolio() {
  const d = window.portfolioData;
  if (!d) {
    console.error("portfolioData not found. Make sure data.js loads before render.js.");
    return;
  }

  // Small helpers
  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el && value != null) el.textContent = value; };
  const setHTML = (id, value) => { const el = $(id); if (el && value != null) el.innerHTML = value; };

  /* ---- Branding ---- */
  if (d.site) {
    if (d.site.pageTitle) document.title = d.site.pageTitle;
    setText("navLogo", d.site.name);
  }

  /* ---- Hero ---- */
  if (d.hero) {
    setText("heroTag", d.hero.tag);
    setText("heroSubtitle", d.hero.subtitle);
    // first/last name are typed in by script.js using portfolioData.hero
  }

  /* ---- About ---- */
  if (d.about) {
    setText("aboutTag", d.about.tag);
    setText("aboutTitle", d.about.title);

    const aboutText = $("aboutText");
    if (aboutText && Array.isArray(d.about.paragraphs)) {
      aboutText.innerHTML = d.about.paragraphs.map(p => `<p>${p}</p>`).join("");
    }

    const statsGrid = $("statsGrid");
    if (statsGrid && Array.isArray(d.about.stats)) {
      statsGrid.innerHTML = d.about.stats.map(s => `
        <div class="stat-item">
          <h3 data-count="${s.value}" data-suffix="${s.suffix || ""}">0${s.suffix || ""}</h3>
          <p>${s.label}</p>
        </div>`).join("");
    }
  }

  /* ---- Skills ---- */
  if (d.skills) {
    setText("skillsTag", d.skills.tag);
    setText("skillsTitle", d.skills.title);
    setText("skillsDesc", d.skills.description);

    const grid = $("skillsGrid");
    if (grid && Array.isArray(d.skills.items)) {
      grid.innerHTML = d.skills.items.map(s => `
        <div class="skill-card">
          <div class="skill-icon"><i class="${s.icon}"></i></div>
          <div class="skill-name">${s.name}</div>
          <div class="skill-level">${s.level}</div>
        </div>`).join("");
    }
  }

  /* ---- Projects ---- */
  if (d.projects) {
    setText("projectsTag", d.projects.tag);
    setText("projectsTitle", d.projects.title);
    setText("projectsDesc", d.projects.description);

    const grid = $("projectsGrid");
    if (grid && Array.isArray(d.projects.items)) {
      grid.innerHTML = d.projects.items.map(p => {
        const tech = (p.tech || []).map(t => `<span class="tech-tag">${t}</span>`).join("");
        const title = p.link
          ? `<h3><a href="${p.link}" target="_blank" rel="noopener" class="project-title-link">${p.title}</a></h3>`
          : `<h3>${p.title}</h3>`;
        return `
          <div class="project-card">
            <div class="project-info">
              ${title}
              <p>${p.description}</p>
              <div class="tech-stack">${tech}</div>
            </div>
            <div class="project-visual">
              <i class="${p.icon}"></i>
            </div>
          </div>`;
      }).join("");
    }
  }

  /* ---- Experience ---- */
  if (d.experience) {
    setText("experienceTag", d.experience.tag);
    setText("experienceTitle", d.experience.title);

    const list = $("experienceList");
    if (list && Array.isArray(d.experience.items)) {
      list.innerHTML = d.experience.items.map(e => {
        const points = (e.points || []).map(pt => `<li>${pt}</li>`).join("");
        return `
          <div class="experience-card reveal">
            <div class="experience-header">
              <div>
                <h3>${e.role}</h3>
                <h4>${e.company}</h4>
                <p>${e.subtitle || ""}</p>
              </div>
              <span class="experience-date">${e.date || ""}</span>
            </div>
            <ul>${points}</ul>
          </div>`;
      }).join("");
    }
  }

  /* ---- Contact ---- */
  if (d.contact) {
    setText("contactTag", d.contact.tag);
    setText("contactTitle", d.contact.title);
    setText("contactDesc", d.contact.description);

    const links = $("contactLinks");
    if (links && Array.isArray(d.contact.links)) {
      links.innerHTML = d.contact.links.map(l => {
        const ext = l.external ? ` target="_blank" rel="noopener"` : "";
        return `<a href="${l.href}"${ext} class="contact-link">
            <i class="${l.icon}"></i>
            ${l.label}
          </a>`;
      }).join("");
    }
  }

  /* ---- Footer ---- */
  if (d.footer) setText("footerText", d.footer.text);
})();
