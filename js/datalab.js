/* =============================================================================
 * Luna Mattins AVCP - Data Lab (telemetry recorder, library & analyzer)
 *
 * Engineer-grade data extraction for the panel:
 *
 *   Recorder  - samples the live streams into named channels at a selectable
 *               rate (1–60 Hz). Record everything ("extensive") or narrow the
 *               scope per category for long sessions. Markers can be dropped
 *               while recording (button or the M shortcut). A take auto-saves
 *               to the library on stop, so data can never be lost to a
 *               mis-click.
 *   Library   - recordings persist in IndexedDB ("avcp_telemetry"; browser-
 *               sandboxed exactly like the panel's other storage - never a
 *               game-file write). Each take can be reloaded, exported as CSV
 *               (spreadsheet/MoTeC-style wide table) or JSON, or deleted.
 *               JSON exports re-import losslessly, so takes can be shared.
 *   Analyzer  - multi-channel graph with overlay and per-channel lane modes,
 *               min/max-binned rendering (no aliasing at any zoom), wheel
 *               zoom + minimap pan, a data cursor with interpolated readouts,
 *               per-channel min/avg/max stats, marker flags and a playback
 *               transport (0.25–4×, loop). "Drive dashboard" feeds recorded
 *               values back into the shared telemetry state so the panel's
 *               real gauges replay the take - live stream data is ignored
 *               while it is on (app.js checks DataLab.isDriving()).
 *               "Actuate vehicle" goes one step further and replays the
 *               recorded DRIVER INPUTS into the real car over the bridge
 *               (open-loop input.event replay - see the actuation section).
 *
 * Wiring: app.js calls DataLab.init({ br, T, toast, vehicleName }) at boot.
 * Recording/analysis only read the already-streaming state; the single place
 * this module SENDS Lua is the opt-in actuation replay.
 * ========================================================================== */
