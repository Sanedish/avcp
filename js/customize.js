/* =============================================================================
 * Luna Mattins AVCP - Customization layer
 *
 *   Layout editor - every card on every tab can be hidden or re-ordered
 *                   (drag on desktop, ◀ ▶ arrows everywhere). The layout is
 *                   stored per tab with the card COUNT at save time: if a
 *                   future version adds/removes cards on a tab, that tab's
 *                   saved layout is ignored instead of scrambling - the
 *                   layout self-heals across updates.
 *   Driving alerts- shift light (flashes the screen edges at the configured
 *                   redline) and an overspeed warning with a unit-aware
 *                   threshold. Evaluated on the telemetry stream cadence via
 *                   Customize.tick() from app.js; DOM is only touched when
 *                   the alert state actually changes.
 *   Interface    - whole-panel UI scale (Chromium zoom, 80–130 %) and a
 *                   startup-tab choice.
 *   Profiles     - named snapshots of the entire panel setup (theme, units,
 *                   gauges, appearance, layout, alerts, scale…), saved
 *                   locally, exportable/importable as JSON. Applying a
 *                   profile reloads the page - the only honest way to
 *                   re-render every subsystem.
 *   Online gallery- optional, user-triggered fetch of a manifest from the
 *                   Malo Interactive CDN with shareable themes, backgrounds
 *                   and profiles. Nothing is fetched until "Browse" is
 *                   clicked; backgrounds are displayed straight from their
 *                   URL (no CORS needed), the manifest + profile JSONs need
 *                   CORS headers on the CDN (see cdn-upload/README.md).
 *
 * Everything persists through AVCP.Store (localStorage, avcp.*) - never a
 * game-file write. app.js calls Customize.init({ toast, closeMaximized }).
 * ========================================================================== */
