/* =============================================================================
 * Luna Mattins AVCP - Remote Access (opt-in relay pairing)
 *
 * One file, two roles, decided by how the page was served:
 *
 *   HOST   - the panel served by the GAME's web server (http://localhost:8084/…).
 *            Settings → Remote Access toggles an outbound wss connection to the
 *            relay, displays the pairing code, and - once a client pairs - opens
 *            a SECOND, dedicated WebSocket to the game and pumps frames between
 *            game and relay verbatim. The panel's own Bridge connection is never
 *            shared, so callback ids / stream subscriptions can't collide.
 *   CLIENT - the panel served by the RELAY over https (a phone). Instead of
 *            dialing the page's host directly, bridge.js asks this module for
 *            the relay /client URL; before a pairing code exists a code-entry
 *            overlay gates the connection.
 *
 * Relay framing (host leg): TEXT frames = relay control JSON ({t:"code"|"paired"|
 * "unpaired"}), BINARY frames = piped game traffic. The client leg carries pure
 * game traffic - its code travels in the connect URL. See server/relay.js.
 *
 * Compliance posture: strictly opt-in, OFF by default, never persisted - remote
 * access dies with the toggle or the tab. No data leaves the machine until the
 * user turns it on. The relay endpoint is disclosed in the README.
 * ========================================================================== */
