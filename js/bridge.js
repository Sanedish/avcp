/* =============================================================================
 * Luna Mattins AVCP - Bridge
 *
 * Standalone re-implementation of the game's UI<->engine communication layer
 * (normally split across ui/entrypoints/main/comms.js + ui-vue BeamNGAPI /
 * StreamManager / Hooks). This lets a plain browser talk to the running game
 * over the same WebSocket "bng-ext-app-v1" protocol that the in-game external
 * app server exposes on the page's own host:port.
 *
 * Nothing here modifies game files; it only *speaks* the documented protocol.
 * ========================================================================== */
(function (global) {
  "use strict";

  // --- Lua serialization (ported from BeamNGAPI.serializeToLua) --------------
  function serializeToLua(obj) {
    if (obj === undefined || obj === null) return "nil";
    switch (obj.constructor) {
      case String:
        if (obj.search(/\\|"|\n|\t|\r/) !== -1) {
          return '"' + obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\n|\r/g, "\\n").replace(/\t/g, "\\t") + '"';
        }
        return '"' + obj + '"';
      case Number:
        return isFinite(obj) ? obj.toString() : "nil";
      case Boolean:
        return obj ? "true" : "false";
      case Array: {
        var t = [];
        for (var i = 0; i < obj.length; i++) {
          if (obj[i] != null) t.push(serializeToLua(obj[i]));
        }
        return "{" + t.join(",") + "}";
      }
      case Function:
        return "nil";
      default:
        if (typeof obj === "object") {
          var parts = [];
          for (var attr in obj) {
            if (typeof obj[attr] !== "function") {
              parts.push('["' + attr + '"]=' + serializeToLua(obj[attr]));
            }
          }
          return "{" + parts.join(",") + "}";
        }
        return obj.toString();
    }
  }

  function Bridge() {
    this.ws = null;
    this.connected = false;
    this.msgBuffer = [];
    this.callbackId = 0;
    this.apiCallbacks = {};
    this.beamng = null;           // base info from the game (I# message)
    this._listeners = {};         // event name -> [fn]
    this._streamRefs = {};        // stream name -> refcount
    this._reconnectTimer = null;
  }

  Bridge.prototype.serializeToLua = serializeToLua;

  // --- tiny event emitter ----------------------------------------------------
  Bridge.prototype.on = function (evt, fn) {
    (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
    return this;
  };
  Bridge.prototype.off = function (evt, fn) {
    var a = this._listeners[evt];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  Bridge.prototype.emit = function (evt) {
    var a = this._listeners[evt];
    if (!a) return;
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < a.length; i++) {
      try { a[i].apply(null, args); } catch (e) { console.error("listener error", evt, e); }
    }
  };

  // --- websocket lifecycle ---------------------------------------------------
  Bridge.prototype._wsUrl = function () {
    var u = document.URL, pcol;
    if (u.substring(0, 5) === "https") { pcol = "wss://"; u = u.substr(8); }
    else { pcol = "ws://"; if (u.substring(0, 4) === "http") u = u.substr(7); }
    return pcol + u.split("/")[0] + "/";
  };

  Bridge.prototype.connect = function () {
    var self = this;
    try {
      this.ws = new WebSocket(this._wsUrl(), "bng-ext-app-v1");
    } catch (e) {
      console.error("WS construct failed", e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = function () {
      self.connected = true;
      self._backoff = 500; // reset backoff on a successful open
      self.emit("connection", "open");
      // flush queued messages
      var buf = self.msgBuffer; self.msgBuffer = [];
      for (var i = 0; i < buf.length; i++) self.ws.send(buf[i]);
      // re-subscribe to any streams that were requested before connect
      self._pushSubscriptions();
    };

    this.ws.onclose = function () {
      self.connected = false;
      self.emit("connection", "closed");
      self._scheduleReconnect();
    };

    this.ws.onerror = function (e) { console.warn("WS error", e); };

    this.ws.onmessage = function (evt) {
      if (evt.data instanceof Blob) {
        evt.data.text().then(function (t) { self._handle(t); });
      } else if (typeof evt.data === "string") {
        self._handle(evt.data);
      }
    };
  };

  Bridge.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._reconnectTimer) return;
    // exponential backoff, capped - quick first retries, then ease off so a
    // genuinely-down server isn't hammered every second forever.
    this._backoff = Math.min((this._backoff || 500) * 1.6, 8000);
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (!self.connected) self.connect();
    }, this._backoff);
  };

  Bridge.prototype._send = function (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.msgBuffer.push(msg);
      return;
    }
    this.ws.send(msg);
  };

  // --- inbound message handling ----------------------------------------------
  Bridge.prototype._handle = function (raw) {
    var id = raw.substr(0, 2);
    var data = raw.slice(2);

    if (id === "H#") {
      // hooks: array of [hookName, argsArray]
      var hooks;
      try { hooks = eval("(" + data + ")"); }
      catch (e) { console.warn("hook parse fail", e); return; }
      for (var i in hooks) this._onHook(hooks[i][0], hooks[i][1]);
    } else if (id === "S#") {
      var streams;
      try { streams = eval("(" + data + ")"); }
      catch (e) { console.warn("stream parse fail", e); return; }
      this._onStreams(streams);
    } else if (id === "I#") {
      try {
        this.beamng = JSON.parse(data);
        this.emit("info", this.beamng);
      } catch (e) { console.warn("info parse fail", e); }
    }
  };

  Bridge.prototype._onHook = function (name, args) {
    args = args || [];
    if (name === "onBNGAPICallback") {
      var idx = args[0], result = args[1];
      if (idx in this.apiCallbacks) {
        try { this.apiCallbacks[idx](result); }
        finally { delete this.apiCallbacks[idx]; }
      }
      return;
    }
    this.emit("hook", name, args);
    this.emit("hook:" + name, args);
  };

  Bridge.prototype._onStreams = function (data) {
    // Flatten new format -> single object (same as game's Hooks.js)
    var flat = {};
    if (data.globalStreams) for (var g in data.globalStreams) flat[g] = data.globalStreams[g];
    if (data.vehicleStreams && data.vehicleStreams.player_0) {
      var v = data.vehicleStreams.player_0;
      for (var s in v) flat[s] = v[s];
    }
    this.emit("streams", flat, data);
  };

  // --- outbound Lua calls ----------------------------------------------------
  Bridge.prototype.engineLua = function (cmd) { this._send("GL" + cmd); };
  Bridge.prototype.activeObjectLua = function (cmd) { this._send("PO" + cmd); };
  Bridge.prototype.queueAllObjectLua = function (cmd) { this._send("PB" + cmd); };

  // Surface a message through BeamNG's OWN notification system: an in-game
  // toastr toast plus a line in the game console. Runs in the engine VM where
  // guihooks exists. Like any _send it's buffered until the socket opens, so a
  // late connection still delivers it; if we never connect it harmlessly no-ops.
  Bridge.prototype.beamngAlert = function (title, msg, kind) {
    var t = String(title || "").replace(/"/g, "'");
    var m = String(msg || "").replace(/"/g, "'");
    var typ = kind || "warning";
    this.engineLua('guihooks.trigger("toastrMsg",{type="' + typ + '",title="' + t +
      '",msg="' + m + '",config={timeOut=0,extendedTimeOut=0}})');
    this.engineLua('log("E","AVCP","' + t + ' - ' + m + '")');
  };

  // engineLua with a return value -> Promise
  Bridge.prototype.engineLuaCb = function (cmd) {
    var self = this;
    return new Promise(function (resolve) {
      var id = ++self.callbackId;
      self.apiCallbacks[id] = resolve;
      self._send('GLguihooks.trigger("onBNGAPICallback",' + id + "," + (cmd || "nil") + ")");
      // safety timeout so a panel never hangs forever
      setTimeout(function () {
        if (id in self.apiCallbacks) { delete self.apiCallbacks[id]; resolve(undefined); }
      }, 8000);
    });
  };

  // activeObjectLua with return value -> Promise.
  // NOTE: `guihooks` does NOT exist in the vehicle Lua VM, so the naive
  // `POguihooks.trigger(...)` silently never fires. Instead we evaluate the
  // expression in the vehicle VM, then bounce the serialized result to the
  // engine VM (which CAN trigger onBNGAPICallback). `serialize()` turns any Lua
  // value into a literal the engine can re-evaluate and hand back as JSON.
  Bridge.prototype.activeObjectLuaCb = function (cmd) {
    var self = this;
    return new Promise(function (resolve) {
      var id = ++self.callbackId;
      self.apiCallbacks[id] = resolve;
      var payload = "local ok,v=pcall(function() return " + (cmd || "nil") +
        " end) obj:queueGameEngineLua(\"guihooks.trigger('onBNGAPICallback'," + id +
        ",\"..serialize(ok and v or ('error: '..tostring(v)))..\")\")";
      self._send("PO" + payload);
      setTimeout(function () {
        if (id in self.apiCallbacks) { delete self.apiCallbacks[id]; resolve(undefined); }
      }, 8000);
    });
  };

  // --- streams subscription (ported from StreamManager) ----------------------
  Bridge.prototype._pushSubscriptions = function () {
    var list = [];
    for (var k in this._streamRefs) list.push(k);
    var subs = { vehicles: [{ byPlayerId: 0, streams: list }] };
    this._send("SE" + JSON.stringify(subs));
  };

  Bridge.prototype.addStreams = function (names) {
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      this._streamRefs[n] = (this._streamRefs[n] || 0) + 1;
    }
    this._pushSubscriptions();
  };

  Bridge.prototype.removeStreams = function (names) {
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (this._streamRefs[n]) {
        if (--this._streamRefs[n] <= 0) delete this._streamRefs[n];
      }
    }
    this._pushSubscriptions();
  };

  // Subscribe to engine event hooks (so game pushes them via H#).
  Bridge.prototype.subscribeHooks = function () {
    // The game pushes most guihooks automatically once a UI is connected;
    // explicit per-hook subscription is not required for the external app.
  };

  global.Bridge = Bridge;
})(window);
