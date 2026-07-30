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

  // Shared safety helpers (from util.js — must load before this file).
  const U = window.PortfolioUtil || {};
  const esc = U.escapeHtml || ((s) => String(s == null ? "" : s));
  const safeUrl = U.safeUrl || ((s) => String(s == null ? "" : s));
  const sanitize = U.sanitizeHtml || esc;

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
      aboutText.innerHTML = d.about.paragraphs.map(p => `<p>${sanitize(p)}</p>`).join("");
    }

    const statsGrid = $("statsGrid");
    if (statsGrid && Array.isArray(d.about.stats)) {
      statsGrid.innerHTML = d.about.stats.map(s => `
        <div class="stat-item">
          <h3 data-count="${Number(s.value) || 0}" data-suffix="${esc(s.suffix || "")}">0${esc(s.suffix || "")}</h3>
          <p>${esc(s.label)}</p>
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
          <div class="skill-icon"><i class="${esc(s.icon)}"></i></div>
          <div class="skill-name">${esc(s.name)}</div>
          <div class="skill-level">${esc(s.level)}</div>
        </div>`).join("");
    }
  }

  /* ---- Projects ----
     Cards are loaded from public/data/projects.json (kept up to date by the
     automation workflow). If that file is missing or invalid, we fall back to
     the built-in list in data.js so the site always renders. Because this load
     is async, we fire a "projects:rendered" event afterwards so script.js can
     (re)initialize the stacked-deck and spotlight interactions on the cards. */
  function buildProjectsHtml(items) {
    const total = items.length;
    return items.map((p, i) => {
      const tech = (p.tech || []).map(t => `<span class="tech-tag">${esc(t)}</span>`).join("");
      const title = `<h3>${esc(p.title)}</h3>`;
      const button = p.link
        ? `<a href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener" class="pearl-button" aria-label="View ${esc(p.title)} on GitHub">
             <span class="pearl-wrap">
               <i class="fab fa-github"></i>
               <span class="pearl-label">View Code</span>
             </span>
           </a>`
        : "";
      return `
        <div class="project-stack-item" style="--i:${i};">
          <div class="project-card" data-stack-index="${i}" data-stack-total="${total}">
            <div class="project-info">
              ${title}
              <p>${esc(p.description)}</p>
              <div class="tech-stack">${tech}</div>
              ${button}
            </div>
            <div class="project-visual">
              <i class="${esc(p.icon)}"></i>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  // Normalize/order a project list: keep only visible items, sort by `order`.
  function prepareItems(items) {
    return (Array.isArray(items) ? items : [])
      .filter(p => p && p.title && p.featured !== false)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  }

  function renderProjects(grid, items) {
    const list = prepareItems(items);
    if (!list.length) return;
    grid.innerHTML = buildProjectsHtml(list);
    document.dispatchEvent(new CustomEvent("projects:rendered"));
  }

  if (d.projects) {
    setText("projectsTag", d.projects.tag);
    setText("projectsTitle", d.projects.title);
    setText("projectsDesc", d.projects.description);

    const grid = $("projectsGrid");
    if (grid) {
      const fallback = d.projects.items;
      fetch("./data/projects.json", { cache: "no-cache" })
        .then(res => (res.ok ? res.json() : null))
        .then(json => {
          const items = json && Array.isArray(json.items) && json.items.length
            ? json.items
            : fallback;
          renderProjects(grid, items);
        })
        .catch(() => renderProjects(grid, fallback));
    }
  }

  /* ---- Experience ---- */
  if (d.experience) {
    setText("experienceTag", d.experience.tag);
    setText("experienceTitle", d.experience.title);

    const list = $("experienceList");
    if (list && Array.isArray(d.experience.items)) {
      list.innerHTML = d.experience.items.map(e => {
        const points = (e.points || []).map(pt => `<li>${esc(pt)}</li>`).join("");
        return `
          <div class="experience-card reveal">
            <div class="experience-header">
              <div>
                <h3>${esc(e.role)}</h3>
                <h4>${esc(e.company)}</h4>
                <p>${esc(e.subtitle || "")}</p>
              </div>
              <span class="experience-date">${esc(e.date || "")}</span>
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
        return `<a href="${esc(safeUrl(l.href))}"${ext} class="contact-link">
            <i class="${esc(l.icon)}"></i>
            ${esc(l.label)}
          </a>`;
      }).join("");
    }
  }

  /* ---- Footer ---- */
  if (d.footer) setText("footerText", d.footer.text);
})();
