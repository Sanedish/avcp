/* =============================================================================
 * Luna Mattins AVCP - First-launch intro splash
 *
 * Plays the Malo Interactive splash video ONCE per browser/CEF profile, picking
 * the portrait (9:16) or landscape (16:9) cut to match the viewport at launch.
 *
 * Misfire-proofing (the rules of the intro):
 *   • The "seen" flag is written through AVCP.Store the moment the intro is
 *     ATTEMPTED - not when it finishes - so a crash, reload or codec failure
 *     mid-video can never make it loop on every launch.
 *   • Settings → Intro can disable it permanently (avcp.intro = "off"); the
 *     same card can replay it on demand.
 *   • prefers-reduced-motion suppresses the auto-play entirely (manual replay
 *     from Settings still works).
 *
 * Sources: the local copies shipped under media/ are tried first. If they are
 * missing or the host refuses to serve them (e.g. a video-stripped package or
 * a VFS that won't serve .webm), the same files are fetched once from the
 * Malo Interactive CDN. If neither loads inside its timeout the intro
 * dismisses itself silently - it must never hold the panel hostage.
 *
 * Storage: avcp.intro ("on"|"off") + avcp.introSeen ("1") in localStorage via
 * AVCP.Store. Browser-sandboxed; never a game-file write.
 * ========================================================================== */
(function (global) {
  "use strict";

  var AVCP = global.AVCP;
  if (!AVCP || !AVCP.Store) return; // settings.js must load first
  var Store = AVCP.Store;

  // [local, CDN] - each tier gets its own watchdog timeout before we move on.
  var SOURCES = [
    {
      portrait: "media/malo-interactive-splash-9x16.webm",
      landscape: "media/malo-interactive-splash-16x9.webm",
      timeout: 4000
    },
    {
      portrait: "https://cdn.boykisser.cloud/malo-interactive/malo-interactive-splash-9x16.webm",
      landscape: "https://cdn.boykisser.cloud/malo-interactive/malo-interactive-splash-16x9.webm",
      timeout: 9000
    }
  ];
  // absolute ceiling: whatever happens, the overlay self-destructs after this
  var HARD_CAP_MS = 90000;

  function enabled() { return Store.get("intro", "on") !== "off"; }
  function seen() { return Store.get("introSeen", "") === "1"; }
  function orientationKey() {
    return window.innerHeight > window.innerWidth ? "portrait" : "landscape";
  }

  var showing = false;

  function show(manual) {
    if (showing) return;
    showing = true;
    if (!manual) Store.set("introSeen", "1"); // attempted = seen (see header)

    var key = orientationKey();
    var tier = 0, watchdog = null, hardCap = null, done = false;

    var ov = document.createElement("div");
    ov.className = "intro-splash";

    var vid = document.createElement("video");
    vid.muted = true;                 // required for autoplay everywhere
    vid.autoplay = true;
    vid.playsInline = true;
    vid.setAttribute("playsinline", "");
    vid.preload = "auto";
    ov.appendChild(vid);

    var skip = document.createElement("button");
    skip.className = "intro-skip"; skip.type = "button";
    skip.textContent = "Skip intro";
    ov.appendChild(skip);



    function dismiss() {
      if (done) return;
      done = true;
      clearTimeout(watchdog); clearTimeout(hardCap);
      document.removeEventListener("keydown", onKey);
      ov.classList.add("leaving");
      try { vid.pause(); } catch (e) { /* already torn down */ }
      setTimeout(function () {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        vid.removeAttribute("src"); try { vid.load(); } catch (e) { /* noop */ }
        showing = false;
      }, 500);
    }

    function fail(forTier) {
      if (done || forTier !== tier) return; // stale watchdog / error
      tier++;
      if (tier >= SOURCES.length) { dismiss(); return; }
      setSource();
    }

    function setSource() {
      var s = SOURCES[tier], myTier = tier;
      clearTimeout(watchdog);
      watchdog = setTimeout(function () { fail(myTier); }, s.timeout);
      vid.src = s[key];
      var p = vid.play();
      if (p && p.catch) p.catch(function () { /* watchdog handles it */ });
    }

    vid.addEventListener("error", function () { fail(tier); });
    vid.addEventListener("playing", function () {
      clearTimeout(watchdog);
      ov.classList.add("playing");
    });
    vid.addEventListener("ended", dismiss);

    skip.addEventListener("click", function (e) { e.stopPropagation(); dismiss(); });
    ov.addEventListener("click", dismiss); // anywhere skips

    function onKey(e) { if (e.key === "Escape" || e.key === " " || e.key === "Enter") dismiss(); }
    document.addEventListener("keydown", onKey);

    hardCap = setTimeout(dismiss, HARD_CAP_MS);
    document.body.appendChild(ov);
    setSource();
  }

  // ------------------------------------------------------- Settings wiring
  function syncUI() {
    var st = document.getElementById("introState");
    if (st) st.textContent = enabled() ? "on" : "off";
    var t = document.getElementById("introToggle");
    if (t) t.classList.toggle("on", enabled());
  }
  (function wire() {
    var t = document.getElementById("introToggle");
    var r = document.getElementById("introReplay");
    if (t) t.addEventListener("click", function () {
      Store.set("intro", enabled() ? "off" : "on");
      syncUI();
    });
    if (r) r.addEventListener("click", function () { show(true); });
    syncUI();
  })();

  global.AVCPIntro = { show: show, syncUI: syncUI };

  // ------------------------------------------------------------- auto-run
  var reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* old engine */ }
  if (enabled() && !seen()) {
    if (reduced) { Store.set("introSeen", "1"); }   // respect the OS setting
    else show(false);
  }
})(window);
