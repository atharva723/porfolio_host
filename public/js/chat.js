/* =====================================================================
   "ASK ABOUT ME" — recruiter chat (vanilla JS)
   Builds a full-screen overlay, talks to POST /api/chat, renders the
   conversation. No frameworks, no build step.
   ===================================================================== */
(function () {
  "use strict";

  const MAX_CHARS = 1000;
  const ownerName = (window.portfolioData && window.portfolioData.site && window.portfolioData.site.name) || "me";
  const firstName = ownerName.split(" ")[0] || ownerName;

  // Conversation state: [{ role: "user" | "assistant", content }]
  const history = [];
  let isSending = false;
  let lastFocused = null;

  // ---- Build overlay markup ----
  const overlay = document.createElement("div");
  overlay.className = "ask-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Ask about " + ownerName);
  overlay.innerHTML = [
    '<button class="ask-close" type="button" aria-label="Close">',
    '  <i class="fas fa-times"></i>',
    "</button>",
    '<div class="ask-heading">',
    "  <h2>Ask about " + escapeHtml(firstName) + "</h2>",
    "  <p>Curious about my skills, experience, or projects? Ask away.</p>",
    "</div>",
    '<div class="ask-panel">',
    '  <div class="ask-transcript" id="askTranscript" aria-live="polite"></div>',
    '  <div class="ask-inputbox">',
    '    <textarea id="askInput" rows="1" maxlength="' + MAX_CHARS + '" placeholder="Ask me anything about ' + escapeHtml(firstName) + '..."></textarea>',
    '    <div class="ask-inputbox-row">',
    '      <div class="ask-tools" aria-hidden="true">',
    '        <span class="ask-tool"><i class="fas fa-paperclip"></i></span>',
    '        <span class="ask-tool"><i class="fas fa-globe"></i></span>',
    '        <span class="ask-tool"><i class="fas fa-sliders-h"></i></span>',
    '        <span class="ask-tool"><i class="fas fa-code"></i></span>',
    "      </div>",
    '      <button class="ask-send" id="askSend" type="button" aria-label="Send" disabled>',
    '        <i class="fas fa-arrow-up"></i>',
    "      </button>",
    "    </div>",
    "  </div>",
    '  <p class="ask-hint">Press Enter to send · Shift+Enter for a new line · Esc to close</p>',
    "</div>",
  ].join("");
  document.body.appendChild(overlay);

  const transcript = overlay.querySelector("#askTranscript");
  const input = overlay.querySelector("#askInput");
  const sendBtn = overlay.querySelector("#askSend");
  const closeBtn = overlay.querySelector(".ask-close");

  // ---- Open / close ----
  function open() {
    lastFocused = document.activeElement;

    // Close the mobile nav menu if it's open (the button lives inside it).
    const navLinks = document.getElementById("navLinks");
    const menuToggle = document.getElementById("menuToggle");
    if (navLinks && navLinks.classList.contains("active")) {
      navLinks.classList.remove("active");
      const icon = menuToggle && menuToggle.querySelector("i");
      if (icon) {
        icon.classList.add("fa-bars");
        icon.classList.remove("fa-times");
      }
    }

    overlay.classList.add("is-open");
    document.body.classList.add("ask-open");
    if (!history.length) {
      addMessage(
        "assistant",
        "Hi! I'm " + firstName + "'s assistant. Ask me about " + firstName + "'s skills, experience, projects, or how to get in touch."
      );
    }
    setTimeout(function () {
      input.focus();
    }, 350);
  }

  function close() {
    overlay.classList.remove("is-open");
    document.body.classList.remove("ask-open");
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  // ---- Rendering ----
  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = "ask-msg " + role;
    if (role === "assistant") {
      el.innerHTML = formatMarkdown(text);
    } else {
      el.textContent = text;
    }
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }

  // Minimal, XSS-safe markdown -> HTML. Input is HTML-escaped FIRST, so only the
  // whitelisted tags below can ever be produced.
  function formatMarkdown(text) {
    let html = escapeHtml(String(text));

    // Inline code: `code`
    html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");
    // Bold: **text** or __text__
    html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
    // Italic: *text* or _text_
    html = html.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    html = html.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");

    // Bullet lists: lines starting with "- " or "* "
    html = html.replace(/(?:^|\n)[ \t]*[-*] (.+)/g, "\n<li>$1</li>");
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
    html = html.replace(/<\/ul>\s*<ul>/g, "");

    // Remaining newlines -> line breaks
    html = html.replace(/\n/g, "<br>");
    // Tidy stray breaks around lists
    html = html.replace(/<br>\s*(<ul>|<\/ul>|<li>)/g, "$1").replace(/(<\/li>|<\/ul>)\s*<br>/g, "$1");

    return html;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "ask-msg assistant";
    el.innerHTML = '<span class="ask-typing"><span></span><span></span><span></span></span>';
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }

  function updateSendState() {
    const hasText = input.value.trim().length > 0;
    sendBtn.disabled = !hasText || isSending;
    sendBtn.classList.toggle("is-active", hasText && !isSending);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  // ---- Send ----
  async function send() {
    const text = input.value.trim();
    if (!text || isSending) return;

    isSending = true;
    addMessage("user", text);
    history.push({ role: "user", content: text });
    input.value = "";
    autosize();
    updateSendState();

    const typingEl = showTyping();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(0, -1) }),
      });

      const data = await res.json().catch(function () {
        return {};
      });
      typingEl.remove();

      if (!res.ok) {
        addMessage("error", data.error || "Something went wrong. Please try again.");
      } else {
        addMessage("assistant", data.reply);
        history.push({ role: "assistant", content: data.reply });
      }
    } catch (err) {
      typingEl.remove();
      addMessage("error", "Network error. Please check your connection and try again.");
    } finally {
      isSending = false;
      updateSendState();
      input.focus();
    }
  }

  // ---- Events ----
  input.addEventListener("input", function () {
    autosize();
    updateSendState();
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener("click", send);
  closeBtn.addEventListener("click", close);

  overlay.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  // Wire up any trigger buttons on the page
  document.querySelectorAll("[data-ask-trigger]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      open();
    });
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