(function (global) {
  "use strict";

  var AVCP = global.AVCP;
  if (!AVCP) return;
  var Store = AVCP.Store;

  var ctx = null; // { toast, closeMaximized }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function toast(m) { if (ctx && ctx.toast) ctx.toast(m); }

  // avcp.galleryUrl in localStorage overrides this - handy for testing a new
  // manifest before uploading it to the CDN (see cdn-upload/README.md)
  function galleryUrl() {
    return Store.get("galleryUrl", "https://cdn.boykisser.cloud/malo-interactive/avcp/gallery.json");
  }

  /* ========================================================== layout editor */
  var editing = false, dragCard = null;

  function assignCardIds() {
    $$(".page").forEach(function (p) {
      $$(".card", p).forEach(function (c, i) { c.dataset.lid = p.id + ":" + i; });
    });
  }

  function applyLayout() {
    var cfg = Store.getJSON("layout", {}) || {};
    $$(".page").forEach(function (p) {
      var cards = $$(".card", p), pc = cfg[p.id];
      if (!pc || pc.count !== cards.length) return; // card set changed → ignore
      var byId = {};
      cards.forEach(function (c) { byId[c.dataset.lid] = c; });
      (pc.order || []).forEach(function (id) {
        var el = byId[id];
        if (el) el.parentNode.appendChild(el); // sequential appends = final order
      });
      (pc.hidden || []).forEach(function (id) {
        if (byId[id]) byId[id].classList.add("layout-hidden");
      });
    });
  }

  function persistLayout() {
    var cfg = {};
    $$(".page").forEach(function (p) {
      var cards = $$(".card", p);
      cfg[p.id] = {
        count: cards.length,
        order: cards.map(function (c) { return c.dataset.lid; }),
        hidden: cards.filter(function (c) { return c.classList.contains("layout-hidden"); })
          .map(function (c) { return c.dataset.lid; })
      };
    });
    Store.setJSON("layout", cfg);
  }

  function resetLayout() {
    Store.set("layout", "{}");
    $$(".page").forEach(function (p) {
      // original source order = the numeric suffix of the boot-assigned id
      var cards = $$(".card", p).sort(function (a, b) {
        return parseInt(a.dataset.lid.split(":")[1], 10) - parseInt(b.dataset.lid.split(":")[1], 10);
      });
      cards.forEach(function (c) {
        c.classList.remove("layout-hidden");
        c.parentNode.appendChild(c);
      });
    });
  }

  function siblingCard(card, dir) {
    var el = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    while (el && !el.classList.contains("card")) el = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    return el;
  }

  function injectLayoutTools() {
    $$(".card").forEach(function (card) {
      var bar = document.createElement("div");
      bar.className = "layout-tools";
      bar.innerHTML = '<span class="lt-grip">⠿ drag to move</span>' +
        '<button type="button" class="lt-btn" data-lt="back" title="Move earlier">◀</button>' +
        '<button type="button" class="lt-btn" data-lt="fwd" title="Move later">▶</button>' +
        '<button type="button" class="lt-btn" data-lt="eye" title="Show / hide this card">👁</button>';
      card.appendChild(bar);
      bar.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("[data-lt]") : null;
        if (!b) return;
        ev.stopPropagation();
        if (b.dataset.lt === "eye") {
          card.classList.toggle("layout-hidden");
        } else {
          var ref = siblingCard(card, b.dataset.lt === "back" ? -1 : 1);
          if (ref) {
            if (b.dataset.lt === "back") card.parentNode.insertBefore(card, ref);
            else card.parentNode.insertBefore(ref, card);
          }
        }
        persistLayout();
      });

      // drag & drop reorder (desktop); the card reflows live under the pointer
      card.addEventListener("dragstart", function (ev) {
        if (!editing) { ev.preventDefault(); return; }
        dragCard = card;
        card.classList.add("layout-drag");
        try { ev.dataTransfer.setData("text/plain", card.dataset.lid); } catch (e) { /* CEF quirk */ }
        ev.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", function () {
        card.classList.remove("layout-drag");
        dragCard = null;
        persistLayout();
      });
      card.addEventListener("dragover", function (ev) {
        if (!editing || !dragCard || dragCard === card || dragCard.parentNode !== card.parentNode) return;
        ev.preventDefault();
        var r = card.getBoundingClientRect();
        var midY = r.top + r.height / 2, midX = r.left + r.width / 2;
        var before = ev.clientY < midY - r.height * 0.15 ? true
          : ev.clientY > midY + r.height * 0.15 ? false
            : ev.clientX < midX;
        card.parentNode.insertBefore(dragCard, before ? card : card.nextSibling);
      });
    });
  }

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle("layout-editing", editing);
    $$(".card").forEach(function (c) { c.draggable = editing; });
    if (editing) {
      if (ctx && ctx.closeMaximized) ctx.closeMaximized();
      toast("layout editor: drag or use ◀ ▶ to move, 👁 to hide - works on every tab");
    } else {
      persistLayout();
      toast("layout saved");
    }
  }

  /* ========================================================= driving alerts */
  var ALERT_DEFAULTS = { shift: false, speed: false, speedKmh: 120 };
  var alertsCache = null, alertEl = null, alertState = "";

  function alertCfg() {
    if (!alertsCache) {
      var c = Store.getJSON("alerts", {}) || {}, out = {};
      for (var k in ALERT_DEFAULTS) out[k] = c[k] != null ? c[k] : ALERT_DEFAULTS[k];
      alertsCache = out;
    }
    return alertsCache;
  }
  function setAlert(key, val) {
    var c = alertCfg(); c[key] = val;
    Store.setJSON("alerts", c);
    alertsCache = null;
  }

  // called from app.js on every telemetry frame (spd in km/h, rpm, engine max)
  function tick(spdKmh, rpm, maxRpm) {
    var cfg = alertCfg();
    if (!cfg.shift && !cfg.speed) {
      if (alertState) { alertState = ""; if (alertEl) alertEl.className = ""; }
      return;
    }
    var g = AVCP.gaugeCfg();
    var ceil = g.rpmMax > 0 ? g.rpmMax : (maxRpm || 0);
    var shift = cfg.shift && ceil > 0 && rpm >= ceil * (g.redlinePct / 100);
    var over = cfg.speed && spdKmh >= cfg.speedKmh;
    var st = (shift ? "s" : "") + (over ? "v" : "");
    if (st === alertState) return;
    alertState = st;
    if (!alertEl) {
      alertEl = document.createElement("div");
      alertEl.id = "alertOverlay";
      document.body.appendChild(alertEl);
    }
    alertEl.classList.toggle("shift", shift);
    alertEl.classList.toggle("over", over);
  }

  function renderAlertUI() {
    var cfg = alertCfg();
    var sh = $("#alShift"), sp = $("#alSpeed"), val = $("#alSpeedVal"), unit = $("#alSpeedUnit");
    if (!sh) return;
    sh.classList.toggle("on", !!cfg.shift);
    sp.classList.toggle("on", !!cfg.speed);
    var d = AVCP.Units.speed(cfg.speedKmh);
    val.value = Math.round(d.val);
    unit.textContent = d.unit;
  }

  /* ============================================================== interface */
  function applyScale() {
    var s = parseInt(Store.get("uiScale", "100"), 10) || 100;
    document.body.style.zoom = s === 100 ? "" : (s / 100);
  }

  /* =============================================================== profiles */
  // A profile is a snapshot of these raw avcp.* values. Keys absent from a
  // profile are REMOVED on apply, so loading one lands you exactly where it
  // was saved. (The custom background image lives in IndexedDB and is not
  // part of a profile - too big to export; a remote/preset background is.)
  var PROFILE_KEYS = ["theme", "accent", "data", "units", "units2", "gauges",
    "appearance", "layout", "alerts", "uiScale", "startTab", "keys",
    "customCss", "customCssOn"];

  function captureProfile() {
    var o = {};
    PROFILE_KEYS.forEach(function (k) {
      var v = Store.get(k, null);
      if (v != null) o[k] = v;
    });
    return o;
  }
  function applyProfile(settings) {
    PROFILE_KEYS.forEach(function (k) {
      if (settings[k] != null) Store.set(k, settings[k]);
      else { try { localStorage.removeItem("avcp." + k); } catch (e) { /* ignore */ } }
    });
    toast("profile applied - reloading…");
    setTimeout(function () { location.reload(); }, 350);
  }

  function profiles() { return Store.getJSON("profiles", {}) || {}; }

  function renderProfiles() {
    var box = $("#profList");
    if (!box) return;
    var all = profiles(), names = Object.keys(all).sort();
    if (!names.length) {
      box.innerHTML = '<div class="hint">No profiles yet - set the panel up how you like it, then save it here.</div>';
      return;
    }
    box.innerHTML = names.map(function (n) {
      var d = all[n].savedAt ? new Date(all[n].savedAt) : null;
      function p2(x) { return ("0" + x).slice(-2); }
      var when = d ? d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) : "";
      return '<div class="dl-row" data-name="' + escapeHtml(n) + '">' +
        '<div class="dl-row-main"><b>' + escapeHtml(n) + "</b><span>" + when + "</span></div>" +
        '<div class="dl-row-actions">' +
        '<button class="mini" data-pact="load">load</button>' +
        '<button class="mini" data-pact="export">export</button>' +
        '<button class="mini danger" data-pact="del">✕</button>' +
        "</div></div>";
    }).join("");
    $$("#profList [data-pact]").forEach(function (b) {
      b.addEventListener("click", function () {
        var name = this.parentNode.parentNode.dataset.name;
        var all2 = profiles(), p = all2[name];
        if (!p) return;
        if (this.dataset.pact === "load") { applyProfile(p.settings || {}); }
        else if (this.dataset.pact === "export") {
          download(new Blob([JSON.stringify({ format: "avcp-profile-1", name: name, savedAt: p.savedAt, settings: p.settings }, null, 2)],
            { type: "application/json" }), "avcp-profile-" + safeName(name) + ".json");
          toast("profile exported");
        } else {
          if (!this.classList.contains("confirm")) {
            var self = this;
            this.classList.add("confirm"); this.textContent = "sure?";
            setTimeout(function () { self.classList.remove("confirm"); self.textContent = "✕"; }, 2500);
            return;
          }
          delete all2[name];
          Store.setJSON("profiles", all2);
          renderProfiles();
          toast("profile deleted");
        }
      });
    });
  }

  function saveProfile() {
    var name = ($("#profName").value || "").trim();
    if (!name) { toast("give the profile a name"); return; }
    var all = profiles();
    all[name] = { savedAt: new Date().toISOString(), settings: captureProfile() };
    Store.setJSON("profiles", all);
    $("#profName").value = "";
    renderProfiles();
    toast("profile “" + name + "” saved");
  }

  function importProfile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var d;
      try { d = JSON.parse(fr.result); } catch (e) { toast("not valid JSON"); return; }
      if (!d || d.format !== "avcp-profile-1" || typeof d.settings !== "object") {
        toast("not an AVCP profile export"); return;
      }
      var name = d.name || file.name.replace(/\.json$/i, "");
      var all = profiles();
      all[name] = { savedAt: d.savedAt || new Date().toISOString(), settings: d.settings };
      Store.setJSON("profiles", all);
      renderProfiles();
      toast("imported “" + name + "” - click load to apply");
    };
    fr.readAsText(file);
  }

  /* ============================================================= custom css */
  // A user-authored stylesheet, appended LAST in <head> so it wins the cascade
  // against the panel's own rules (theme tokens set inline on <html> need
  // !important to override - the placeholder text explains this). Stored like
  // every other preference; applied via textContent, so nothing in it can
  // break out of the <style> element. Toggling off keeps the text.
  var CSS_MAX = 65536;
  function applyCustomCss() {
    var el = document.getElementById("customCssStyle");
    if (!el) {
      el = document.createElement("style");
      el.id = "customCssStyle";
      document.head.appendChild(el);
    }
    var on = Store.get("customCssOn", "on") !== "off";
    el.textContent = on ? Store.get("customCss", "") : "";
  }
  function renderCssState() {
    var st = $("#cssState");
    if (st) st.textContent = Store.get("customCssOn", "on") !== "off" ? "on" : "off";
  }

  /* ========================================================= online gallery */
  function browseGallery() {
    var box = $("#galleryBox");
    box.innerHTML = '<div class="hint">loading gallery…</div>';
    fetch(galleryUrl(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(renderGallery)
      .catch(function (e) {
        box.innerHTML = '<div class="hint">Couldn’t load the gallery (' + escapeHtml(e.message) +
          "). It needs internet access, and the manifest must be reachable with CORS enabled on the CDN.</div>";
      });
  }

  function renderGallery(g) {
    var box = $("#galleryBox");
    if (!g || g.format !== "avcp-gallery-1") {
      box.innerHTML = '<div class="hint">The gallery manifest has an unexpected format.</div>';
      return;
    }
    // note: themes are deliberately LOCAL (Settings → Theme presets + custom
    // colours); a manifest "themes" array is ignored if present
    var html = "";
    if (g.backgrounds && g.backgrounds.length) {
      html += '<label class="slider-label">Backgrounds</label><div class="bg-grid">';
      g.backgrounds.forEach(function (b, i) {
        html += '<button class="bg-swatch" data-gbg="' + i + '">' +
          '<i style="background-image:url(\'' + escapeHtml(b.thumb || b.url) + '\');background-size:cover;background-position:center"></i>' +
          "<span>" + escapeHtml(b.name || "image") + "</span></button>";
      });
      html += "</div>";
    }
    if (g.profiles && g.profiles.length) {
      html += '<label class="slider-label">Profiles</label><div class="dl-list">';
      g.profiles.forEach(function (p, i) {
        html += '<div class="dl-row"><div class="dl-row-main"><b>' + escapeHtml(p.name || "profile") +
          "</b><span>" + escapeHtml(p.description || "") + "</span></div>" +
          '<div class="dl-row-actions"><button class="mini" data-gpr="' + i + '">apply</button></div></div>';
      });
      html += "</div>";
    }
    box.innerHTML = html || '<div class="hint">The gallery is empty right now.</div>';

    $$("#galleryBox [data-gbg]").forEach(function (el) {
      el.addEventListener("click", function () {
        var b = g.backgrounds[parseInt(this.dataset.gbg, 10)];
        AVCP.setAppearance("bgUrl", b.url);
        AVCP.setAppearance("bgMode", "remote");
        if (!AVCP.appearance().glass) AVCP.setAppearance("glass", true);
        toast("background “" + (b.name || "image") + "” applied");
      });
    });
    $$("#galleryBox [data-gpr]").forEach(function (el) {
      el.addEventListener("click", function () {
        var p = g.profiles[parseInt(this.dataset.gpr, 10)];
        toast("fetching profile…");
        fetch(p.url, { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (d) {
            if (!d || d.format !== "avcp-profile-1" || typeof d.settings !== "object") throw new Error("bad format");
            applyProfile(d.settings);
          })
          .catch(function (e) { toast("profile failed to load (" + e.message + ")"); });
      });
    });
  }

  /* ================================================================ helpers */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeName(s) { return String(s).replace(/[^\w\-]+/g, "_").slice(0, 60) || "profile"; }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ================================================================== init */
  function init(c) {
    if (ctx) return;
    ctx = c;
    injectLayoutTools();

    // layout
    $("#layoutEdit").addEventListener("click", function () { setEditing(!editing); });
    $("#layoutDone").addEventListener("click", function () { setEditing(false); });
    $("#layoutReset").addEventListener("click", function () { resetLayout(); toast("layout reset to default"); });

    // interface: scale + startup tab
    var sc = $("#uiScale"), scv = $("#uiScaleVal");
    var cur = parseInt(Store.get("uiScale", "100"), 10) || 100;
    sc.value = cur; scv.textContent = cur + "%";
    sc.addEventListener("input", function () {
      scv.textContent = this.value + "%";
      Store.set("uiScale", this.value);
      applyScale();
    });
    var sel = $("#startTabSel");
    sel.innerHTML = $$(".tab").map(function (t) {
      return '<option value="' + t.dataset.tab + '">' + escapeHtml(t.textContent) + "</option>";
    }).join("");
    sel.value = Store.get("startTab", "dashboard");
    if (!sel.value) sel.value = "dashboard";
    sel.addEventListener("change", function () { Store.set("startTab", this.value); toast("startup tab: " + this.options[this.selectedIndex].text); });

    // units (granular selects)
    $$("#unitsFine select").forEach(function (s) {
      s.value = AVCP.Units.prefs()[s.dataset.unit];
      s.addEventListener("change", function () { AVCP.setUnit(this.dataset.unit, this.value); });
    });
    AVCP.on("units", function () {
      $$("#unitsFine select").forEach(function (s) { s.value = AVCP.Units.prefs()[s.dataset.unit]; });
      renderAlertUI();
    });

    // alerts
    $("#alShift").addEventListener("click", function () { setAlert("shift", !alertCfg().shift); renderAlertUI(); });
    $("#alSpeed").addEventListener("click", function () { setAlert("speed", !alertCfg().speed); renderAlertUI(); });
    $("#alSpeedVal").addEventListener("change", function () {
      var v = parseFloat(this.value) || 0;
      // input shows the active speed unit; store canonical km/h
      var kmh = AVCP.Units.prefs().speed === "mph" ? v * 1.609344 : v;
      setAlert("speedKmh", Math.max(10, Math.round(kmh)));
      renderAlertUI();
    });
    renderAlertUI();

    // profiles
    $("#profSave").addEventListener("click", saveProfile);
    $("#profName").addEventListener("keydown", function (e) { if (e.key === "Enter") saveProfile(); });
    $("#profImport").addEventListener("click", function () { $("#profImportFile").click(); });
    $("#profImportFile").addEventListener("change", function () {
      var f = this.files && this.files[0]; this.value = "";
      if (f) importProfile(f);
    });
    renderProfiles();

    // custom css
    var cssBox = $("#cssBox");
    cssBox.value = Store.get("customCss", "");
    $("#cssApply").addEventListener("click", function () {
      var css = cssBox.value;
      if (css.length > CSS_MAX) { toast("CSS too large (max 64 KB)"); return; }
      Store.set("customCss", css);
      Store.set("customCssOn", "on");
      applyCustomCss(); renderCssState();
      toast(css.trim() ? "custom CSS applied" : "custom CSS emptied");
    });
    $("#cssToggle").addEventListener("click", function () {
      Store.set("customCssOn", Store.get("customCssOn", "on") !== "off" ? "off" : "on");
      applyCustomCss(); renderCssState();
      toast("custom CSS " + (Store.get("customCssOn", "on") !== "off" ? "on" : "off"));
    });
    $("#cssClear").addEventListener("click", function () {
      if (!this.classList.contains("confirm")) {
        var self = this;
        this.classList.add("confirm"); this.textContent = "sure?";
        setTimeout(function () { self.classList.remove("confirm"); self.textContent = "clear saved css"; }, 2500);
        return;
      }
      this.classList.remove("confirm"); this.textContent = "clear saved css";
      cssBox.value = "";
      Store.set("customCss", "");
      applyCustomCss();
      toast("custom CSS cleared");
    });
    renderCssState();

    // gallery
    $("#galleryBrowse").addEventListener("click", browseGallery);
  }

  global.Customize = { init: init, tick: tick };

  // applied immediately so the first paint already wears the user's layout,
  // scale and stylesheet (this script runs at the end of <body>, DOM is ready)
  assignCardIds();
  applyLayout();
  applyScale();
  applyCustomCss();
})(window);