(function (global) {
  "use strict";

  var ctx = null; // injected: { br, T, toast, vehicleName }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function toast(m) { if (ctx && ctx.toast) ctx.toast(m); }

  // ----------------------------------------------------------- channel model
  var CATS = [
    { id: "inputs", name: "Driver inputs" },
    { id: "power",  name: "Powertrain" },
    { id: "dyn",    name: "Dynamics" },
    { id: "therm",  name: "Thermals" },
    { id: "brakes", name: "Brakes" },
    { id: "wheels", name: "Wheels & tires" }
  ];
  var PAL = ["#ff7a18", "#3cc6ff", "#34d058", "#ffd21a", "#b07bff", "#ff4d4d",
    "#5fd0ff", "#ff9d3c", "#3cffe0", "#cdd6e2", "#e6cd73", "#9fb0c3",
    "#5fe07f", "#ff7d7d", "#d99a5b", "#7f8c9c"];

  function num(v) { return (v == null || !isFinite(v)) ? NaN : Number(v); }
  function ch(id, label, unit, cat, get, set) {
    return { id: id, label: label, unit: unit, cat: cat, get: get, set: set || null };
  }
  function wheelRows(T) {
    var w = T.wheelInfo;
    var arr = !w ? [] : (Array.isArray(w) ? w : Object.keys(w).map(function (k) { return w[k]; }));
    return arr.filter(function (v) { return v && typeof v[0] === "string"; })
      .sort(function (a, b) { return a[0] > b[0] ? 1 : -1; });
  }
  function rowByName(T, name) {
    var rows = wheelRows(T);
    for (var i = 0; i < rows.length; i++) if (rows[i][0] === name) return rows[i];
    return null;
  }

  // The full channel catalog for the CURRENT vehicle. Wheel/brake channels are
  // generated from the live wheel set at record start (4-wheelers, 6-wheel
  // trucks and trailers all get correct channel lists).
  function buildChannels(T) {
    var defs = [
      // --- driver inputs ---
      ch("throttle", "Throttle", "%", "inputs",
        function (T) { return num(T.electrics.throttle) * 100; },
        function (T, v) { T.electrics.throttle = v / 100; }),
      ch("brake", "Brake", "%", "inputs",
        function (T) { return num(T.electrics.brake) * 100; },
        function (T, v) { T.electrics.brake = v / 100; }),
      ch("clutch", "Clutch", "%", "inputs",
        function (T) { return num(T.electrics.clutch) * 100; },
        function (T, v) { T.electrics.clutch = v / 100; }),
      ch("steering", "Steering", "%", "inputs",
        function (T) {
          var s = T.electrics.steering_input != null ? T.electrics.steering_input : T.electrics.steering;
          return num(s) * 100;
        },
        function (T, v) { T.electrics.steering_input = v / 100; }),
      ch("handbrake", "Handbrake", "%", "inputs",
        function (T) { return num(T.electrics.parkingbrake) * 100; },
        function (T, v) { T.electrics.parkingbrake = v / 100; }),

      // --- powertrain ---
      ch("speed", "Wheel speed", "km/h", "power",
        function (T) { return Math.abs(num(T.electrics.wheelspeed) * 3.6); },
        function (T, v) { T.electrics.wheelspeed = v / 3.6; }),
      ch("airspeed", "Airspeed", "km/h", "power",
        function (T) { return Math.abs(num(T.electrics.airspeed) * 3.6); },
        function (T, v) { T.electrics.airspeed = v / 3.6; }),
      ch("rpm", "Engine RPM", "rpm", "power",
        function (T) { return num(T.electrics.rpm); },
        function (T, v) { T.electrics.rpm = v; }),
      ch("gear", "Gear index", "", "power",
        function (T) { return num(T.electrics.gearIndex); },
        function (T, v) {
          var g = Math.round(v);
          T.electrics.gearIndex = g;
          T.electrics.gear = g < 0 ? "R" : (g === 0 ? "N" : String(g));
        }),
      ch("boost", "Turbo boost", "psi", "power",
        function (T) { return num(T.electrics.turboBoost != null ? T.electrics.turboBoost : T.electrics.boost); },
        function (T, v) { T.electrics.turboBoost = v; }),
      ch("engload", "Engine load", "%", "power",
        function (T) { return num(T.electrics.engineLoad) * 100; },
        function (T, v) { T.electrics.engineLoad = v / 100; }),
      ch("fuel", "Fuel level", "%", "power",
        function (T) { return num(T.electrics.fuel) * 100; },
        function (T, v) { T.electrics.fuel = v / 100; }),

      // --- dynamics & attitude (sensors gx2/gy2 are smoothed accel, m/s²) ---
      ch("g_lat", "Lateral G", "g", "dyn",
        function (T) {
          var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
          return num(T.sensors.gx2 != null ? T.sensors.gx2 : T.sensors.gx) / grav;
        },
        function (T, v) { T.sensors.gx2 = v * 9.81; }),
      ch("g_lon", "Longitudinal G", "g", "dyn",
        function (T) {
          var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
          return num(T.sensors.gy2 != null ? T.sensors.gy2 : T.sensors.gy) / grav;
        },
        function (T, v) { T.sensors.gy2 = v * 9.81; }),
      ch("g_vert", "Vertical G", "g", "dyn",
        function (T) {
          var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
          return -(T.sensors.gz2 != null ? T.sensors.gz2 : -grav) / grav;
        },
        function (T, v) { T.sensors.gz2 = -v * 9.81; }),
      ch("roll", "Roll", "°", "dyn",
        function (T) { return num(T.sensors.roll) * 180 / Math.PI; },
        function (T, v) { T.sensors.roll = v * Math.PI / 180; }),
      ch("pitch", "Pitch", "°", "dyn",
        function (T) { return num(T.sensors.pitch) * 180 / Math.PI; },
        function (T, v) { T.sensors.pitch = v * Math.PI / 180; }),
      ch("yaw", "Yaw / heading", "°", "dyn",
        function (T) { return num(T.sensors.yaw) * 180 / Math.PI; },
        function (T, v) { T.sensors.yaw = v * Math.PI / 180; }),
      ch("altitude", "Altitude", "m", "dyn",
        function (T) { return num(T.electrics.altitude); },
        function (T, v) { T.electrics.altitude = v; }),

      // --- thermals ---
      ch("water", "Coolant temp", "°C", "therm",
        function (T) { return num(T.electrics.watertemp); },
        function (T, v) { T.electrics.watertemp = v; }),
      ch("oil", "Oil temp", "°C", "therm",
        function (T) { return num(T.electrics.oiltemp); },
        function (T, v) { T.electrics.oiltemp = v; })
    ];

    // --- per-wheel brakes (from the wheelThermals electrics block) ---
    var wt = T.electrics.wheelThermals || {};
    Object.keys(wt).sort().forEach(function (n) {
      defs.push(ch("btemp_" + n, n + " brake temp", "°C", "brakes",
        function (T) {
          var b = (T.electrics.wheelThermals || {})[n];
          return b ? num(b.brakeSurfaceTemperature) : NaN;
        },
        function (T, v) {
          var o = T.electrics.wheelThermals || (T.electrics.wheelThermals = {});
          (o[n] || (o[n] = {})).brakeSurfaceTemperature = v;
        }));
      defs.push(ch("bfade_" + n, n + " brake efficiency", "%", "brakes",
        function (T) {
          var b = (T.electrics.wheelThermals || {})[n];
          return b ? num(b.brakeThermalEfficiency) * 100 : NaN;
        },
        function (T, v) {
          var o = T.electrics.wheelThermals || (T.electrics.wheelThermals = {});
          (o[n] || (o[n] = {})).brakeThermalEfficiency = v / 100;
        }));
    });

    // --- per-wheel dynamics (wheelInfo rows; graph-only, no replay set) ---
    wheelRows(T).forEach(function (row) {
      var n = row[0];
      defs.push(ch("wspd_" + n, n + " wheel speed", "km/h", "wheels", function (T) {
        var v = rowByName(T, n); return v ? Math.abs(num(v[3]) * num(v[1])) * 3.6 : NaN;
      }));
      defs.push(ch("slip_" + n, n + " slip", "", "wheels", function (T) {
        var v = rowByName(T, n); return v ? num(v[5]) : NaN;
      }));
      defs.push(ch("load_" + n, n + " vertical load", "kN", "wheels", function (T) {
        var v = rowByName(T, n); return v ? num(v[7]) / 1000 : NaN;
      }));
      defs.push(ch("tqd_" + n, n + " drive torque", "N·m", "wheels", function (T) {
        var v = rowByName(T, n); return v ? num(v[4]) : NaN;
      }));
      defs.push(ch("tqb_" + n, n + " brake torque", "N·m", "wheels", function (T) {
        var v = rowByName(T, n); return v ? Math.abs(num(v[8])) : NaN;
      }));
    });

    return defs;
  }

  // ----------------------------------------------------------- persisted prefs
  function prefs() {
    var p = (global.AVCP && AVCP.Store.getJSON("datalab", {})) || {};
    if (!p.cats) { p.cats = {}; CATS.forEach(function (c) { p.cats[c.id] = true; }); }
    if (!p.rate) p.rate = 20;
    if (!p.mode) p.mode = "overlay";
    return p;
  }
  function setPref(key, val) {
    var p = prefs(); p[key] = val;
    if (global.AVCP) AVCP.Store.setJSON("datalab", p);
  }

  // ----------------------------------------------------------- IndexedDB store
  // Separate database from settings.js' image store so the two modules never
  // fight over schema versions.
  var DB_NAME = "avcp_telemetry", DB_STORE = "recordings";
  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = function () {
          try { r.result.createObjectStore(DB_STORE, { keyPath: "id" }); } catch (e) { /* exists */ }
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function idbReq(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, mode), st = tx.objectStore(DB_STORE);
        var q = fn(st);
        tx.oncomplete = function () { res(q ? q.result : true); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function dbSave(recObj) { return idbReq("readwrite", function (st) { st.put(recObj); }); }
  function dbList() { return idbReq("readonly", function (st) { return st.getAll(); }); }
  function dbGet(id) { return idbReq("readonly", function (st) { return st.get(id); }); }
  function dbDelete(id) { return idbReq("readwrite", function (st) { st.delete(id); }); }
  function dbClear() { return idbReq("readwrite", function (st) { st.clear(); }); }

  // ----------------------------------------------------------- recorder state
  var MAX_POINTS = 4e6;        // total samples × channels hard cap (~16 MB)
  var rec = {
    active: false, t0: 0, lastSample: 0, rate: 20,
    time: [], chans: [], markers: []
  };

  function recPointCount() { return rec.time.length * rec.chans.length; }
  function recBytes(R) {
    var n = R.time.length * 4;
    for (var i = 0; i < R.channels.length; i++) n += R.channels[i].data.length * 4;
    return n;
  }
  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
    return b + " B";
  }
  function fmtT(s) {
    if (s == null || isNaN(s)) return "–";
    if (s >= 60) {
      var m = Math.floor(s / 60);
      return m + ":" + ("0" + (s % 60).toFixed(1)).slice(-4);
    }
    return s.toFixed(2) + " s";
  }
  function fmtV(v) {
    if (v == null || isNaN(v)) return "–";
    var a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : (a >= 10 ? 1 : 2));
  }

  function startRecording() {
    if (rec.active) { stopRecording(); return; }
    if (!ctx.br.connected) { toast("not connected to the game"); return; }
    if (!ctx.T.lastStreamTs || performance.now() - ctx.T.lastStreamTs > 3000) {
      toast("no telemetry flowing yet - is a vehicle loaded?"); return;
    }
    if (view.drive) setDrive(false); // never record our own replay

    var p = prefs();
    var defs = buildChannels(ctx.T).filter(function (c) { return p.cats[c.cat]; });
    if (!defs.length) { toast("select at least one category"); return; }

    rec.active = true;
    rec.t0 = performance.now();
    rec.lastSample = 0;
    rec.rate = p.rate;
    rec.time = [];
    rec.markers = [];
    rec.chans = defs.map(function (d, i) {
      return { id: d.id, label: d.label, unit: d.unit, cat: d.cat,
        color: PAL[i % PAL.length], get: d.get, set: d.set, data: [] };
    });

    var btn = $("#dlRecBtn");
    btn.textContent = "■ Stop & save";
    btn.classList.remove("primary"); btn.classList.add("danger");
    $("#dlRecState").textContent = "REC";
    $("#dlRecState").classList.add("rec");
    dirty = true;
    toast("recording " + rec.chans.length + " channels @ " + rec.rate + " Hz");
  }

  function stopRecording() {
    if (!rec.active) return;
    rec.active = false;
    var btn = $("#dlRecBtn");
    btn.textContent = "● Start recording";
    btn.classList.add("primary"); btn.classList.remove("danger");
    $("#dlRecState").textContent = "idle";
    $("#dlRecState").classList.remove("rec");

    if (rec.time.length < 2) { toast("take discarded - nothing recorded"); dirty = true; return; }

    var name = $("#dlName").value.trim();
    var veh = ctx.vehicleName ? ctx.vehicleName() : "";
    if (!name) {
      var d = new Date();
      function p2(x) { return ("0" + x).slice(-2); }
      name = (veh ? veh.split("·")[0].trim() + " " : "take ") +
        d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
        " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
    }
    $("#dlName").value = "";

    var recording = {
      id: Date.now(),
      name: name,
      vehicle: veh,
      createdAt: new Date().toISOString(),
      rate: rec.rate,
      duration: rec.time[rec.time.length - 1],
      markers: rec.markers.slice(),
      time: Float32Array.from(rec.time),
      channels: rec.chans.map(function (c) {
        return { id: c.id, label: c.label, unit: c.unit, cat: c.cat,
          color: c.color, data: Float32Array.from(c.data) };
      })
    };

    dbSave(recording).then(function () {
      toast("saved “" + name + "” to the library");
      refreshList();
    }).catch(function (e) {
      console.warn("[AVCP] recording could not be persisted:", e);
      toast("storage unavailable - take kept in memory only");
    });
    setView(recording);
  }

  function addMarker() {
    if (!rec.active) { toast("markers can only be dropped while recording"); return; }
    var t = (performance.now() - rec.t0) / 1000;
    rec.markers.push({ t: t, label: "M" + (rec.markers.length + 1) });
    toast("⚑ marker M" + rec.markers.length + " @ " + fmtT(t));
  }

  // sampling - driven by the bridge's stream events (registered in init)
  function onStreams() {
    if (!rec.active) return;
    var now = performance.now();
    if (now - rec.lastSample < 1000 / rec.rate - 2) return;
    rec.lastSample = now;
    rec.time.push((now - rec.t0) / 1000);
    for (var i = 0; i < rec.chans.length; i++) {
      var c = rec.chans[i], v;
      try { v = c.get(ctx.T); } catch (e) { v = NaN; }
      c.data.push(v == null || !isFinite(v) ? NaN : v);
    }
    if (recPointCount() >= MAX_POINTS) {
      stopRecording();
      toast("recording auto-stopped - size cap reached");
    }
  }

  // ----------------------------------------------------------- analyzer state
  var view = {
    rec: null,        // loaded recording
    t: 0,             // playhead / cursor (s)
    playing: false,
    speed: 1,
    loop: false,
    drive: false,     // feed recorded values back into ctx.T (gauges replay)
    actuate: false,   // send recorded inputs to the real vehicle (Lua input.event)
    win: [0, 1],      // visible window as fractions of duration
    hidden: {},       // channel id -> true (hidden from graph)
    mode: "overlay"   // "overlay" | "lanes"
  };
  var dirty = true;          // chart needs a redraw
  var lastWindow = null;     // {w0,w1,dur} of last draw, for pointer math
  var LIVE_WIN = 30;         // seconds of live tail shown while recording
  var readoutRefs = [];      // [{chan, el}] for cheap per-frame value updates

  function isDriving() { return !!(view.drive && view.rec); }

  function setDrive(on) {
    if (on && rec.active) { toast("stop the recording first"); return; }
    if (on && !view.rec) { toast("load a recording first"); return; }
    view.drive = !!on;
    $("#dlDrive").classList.toggle("on", view.drive);
    toast(view.drive ? "recorded data is driving the dashboard" : "live telemetry resumed");
  }

  function setPlaying(on) {
    if (on && !view.rec) { toast("load a recording first"); return; }
    if (on && view.rec && view.t >= view.rec.duration - 0.01) view.t = 0;
    view.playing = !!on;
    // hand the car back the instant the replay stops driving it
    if (!view.playing && view.actuate) releaseControls();
    $("#dlPlay").textContent = view.playing ? "❚❚ Pause" : "▶ Play";
    dirty = true;
  }

  function setView(R) {
    view.rec = R;
    view.t = 0;
    view.playing = false;
    view.win = [0, 1];
    view.hidden = {};
    if (view.drive) setDrive(false);
    if (view.actuate) setActuate(false);
    $("#dlPlay").textContent = "▶ Play";
    $("#dlTitle").textContent = R
      ? R.name + " · " + fmtT(R.duration) + " · " + R.channels.length + " ch @ " + R.rate + " Hz"
      : "no recording loaded";
    rebuildChips();
    rebuildReadout();
    rebuildStats();
    dirty = true;
  }

  // --------------------------------------------------------------- math utils
  function idxFor(time, t) { // floor index for t (binary search)
    var hi = time.length - 1, lo = 0;
    if (hi < 0) return 0;
    if (t <= time[0]) return 0;
    if (t >= time[hi]) return hi;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (time[mid] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }
  function valAt(R, c, t) { // linear interpolation, NaN-tolerant
    var time = R.time, i = idxFor(time, t);
    var a = c.data[i], b = c.data[i + 1];
    if (b == null || isNaN(b)) return a;
    if (a == null || isNaN(a)) return b;
    var ta = time[i], tb = time[i + 1];
    if (!(tb > ta)) return a;
    return a + (b - a) * (t - ta) / (tb - ta);
  }
  function chanStats(c) {
    if (c._stats) return c._stats;
    var mn = Infinity, mx = -Infinity, sum = 0, n = 0, d = c.data;
    for (var i = 0; i < d.length; i++) {
      var v = d[i];
      if (v == null || isNaN(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v; n++;
    }
    if (!n) { mn = 0; mx = 1; }
    c._stats = { min: mn, max: mx, avg: n ? sum / n : NaN, n: n };
    return c._stats;
  }
  function visibleChans(R) {
    return R.channels.filter(function (c) { return !view.hidden[c.id]; });
  }

  // ------------------------------------------------------------- chart canvas
  var chart, mini;
  function cfit(canvas) {
    var r = window.devicePixelRatio || 1;
    var cw = canvas.clientWidth || 300, chh = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(cw * r) || canvas.height !== Math.round(chh * r)) {
      canvas.width = Math.round(cw * r); canvas.height = Math.round(chh * r);
    }
    var g = canvas.getContext("2d"); g.setTransform(r, 0, 0, r, 0, 0);
    return { ctx: g, w: cw, h: chh };
  }

  // one channel into a band [yTop, yTop+yH]; polyline when sparse, min/max
  // envelope per pixel column when dense (the way real data loggers render)
  function renderChan(g, R, c, W, w0, w1, yTop, yH, range, alpha, lw) {
    var st = range || chanStats(c);
    var span = (st.max - st.min) || 1;
    var lo = st.min - span * 0.05, hi = st.max + span * 0.05;
    var time = R.time, data = c.data, n = time.length;
    var i0 = idxFor(time, w0), i1 = Math.min(n - 1, idxFor(time, w1) + 2);
    function Y(v) { return yTop + yH * (1 - (v - lo) / (hi - lo)); }
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.strokeStyle = c.color;
    g.lineWidth = lw || 1.6;
    g.beginPath();
    if (i1 - i0 <= W * 1.5) {
      var started = false;
      for (var i = i0; i <= i1; i++) {
        var v = data[i];
        if (v == null || isNaN(v)) { started = false; continue; }
        var x = (time[i] - w0) / (w1 - w0) * W;
        if (!started) { g.moveTo(x, Y(v)); started = true; } else g.lineTo(x, Y(v));
      }
    } else {
      var idx = i0;
      for (var x2 = 0; x2 < W; x2++) {
        var tB = w0 + (w1 - w0) * (x2 + 1) / W;
        var mn = Infinity, mx = -Infinity;
        while (idx <= i1 && time[idx] <= tB) {
          var vv = data[idx];
          if (vv != null && !isNaN(vv)) { if (vv < mn) mn = vv; if (vv > mx) mx = vv; }
          idx++;
        }
        if (mn === Infinity) continue;
        g.moveTo(x2 + 0.5, Y(mx) - 0.5);
        g.lineTo(x2 + 0.5, Y(mn) + 0.5);
      }
    }
    g.stroke();
    g.globalAlpha = 1;
  }

  // live recordings have no stable full-take stats: scale to the drawn window
  function windowRange(R, c, w0, w1) {
    var time = R.time, data = c.data;
    var i0 = idxFor(time, w0), i1 = Math.min(time.length - 1, idxFor(time, w1) + 1);
    var mn = Infinity, mx = -Infinity;
    for (var i = i0; i <= i1; i++) {
      var v = data[i];
      if (v == null || isNaN(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (mn === Infinity) { mn = 0; mx = 1; }
    if (mx - mn < 1e-9) mx = mn + 1;
    return { min: mn, max: mx };
  }

  function timeGrid(g, W, H, w0, w1) {
    var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    var target = (w1 - w0) / 7, step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= target) { step = steps[i]; break; }
    g.strokeStyle = "rgba(255,255,255,0.06)"; g.lineWidth = 1;
    g.fillStyle = "#5d6976"; g.font = "600 9px monospace"; g.textAlign = "center";
    for (var t = Math.ceil(w0 / step) * step; t <= w1 + 1e-9; t += step) {
      var x = (t - w0) / (w1 - w0) * W;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 12); g.stroke();
      g.fillText(t >= 60 ? Math.floor(t / 60) + ":" + ("0" + Math.round(t % 60)).slice(-2) : t.toFixed(step < 1 ? 1 : 0), x, H - 3);
    }
  }

  function drawMain() {
    var f = cfit(chart), g = f.ctx, W = f.w, H = f.h;
    g.clearRect(0, 0, W, H);
    var live = rec.active;
    var R = live
      ? { time: rec.time, channels: rec.chans, markers: rec.markers, duration: rec.time.length ? rec.time[rec.time.length - 1] : 0 }
      : view.rec;
    if (!R || R.time.length < 2) {
      g.fillStyle = "#5d6976"; g.font = "600 12px 'Segoe UI',sans-serif"; g.textAlign = "center";
      g.fillText(live ? "waiting for samples…" : "record a take, or load one from the library", W / 2, H / 2);
      lastWindow = null;
      return;
    }
    var dur = R.time[R.time.length - 1];
    var w0, w1;
    if (live) { w1 = dur; w0 = Math.max(0, dur - LIVE_WIN); }
    else { w0 = view.win[0] * dur; w1 = Math.max(view.win[1] * dur, w0 + 1e-6); }

    timeGrid(g, W, H, w0, w1);
    var plotH = H - 14;
    var vis = live ? R.channels : visibleChans(R);

    if (view.mode === "lanes" && vis.length) {
      var laneH = plotH / vis.length;
      for (var k = 0; k < vis.length; k++) {
        var c = vis[k], yTop = k * laneH;
        if (k > 0) {
          g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1;
          g.beginPath(); g.moveTo(0, yTop); g.lineTo(W, yTop); g.stroke();
        }
        var range = live ? windowRange(R, c, w0, w1) : null;
        renderChan(g, R, c, W, w0, w1, yTop + 3, laneH - 6, range, 1, 1.4);
        g.fillStyle = c.color; g.font = "700 10px 'Segoe UI',sans-serif"; g.textAlign = "left";
        g.fillText(c.label + (c.unit ? " (" + c.unit + ")" : ""), 6, yTop + 12);
        var st = range || chanStats(c);
        g.fillStyle = "#5d6976"; g.font = "600 9px monospace"; g.textAlign = "right";
        g.fillText(fmtV(st.max), W - 4, yTop + 11);
        g.fillText(fmtV(st.min), W - 4, yTop + laneH - 4);
      }
    } else {
      g.strokeStyle = "rgba(255,255,255,0.05)"; g.lineWidth = 1;
      for (var gy = 1; gy <= 3; gy++) {
        var y = plotH * gy / 4;
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      for (var j = 0; j < vis.length; j++) {
        var rangeO = live ? windowRange(R, vis[j], w0, w1) : null;
        renderChan(g, R, vis[j], W, w0, w1, 4, plotH - 8, rangeO, 0.92, 1.6);
      }
    }

    // markers
    var marks = R.markers || [];
    g.font = "700 9px 'Segoe UI',sans-serif"; g.textAlign = "left";
    for (var m = 0; m < marks.length; m++) {
      if (marks[m].t < w0 || marks[m].t > w1) continue;
      var mx = (marks[m].t - w0) / (w1 - w0) * W;
      g.setLineDash([4, 4]); g.strokeStyle = "rgba(255,210,26,0.55)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(mx, 0); g.lineTo(mx, plotH); g.stroke(); g.setLineDash([]);
      g.fillStyle = "#ffd21a";
      g.fillText(marks[m].label, mx + 3, 10);
    }

    // playhead / cursor
    if (!live && view.rec) {
      var t = Math.max(0, Math.min(dur, view.t));
      if (t >= w0 && t <= w1) {
        var px = (t - w0) / (w1 - w0) * W;
        g.strokeStyle = "rgba(233,238,244,0.85)"; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, plotH); g.stroke();
        g.fillStyle = "rgba(233,238,244,0.85)";
        g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.closePath(); g.fill();
      }
    }

    lastWindow = { w0: w0, w1: w1, dur: dur };
  }

  function drawMini() {
    var f = cfit(mini), g = f.ctx, W = f.w, H = f.h;
    g.clearRect(0, 0, W, H);
    var live = rec.active;
    var R = live
      ? { time: rec.time, channels: rec.chans }
      : view.rec;
    if (!R || R.time.length < 2) return;
    var dur = R.time[R.time.length - 1];
    var vis = live ? R.channels : visibleChans(view.rec);
    for (var i = 0; i < vis.length; i++) {
      var range = live ? windowRange(R, vis[i], 0, dur) : null;
      renderChan(g, R, vis[i], W, 0, dur, 1, H - 2, range, 0.4, 1);
    }
    // window indicator
    var a = live ? Math.max(0, (dur - LIVE_WIN) / dur) : view.win[0];
    var b = live ? 1 : view.win[1];
    g.fillStyle = "rgba(5,8,11,0.55)";
    g.fillRect(0, 0, W * a, H);
    g.fillRect(W * b, 0, W - W * b, H);
    g.strokeStyle = "rgba(255,122,24,0.8)"; g.lineWidth = 1;
    g.strokeRect(W * a + 0.5, 0.5, Math.max(2, W * (b - a)) - 1, H - 1);
  }

  // ------------------------------------------------------ readout / stats DOM
  function rebuildChips() {
    var box = $("#dlChans");
    if (!view.rec) { box.innerHTML = ""; return; }
    var html = '<button class="mini" data-all="1">all</button><button class="mini" data-all="0">none</button>';
    html += view.rec.channels.map(function (c) {
      var off = view.hidden[c.id] ? " off" : "";
      return '<button class="dl-chip' + off + '" data-id="' + c.id + '">' +
        '<i style="background:' + c.color + '"></i>' + c.label + "</button>";
    }).join("");
    box.innerHTML = html;
    $$("#dlChans .dl-chip").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.dataset.id;
        if (view.hidden[id]) delete view.hidden[id]; else view.hidden[id] = true;
        this.classList.toggle("off", !!view.hidden[id]);
        rebuildReadout(); rebuildStats(); dirty = true;
      });
    });
    $$("#dlChans .mini").forEach(function (b) {
      b.addEventListener("click", function () {
        var on = this.dataset.all === "1";
        view.hidden = {};
        if (!on) view.rec.channels.forEach(function (c) { view.hidden[c.id] = true; });
        rebuildChips(); rebuildReadout(); rebuildStats(); dirty = true;
      });
    });
  }

  function rebuildReadout() {
    var box = $("#dlReadout");
    readoutRefs = [];
    if (!view.rec) { box.innerHTML = ""; return; }
    box.innerHTML = visibleChans(view.rec).map(function (c) {
      return '<div class="dl-ro" data-id="' + c.id + '"><i style="background:' + c.color + '"></i>' +
        '<span>' + c.label + '</span><b>–</b><em>' + c.unit + "</em></div>";
    }).join("");
    visibleChans(view.rec).forEach(function (c) {
      var el = box.querySelector('[data-id="' + c.id + '"] b');
      if (el) readoutRefs.push({ chan: c, el: el });
    });
  }

  function updateReadout() {
    if (!view.rec || !readoutRefs.length) return;
    for (var i = 0; i < readoutRefs.length; i++) {
      readoutRefs[i].el.textContent = fmtV(valAt(view.rec, readoutRefs[i].chan, view.t));
    }
  }

  function rebuildStats() {
    var box = $("#dlStats");
    if (!view.rec) { box.innerHTML = ""; return; }
    var rows = visibleChans(view.rec).map(function (c) {
      var st = chanStats(c);
      return '<div class="dl-st"><i style="background:' + c.color + '"></i><span>' + c.label + "</span>" +
        "<b>" + fmtV(st.min) + "</b><b>" + fmtV(st.avg) + "</b><b>" + fmtV(st.max) + "</b>" +
        "<em>" + (c.unit || "·") + "</em></div>";
    }).join("");
    box.innerHTML = rows
      ? '<div class="dl-st head"><i></i><span>channel</span><b>min</b><b>avg</b><b>max</b><em>unit</em></div>' + rows
      : "";
  }

  // --------------------------------------------------------------- transport
  var lastTs = 0;
  function tick(ts) {
    // the rAF re-request lives OUTSIDE the try so one bad frame (odd vehicle
    // data, detached canvas, …) can never kill the whole analyzer loop
    try {
      var dt = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      if (dt > 0.25) dt = 0.25; // hidden-tab resume guard

      if (view.rec && view.playing) {
        view.t += dt * view.speed;
        if (view.t >= view.rec.duration) {
          if (view.loop) view.t -= view.rec.duration;
          else { view.t = view.rec.duration; setPlaying(false); }
        }
        dirty = true;
      }
      if (isDriving()) applyDrive();
      if (view.actuate && view.playing) applyActuation(ts);

      var page = $("#page-datalab");
      if (page && page.classList.contains("active")) {
        // redraw when something moved, while recording (live tail), or on resize
        var resized = chart.clientWidth !== chart._lastW;
        if (dirty || rec.active || resized) {
          chart._lastW = chart.clientWidth;
          drawMain(); drawMini();
          if (rec.active) updateLiveMeta(); else updateReadout();
          updateTimeLabel();
          dirty = false;
        }
      }
    } catch (e) {
      console.error("[AVCP] Data Lab frame error:", e);
    }
    requestAnimationFrame(tick);
  }

  function updateTimeLabel() {
    var el = $("#dlTime");
    if (rec.active) { el.textContent = "REC " + fmtT(rec.time.length ? rec.time[rec.time.length - 1] : 0); return; }
    el.textContent = view.rec ? fmtT(view.t) + " / " + fmtT(view.rec.duration) : "–";
  }

  function updateLiveMeta() {
    var n = rec.time.length;
    $("#dlRecState").textContent =
      "REC " + fmtT(n ? rec.time[n - 1] : 0) + " · " + n + " samples · " +
      rec.chans.length + " ch · ~" + fmtBytes(n * rec.chans.length * 4);
  }

  // ------------------------------------------------- actuation (input replay)
  // Sends the recorded DRIVER INPUTS to the real vehicle while playing, via
  // input.event(<input>, <0..1 / -1..1>, 2) in the vehicle VM (filter 2 =
  // FILTER_DIRECT: 1:1, no extra smoothing - the data already carries the
  // original driver's filtering). Gear is replayed through the vehicle's own
  // controller (shiftToGearIndex) only when the recorded index changes.
  //
  // This is OPEN-LOOP input replay, not a position-locked ghost: same vehicle
  // + same starting spot reproduces the run, but soft-body physics divergence
  // accumulates over time. Controls are zeroed the moment playback stops, so
  // the user gets the car back instantly - rolling, not parked.
  var ACT_INTERVAL = 50; // ms between input batches (~20 Hz toward the game)
  var actLast = 0, actGear = null;

  function releaseControls() {
    actGear = null;
    if (!ctx.br.connected) return;
    ctx.br.activeObjectLua(
      "input.event('throttle',0,2) input.event('brake',0,2) " +
      "input.event('steering',0,2) input.event('clutch',0,2)");
  }

  function setActuate(on) {
    if (on && !view.rec) { toast("load a recording first"); return; }
    if (on && !ctx.br.connected) { toast("not connected to the game"); return; }
    view.actuate = !!on;
    $("#dlActuate").classList.toggle("on", view.actuate);
    if (view.actuate) {
      // show the car's REAL response on the gauges, not the recording
      if (view.drive) setDrive(false);
      toast("⚠ playback now drives the vehicle - pause to take over");
    } else {
      releaseControls();
      toast("vehicle control released");
    }
  }

  function applyActuation(nowMs) {
    if (nowMs - actLast < ACT_INTERVAL) return;
    actLast = nowMs;
    var R = view.rec;
    if (!R || !ctx.br.connected) return;
    if (!R._chanById) {
      R._chanById = {};
      R.channels.forEach(function (c) { R._chanById[c.id] = c; });
    }
    function v(id) {
      var c = R._chanById[id];
      if (!c) return null;
      var x = valAt(R, c, view.t);
      return (x == null || isNaN(x)) ? null : x;
    }
    function clamp01(x) { return Math.max(0, Math.min(1, x / 100)); }
    var lua = "", x;
    if ((x = v("throttle")) != null) lua += "input.event('throttle'," + clamp01(x).toFixed(4) + ",2) ";
    if ((x = v("brake")) != null) lua += "input.event('brake'," + clamp01(x).toFixed(4) + ",2) ";
    if ((x = v("clutch")) != null) lua += "input.event('clutch'," + clamp01(x).toFixed(4) + ",2) ";
    if ((x = v("handbrake")) != null) lua += "input.event('parkingbrake'," + clamp01(x).toFixed(4) + ",2) ";
    if ((x = v("steering")) != null) {
      lua += "input.event('steering'," + Math.max(-1, Math.min(1, x / 100)).toFixed(4) + ",2) ";
    }
    if ((x = v("gear")) != null) {
      var g = Math.round(x);
      if (g !== actGear) {
        actGear = g;
        lua += "if controller.mainController and controller.mainController.shiftToGearIndex then " +
          "controller.mainController.shiftToGearIndex(" + g + ") end ";
      }
    }
    if (lua) ctx.br.activeObjectLua(lua);
  }

  // replay → shared telemetry state. set() exists only for channels that map
  // cleanly back onto electrics/sensors fields; wheelInfo rows stay live.
  function applyDrive() {
    var R = view.rec;
    if (!R) return;
    if (!R._setters) {
      // recordings loaded from the DB carry no functions - rebind from defs
      var defs = buildChannels(ctx.T), map = {};
      defs.forEach(function (d) { if (d.set) map[d.id] = d.set; });
      R._setters = R.channels.map(function (c) { return map[c.id] || null; });
    }
    ctx.T.sensors.gravity = -9.81; // keep g-math self-consistent during replay
    for (var i = 0; i < R.channels.length; i++) {
      var set = R._setters[i];
      if (!set) continue;
      var v = valAt(R, R.channels[i], view.t);
      if (v == null || isNaN(v)) continue;
      try { set(ctx.T, v); } catch (e) { /* tolerate odd vehicle states */ }
    }
  }

  // -------------------------------------------------------------- interaction
  function wireChart() {
    var scrubbing = false;
    function scrubTo(ev) {
      if (!lastWindow || !view.rec || rec.active) return;
      var rect = chart.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      view.t = lastWindow.w0 + frac * (lastWindow.w1 - lastWindow.w0);
      dirty = true;
    }
    chart.addEventListener("pointerdown", function (ev) {
      scrubbing = true;
      try { chart.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported */ }
      scrubTo(ev);
    });
    chart.addEventListener("pointermove", function (ev) { if (scrubbing) scrubTo(ev); });
    chart.addEventListener("pointerup", function () { scrubbing = false; });
    chart.addEventListener("pointercancel", function () { scrubbing = false; });
    chart.addEventListener("dblclick", function () { view.win = [0, 1]; dirty = true; });
    chart.addEventListener("wheel", function (ev) {
      if (!view.rec || rec.active) return;
      ev.preventDefault();
      var rect = chart.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      zoom(ev.deltaY < 0 ? 0.78 : 1.28, frac);
    }, { passive: false });

    mini.addEventListener("pointerdown", miniDrag);
    mini.addEventListener("pointermove", function (ev) { if (ev.buttons & 1) miniDrag(ev); });
    function miniDrag(ev) {
      if (!view.rec || rec.active) return;
      var rect = mini.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      var span = view.win[1] - view.win[0];
      var a = Math.max(0, Math.min(1 - span, frac - span / 2));
      view.win = [a, a + span];
      dirty = true;
    }
  }

  function zoom(factor, anchorFrac) {
    if (!view.rec) return;
    if (anchorFrac == null) anchorFrac = 0.5;
    var a = view.win[0], b = view.win[1], span = b - a;
    var minSpan = Math.max(0.0005, 0.25 / Math.max(0.25, view.rec.duration));
    var ns = Math.max(minSpan, Math.min(1, span * factor));
    var anchor = a + anchorFrac * span;
    var na = anchor - anchorFrac * ns;
    na = Math.max(0, Math.min(1 - ns, na));
    view.win = [na, na + ns];
    dirty = true;
  }

  // ------------------------------------------------------------------ library
  function recMetaLine(R) {
    var d = new Date(R.createdAt);
    function p2(x) { return ("0" + x).slice(-2); }
    var when = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
      " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    return [R.vehicle, when, fmtT(R.duration), R.channels.length + " ch @ " + R.rate + " Hz", fmtBytes(recBytes(R))]
      .filter(Boolean).join(" · ");
  }

  function refreshList() {
    dbList().then(function (rows) {
      rows = rows || [];
      rows.sort(function (a, b) { return b.id - a.id; });
      var box = $("#dlList");
      if (!rows.length) {
        box.innerHTML = '<div class="hint">No recordings yet - hit <b>Start recording</b> while driving, ' +
          "or import a JSON export from someone else.</div>";
      } else {
        box.innerHTML = rows.map(function (R) {
          return '<div class="dl-row" data-id="' + R.id + '">' +
            '<div class="dl-row-main"><b>' + escapeHtml(R.name) + "</b><span>" + escapeHtml(recMetaLine(R)) + "</span></div>" +
            '<div class="dl-row-actions">' +
            '<button class="mini" data-act="load">load</button>' +
            '<button class="mini" data-act="csv">csv</button>' +
            '<button class="mini" data-act="json">json</button>' +
            '<button class="mini danger" data-act="del">✕</button>' +
            "</div></div>";
        }).join("");
        $$("#dlList [data-act]").forEach(function (b) {
          b.addEventListener("click", onRowAction);
        });
      }
      updateStorageNote();
    }).catch(function () {
      $("#dlList").innerHTML = '<div class="hint">Browser storage is unavailable in this context - ' +
        "recording still works, but takes survive only until the page reloads.</div>";
    });
  }

  function onRowAction() {
    var row = this.parentNode.parentNode;
    var id = parseInt(row.dataset.id, 10);
    var act = this.dataset.act;
    if (act === "del") {
      if (!this.classList.contains("confirm")) {
        var self = this;
        this.classList.add("confirm"); this.textContent = "sure?";
        setTimeout(function () { self.classList.remove("confirm"); self.textContent = "✕"; }, 2500);
        return;
      }
      dbDelete(id).then(function () {
        if (view.rec && view.rec.id === id) setView(null);
        refreshList(); toast("recording deleted");
      });
      return;
    }
    dbGet(id).then(function (R) {
      if (!R) { toast("recording not found"); refreshList(); return; }
      if (act === "load") { setView(R); toast("loaded “" + R.name + "”"); }
      else if (act === "csv") exportCsv(R);
      else if (act === "json") exportJson(R);
    });
  }

  function updateStorageNote() {
    var el = $("#dlStorage");
    if (!el) return;
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        if (e && e.usage != null) el.textContent = fmtBytes(e.usage) + " used";
      }).catch(function () { /* fine without */ });
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeName(s) { return String(s).replace(/[^\w\-]+/g, "_").slice(0, 60) || "take"; }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ------------------------------------------------------------------ exports
  function exportCsv(R) {
    var head = ["time_s"].concat(R.channels.map(function (c) { return c.id; }));
    var lines = [head.join(",")];
    for (var i = 0; i < R.time.length; i++) {
      var row = [R.time[i].toFixed(3)];
      for (var j = 0; j < R.channels.length; j++) {
        var v = R.channels[j].data[i];
        row.push(v == null || isNaN(v) ? "" : (Math.round(v * 1000) / 1000));
      }
      lines.push(row.join(","));
    }
    if (R.markers && R.markers.length) {
      lines.push("");
      lines.push("# markers");
      R.markers.forEach(function (m) { lines.push("# " + m.label + "," + m.t.toFixed(3)); });
    }
    download(new Blob([lines.join("\n")], { type: "text/csv" }), "avcp-" + safeName(R.name) + ".csv");
    toast("CSV exported (" + R.time.length + " rows × " + R.channels.length + " channels)");
  }

  function exportJson(R) {
    var out = {
      format: "avcp-telemetry-1",
      meta: {
        name: R.name, vehicle: R.vehicle, createdAt: R.createdAt,
        rate: R.rate, duration: R.duration, source: "BeamNG.drive · Luna Mattins AVCP"
      },
      markers: R.markers || [],
      time: Array.prototype.slice.call(R.time),
      channels: R.channels.map(function (c) {
        return { id: c.id, label: c.label, unit: c.unit, category: c.cat,
          color: c.color, data: Array.prototype.slice.call(c.data) };
      })
    };
    download(new Blob([JSON.stringify(out)], { type: "application/json" }),
      "avcp-" + safeName(R.name) + ".json");
    toast("JSON exported");
  }

  function importJson(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var d;
      try { d = JSON.parse(fr.result); } catch (e) { toast("not valid JSON"); return; }
      if (!d || d.format !== "avcp-telemetry-1" || !d.time || !d.channels) {
        toast("not an AVCP telemetry export"); return;
      }
      var R = {
        id: Date.now(),
        name: (d.meta && d.meta.name) || file.name.replace(/\.json$/i, ""),
        vehicle: (d.meta && d.meta.vehicle) || "",
        createdAt: (d.meta && d.meta.createdAt) || new Date().toISOString(),
        rate: (d.meta && d.meta.rate) || 0,
        duration: d.time.length ? d.time[d.time.length - 1] : 0,
        markers: d.markers || [],
        time: Float32Array.from(d.time),
        channels: d.channels.map(function (c, i) {
          return { id: c.id, label: c.label || c.id, unit: c.unit || "", cat: c.category || "power",
            color: c.color || PAL[i % PAL.length], data: Float32Array.from(c.data || []) };
        })
      };
      dbSave(R).then(function () { refreshList(); setView(R); toast("imported “" + R.name + "”"); })
        .catch(function () { setView(R); toast("imported (memory only - storage unavailable)"); });
    };
    fr.readAsText(file);
  }

  function wipeAll() {
    dbClear().then(function () {
      setView(null); refreshList(); toast("all recordings deleted");
    }).catch(function () { toast("storage unavailable"); });
  }

  // --------------------------------------------------------------- UI wiring
  function wireUI() {
    var p = prefs();

    // recorder
    $("#dlRecBtn").addEventListener("click", startRecording);
    $("#dlMarkerBtn").addEventListener("click", addMarker);
    var rateSel = $("#dlRate");
    rateSel.value = String(p.rate);
    rateSel.addEventListener("change", function () { setPref("rate", parseInt(this.value, 10) || 20); });

    var cats = $("#dlCats");
    cats.innerHTML = CATS.map(function (c) {
      return '<button class="dl-cat' + (p.cats[c.id] ? " on" : "") + '" data-cat="' + c.id + '">' + c.name + "</button>";
    }).join("");
    $$("#dlCats .dl-cat").forEach(function (b) {
      b.addEventListener("click", function () {
        if (rec.active) { toast("stop the recording to change scope"); return; }
        var pr = prefs();
        pr.cats[this.dataset.cat] = !pr.cats[this.dataset.cat];
        if (global.AVCP) AVCP.Store.setJSON("datalab", pr);
        this.classList.toggle("on", pr.cats[this.dataset.cat]);
      });
    });

    // library
    $("#dlImportBtn").addEventListener("click", function () { $("#dlImportFile").click(); });
    $("#dlImportFile").addEventListener("change", function () {
      var f = this.files && this.files[0]; this.value = "";
      if (f) importJson(f);
    });

    // transport
    $("#dlPlay").addEventListener("click", function () { setPlaying(!view.playing); });
    $("#dlToStart").addEventListener("click", function () { view.t = 0; dirty = true; });
    $("#dlLoop").addEventListener("click", function () {
      view.loop = !view.loop; this.classList.toggle("on", view.loop);
    });
    $("#dlSpeed").addEventListener("change", function () { view.speed = parseFloat(this.value) || 1; });
    $("#dlMode").addEventListener("click", function () {
      view.mode = view.mode === "overlay" ? "lanes" : "overlay";
      this.textContent = view.mode === "overlay" ? "Lanes" : "Overlay";
      setPref("mode", view.mode); dirty = true;
    });
    view.mode = p.mode;
    $("#dlMode").textContent = view.mode === "overlay" ? "Lanes" : "Overlay";
    $("#dlZoomIn").addEventListener("click", function () { zoom(0.6); });
    $("#dlZoomOut").addEventListener("click", function () { zoom(1.7); });
    $("#dlFit").addEventListener("click", function () { view.win = [0, 1]; dirty = true; });
    $("#dlDrive").addEventListener("click", function () { setDrive(!view.drive); });
    $("#dlActuate").addEventListener("click", function () { setActuate(!view.actuate); });

    // settings-tab bulk delete (lives on the Settings page)
    var wipe = $("#dlWipe");
    if (wipe) wipe.addEventListener("click", function () {
      if (!this.classList.contains("confirm")) {
        var self = this;
        this.classList.add("confirm"); this.textContent = "Really delete all recordings?";
        setTimeout(function () { self.classList.remove("confirm"); self.textContent = "Delete all recordings"; }, 3000);
        return;
      }
      this.classList.remove("confirm"); this.textContent = "Delete all recordings";
      wipeAll();
    });

    // redraw when the tab becomes visible
    var tab = $('.tab[data-tab="datalab"]');
    if (tab) tab.addEventListener("click", function () { dirty = true; });

    wireChart();
  }

  // -------------------------------------------------------------------- init
  function init(c) {
    if (ctx) return; // once
    ctx = c;
    chart = $("#dlChart");
    mini = $("#dlMini");
    if (!chart || !mini) { console.warn("[AVCP] Data Lab markup missing"); return; }
    wireUI();
    refreshList();
    ctx.br.on("streams", onStreams);
    requestAnimationFrame(tick);
  }

  global.DataLab = {
    init: init,
    isDriving: isDriving,
    addMarker: addMarker,
    wipeAll: wipeAll
  };
})(window);
