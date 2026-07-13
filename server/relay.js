#!/usr/bin/env node
/* =============================================================================
 * AVCP Remote Relay
 *
 * Pairs a HOSTING AVCP panel (the browser tab on the gaming PC, Settings →
 * Remote Access) with a remote CLIENT (usually a phone) and pumps the game's
 * `bng-ext-app-v1` WebSocket frames between them verbatim. It also statically
 * serves the panel itself, so a phone only ever needs this one domain.
 *
 *   [phone]  ⇄ wss /client ⇄  [this relay]  ⇄ wss /host ⇄  [AVCP tab on PC]
 *                                                              ⇄ ws://localhost:8084 ⇄ [BeamNG]
 *
 * Design rules (read before changing):
 *  - The relay NEVER parses game traffic. Piped frames are opaque.
 *  - Framing on the /host leg: TEXT frames = relay control JSON, BINARY frames
 *    = piped game traffic. On the /client leg everything is game traffic
 *    (the pairing code travels in the connect URL), so no control framing.
 *  - Both sides dial OUT to this server; neither ever learns the other's IP.
 *  - No accounts, no persistence, no frame logging. All state is in-memory
 *    and dies with the session or the process.
 *
 * Session/close codes (also handled in js/remote.js):
 *   4001 invalid or expired pairing code
 *   4002 host disconnected
 *   4003 replaced by a newer client connection
 *   4004 kicked by the host
 *   4005 rate limited / server full
 *
 * Run behind Cloudflare Tunnel (cloudflared) - see README.md. Cloudflare
 * terminates TLS at its edge and the tunnel dials out, so this process speaks
 * plain HTTP/WS on localhost only and no inbound ports are ever exposed.
 * ========================================================================== */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let WebSocketServer;
try { ({ WebSocketServer } = require("ws")); }
catch (e) { console.error("dependency missing - run `npm install` in this folder"); process.exit(1); }

// ------------------------------------------------------------- configuration
const CFG = {
  port: parseInt(process.env.PORT || "8977", 10),
  bind: process.env.BIND || "127.0.0.1",          // cloudflared connects here; 0.0.0.0 only for LAN testing
  panelDir: path.resolve(process.env.PANEL_DIR || path.join(__dirname, "..")),
  maxSessions: parseInt(process.env.MAX_SESSIONS || "500", 10),
  maxSessionsPerIp: parseInt(process.env.MAX_SESSIONS_PER_IP || "4", 10),
  codeTtlMs: parseInt(process.env.CODE_TTL_MIN || "10", 10) * 60000, // unpaired codes rotate after this
  maxPayload: 1 << 20,                            // 1 MiB per frame is far beyond any real game frame
  trustProxy: process.env.TRUST_PROXY === "1",    // read CF-Connecting-IP / X-Forwarded-For (set by cloudflared)
  strictOrigin: process.env.STRICT_ORIGIN !== "0",// /client must come from a page THIS server served
  logIps: process.env.LOG_IPS === "1"             // off by default - no need to store user IPs
};

// ------------------------------------------------------------------ sessions
// code -> { code, host, client, paired, createdAt }
const sessions = new Map();
// bad pairing attempts per IP: ip -> { n, resetAt, blockedUntil }
const badTries = new Map();
const BAD_TRIES_MAX = 10;          // wrong codes per minute before a block
const BAD_TRIES_BLOCK_MS = 600000; // 10 min block

// Unambiguous alphabet (no I/O/0/1), 8 chars = ~40 bits - plenty for codes
// that are rate-limited, short-lived and single-host-bound.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  for (;;) {
    let s = "";
    const b = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % 32];
    if (!sessions.has(s)) return s;
  }
}
function normCode(x) { return String(x || "").toUpperCase().replace(/[^A-Z2-9]/g, ""); }

function ipOf(req) {
  if (CFG.trustProxy) {
    // Cloudflare Tunnel sets CF-Connecting-IP to the true client IP and
    // overwrites any client-supplied value, so it's the trustworthy source.
    // Fall back to X-Forwarded-For for other proxies. Without this, every
    // request behind the tunnel shares cloudflared's loopback address and the
    // per-IP rate limiting silently becomes global.
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}
function ipTag(ip) { return CFG.logIps ? ip : "ip:" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 8); }
function log(msg) { console.log(new Date().toISOString() + " " + msg); }

function hostCountFor(ip) {
  let n = 0;
  for (const s of sessions.values()) if (s.hostIp === ip) n++;
  return n;
}

function ctl(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ------------------------------------------------------------- static server
// Serves the panel to remote clients. Strict allowlist: only the panel's own
// files, never this folder, dotfiles, or anything else in the repo.
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webm": "video/webm", ".json": "application/json",
  ".woff2": "font/woff2", ".ico": "image/x-icon"
};
const STATIC_OK = /^\/(?:index\.html|(?:js|css|media|images)\/[\w .\-()]+(?:\/[\w .\-()]+)*)$/;

