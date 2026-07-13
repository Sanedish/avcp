/* =============================================================================
 * Luna Mattins AVCP - Canvas widgets
 * Reusable, dependency-free gauges, a rolling chart and a nav compass/radar.
 *
 * Theme-aware: colours are resolved from the live CSS custom properties (which
 * AVCP.applyTheme rewrites), so re-skinning the panel re-colours the canvases
 * too. Call Gauges.refreshTheme() after a theme change (app.js wires this to the
 * AVCP "theme" event); widgets read the cached COL table every frame.
 * ========================================================================== */
(function (global) {
  "use strict";

  // Live colour cache, refreshed from CSS variables on theme change.
  var COL = {
    accent: "#ff7a18", data: "#3cc6ff",
    grid: "rgba(255,255,255,0.08)", txt: "#e9eef4", dim: "#8d9aa9", bad: "#ff3b3b"
  };
  function refreshTheme() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var v = function (name, fb) { var x = cs.getPropertyValue(name); return (x && x.trim()) || fb; };
      COL.accent = v("--accent", COL.accent);
      COL.data = v("--data", COL.data);
      COL.txt = v("--txt", COL.txt);
      COL.dim = v("--dim", COL.dim);
      COL.bad = v("--bad", COL.bad);
    } catch (e) { /* keep last-known colours */ }
  }
  // Resolve a colour that may be a theme role ("accent"/"data"/"bad") or a
  // literal CSS colour. Lets callers opt into theme-following per element.
  function col(c) {
    if (c === "accent") return COL.accent;
    if (c === "data") return COL.data;
    if (c === "bad") return COL.bad;
    return c || COL.accent;
  }

  function dpr() { return window.devicePixelRatio || 1; }

  function fit(canvas) {
    // No layout size (hidden card, not attached yet) -> skip the frame. Never
    // fall back to canvas.width: that's the DEVICE-pixel backing size, and at
    // dpr>1 re-feeding it here multiplies the canvas by dpr every frame.
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    var r = dpr();
    if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(h * r)) {
      canvas.width = Math.round(w * r);
      canvas.height = Math.round(h * r);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* ----------------------------------------------------------- radial Gauge */
  function Gauge(canvas, opts) {
    this.canvas = canvas;
    opts = opts || {};
    this.min = opts.min || 0;
    this.max = opts.max || 100;
    this.value = opts.min || 0;
    this.target = opts.min || 0;
    this.label = opts.label || "";
    this.unit = opts.unit || "";
    this.redline = opts.redline;               // optional value where arc turns red
    this.accentRole = opts.accent || "accent"; // "accent" | "data" | css colour
    this.decimals = opts.decimals == null ? 0 : opts.decimals;
    this.smoothing = opts.smoothing == null ? 0.25 : opts.smoothing;
    this.showTicks = opts.showTicks !== false;
    this.bigText = opts.bigText !== false;
  }
  Gauge.prototype.set = function (v, max) {
    if (max != null && isFinite(max) && max > 0) this.max = max;
    if (v == null || !isFinite(v)) return; // one NaN frame must not poison the easing forever
    this.target = v;
  };
  // Live re-configuration from the Settings tab (per-gauge adjustments).
  Gauge.prototype.configure = function (cfg) {
    if (!cfg) return;
    if (cfg.smoothing != null) this.smoothing = cfg.smoothing;
    if (cfg.decimals != null) this.decimals = cfg.decimals;
    if (cfg.showTicks != null) this.showTicks = cfg.showTicks;
    if (cfg.max != null) this.max = cfg.max;
    if (cfg.redline != null) this.redline = cfg.redline;
    if (cfg.unit != null) this.unit = cfg.unit;
  };
  Gauge.prototype.draw = function () {
    var f = fit(this.canvas); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    this.value += (this.target - this.value) * this.smoothing;
    var v = this.value, accent = col(this.accentRole);

    var cx = w / 2, cy = h * 0.58, r = Math.min(w, h) * 0.42;
    var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // 270deg sweep
    ctx.clearRect(0, 0, w, h);

    // track
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(6, r * 0.13);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();

    // ticks
    if (this.showTicks) {
      var ticks = 10;
      ctx.strokeStyle = COL.grid;
      ctx.lineWidth = 1.5;
      for (var i = 0; i <= ticks; i++) {
        var a = a0 + (a1 - a0) * (i / ticks);
        var ri = r + ctx.lineWidth, ro = r + r * 0.20;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri);
        ctx.lineTo(cx + Math.cos(a) * ro, cy + Math.sin(a) * ro);
        ctx.stroke();
      }
    }

    // value arc
    var frac = (v - this.min) / (this.max - this.min);
    frac = Math.max(0, Math.min(1, frac));
    var av = a0 + (a1 - a0) * frac;
    var overRed = this.redline != null && v >= this.redline;
    ctx.strokeStyle = overRed ? COL.bad : accent;
    ctx.lineWidth = Math.max(6, r * 0.13);
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, av); ctx.stroke();

    // redline marker
    if (this.redline != null) {
      var rf = (this.redline - this.min) / (this.max - this.min);
      var ra = a0 + (a1 - a0) * Math.max(0, Math.min(1, rf));
      ctx.strokeStyle = COL.bad; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ra) * (r - r * 0.12), cy + Math.sin(ra) * (r - r * 0.12));
      ctx.lineTo(cx + Math.cos(ra) * (r + r * 0.10), cy + Math.sin(ra) * (r + r * 0.10));
      ctx.stroke();
    }

    // numbers
    ctx.fillStyle = COL.txt;
    ctx.textAlign = "center";
    if (this.bigText) {
      ctx.font = "700 " + Math.round(r * 0.46) + "px 'Segoe UI',Roboto,sans-serif";
      ctx.fillText(v.toFixed(this.decimals), cx, cy + r * 0.10);
    }
    ctx.fillStyle = COL.dim;
    ctx.font = "600 " + Math.round(r * 0.16) + "px 'Segoe UI',Roboto,sans-serif";
    ctx.fillText(this.unit, cx, cy + r * 0.42);
    ctx.fillStyle = accent;
    ctx.font = "700 " + Math.round(r * 0.17) + "px 'Segoe UI',Roboto,sans-serif";
    ctx.fillText(this.label, cx, cy - r * 0.62);
  };

  /* -------------------------------------------------------------- G-G meter */
  function GMeter(canvas) {
    this.canvas = canvas;
    this.gx = 0; this.gy = 0;
    this.maxLat = 0; this.maxLon = 0;
    this.peak = null;          // {x,y,mag} session-peak position for the ghost dot
    this.history = [];
  }
  GMeter.prototype.set = function (gx, gy) { this.gx = gx; this.gy = gy; };
  GMeter.prototype.reset = function () { this.maxLat = 0; this.maxLon = 0; this.history = []; this.peak = null; };
  GMeter.prototype.draw = function () {
    var f = fit(this.canvas); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.44;
    var maxG = 2, scale = R / maxG;
    ctx.clearRect(0, 0, w, h);

    // rings
    ctx.strokeStyle = COL.grid; ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
    for (var g = 1; g <= maxG; g++) {
      ctx.beginPath(); ctx.arc(cx, cy, scale * g, 0, Math.PI * 2);
      if (g === maxG) ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COL.dim; ctx.font = "10px monospace"; ctx.textAlign = "left";
      ctx.fillText(g + "g", cx + 2, cy - scale * g + 12);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
    }
    ctx.strokeStyle = COL.grid;
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

    this.maxLat = Math.max(this.maxLat, Math.abs(this.gx));
    this.maxLon = Math.max(this.maxLon, Math.abs(this.gy));

    var px = cx + this.gx * scale;
    var py = cy - this.gy * scale;

    // remember the furthest-from-centre point this session for the ghost marker
    var mag = Math.sqrt(this.gx * this.gx + this.gy * this.gy);
    if (!this.peak || mag > this.peak.mag) this.peak = { gx: this.gx, gy: this.gy, mag: mag };

    // trail is stored in g-space, not pixels, so a canvas resize (maximize,
    // layout edit) re-projects it instead of smearing stale coordinates
    this.history.push([this.gx, this.gy]);
    if (this.history.length > 40) this.history.shift();
    var trailRgb = COL.accent;
    for (var i = 1; i < this.history.length; i++) {
      ctx.strokeStyle = global.AVCP ? global.AVCP.rgba(trailRgb, i / this.history.length) : trailRgb;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + this.history[i - 1][0] * scale, cy - this.history[i - 1][1] * scale);
      ctx.lineTo(cx + this.history[i][0] * scale, cy - this.history[i][1] * scale);
      ctx.stroke();
    }

    // peak-hold ghost ring
    if (this.peak && this.peak.mag > 0.08) {
      var gpx = cx + this.peak.gx * scale, gpy = cy - this.peak.gy * scale;
      ctx.strokeStyle = global.AVCP ? global.AVCP.rgba(COL.bad, 0.6) : COL.bad;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(gpx, gpy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = global.AVCP ? global.AVCP.rgba(COL.bad, 0.18) : COL.bad;
      ctx.beginPath(); ctx.arc(gpx, gpy, 7, 0, Math.PI * 2); ctx.fill();
    }

    // live dot
    ctx.fillStyle = COL.accent;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();

    // readouts
    ctx.fillStyle = COL.txt; ctx.font = "600 12px 'Segoe UI',sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("lat " + this.gx.toFixed(2) + "g (max " + this.maxLat.toFixed(2) + ")", 8, h - 20);
    ctx.fillText("lon " + this.gy.toFixed(2) + "g (max " + this.maxLon.toFixed(2) + ")", 8, h - 6);
  };

  /* ----------------------------------------------------------- rolling chart */
  function Chart(canvas, series) {
    this.canvas = canvas;
    // series: [{name,color,max}]  (color may be a theme role or css colour)
    this.series = series.map(function (s) { return { name: s.name, color: s.color, max: s.max || 1, data: [] }; });
    this.cap = 240;
  }
  Chart.prototype.push = function (vals) {
    for (var i = 0; i < this.series.length; i++) {
      var s = this.series[i];
      s.data.push(vals[i] || 0);
      if (s.data.length > this.cap) s.data.shift();
      if (vals[i] > s.max) s.max = vals[i] * 1.1;
    }
  };
  Chart.prototype.draw = function () {
    var f = fit(this.canvas); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var pad = 4;
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (var gy = 0; gy <= 4; gy++) {
      var y = pad + (h - 2 * pad) * gy / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (var si = 0; si < this.series.length; si++) {
      var s = this.series[si], c = col(s.color);
      if (s.data.length < 2) continue;
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i < s.data.length; i++) {
        var x = w * i / (this.cap - 1);
        var yy = pad + (h - 2 * pad) * (1 - Math.max(0, Math.min(1, s.data[i] / s.max)));
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      ctx.fillStyle = c; ctx.font = "600 11px 'Segoe UI',sans-serif"; ctx.textAlign = "left";
      ctx.fillText(s.name, 6, 14 + si * 14);
    }
  };

  /* ------------------------------------------------ nav compass + trail radar
   * Heading-up local radar: outer rose shows true compass bearing, the inner
   * plot traces recent world positions rotated into the vehicle frame (forward
   * = up). No terrain tiles - it's a positional breadcrumb radar, not a map. */
  function Compass(canvas) {
    this.canvas = canvas;
    this.heading = 0;        // radians, 0 = +Y (north), from sensors.yaw
    this.trail = [];         // recent world {x,y}
    this.pos = null;         // latest world {x,y,z}
    this.cap = 300;
  }
  Compass.prototype.setHeading = function (rad) { if (typeof rad === "number" && isFinite(rad)) this.heading = rad; };
  Compass.prototype.pushPos = function (p) {
    if (!p || typeof p.x !== "number") return;
    this.pos = p;
    var last = this.trail[this.trail.length - 1];
    // only record meaningful movement so idling doesn't flood the buffer
    if (!last || Math.abs(last.x - p.x) > 0.3 || Math.abs(last.y - p.y) > 0.3) {
      this.trail.push({ x: p.x, y: p.y });
      if (this.trail.length > this.cap) this.trail.shift();
    }
  };
  Compass.prototype.reset = function () { this.trail = []; this.pos = null; };
  Compass.prototype.draw = function () {
    var f = fit(this.canvas); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
    var hd = this.heading;

    // outer ring
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.66, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.33, 0, Math.PI * 2); ctx.stroke();

    // cardinal marks (rotate opposite to heading so N stays true north)
    var marks = [["N", 0], ["E", Math.PI / 2], ["S", Math.PI], ["W", -Math.PI / 2]];
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var i = 0; i < marks.length; i++) {
      var ang = marks[i][1] - hd;            // screen angle (0 = up)
      var sx = cx + Math.sin(ang) * (R + 0), sy = cy - Math.cos(ang) * (R + 0);
      var lx = cx + Math.sin(ang) * (R - 14), ly = cy - Math.cos(ang) * (R - 14);
      ctx.strokeStyle = COL.dim; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(lx, ly); ctx.stroke();
      ctx.fillStyle = marks[i][0] === "N" ? COL.accent : COL.dim;
      ctx.font = "700 12px 'Segoe UI',sans-serif";
      ctx.fillText(marks[i][0], cx + Math.sin(ang) * (R - 26), cy - Math.cos(ang) * (R - 26));
    }

    // trail: scale to fit, plotted relative to current position & heading
    if (this.pos && this.trail.length > 1) {
      var span = 1;
      for (var t = 0; t < this.trail.length; t++) {
        span = Math.max(span, Math.abs(this.trail[t].x - this.pos.x), Math.abs(this.trail[t].y - this.pos.y));
      }
      var s = (R * 0.92) / span;
      var cosH = Math.cos(hd), sinH = Math.sin(hd);
      ctx.strokeStyle = COL.data; ctx.lineWidth = 2; ctx.beginPath();
      for (var k = 0; k < this.trail.length; k++) {
        var dx = this.trail[k].x - this.pos.x, dy = this.trail[k].y - this.pos.y;
        // rotate world delta into vehicle frame (forward = +Y/up)
        var rx = dx * cosH - dy * sinH, ry = dx * sinH + dy * cosH;
        var X = cx + rx * s, Y = cy - ry * s;
        if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }

    // vehicle arrow (always pointing up = forward)
    ctx.fillStyle = COL.accent;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx - 6, cy + 7);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx + 6, cy + 7);
    ctx.closePath(); ctx.fill();

    // bearing readout
    var deg = ((hd * 180 / Math.PI) % 360 + 360) % 360;
    var card = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
    ctx.fillStyle = COL.txt; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.font = "700 13px 'Segoe UI',sans-serif";
    ctx.fillText(deg.toFixed(0) + "° " + card, 8, h - 8);
  };

  /* -------------------------------------------------------------- bar (h/v) */
  function bar(canvas, value, opts) {
    opts = opts || {};
    var f = fit(canvas); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var frac = Math.max(0, Math.min(1, value));
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, 0, 0, w, h, 4); ctx.fill();
    ctx.fillStyle = col(opts.color);
    if (opts.vertical) {
      roundRect(ctx, 0, h * (1 - frac), w, h * frac, 4); ctx.fill();
    } else {
      roundRect(ctx, 0, 0, w * frac, h, 4); ctx.fill();
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2; if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  refreshTheme();
  global.Gauges = {
    Gauge: Gauge, GMeter: GMeter, Chart: Chart, Compass: Compass, bar: bar,
    refreshTheme: refreshTheme, col: col,
    // legacy literals kept for any external reference; prefer theme roles
    ACCENT: "#ff7a18", ACCENT2: "#3cc6ff"
  };
})(window);