(function (global) {
  "use strict";

  var AVCP = global.AVCP;
  if (!AVCP || !global.Bridge) return; // settings.js + bridge.js must load first
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var DEFAULT_RELAY = "wss://avcp.malo-interactive.net";
  // https = served by the relay, not the game (the game's server is plain http).
  // ?remote=1 forces client mode for local ws:// testing (see server/README.md).
  var IS_CLIENT = location.protocol === "https:" || /[?&]remote=1/.test(location.search);

  function fmtCode(c) { return c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c; }
  function normCode(x) { return String(x || "").toUpperCase().replace(/[^A-Z2-9]/g, ""); }

  /* ================================================================ CLIENT */
  if (IS_CLIENT) {
    var code = null, bridgeRef = null, gateEl = null;
    try { code = sessionStorage.getItem("avcp.remote.code") || null; } catch (e) { /* private mode */ }
    // allow pairing links: https://avcp.…/#ABCD-EFGH
    var h = normCode(location.hash);
    if (h.length === 8) {
      code = h;
      try { sessionStorage.setItem("avcp.remote.code", code); } catch (e) { /* ignore */ }
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
    }

    var clearCode = function () {
      code = null;
      try { sessionStorage.removeItem("avcp.remote.code"); } catch (e) { /* ignore */ }
    };

    var showGate = function (msg) {
      if (!gateEl) {
        gateEl = document.createElement("div");
        gateEl.id = "remoteGate";
        gateEl.innerHTML =
          '<div class="rg-box">' +
          '<div class="rg-title">Luna Mattins <b>AVCP</b></div>' +
          '<div class="rg-sub">On your gaming PC, open the panel and turn on ' +
          "<b>Settings → Remote Access</b>, then enter the pairing code shown there.</div>" +
          '<input id="rgInput" autocomplete="off" autocapitalize="characters" ' +
          'spellcheck="false" maxlength="9" placeholder="ABCD-EFGH">' +
          '<button class="btn primary" id="rgGo">Connect</button>' +
          '<div class="rg-msg" id="rgMsg"></div></div>';
        document.body.appendChild(gateEl);
        var submit = function () {
          var v = normCode($("#rgInput").value);
          if (v.length !== 8) { $("#rgMsg").textContent = "codes are 8 characters (letters + digits)"; return; }
          code = v;
          try { sessionStorage.setItem("avcp.remote.code", code); } catch (e) { /* ignore */ }
          $("#rgMsg").textContent = "connecting…";
          if (bridgeRef) bridgeRef.connect();
        };
        $("#rgGo").addEventListener("click", submit);
        $("#rgInput").addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      }
      gateEl.classList.remove("hidden");
      // only overwrite the message when one is passed - the Bridge's backoff
      // reconnect re-opens the gate and must not wipe a rejection reason
      if (msg != null) $("#rgMsg").textContent = msg;
      $("#rgInput").focus();
    };
    var hideGate = function () { if (gateEl) gateEl.classList.add("hidden"); };

    global.AVCPRemote = {
      isClient: true,
      clientWsUrl: function () {
        var proto = location.protocol === "https:" ? "wss://" : "ws://";
        return proto + location.host + "/client?code=" + encodeURIComponent(code || "");
      },
      // bridge.connect() calls this; false = no code yet, overlay is up and
      // will re-call connect() once the user enters one
      gate: function (br) {
        if (!bridgeRef) {
          bridgeRef = br;
          br.on("connection", function (state, closeCode, reason) {
            if (state === "open") { hideGate(); return; }
            // relay-intent close codes mean the code is dead - re-prompt.
            // Network blips (1006 etc.) keep the code; the Bridge's backoff
            // reconnect reuses it (valid for the host session's lifetime).
            if (closeCode >= 4001 && closeCode <= 4005) {
              clearCode();
              showGate(String(reason || "disconnected") + " - enter a new code");
            }
          });
        }
        if (code) return true;
        showGate(null);
        return false;
      }
    };
    // hosting UI is meaningless on a relayed client - hide the Settings card
    document.addEventListener("DOMContentLoaded", function () {
      var c = $("#remoteCard"); if (c) c.style.display = "none";
    });
    return; // host code below never runs on clients
  }

  /* ================================================================== HOST */
  global.AVCPRemote = { isClient: false };

  var on = false, relay = null, game = null, retryTimer = null, paired = false;
  var DEC = new TextDecoder();

  // Settings → Remote Access → "Relay server" (stored as avcp.relayUrl)
  // overrides the official relay: self-hosted instances, or a local relay.js
  // without TLS (see server/README.md). Empty = official relay.
  function relayBase() {
    var u = String(AVCP.Store.get("relayUrl", "") || "").trim();
    return (u || DEFAULT_RELAY).replace(/\/+$/, "");
  }
  function relayHost() { return relayBase().replace(/^wss?:\/\//i, ""); }
  function gameWsUrl() { return Bridge.prototype._wsUrl.call(null); } // same derivation the panel's own Bridge uses

  function setStatus(t) { var el = $("#remoteStatus"); if (el) el.textContent = t; }
  function setCodeUI(c) {
    var el = $("#remoteCode"); if (!el) return;
    el.classList.toggle("hidden", !c);
    el.textContent = c ? fmtCode(c) : "";
  }
  function setPairedUI(p) {
    paired = p;
    var k = $("#remoteKick"); if (k) k.classList.toggle("hidden", !p);
    var st = $("#remoteState"); if (st) st.textContent = on ? (p ? "client connected" : "on") : "off";
    if (!on) setDownUI();
  }

  /* ---- official-relay status notice --------------------------------------
   * STATUS_URL is a plain-text file next to the CDN assets:
   *   STATUS=UP|DOWN
   *   REASON=<one human-readable line, optional>
   * Fetched only on a user action (opening the Settings tab / the toggle),
   * only while the official relay is the configured target, and it never
   * blocks anything - it's a notice, not a gate. An unreachable status file
   * proves nothing and shows nothing. The file is remote DATA: it is parsed
   * with these two line-anchored patterns and rendered via textContent only.
   */
  var STATUS_URL = "https://cdn.boykisser.cloud/malo-interactive/avcp-cdn/wss-status.txt";
  var officialDown = false, statusChecked = false;

  function setDownUI() {
    var showing = officialDown && relayBase() === DEFAULT_RELAY;
    var el = $("#remoteDown"); if (el) el.classList.toggle("hidden", !showing);
    var st = $("#remoteState");
    if (st && !on) st.textContent = showing ? "official relay down" : "off";
  }
  function checkOfficialStatus() {
    if (statusChecked || relayBase() !== DEFAULT_RELAY) return;
    statusChecked = true;
    fetch(STATUS_URL, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (txt) {
        var m = /^STATUS=(.+)$/m.exec(txt || "");
        officialDown = !!m && m[1].trim().toUpperCase() === "DOWN";
        if (officialDown) {
          var r = /^REASON=(.+)$/m.exec(txt);
          var reason = r ? r[1].trim().slice(0, 300) : "";
          var el = $("#remoteDown");
          if (el) el.textContent = "Official relay is DOWN" + (reason ? ": " + reason : ".");
        }
        setDownUI();
      })
      .catch(function () { /* offline / blocked - not a verdict */ });
  }
  function updateRelayUI() {
    var h = $("#remoteHost"); if (h) h.textContent = relayHost();
    setDownUI();
  }

  function closeGamePipe() {
    if (game) { try { game.close(); } catch (e) { /* ignore */ } game = null; }
  }
  function openGamePipe() {
    closeGamePipe();
    var g = new WebSocket(gameWsUrl(), "bng-ext-app-v1");
    game = g;
    g.onmessage = function (ev) {
      if (relay && relay.readyState === 1) {
        // wrap game text frames as binary = "piped data" framing on the relay leg
        relay.send(ev.data instanceof Blob ? ev.data : new Blob([ev.data]));
      }
    };
    g.onclose = function () {
      if (game !== g) return;
      game = null;
      if (on && paired) {
        // can't serve the client without the game - drop them cleanly
        if (relay && relay.readyState === 1) relay.send(JSON.stringify({ t: "kick" }));
        setStatus("lost the game connection - is BeamNG still running?");
      }
    };
  }

  function connectRelay() {
    var ws = new WebSocket(relayBase() + "/host");
    relay = ws;
    ws.binaryType = "arraybuffer";
    setStatus("contacting relay…");
    ws.onopen = function () { setStatus("waiting for pairing code…"); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === "code") { setCodeUI(m.code); setStatus("enter this code on the other device"); }
        else if (m.t === "paired") { setPairedUI(true); setStatus("client connected - streaming"); openGamePipe(); }
        else if (m.t === "unpaired") { setPairedUI(false); setStatus("client left - code still valid"); closeGamePipe(); }
        return;
      }
      // piped client command -> the game expects text frames
      if (game && game.readyState === 1) game.send(DEC.decode(ev.data));
    };
    ws.onclose = function (ev) {
      if (relay !== ws) return;
      relay = null;
      setPairedUI(false); setCodeUI(null); closeGamePipe();
      if (!on) return;
      setStatus((ev && ev.reason ? ev.reason + " - " : "relay unreachable - ") + "retrying…");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connectRelay, 4000);
    };
  }

  function setRemote(enable) {
    on = !!enable;
    var b = $("#remoteToggle");
    if (b) { b.textContent = on ? "Disable remote access" : "Enable remote access"; b.classList.toggle("on", on); }
    if (on) { connectRelay(); }
    else {
      clearTimeout(retryTimer); retryTimer = null;
      if (relay) { try { relay.close(); } catch (e) { /* ignore */ } relay = null; }
      closeGamePipe();
      setPairedUI(false); setCodeUI(null); setStatus("Off.");
    }
    setPairedUI(paired && on);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var t = $("#remoteToggle"), k = $("#remoteKick");
    if (t) t.addEventListener("click", function () { checkOfficialStatus(); setRemote(!on); });
    if (k) k.addEventListener("click", function () {
      if (relay && relay.readyState === 1) relay.send(JSON.stringify({ t: "kick" }));
    });

    // Relay server field: empty = official relay. Persisted like every other
    // setting; changing it while remote access is ON reconnects immediately.
    var ru = $("#relayUrl");
    if (ru) {
      var saved = String(AVCP.Store.get("relayUrl", "") || "").trim();
      ru.value = saved === DEFAULT_RELAY ? "" : saved;
      ru.addEventListener("change", function () {
        var v = ru.value.trim().replace(/\/+$/, "");
        if (v && !/^wss?:\/\//i.test(v)) {
          setStatus("relay URL must start with ws:// or wss://");
          return; // keep the stored value; the field shows what was rejected
        }
        if (v === DEFAULT_RELAY) v = "";
        AVCP.Store.set("relayUrl", v);
        ru.value = v;
        updateRelayUI();
        if (on) { setRemote(false); setRemote(true); }
        else setStatus(v ? "using custom relay " + relayHost() : "using the official relay");
      });
    }
    updateRelayUI();

    // The status check is user-triggered (navigating to Settings) - never an
    // automatic ping on page load.
    var tabs = document.querySelectorAll('.tab[data-tab="settings"]');
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", checkOfficialStatus);
    setTimeout(function () { // startup-tab = Settings (applied by customize.js)
      var pg = $("#page-settings");
      if (pg && pg.classList.contains("active")) checkOfficialStatus();
    }, 0);
  });
  // deliberately never persisted: remote access is opt-in per session and
  // always starts OFF - closing the tab is a guaranteed kill switch
})(window);
