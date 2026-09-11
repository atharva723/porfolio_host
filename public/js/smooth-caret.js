/* =====================================================================
   SMOOTH CARET - spring-animated caret for <input> / <textarea>.

   Hides the native caret and paints a custom one that glides to the real
   caret position. The position is measured with a hidden "mirror" element
   that clones the field's typography and box metrics, so this works for
   multi-line, wrapping textareas (2D: x and y), not just single-line inputs.

   Vanilla port of the framer-motion smooth-input pattern - same spring
   constants, no framework, no build step.

   Falls back to the native caret on touch devices and when the user asks
   for reduced motion.

   Usage: const ctl = SmoothCaret.attach(textareaEl);
          ctl.update();  // re-measure (e.g. after resizing the field)
          ctl.snap();    // jump without animating (e.g. after clearing)
   ===================================================================== */
(function () {
  "use strict";

  // Spring constants match the reference framer-motion config.
  const STIFFNESS = 500;
  const DAMPING = 30;
  const MASS = 0.5;
  const REST_OFFSET = 0.1;      // px - close enough to snap to target
  const REST_SPEED = 2;         // px/s - slow enough to call it settled
  const MAX_SUBSTEP = 1 / 240;  // s - keeps the physics stable on slow frames
  const MAX_FRAME = 1 / 30;     // s - clamp after tab switches
  const BLINK_DELAY = 620;      // ms idle before the caret starts blinking

  // Typography + box metrics the mirror must reproduce exactly.
  const MIRRORED_STYLES = [
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "fontFeatureSettings", "fontVariationSettings",
    "letterSpacing", "wordSpacing", "lineHeight",
    "textTransform", "textIndent", "textAlign", "direction",
    "whiteSpace", "wordBreak", "overflowWrap", "tabSize"
  ];

  const mqFinePointer = window.matchMedia("(pointer: fine)");
  const mqReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function onMediaChange(mq, fn) {
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", fn);
    else if (typeof mq.addListener === "function") mq.addListener(fn);
  }

  function attach(el) {
    if (!el || !el.parentNode || el.dataset.smoothCaret === "on") return null;
    el.dataset.smoothCaret = "on";

    // ---- DOM scaffolding ----
    const field = document.createElement("div");
    field.className = "smooth-caret-field";
    el.parentNode.insertBefore(field, el);
    field.appendChild(el);

    const mirror = document.createElement("div");
    mirror.className = "smooth-caret-mirror";
    mirror.setAttribute("aria-hidden", "true");

    const marker = document.createElement("span");
    marker.className = "smooth-caret-marker";
    marker.textContent = "\u200b";

    const caret = document.createElement("span");
    caret.className = "smooth-caret";
    caret.setAttribute("aria-hidden", "true");

    field.appendChild(mirror);
    field.appendChild(caret);

    // ---- Spring state ----
    let x = 0, y = 0;    // current
    let tx = 0, ty = 0;  // target
    let vx = 0, vy = 0;  // velocity
    let height = 0;
    let rafPhysics = 0;
    let lastTime = 0;
    let visible = false;
    let composing = false;
    let blinkTimer = 0;
    let scheduled = 0;
    let scheduledSnap = false;

    function usesCustomCaret() {
      return mqFinePointer.matches && !mqReducedMotion.matches;
    }

    function syncMirrorStyles() {
      const cs = window.getComputedStyle(el);
      for (let i = 0; i < MIRRORED_STYLES.length; i++) {
        const prop = MIRRORED_STYLES[i];
        mirror.style[prop] = cs[prop];
      }
    }

    // Caret box, in pixels, relative to the field wrapper's origin.
    function measure(caretIndex) {
      // clientWidth excludes the border and any scrollbar, so the mirror wraps
      // text at exactly the same column as the real field.
      mirror.style.width = el.clientWidth + "px";
      mirror.textContent = el.value.slice(0, caretIndex);
      mirror.appendChild(marker);

      const markerRect = marker.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();
      const fieldRect = field.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();

      const cs = window.getComputedStyle(el);
      const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const fontSize = parseFloat(cs.fontSize) || 16;

      // Offset inside the field's own border box, corrected for its scroll.
      const localX = markerRect.left - mirrorRect.left + borderLeft - el.scrollLeft;
      const localY = markerRect.top - mirrorRect.top + borderTop - el.scrollTop;

      return {
        x: localX + (elRect.left - fieldRect.left),
        y: localY + (elRect.top - fieldRect.top),
        h: markerRect.height || fontSize * 1.2,
        localY: localY
      };
    }

    function draw() {
      caret.style.transform =
        "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)";
    }

    function step(now) {
      rafPhysics = 0;
      const frame = Math.min((now - lastTime) / 1000, MAX_FRAME);
      lastTime = now;

      const substeps = Math.max(1, Math.ceil(frame / MAX_SUBSTEP));
      const dt = frame / substeps;
      for (let i = 0; i < substeps; i++) {
        vx += ((-STIFFNESS * (x - tx) - DAMPING * vx) / MASS) * dt;
        vy += ((-STIFFNESS * (y - ty) - DAMPING * vy) / MASS) * dt;
        x += vx * dt;
        y += vy * dt;
      }

      const settled =
        Math.abs(tx - x) < REST_OFFSET && Math.abs(vx) < REST_SPEED &&
        Math.abs(ty - y) < REST_OFFSET && Math.abs(vy) < REST_SPEED;

      if (settled) { x = tx; y = ty; vx = 0; vy = 0; }
      draw();
      if (!settled) rafPhysics = requestAnimationFrame(step);
    }

    function setTarget(nextX, nextY, nextHeight, snap) {
      if (nextHeight !== height) {
        height = nextHeight;
        caret.style.height = height.toFixed(2) + "px";
      }
      tx = nextX;
      ty = nextY;

      // Snap on first appearance too, so the caret never flies in from 0,0.
      if (snap || !visible || mqReducedMotion.matches) {
        x = tx; y = ty; vx = 0; vy = 0;
        if (rafPhysics) { cancelAnimationFrame(rafPhysics); rafPhysics = 0; }
        draw();
        return;
      }
      if (!rafPhysics) {
        lastTime = performance.now();
        rafPhysics = requestAnimationFrame(step);
      }
    }

    function restartBlink() {
      caret.classList.remove("is-idle");
      clearTimeout(blinkTimer);
      blinkTimer = setTimeout(function () {
        caret.classList.add("is-idle");
      }, BLINK_DELAY);
    }

    function show() {
      if (visible) return;
      visible = true;
      field.classList.add("is-caret-visible");
    }

    function hide() {
      clearTimeout(blinkTimer);
      caret.classList.remove("is-idle");
      if (rafPhysics) { cancelAnimationFrame(rafPhysics); rafPhysics = 0; }
      if (!visible) return;
      visible = false;
      field.classList.remove("is-caret-visible");
    }

    function update(snap) {
      if (!usesCustomCaret() || composing || document.activeElement !== el) {
        hide();
        return;
      }

      const start = el.selectionStart;
      const end = el.selectionEnd;
      // A range selection draws its own highlight; a caret would just be noise.
      if (start === null || start === undefined || start !== end) {
        hide();
        return;
      }

      const pos = measure(start);

      // Caret sits outside the rows currently scrolled into view.
      if (pos.localY + pos.h < -1 || pos.localY > el.clientHeight + 1) {
        hide();
        return;
      }

      setTarget(pos.x, pos.y, pos.h, snap === true);
      show();
      restartBlink();
    }

    // Batch to the next frame so we measure after any synchronous layout work
    // (autosize, class toggles) that runs in the same event.
    function schedule(snap) {
      if (snap) scheduledSnap = true;
      if (scheduled) return;
      scheduled = requestAnimationFrame(function () {
        scheduled = 0;
        const snapNow = scheduledSnap;
        scheduledSnap = false;
        update(snapNow);
      });
    }

    function resync(snap) {
      syncMirrorStyles();
      schedule(snap !== false);
    }

    // ---- Events ----
    el.addEventListener("input", function () { schedule(false); });
    el.addEventListener("keyup", function () { schedule(false); });
    el.addEventListener("click", function () { schedule(false); });
    el.addEventListener("scroll", function () { schedule(true); });
    el.addEventListener("focus", function () { schedule(true); });
    el.addEventListener("blur", hide);
    el.addEventListener("compositionstart", function () { composing = true; hide(); });
    el.addEventListener("compositionend", function () { composing = false; schedule(true); });

    // Arrow keys, drag-select and programmatic selection changes.
    document.addEventListener("selectionchange", function () {
      if (document.activeElement === el) schedule(false);
    });

    window.addEventListener("resize", function () { resync(true); });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { resync(true); }).observe(el);
    }

    // Web fonts change every metric the mirror depends on.
    if (document.fonts) {
      if (typeof document.fonts.addEventListener === "function") {
        document.fonts.addEventListener("loadingdone", function () { resync(true); });
      }
      if (document.fonts.ready && typeof document.fonts.ready.then === "function") {
        document.fonts.ready.then(function () { resync(true); });
      }
    }

    function syncMode() {
      const custom = usesCustomCaret();
      field.classList.toggle("is-native-caret", !custom);
      if (custom) resync(true);
      else hide();
    }

    onMediaChange(mqFinePointer, syncMode);
    onMediaChange(mqReducedMotion, syncMode);

    syncMirrorStyles();
    syncMode();

    return {
      update: function () { schedule(false); },
      snap: function () { schedule(true); },
      element: el
    };
  }

  window.SmoothCaret = { attach: attach };
})();