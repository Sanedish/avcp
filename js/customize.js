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
 *   Online gallery- optional, user-triggered fetch of an index from the Malo
 *                   Interactive CDN with shareable backgrounds and profiles.
 *                   Submissions are reviewed on Discord, not uploaded by this
 *                   panel - the client is a pure downloader: it fetches
 *                   index/index.json, then resolves each entry's file against
 *                   the CDN's json/ folder. Nothing is fetched until "Browse"
 *                   is clicked; backgrounds are displayed straight from their
 *                   URL (no CORS needed), the index + profile JSONs need CORS
 *                   headers on the CDN.
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

  // Everything the gallery reads lives under this CDN folder; Discord-reviewed
  // submissions get dropped in here by hand, then listed in index/index.json.
  // The panel never writes to the CDN - it only ever downloads.
  function cdnBase() { return "https://cdn.boykisser.cloud/malo-interactive/static/avcp/json/"; }
  // avcp.galleryUrl in localStorage overrides this - handy for testing a draft
  // index.json before it's live (see index.json format below)
  function galleryUrl() {
    return Store.get("galleryUrl", cdnBase() + "index/index.json");
  }
  // index/profile entries carry either a full URL or a filename relative to
  // cdnBase(); this is what makes the latter work without every entry having
  // to spell out the CDN host.
  function resolveCdn(f) { return /^https?:\/\//i.test(f) ? f : cdnBase() + f; }

  /* ========================================================== layout editor */
  var editing = false, dragCard = null;

  function assignCardIds() {
    $$(".page").forEach(function (p) {
      $$(".card", p).forEach(function (c, i) { c.dataset.lid = p.id + ":" + i; });
    });
  }

  // flow-managed cards = the bespoke cards, i.e. everything NOT inside a grid zone
  function flowCards(p) {
    return $$(".card", p).filter(function (c) { return !c.closest(".tile-grid"); });
  }

  function applyLayout() {
    var cfg = Store.getJSON("layout", {}) || {};
    $$(".page").forEach(function (p) {
      var cards = flowCards(p), pc = cfg[p.id];    // grid tiles are placed by applyTileGrid
      if (!cards.length) return;
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
      var cards = flowCards(p);            // grid tiles persist via saveTileGrid
      if (!cards.length) return;
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
      var cards = flowCards(p).sort(function (a, b) {
        return parseInt(a.dataset.lid.split(":")[1], 10) - parseInt(b.dataset.lid.split(":")[1], 10);
      });
      cards.forEach(function (c) {
        c.classList.remove("layout-hidden");
        c.parentNode.appendChild(c);
      });
    });
    resetTileGrid();   // free-placement pages back to their data-g* defaults
  }

  function siblingCard(card, dir) {
    var el = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    while (el && !el.classList.contains("card")) el = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    return el;
  }

  function injectLayoutTools() {
    $$(".card").forEach(function (card) {
      var inGrid = !!card.closest(".tile-grid");
      var isWidget = !!card.dataset.widget;
      var bar = document.createElement("div");
      bar.className = "layout-tools";
      // grid cards move by free drag, so they get no ◀ ▶ reorder arrows;
      // cloned gauges also get a ✕ to remove them entirely.
      bar.innerHTML = '<span class="lt-grip">⠿ ' + (inGrid ? "DYNAMIC DRAG" : "drag to move") + "</span>" +
        (inGrid ? "" :
          '<button type="button" class="lt-btn" data-lt="back" title="Move earlier">◀</button>' +
          '<button type="button" class="lt-btn" data-lt="fwd" title="Move later">▶</button>') +
        (isWidget ? '<button type="button" class="lt-btn" data-lt="del" title="Remove this gauge">✕</button>' : "") +
        '<button type="button" class="lt-btn" data-lt="eye" title="Show / hide this card">👁</button>';
      card.appendChild(bar);
      bar.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("[data-lt]") : null;
        if (!b) return;
        ev.stopPropagation();
        if (b.dataset.lt === "del") { removeWidget(card.dataset.tile); return; }
        if (b.dataset.lt === "eye") {
          card.classList.toggle("layout-hidden");
          if (inGrid) { var g = card.closest(".tile-grid"); compactGrid(g); saveTileGrid(g); return; }
        } else {
          var ref = siblingCard(card, b.dataset.lt === "back" ? -1 : 1);
          if (ref) {
            if (b.dataset.lt === "back") card.parentNode.insertBefore(card, ref);
            else card.parentNode.insertBefore(ref, card);
          }
        }
        persistLayout();
      });

      if (inGrid) {
        var rz = document.createElement("div");
        rz.className = "tile-resize";
        rz.title = "Drag to resize";
        card.appendChild(rz);
        wireTile(card);
        return;   // grid cards use pointer drag/resize, not HTML5 reorder
      }

      // drag & drop reorder (desktop); the card reflows live under the pointer
      card.draggable = editing && !inGrid;
      card.addEventListener("dragstart", function (ev) {
        if (!editing) { ev.preventDefault(); return; }
        dragCard = card;
        card.classList.add("layout-drag");
        try { ev.dataTransfer.setData("text/plain", card.dataset.lid); } catch (e) { /* CEF quirk */ }
        ev.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", function () {
        card.classList.remove("layout-drag");
        if (!card.closest(".tile-grid")) {
          card.draggable = editing;
        }
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

  var preEditLayout = null;
  var preEditWidgets = null;

  function setEditing(on, isCancel) {
    editing = !!on;
    document.body.classList.toggle("layout-editing", editing);
    // grid cards drag via pointer events, so native HTML5 draggable stays off for them
    $$(".card").forEach(function (c) { c.draggable = editing && !c.closest(".tile-grid"); });
    
    var editBtn = $("#editBtn");
    var cancelBtn = $("#cancelBtn");
    if (editBtn) {
      editBtn.textContent = editing ? "Done" : "Edit";
      editBtn.classList.toggle("on", editing);
    }
    if (cancelBtn) {
      cancelBtn.style.display = editing ? "inline-block" : "none";
    }
    // "+ Add" (add tiles/gauges) and "Reset" only make sense mid-edit
    var addBtn = $("#addBtn"), resetBtn = $("#resetBtn");
    if (addBtn) addBtn.style.display = editing ? "inline-block" : "none";
    if (resetBtn) resetBtn.style.display = editing ? "inline-block" : "none";
    
    if (editing) {
      preEditLayout = tileGridCfg();
      preEditWidgets = widgetsCfg();
      if (ctx && ctx.closeMaximized) ctx.closeMaximized();
      toast("layout editor: drag to move, corner handle to resize, 👁 to hide, Esc to cancel - works on every tab");
    } else {
      if (isCancel) {
        if (preEditLayout) Store.setJSON("tileGrid", preEditLayout);
        if (preEditWidgets) {
          Store.setJSON("widgets", preEditWidgets);
          for (var k in widgetInstances) {
            if (widgetInstances[k].el) widgetInstances[k].el.remove();
          }
          widgetInstances = {};
          renderWidgetInstances();
        }
        applyTileGrid();
        toast("edits cancelled");
      } else {
        $$(".tile-grid").forEach(saveTileGrid);
        persistLayout();
        toast("layout saved");
      }
    }
  }

  /* ==================================================== free-placement grid */
  // A .tile-grid page positions every card by explicit {x,y,w,h} cells on a
  // GRID_COLS-wide grid (like BeamNG's app editor). The editor drags & resizes
  // with collision checks so tiles never overlap or squish. Live coords live on
  // the card as data-c* (single source of truth), persist per page in
  // avcp.tileGrid, and default to the card's data-g* attrs = today's layout.
  // ponytail: fixed 12-col grid ignores the mobile breakpoints (BeamNG runs
  //   fullscreen); add a phone layout only if someone actually needs one.
  var GRID_COLS = 12;

  function gridCards(grid) {
    var cards = $$(".card", grid);
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].dataset.tile) cards[i].dataset.tile = "auto_" + grid.closest(".page").id + "_" + i;
    }
    return cards;
  }
  function tileCoords(c) {
    return { x: parseInt(c.dataset.cx, 10), y: parseInt(c.dataset.cy, 10),
      w: parseInt(c.dataset.cw, 10), h: parseInt(c.dataset.ch, 10) };
  }
  function setTileCoords(c, x, y, w, h) {
    c.dataset.cx = x; c.dataset.cy = y; c.dataset.cw = w; c.dataset.ch = h;
    c.style.gridColumn = (x + 1) + " / span " + w;
    c.style.gridRow = (y + 1) + " / span " + h;
  }
  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  function resolveGridCollisions(grid, activeCard, activeRect, originalLayout) {
    var state = originalLayout.map(function(item) {
      return { card: item.card, r: { x: item.originalRect.x, y: item.originalRect.y, w: item.originalRect.w, h: item.originalRect.h }, isActive: item.card === activeCard };
    });
    var activeState = state.find(function(s) { return s.isActive; });
    if (activeState) activeState.r = activeRect;
    
    state.sort(function(a, b) { return a.r.y - b.r.y; });
    var changed = true, iterations = 0;
    while (changed && iterations < 50) {
      changed = false;
      iterations++;
      for (var i = 0; i < state.length; i++) {
        for (var j = 0; j < state.length; j++) {
          if (i === j) continue;
          var a = state[i], b = state[j];
          if (rectsOverlap(a.r, b.r)) {
            var mover, stationary;
            if (a.isActive) { mover = b; stationary = a; }
            else if (b.isActive) { mover = a; stationary = b; }
            else if (a.r.y > b.r.y) { mover = a; stationary = b; }
            else if (b.r.y > a.r.y) { mover = b; stationary = a; }
            else { mover = b; stationary = a; }
            mover.r.y = stationary.r.y + stationary.r.h;
            changed = true;
          }
        }
      }
    }
    state.forEach(function(s) {
      if (!s.isActive) setTileCoords(s.card, s.r.x, s.r.y, s.r.w, s.r.h);
    });
  }
  // can `card` occupy rect r without leaving the grid or hitting a visible tile?
  function tileFits(grid, card, r) {
    if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > GRID_COLS) return false;
    return gridCards(grid).every(function (o) {
      if (o === card || o.classList.contains("layout-hidden")) return true;
      var k = tileCoords(o);
      if (isNaN(k.x)) return true;   // not placed yet
      return !rectsOverlap(r, k);
    });
  }
  function firstFreeCell(grid, card, w, h) {
    for (var y = 0; y < 400; y++) {
      for (var x = 0; x + w <= GRID_COLS; x++) {
        if (tileFits(grid, card, { x: x, y: y, w: w, h: h })) return { x: x, y: y };
      }
    }
    return { x: 0, y: 0 };
  }

  // gravity-up packing: float each rect to the smallest y where it still fits,
  // scanning in (y,x) order so nothing leaves a hole above it. Removing, hiding
  // or shrinking a tile therefore never leaves a void - the tiles below rise to
  // fill it (like BeamNG's app editor). Pure -> unit-tested in _selfcheck.
  function compactRects(rects) {
    var out = rects.map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; });
    var order = out.map(function (r, i) { return i; })
      .sort(function (a, b) { return out[a].y - out[b].y || out[a].x - out[b].x; });
    var placed = [];
    order.forEach(function (i) {
      var r = out[i], y = r.y;
      while (y > 0 && !placed.some(function (p) {
        return rectsOverlap({ x: r.x, y: y - 1, w: r.w, h: r.h }, p);
      })) y--;
      r.y = y;
      placed.push({ x: r.x, y: y, w: r.w, h: r.h });
    });
    return out;
  }
  function compactGrid(grid) {
    var cards = gridCards(grid).filter(function (c) {
      return !c.classList.contains("layout-hidden") && !isNaN(tileCoords(c).x);
    });
    var packed = compactRects(cards.map(tileCoords));
    cards.forEach(function (c, i) { setTileCoords(c, packed[i].x, packed[i].y, packed[i].w, packed[i].h); });
  }

  function tileGridCfg() { return Store.getJSON("tileGrid", {}) || {}; }

  function applyTileGrid() {
    $$(".tile-grid").forEach(function (grid) {
      var pageId = grid.closest(".page").id;
      var saved = tileGridCfg()[pageId] || {};
      var homeless = [];
      gridCards(grid).forEach(function (c) {
        var s = saved[c.dataset.tile];
        if (s) {
          setTileCoords(c, s.x, s.y, s.w, s.h);
          c.classList.toggle("layout-hidden", !!s.hidden);
        } else if (c.dataset.gx != null && c.dataset.gx !== "") {
          setTileCoords(c, +c.dataset.gx, +c.dataset.gy, +c.dataset.gw, +c.dataset.gh);
          c.classList.remove("layout-hidden");
        } else {
          c.classList.remove("layout-hidden");
          homeless.push(c);   // e.g. a freshly-added custom tile with no saved spot
        }
      });
      // pack homeless tiles into the first gap that fits, at their declared
      // size (data-gw/gh from the HTML; 4x3 fallback for custom tiles that
      // ship no size). This is what makes per-tile sizing in index.html stick.
      homeless.forEach(function (c) {
        var w = +c.dataset.gw || 4, h = +c.dataset.gh || 3;
        var cell = firstFreeCell(grid, c, w, h);
        setTileCoords(c, cell.x, cell.y, w, h);
      });
      compactGrid(grid);   // float everything up so saved voids self-heal on load
    });
  }

  function saveTileGrid(grid) {
    var cfg = tileGridCfg(), out = {};
    gridCards(grid).forEach(function (c) {
      var k = tileCoords(c);
      out[c.dataset.tile] = { x: k.x, y: k.y, w: k.w, h: k.h,
        hidden: c.classList.contains("layout-hidden") };
    });
    cfg[grid.closest(".page").id] = out;
    Store.setJSON("tileGrid", cfg);
  }

  function resetTileGrid() { Store.set("tileGrid", "{}"); applyTileGrid(); }

  // grid geometry -> pixels per cell (for translating a pointer drag into cells)
  function gridMetrics(grid) {
    var rect = grid.getBoundingClientRect(), cs = getComputedStyle(grid);
    var gap = parseFloat(cs.columnGap) || 22, rowGap = parseFloat(cs.rowGap) || gap;
    var rowH = parseFloat(cs.gridAutoRows) || 80;
    return { colW: (rect.width - (GRID_COLS - 1) * gap) / GRID_COLS, rowH: rowH, gap: gap, rowGap: rowGap };
  }

  function wireTile(card) {
    var grid = card.closest(".tile-grid");
    var mode = null, sx = 0, sy = 0, start = null;
    var isPendingMove = false, startMoveX = 0, startMoveY = 0, startTileCoords = null;
    var originalLayout = [];

    function begin(ev, m) {
      mode = m; start = tileCoords(card); sx = ev.clientX; sy = ev.clientY;
      card.classList.add("layout-drag");
      
      originalLayout = gridCards(grid).filter(function(c) { 
        return !c.classList.contains("layout-hidden"); 
      }).map(function(c) {
         return { card: c, originalRect: tileCoords(c) };
      });
      
      var placeholder = document.createElement("div");
      placeholder.className = "grid-placeholder";
      placeholder.id = "gridPlaceholder";
      setTileCoords(placeholder, start.x, start.y, start.w, start.h);
      grid.appendChild(placeholder);
      
      try { card.setPointerCapture(ev.pointerId); } catch (e) { /* older CEF */ }
      ev.preventDefault(); ev.stopPropagation();
    }
    function moveTo(ev) {
      if (!mode) return;
      var m = gridMetrics(grid);
      var dx = ev.clientX - sx;
      var dy = ev.clientY - sy;
      var dcx = Math.round(dx / (m.colW + m.gap));
      var dcy = Math.round(dy / (m.rowH + m.rowGap));
      var r;
      var placeholder = document.getElementById("gridPlaceholder");
      
      if (mode === "move") {
        card.style.transform = "translate(" + dx + "px, " + dy + "px)";
        r = { x: start.x + dcx, y: start.y + dcy, w: start.w, h: start.h };
        r.x = Math.max(0, Math.min(GRID_COLS - r.w, r.x));
        r.y = Math.max(0, r.y);
      } else {
        r = { x: start.x, y: start.y,
          w: Math.max(1, Math.min(GRID_COLS - start.x, start.w + dcx)),
          h: Math.max(1, start.h + dcy) };
      }
      
      if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > GRID_COLS) return;
      
      if (placeholder) setTileCoords(placeholder, r.x, r.y, r.w, r.h);
      if (mode === "resize") setTileCoords(card, r.x, r.y, r.w, r.h);
      
      resolveGridCollisions(grid, card, r, originalLayout);
    }
    function end(ev) {
      isPendingMove = false;
      if (!mode) return;
      mode = null; card.classList.remove("layout-drag");
      card.style.transform = "";
      
      var placeholder = document.getElementById("gridPlaceholder");
      if (placeholder) {
        var r = tileCoords(placeholder);
        setTileCoords(card, r.x, r.y, r.w, r.h);
        placeholder.remove();
      }

      compactGrid(grid);   // settle the drop: pull tiles up into any freed space
      try { card.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      saveTileGrid(grid);
    }
    card.addEventListener("pointerdown", function (ev) {
      if (ev.target.closest(".tile-resize") || ev.target.closest(".maxbtn")) return;
      if (editing && !ev.target.closest("button") && !ev.target.closest("input")) {
        begin(ev, "move");
      }
    });
    card.addEventListener("pointermove", function (ev) {
      if (isPendingMove) {
        var dx = ev.clientX - startMoveX;
        var dy = ev.clientY - startMoveY;
        if (Math.sqrt(dx*dx + dy*dy) > 4) {
          isPendingMove = false;
          if (!editing) {
            setEditing(true);
          }
          begin(ev, "move");
          sx = startMoveX;
          sy = startMoveY;
          start = startTileCoords;
        }
        return;
      }
      moveTo(ev);
    });
    var rz = card.querySelector(".tile-resize");
    if (rz) rz.addEventListener("pointerdown", function (ev) { if (editing) begin(ev, "resize"); });
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  /* ======================================================== widget catalog =
   * Clone any gauge onto any page. Each catalog entry knows how to build one
   * instance (make -> a live Gauges.* handle) and draw it from a per-frame
   * telemetry snapshot. Added instances are grid tiles like any other, so they
   * drag, resize and persist through the same engine; app.js feeds them every
   * frame via Customize.renderWidgets(), so a gauge stays live on whatever page
   * it sits on - not just the dashboard.
   * ponytail: catalog covers the canvas gauges (the "gauges" users mean); the
   *   composite DOM cards (Indicators/Wheels/Inputs/Raw) stay dashboard cards -
   *   cloning those needs per-instance DOM updates, a later pass. */
  var widgetInstances = {};   // iid -> { type, handle, pageId, el }

  function widgetCanvas(card, title) {
    card.innerHTML = '<div class="card-h">' + escapeHtml(title) + "</div>" +
      '<canvas class="widget-canvas"></canvas>';
    return card.querySelector(".widget-canvas");
  }

  var WIDGETS = {
    speed: {
      label: "Speed dial", make: function (c) {
        return new Gauges.Gauge(widgetCanvas(c, "Speed"), { min: 0, max: 240, label: "SPEED", unit: "km/h" });
      },
      draw: function (g, f) { g.unit = f.speedUnit; g.max = f.speedMax; g.set(f.speedVal); g.draw(); }
    },
    tach: {
      label: "Tachometer", make: function (c) {
        return new Gauges.Gauge(widgetCanvas(c, "RPM"), { min: 0, max: 8000, label: "RPM", unit: "rpm", decimals: 0, accent: "data" });
      },
      draw: function (g, f) { g.redline = f.redline; g.set(f.rpm, f.rpmCeil); g.draw(); }
    },
    gforce: {
      label: "G-meter", make: function (c) { return new Gauges.GMeter(widgetCanvas(c, "G-Force")); },
      draw: function (g, f) { g.set(f.gx, f.gy); g.draw(); }
    },
    rpmchart: {
      label: "Speed / RPM chart", make: function (c) {
        return new Gauges.Chart(widgetCanvas(c, "Speed / RPM history"),
          [{ name: "Speed", color: "accent", max: 240 }, { name: "RPM%", color: "data", max: 1 }]);
      },
      draw: function (g, f, push) { if (push) g.push([f.speedKmh, f.rpmFrac]); g.draw(); }
    },
    compass: {
      label: "Compass / radar", make: function (c) { return new Gauges.Compass(widgetCanvas(c, "Navigation")); },
      draw: function (g, f) { g.setHeading(f.yaw); if (f.pos) g.pushPos(f.pos); g.draw(); }
    },

    gear: {
      label: "Gear indicator", make: function(c) {
        c.innerHTML = '<div class="card-h">Gear</div><div class="gear-badge" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:80px;height:80px;font-size:40px;line-height:80px;border-radius:12px;"><span id="gearVal_clone">N</span></div>';
        return c.querySelector("span");
      },
      draw: function(g, f) {
        if (f.gear !== undefined) g.textContent = f.gear;
      }
    },
    wheels: {
      label: "Wheels status", make: function(c) {
        c.innerHTML = '<div class="card-h">Wheels (slip / drive·brake)</div><div class="wheels"></div>';
        return { box: c.querySelector(".wheels"), els: [] };
      },
      draw: function(g, f) {
        var wData = null;
        if (window.AVCP && window.AVCP.Telemetry) wData = window.AVCP.Telemetry.wheelInfo;
        var arr = !wData ? [] : (Array.isArray(wData) ? wData : Object.keys(wData).map(function(k){return wData[k];}));
        arr = arr.filter(function(v){return v && typeof v[0] === "string";});
        var len = arr.length;
        if (!len) { g.box.innerHTML = '<div class="hint">No wheel data.</div>'; g.els = []; return; }
        if (g.els.length !== len) {
          var sorted = arr.sort(function(a,b){return a[0]>b[0]?1:-1;});
          g.box.innerHTML = sorted.map(function(v) {
            return '<div class="wheel"><div class="wn">' + v[0] + '</div>' +
                   '<div class="wsub">0 km/h · slip 0.0</div>' +
                   '<div class="wbar"><i style="width:0%"></i></div></div>';
          }).join("");
          g.els = Array.from(g.box.querySelectorAll(".wheel"));
        }
        var sorted2 = arr.sort(function(a,b){return a[0]>b[0]?1:-1;});
        for (var i=0; i<len; i++) {
          var v = sorted2[i], el = g.els[i];
          if(!el) continue;
          var slip = Math.min(1, Math.abs(v[5] || 0) / 10);
          var spd = Math.abs((v[3] || 0) * (v[1] || 0)) * 3.6;
          el.querySelector(".wsub").textContent = spd.toFixed(0) + " km/h · slip " + (v[5] || 0).toFixed(1);
          el.querySelector("i").style.width = (slip * 100).toFixed(0) + "%";
        }
      }
    },
  };

  function widgetsCfg() { return Store.getJSON("widgets", {}) || {}; }

  // every page gets a free-placement grid zone for cloned gauges; the dashboard
  // already is one (its built-ins), so it reuses that instead of a second grid.
  function injectWidgetGrids() {
    $$(".page").forEach(function (p) {
      if ($(".tile-grid", p)) return;
      var g = document.createElement("div");
      g.className = "grid widget-grid tile-grid";
      p.appendChild(g);
    });
  }
  function pageGrid(pageId) { return $("#" + pageId + " .tile-grid"); }

  function renderWidgetInstances() {
    var cfg = widgetsCfg();
    Object.keys(cfg).forEach(function (pageId) {
      var grid = pageGrid(pageId);
      if (!grid) return;
      (cfg[pageId] || []).forEach(function (w) {
        var def = WIDGETS[w.type];
        if (!def) return;
        var card = document.createElement("div");
        card.className = "card widget-card";
        card.dataset.tile = w.iid;
        card.dataset.widget = w.type;
        try {
          var handle = def.make(card);
          grid.appendChild(card);
          widgetInstances[w.iid] = { type: w.type, handle: handle, pageId: pageId, el: card };
        } catch (e) { /* a broken widget def must not take the rest of the page down */ }
      });
    });
  }

  function addWidget(type) {
    if (!WIDGETS[type]) return;
    var active = $(".page.active");
    if (!active || !pageGrid(active.id)) { toast("open a page first"); return; }
    var cfg = widgetsCfg();
    (cfg[active.id] = cfg[active.id] || []).push({ iid: "w" + Date.now(), type: type });
    Store.setJSON("widgets", cfg);
    toast(WIDGETS[type].label + " added - reloading…");
    setTimeout(function () { location.reload(); }, 350);
  }

  function removeWidget(iid) {
    var cfg = widgetsCfg(), grid = tileGridCfg();
    Object.keys(cfg).forEach(function (pageId) {
      cfg[pageId] = (cfg[pageId] || []).filter(function (w) { return w.iid !== iid; });
      if (grid[pageId]) delete grid[pageId][iid];
    });
    Store.setJSON("widgets", cfg);
    Store.setJSON("tileGrid", grid);
    toast("gauge removed - reloading…");
    setTimeout(function () { location.reload(); }, 350);
  }

  // called from app.js render loop each frame with a telemetry snapshot; only
  // instances on the visible page draw (canvas work is not free).
  function renderWidgets(frame, push) {
    for (var iid in widgetInstances) {
      var inst = widgetInstances[iid];
      var page = document.getElementById(inst.pageId);
      if (!page || !page.classList.contains("active")) continue;
      if (inst.el.classList.contains("layout-hidden")) continue;
      try { WIDGETS[inst.type].draw(inst.handle, frame, push); } catch (e) { /* keep looping */ }
    }
  }

  function openAddWidgetModal() {
    var existing = document.getElementById("widgetModalOverlay");
    if (existing) existing.remove();
    
    var overlay = document.createElement("div");
    overlay.className = "widget-modal-overlay";
    overlay.id = "widgetModalOverlay";
    
    var modal = document.createElement("div");
    modal.className = "widget-modal";
    
    var header = document.createElement("div");
    header.className = "widget-modal-header";
    header.innerHTML = '<span>Add Widget</span>' +
                       '<div><button class="btn" id="modalResetLayout">Reset Layout</button> ' +
                       '<button class="mini" id="modalClose">✕</button></div>';
    
    var grid = document.createElement("div");
    grid.className = "widget-modal-grid";
    
    var previews = [];
    
    Object.keys(WIDGETS).forEach(function (k) {
      var w = WIDGETS[k];
      var card = document.createElement("div");
      card.className = "widget-preview-card";
      card.dataset.widget = k;
      
      var title = document.createElement("div");
      title.className = "wp-title";
      title.textContent = w.label;
      card.appendChild(title);

      // widgets build their own canvas/DOM into a host container (same contract
      // as renderWidgetInstances); guard each so one bad entry can't nuke the
      // whole modal - which is exactly why "+ Add" used to open nothing.
      var host = document.createElement("div");
      card.appendChild(host);
      grid.appendChild(card);
      try {
        previews.push({ gauge: w.make(host), key: k });
      } catch (e) {
        host.innerHTML = '<div class="hint" style="padding:10px">preview unavailable</div>';
      }
    });
    
    modal.appendChild(header);
    modal.appendChild(grid);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Some widgets need a frame to render. Some use 'push'. Keys match the
    // snapshot app.js feeds renderWidgets() every frame.
    var dummyFrame = { speedVal: 125, speedUnit: "km/h", speedMax: 240, speedKmh: 125,
      rpm: 4500, rpmCeil: 8000, redline: 6800, rpmFrac: 0.56,
      gx: 0.5, gy: 0.2, yaw: 0.8, pos: null, gear: "4" };
    previews.forEach(function(p) {
      try { 
        if (WIDGETS[p.key].draw) WIDGETS[p.key].draw(p.gauge, dummyFrame, true); 
        else if (p.gauge.draw) p.gauge.draw(dummyFrame, true);
        else if (p.gauge.update) p.gauge.update(dummyFrame);
      } catch (e) { /* ignore */ }
    });
    
    grid.addEventListener("click", function(ev) {
      var b = ev.target.closest(".widget-preview-card");
      if (b) {
        addWidget(b.dataset.widget);
        overlay.remove();
      }
    });
    
    overlay.querySelector("#modalClose").addEventListener("click", function() { overlay.remove(); });
    overlay.querySelector("#modalResetLayout").addEventListener("click", function() {
      resetLayout();
      toast("layout reset to default");
      overlay.remove();
    });
    
    overlay.addEventListener("click", function(ev) {
      if (ev.target === overlay) overlay.remove();
    });
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
    function applyScale(pageId) {
    if (!pageId) {
      var act = document.querySelector(".tab.active");
      pageId = act ? act.dataset.tab : "dashboard";
    }
    var scales = Store.getJSON("uiScaleObj", { dashboard: 90, stats: 105 });
    var s = scales[pageId] || 100;
    document.body.style.zoom = s === 100 ? "" : (s / 100);
    var sc = document.getElementById("uiScale"), scv = document.getElementById("uiScaleVal");
    if (sc && sc.value !== s.toString()) { sc.value = s; if (scv) scv.textContent = s + "%"; }
  }

  /* =============================================================== profiles */
  // A profile is a snapshot of these raw avcp.* values. Keys absent from a
  // profile are REMOVED on apply, so loading one lands you exactly where it
  // was saved. (The custom background image lives in IndexedDB and is not
  // part of a profile - too big to export; a remote/preset background is.)
  var PROFILE_KEYS = ["theme", "accent", "data", "units", "units2", "gauges",
    "appearance", "layout", "alerts", "uiScaleObj", "startTab", "keys",
    "customCss", "customCssOn", "customTiles", "tileGrid", "widgets"];

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

  /* ============================================================ custom tiles */
  // User-authored Dashboard cards, each bound to one live telemetry (electrics)
  // field. Rendered into the dashboard grid at BOOT - before assignCardIds() -
  // so they become real .cards that ride the SAME layout editor (drag / hide /
  // reorder / persist) as the built-ins. Add & remove reload the page, matching
  // the profiles pattern (the only honest full re-render).
  // ponytail: field value shown raw (no unit conversion) - the unit is a user
  //   label; add/remove resets dashboard order (layout self-heal on count change).
  //   In-place edit skipped: delete + re-add covers it.
  function customTiles() { return Store.getJSON("customTiles", []) || []; }

  // pure + testable: null/blank -> dash, numbers rounded, strings passthrough
  function formatTileValue(v, decimals, unit) {
    var out;
    if (v == null || v === "") out = "–";
    else if (typeof v === "number") out = isFinite(v) ? v.toFixed(decimals || 0) : "–";
    else out = String(v);
    if (unit && out !== "–") out += " " + unit;
    return out;
  }

  function renderCustomTiles() {
    var grid = $("#page-dashboard .dash-grid");
    if (!grid) return;
    customTiles().forEach(function (t) {
      var card = document.createElement("div");
      card.className = "card custile";
      card.dataset.tile = t.id;   // stable id so the grid can place & persist it
      card.innerHTML = '<div class="card-h">' + escapeHtml(t.title || t.field || "Tile") + "</div>" +
        '<div class="custile-val" data-field="' + escapeHtml(t.field || "") +
        '" data-dec="' + (parseInt(t.decimals, 10) || 0) + '" data-unit="' +
        escapeHtml(t.unit || "") + '">–</div>';
      grid.appendChild(card);
    });
  }

  // called from app.js render loop (throttled, dashboard-visible only)
  function updateTiles(e) {
    $$(".custile-val").forEach(function (el) {
      el.textContent = formatTileValue(e ? e[el.dataset.field] : null,
        parseInt(el.dataset.dec, 10) || 0, el.dataset.unit);
    });
  }

  function renderCtList() {
    var box = $("#ctList");
    if (!box) return;
    var tiles = customTiles();
    if (!tiles.length) {
      box.innerHTML = '<div class="hint">No custom tiles yet.</div>';
      return;
    }
    box.innerHTML = tiles.map(function (t, i) {
      return '<div class="dl-row" data-i="' + i + '">' +
        '<div class="dl-row-main"><b>' + escapeHtml(t.title || t.field) + "</b><span>" +
        escapeHtml(t.field) + (t.unit ? " · " + escapeHtml(t.unit) : "") + "</span></div>" +
        '<div class="dl-row-actions"><button class="mini danger" data-ctdel>✕</button></div></div>';
    }).join("");
    $$("#ctList [data-ctdel]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!this.classList.contains("confirm")) {
          var self = this;
          this.classList.add("confirm"); this.textContent = "sure?";
          setTimeout(function () { self.classList.remove("confirm"); self.textContent = "✕"; }, 2500);
          return;
        }
        var i = parseInt(this.closest("[data-i]").dataset.i, 10);
        var all = customTiles(); all.splice(i, 1);
        Store.setJSON("customTiles", all);
        toast("tile removed - reloading…");
        setTimeout(function () { location.reload(); }, 350);
      });
    });
  }

  function addTile() {
    var field = ($("#ctField").value || "").trim();
    if (!field) { toast("enter a telemetry field"); return; }
    var all = customTiles();
    all.push({
      id: "ct" + Date.now(),
      title: ($("#ctTitle").value || "").trim() || field,
      field: field,
      unit: ($("#ctUnit").value || "").trim(),
      decimals: Math.max(0, Math.min(4, parseInt($("#ctDec").value, 10) || 0))
    });
    Store.setJSON("customTiles", all);
    toast("tile added - reloading…");
    setTimeout(function () { location.reload(); }, 350);
  }

  /* ========================================================= online gallery */
  function browseGallery() {
    var box = $("#galleryBox");
    box.innerHTML = '<div class="hint">loading gallery… (if you see this your internet is either ass or it broke)</div>';
    fetch(galleryUrl(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(renderGallery)
      .catch(function (e) {
        box.innerHTML = '<div class="warn">Couldn’t load gallery (' + escapeHtml(e.message) +
          "). Cannot reach CDN.</div>";
      });
  }

  function renderGallery(g) {
    var box = $("#galleryBox");
    if (!g || g.format !== "avcp-index-1") {
      box.innerHTML = '<div class="hint">The gallery index has an unexpected format.</div>';
      return;
    }
    // note: themes are deliberately LOCAL (Settings → Theme presets + custom
    // colours); an index "themes" array is ignored if present
    var html = "";
    if (g.backgrounds && g.backgrounds.length) {
      html += '<label class="slider-label">Backgrounds</label><div class="bg-grid">';
      g.backgrounds.forEach(function (b, i) {
        html += '<button class="bg-swatch" data-gbg="' + i + '">' +
          '<i style="background-image:url(\'' + escapeHtml(resolveCdn(b.thumb || b.file)) + '\');background-size:cover;background-position:center"></i>' +
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
        AVCP.setAppearance("bgUrl", resolveCdn(b.file));
        AVCP.setAppearance("bgMode", "remote");
        if (!AVCP.appearance().glass) AVCP.setAppearance("glass", true);
        toast("background “" + (b.name || "image") + "” applied");
      });
    });
    $$("#galleryBox [data-gpr]").forEach(function (el) {
      el.addEventListener("click", function () {
        var p = g.profiles[parseInt(this.dataset.gpr, 10)];
        toast("fetching profile…");
        fetch(resolveCdn(p.file), { cache: "no-store" })
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
    var editBtn = $("#editBtn");
    if (editBtn) editBtn.addEventListener("click", function () { setEditing(!editing); });
    var cancelBtn = $("#cancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { setEditing(false, true); });
    // Esc bails out of the layout editor (discarding the session's edits) - the
    // usual "get me out of this mode" reflex; no-op when not editing.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && editing) { setEditing(false, true); }
    });
    var addBtn = $("#addBtn");
    if (addBtn) addBtn.addEventListener("click", function () {
      if (!editing) setEditing(true);
      openAddWidgetModal();
    });
    var resetBtn = $("#resetBtn");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      resetLayout(); toast("layout reset to default");
    });

    // interface: scale + startup tab
    var sc = $("#uiScale"), scv = $("#uiScaleVal");
    if (sc) {
      sc.addEventListener("input", function () {
        scv.textContent = this.value + "%";
        var act = document.querySelector(".tab.active");
        var pid = act ? act.dataset.tab : "dashboard";
        var scales = Store.getJSON("uiScaleObj", { dashboard: 90, stats: 105 });
        scales[pid] = parseInt(this.value, 10);
        Store.setJSON("uiScaleObj", scales);
        applyScale(pid);
      });
    }
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

    // custom tiles
    var ctAddBtn = $("#ctAdd");
    if (ctAddBtn) ctAddBtn.addEventListener("click", addTile);
    renderCtList();

    // widget modal is spawned via openAddWidgetModal
  }

  function _selfcheck() {
    var f = formatTileValue;
    console.assert(f(null, 0, "km/h") === "–", "null -> dash");
    console.assert(f(12.345, 1, "") === "12.3", "decimals");
    console.assert(f(12.345, 0, "C") === "12 C", "unit appended");
    console.assert(f("N", 0, "gear") === "N gear", "string passthrough");
    console.assert(f(Infinity, 0, "") === "–", "non-finite -> dash");
    console.assert(f(0, 2, "%") === "0.00 %", "zero is not blank");
    // grid collision math
    console.assert(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 }) === true, "overlap");
    console.assert(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }) === false, "side by side");
    console.assert(rectsOverlap({ x: 0, y: 0, w: 3, h: 1 }, { x: 0, y: 1, w: 3, h: 1 }) === false, "stacked");
    // void-filling compaction (gravity up)
    var packed = compactRects([{ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 5, w: 2, h: 1 }]);
    console.assert(packed[1].y === 2, "compaction pulls a tile up to sit under the one above");
    var cols = compactRects([{ x: 0, y: 3, w: 2, h: 1 }, { x: 2, y: 0, w: 2, h: 1 }]);
    console.assert(cols[0].y === 0 && cols[1].y === 0, "independent columns both float to the top");
    return "custom-tile + grid self-check ok";
  }

  global.Customize = {
    init: init, tick: tick, updateTiles: updateTiles, renderWidgets: renderWidgets, applyScale: applyScale,
    _selfcheck: _selfcheck, _addWidget: addWidget, _removeWidget: removeWidget,
    persistLayout: persistLayout, saveTileGrid: saveTileGrid, setEditing: setEditing
  };

  // applied immediately so the first paint already wears the user's layout,
  // scale and stylesheet (this script runs at the end of <body>, DOM is ready).
  // custom tiles inject FIRST so they get card ids and ride the layout editor.
  renderCustomTiles();
  injectWidgetGrids();      // give every non-dashboard page a grid zone for clones
  renderWidgetInstances();  // rebuild cloned gauges and their live handles
  assignCardIds();
  // one-time layout migration: bump when the built-in default tile sizes change
  // so a previously-saved grid can't pin the OLD sizes forever (that's why the
  // stats tiles stayed thick after their default was slimmed). Only the tile
  // positions reset - themes, gauges, custom CSS etc. are untouched.
  if (Store.get("layoutVer", "0") !== "7") { Store.set("tileGrid", "{}"); Store.set("layoutVer", "7"); }
  applyTileGrid();   // free-placement pages get explicit cell positions
  applyLayout();     // flow pages get their saved order
  applyScale();
  applyCustomCss();
})(window);
