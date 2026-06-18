// ===============================
//  Portfolio interactions
// ===============================

// Mobile Menu Toggle
const menuToggle = document.getElementById('menuToggle');
const navLinks = document.getElementById('navLinks');

if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        const icon = menuToggle.querySelector('i');
        icon.classList.toggle('fa-bars');
        icon.classList.toggle('fa-times');
    });

    // Close menu when clicking a link
    document.querySelectorAll('.nav-links a').forEach(link => {
        link.addEventListener('click', () => {
            navLinks.classList.remove('active');
            const icon = menuToggle.querySelector('i');
            icon.classList.add('fa-bars');
            icon.classList.remove('fa-times');
        });
    });
}

// Navbar scroll effect (background appears after leaving the hero)
const nav = document.querySelector('nav');
const hero = document.querySelector('#home');

if (nav && hero) {
    window.addEventListener('scroll', () => {
        const heroBottom = hero.offsetTop + hero.offsetHeight;
        if (window.scrollY >= heroBottom - 80) {
            nav.classList.add('scrolled');
        } else {
            nav.classList.remove('scrolled');
        }
    });
}

// ===============================
//  Hero name typing animation
// ===============================
(function typeHeroName() {
    const data = (window.portfolioData && window.portfolioData.hero) || {};
    const firstName = data.firstName != null ? data.firstName : "Atharva ";
    const lastName = data.lastName != null ? data.lastName : "Jadhav";

    const firstEl = document.getElementById("first-name");
    const lastEl = document.getElementById("last-name");
    if (!firstEl || !lastEl) return;

    let i = 0;
    let j = 0;

    firstEl.classList.add("typing");

    function typeFirstName() {
        if (i < firstName.length) {
            firstEl.textContent += firstName.charAt(i);
            i++;
            setTimeout(typeFirstName, 90);
        } else {
            firstEl.classList.remove("typing");
            lastEl.classList.add("typing");
            setTimeout(typeLastName, 200);
        }
    }

    function typeLastName() {
        if (j < lastName.length) {
            lastEl.textContent += lastName.charAt(j);
            j++;
            setTimeout(typeLastName, 90);
        } else {
            lastEl.classList.remove("typing");
        }
    }

    typeFirstName();
})();

// ===============================
//  Scroll reveal animations
// ===============================
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealEls = document.querySelectorAll('.reveal, .reveal-stagger');

if (revealEls.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
        revealEls.forEach(el => el.classList.add('is-visible'));
    } else {
        const revealObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const el = entry.target;

                // Stagger child animations
                if (el.classList.contains('reveal-stagger')) {
                    Array.from(el.children).forEach((child, idx) => {
                        child.style.transitionDelay = `${idx * 90}ms`;
                    });
                }

                el.classList.add('is-visible');
                obs.unobserve(el);
            });
        }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });

        revealEls.forEach(el => revealObserver.observe(el));
    }
}

// ===============================
//  Animated stat counters
// ===============================
const counters = document.querySelectorAll('[data-count]');

if (counters.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
        counters.forEach(el => {
            el.textContent = el.dataset.count + (el.dataset.suffix || '');
        });
    } else {
        const countObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                const target = parseInt(el.dataset.count, 10);
                const suffix = el.dataset.suffix || '';
                const duration = 1500;
                const start = performance.now();

                function tick(now) {
                    const progress = Math.min((now - start) / duration, 1);
                    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
                    el.textContent = Math.round(eased * target) + suffix;
                    if (progress < 1) requestAnimationFrame(tick);
                }

                requestAnimationFrame(tick);
                obs.unobserve(el);
            });
        }, { threshold: 0.6 });

        counters.forEach(el => countObserver.observe(el));
    }
}

// ===============================
//  Scroll progress bar + scroll-to-top
// ===============================
const progressBar = document.getElementById('scrollProgress');
const scrollTopBtn = document.getElementById('scrollTop');

// Parallax cinematic hero (zoom + blur + fade on scroll)
const heroBg = document.getElementById('heroBg');
const heroBaseFilter = 'brightness(1.12) contrast(1.08)';

// Stacked project cards (scroll-pinned deck — ported from GSAP ScrollTrigger)
const stackCards = Array.from(document.querySelectorAll('.projects-stack .project-card'));

function updateProjectStack() {
    if (!stackCards.length || reduceMotion) return;
    const centerY = window.innerHeight / 2;

    stackCards.forEach(card => {
        const item = card.parentElement; // .project-stack-item (the trigger)
        const index = parseInt(card.dataset.stackIndex, 10) || 0;
        const total = parseInt(card.dataset.stackTotal, 10) || 1;
        const targetScale = 1 - (total - index) * 0.05;

        const rect = item.getBoundingClientRect();
        // progress: 0 when item top reaches viewport center, 1 when item bottom does
        let progress = (centerY - rect.top) / rect.height;
        progress = Math.min(Math.max(progress, 0), 1);

        const scale = 1 + (targetScale - 1) * progress; // interpolate 1 → targetScale
        card.style.transform = `scale(${Math.max(scale, targetScale).toFixed(4)})`;
    });
}

function onScrollUI() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const percent = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;

    if (progressBar) progressBar.style.width = percent + '%';

    if (scrollTopBtn) {
        scrollTopBtn.classList.toggle('visible', scrollTop > 500);
    }

    // Parallax: as you scroll through the hero, the backdrop slowly
    // zooms in, blurs and fades — same mechanism as the React effect.
    if (heroBg && !reduceMotion) {
        const heroHeight = window.innerHeight;
        const progress = Math.min(scrollTop / heroHeight, 1); // 0 → 1 across the hero
        const scale = 1 + progress * 0.18;        // 1 → 1.18 zoom
        const blur = progress * 8;                 // 0 → 8px blur
        const opacity = 1 - progress * 0.85;       // 1 → 0.15 fade

        heroBg.style.transform = `scale(${scale.toFixed(4)})`;
        heroBg.style.filter = `${heroBaseFilter} blur(${blur.toFixed(2)}px)`;
        heroBg.style.opacity = opacity.toFixed(3);
    }

    updateProjectStack();
}

window.addEventListener('scroll', onScrollUI, { passive: true });
onScrollUI();

if (scrollTopBtn) {
    scrollTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// ===============================
//  Magnetic buttons (subtle pull toward cursor)
// ===============================
if (!reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.btn').forEach(btn => {
        btn.addEventListener('mousemove', (e) => {
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            btn.style.transform = `translate(${x * 0.2}px, ${y * 0.3 - 3}px)`;
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = '';
        });
    });
}