const server = http.createServer((req, res) => {
  let urlPath;
  // malformed %-escapes make decodeURIComponent throw; an uncaught throw here
  // kills the whole process (remote DoS) - answer 400 instead
  try { urlPath = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch (e) { res.writeHead(400); res.end("bad request"); return; }
  if (urlPath === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }

  const p = urlPath === "/" ? "/index.html" : urlPath;
  if (!STATIC_OK.test(p) || p.indexOf("..") >= 0) { res.writeHead(404); res.end("not found"); return; }
  const abs = path.join(CFG.panelDir, p);
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
});

// --------------------------------------------------------------- WebSockets
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: CFG.maxPayload,
  // the phone's Bridge connects with the game's subprotocol; echo it back
  handleProtocols: (protocols) => (protocols.has("bng-ext-app-v1") ? "bng-ext-app-v1" : false)
});

server.on("upgrade", (req, socket, head) => {
  let url;
  // absolute-form request lines can make the URL constructor throw; an
  // uncaught throw in this handler also kills the process
  try { url = new URL(req.url, "http://x"); }
  catch (e) { socket.destroy(); return; }
  const route = url.pathname;
  if (route !== "/host" && route !== "/client") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    if (route === "/host") onHost(ws, req);
    else onClient(ws, req, url);
  });
});

// ---- /host: the AVCP panel on the gaming PC ---------------------------------
function onHost(ws, req) {
  const ip = ipOf(req);
  if (sessions.size >= CFG.maxSessions || hostCountFor(ip) >= CFG.maxSessionsPerIp) {
    ws.close(4005, "server full or too many sessions from this address");
    return;
  }
  const s = { code: makeCode(), host: ws, hostIp: ip, client: null, paired: false, createdAt: Date.now() };
  sessions.set(s.code, s);
  ctl(ws, { t: "code", code: s.code });
  log("session " + s.code + " opened (" + ipTag(ip) + ", " + sessions.size + " active)");

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // piped game traffic -> forward to the paired client as TEXT (the game
      // protocol is text frames; the host wraps them binary purely as framing)
      if (s.client && s.client.readyState === 1) s.client.send(data, { binary: false });
      return;
    }
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m && m.t === "kick" && s.client) s.client.close(4004, "kicked by the host");
  });

  ws.on("close", () => {
    sessions.delete(s.code);
    if (s.client) s.client.close(4002, "host disconnected");
    log("session " + s.code + " closed (" + sessions.size + " active)");
  });
  ws.on("error", () => { /* close handler does the cleanup */ });
}

// ---- /client: the phone -----------------------------------------------------
function onClient(ws, req, url) {
  const ip = ipOf(req);

  // pages we didn't serve don't get to pair (defence against random web pages
  // driving the relay from inside someone's browser)
  if (CFG.strictOrigin) {
    const origin = req.headers.origin || "";
    const ok = origin === "https://" + req.headers.host || origin === "http://" + req.headers.host;
    if (!ok) { ws.close(4005, "bad origin"); return; }
  }

  const bt = badTries.get(ip);
  const now = Date.now();
  if (bt && bt.blockedUntil > now) { ws.close(4005, "rate limited - try again later"); return; }

  const s = sessions.get(normCode(url.searchParams.get("code")));
  if (!s) {
    const e = bt && bt.resetAt > now ? bt : { n: 0, resetAt: now + 60000, blockedUntil: 0 };
    e.n++;
    if (e.n >= BAD_TRIES_MAX) { e.blockedUntil = now + BAD_TRIES_BLOCK_MS; e.n = 0; }
    badTries.set(ip, e);
    ws.close(4001, "invalid or expired code");
    return;
  }

  if (s.client) s.client.close(4003, "replaced by a newer client connection");
  s.client = ws;
  s.paired = true; // once paired the code stays valid for this host session (reconnects)
  ctl(s.host, { t: "paired" });
  log("session " + s.code + " paired (" + ipTag(ip) + ")");

  ws.on("message", (data, isBinary) => {
    // phone -> game commands; forward to the host wrapped BINARY (framing)
    if (!isBinary && s.host.readyState === 1) s.host.send(data, { binary: true });
  });
  ws.on("close", () => {
    if (s.client === ws) { s.client = null; ctl(s.host, { t: "unpaired" }); }
  });
  ws.on("error", () => { /* close handler does the cleanup */ });
}

// ------------------------------------------------------- housekeeping timers
// Rotate codes nobody has used within the TTL (host stays connected, just gets
// a fresh code), drop dead sockets, forget old rate-limit entries.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.paired && now - s.createdAt > CFG.codeTtlMs) {
      sessions.delete(s.code);
      s.code = makeCode();
      s.createdAt = now;
      sessions.set(s.code, s);
      ctl(s.host, { t: "code", code: s.code });
    }
  }
  for (const [ip, e] of badTries) {
    if (e.resetAt < now && e.blockedUntil < now) badTries.delete(ip);
  }
}, 60000);

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --------------------------------------------------------------------- start
if (!fs.existsSync(path.join(CFG.panelDir, "index.html"))) {
  console.error("PANEL_DIR (" + CFG.panelDir + ") does not contain index.html - set PANEL_DIR to the panel folder");
  process.exit(1);
}
server.listen(CFG.port, CFG.bind, () => {
  log("AVCP relay listening on " + CFG.bind + ":" + CFG.port +
    " (panel: " + CFG.panelDir + ", trustProxy: " + CFG.trustProxy + ")");
});
