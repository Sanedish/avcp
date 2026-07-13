/* =============================================================================
 * Luna Mattins AVCP - Application
 * Wires the bridge to telemetry widgets, action panels, world controls,
 * AI/traffic, statistics and a Lua console.
 * ========================================================================== */
(function () {
  "use strict";

  var br = new Bridge();
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // -------------------------------------------------- shared telemetry state
  var T = {
    electrics: {}, engineInfo: [], wheelInfo: [], sensors: {},
    lastStreamTs: 0
  };

  // ===================================================================== TABS
  $$(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      closeMaximized();
      $$(".tab").forEach(function (x) { x.classList.remove("active"); });
      $$(".page").forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active");
      $("#page-" + t.dataset.tab).classList.add("active");
      // per-tab UI scale (Settings → Interface) follows the visible page
      if (window.Customize && Customize.applyScale) Customize.applyScale(t.dataset.tab);
      t.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  });

  // =============================================================== CONNECTION
  // ---- setup / connection health -------------------------------------------
  // The single source of truth that the game web-server is enabled & reachable
  // is the WebSocket actually OPENING with the bng-ext-app-v1 subprotocol. If it
  // ever opens we know setup is fine and never warn - that's what keeps false
  // alarms near-zero. A server that's enabled but slow to wake (the "looks
  // disabled until you open Options once" case from the readme) still opens
  // inside the grace window, so it won't trip the warning.
  //
  // Grace before concluding "setup required":
  //   main menu  : ~10 s   (light; the server should answer quickly)
  //   loaded map : ~30 s   (map + vehicle load is heavy; give it room)
  // We can't distinguish menu from map while disconnected (there's no game to
  // ask), so the disconnected failure path uses the larger 30 s window to
  // minimise misfires. Fires at most once per session.
  var SETUP_GRACE_MENU_MS = 10000, SETUP_GRACE_MAP_MS = 30000;
  var everConnected = false, setupFired = false, setupTimer = null;

  function setConn(state) {
    var c = $("#conn"), txt = $("#connText");
    if (state === "open") { c.classList.add("online"); txt.textContent = ""; }
    else { c.classList.remove("online"); txt.textContent = everConnected ? "reconnecting…" : "connecting…"; }
  }

  function fireSetupRequired() {
    if (setupFired || everConnected) return;
    setupFired = true;
    // The notification is thrown IN-GAME, not on this page: a site banner is
    // useless here - if the web server is off the page can't load at all, and a
    // user running the in-game UI isn't looking at this tab. beamngAlert is
    // buffered by the bridge, so if the server was merely slow to wake the toast
    // still lands in-game once it connects; if it truly never connects nothing
    // sends (harmless) and the console line below remains for anyone debugging.
    var title = "AVCP - can't reach the Web UI server";
    var msg = "Enable BeamNG's external/Web UI server, then reload the AVCP page (see the mod description).";
    console.error("[AVCP] " + title + " - " + msg +
      "\nThe panel could not reach BeamNG's external-UI web server on this host within " +
      (SETUP_GRACE_MAP_MS / 1000) + "s.");
    br.beamngAlert(title, msg, "error");
  }

  br.on("connection", function (s) {
    setConn(s);
    if (s === "open") {
      everConnected = true;
      if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
      br.addStreams(["electrics", "engineInfo", "wheelInfo", "sensors"]);
      refreshVehicle();
      br.engineLua("core_environment.requestState()");
      br.engineLua("simTimeAuthority.requestValue()");
      populateModelList();
      fetchGroundModels();
      fetchSysInfo();
    }
  });

  // ============================================================ STREAM INTAKE
  br.on("streams", function (s) {
    // While the Data Lab replays a recording onto the dashboard it owns T -
    // live frames are dropped wholesale (stats included) until replay ends.
    if (window.DataLab && DataLab.isDriving()) return;
    var now = performance.now();
    var dt = T.lastStreamTs ? (now - T.lastStreamTs) / 1000 : 0;
    T.lastStreamTs = now;
    if (s.electrics) T.electrics = s.electrics;
    if (s.engineInfo) T.engineInfo = s.engineInfo;
    if (s.wheelInfo) T.wheelInfo = s.wheelInfo;
    if (s.sensors) T.sensors = s.sensors;
    updateStats(dt);
  });

  // ================================================================== HOOKS
  br.on("hook:VehicleFocusChanged", refreshVehicle);
  br.on("hook:VehicleChange", refreshVehicle);
  br.on("hook:vehicleSpawned", function () { setTimeout(refreshVehicle, 400); });
  br.on("hook:vehicleResetted", function () { setTimeout(refreshVehicle, 200); });

  br.on("hook:EnvironmentStateUpdate", function (args) {
    var st = args[0]; if (!st) return;
    if (typeof st.time === "number") { setTodSlider(st.time); }
    if (typeof st.play === "boolean") { todPlaying = st.play; renderTodPlay(); }
    if (typeof st.fogDensity === "number") $("#fogSlider").value = Math.min(1, st.fogDensity / 1000);
    if (typeof st.cloudCover === "number") $("#cloudSlider").value = st.cloudCover;
    if (typeof st.windSpeed === "number") $("#windSlider").value = st.windSpeed;
  });
  br.on("hook:BullettimeValueChanged", function (args) {
    var v = args[0]; if (typeof v === "number" && v > 0) setSimPill(v);
  });

  // =================================================================== GAUGES
  var gSpeed = new Gauges.Gauge($("#gSpeed"), { min: 0, max: 240, label: "SPEED", unit: "km/h" });
  var gTach = new Gauges.Gauge($("#gTach"), { min: 0, max: 8000, label: "RPM", unit: "rpm", decimals: 0, redline: 7000, accent: "data" });
  var gMeter = new Gauges.GMeter($("#gMeter"));
  var hist = new Gauges.Chart($("#histChart"), [
    { name: "Speed", color: "accent", max: 240 },
    { name: "RPM%", color: "data", max: 1 }
  ]);
  var compass = new Gauges.Compass($("#compass"));
  $("#gReset").addEventListener("click", function () { gMeter.reset(); });

  // performance history charts (Stats tab) - reuse the line-chart widget
  var fpsChart = new Gauges.Chart($("#fpsChart"), [{ name: "FPS", color: "accent", max: 120 }]);
  var memChart = new Gauges.Chart($("#memChart"), [{ name: "Process RAM (MB)", color: "data", max: 4096 }]);
  var vramChart = new Gauges.Chart($("#vramChart"), [{ name: "VRAM (GB)", color: "#b07bff", max: 8 }]);

  // ---- per-gauge config + units applied to the dial widgets ----------------
  // GCFG mirrors the persisted Settings → Gauges block; applyGaugeConfig pushes
  // it (and the active unit system) onto the live widgets. Re-run on change.
  var GCFG = AVCP.gaugeCfg();
  function applyGaugeConfig() {
    GCFG = AVCP.gaugeCfg();
    gSpeed.unit = AVCP.Units.speed(0).unit;
    gSpeed.max = AVCP.Units.speed(GCFG.speedMax).val;
    gSpeed.smoothing = GCFG.smoothing / 100;
    gSpeed.decimals = GCFG.speedDecimals;
    gSpeed.showTicks = GCFG.showTicks;
    gTach.smoothing = GCFG.smoothing / 100;
    gTach.showTicks = GCFG.showTicks;
  }
  applyGaugeConfig();
  AVCP.on("gauges", applyGaugeConfig);
  AVCP.on("units", function () { applyGaugeConfig(); });
  AVCP.on("theme", function () { Gauges.refreshTheme(); });

  var histAccum = 0;

  // Background-throttling bypass: Web Workers run at full speed even in unfocused tabs
  var bgWorkerBlob = new Blob([
    "var t; self.onmessage = function(e) {",
    "  if (e.data === 'start') { clearInterval(t); t = setInterval(function() { postMessage('tick'); }, 16); }",
    "  if (e.data === 'stop') clearInterval(t);",
    "};"
  ], { type: "application/javascript" });
  var tickerWorker = new Worker(URL.createObjectURL(bgWorkerBlob));

  function renderLoop() {
    var e = T.electrics, ei = T.engineInfo;
    histAccum++;
    var domTick = (histAccum % 3 === 0); // ~20fps cap for DOM-list rebuilds

    // cloned gauge widgets (Customize) draw on whatever page they're on, so their
    // telemetry snapshot is built OUTSIDE the dashboard gate. Cheap: only the
    // active page's instances actually render.
    if (window.Customize && Customize.renderWidgets) {
      var wSpd = Math.abs((e.wheelspeed != null ? e.wheelspeed : (e.airspeed || 0)) * 3.6);
      var wRpm = e.rpm != null ? e.rpm : (ei[4] || 0);
      var wMax = ei[1] || 8000, wGrav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
      Customize.renderWidgets({
        speedVal: AVCP.Units.speed(wSpd).val, speedUnit: AVCP.Units.speed(0).unit,
        speedMax: AVCP.Units.speed(GCFG.speedMax).val, speedKmh: wSpd,
        rpm: wRpm, rpmCeil: GCFG.rpmMax > 0 ? GCFG.rpmMax : Math.ceil(wMax / 1000) * 1000,
        redline: (GCFG.rpmMax > 0 ? GCFG.rpmMax : wMax) * (GCFG.redlinePct / 100),
        rpmFrac: wMax ? wRpm / wMax : 0,
        gx: (T.sensors.gx2 != null ? T.sensors.gx2 : (T.sensors.gx || 0)) / wGrav,
        gy: (T.sensors.gy2 != null ? T.sensors.gy2 : (T.sensors.gy || 0)) / wGrav,
        yaw: T.sensors.yaw || 0, gear: e.gear != null ? e.gear : (e.gear_A || e.gear_M || "N"),
        pos: navPos
      }, histAccum % 4 === 0);
    }

    // Only render a tab's widgets while that tab is actually visible - otherwise
    // we were redrawing the whole dashboard (3 canvases + 2 innerHTML rebuilds)
    // every frame behind other tabs, which is what tanked real browsers.
    if ($("#page-dashboard").classList.contains("active")) {
      // speed (m/s -> km/h internally; the dial shows it in the chosen unit)
      var speedKmh = Math.abs((e.wheelspeed != null ? e.wheelspeed : (e.airspeed || 0)) * 3.6);
      gSpeed.set(AVCP.Units.speed(speedKmh).val);

      // rpm (ceiling + redline honour the Settings → Gauges config)
      var rpm = e.rpm != null ? e.rpm : (ei[4] || 0);
      var maxRpm = ei[1] || 8000;
      var rpmCeil = GCFG.rpmMax > 0 ? GCFG.rpmMax : Math.ceil(maxRpm / 1000) * 1000;
      gTach.redline = (GCFG.rpmMax > 0 ? GCFG.rpmMax : maxRpm) * (GCFG.redlinePct / 100);
      gTach.set(rpm, rpmCeil);

      // gear
      var gear = e.gear != null ? e.gear : (e.gear_A || e.gear_M || "N");
      $("#gearVal").textContent = (gear === "" || gear == null) ? "N" : gear;

      gSpeed.draw(); gTach.draw();

      // g-meter (lateral=x, longitudinal=y); sensors gx2/gy2 are smoothed, in m/s^2
      var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
      var gx = (T.sensors.gx2 != null ? T.sensors.gx2 : (T.sensors.gx || 0)) / grav;
      var gy = (T.sensors.gy2 != null ? T.sensors.gy2 : (T.sensors.gy || 0)) / grav;
      gMeter.set(gx, gy);
      gMeter.draw();

      // pedals
      Gauges.bar($("[data-bar=throttle]"), e.throttle || 0, { vertical: true, color: "accent" });
      Gauges.bar($("[data-bar=brake]"), e.brake || 0, { vertical: true, color: "bad" });
      Gauges.bar($("[data-bar=clutch]"), e.clutch || 0, { vertical: true, color: "data" });
      // steering -1..1 -> 0..1 centered
      var st = e.steering_input != null ? e.steering_input : (e.steering || 0);
      Gauges.bar($("#steerBar"), 0.5 + Math.max(-1, Math.min(1, st)) / 2, { color: "#9b7bff" });

      // history chart (kept in km/h internally so the scale is unit-stable)
      if (histAccum % 4 === 0) {
        hist.series[0].max = Math.max(120, GCFG.speedMax);
        hist.push([speedKmh, maxRpm ? rpm / maxRpm : 0]);
      }
      hist.draw();

      // navigation compass: heading every frame (cheap), position polled slowly
      compass.setHeading(T.sensors.yaw || 0);
      compass.draw();
      if (histAccum % 18 === 0) pollPosition();

      // DOM-list rebuilds are throttled - they don't need 60fps
      if (domTick) {
        updateIndicators(e);
        updateReadouts(e, speedKmh, rpm);
        updateWheels();
        updateNavSide(e, speedKmh);
        if (window.Customize && Customize.updateTiles) Customize.updateTiles(e);
        if (!rawTable.classList.contains("hidden")) renderRaw(e);
      }
    }

    // diagnostics tab: ~12fps update only while it's the active page
    if (histAccum % 5 === 0 && $("#page-diag").classList.contains("active")) updateDiag(e);
    // damage poll is an async Lua round-trip - keep it to ~1 Hz while visible
    if (histAccum % 60 === 0 && $("#page-diag").classList.contains("active")) pollDamage();
    // CSV telemetry sampler (~5 Hz) when logging is armed
    if (histAccum % 12 === 0) sampleLog(e);
    // suspension tab: ~20fps so the load history & damper bars stay responsive
    if (histAccum % 3 === 0 && $("#page-susp").classList.contains("active")) updateSusp(e);
    // per-wheel ground material is a vehicle-VM round-trip - poll it ~3 Hz while visible
    if (histAccum % 20 === 0 && $("#page-susp").classList.contains("active")) pollSurface();
    // vehicle tab: keep the live fuel readout fresh
    if (histAccum % 15 === 0 && $("#page-vehicle").classList.contains("active")) {
      var fl = $("#fuelLevel"); if (fl) fl.textContent = e.fuel != null ? Math.round(e.fuel * 100) + "%" : "–";
    }
    // stats tab: live FPS / memory / VRAM via one combined engine round-trip (~2 Hz)
    if (histAccum % 30 === 0 && $("#page-stats").classList.contains("active")) { pollPerf(); fetchSysInfo(); }
  }

  // ----------------------------------------------------------- indicators
  var INDS = {
    parkingbrake: { test: function (e) { return e.parkingbrake > 0.5; }, cls: "red" },
    signal_L: { test: function (e) { return e.signal_L > 0.5; }, cls: "green" },
    signal_R: { test: function (e) { return e.signal_R > 0.5; }, cls: "green" },
    // NOTE: electrics.lights is a ramping light *intensity* (low beam can sit
    // ~0.2), so use the discrete state fields for clean on/off detection.
    lights: { test: function (e) { return e.lights_state >= 1 || e.lowhighbeam > 0.5; }, cls: "" },
    highbeam: { test: function (e) { return e.highbeam > 0.5 || e.lights_state >= 2; }, cls: "" },
    abs: { test: function (e) { return e.abs > 0.5; }, cls: "" },
    tcsActive: { test: function (e) { return e.tcsActive > 0.5; }, cls: "" },
    espActive: { test: function (e) { return e.espActive > 0.5 || e.escActive > 0.5; }, cls: "" },
    lowfuel: { test: function (e) { return !!e.lowfuel; }, cls: "red" },
    checkengine: { test: function (e) { return !!e.checkengine; }, cls: "red" },
    hazard: { test: function (e) { return e.hazard_enabled > 0.5 || (e.signal_L > 0.5 && e.signal_R > 0.5); }, cls: "yellow" },
    cruiseControlActive: { test: function (e) { return e.cruiseControlActive > 0.5; }, cls: "" }
  };
  function updateIndicators(e) {
    $$(".ind").forEach(function (el) {
      var k = el.dataset.k, def = INDS[k];
      var on = def ? def.test(e) : false;
      el.classList.toggle("on", !!on);
      el.classList.toggle("green", def && def.cls === "green");
      el.classList.toggle("yellow", def && def.cls === "yellow");
      el.classList.toggle("red", def && def.cls === "red");
    });
  }

  function fmt(v, d) { return (v == null || isNaN(v)) ? "–" : Number(v).toFixed(d == null ? 1 : d); }
  function updateReadouts(e, speedKmh, rpm) {
    var fuelPct = e.fuel != null ? (e.fuel * 100) : null;
    var U = AVCP.Units;
    var prim = U.speed(speedKmh), sec = U.system === "imperial" ? { val: speedKmh, unit: "km/h" } : { val: speedKmh / 1.609344, unit: "mph" };
    var water = e.watertemp != null ? U.temp(e.watertemp) : null;
    var oil = e.oiltemp != null ? U.temp(e.oiltemp) : null;
    var odo = e.odometer != null ? U.dist(e.odometer / 1000) : null;
    var rows = [
      ["Speed", fmt(prim.val, 0) + " " + prim.unit],
      ["Speed", fmt(sec.val, 0) + " " + sec.unit],
      ["RPM", fmt(rpm, 0)],
      ["Fuel", fuelPct == null ? "–" : fmt(fuelPct, 0) + " %"],
      ["Water", water ? fmt(water.val, 0) + " " + water.unit : "–"],
      ["Oil", oil ? fmt(oil.val, 0) + " " + oil.unit : "–"],
      ["Altitude", e.altitude != null ? (function (a) { return fmt(a.val, 0) + " " + a.unit; })(U.alt(e.altitude)) : "–"],
      ["Odometer", odo ? fmt(odo.val, 1) + " " + odo.unit : "–"]
    ];
    $("#readouts").innerHTML = rows.map(function (r) {
      return '<div class="ro"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");
  }

  // ----------------------------------------------------------- wheels
  function updateWheels() {
    var w = T.wheelInfo;
    // wheelInfo can arrive as an object (numeric keys) or an array
    var arr = !w ? [] : (Array.isArray(w) ? w : Object.keys(w).map(function (k) { return w[k]; }));
    arr = arr.filter(function (v) { return v && typeof v[0] === "string"; });
    if (!arr.length) { $("#wheels").innerHTML = '<div class="hint">No wheel data.</div>'; return; }
    // value format: [name, radius, wheelDir, angularVelocity, lastTorque, lastSlip, lastTorqueMode]
    var sorted = arr.sort(function (a, b) { return (a[0] > b[0]) ? 1 : -1; });
    $("#wheels").innerHTML = sorted.map(function (v) {
      var slip = Math.min(1, Math.abs(v[5] || 0) / 10);
      var spd = AVCP.Units.speed(Math.abs((v[3] || 0) * (v[1] || 0)) * 3.6);
      return '<div class="wheel"><div class="wn">' + v[0] + "</div>" +
        '<div class="wsub">' + spd.val.toFixed(0) + " " + spd.unit + " · slip " + (v[5] || 0).toFixed(1) + "</div>" +
        '<div class="wbar"><i style="width:' + (slip * 100).toFixed(0) + '%"></i></div></div>';
    }).join("");
  }

  // ----------------------------------------------------------- diagnostics
  var diagDrivetrain = ""; // set from vehicle details in refreshVehicle
  function fnode(h, v, s, active) {
    return '<div class="fnode' + (active ? " active" : "") + '"><div class="fh">' + h +
      '</div><div class="fv">' + v + '</div><div class="fs">' + (s || "") + "</div></div>";
  }
  function farrow(flow) { return '<div class="farrow' + (flow ? " flowing" : "") + '">▶</div>'; }
  function updateDiag(e) {
    // --- thermals (all from the electrics stream) ---
    // bar fill & warn thresholds stay in native units (°C / psi); only the
    // value text is converted to the user's units
    var THCFG = [
      { l: "Coolant", v: e.watertemp, kind: "temp", max: 120, warm: 100, hot: 110 },
      { l: "Oil", v: e.oiltemp, kind: "temp", max: 150, warm: 120, hot: 135 },
      { l: "Turbo", v: e.turboBoost != null ? e.turboBoost : e.boost, kind: "press", max: Math.max(20, (e.boostMax || 10) * 1.6), data: true },
      { l: "Load", v: (e.engineLoad || 0) * 100, unit: "%", max: 100, warm: 85, hot: 97 },
      { l: "Fuel", v: (e.fuel || 0) * 100, unit: "%", max: 100, low: true, warm: 25, hot: 12 }
    ];
    $("#thermo").innerHTML = THCFG.map(function (c) {
      var v = (c.v == null || isNaN(c.v)) ? 0 : c.v;
      var pct = Math.max(0, Math.min(100, (v / c.max) * 100));
      var col = c.data ? "var(--data)"
        : c.low ? (v > c.warm ? "#34d058" : (v > c.hot ? "#ffd21a" : "#ff4d4d"))
          : (v >= c.hot ? "#ff4d4d" : (v >= c.warm ? "#ffd21a" : "#34d058"));
      var disp = c.kind === "temp" ? AVCP.Units.temp(v)
        : c.kind === "press" ? AVCP.Units.press(v)
          : { val: v, unit: c.unit };
      var dec = c.kind === "press" && disp.unit === "bar" ? 1 : 0;
      return '<div class="tm"><div class="tl">' + c.l + '</div><div class="tt"><i style="width:' +
        pct.toFixed(0) + "%;background:" + col + '"></i></div><div class="tv">' + disp.val.toFixed(dec) + " " + disp.unit + "</div></div>";
    }).join("");

    // --- brakes: merge wheelInfo (power/force) with wheelThermals (temp/fade) ---
    // wheelInfo idx: [1]=radius [3]=angularVel [7]=downForce [8]=brakingTorque(N·m)
    var wmap = wheelInfoMap();
    var wt = e.wheelThermals || {};
    var bnames = Object.keys(wmap).length ? Object.keys(wmap) : Object.keys(wt);
    bnames.sort();
    var totBW = 0, totBF = 0;
    $("#brakeGrid").innerHTML = bnames.length ? bnames.map(function (n) {
      var v = wmap[n], b = wt[n];
      var bt = v ? Math.abs(v[8] || 0) : 0;        // braking torque (N·m)
      var av = v ? Math.abs(v[3] || 0) : 0;        // angular velocity (rad/s)
      var rad = v ? (v[1] || 0.3) : 0.3;
      var powW = bt * av, forceN = rad > 0 ? bt / rad : 0;
      totBW += powW; totBF += forceN;
      var t = b ? (b.brakeSurfaceTemperature || 0) : null;
      var eff = b ? (b.brakeThermalEfficiency != null ? b.brakeThermalEfficiency : 1) * 100 : null;
      var pct = t != null ? Math.max(0, Math.min(100, t / 600 * 100)) : 0;
      var col = t == null ? "var(--faint)" : (t >= 450 ? "#ff4d4d" : (t >= 250 ? "#ffd21a" : "#34d058"));
      var fade = eff != null && eff < 85;
      var tDisp = t != null ? AVCP.Units.temp(t) : null;
      return '<div class="brk"><div class="bn"><span>' + n + '</span><span style="color:' +
        (fade ? "var(--bad)" : "var(--faint)") + '">' + (eff != null ? eff.toFixed(0) + "% eff" : "") + "</span></div>" +
        '<div class="bt" style="color:' + col + '">' + (tDisp != null ? tDisp.val.toFixed(0) + tDisp.unit : "–") + "</div>" +
        '<div class="bpow">' + (powW / 1000).toFixed(1) + " kW · " + (forceN / 1000).toFixed(2) + " kN</div>" +
        '<div class="bbar"><i style="width:' + pct.toFixed(0) + "%;background:" + col + '"></i></div></div>';
    }).join("") : '<div class="hint">No wheel data.</div>';
    var tKw = totBW / 1000, tHp = tKw / 0.7457, tKn = totBF / 1000;
    $("#brakeTotal").textContent = tKw > 0.05 ? (tKw.toFixed(1) + " kW · " + tHp.toFixed(0) + " hp · " + tKn.toFixed(1) + " kN") : "no braking";

    // --- powertrain flow ---
    var rpm = e.rpm != null ? e.rpm : 0;
    var load = (e.engineLoad || 0) * 100;
    var boost = e.turboBoost != null ? e.turboBoost : (e.boost || 0);
    var thr = e.throttle || 0;
    var clutch = (e.clutchRatio != null ? e.clutchRatio : 1) * 100;
    var gear = (e.gear != null && e.gear !== "") ? e.gear : "N";
    var ds = e.driveshaft != null ? e.driveshaft : 0;
    var h = "";
    var boostD = AVCP.Units.press(boost);
    h += fnode("Engine", rpm.toFixed(0), Math.round(load) + "% load" + (boost > 0.5 ? " · " + boostD.val.toFixed(boostD.unit === "bar" ? 1 : 0) + " " + boostD.unit : ""), e.engineRunning > 0.5 || rpm > 10);
    h += farrow(thr > 0.05);
    h += fnode("Clutch", clutch.toFixed(0) + "%", e.isShifting > 0.5 ? "shifting" : "", clutch > 5);
    h += farrow(clutch > 5);
    h += fnode("Trans", gear, e.gearboxMode || "", true);
    h += farrow(Math.abs(ds) > 1);
    h += fnode("Driveshaft", Math.abs(ds).toFixed(0), diagDrivetrain || (e.mode4WD ? "4WD" : ""), Math.abs(ds) > 1);
    h += farrow(true);
    var wa = (function () {
      var w = T.wheelInfo;
      var arr = !w ? [] : (Array.isArray(w) ? w : Object.keys(w).map(function (k) { return w[k]; }));
      return arr.filter(function (v) { return v && typeof v[0] === "string"; }).sort(function (a, b) { return a[0] > b[0] ? 1 : -1; });
    })();
    var wheelsHtml = wa.map(function (v) {
      var tq = v[4] || 0, driven = Math.abs(tq) > 1;
      // center-origin bar: drive torque grows right (accent), engine-braking /
      // reverse grows left (data) so sign is readable at a glance.
      var half = Math.min(50, Math.abs(tq) / 800 * 50);
      var fill = tq >= 0
        ? '<i class="pos" style="width:' + half.toFixed(0) + '%"></i>'
        : '<i class="neg" style="width:' + half.toFixed(0) + '%"></i>';
      return '<div class="fwheel' + (driven ? " driven" : "") + '"><div class="fwn">' + v[0] +
        '</div><div class="fwt">' + tq.toFixed(0) + '</div><div class="fwbar signed"><div class="fwmid"></div>' + fill + '</div></div>';
    }).join("");
    h += '<div class="fnode" style="min-width:auto"><div class="fh">Wheels · N·m</div><div class="fwheels">' +
      (wheelsHtml || '<span class="fs">no data</span>') + "</div></div>";
    $("#powerFlow").innerHTML = h;
    $("#flowLayout").textContent = diagDrivetrain ? (diagDrivetrain + (e.mode4WD ? " · 4WD " + e.mode4WD : "")) : (e.mode4WD ? "4WD mode " + e.mode4WD : "");
  }

  // --------------------------------------------------- suspension / chassis
  var DIMC = "#8d9aa9";
  // wheelInfo arrives as an object keyed numerically (or array); return name->row
  function wheelInfoMap() {
    var w = T.wheelInfo;
    var arr = !w ? [] : (Array.isArray(w) ? w : Object.keys(w).map(function (k) { return w[k]; }));
    var m = {};
    arr.forEach(function (v) { if (v && typeof v[0] === "string") m[v[0]] = v; });
    return m;
  }
  function cfit(canvas) {
    var r = window.devicePixelRatio || 1;
    var cw = canvas.clientWidth || 300, ch = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(cw * r) || canvas.height !== Math.round(ch * r)) {
      canvas.width = Math.round(cw * r); canvas.height = Math.round(ch * r);
    }
    var ctx = canvas.getContext("2d"); ctx.setTransform(r, 0, 0, r, 0, 0);
    return { ctx: ctx, w: cw, h: ch };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  var suspHist = {}, suspLast = {}, suspMax = 2, SUSP_CAP = 200;
  var compHist = {}, suspStatic = {}, suspTs = 0, COMP_MAX = 2.5;
  var SUSP_PAL = ["#ff7a18", "#3cc6ff", "#34d058", "#ffd21a", "#9b7bff", "#ff4d4d"];
  // off-road / pre-runner session peaks (accumulate while the Suspension tab is open)
  function freshOrStats() { return { landG: 0, cornerLoad: 0, air: 0, flex: 0, airNow: 0, flying: false }; }
  var orStats = freshOrStats();
  function suspReset() {
    suspHist = {}; suspLast = {}; suspStatic = {}; compHist = {}; suspMax = 2;
    orStats = freshOrStats(); wheelMat = {};
  }
  br.on("hook:VehicleChange", suspReset);
  br.on("hook:VehicleFocusChanged", suspReset);
  (function () { var b = $("#orReset"); if (b) b.addEventListener("click", function () { suspReset(); toast("off-road stats reset"); }); })();

  // --- ground surface under each wheel -------------------------------------
  // Official path: each wheel's contactMaterialID1 (vehicle VM; -1 = airborne)
  // indexes the engine ground-model registry, and be:getGroundModelByID(i).data.name
  // (GE VM) resolves it to a name. So we cache id->name once per level and poll the
  // per-wheel ids ~3 Hz while the tab is open. (The runtime id order is NOT the
  // groundmodels.json order - e.g. asphalt is id 10/29 - which is exactly why we
  // resolve names from the engine instead of assuming the file order.)
  var gmNames = {}, gmFetching = false, wheelMat = {}, surfInflight = false;
  function fetchGroundModels() {
    if (!br.connected || gmFetching) return;
    gmFetching = true;
    // be:getGroundModelByID(i).data is USERDATA - its fields are only reachable
    // via :as_table() (NOT .data.name directly; that returns nil), then .name.
    br.engineLuaCb("(function() local t={} local n=(be.getGroundModelCount and be:getGroundModelCount()) or 0 for i=0,n do local gm=be:getGroundModelByID(i) if gm and gm.data then local ok,tbl=pcall(function() return gm.data:as_table() end) if ok and tbl and tbl.name and tbl.name~='' then t[tostring(i)]=tbl.name end end end return t end)()")
      .then(function (t) { gmFetching = false; if (t && typeof t === "object" && Object.keys(t).length) gmNames = t; });
  }
  // raw ground-model name -> compact label + colour class (dirt/mud/rock/gravel/sand/asphalt …).
  // Level ground-models use compound names (DIRT_GRASS, DIRT_ROCKY, ROCKYDIRT,
  // GROUNDMODEL_ASPH, …); order matters - DIRT is matched before ROCK so a rocky-DIRT
  // trail reads DIRT and only solid rock reads ROCK.
  function surfInfo(matId) {
    if (matId == null) return { label: "…", cls: "unknown" };
    if (matId === -1 || matId === "-1") return { label: "AIR", cls: "air" };
    var raw = gmNames[matId] != null ? gmNames[matId] : gmNames[String(matId)];
    if (raw == null) { if (!gmFetching) fetchGroundModels(); return { label: "…", cls: "unknown" }; }
    var n = String(raw).toUpperCase();
    if (!n) return { label: "…", cls: "unknown" };
    function has(s) { return n.indexOf(s) >= 0; }
    if (has("MUD")) return { label: "MUD", cls: "mud" };
    if (has("SAND")) return { label: "SAND", cls: "sand" };
    if (has("SNOW")) return { label: "SNOW", cls: "snow" };
    if (n === "ICE") return { label: "ICE", cls: "ice" };
    if (has("SLIPPERY") || n === "FRICTIONLESS") return { label: "SLICK", cls: "ice" };
    if (has("GRAVEL")) return { label: "GRAVEL", cls: "gravel" };
    if (has("DIRT")) return { label: "DIRT", cls: "dirt" };
    if (has("ROCK")) return { label: "ROCK", cls: "rock" };
    if (has("GRASS") || has("LEAVES") || has("BRANCH")) return { label: "GRASS", cls: "grass" };
    if (has("COBBLE")) return { label: "COBBLE", cls: "paved" };
    if (has("ASPHALT") || has("ASPH") || n === "RUMBLE_STRIP") return { label: "ASPHALT", cls: "paved" };
    if (has("CONCRETE")) return { label: "CONCRETE", cls: "paved" };
    if (n === "GRID") return { label: "GRID", cls: "paved" };
    if (has("METAL") || n === "KICKPLATE" || n === "PLASTIC") return { label: "METAL", cls: "metal" };
    if (has("WOOD")) return { label: "WOOD", cls: "wood" };
    if (has("SPIKE")) return { label: "SPIKES", cls: "hazard" };
    if (n === "VOID" || has("COLLISION")) return { label: "-", cls: "unknown" };
    return { label: n.replace(/GROUNDMODEL_?/, "").replace(/_/g, " ") || "-", cls: "other" };
  }
  function pollSurface() {
    if (!br.connected || surfInflight) return;
    surfInflight = true;
    br.activeObjectLuaCb("(function() local t={} local wc=(wheels and wheels.wheelCount) or 0 for i=0,wc-1 do local w=wheels.wheels and wheels.wheels[i] if w and w.name then t[w.name]=w.contactMaterialID1 end end return t end)()")
      .then(function (m) { surfInflight = false; if (m && typeof m === "object") wheelMat = m; });
  }

  function updateSusp(e) {
    var wmap = wheelInfoMap();
    var names = Object.keys(wmap).sort();
    if (!names.length) {
      $("#damperGrid").innerHTML = '<div class="hint">No wheel data.</div>';
      $("#travelRow").innerHTML = '<div class="hint">No wheel data.</div>';
      return;
    }

    // dt for time-based off-road stats (airtime). Clamped so a tab that was hidden
    // and resumes doesn't dump a huge delta into the timers.
    var now = performance.now();
    var dt = suspTs ? Math.min(0.2, (now - suspTs) / 1000) : 0;
    suspTs = now;

    // per-corner vertical load (downForce, idx7) in kN + balance sums + quadrants
    var loads = {}, total = 0, fr = 0, rr = 0, lf = 0, rt = 0;
    var quad = { FL: 0, FR: 0, RL: 0, RR: 0 };
    names.forEach(function (n) {
      var kn = (wmap[n][7] || 0) / 1000; loads[n] = kn; total += kn;
      var front = n.charAt(0) === "F", left = n.charAt(n.length - 1) === "L";
      if (front) fr += kn; else rr += kn;
      if (left) lf += kn; else rt += kn;
      quad[(front ? "F" : "R") + (left ? "L" : "R")] += kn;
      (suspHist[n] || (suspHist[n] = [])).push(kn);
      if (suspHist[n].length > SUSP_CAP) suspHist[n].shift();
      if (kn > suspMax) suspMax = kn * 1.15;
      if (kn > orStats.cornerLoad) orStats.cornerLoad = kn;
    });

    // attitude / vertical load factor (also drives the static-learning gate + stats)
    var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
    var roll = (T.sensors.roll || 0) * 180 / Math.PI;
    var pitch = (T.sensors.pitch || 0) * 180 / Math.PI;
    var vg = -(T.sensors.gz2 != null ? T.sensors.gz2 : -grav) / grav; // ~1g at rest, higher on landings
    if (vg > orStats.landG) orStats.landG = vg;

    // --- adaptive per-corner resting load = the compression reference ----------
    // BeamNG has no suspension-travel stream, so learn each corner's settled
    // vertical load (only while the car is calm & on the ground) and read the live
    // load against it as compression (>1) / droop (<1) / airborne (~0).
    var comp = {};
    names.forEach(function (n) {
      var kn = loads[n];
      var rate = suspLast[n] != null ? Math.abs(kn - suspLast[n]) : 0;
      var settled = Math.abs(vg - 1) < 0.18 && rate < 0.06 && kn > 0.25;
      if (suspStatic[n] == null) suspStatic[n] = Math.max(kn, 0.1);
      else if (settled) suspStatic[n] += (kn - suspStatic[n]) * 0.03;
      comp[n] = kn / Math.max(suspStatic[n], 0.08);
      (compHist[n] || (compHist[n] = [])).push(comp[n]);
      if (compHist[n].length > SUSP_CAP) compHist[n].shift();
    });

    // articulation: diagonal (cross-axle) load imbalance - chassis twist over
    // uneven ground, the off-road flex/RTI signal.
    var flex = total > 0 ? Math.abs((quad.FL + quad.RR) - (quad.FR + quad.RL)) / total * 100 : 0;
    if (flex > orStats.flex) orStats.flex = flex;

    // airtime: a corner is "light" when it carries almost none of its resting load;
    // every wheel light = a jump. Track the longest continuous flight.
    var airborne = 0;
    names.forEach(function (n) { if (comp[n] < 0.1) airborne++; });
    if (airborne === names.length) {
      orStats.flying = true; orStats.airNow += dt;
      if (orStats.airNow > orStats.air) orStats.air = orStats.airNow;
    } else { orStats.flying = false; orStats.airNow = 0; }

    // --- chassis load map ---
    var f = cfit($("#chassisMap")), ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var bw = w * 0.34, bh = h * 0.60, bx = w / 2 - bw / 2, by = h / 2 - bh / 2;
    ctx.fillStyle = "rgba(60,198,255,0.06)"; ctx.strokeStyle = "rgba(60,198,255,0.40)"; ctx.lineWidth = 1.5;
    roundRect(ctx, bx, by, bw, bh, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = DIMC; ctx.font = "600 10px 'Segoe UI',sans-serif"; ctx.textAlign = "center";
    ctx.fillText("FRONT", w / 2, by - 7);
    var avg = total / Math.max(1, names.length);
    names.forEach(function (n) {
      var front = n.charAt(0) === "F", left = n.charAt(n.length - 1) === "L";
      var cx = left ? bx : bx + bw, cy = front ? by : by + bh;
      var kn = loads[n], ratio = avg > 0 ? kn / avg : 1;
      var R = 11 + Math.min(28, kn * 1.6);
      var col = kn < avg * 0.4 ? "#3cc6ff" : (ratio > 1.35 ? "#ff4d4d" : (ratio > 1.1 ? "#ffd21a" : "#34d058"));
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.globalAlpha = 0.85; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#0c1014"; ctx.font = "700 11px 'Segoe UI',sans-serif";
      ctx.fillText(kn.toFixed(1), cx, cy + 4);
      ctx.fillStyle = DIMC; ctx.font = "600 9px 'Segoe UI',sans-serif";
      ctx.fillText(n, cx, cy - R - 4);
    });

    // --- off-road travel columns (per-corner compression / droop) ---
    // travel position: 0 = full droop (no load), .5 = resting, 1 = hard bump (>=2x rest)
    $("#travelRow").innerHTML = names.map(function (n) {
      var c = comp[n], travel = Math.max(0, Math.min(1, c / 2));
      var air = c < 0.1, light = c < 0.45;
      var state = air ? "AIR" : (light ? "LIGHT" : (c > 1.25 ? "LOADED" : "PLANTED"));
      var scls = air ? "air" : (light ? "light" : (c > 1.25 ? "loaded" : "planted"));
      var col = c >= 1 ? "var(--accent)" : "var(--data)";
      var sf = surfInfo(wheelMat[n]); // ground material under this wheel
      return '<div class="tcol' + (air ? " is-air" : "") + '">' +
        '<div class="ttrack"><div class="tstatic"></div>' +
        '<div class="tfill" style="height:' + (travel * 100).toFixed(1) + "%;background:" + col + '"></div></div>' +
        '<div class="tcn">' + n + '</div>' +
        '<div class="tsurf surf-' + sf.cls + '">' + sf.label + '</div>' +
        '<div class="tmeta"><span class="tstate ' + scls + '">' + state + '</span><span class="tcv">' + Math.round(c * 100) + '%</span></div>' +
        '</div>';
    }).join("");

    // articulation / cross-axle flex meter
    $("#orFlexVal").textContent = flex.toFixed(0) + "%";
    var ff = $("#orFlexFill");
    ff.style.width = Math.min(100, flex) + "%";
    ff.style.background = flex > 35 ? "var(--accent)" : (flex > 15 ? "var(--warn)" : "var(--data)");
    $("#orFlightState").textContent = orStats.flying ? "✈ AIRBORNE" : "";

    // off-road session peaks
    $("#orStats").innerHTML = [
      ["Peak landing", orStats.landG.toFixed(2) + "g"],
      ["Max corner load", orStats.cornerLoad.toFixed(1) + " kN"],
      ["Longest air", orStats.air.toFixed(2) + " s"],
      ["Flex peak", orStats.flex.toFixed(0) + "%"]
    ].map(function (a) {
      return '<div class="ors"><div class="orsl">' + a[0] + '</div><div class="orsv">' + a[1] + "</div></div>";
    }).join("");

    // --- per-corner load history (shared scale) ---
    var f2 = cfit($("#loadChart")), c2 = f2.ctx, w2 = f2.w, h2 = f2.h, pad = 6;
    c2.clearRect(0, 0, w2, h2);
    c2.strokeStyle = "rgba(255,255,255,0.07)"; c2.lineWidth = 1;
    for (var g = 0; g <= 4; g++) { var gy = pad + (h2 - 2 * pad) * g / 4; c2.beginPath(); c2.moveTo(0, gy); c2.lineTo(w2, gy); c2.stroke(); }
    c2.fillStyle = DIMC; c2.font = "600 9px monospace"; c2.textAlign = "left";
    c2.fillText(suspMax.toFixed(1) + " kN", 4, pad + 9);
    names.forEach(function (n, si) {
      var col = SUSP_PAL[si % SUSP_PAL.length], data = suspHist[n] || [];
      c2.fillStyle = col; c2.font = "700 10px 'Segoe UI',sans-serif"; c2.textAlign = "left";
      c2.fillText(n, 60 + si * 32, pad + 9);
      if (data.length < 2) return;
      c2.strokeStyle = col; c2.lineWidth = 1.8; c2.beginPath();
      for (var i = 0; i < data.length; i++) {
        var x = w2 * i / (SUSP_CAP - 1);
        var yy = pad + (h2 - 2 * pad) * (1 - Math.max(0, Math.min(1, data[i] / suspMax)));
        if (i === 0) c2.moveTo(x, yy); else c2.lineTo(x, yy);
      }
      c2.stroke();
    });

    // --- suspension compression (live, normalized to learned resting load) ---
    var f3 = cfit($("#compChart")), c3 = f3.ctx, w3 = f3.w, h3 = f3.h, pad3 = 6;
    c3.clearRect(0, 0, w3, h3);
    function compY(v) { return pad3 + (h3 - 2 * pad3) * (1 - Math.max(0, Math.min(1, v / COMP_MAX))); }
    c3.strokeStyle = "rgba(255,255,255,0.07)"; c3.lineWidth = 1;
    [0, 1, 2].forEach(function (gv) { var gy = compY(gv); c3.beginPath(); c3.moveTo(0, gy); c3.lineTo(w3, gy); c3.stroke(); });
    // static (1.0x) reference line, dashed & emphasized
    var sy = compY(1);
    c3.setLineDash([5, 4]); c3.strokeStyle = "rgba(141,154,169,0.55)"; c3.lineWidth = 1.2;
    c3.beginPath(); c3.moveTo(0, sy); c3.lineTo(w3, sy); c3.stroke(); c3.setLineDash([]);
    c3.fillStyle = DIMC; c3.font = "600 9px monospace"; c3.textAlign = "left";
    c3.fillText("2.0×", 4, compY(2) + 9); c3.fillText("static 1.0×", 4, sy - 4); c3.fillText("droop 0", 4, compY(0) - 3);
    names.forEach(function (n, si) {
      var col = SUSP_PAL[si % SUSP_PAL.length], data = compHist[n] || [];
      c3.fillStyle = col; c3.font = "700 10px 'Segoe UI',sans-serif"; c3.textAlign = "left";
      c3.fillText(n, 70 + si * 32, pad3 + 9);
      if (data.length < 2) return;
      c3.strokeStyle = col; c3.lineWidth = 1.8; c3.beginPath();
      for (var i = 0; i < data.length; i++) {
        var x = w3 * i / (SUSP_CAP - 1);
        if (i === 0) c3.moveTo(x, compY(data[i])); else c3.lineTo(x, compY(data[i]));
      }
      c3.stroke();
    });

    // --- damper activity (rate of load change = bump/rebound) ---
    $("#damperGrid").innerHTML = names.map(function (n) {
      var rate = suspLast[n] != null ? (loads[n] - suspLast[n]) : 0;
      suspLast[n] = loads[n];
      var mag = Math.max(0, Math.min(1, Math.abs(rate) / 0.6)), hPct = mag * 46;
      var up = rate >= 0, top = up ? (50 - hPct) : 50, col = up ? "var(--accent)" : "var(--data)";
      var dir = Math.abs(rate) < 0.02 ? "-" : (up ? "▲ bump" : "▼ rebound");
      return '<div class="dmp"><div class="dn"><span>' + n + '</span><span style="color:' + col + '">' + dir + "</span></div>" +
        '<div class="dtrack"><div class="dmid"></div><div class="dfill" style="top:' + top + "%;height:" + hPct + "%;background:" + col + '"></div></div></div>';
    }).join("");

    // --- attitude readouts (roll/pitch/vg computed above) ---
    var att = [
      ["Roll", roll.toFixed(1) + "°"], ["Pitch", pitch.toFixed(1) + "°"], ["Vert G", vg.toFixed(2) + "g"],
      ["Total", total.toFixed(1) + " kN"],
      ["Front/Rear", total > 0 ? (fr / total * 100).toFixed(0) + "/" + (rr / total * 100).toFixed(0) + "%" : "–"],
      ["Left/Right", total > 0 ? (lf / total * 100).toFixed(0) + "/" + (rt / total * 100).toFixed(0) + "%" : "–"]
    ];
    $("#suspAttitude").innerHTML = att.map(function (a) {
      return '<div class="sa"><div class="sal">' + a[0] + '</div><div class="sav">' + a[1] + "</div></div>";
    }).join("");
    $("#suspTotal").textContent = total > 0 ? total.toFixed(1) + " kN" : "–";
  }

  // ----------------------------------------------------------- raw table
  var rawTable = $("#rawTable");
  $("#rawToggle").addEventListener("click", function () {
    rawTable.classList.toggle("hidden");
    this.textContent = rawTable.classList.contains("hidden") ? "show" : "hide";
  });
  function renderRaw(e) {
    var keys = Object.keys(e).sort();
    rawTable.innerHTML = keys.map(function (k) {
      var val = e[k];
      if (typeof val === "number") val = Math.abs(val) > 100 ? val.toFixed(0) : val.toFixed(3);
      else if (typeof val === "boolean") val = val ? "true" : "false";
      else if (val == null) val = "nil";
      return '<div class="kv"><span>' + k + "</span><b>" + val + "</b></div>";
    }).join("");
  }

  // ================================================================ VEHICLE
  function refreshVehicle() {
    br.engineLuaCb("core_vehicles.getCurrentVehicleDetails()").then(function (d) {
      if (!d) { $("#vehName").textContent = "no vehicle"; $("#vehInfoTable").innerHTML = '<div class="hint">No vehicle.</div>'; return; }
      var name = (d.model && (d.model.Name || d.model.name)) || d.current && d.current.model || "vehicle";
      var cfg = (d.configs && (d.configs.Configuration || d.configs.Name)) || (d.current && d.current.config) || "";
      $("#vehName").textContent = cfg ? (name + " · " + cfg) : name;

      var info = [];
      var m = d.model || {};
      diagDrivetrain = m.Drivetrain || "";
      [["Name", m.Name], ["Brand", m.Brand], ["Type", m.Type], ["Body", m.BodyStyle],
       ["Years", (m.Years && (m.Years.min + "–" + m.Years.max))], ["Weight", m.Weight && (m.Weight + " kg")],
       ["Config", cfg], ["Power", m.Power && (m.Power + " hp")], ["Torque", m.Torque && (m.Torque + " Nm")],
       ["Drivetrain", m.Drivetrain], ["Top speed", m["Top Speed"]], ["0-100", m["0-100 km/h"]]
      ].forEach(function (r) { if (r[1]) info.push(r); });
      $("#vehInfoTable").innerHTML = info.length ? info.map(function (r) {
        return '<div class="kv"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
      }).join("") : '<div class="hint">Details unavailable for this vehicle.</div>';
    });
  }

  function aoLua(cmd) { return function () { br.activeObjectLua(cmd); toast("✓ sent"); }; }
  function geLua(cmd) { return function () { br.engineLua(cmd); toast("✓ sent"); }; }

  function buildButtons(containerId, defs) {
    $(containerId).innerHTML = "";
    defs.forEach(function (d) {
      var b = document.createElement("button");
      b.className = "btn" + (d.primary ? " primary" : "") + (d.big ? " big" : "") + (d.cls ? " " + d.cls : "");
      b.textContent = d.label;
      b.addEventListener("click", d.fn);
      $(containerId).appendChild(b);
    });
  }

  // ---- powertrain / recovery actions (dialed in against the live vehicle VM) -
  // The in-game shift & ignition keybinds are press+release PAIRS processed
  // across physics frames; firing OnDown and OnUp in the SAME command cancels
  // them out. So we space the pair. (Verified live: controller.mainController
  // exposes shiftUpOnDown/OnUp + shiftDownOnDown/OnUp - there is NO shiftUp()/
  // shiftDown(), which is why the old calls silently did nothing.)
  function tapPair(downCmd, upCmd, gapMs) {
    br.activeObjectLua(downCmd);
    setTimeout(function () { br.activeObjectLua(upCmd); }, gapMs || 130);
  }
  // Most of these need physics running to take effect (the sim must be unpaused).
  function frameToast(label) { toast(label); }
  function vehShift(dir) {
    var d = dir > 0 ? "Up" : "Down";
    tapPair(
      "if controller.mainController and controller.mainController.shift" + d + "OnDown then controller.mainController.shift" + d + "OnDown() end",
      "if controller.mainController and controller.mainController.shift" + d + "OnUp then controller.mainController.shift" + d + "OnUp() end"
    );
    frameToast(dir > 0 ? "▲ shift up" : "▼ shift down");
  }
  function ignitionCycle() {
    tapPair(
      "if electrics.toggleIgnitionLevelOnDown then electrics.toggleIgnitionLevelOnDown() end",
      "if electrics.toggleIgnitionLevelOnUp then electrics.toggleIgnitionLevelOnUp() end"
    );
    frameToast("ignition");
  }
  function engineToggle() {
    br.activeObjectLuaCb("electrics.values.engineRunning").then(function (running) {
      if (running > 0.5) {
        br.activeObjectLua("if controller.mainController.setEngineIgnition then controller.mainController.setEngineIgnition(false) end");
        frameToast("engine off");
      } else {
        // ignition on + a momentary starter crank, released after ~0.9 s
        br.activeObjectLua("if controller.mainController.setEngineIgnition then controller.mainController.setEngineIgnition(true) end if controller.mainController.setStarter then controller.mainController.setStarter(true) end");
        setTimeout(function () { br.activeObjectLua("if controller.mainController.setStarter then controller.mainController.setStarter(false) end"); }, 900);
        frameToast("starting engine…");
      }
    });
  }
  // recovery.startRecovering() runs CONTINUOUSLY until stopped - the user wants a
  // fixed 3-second nudge back onto the road, so we stop it on a timer.
  var recoverTimer = null;
  function recoverToRoad() {
    br.activeObjectLua("recovery.startRecovering()");
    frameToast("recovering to road (3s)…");
    clearTimeout(recoverTimer);
    recoverTimer = setTimeout(function () {
      br.activeObjectLua("recovery.stopRecovering()"); toast("recovery stopped");
    }, 3000);
  }

  buildButtons("#vehActions", [
    { label: "Recover (unflip)", fn: aoLua("recovery.recoverInPlace()") },
    { label: "Recover to road (3s)", fn: recoverToRoad },
    { label: "Repair in place", primary: true, fn: aoLua("beamstate.reset()") },
    { label: "Reset to spawn", fn: geLua("if be then be:resetVehicle(0) end") },
    { label: "Reload vehicle", fn: geLua("core_vehicle_manager.reloadAllVehicles()") },
    { label: "Recenter wheels", fn: aoLua("electrics.values.steering = 0") }
  ]);

  buildButtons("#vehElectrics", [
    { label: "Headlights", fn: aoLua("electrics.toggle_lights()") },
    { label: "High beams", fn: aoLua("electrics.toggle_highbeams()") },
    { label: "Fog lights", fn: aoLua("electrics.toggle_fog_lights()") },
    { label: "Parking brake", fn: aoLua("input.toggleEvent('parkingbrake')") },
    { label: "Left signal", fn: aoLua("electrics.toggle_left_signal()") },
    { label: "Right signal", fn: aoLua("electrics.toggle_right_signal()") },
    { label: "Hazards", fn: aoLua("electrics.toggle_warn_signal()") },
    { label: "Horn (beep)", fn: function () { br.activeObjectLua("electrics.horn(true)"); setTimeout(function () { br.activeObjectLua("electrics.horn(false)"); }, 500); toast("📣"); } },
  ]);

  buildButtons("#vehPowertrain", [
    { label: "Shift up ▲", primary: true, fn: function () { vehShift(1); } },
    { label: "Shift down ▼", fn: function () { vehShift(-1); } },
    { label: "Ignition cycle", fn: ignitionCycle },
    { label: "Engine start/stop", fn: engineToggle }
  ]);

  $("#btnSpawn").addEventListener("click", function () {
    var m = $("#spawnModel").value.trim(); if (!m) return toast("enter a model key");
    br.engineLua('core_vehicles.spawnNewVehicle("' + m + '")'); toast("spawning " + m);
  });
  $("#btnReplace").addEventListener("click", function () {
    var m = $("#spawnModel").value.trim(); if (!m) return toast("enter a model key");
    br.engineLua('core_vehicles.replaceVehicle("' + m + '")'); toast("replacing with " + m);
    setTimeout(refreshVehicle, 800);
  });
  $("#btnDeleteVeh").addEventListener("click", geLua("core_vehicles.removeCurrent()"));
  $("#btnDeleteAll").addEventListener("click", geLua("core_vehicles.removeAllExceptCurrent()"));
  $$("#page-vehicle .hint code").forEach(function (c) {
    c.addEventListener("click", function () { $("#spawnModel").value = c.textContent; });
  });

  // ================================================================== WORLD
  function setTodSlider(t) { $("#todSlider").value = t; renderTod(t); }
  function renderTod(t) {
    // BeamNG time 0..1 with 0=noon-ish offset; display by mapping like game (+0.5)
    var disp = (t + 0.5) % 1;
    var h = Math.floor(disp * 24), m = Math.floor((disp * 24 - h) * 60);
    $("#todVal").textContent = ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2);
  }
  $("#todSlider").addEventListener("input", function () {
    var t = parseFloat(this.value); renderTod(t);
    br.engineLua("core_environment.setTimeOfDay({time=" + t + "})");
  });
  $$("[data-tod]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = parseFloat(b.dataset.tod); setTodSlider(t);
      br.engineLua("core_environment.setTimeOfDay({time=" + t + "})");
    });
  });
  var todPlaying = false;
  function renderTodPlay() { $("#todPlayState").textContent = todPlaying ? "ON" : "OFF"; }
  $("#todPlay").addEventListener("click", function () {
    todPlaying = !todPlaying; renderTodPlay();
    br.engineLua("core_environment.setState({play=" + (todPlaying ? "true" : "false") + "})");
  });

  // sim speed
  var SIMS = [["Real-time", 1], ["1/2", 0.5], ["1/4", 0.25], ["1/10", 0.1], ["1/25", 0.04], ["1/100", 0.01]];
  buildButtons("#simSpeeds", SIMS.map(function (s) {
    return { label: s[0], primary: s[1] === 1, fn: function () { br.engineLua("simTimeAuthority.set(" + s[1] + ")"); setSimPill(s[1]); } };
  }));
  // Sim-speed pill just reflects the current time scale (1.0× = real-time, 1/2× …).
  var lastSimFactor = 1;
  function setSimPill(v) {
    lastSimFactor = v;
    $("#simSpeedPill").textContent = (lastSimFactor >= 1 ? lastSimFactor.toFixed(1) : ("1/" + Math.round(1 / lastSimFactor))) + "×";
  }

  // gravity
  var GRAV = [["Earth", -9.81], ["Zero-G", 0], ["Moon", -1.62], ["Mars", -3.71], ["Jupiter", -24.92], ["Inverted", 9.81]];
  buildButtons("#gravityGrid", GRAV.map(function (g) {
    return { label: g[0], primary: g[1] === -9.81, fn: function () { br.engineLua("core_environment.setGravity(" + g[1] + ")"); toast(g[0] + " gravity"); } };
  }));

  // camera & sim misc
  buildButtons("#worldMisc", [
    { label: "Pause / resume", primary: true, fn: geLua("simTimeAuthority.togglePause()") },
    { label: "Free camera", fn: geLua("core_camera.setByName(0,'free')") },
    { label: "Orbit camera", fn: geLua("core_camera.setByName(0,'orbit')") },
    { label: "Chase camera", fn: geLua("core_camera.setByName(0,'external')") },
    { label: "Relative camera", fn: geLua("core_camera.setByName(0,'relative')") },
    { label: "Cycle camera", fn: geLua("core_camera.cycleCamera(0)") }
  ]);

  // weather
  $("#fogSlider").addEventListener("input", function () {
    br.engineLua("core_environment.setState({fogDensity=" + (parseFloat(this.value) * 1000) + "})");
  });
  $("#cloudSlider").addEventListener("input", function () {
    br.engineLua("core_environment.setState({cloudCover=" + parseFloat(this.value) + "})");
  });
  $("#windSlider").addEventListener("input", function () {
    br.engineLua("core_environment.setState({windSpeed=" + parseFloat(this.value) + "})");
  });

  // ================================================================== CHAOS
  // Instant state triggers (active-vehicle Lua). Deflate-all loops over the
  // vehicle's wheel set; break* are documented beamstate calls; repair rebuilds.
  buildButtons("#chaosTriggers", [
    { label: "[ Ignite Engine ]", cls: "danger big", fn: aoLua("fire.igniteVehicle()") },
    { label: "[ Extinguish ]", cls: "ok big", fn: aoLua("fire.extinguishVehicle()") },
    { label: "[ Deflate All Tires ]", cls: "danger big", fn: aoLua("for i=0,wheels.wheelCount-1 do beamstate.deflateTire(i) end") },
    { label: "[ Deflate Random ]", cls: "big", fn: aoLua("beamstate.deflateRandomTire()") },
    { label: "[ Break All Hinges ]", cls: "danger big", fn: aoLua("beamstate.breakHinges()") },
    { label: "[ Break Breakgroups ]", cls: "danger big", fn: aoLua("beamstate.breakAllBreakgroups()") },
    { label: "[ Repair ]", cls: "ok big", primary: true, fn: function () { br.activeObjectLua("beamstate.reset()"); toast("✓ repaired"); setTimeout(refreshVehicle, 300); } }
  ]);

  // Time dilation: shared setter keeps slider, presets, pill and readout in sync.
  function setSim(factor) {
    br.engineLua("simTimeAuthority.set(" + factor + ")");
    setSimPill(factor);
    var slow = factor > 0 ? Math.round(1 / factor) : 1;
    $("#chaosSlow").value = Math.max(1, Math.min(100, slow));
    $("#chaosSlowVal").textContent = (factor >= 1 ? "1.0×" : slow + "× slow");
    $("#chaosSimReadout").textContent = factor >= 1 ? "real-time" : "1 / " + slow + " speed";
  }
  $("#chaosSlow").addEventListener("input", function () {
    var n = parseInt(this.value, 10) || 1;
    setSim(n <= 1 ? 1 : 1 / n);
  });
  buildButtons("#chaosSims", SIMS.map(function (s) {
    return { label: s[0], primary: s[1] === 1, fn: function () { setSim(s[1]); } };
  }));
  // Momentary "hold to slow-mo": dives to 10× slow while held, restores the
  // slider's current factor on release.
  (function () {
    var hold = $("#chaosHold"), active = false;
    function restoreFactor() { var n = parseInt($("#chaosSlow").value, 10) || 1; return n <= 1 ? 1 : 1 / n; }
    function down(ev) { ev.preventDefault(); if (active) return; active = true; hold.classList.add("holding"); br.engineLua("simTimeAuthority.set(0.1)"); setSimPill(0.1); }
    function up() { if (!active) return; active = false; hold.classList.remove("holding"); var f = restoreFactor(); br.engineLua("simTimeAuthority.set(" + f + ")"); setSimPill(f); }
    hold.addEventListener("mousedown", down);
    hold.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mouseup", up);
    hold.addEventListener("touchend", up);
    hold.addEventListener("touchcancel", up);
  })();

  // Gravity matrix (presets mirror the World tab; same engine call).
  buildButtons("#chaosGravity", GRAV.map(function (g) {
    return { label: g[0], primary: g[1] === -9.81, fn: function () { br.engineLua("core_environment.setGravity(" + g[1] + ")"); $("#chaosGravSlider").value = g[1]; $("#chaosGravVal").textContent = g[1] + " m/s²"; toast(g[0] + " gravity"); } };
  }));
  $("#chaosGravSlider").addEventListener("input", function () {
    var v = parseFloat(this.value);
    $("#chaosGravVal").textContent = v.toFixed(2) + " m/s²";
    br.engineLua("core_environment.setGravity(" + v + ")");
  });

  // ============================================================ AI & TRAFFIC
  var AIMODES = [["Disable", "disabled"], ["Random roam", "random"], ["Span (explore)", "span"],
    ["Flee", "flee"], ["Chase", "chase"], ["Stop", "stop"]];
  buildButtons("#aiModes", AIMODES.map(function (m) {
    return { label: m[0], fn: function () { br.activeObjectLua('ai.setMode("' + m[1] + '")'); toast("AI: " + m[0]); } };
  }));
  $("#aiAggr").addEventListener("input", function () {
    $("#aiAggrVal").textContent = parseFloat(this.value).toFixed(2);
    br.activeObjectLua("ai.setAggression(" + parseFloat(this.value) + ")");
  });
  $("#aiSetSpeed").addEventListener("click", function () {
    var kmh = parseFloat($("#aiSpeed").value) || 0;
    br.activeObjectLua('ai.setMode("span"); ai.setSpeed(' + (kmh / 3.6) + "); ai.setSpeedMode('set')");
    toast("AI cruising at " + kmh + " km/h");
  });

  function trafficVars(obj) { br.engineLua("extensions.gameplay_traffic.setTrafficVars(" + br.serializeToLua(obj) + ")"); }
  $("#trafficActivate").addEventListener("click", function () {
    br.engineLua("extensions.gameplay_traffic.activate()");
    trafficVars({ enableRandomEvents: true }); toast("traffic activated");
  });
  $("#trafficDeactivate").addEventListener("click", function () {
    br.engineLua("extensions.gameplay_traffic.deactivate(true)"); toast("traffic off");
  });
  $("#trAmt").addEventListener("input", function () { $("#trAmtVal").textContent = this.value; });
  $("#trafficSpawn").addEventListener("click", function () {
    var n = parseInt($("#trAmt").value, 10);
    br.engineLua("extensions.core_multiSpawn.spawnGroup(extensions.gameplay_traffic_trafficUtils.createTrafficGroup(20)," + n + ")");
    toast("spawning " + n + " traffic");
  });
  $("#trafficDelete").addEventListener("click", function () {
    var n = parseInt($("#trAmt").value, 10);
    br.engineLua("extensions.core_multiSpawn.deleteVehicles(" + n + ")"); toast("deleting traffic");
  });
  $("#trAggr").addEventListener("input", function () {
    $("#trAggrVal").textContent = parseFloat(this.value).toFixed(2);
    trafficVars({ baseAggression: parseFloat(this.value) });
  });

  // ----------------------------------------------- quick spawn + chaos factor
  var PID = 0; // player vehicle id, refreshed alongside the behavior matrix
  $("#qsAmt").addEventListener("input", function () { $("#qsAmtVal").textContent = this.value; });
  function qsAmt() { return parseInt($("#qsAmt").value, 10) || 4; }
  function traffic(cmd) { return "extensions.gameplay_traffic." + cmd; }
  function setAiStatus(msg) {
    var el = $("#aiStatus");
    if (el) el.textContent = msg;
  }

  // Set every active traffic vehicle to chase the player at full aggression.
  function trafficChaseAll() {
    br.engineLua("(function() local p=be:getPlayerVehicleID(0) for id,_ in pairs(extensions.gameplay_traffic.getTrafficAiVehIds()) do local v=be:getObjectByID(tonumber(id) or id) if v then v:queueLuaCommand(\"ai.setAggressionMode('rubberBand'); ai.setAggression(1); ai.setTargetObjectID(\"..p..\"); ai.setMode('chase')\") end end end)()");
  }
  function trafficCalmAll() {
    br.engineLua("(function() for id,_ in pairs(extensions.gameplay_traffic.getTrafficAiVehIds()) do local v=be:getObjectByID(tonumber(id) or id) if v then v:queueLuaCommand(\"ai.setAggression(0.3); ai.setMode('traffic')\") end end end)()");
  }

  buildButtons("#qsGrid", [
    { label: "Traffic", primary: true, fn: function () {
        br.engineLua(traffic("setupTraffic(" + qsAmt() + ", 0)"));
        toast("spawning traffic");
        setAiStatus("Spawning " + qsAmt() + " traffic vehicles. Matrix refreshes automatically.");
        setTimeout(refreshMatrix, 2500);
      } },
    { label: "Police Patrol", fn: function () {
        br.engineLua(traffic("setupTraffic(" + qsAmt() + ", 0.5)"));
        toast("police patrol incoming");
        setAiStatus("Spawning " + qsAmt() + " patrol-capable traffic vehicles.");
        setTimeout(refreshMatrix, 2500);
      } },
    { label: "Police Chase", cls: "danger", fn: function () {
        br.engineLua(traffic("setupTraffic(" + qsAmt() + ", 0.6)"));
        toast("police chase arming");
        setAiStatus("Spawning police chase traffic and arming pursuit mode.");
        setTimeout(function () { br.engineLua("extensions.gameplay_police.setPursuitMode(2, be:getPlayerVehicleID(0))"); toast("pursuit active"); refreshMatrix(); }, 2800);
      } },
    { label: "Derby", cls: "danger", fn: function () {
        br.engineLua(traffic("setupTraffic(" + qsAmt() + ", 0)"));
        trafficVars({ baseAggression: 1, enableRandomEvents: true });
        toast("derby spawning");
        setAiStatus("Spawning aggressive traffic and switching them to chase after they appear.");
        setTimeout(function () { trafficChaseAll(); refreshMatrix(); }, 2800);
      } },
    { label: "Clear Traffic", fn: function () {
        br.engineLua(traffic("deactivate(false)"));
        br.engineLua(traffic("deleteVehicles()"));
        toast("traffic cleared");
        setAiStatus("Traffic cleared. Refresh the matrix if any external vehicles remain.");
        setTimeout(refreshMatrix, 400);
      } }
  ]);

  $("#chaosFac").addEventListener("input", function () {
    var f = parseInt(this.value, 10);
    $("#chaosFacVal").textContent = f + "%";
    var aggr = 0.2 + (f / 100) * 0.8; // 0.2 .. 1.0
    trafficVars({ baseAggression: aggr, enableRandomEvents: f >= 40 });
    // keep the finer Traffic-System slider in sync
    $("#trAggr").value = aggr; $("#trAggrVal").textContent = aggr.toFixed(2);
  });

  // -------------------------------------------------------- behavior matrix
  var AIMATRIX_MODES = [["Traffic", "traffic"], ["Wander", "random"], ["Follow", "follow"],
    ["Chase", "chase"], ["Flee", "flee"], ["Stop", "stop"], ["Disabled", "disabled"]];
  function setVehAi(id, mode) {
    var pre = (mode === "chase" || mode === "follow" || mode === "flee") ? "ai.setTargetObjectID(" + PID + "); " : "";
    var lua = pre + "ai.setMode('" + mode + "')";
    br.engineLua("be:getObjectByID(" + id + "):queueLuaCommand(\"" + lua + "\")");
  }
  function refreshMatrix() {
    br.engineLuaCb("(function() local p=be:getPlayerVehicleID(0) local r={} for _,v in ipairs(getAllVehicles()) do r[#r+1]={id=v:getId(), jb=v:getJBeamFilename()} end return {player=p, list=r} end)()").then(function (d) {
      if (!d || !d.list || !d.list.length) {
        $("#aiMatrix").innerHTML = '<div class="hint">No vehicles spawned.</div>';
        setAiStatus("No spawned vehicles found.");
        return;
      }
      PID = d.player || 0;
      var opts = AIMATRIX_MODES.map(function (m) { return '<option value="' + m[1] + '">' + m[0] + "</option>"; }).join("");
      $("#aiMatrix").innerHTML = d.list.map(function (v) {
        var isP = v.id === PID;
        var disabled = isP ? " disabled" : "";
        var playerLabel = isP ? " (you)" : "";
        return '<div class="ai-row' + (isP ? " player" : "") + '" data-id="' + v.id + '">' +
          '<span class="an">' + (v.jb || "vehicle") + playerLabel + "</span>" +
          '<span class="aid">#' + v.id + "</span>" +
          "<select" + disabled + ">" + opts + "</select></div>";
      }).join("");
      $$("#aiMatrix .ai-row select").forEach(function (sel) {
        sel.addEventListener("change", function () {
          if (this.disabled) return;
          var id = parseInt(this.parentNode.dataset.id, 10);
          setVehAi(id, this.value);
          toast("AI #" + id + ": " + this.value);
          setAiStatus("Vehicle #" + id + " set to " + this.value + ".");
        });
      });
      setAiStatus("Behavior matrix refreshed. Player vehicle is read-only here.");
    });
  }
  $("#matrixRefresh").addEventListener("click", refreshMatrix);
  $("#matrixChaseAll").addEventListener("click", function () { trafficChaseAll(); toast("traffic set to chase"); setAiStatus("Traffic vehicles are targeting you."); setTimeout(refreshMatrix, 400); });
  $("#matrixCalmAll").addEventListener("click", function () { trafficCalmAll(); toast("traffic calmed"); setAiStatus("Traffic vehicles returned to traffic mode."); setTimeout(refreshMatrix, 400); });
  $('.tab[data-tab="ai"]').addEventListener("click", refreshMatrix);
  br.on("hook:vehicleSpawned", function () { setTimeout(refreshMatrix, 500); });

  // ================================================================== STATS
  var S = { topSpeed: 0, maxRpm: 0, maxLat: 0, maxLon: 0, t0100: null, t060: null,
    dist: 0, launchArmed: false, launchStart: 0 };
  function resetStats() {
    S.topSpeed = 0; S.maxRpm = 0; S.maxLat = 0; S.maxLon = 0; S.t0100 = null; S.t060 = null;
    S.dist = 0; S.launchArmed = false; S.launchStart = 0;
    gMeter.reset(); renderStats();
  }
  $("#stReset").addEventListener("click", function () { resetStats(); toast("stats reset"); });
  $("#stArmLaunch").addEventListener("click", function () { S.launchArmed = true; S.launchStart = 0; S.t0100 = null; S.t060 = null; toast("0–100 armed: floor it from standstill"); });

  function updateStats(dt) {
    var e = T.electrics;
    var spd = Math.abs((e.wheelspeed != null ? e.wheelspeed : (e.airspeed || 0)) * 3.6);
    var rpm = e.rpm != null ? e.rpm : (T.engineInfo[4] || 0);
    var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
    var gx = Math.abs((T.sensors.gx2 != null ? T.sensors.gx2 : 0) / grav);
    var gy = Math.abs((T.sensors.gy2 != null ? T.sensors.gy2 : 0) / grav);

    if (spd > S.topSpeed) S.topSpeed = spd;
    if (rpm > S.maxRpm) S.maxRpm = rpm;
    if (gx > S.maxLat) S.maxLat = gx;
    if (gy > S.maxLon) S.maxLon = gy;
    if (dt > 0 && dt < 0.5) S.dist += (spd / 3.6) * dt;

    // 0-100 timer
    if (spd < 1) { S.launchStart = 0; if (S.launchArmed) { /* ready */ } }
    if (S.launchStart === 0 && spd > 1) S.launchStart = performance.now();
    if (S.launchStart > 0) {
      var el = (performance.now() - S.launchStart) / 1000;
      if (S.t060 == null && spd >= 96.56) S.t060 = el;
      if (S.t0100 == null && spd >= 100) { S.t0100 = el; S.launchArmed = false; }
    }
    // driving alerts (shift light / overspeed) ride the same stream cadence
    if (window.Customize) Customize.tick(spd, rpm, T.engineInfo[1] || 0);
    // stats accumulate every frame; the DOM only needs painting while visible
    if ($("#page-stats").classList.contains("active")) renderStats();
  }
  function renderStats() {
    var U = AVCP.Units;
    var ts = U.speed(S.topSpeed), di = U.dist(S.dist / 1000);
    $("#stTopSpeed").textContent = S.topSpeed > 0 ? ts.val.toFixed(0) + " " + ts.unit : "–";
    $("#stMaxRpm").textContent = S.maxRpm > 0 ? S.maxRpm.toFixed(0) : "–";
    $("#stMaxLat").textContent = S.maxLat > 0 ? S.maxLat.toFixed(2) + " g" : "–";
    $("#stMaxLon").textContent = S.maxLon > 0 ? S.maxLon.toFixed(2) + " g" : "–";
    $("#st0100").textContent = S.t0100 != null ? S.t0100.toFixed(2) + " s" : "–";
    $("#st060").textContent = S.t060 != null ? S.t060.toFixed(2) + " s" : "–";
    $("#stDist").textContent = di.val.toFixed(2) + " " + di.unit;
    var odo = T.electrics.odometer != null ? U.dist(T.electrics.odometer / 1000) : null;
    $("#stOdo").textContent = odo ? odo.val.toFixed(1) + " " + odo.unit : "–";
  }

  // ============================================================ PERFORMANCE
  // Live FPS, memory and VRAM read straight from the engine. All probed against
  // the running game (Opus probe, 2026-06): FPS is derived from the frame id and
  // a monotonic clock SAMPLED TOGETHER in one Lua call (no WebSocket round-trip
  // skew); memory & VRAM come from Engine.Platform / Engine.Render. BeamNG exposes
  // no CPU/GPU *compute-utilisation* %, so we honestly show frame time + memory
  // rather than inventing a load number.
  var PERF = { prev: null, min: 0, max: 0, sum: 0, n: 0, sysInfo: null };
  var perfInflight = false;
  function pollPerf() {
    if (!br.connected || perfInflight) return;
    perfInflight = true;
    br.engineLuaCb("(function() local fid=Engine.Render.getFrameId() local ms=Engine.Platform.getSystemTimeMS()" +
      " local mi=Engine.Platform.getMemoryInfo() local vr=Engine.Render.getVRAMUsage()" +
      " return {f=fid,ms=ms,pp=mi.processPhysUsed,ou=mi.osPhysUsed,oa=mi.osPhysAvailable,vr=vr} end)()")
      .then(function (d) { perfInflight = false; if (d && typeof d.f === "number") applyPerf(d); });
  }
  function applyPerf(d) {
    // FPS = Δframes / Δseconds, both sampled together engine-side
    var p = PERF.prev;
    if (p && d.ms > p.ms) {
      var fps = (d.f - p.f) * 1000 / (d.ms - p.ms);
      if (isFinite(fps) && fps >= 0 && fps < 1000) {
        $("#fpsBig").textContent = fps.toFixed(0);
        $("#perfFt").textContent = fps > 0 ? (1000 / fps).toFixed(1) + " ms" : "– ms";
        if (PERF.n === 0 || fps < PERF.min) PERF.min = fps;
        if (fps > PERF.max) PERF.max = fps;
        PERF.sum += fps; PERF.n++;
        $("#fpsMin").textContent = PERF.min.toFixed(0);
        $("#fpsMax").textContent = PERF.max.toFixed(0);
        $("#fpsAvg").textContent = (PERF.sum / PERF.n).toFixed(0);
        fpsChart.push([fps]); fpsChart.draw();
      }
    }
    PERF.prev = { f: d.f, ms: d.ms };
    // memory: process working set (big number) + system RAM (bar)
    var GiB = 1073741824, MiB = 1048576;
    var procGB = d.pp / GiB, sysUsedGB = d.ou / GiB, sysTotGB = (d.ou + d.oa) / GiB;
    $("#memBig").textContent = procGB.toFixed(2);
    $("#memSys").textContent = sysUsedGB.toFixed(1) + " / " + sysTotGB.toFixed(1) + " GB";
    $("#memSysFill").style.width = (sysTotGB > 0 ? Math.max(0, Math.min(100, sysUsedGB / sysTotGB * 100)) : 0).toFixed(1) + "%";
    memChart.push([d.pp / MiB]); memChart.draw();
    // VRAM: used (big number) + used/total (bar), total from the static GPU info
    var vramGB = d.vr / GiB;
    var vramTotGB = (PERF.sysInfo && PERF.sysInfo.vramTotalMB) ? PERF.sysInfo.vramTotalMB / 1024 : null;
    $("#vramBig").textContent = vramGB.toFixed(2);
    if (vramTotGB) {
      var vpct = Math.max(0, Math.min(100, vramGB / vramTotGB * 100));
      $("#vramPct").textContent = Math.round(vpct) + "%";
      $("#vramTotalNote").textContent = vramGB.toFixed(1) + " / " + vramTotGB.toFixed(1) + " GB";
      $("#vramFill").style.width = vpct.toFixed(1) + "%";
      vramChart.series[0].max = vramTotGB;
    }
    vramChart.push([vramGB]); vramChart.draw();
  }
  function resetPerf() {
    PERF.min = 0; PERF.max = 0; PERF.sum = 0; PERF.n = 0;
    fpsChart.series[0].data = []; memChart.series[0].data = []; vramChart.series[0].data = [];
    $("#fpsMin").textContent = "–"; $("#fpsMax").textContent = "–"; $("#fpsAvg").textContent = "–";
  }
  $("#perfReset").addEventListener("click", function () { resetPerf(); toast("perf stats reset"); });

  // static hardware info - fetched once (cheap, doesn't change)
  var sysInfoFetched = false;
  function fetchSysInfo() {
    if (sysInfoFetched || !br.connected) return;
    sysInfoFetched = true;
    br.engineLuaCb("(function() local c=Engine.Platform.getCPUInfo() local g=Engine.Platform.getGPUInfo()" +
      " local m=Engine.Platform.getMemoryInfo() return {cpu=c.name,coresP=c.coresPhysical,coresL=c.coresLogical," +
      "clock=c.clockSpeed,gpu=g.name,vramTotalMB=g.memoryMB,ramTotalB=m.osPhysUsed+m.osPhysAvailable} end)()")
      .then(function (d) { if (!d || typeof d !== "object") { sysInfoFetched = false; return; } PERF.sysInfo = d; renderSysInfo(d); });
  }
  function renderSysInfo(d) {
    var rows = [
      ["CPU", d.cpu || "–"],
      ["Cores", (d.coresP != null ? d.coresP + "C" : "?") + " / " + (d.coresL != null ? d.coresL + "T" : "?") +
        (d.clock ? " · " + (d.clock / 1000).toFixed(1) + " GHz" : "")],
      ["GPU", d.gpu || "–"],
      ["VRAM", d.vramTotalMB ? (d.vramTotalMB / 1024).toFixed(0) + " GB" : "–"],
      ["System RAM", d.ramTotalB ? (d.ramTotalB / 1073741824).toFixed(0) + " GB" : "–"]
    ];
    $("#sysInfoTable").innerHTML = rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");
  }

  // on-demand GE-Lua profiler: enable, let it accumulate ~2 s, snapshot the
  // hottest functions, then disable so the overhead doesn't linger.
  var luaProfiling = false;
  function prettyFn(f) {
    return String(f == null ? "?" : f).replace(/^Lua_/, "").replace(/^@?\/?lua\//, "")
      .replace(/^ge\/extensions\//, "").replace(/^ge\//, "").replace(/^vehicle\//, "veh:");
  }
  function profileLua() {
    if (!br.connected) { toast("not connected to game"); return; }
    if (luaProfiling) return;
    luaProfiling = true;
    $("#luaProfileBtn").classList.add("on");
    $("#luaTasksStatus").textContent = "profiling…";
    br.engineLua("if perf and perf.enable then perf.enable() end");
    setTimeout(function () {
      br.engineLuaCb("(function() if not (perf and perf.getData) then return {err='profiler API unavailable'} end" +
        " perf.update() local d=perf.getData() local arr={} if type(d.fcts)=='table' then for _,v in pairs(d.fcts) do arr[#arr+1]=v end end" +
        " table.sort(arr,function(a,b) return (a.t or 0)>(b.t or 0) end) local out={}" +
        " for i=1,math.min(12,#arr) do local v=arr[i] out[#out+1]={f=v.f,t=v.t,s=v.s,c=v.c} end" +
        " if perf.disable then perf.disable() end return {top=out,total=#arr,mem=d.memory} end)()")
        .then(function (r) {
          luaProfiling = false; $("#luaProfileBtn").classList.remove("on"); renderLuaTasks(r);
        });
    }, 2000);
  }
  function renderLuaTasks(r) {
    if (!r || r.err || !r.top || !r.top.length) {
      $("#luaTasksStatus").textContent = "no data";
      $("#luaTasks").innerHTML = '<div class="hint">' +
        ((r && r.err) ? r.err : "No profiler data - try again while a level is loaded and the sim is running.") + "</div>";
      return;
    }
    var max = r.top[0].t || 1;
    $("#luaTasksStatus").textContent = r.total + " fns" + (r.mem ? " · " + (r.mem / 1024).toFixed(0) + " MB lua" : "");
    $("#luaTasks").innerHTML = r.top.map(function (v) {
      var pct = Math.max(2, Math.min(100, (v.t / max) * 100));
      return '<div class="ltask"><div class="ltn" title="' + String(v.f).replace(/"/g, "&quot;") + '">' + prettyFn(v.f) + "</div>" +
        '<div class="ltv">' + (v.t != null ? v.t.toFixed(2) : "?") + ' ms</div>' +
        '<div class="ltbar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="ltc">' + (v.c != null ? v.c + " calls" : "") + (v.s != null ? " · self " + v.s.toFixed(2) + " ms" : "") + "</div></div>";
    }).join("");
  }
  $("#luaProfileBtn").addEventListener("click", profileLua);

  // ================================================================= CONSOLE
  var consoleCtx = "ge";
  $$(".ctx").forEach(function (b) {
    b.addEventListener("click", function () {
      $$(".ctx").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active"); consoleCtx = b.dataset.ctx;
    });
  });
  function consoleLine(cls, text) {
    var d = document.createElement("div");
    d.className = "ln " + cls; d.textContent = text;
    $("#consoleOut").appendChild(d);
    $("#consoleOut").scrollTop = $("#consoleOut").scrollHeight;
  }
  function runConsole() {
    var code = $("#consoleInput").value.trim(); if (!code) return;
    consoleLine("cmd", (consoleCtx === "ge" ? "GE> " : "VEH> ") + code);
    $("#consoleInput").value = "";
    var p = consoleCtx === "ge" ? br.engineLuaCb(code) : br.activeObjectLuaCb(code);
    p.then(function (res) {
      var out;
      try { out = (res === undefined) ? "(no return / nil)" : (typeof res === "object" ? JSON.stringify(res, null, 2) : String(res)); }
      catch (e) { out = String(res); }
      consoleLine("res", out);
    });
  }
  $("#consoleRun").addEventListener("click", runConsole);
  $("#consoleInput").addEventListener("keydown", function (e) { if (e.key === "Enter") runConsole(); });

  // ================================================================ NAV / GPS
  // Heading comes from sensors.yaw (already streaming, free). World position has
  // no stream, so we poll it slowly via the engine VM only while the dashboard
  // is open. The compass widget keeps a breadcrumb trail for the radar.
  var navPos = null, posInflight = false;
  function pollPosition() {
    if (!br.connected || posInflight) return;
    posInflight = true;
    br.engineLuaCb("(function() local v=be:getPlayerVehicle(0) if not v then return nil end local p=v:getPosition() return {x=p.x,y=p.y,z=p.z} end)()")
      .then(function (p) { posInflight = false; if (p && typeof p.x === "number") { navPos = p; compass.pushPos(p); } });
  }
  function updateNavSide(e, speedKmh) {
    var sp = AVCP.Units.speed(speedKmh);
    var hd = (((T.sensors.yaw || 0) * 180 / Math.PI) % 360 + 360) % 360;
    $("#navCoords").textContent = navPos ? "x/y " + navPos.x.toFixed(0) + ", " + navPos.y.toFixed(0) : "–";
    var alt = e.altitude != null ? AVCP.Units.alt(e.altitude) : null;
    var elev = navPos ? AVCP.Units.alt(navPos.z) : null;
    var rows = [
      ["Heading", hd.toFixed(0) + "°"],
      ["Speed", sp.val.toFixed(0) + " " + sp.unit],
      ["Altitude", alt ? alt.val.toFixed(0) + " " + alt.unit : "–"],
      ["Elevation", elev ? elev.val.toFixed(0) + " " + elev.unit : "–"]
    ];
    $("#navSide").innerHTML = rows.map(function (r) {
      return '<div class="ro"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");
  }
  br.on("hook:VehicleChange", function () { compass.reset(); navPos = null; });
  br.on("hook:VehicleFocusChanged", function () { compass.reset(); navPos = null; });

  // ================================================================== DAMAGE
  // No damage stream exists, so poll the vehicle VM (~1 Hz, guarded). Tire
  // deflation is counted from the wheel set; structural damage uses
  // beamstate.damage when the vehicle exposes it (best-effort across vehicles).
  var dmgInflight = false;
  function pollDamage() {
    if (!br.connected || dmgInflight) return;
    dmgInflight = true;
    br.activeObjectLuaCb("(function() local r={} local wc=(wheels and wheels.wheelCount) or 0 r.wheelCount=wc local def=0 for i=0,wc-1 do local w=wheels.wheels and wheels.wheels[i] if w and w.isTireDeflated then def=def+1 end end r.deflated=def if beamstate and beamstate.damage~=nil then r.damage=beamstate.damage end return r end)()")
      .then(function (d) { dmgInflight = false; renderDamage(d); });
  }
  function renderDamage(d) {
    var e = T.electrics;
    if (!d || typeof d !== "object") {
      $("#damageGrid").innerHTML = '<div class="hint">No damage data for this vehicle.</div>';
      $("#dmgState").textContent = "n/a"; return;
    }
    var deflated = d.deflated || 0, wc = d.wheelCount || 0;
    var dmg = (typeof d.damage === "number") ? d.damage : null;
    var hurt = deflated > 0 || (dmg != null && dmg > 100) || !!e.checkengine;
    $("#dmgState").textContent = hurt ? "Vehicle Damaged" : "Herbie is happy :)";
    var cells = [
      { l: "Deflated tires", v: deflated + " / " + wc, cls: deflated > 0 ? "bad" : "ok" },
      { l: "Structural", v: dmg != null ? (dmg > 1000 ? (dmg / 1000).toFixed(1) + "k" : dmg.toFixed(0)) : "n/a", cls: dmg == null ? "" : (dmg > 1000 ? "bad" : dmg > 100 ? "warn" : "ok") },
      { l: "Engine", v: e.engineRunning != null ? (e.engineRunning > 0.5 ? "running" : "off") : "n/a", cls: e.engineRunning > 0.5 ? "ok" : "warn" },
      { l: "Check engine", v: e.checkengine ? "fault" : "clear", cls: e.checkengine ? "bad" : "ok" }
    ];
    $("#damageGrid").innerHTML = cells.map(function (c) {
      return '<div class="dmgcell ' + c.cls + '"><div class="dl">' + c.l + '</div><div class="dv">' + c.v + "</div></div>";
    }).join("");
  }
  $("#dmgRepair").addEventListener("click", function () {
    br.activeObjectLua("beamstate.reset()"); toast("✓ repaired");
    setTimeout(pollDamage, 400); setTimeout(refreshVehicle, 400);
  });
  $("#dmgRefresh").addEventListener("click", pollDamage);

  // ==================================================================== FUEL
  function setFuel(frac) {
    frac = Math.max(0, Math.min(1, frac));
    // best-effort across vehicle types: set every energy storage to the fraction
    br.activeObjectLua("(function(f) if not energyStorage then return end local ok,st=pcall(energyStorage.getStorages) if not ok or not st then return end for _,s in pairs(st) do if s.energyCapacity and s.energyCapacity>0 then s.storedEnergy=s.energyCapacity*f end if s.remainingVolume and s.capacity then s.remainingVolume=s.capacity*f end end end)(" + frac.toFixed(3) + ")");
  }
  function setFuelUI(pct) { $("#fuelSlider").value = pct; $("#fuelSetVal").textContent = pct + "%"; }
  buildButtons("#fuelBtns", [
    { label: "Empty", fn: function () { setFuel(0); setFuelUI(0); toast("fuel: empty"); } },
    { label: "25%", fn: function () { setFuel(0.25); setFuelUI(25); toast("fuel: 25%"); } },
    { label: "50%", fn: function () { setFuel(0.5); setFuelUI(50); toast("fuel: 50%"); } },
    { label: "Full", primary: true, fn: function () { setFuel(1); setFuelUI(100); toast("fuel: full"); } }
  ]);
  $("#fuelSlider").addEventListener("input", function () { $("#fuelSetVal").textContent = this.value + "%"; });
  $("#fuelSlider").addEventListener("change", function () { setFuel(parseInt(this.value, 10) / 100); toast("fuel: " + this.value + "%"); });

  // ================================================================ OFF-ROAD
  // Vehicle-agnostic drivetrain control: list switchable powertrain devices
  // (transfer case, range box, lockable diffs) and toggle their modes live.
  function prettyDev(name) {
    var n = name.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  function refreshOffroad() {
    if (!br.connected) return;
    br.activeObjectLuaCb("(function() local r={} if not (powertrain and powertrain.getDevices) then return r end for name,d in pairs(powertrain.getDevices()) do if d.availableModes and #d.availableModes>1 then r[name]={mode=d.mode, modes=d.availableModes} end end return r end)()")
      .then(renderOffroad);
  }
  function renderOffroad(devs) {
    var keys = (devs && typeof devs === "object") ? Object.keys(devs) : [];
    if (!keys.length) {
      $("#offroadGrid").innerHTML = '<div class="hint">This vehicle exposes no switchable drivetrain devices (no transfer case, range box or lockable diff).</div>';
      return;
    }
    keys.sort();
    $("#offroadGrid").innerHTML = keys.map(function (name) {
      var d = devs[name];
      var modes = (d.modes || []).map(function (m) {
        return '<button class="odm' + (m === d.mode ? " active" : "") + '" data-dev="' + name + '" data-mode="' + m + '">' + m + "</button>";
      }).join("");
      return '<div class="offdev"><div class="odn"><span>' + prettyDev(name) + '</span><b>' + (d.mode || "") + '</b></div><div class="odmodes">' + modes + "</div></div>";
    }).join("");
    $$("#offroadGrid .odm").forEach(function (b) {
      b.addEventListener("click", function () {
        var dev = this.dataset.dev, mode = this.dataset.mode;
        br.activeObjectLua("powertrain.setDeviceMode('" + dev + "','" + mode + "')");
        toast(prettyDev(dev) + ": " + mode);
        setTimeout(refreshOffroad, 250);
      });
    });
  }
  function diffAll(mode) {
    br.activeObjectLua("(function() if not (powertrain and powertrain.getDevices) then return end for name,d in pairs(powertrain.getDevices()) do if d.availableModes then for _,m in ipairs(d.availableModes) do if m=='" + mode + "' then powertrain.setDeviceMode(name,'" + mode + "') end end end end end)()");
    toast("diffs " + mode); setTimeout(refreshOffroad, 300);
  }
  $("#offRefresh").addEventListener("click", refreshOffroad);
  $("#diffLockAll").addEventListener("click", function () { diffAll("locked"); });
  $("#diffOpenAll").addEventListener("click", function () { diffAll("open"); });
  $('.tab[data-tab="vehicle"]').addEventListener("click", refreshOffroad);
  br.on("hook:VehicleChange", function () { setTimeout(refreshOffroad, 300); });

  // ============================================================== MODEL LIST
  // Populate the spawn box's autocomplete from the installed vehicle models.
  var modelListLoaded = false;
  function populateModelList() {
    if (modelListLoaded || !br.connected) return;
    br.engineLuaCb("(function() local r={} local ok,m=pcall(function() return core_vehicles.getModelList().models end) if ok and m then for k,_ in pairs(m) do r[#r+1]=k end end return r end)()")
      .then(function (list) {
        if (!list || !list.length) return;
        modelListLoaded = true; list.sort();
        $("#modelList").innerHTML = list.map(function (k) { return '<option value="' + k + '">'; }).join("");
      });
  }

  // ============================================================== SHORTCUTS
  var SHORTCUTS = [
    { keys: "R", desc: "Recover (unflip in place)", fn: function () { br.activeObjectLua("recovery.recoverInPlace()"); } },
    { keys: "Shift+R", desc: "Recover to road (3s)", fn: function () { recoverToRoad(); } },
    { keys: "P", desc: "Repair / reset vehicle", fn: function () { br.activeObjectLua("beamstate.reset()"); setTimeout(refreshVehicle, 300); } },
    { keys: "L", desc: "Toggle headlights", fn: function () { br.activeObjectLua("electrics.toggle_lights()"); } },
    { keys: "H", desc: "Toggle high beams", fn: function () { br.activeObjectLua("electrics.toggle_highbeams()"); } },
    { keys: "[", desc: "Shift down", fn: function () { vehShift(-1); } },
    { keys: "]", desc: "Shift up", fn: function () { vehShift(1); } },
    { keys: "C", desc: "Cycle camera", fn: function () { br.engineLua("core_camera.cycleCamera(0)"); } },
    { keys: "M", desc: "Drop marker (while recording)", fn: function () { if (window.DataLab) DataLab.addMarker(); } },
    { keys: "Space", desc: "Pause / resume sim", fn: function () { br.engineLua("simTimeAuthority.togglePause()"); } },
    { keys: "?", desc: "Show / hide this help", fn: function () { toggleKeysHelp(); } }
  ];
  function isTyping() {
    var a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { var ov = $("#keysOverlay"); if (ov) ov.classList.remove("show"); }
    if (!AVCP.keysEnabled() || isTyping() || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    var k = ev.key, combo;
    if (k === "?") combo = "?";
    else if (k === " ") combo = "Space";
    else if (k.length === 1) combo = (ev.shiftKey ? "Shift+" : "") + k.toUpperCase();
    else combo = k;
    var hit = SHORTCUTS.filter(function (s) { return s.keys === combo; })[0];
    if (hit) { ev.preventDefault(); hit.fn(); if (hit.keys !== "?") toast("⌨ " + hit.desc); }
  });
  function renderKeysList() {
    $("#keysList").innerHTML = SHORTCUTS.map(function (s) {
      return '<div class="krow"><kbd>' + s.keys + "</kbd><span>" + s.desc + "</span></div>";
    }).join("");
  }
  function toggleKeysHelp() { renderKeysList(); $("#keysOverlay").classList.toggle("show"); }
  $("#keysClose").addEventListener("click", function () { $("#keysOverlay").classList.remove("show"); });
  $("#keysOverlay").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("show"); });

  // ================================================================= CSV LOG
  // In-memory ring buffer sampled at ~5 Hz; "Export" builds a CSV Blob and lets
  // the browser download it. Purely client-side - never writes the game folder.
  var logBuf = [], logging = false, LOG_CAP = 20000;
  var LOG_COLS = ["t_s", "speed_kmh", "rpm", "gear", "throttle", "brake", "clutch", "steering", "water_c", "oil_c", "fuel_pct", "gx", "gy"];
  function sampleLog(e) {
    if (!logging) return;
    var speedKmh = Math.abs((e.wheelspeed != null ? e.wheelspeed : (e.airspeed || 0)) * 3.6);
    var grav = T.sensors.gravity ? Math.abs(T.sensors.gravity) : 9.81;
    logBuf.push([
      (performance.now() / 1000).toFixed(2), speedKmh.toFixed(1),
      (e.rpm != null ? e.rpm : 0).toFixed(0), (e.gear != null && e.gear !== "" ? e.gear : "N"),
      (e.throttle || 0).toFixed(3), (e.brake || 0).toFixed(3), (e.clutch || 0).toFixed(3),
      (e.steering_input != null ? e.steering_input : (e.steering || 0)).toFixed(3),
      e.watertemp != null ? e.watertemp.toFixed(1) : "", e.oiltemp != null ? e.oiltemp.toFixed(1) : "",
      e.fuel != null ? (e.fuel * 100).toFixed(1) : "",
      ((T.sensors.gx2 || 0) / grav).toFixed(3), ((T.sensors.gy2 || 0) / grav).toFixed(3)
    ]);
    if (logBuf.length > LOG_CAP) logBuf.shift();
    $("#logCount").textContent = logBuf.length + " rows";
  }
  $("#logToggle").addEventListener("click", function () {
    logging = !logging;
    this.textContent = logging ? "Stop logging" : "Start logging";
    this.classList.toggle("sel", logging);
    toast(logging ? "logging…" : "logging paused");
  });
  $("#logClear").addEventListener("click", function () { logBuf = []; $("#logCount").textContent = "0 rows"; toast("buffer cleared"); });
  $("#logExport").addEventListener("click", function () {
    if (!logBuf.length) return toast("nothing logged yet");
    var csv = LOG_COLS.join(",") + "\n" + logBuf.map(function (r) { return r.join(","); }).join("\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    var a = document.createElement("a");
    a.href = url; a.download = "avcp-telemetry-" + Date.now() + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("CSV exported (" + logBuf.length + " rows)");
  });

  // ============================================================ SETTINGS UI
  function renderThemeGrid() {
    var active = AVCP.activeTheme();
    $("#themeGrid").innerHTML = Object.keys(AVCP.THEMES).map(function (id) {
      var t = AVCP.THEMES[id];
      return '<div class="swatch' + (id === active ? " active" : "") + '" data-theme="' + id + '">' +
        '<div class="dots"><i style="background:' + t.accent + '"></i><i style="background:' + t.data + '"></i></div>' +
        '<div class="sn">' + t.name + "</div></div>";
    }).join("");
    $$("#themeGrid .swatch").forEach(function (s) {
      s.addEventListener("click", function () { AVCP.setTheme(this.dataset.theme); renderThemeGrid(); });
    });
  }
  renderThemeGrid();
  (function () { var c = AVCP.currentColors(); $("#customAccent").value = c.accent; $("#customData").value = c.data; })();
  $("#applyCustom").addEventListener("click", function () {
    AVCP.setCustom($("#customAccent").value, $("#customData").value);
    renderThemeGrid(); toast("custom theme applied");
  });

  // -------------------------------------------------- APPEARANCE / BACKGROUND
  var bgFile = $("#bgFile");
  function setBgPreview(dataURL) {
    var p = $("#bgPreview");
    if (dataURL) { p.style.backgroundImage = 'url("' + dataURL + '")'; p.classList.add("has"); }
    else { p.style.backgroundImage = ""; p.classList.remove("has"); }
  }
  function renderBgGrid() {
    var a = AVCP.appearance();
    var html = '<button class="bg-swatch' + (a.bgMode === "none" ? " active" : "") +
      '" data-bg="none"><i class="bgs-none"></i><span>None</span></button>';
    Object.keys(AVCP.BG_PRESETS).forEach(function (id) {
      var p = AVCP.BG_PRESETS[id];
      var sw = typeof p.swatch === "function" ? p.swatch() : p.swatch;
      var on = a.bgMode === "preset" && a.bgPreset === id;
      html += '<button class="bg-swatch' + (on ? " active" : "") + '" data-bg="preset" data-preset="' + id +
        '"><i style="background:' + sw + '"></i><span>' + p.name + '</span></button>';
    });
    html += '<button class="bg-swatch' + (a.bgMode === "custom" ? " active" : "") +
      '" data-bg="custom"><i class="bgs-custom">+</i><span>Custom</span></button>';
    $("#bgPresetGrid").innerHTML = html;
    $$("#bgPresetGrid .bg-swatch").forEach(function (b) {
      b.addEventListener("click", function () { pickBackground(this.dataset.bg, this.dataset.preset); });
    });
  }
  // choosing any non-empty background turns glass on the first time so the effect
  // is visible immediately; the user can still toggle it back off afterwards
  function autoGlass() {
    if (!AVCP.appearance().glass) {
      AVCP.setAppearance("glass", true);
      $("#glassState").textContent = "on"; $("#glassToggle").classList.add("on");
    }
  }
  function pickBackground(mode, preset) {
    if (mode === "custom") {
      if (AVCP.hasBackgroundImage()) { AVCP.setAppearance("bgMode", "custom"); autoGlass(); }
      else { bgFile.click(); }
      renderBgGrid(); return;
    }
    if (mode === "preset") { AVCP.setAppearance("bgPreset", preset); AVCP.setAppearance("bgMode", "preset"); autoGlass(); }
    else { AVCP.setAppearance("bgMode", "none"); }
    renderBgGrid();
  }
  // big photos are downscaled before storing: caps memory, IndexedDB size & the
  // GPU cost of blurring a huge image behind frosted cards
  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 2560, w = img.naturalWidth, h = img.naturalHeight;
        var sc = Math.min(1, max / Math.max(w, h));
        if (sc >= 1 && file.size < 1.5 * 1024 * 1024) { // already small - keep original bytes
          URL.revokeObjectURL(url);
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsDataURL(file); return;
        }
        var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        var c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try { resolve(c.toDataURL("image/jpeg", 0.9)); } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    });
  }
  bgFile.addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast("not an image file"); return; }
    if (f.size > 24 * 1024 * 1024) { toast("image too large (max 24 MB)"); return; }
    toast("processing image…");
    fileToDataURL(f).then(function (dataURL) {
      setBgPreview(dataURL);
      AVCP.setBackgroundImage(dataURL);
      autoGlass();
      renderBgGrid();
      toast("background set");
    }).catch(function () { toast("could not read image"); });
  });
  $("#bgUpload").addEventListener("click", function () { bgFile.click(); });
  $("#bgRemove").addEventListener("click", function () {
    AVCP.clearBackgroundImage(); setBgPreview(null); renderBgGrid(); toast("custom background removed");
  });

  function initAppearanceUI() {
    var a = AVCP.appearance();
    $("#bgBlur").value = a.bgBlur; $("#bgBlurVal").textContent = a.bgBlur + "px";
    $("#bgDim").value = a.bgDim; $("#bgDimVal").textContent = a.bgDim + "%";
    $("#glassBlur").value = a.glassBlur; $("#glassBlurVal").textContent = a.glassBlur + "px";
    $("#glassOpacity").value = a.glassOpacity; $("#glassOpacityVal").textContent = a.glassOpacity + "%";
    $("#glassState").textContent = a.glass ? "on" : "off";
    $("#glassToggle").classList.toggle("on", !!a.glass);
    renderBgGrid();
  }
  $("#bgBlur").addEventListener("input", function () { $("#bgBlurVal").textContent = this.value + "px"; AVCP.setAppearance("bgBlur", parseInt(this.value, 10)); });
  $("#bgDim").addEventListener("input", function () { $("#bgDimVal").textContent = this.value + "%"; AVCP.setAppearance("bgDim", parseInt(this.value, 10)); });
  $("#glassBlur").addEventListener("input", function () { $("#glassBlurVal").textContent = this.value + "px"; AVCP.setAppearance("glassBlur", parseInt(this.value, 10)); });
  $("#glassOpacity").addEventListener("input", function () { $("#glassOpacityVal").textContent = this.value + "%"; AVCP.setAppearance("glassOpacity", parseInt(this.value, 10)); });
  $("#glassToggle").addEventListener("click", function () {
    var on = !AVCP.appearance().glass; AVCP.setAppearance("glass", on);
    $("#glassState").textContent = on ? "on" : "off"; this.classList.toggle("on", on);
    toast("glass panels " + (on ? "on" : "off"));
  });
  // hydrate the preview/active-state from any image already stored in IndexedDB
  AVCP.loadBackgroundImage().then(function (d) { if (d) setBgPreview(d); initAppearanceUI(); });
  initAppearanceUI();

  // preset buttons highlight only when every per-quantity pref matches them;
  // the granular selects (wired in customize.js) cover the mixed cases
  var UNIT_PRESETS = {
    metric: { speed: "kmh", temp: "c", dist: "km", press: "psi" },
    imperial: { speed: "mph", temp: "f", dist: "mi", press: "psi" }
  };
  function renderUnitsGrid() {
    var p = AVCP.Units.prefs();
    $$("#unitsGrid .btn").forEach(function (b) {
      var preset = UNIT_PRESETS[b.dataset.units] || {};
      var all = Object.keys(preset).every(function (k) { return p[k] === preset[k]; });
      b.classList.toggle("sel", all);
    });
  }
  $$("#unitsGrid .btn").forEach(function (b) {
    b.addEventListener("click", function () { AVCP.setUnits(this.dataset.units); renderUnitsGrid(); });
  });
  renderUnitsGrid();
  AVCP.on("units", renderUnitsGrid);

  function initGaugeUI() {
    var c = AVCP.gaugeCfg();
    $("#gSpeedMax").value = c.speedMax; $("#gSpeedMaxVal").textContent = c.speedMax;
    $("#gRpmMax").value = c.rpmMax; $("#gRpmMaxVal").textContent = c.rpmMax > 0 ? c.rpmMax : "auto";
    $("#gRedline").value = c.redlinePct; $("#gRedlineVal").textContent = c.redlinePct + "%";
    $("#gSmooth").value = c.smoothing; $("#gSmoothVal").textContent = c.smoothing + "%";
    $("#gTicks").checked = !!c.showTicks;
    $("#gDecimals").value = String(c.speedDecimals);
  }
  initGaugeUI();
  $("#gSpeedMax").addEventListener("input", function () { $("#gSpeedMaxVal").textContent = this.value; AVCP.setGauge("speedMax", parseInt(this.value, 10)); });
  $("#gRpmMax").addEventListener("input", function () { var v = parseInt(this.value, 10); $("#gRpmMaxVal").textContent = v > 0 ? v : "auto"; AVCP.setGauge("rpmMax", v); });
  $("#gRedline").addEventListener("input", function () { $("#gRedlineVal").textContent = this.value + "%"; AVCP.setGauge("redlinePct", parseInt(this.value, 10)); });
  $("#gSmooth").addEventListener("input", function () { $("#gSmoothVal").textContent = this.value + "%"; AVCP.setGauge("smoothing", parseInt(this.value, 10)); });
  $("#gTicks").addEventListener("change", function () { AVCP.setGauge("showTicks", this.checked); });
  $("#gDecimals").addEventListener("change", function () { AVCP.setGauge("speedDecimals", parseInt(this.value, 10)); });
  $("#gaugeReset").addEventListener("click", function () { AVCP.resetGauges(); initGaugeUI(); toast("gauges reset"); });

  function renderKeysState() { $("#keysState").textContent = AVCP.keysEnabled() ? "on" : "off"; }
  renderKeysState();
  $("#keysToggle").addEventListener("click", function () { AVCP.setKeysEnabled(!AVCP.keysEnabled()); renderKeysState(); toast("shortcuts " + (AVCP.keysEnabled() ? "on" : "off")); });
  $("#keysHelp").addEventListener("click", toggleKeysHelp);

  // Factory reset. With v0.4's layout/profiles/scale in the mix, a clean
  // reload is the only honest way to re-render everything; the custom
  // background image (IndexedDB) is cleared first since its write is async.
  $("#settingsWipe").addEventListener("click", function () {
    ["theme", "accent", "data", "units", "units2", "gauges", "keys", "appearance",
      "intro", "introSeen", "datalab", "layout", "alerts", "uiScale", "startTab",
      "profiles", "customCss", "customCssOn"]
      .forEach(function (k) { try { localStorage.removeItem("avcp." + k); } catch (e) { /* ignore */ } });
    toast("settings reset - reloading…");
    AVCP.clearBackgroundImage().then(function () { location.reload(); });
  });

  // =================================================================== TOAST
  var toastTimer;
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1600);
  }

  // ============================================================== FULLSCREEN
  // Any card can be expanded to fill the viewport. Canvas widgets re-fit to the
  // new size automatically on their next draw (they read clientWidth/Height).
  var fsBackdrop = document.createElement("div");
  fsBackdrop.id = "fsBackdrop";
  document.body.appendChild(fsBackdrop);
  function closeMaximized() {
    var m = $(".card.maximized");
    if (m) {
      m.classList.remove("maximized");
      var mb = m.querySelector(".maxbtn"); if (mb) mb.innerHTML = "⛶";
    }
    fsBackdrop.classList.remove("show");
  }
  fsBackdrop.addEventListener("click", closeMaximized);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMaximized(); });
  $$(".card").forEach(function (card) {
    var b = document.createElement("button");
    b.className = "maxbtn"; b.type = "button"; b.title = "Full screen (Esc to exit)"; b.innerHTML = "⛶";
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var was = card.classList.contains("maximized");
      closeMaximized();
      if (!was) { card.classList.add("maximized"); b.innerHTML = "✕"; fsBackdrop.classList.add("show"); }
    });
    card.appendChild(b);
  });

  // ===================================================================== BOOT
  renderTodPlay();
  renderStats();
  Gauges.refreshTheme();
  // Data Lab gets the bridge + the shared telemetry state; it samples on the
  // same stream events this file consumes and replays back into T (see the
  // DataLab.isDriving() gate in the stream intake above).
  if (window.DataLab) DataLab.init({
    br: br,
    T: T,
    toast: toast,
    vehicleName: function () {
      var t = $("#vehName").textContent;
      return t === "no vehicle" ? "" : t;
    }
  });
  // customization layer (layout editor, profiles, alerts, gallery, scale)
  if (window.Customize) Customize.init({ toast: toast, closeMaximized: closeMaximized });
  // startup tab (Settings → Interface); falls back to Dashboard silently
  (function () {
    var st = AVCP.Store.get("startTab", "");
    if (st && st !== "dashboard") {
      var tb = $('.tab[data-tab="' + st + '"]');
      if (tb) tb.click();
    }
  })();
  br.connect();
  // Arm the setup-required check. If the WebSocket never opens within the grace
  // window we conclude the game web-server isn't reachable (see fireSetupRequired).
  // Remote (relay) clients pair by code on their own schedule - no alarm there.
  if (!(window.AVCPRemote && AVCPRemote.isClient)) setupTimer = setTimeout(fireSetupRequired, SETUP_GRACE_MAP_MS);
  tickerWorker.onmessage = renderLoop;
  tickerWorker.postMessage('start');
})();
