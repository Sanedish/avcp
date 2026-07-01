// Dev-only static file server for previewing the panel outside BeamNG.
// Not part of the mod; never packaged (package-mod.ps1 bundles an explicit list).
//
// Extras for headless/hidden preview windows (where browsers suspend rAF):
//   • injects /__dev-raf-shim.js into index.html - a setTimeout fallback so the
//     panel's render loops keep ticking while the window is hidden
//   • POST /__shot/<name> - body is a canvas dataURL; saved to .claude/shots/
//     so canvases can be inspected as PNG files
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var root = path.resolve(__dirname, "..");
var MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm",
  ".json": "application/json", ".md": "text/plain"
};

var RAF_SHIM = "(function(){\n" +
  "  var raf = window.requestAnimationFrame.bind(window);\n" +
  "  window.requestAnimationFrame = function(fn){\n" +
  "    var done = false;\n" +
  "    var id = raf(function(ts){ if(done) return; done = true; fn(ts); });\n" +
  "    setTimeout(function(){ if(done) return; done = true; fn(performance.now()); }, 50);\n" +
  "    return id;\n" +
  "  };\n" +
  "})();\n";

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (req.method === "POST" && urlPath.indexOf("/__shot/") === 0) {
    var name = urlPath.slice(8).replace(/[^\w\-]/g, "_") || "shot";
    var body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", function () {
      var m = /^data:image\/png;base64,(.+)$/.exec(body);
      if (!m) { res.writeHead(400); res.end("expected png dataURL"); return; }
      var dir = path.join(__dirname, "shots");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(m[1], "base64"));
      res.writeHead(200); res.end("ok");
    });
    return;
  }

  if (urlPath === "/__lastpo") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(lastPO));
    return;
  }

  if (urlPath === "/__dev-raf-shim.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    res.end(RAF_SHIM);
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";
  var file = path.join(root, urlPath);
  if (file.indexOf(root) !== 0) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    var type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (/index\.html$/.test(file)) {
      data = data.toString().replace("<script src=\"./js/settings.js\"></script>",
        "<script src=\"/__dev-raf-shim.js\"></script>\n  <script src=\"./js/settings.js\"></script>");
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
});

var lastPO = { count: 0, last: null }; // last PO (vehicle-Lua) message received

// ---- fake BeamNG external-app WebSocket (bng-ext-app-v1) --------------------
// Speaks just enough of the protocol that the panel's bridge connects and the
// telemetry streams flow, so recording can be exercised without the game.
function wsFrame(text) {
  var p = Buffer.from(text), len = p.length;
  var head;
  if (len < 126) { head = Buffer.from([0x81, len]); }
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  return Buffer.concat([head, p]);
}
server.on("upgrade", function (req, socket) {
  var key = req.headers["sec-websocket-key"];
  var accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n" +
    "Sec-WebSocket-Protocol: bng-ext-app-v1\r\n\r\n");
  // decode masked client frames so tests can assert what the panel sends
  var inbuf = Buffer.alloc(0);
  socket.on("data", function (chunk) {
    inbuf = Buffer.concat([inbuf, chunk]);
    for (;;) {
      if (inbuf.length < 2) return;
      var len = inbuf[1] & 0x7f, off = 2;
      if (len === 126) { if (inbuf.length < 4) return; len = inbuf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (inbuf.length < 10) return; len = Number(inbuf.readBigUInt64BE(2)); off = 10; }
      var masked = (inbuf[1] & 0x80) !== 0, maskOff = off;
      if (masked) off += 4;
      if (inbuf.length < off + len) return;
      var payload = inbuf.slice(off, off + len);
      if (masked) {
        var mask = inbuf.slice(maskOff, maskOff + 4);
        for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      if ((inbuf[0] & 0x0f) === 1) { // text frame
        var msg = payload.toString();
        if (msg.slice(0, 2) === "PO") { lastPO.count++; lastPO.last = msg.slice(2); }
      }
      inbuf = inbuf.slice(off + len);
    }
  });
  socket.on("error", function () { /* dropped */ });

  var t0 = Date.now();
  var timer = setInterval(function () {
    var t = (Date.now() - t0) / 1000;
    var speedMs = (20 + 15 * Math.sin(t / 4)) ; // m/s
    var rpm = 3000 + 2500 * Math.sin(t / 2.5);
    function wheel(n, load) { return [n, 0.33, 1, speedMs / 0.33, 150 + 100 * Math.sin(t), 0.4 * Math.abs(Math.sin(t * 2)), 0, load, 40, 1500]; }
    var frame = {
      vehicleStreams: { player_0: {
        electrics: {
          wheelspeed: speedMs, airspeed: speedMs * 1.02, rpm: rpm, gearIndex: 3, gear: "3",
          throttle: 0.5 + 0.5 * Math.sin(t / 2), brake: Math.max(0, -Math.sin(t / 2)) * 0.8,
          clutch: 0, steering_input: 0.4 * Math.sin(t / 3),
          watertemp: 85 + 5 * Math.sin(t / 9), oiltemp: 95 + 6 * Math.sin(t / 7),
          fuel: 0.7, engineLoad: 0.6, altitude: 120,
          wheelThermals: {
            FL: { brakeSurfaceTemperature: 180 + 60 * Math.sin(t / 3), brakeThermalEfficiency: 0.98 },
            FR: { brakeSurfaceTemperature: 175 + 60 * Math.sin(t / 3), brakeThermalEfficiency: 0.98 },
            RL: { brakeSurfaceTemperature: 120, brakeThermalEfficiency: 1 },
            RR: { brakeSurfaceTemperature: 122, brakeThermalEfficiency: 1 }
          }
        },
        sensors: { gx2: 3 * Math.sin(t / 1.5), gy2: 2 * Math.sin(t / 2.2), gz2: -9.81, gravity: -9.81,
          roll: 0.03 * Math.sin(t), pitch: 0.02 * Math.sin(t / 1.3), yaw: t / 10 },
        wheelInfo: {
          "0": wheel("FL", 3500 + 800 * Math.sin(t)), "1": wheel("FR", 3500 - 800 * Math.sin(t)),
          "2": wheel("RL", 3900 + 600 * Math.sin(t * 1.2)), "3": wheel("RR", 3900 - 600 * Math.sin(t * 1.2))
        }
      } }
    };
    try { socket.write(wsFrame("S#" + JSON.stringify(frame))); }
    catch (e) { clearInterval(timer); }
  }, 33);
  socket.on("close", function () { clearInterval(timer); });
});

server.listen(8741, function () { console.log("avcp dev server on http://localhost:8741/"); });
