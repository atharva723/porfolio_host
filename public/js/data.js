/* =====================================================================
   PORTFOLIO CONTENT — EDIT THIS FILE ONLY
   ---------------------------------------------------------------------
   This is the ONLY file you need to change to update your portfolio.
   No HTML editing required. After editing, just refresh the page.

   QUICK GUIDE
   - Add a skill / project / experience: copy an existing { ... } block,
     paste it, and change the text. Keep the comma between blocks.
   - Icons come from Font Awesome (https://fontawesome.com/icons).
     Use the full class, e.g. "fab fa-python" or "fas fa-server".
   - In "about.paragraphs" you can use <strong>bold</strong> for emphasis.
   ===================================================================== */

const portfolioData = {

  /* ---- Site / branding ---- */
  site: {
    name: "Atharva Jadhav",                 // nav logo
    pageTitle: "Atharva Jadhav - Cloud Infrastructure Engineer"
  },

  /* ---- Hero (top of the page) ---- */
  hero: {
    tag: "Cloud Infrastructure Engineer",
    firstName: "Atharva ",                  // keep the trailing space
    lastName: "Jadhav",
    subtitle: "Building scalable cloud infrastructure with Azure, DevOps, and automation-first mindset."
  },

  /* ---- About section ---- */
  about: {
    tag: "About Me",
    title: "Building the future of cloud infrastructure",
    paragraphs: [
      "I'm a full-time <strong>Cloud Engineer</strong> at <strong>LTIMindtree</strong>, working primarily in a <strong>DevOps engineering</strong> role. My work focuses on building, deploying, and maintaining scalable cloud infrastructure, with a strong emphasis on Microsoft Azure and modern DevOps practices.",
      "My expertise spans across Azure cloud services, Linux system administration, CI/CD pipelines, infrastructure as code with Terraform, and cloud automation. I'm driven by the challenge of designing secure, efficient, and production-ready systems that power real-world applications.",
      "Beyond cloud and DevOps, I have hands-on experience in <strong>Python full-stack development</strong> and <strong>Machine Learning</strong>. I love developing cool, impactful applications and am deeply fascinated by emerging technologies, constantly exploring new tools and ideas to expand my skill set."
    ],
    // The numbers animate up from 0 when scrolled into view.
    stats: [
      { value: 90,  suffix: "%", label: "Azure Expertise" },
      { value: 10,  suffix: "+", label: "Tech Stack" },
      { value: 2,   suffix: "+", label: "ML Projects" },
      { value: 100, suffix: "%", label: "Dedication" }
    ]
  },

  /* ---- Skills section ---- */
  skills: {
    tag: "Capabilities",
    title: "What I bring to the table",
    description: "A comprehensive skill set focused on modern cloud infrastructure and DevOps practices.",
    items: [
      { icon: "fab fa-python",     name: "Python",            level: "Advanced" },
      { icon: "fab fa-docker",     name: "Docker",            level: "Advanced" },
      { icon: "fas fa-dharmachakra", name: "Kubernetes",      level: "Intermediate" },
      { icon: "fab fa-git-alt",    name: "Git",               level: "Advanced" },
      { icon: "fas fa-infinity",   name: "Azure DevOps",      level: "Advanced" },
      { icon: "fas fa-code",       name: "Terraform",         level: "Intermediate" },
      { icon: "fas fa-brain",      name: "Azure AI",          level: "Intermediate" },
      { icon: "fab fa-microsoft",  name: "Azure App Service", level: "Advanced" }
    ]
  },

  /* ---- Projects section ---- */
  projects: {
    tag: "Projects",
    title: "Featured work",
    description: "Innovative solutions combining machine learning and practical applications.",
    items: [
      {
        title: "Flask OCR Application – Docker & Azure Deployment",
        description: "Built and deployed a production-ready OCR web application using Flask, containerized with Docker and hosted on Azure App Service. Implemented CI/CD automation using GitHub Actions to enable seamless build and deployment workflows.",
        icon: "fas fa-server",
        tech: ["Python", "Flask", "Docker", "Azure App Service", "GitHub Actions", "OCR"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      },
      {
        title: "Containerized Application Deployment on Azure AKS",
        description: "Designed and implemented a production-ready Kubernetes deployment on Azure AKS using a Blue-Green strategy to achieve zero-downtime releases. Automated the complete container lifecycle with Azure DevOps CI/CD pipelines, integrated vulnerability scanning, and enforced enterprise-grade security, scalability, and observability.",
        icon: "fas fa-network-wired",
        tech: ["Azure AKS", "Kubernetes", "Azure DevOps", "Docker", "ACR", "Blue-Green Deployment"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      },
      {
        title: "Weather Dashboard – Microservices Architecture",
        description: "Designed and developed a full-stack weather application using a microservices architecture. Implemented an API Gateway with JWT-based authentication, service-to-service communication, and real-time weather data integration, along with a visually rich and animated frontend.",
        icon: "fas fa-cloud-sun",
        tech: ["Python", "Flask", "Microservices", "JWT Auth", "API Gateway", "Open-Meteo API"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      },
      {
        title: "CinePlex – AI-Powered Movie Discovery Platform",
        description: "Built an AI-driven movie discovery platform that recommends films based on semantic story similarity rather than traditional genre or rating filters. Leveraged NLP sentence embeddings to analyze movie narratives and deliver context-aware, emotionally aligned recommendations through a modern full-stack web application.",
        icon: "fas fa-film",
        tech: ["Python", "Flask", "React", "NLP", "Sentence Transformers", "TMDB API"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      },
      {
        title: "Clothing Store – Full-Stack E-Commerce Application",
        description: "Developed a full-stack e-commerce application simulating a real clothing brand platform. Implemented complete backend-driven cart and order workflows, relational database design, and REST APIs while handling real-world debugging challenges that arise from frontend–backend interaction and persistent data storage.",
        icon: "fas fa-shopping-bag",
        tech: ["HTML", "CSS", "JavaScript", "Node.js", "Express", "SQLite"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      },
      {
        title: "AI Study Prep Platform – PDF to Intelligent Quizzes",
        description: "Built an AI-powered study preparation platform that transforms PDF documents into adaptive, interview-focused quizzes. Integrated Google Gemini AI for automated question generation, implemented difficulty-based assessments, and designed a full-stack system with persistent storage, real-time scoring, and performance tracking.",
        icon: "fas fa-graduation-cap",
        tech: ["Python", "Flask", "Google Gemini AI", "NLP", "SQLite", "PDF Processing"],
        link: "https://github.com/atharvajadhav"  // ← replace with the real repo URL
      }
    ]
  },

  /* ---- Experience section ---- */
  experience: {
    tag: "Experience",
    title: "Professional journey",
    items: [
      {
        role: "Cloud Engineer – DevOps",
        company: "LTIMindtree",
        subtitle: "Cloud & DevOps Engineering (Microsoft Azure)",
        date: "Present",
        points: [
          "Designing, deploying, and managing cloud infrastructure on Microsoft Azure using DevOps best practices",
          "Building and maintaining CI/CD pipelines for automated build, test, and deployment workflows",
          "Containerizing applications using Docker and deploying workloads on Azure services and Kubernetes",
          "Implementing Infrastructure as Code using Terraform for repeatable and scalable environments",
          "Monitoring, optimizing, and securing cloud resources to ensure reliability and performance"
        ]
      },
      {
        role: "Graduate Trainee",
        company: "LTIMindtree",
        subtitle: "Cloud Infrastructure Services (Azure)",
        date: "Earlier",
        points: [
          "Gained strong fundamentals in Azure cloud services, networking, and Linux system administration",
          "Worked with DevOps tools and learned CI/CD concepts through hands-on training and projects",
          "Assisted in infrastructure automation and cloud resource provisioning under senior guidance",
          "Developed a solid understanding of enterprise cloud environments and best practices"
        ]
      }
    ]
  },

  /* ---- Contact section ---- */
  contact: {
    tag: "Get In Touch",
    title: "Let's create something amazing together",
    description: "I'm always open to discussing cloud infrastructure, new opportunities, or tech collaborations.",
    links: [
      {
        icon: "fas fa-envelope",
        label: "Email Me",
        href: "mailto:atharva.jadhav968@gmail.com",
        external: false
      },
      {
        icon: "fab fa-linkedin",
        label: "LinkedIn",
        href: "https://www.linkedin.com/in/atharva-jadhav-b122102b3?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=android_app",
        external: true
      }
    ]
  },

  /* ---- Footer ---- */
  footer: {
    text: "© 2026 Atharva Jadhav. Crafted with passion and precision."
  }
};

// Makes the data available to render.js and script.js (do not remove)
window.portfolioData = portfolioData;
