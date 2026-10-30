/* =====================================================================
   "ASK ABOUT ME" — recruiter chat (vanilla JS)
   Builds a full-screen overlay, talks to POST /api/chat, renders the
   conversation. No frameworks, no build step.
   ===================================================================== */
(function () {
  "use strict";

  const MAX_CHARS = (window.APP_CONFIG && window.APP_CONFIG.MAX_MESSAGE_CHARS) || 1000;
  const escapeHtml = (window.PortfolioUtil && window.PortfolioUtil.escapeHtml) || function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
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
    '  <p class="ask-hint ask-notice">AI assistant — it can make mistakes. Chats are kept up to 1 hour so follow-ups work. <button class="ask-reset" id="askReset" type="button">New chat</button></p>',
    "</div>",
  ].join("");
  document.body.appendChild(overlay);

  const transcript = overlay.querySelector("#askTranscript");
  const input = overlay.querySelector("#askInput");
  const sendBtn = overlay.querySelector("#askSend");
  const closeBtn = overlay.querySelector(".ask-close");
  const resetBtn = overlay.querySelector("#askReset");

  // Spring-animated caret for the prompt box. It keeps the browser's own
  // caret on touch devices and under prefers-reduced-motion.
  const caret = window.SmoothCaret ? window.SmoothCaret.attach(input) : null;

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
    restoreOnce();
    setTimeout(function () {
      input.focus();
    }, 350);
  }

  function greet() {
    addMessage(
      "assistant",
      "Hi! I'm " + firstName + "'s assistant. Ask me about " + firstName + "'s skills, experience, projects, or how to get in touch."
    );
  }

  // The conversation lives on the server (keyed by an HttpOnly cookie). On the
  // first open, restore it so a page reload doesn't lose context; otherwise greet.
  let restorePromise = null;
  function restoreOnce() {
    if (!restorePromise) {
      restorePromise = fetch("/api/chat/history", { headers: { Accept: "application/json" } })
        .then(function (res) {
          return res.ok ? res.json() : { messages: [] };
        })
        .then(function (data) {
          return Array.isArray(data.messages) ? data.messages : [];
        })
        .catch(function () {
          return [];
        })
        .then(function (messages) {
          messages.forEach(function (m) {
            addMessage(m.role, m.content);
            history.push({ role: m.role, content: m.content });
          });
          if (!history.length) greet();
        });
    }
    return restorePromise;
  }

  async function resetChat() {
    if (isSending) return;
    try {
      const res = await fetch("/api/chat/history", { method: "DELETE" });
      if (!res.ok) throw new Error("reset failed");
    } catch (err) {
      addMessage("error", "Couldn't start a new chat. Please try again.");
      return;
    }
    history.length = 0;
    transcript.innerHTML = "";
    restorePromise = Promise.resolve();
    greet();
    input.focus();
  }

  function close() {
    overlay.classList.remove("is-open");
    document.body.classList.remove("ask-open");
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  // ---- Rendering ----
  function addMessage(role, text, opts) {
    const el = document.createElement("div");
    el.className = "ask-msg " + role;
    if (role === "assistant") {
      el.innerHTML = formatMarkdown(text);
      // Small badge showing the reply was served from cache (no LLM call).
      if (opts && opts.cached) {
        const badge = document.createElement("span");
        badge.className = "ask-cached-badge";
        badge.title = "Served instantly from cache (no AI call)";
        badge.innerHTML = '<i class="fas fa-bolt"></i> cached';
        el.appendChild(badge);
      }
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
    updateSendState();
    await restoreOnce();
    addMessage("user", text);
    history.push({ role: "user", content: text });
    input.value = "";
    autosize();
    if (caret) caret.snap();
    updateSendState();

    const typingEl = showTyping();

    try {
      // Only the new message is sent; the server owns the conversation history.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json().catch(function () {
        return {};
      });
      typingEl.remove();

      if (!res.ok) {
        addMessage("error", data.error || "Something went wrong. Please try again.");
      } else {
        addMessage("assistant", data.reply, { cached: data.cached === true });
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
    if (caret) caret.update();
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
  resetBtn.addEventListener("click", resetChat);

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
})();
