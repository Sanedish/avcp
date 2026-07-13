/* =============================================================================
 * Luna Mattins AVCP - Settings, themes, units & local persistence
 *
 * ┌─ PERSISTENCE - READ ME ───────────────────────────────────────────────────┐
 * │ This module owns every localStorage preference the panel keeps (other      │
 * │ modules read/write it through AVCP.Store).                                 │
 * │                                                                            │
 * │  • localStorage is sandboxed PER-ORIGIN inside the browser / in-game CEF   │
 * │    profile. It is NOT a file write: it never touches BeamNG game files,    │
 * │    the Steam install, or the user folder on disk. Clearing the browser /   │
 * │    CEF cache wipes it. Nothing here can affect game integrity, so it stays │
 * │    within the "don't modify game files" spirit of the read-only mod.       │
 * │  • Every key is namespaced under "avcp." so it can never collide with the  │
 * │    game's own UI storage.                                                  │
 * │  • All access is wrapped in try/catch. In a locked-down / private context  │
 * │    where storage throws, we transparently fall back to an in-memory store: │
 * │    settings still work for the session, they just don't survive a reload.  │
 * │                                                                            │
 * │  Stored keys:                                                              │
 * │    avcp.theme   - active theme id (see THEMES) or "custom"                 │
 * │    avcp.accent  - custom accent colour (hex), used when theme == "custom"  │
 * │    avcp.data    - custom data/secondary colour (hex), used when "custom"   │
 * │    avcp.units   - "metric" | "imperial"  (legacy preset; seeds units2)     │
 * │    avcp.units2  - JSON, per-quantity units (speed/temp/dist/pressure)      │
 * │    avcp.gauges  - JSON, per-gauge config (see GAUGE_DEFAULTS)              │
 * │    avcp.layout  - JSON, per-tab card order & hidden cards                  │
 * │    avcp.alerts  - JSON, shift light & overspeed warning config             │
 * │    avcp.uiScale - whole-panel zoom in % (80–130)                           │
 * │    avcp.startTab - tab id to open on launch                                │
 * │    avcp.profiles - JSON, named saved setting profiles                      │
 * │    avcp.customCss / customCssOn - user stylesheet (applied last)           │
 * │    avcp.keys    - "on" | "off"  (global keyboard shortcuts)                │
 * │    avcp.intro   - "on" | "off"  (first-launch intro video)                 │
 * │    avcp.introSeen - "1" once the intro has been attempted/shown            │
 * │    avcp.datalab - JSON, Data Lab prefs (rate, categories, view mode)       │
 * │    (Data Lab recordings live in their own IndexedDB DB: avcp_telemetry)    │
 * └────────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */
(function (global) {
  "use strict";

  // ----------------------------------------- localStorage wrapper (namespaced)
  var NS = "avcp.";
  var mem = {}; // fallback used when localStorage is unavailable / throws
  var canStore = (function () {
    try {
      var k = NS + "__probe";
      localStorage.setItem(k, "1"); localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  var Store = {
    available: canStore,
    get: function (key, def) {
      try {
        var v = canStore ? localStorage.getItem(NS + key) : mem[key];
        return v == null ? def : v;
      } catch (e) { return mem[key] == null ? def : mem[key]; }
    },
    set: function (key, val) {
      mem[key] = val;
      try { if (canStore) localStorage.setItem(NS + key, val); } catch (e) { /* in-memory only */ }
    },
    getJSON: function (key, def) {
      var raw = this.get(key, null);
      if (raw == null) return def;
      try { return JSON.parse(raw); } catch (e) { return def; }
    },
    setJSON: function (key, obj) { this.set(key, JSON.stringify(obj)); }
  };

  // ----------------------------------------------------------- tiny emitter
  var listeners = {};
  function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); return AVCP; }
  function emit(evt, a) {
    (listeners[evt] || []).forEach(function (f) { try { f(a); } catch (e) { console.error("AVCP listener", evt, e); } });
  }

  // ----------------------------------------------------------- colour helpers
  function hexToRgb(h) {
    h = String(h || "").trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return { r: 255, g: 122, b: 24 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) { var c = hexToRgb(hex); return "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")"; }

  // --------------------------------------------------------------- themes
  // Each theme only needs to declare its two signature colours; the derived
  // tokens (soft fill, hairline, focus ring) are computed from the accent so a
  // custom colour automatically gets a coherent set.
  var THEMES = {
    orange:  { name: "Ember",     accent: "#ff7a18", data: "#3cc6ff" },
    cyan:    { name: "Ion",       accent: "#18c6ff", data: "#ff9d3c" },
    green:   { name: "Toxic",     accent: "#34d058", data: "#3cc6ff" },
    crimson: { name: "Redline",   accent: "#ff4d4d", data: "#ffb13c" },
    violet:  { name: "Synthwave", accent: "#b07bff", data: "#3cffe0" },
    amber:   { name: "Hazard",    accent: "#ffb000", data: "#5fd0ff" },
    mono:    { name: "Graphite",  accent: "#cdd6e2", data: "#7f8c9c" }
  };

  function currentColors() {
    var id = Store.get("theme", "orange");
    if (id === "custom") {
      return { id: "custom", accent: Store.get("accent", "#ff7a18"), data: Store.get("data", "#3cc6ff") };
    }
    var t = THEMES[id] || THEMES.orange;
    return { id: id in THEMES ? id : "orange", accent: t.accent, data: t.data };
  }

  // Apply theme by overriding the relevant CSS custom properties on <html>.
  // Inline properties on documentElement beat the :root rule in style.css, so a
  // single call re-skins every DOM widget; canvas widgets pick the new colours
  // up through Gauges.refreshTheme() (wired from the "theme" event in app.js).
  function applyTheme() {
    var c = currentColors();
    var s = document.documentElement.style;
    s.setProperty("--accent", c.accent);
    s.setProperty("--accent-soft", rgba(c.accent, 0.13));
    s.setProperty("--accent-line", rgba(c.accent, 0.45));
    s.setProperty("--ring", "0 0 0 3px " + rgba(c.accent, 0.18));
    s.setProperty("--data", c.data);
    emit("theme", c);
  }

  // ---------------------------------------------------------------- units
  // v0.4: per-quantity unit preferences (a car person may want km/h + psi, or
  // mph + bar). avcp.units2 holds the granular prefs; the legacy avcp.units
  // metric/imperial value seeds them on first run and the old preset buttons
  // keep working as bulk setters.
  var UNIT_CHOICES = {
    speed: ["kmh", "mph"],
    temp: ["c", "f"],
    dist: ["km", "mi"],
    press: ["psi", "bar", "kpa"]
  };
  // memoized: the render loop converts units many times per frame, and a
  // localStorage read + JSON.parse per conversion adds up at 60 Hz
  var unitsCache = null;
  function unitPrefs() {
    if (unitsCache) return unitsCache;
    var p = Store.getJSON("units2", null);
    if (!p) {
      var imp = Store.get("units", "metric") === "imperial";
      p = imp ? { speed: "mph", temp: "f", dist: "mi", press: "psi" }
              : { speed: "kmh", temp: "c", dist: "km", press: "psi" };
    }
    var out = {};
    for (var k in UNIT_CHOICES) {
      out[k] = UNIT_CHOICES[k].indexOf(p[k]) >= 0 ? p[k] : UNIT_CHOICES[k][0];
    }
    unitsCache = out;
    return out;
  }
  function unitSystem() { return unitPrefs().speed === "mph" ? "imperial" : "metric"; }
  var Units = {
    get system() { return unitSystem(); },   // legacy-ish; follows the speed unit
    prefs: unitPrefs,
    // each returns { val:Number, unit:String } so callers format consistently
    speed: function (kmh) {
      return unitPrefs().speed === "mph" ? { val: kmh / 1.609344, unit: "mph" } : { val: kmh, unit: "km/h" };
    },
    dist: function (km) {
      return unitPrefs().dist === "mi" ? { val: km / 1.609344, unit: "mi" } : { val: km, unit: "km" };
    },
    temp: function (c) {
      return unitPrefs().temp === "f" ? { val: c * 9 / 5 + 32, unit: "°F" } : { val: c, unit: "°C" };
    },
    press: function (psi) {
      var u = unitPrefs().press;
      if (u === "bar") return { val: psi / 14.5038, unit: "bar" };
      if (u === "kpa") return { val: psi * 6.89476, unit: "kPa" };
      return { val: psi, unit: "psi" };
    },
    // altitude / elevation follows the distance system
    alt: function (m) {
      return unitPrefs().dist === "mi" ? { val: m * 3.28084, unit: "ft" } : { val: m, unit: "m" };
    }
  };
  function setUnit(key, val) {
    if (!(key in UNIT_CHOICES) || UNIT_CHOICES[key].indexOf(val) < 0) return;
    var p = unitPrefs(); p[key] = val;
    Store.setJSON("units2", p);
    unitsCache = null;
    emit("units", unitSystem());
  }

  // ----------------------------------------------------- per-gauge config
  var GAUGE_DEFAULTS = {
    speedMax: 240,    // km/h full-scale on the speed dial (stored in metric)
    rpmMax: 0,        // 0 = auto from engineInfo; otherwise a fixed ceiling
    redlinePct: 90,   // redline as a % of max RPM
    smoothing: 25,    // needle easing, 5 (floaty) .. 60 (snappy), as a %
    speedDecimals: 0,
    showTicks: true
  };
  var gaugeCache = null; // memoized for the same reason as unitPrefs
  function gaugeCfg() {
    if (gaugeCache) return gaugeCache;
    var c = Store.getJSON("gauges", {}) || {};
    var out = {};
    for (var k in GAUGE_DEFAULTS) out[k] = (c[k] != null) ? c[k] : GAUGE_DEFAULTS[k];
    gaugeCache = out;
    return out;
  }
  function setGauge(key, val) {
    var c = Store.getJSON("gauges", {}) || {};
    c[key] = val; Store.setJSON("gauges", c);
    gaugeCache = null;
    emit("gauges", gaugeCfg());
  }
  function resetGauges() { Store.set("gauges", "{}"); gaugeCache = null; emit("gauges", gaugeCfg()); }

  // ----------------------------------------------- appearance / background
  // Personalization layer: a custom local background image (or a built-in
  // gradient preset) painted behind the whole panel, plus an optional
  // glassmorphism treatment on the cards & top bar. The lightweight prefs live
  // in localStorage under one "appearance" JSON key; the (potentially large)
  // custom image blob lives in IndexedDB instead - also browser/CEF-sandboxed,
  // never a game-file write, so it stays as ToS-clean as the localStorage prefs
  // while sidestepping localStorage's ~5 MB quota. Nothing here is sent anywhere.
  var APPEARANCE_DEFAULTS = {
    bgMode: "none",     // "none" | "preset" | "custom" | "remote"
    bgPreset: "aurora", // active preset when bgMode === "preset"
    bgUrl: "",          // image URL when bgMode === "remote" (online gallery)
    bgBlur: 0,          // px blur on the background layer (mainly for photos)
    bgDim: 45,          // % dark scrim over the background (keeps cards legible)
    glass: false,       // frosted translucent cards + top bar
    glassBlur: 14,      // px backdrop blur for glass surfaces
    glassOpacity: 60    // % tint solidity (higher = more opaque / more legible)
  };

  // Built-in, file-free gradient backgrounds. `css` is the full background-image
  // value; `swatch` is the little preview dot. Aurora is theme-driven, so it
  // re-tints whenever the accent/data colours change.
  var BG_PRESETS = {
    aurora: {
      name: "Aurora",
      css: function () {
        var c = currentColors();
        return "radial-gradient(90% 90% at 12% 6%," + rgba(c.accent, 0.42) + " 0%,rgba(0,0,0,0) 55%)," +
               "radial-gradient(85% 85% at 88% 96%," + rgba(c.data, 0.38) + " 0%,rgba(0,0,0,0) 55%)," +
               "linear-gradient(135deg,#0b1018 0%,#0c1014 100%)";
      },
      swatch: function () { var c = currentColors(); return "linear-gradient(135deg," + c.accent + "," + c.data + ")"; }
    },
    midnight: {
      name: "Midnight",
      css: "radial-gradient(120% 100% at 50% 0%,#16233b 0%,#0a0f17 62%),linear-gradient(#0a0f17,#070b11)",
      swatch: "linear-gradient(135deg,#1b3a6b,#0a0f17)"
    },
    sunset: {
      name: "Sunset",
      css: "linear-gradient(160deg,#2a1633 0%,#3a1d2b 34%,#56291f 68%,#0e0a12 100%)",
      swatch: "linear-gradient(135deg,#ff7a18,#b07bff)"
    },
    carbon: {
      name: "Carbon",
      css: "repeating-linear-gradient(45deg,#0d1116 0,#0d1116 11px,#0f151b 11px,#0f151b 22px)",
      swatch: "linear-gradient(135deg,#2a323c,#0d1116)"
    }
  };

  function appearance() {
    var c = Store.getJSON("appearance", {}) || {};
    var out = {};
    for (var k in APPEARANCE_DEFAULTS) out[k] = (c[k] != null) ? c[k] : APPEARANCE_DEFAULTS[k];
    return out;
  }
  function setAppearance(key, val) {
    var c = Store.getJSON("appearance", {}) || {};
    c[key] = val; Store.setJSON("appearance", c);
    applyAppearance();
  }
  function resetAppearance() { Store.set("appearance", "{}"); applyAppearance(); }

  // --- IndexedDB blob store for the custom background image -----------------
  // Single key/value store. All access is promise-based and fully guarded: if
  // IndexedDB is unavailable or throws (locked-down context), uploads still work
  // for the session via the in-memory `customImg` cache, they just don't persist.
  var IMG_DB = "avcp_assets", IMG_STORE = "kv", IMG_KEY = "bgImage";
  var customImg = null;      // cached data URL once loaded / set
  var customLoaded = false;  // have we tried reading IndexedDB yet this session?
  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(IMG_DB, 1);
        r.onupgradeneeded = function () { try { r.result.createObjectStore(IMG_STORE); } catch (e) { /* exists */ } };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function idbReq(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IMG_STORE, mode), st = tx.objectStore(IMG_STORE);
        var q = fn(st);
        tx.oncomplete = function () { res(q ? q.result : true); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function loadBackgroundImage() {
    return idbReq("readonly", function (st) { return st.get(IMG_KEY); })
      .then(function (v) { customImg = v || null; customLoaded = true; return customImg; })
      .catch(function () { customLoaded = true; return null; });
  }
  function setBackgroundImage(dataURL) {
    customImg = dataURL; customLoaded = true;
    var c = Store.getJSON("appearance", {}) || {}; c.bgMode = "custom"; Store.setJSON("appearance", c);
    applyAppearance();
    return idbReq("readwrite", function (st) { st.put(dataURL, IMG_KEY); }).catch(function (e) {
      console.warn("[AVCP] background image could not be persisted (session-only):", e);
    });
  }
  function clearBackgroundImage() {
    customImg = null; customLoaded = true;
    var c = Store.getJSON("appearance", {}) || {}; if (c.bgMode === "custom") c.bgMode = "none"; Store.setJSON("appearance", c);
    applyAppearance();
    return idbReq("readwrite", function (st) { st.delete(IMG_KEY); }).catch(function () { /* ignore */ });
  }

  // --- apply -----------------------------------------------------------------
  // Two fixed, full-viewport layers sit BEHIND all content: #bgLayer (the image,
  // optionally blurred) and #bgScrim (the dimming overlay). They live directly on
  // <body> with a negative z-index - deliberately NOT a transformed/backdrop-
  // filtered ancestor of the cards, so the position:fixed "maximize" feature
  // keeps resolving against the viewport (see style.css maximize note).
  function ensureBgLayers() {
    if (!document.body) return;
    if (!document.getElementById("bgLayer")) {
      var l = document.createElement("div"); l.id = "bgLayer";
      document.body.insertBefore(l, document.body.firstChild);
    }
    if (!document.getElementById("bgScrim")) {
      var s = document.createElement("div"); s.id = "bgScrim";
      var bl = document.getElementById("bgLayer");
      document.body.insertBefore(s, bl ? bl.nextSibling : document.body.firstChild);
    }
  }
  function applyAppearance() {
    ensureBgLayers();
    var a = appearance();
    var html = document.documentElement, s = html.style;
    // glass tokens + toggle
    html.classList.toggle("glass", !!a.glass);
    s.setProperty("--glass-blur", a.glassBlur + "px");
    s.setProperty("--glass-opacity", (a.glassOpacity / 100).toFixed(3));
    // background tokens
    s.setProperty("--bg-blur", a.bgBlur + "px");
    s.setProperty("--bg-dim", (a.bgDim / 100).toFixed(3));
    // background image source
    if (a.bgMode === "custom") {
      if (customImg) {
        s.setProperty("--bg-image", 'url("' + customImg + '")'); html.classList.add("has-bg");
      } else if (!customLoaded) {
        loadBackgroundImage().then(function () { applyAppearance(); }); // re-apply once loaded
      } else {
        s.setProperty("--bg-image", "none"); html.classList.remove("has-bg");
      }
    } else if (a.bgMode === "preset") {
      var p = BG_PRESETS[a.bgPreset] || BG_PRESETS.aurora;
      s.setProperty("--bg-image", typeof p.css === "function" ? p.css() : p.css);
      html.classList.add("has-bg");
    } else if (a.bgMode === "remote" && a.bgUrl) {
      // online-gallery background: displayed straight from the URL (a CSS
      // background needs no CORS); nothing is downloaded into storage
      s.setProperty("--bg-image", 'url("' + String(a.bgUrl).replace(/"/g, "%22") + '")');
      html.classList.add("has-bg");
    } else {
      s.setProperty("--bg-image", "none"); html.classList.remove("has-bg");
    }
    emit("appearance", a);
  }

  // --------------------------------------------------------------- exports
  var AVCP = {
    Store: Store,
    on: on, emit: emit,
    rgba: rgba,
    // theme
    THEMES: THEMES,
    applyTheme: applyTheme,
    currentColors: currentColors,
    activeTheme: function () { return Store.get("theme", "orange"); },
    setTheme: function (id) { Store.set("theme", id); applyTheme(); },
    setCustom: function (accent, data) {
      if (accent) Store.set("accent", accent);
      if (data) Store.set("data", data);
      Store.set("theme", "custom"); applyTheme();
    },
    // units
    Units: Units,
    UNIT_CHOICES: UNIT_CHOICES,
    setUnit: setUnit,
    setUnits: function (sys) {
      var imp = sys === "imperial";
      Store.set("units", imp ? "imperial" : "metric");
      Store.setJSON("units2", imp
        ? { speed: "mph", temp: "f", dist: "mi", press: "psi" }
        : { speed: "kmh", temp: "c", dist: "km", press: "psi" });
      unitsCache = null;
      emit("units", unitSystem());
    },
    // gauges
    GAUGE_DEFAULTS: GAUGE_DEFAULTS,
    gaugeCfg: gaugeCfg,
    setGauge: setGauge,
    resetGauges: resetGauges,
    // appearance / background
    APPEARANCE_DEFAULTS: APPEARANCE_DEFAULTS,
    BG_PRESETS: BG_PRESETS,
    appearance: appearance,
    setAppearance: setAppearance,
    resetAppearance: resetAppearance,
    applyAppearance: applyAppearance,
    loadBackgroundImage: loadBackgroundImage,
    setBackgroundImage: setBackgroundImage,
    clearBackgroundImage: clearBackgroundImage,
    hasBackgroundImage: function () { return !!customImg; },
    // misc prefs
    keysEnabled: function () { return Store.get("keys", "on") !== "off"; },
    setKeysEnabled: function (b) { Store.set("keys", b ? "on" : "off"); emit("keys", b); }
  };
  global.AVCP = AVCP;

  // Apply the persisted theme + appearance immediately so the first paint is
  // already skinned and (if set) wearing the user's background / glass.
  applyTheme();
  applyAppearance();
  // re-tint the theme-driven Aurora preset whenever the palette changes
  on("theme", function () {
    var a = appearance();
    if (a.bgMode === "preset" && a.bgPreset === "aurora") applyAppearance();
  });
})(window);
