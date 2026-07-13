# AVCP Remote Access relay

This folder is the **server side** of AVCP's Remote Access feature. It is
**not part of the mod zip** — it runs on a server. The official instance
lives at `avcp.malo-interactive.net`, and because the panel's relay endpoint
is a setting (Settings → Remote Access → *Relay server*), anyone can run
their own instance — or re-implement the whole thing from the
[wire protocol](#wire-protocol-for-re-implementers) below — without forking
the mod. The relay does two jobs:

1. **Serves the panel** to remote clients — a phone just opens
   `https://avcp.malo-interactive.net`, nothing to install.
2. **Pairs & relays**: it splices the WebSocket of a hosting panel (the tab on
   the gaming PC, Settings → Remote Access → toggle on) with the remote
   client's WebSocket and pumps the game's `bng-ext-app-v1` frames between
   them verbatim.

```
[phone browser]        [Cloudflare edge]      [your server]         [gaming PC]        [BeamNG]
https://avcp.…  ⇄ wss ⇄  TLS + tunnel  ⇄ wss ⇄  relay.js (cloudflared)  ⇄ wss ⇄  AVCP tab  ⇄ ws://localhost:8084
 enters code                                    pairs + pumps           shows the code    the game
```

Both sides dial **out** to the relay, so no port forwarding is ever needed and
**neither device learns the other's IP** — only the relay sees both, and it
stores nothing.

---

## Pick your setup

| You want | Where it runs | Do this |
|---|---|---|
| Try it / hack on it, this machine only | Windows / macOS / Linux | double-click `start.cmd` · `sh start.sh` |
| Phone on your **own Wi-Fi** — no cloud, no domain, no VPS | the gaming PC itself | `start.cmd lan` · `sh start.sh lan` — see [quick start](#quick-start-on-your-own-pc-windows--macos--linux) |
| A **public** relay with TLS (what the official one is) | a Linux VPS | `run.sh` + Cloudflare Tunnel — see [production setup](#production-setup-public-relay-on-a-linux-vps) |

## Quick start on your own PC (Windows / macOS / Linux)

The relay is one dependency-light Node file; it runs fine on the gaming PC
itself, and for a phone on the same Wi-Fi that is all you need.

1. Install **Node.js ≥ 18** — Windows: `winget install OpenJS.NodeJS.LTS`
   (or the installer from <https://nodejs.org>); macOS/Linux: nodejs.org or
   your package manager.
2. Start the relay:
   - **Windows:** double-click `server\start.cmd` (this-PC-only), or run
     `start.cmd lan` in a terminal to let other devices on your network in.
   - **macOS / Linux:** `cd server && sh start.sh` (or `sh start.sh lan`).

   Either script checks your Node version, installs the one dependency on
   first run, prints the exact URLs for step 3 and 4, and runs the relay in
   the foreground — closing the window stops it; nothing is installed as a
   service.
3. In the panel on the gaming PC: Settings → Remote Access → *Relay server* =
   `ws://127.0.0.1:8977` → toggle on → a pairing code appears.
4. On the phone: open `http://<pc-ip>:8977/?remote=1` (the launcher prints
   this with your real IP filled in) and enter the code.

Worth knowing:

- `?remote=1` marks the device as the **remote** one. It's only needed on
  plain http — on the official https relay the panel detects it by itself.
- LAN mode is plain, unencrypted http **on your own network**. Fine at home;
  do **not** port-forward it to the internet — a public relay is what the
  TLS-terminated production setup below is for.
- Windows Firewall: if the phone can't connect in lan mode, allow TCP 8977
  inbound once — the launcher prints the exact admin-PowerShell one-liner.

## Production setup (public relay on a Linux VPS)

Assumes a small Linux VPS (any 1-vCPU box is plenty — the relay pumps a few
KB/s per session) and that `malo-interactive.net` is already on Cloudflare
(its nameservers point at Cloudflare — same account that fronts the CDN).
Steps use Debian/Ubuntu commands. TLS and the public hostname are handled by
Cloudflare Tunnel (`cloudflared`), so there is **no certificate to manage and
no inbound port to open** — the tunnel dials out.

### Quick path

`server/run.sh` does everything in steps 2–3 for you (creates the `avcp`
service user — the fix for a `status=217/USER` crash loop — installs the
panel to `/opt/avcp`, runs `npm install`, renders the systemd unit with the
right node path, and starts the relay). It's idempotent, so re-run it any
time:

```sh
# from a checkout of the repo on the server:
sudo bash server/run.sh
# ...or, to clone fresh first:
sudo AVCP_REPO=<git-url> bash run.sh
```

Then do the DNS/tunnel steps (1 and 4) below — those need an interactive
Cloudflare login and can't be scripted. The rest of this section is the
manual equivalent of what `run.sh` automates.

### 1. DNS

Nothing to do by hand — the `cloudflared tunnel route dns` command in step 4
creates the `avcp.malo-interactive.net` record automatically (a proxied CNAME
to the tunnel). Running under your own (sub)domain needs no code change at
all: point it in the cloudflared config and have panel users enter
`wss://your.domain` under Settings → Remote Access → *Relay server*. Only a
*fork* that wants its own default touches code — `DEFAULT_RELAY` in
`js/remote.js`. Keep the name short; users type it on a phone.

### 2. Install Node.js (≥ 18) + cloudflared and get the files onto the server

```sh
sudo apt update && sudo apt install -y nodejs npm
# cloudflared (Cloudflare's repo - or grab the .deb from their releases page):
#   https://pkg.cloudflare.com/  →  sudo apt install -y cloudflared
sudo useradd --system --home /opt/avcp avcp
sudo mkdir -p /opt/avcp
# copy the WHOLE panel repo (index.html, js/, css/, media/, server/) to /opt/avcp
# e.g. from your PC:  scp -r ./webcontrolpanel/* user@server:/opt/avcp/
cd /opt/avcp/server && sudo npm install --omit=dev
sudo chown -R avcp:avcp /opt/avcp
```

The relay serves the panel from the folder **above** `server/` by default
(`PANEL_DIR`), so mod and website are the same files — update one, both move.

### 3. Run it as a service

```sh
sudo cp /opt/avcp/server/avcp-relay.service.example /etc/systemd/system/avcp-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now avcp-relay
journalctl -u avcp-relay -f    # should log "AVCP relay listening on 127.0.0.1:8977"
```

### 4. Expose it via Cloudflare Tunnel (cloudflared)

The relay listens only on `127.0.0.1:8977`. Cloudflare terminates TLS at its
edge and the tunnel dials out to reach the relay, so nothing on the box is
publicly reachable and there is no certificate to manage.

```sh
sudo cloudflared tunnel login                       # opens a browser link; pick the malo-interactive.net zone
sudo cloudflared tunnel create avcp-relay           # writes /root/.cloudflared/<TUNNEL_ID>.json
sudo cloudflared tunnel route dns avcp-relay avcp.malo-interactive.net

# drop in the ingress config (fill in <TUNNEL_ID> from the create step)
sudo mkdir -p /etc/cloudflared
sudo cp /opt/avcp/server/cloudflared-config.yml.example /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml

# run it as a service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Firewall: the tunnel is **outbound only**, so you can leave all inbound ports
closed (keep just your SSH port). Port `8977` stays on loopback and is never
exposed. In the Cloudflare dashboard, make sure **WebSockets** are enabled
(Network tab — on by default) and, if you use it, that a Cloudflare **WAF**
rule isn't blocking the `/host` or `/client` upgrade requests.

### 5. Verify

- `https://avcp.malo-interactive.net/healthz` → `ok`
- `https://avcp.malo-interactive.net/` → the panel loads and shows the
  **pairing-code screen** (it detects it was served over https and enters
  client mode).
- On the gaming PC: open the panel from the game's server as usual
  (`http://localhost:8084/ui/webcontrolpanel/index.html`), Settings →
  **Remote Access** → toggle on → a code appears.
- Enter the code on the phone → the dashboard connects.

---

## Configuration reference (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8977` | HTTP/WS listen port |
| `BIND` | `127.0.0.1` | Listen address. Keep loopback (cloudflared connects here); `0.0.0.0` only for LAN testing |
| `PANEL_DIR` | `..` (repo root) | Folder containing the panel's `index.html` |
| `MAX_SESSIONS` | `500` | Total concurrent host sessions |
| `MAX_SESSIONS_PER_IP` | `4` | Host sessions per source IP |
| `CODE_TTL_MIN` | `10` | Unused pairing codes rotate after this many minutes (host just gets a fresh one) |
| `TRUST_PROXY` | off | **Set `1` behind Cloudflare Tunnel** so rate limiting sees real client IPs (reads `CF-Connecting-IP`, then `X-Forwarded-For`). Without it, every request looks like it comes from cloudflared and the per-IP limits become global |
| `STRICT_ORIGIN` | on | `/client` connections must originate from a page this server served. Set `0` only for local testing |
| `LOG_IPS` | off | Log raw IPs instead of a truncated hash. Leave off — you don't need them |

## How pairing works

- Host toggles Remote Access on → panel dials `wss://…/host` → relay replies
  with an 8-character code (`ABCD-EFGH`, unambiguous alphabet, ~40 bits).
- Codes are **rate-limited** (10 wrong guesses/min per IP → 10-min block),
  rotate every `CODE_TTL_MIN` while unused, and are bound to exactly one host
  session.
- Client connects `wss://…/client?code=…` → relay splices the two sockets.
  After first pairing the code stays valid **for that host session only**, so
  a phone that drops off Wi-Fi reconnects without retyping; a second client
  with the same code replaces the first (close code 4003).
- Host toggles off / closes the tab → session and code die instantly; the
  client is disconnected (4002). The host can also kick the client (4004).
- The relay pings both legs every 30 s and reaps dead sockets. This also
  keeps an idle (paired-but-quiet) connection under Cloudflare's ~100 s
  WebSocket idle timeout — don't raise the ping interval past ~90 s.

## Wire protocol (for re-implementers)

Everything needed to write a compatible relay (or client) without reading
`relay.js`. Transport is standard WebSocket over HTTPS/WSS.

**`GET /healthz`** → `200 ok` (plain HTTP, for monitoring).

**`GET /<panel files>`** — optional: serving the panel statically is a
convenience so phones need only one domain. A relay that skips this must set
`STRICT_ORIGIN=0` semantics accordingly (see below) and host the panel
elsewhere.

**`/host` (WebSocket, no subprotocol)** — dialed by the hosting panel:

| Direction | Frame type | Meaning |
|---|---|---|
| relay → host | TEXT | control JSON: `{"t":"code","code":"ABCDEFGH"}` (assigned pairing code, resent on rotation), `{"t":"paired"}`, `{"t":"unpaired"}` |
| host → relay | TEXT | control JSON: `{"t":"kick"}` (disconnect the client with 4004) |
| host → relay | BINARY | one game frame (UTF-8 text of a `bng-ext-app-v1` message), forwarded to the client verbatim as a TEXT frame |
| relay → host | BINARY | one client→game frame; the host unwraps it and sends it to the game as TEXT |

The TEXT/BINARY split on this leg **is** the framing: control vs. piped
traffic. There is no other envelope.

**`/client?code=<code>` (WebSocket, subprotocol `bng-ext-app-v1`)** — dialed
by the remote device's Bridge. The relay must echo the subprotocol. Every
frame both ways is pure game traffic (TEXT); the code travels only in the
connect URL. Codes are normalized `[A-Z2-9]`, 8 chars.

**Close codes** (relay-intent range, both legs):

| Code | Meaning |
|---|---|
| 4001 | invalid or expired pairing code |
| 4002 | host disconnected |
| 4003 | replaced by a newer client connection |
| 4004 | kicked by the host |
| 4005 | rate limited / server full / bad origin |

Behavioural contract: one client per session (new client with a valid code
replaces the old one, 4003); codes rotate while unpaired (TTL) but survive
client drop-outs once paired; the session dies with the host socket; the
relay pings both legs (~30 s) and must never parse, log, or persist piped
frames.

## Official relay status file

The panel shows an outage notice for the **official** relay from a
plain-text status file on the CDN
(`https://cdn.boykisser.cloud/malo-interactive/avcp-cdn/wss-status.txt`):

```
STATUS=UP|DOWN
REASON=<one human-readable line, optional>
```

`STATUS=DOWN` marks the Remote Access card in Settings as down (with the
reason, if one is given). The check runs only when the user opens the
Settings tab, is skipped entirely when a custom *Relay server* is configured
(the file says nothing about *your* relay), and never blocks the toggle —
it's a notice, not a kill switch. Self-hosters need nothing here; if you fork
the panel you can point `STATUS_URL` in `js/remote.js` at your own file, or
remove it.

## Security model (what the relay can and cannot do)

- **TLS on both public legs** (Cloudflare edge → tunnel). The only plaintext
  hops are `localhost` on the gaming PC and the loopback hand-off from
  cloudflared to the relay on the server — neither leaves its machine.
- **IP privacy**: host and client only ever connect to the relay; neither
  sees the other's address. The relay logs hashed IP prefixes only (unless
  `LOG_IPS=1`).
- **No storage**: sessions are in-memory; frames are pumped, never parsed or
  logged; there are no accounts, cookies or databases.
- **Be honest about the capability**: a paired client can send Lua to the
  host's game — the same capability the local panel has. That's the feature.
  The mitigations are: opt-in toggle (off by default, never persisted),
  visible "client connected" state + kick button on the host, one client at a
  time, rate-limited short codes, and sessions that die with the tab.
- The relay process needs no privileges; the systemd unit ships with
  filesystem hardening enabled.
- **Open source does not weaken any of this.** There is nothing to
  reverse-engineer *for*: the code contains no secrets, no keys, no hidden
  endpoints, and no security-through-obscurity. Everything an attacker could
  learn from this source they could also learn from the (deliberately
  readable) `js/remote.js` in the mod. Security rests on properties that
  survive full disclosure: pairing codes are 40 bits of CSPRNG output,
  short-lived, single-session, and rate-limited (10 wrong guesses/min per IP
  → 10-min block, so brute force needs ~10⁵ years in expectation); browser
  pages can't drive `/client` cross-origin (`STRICT_ORIGIN`); sessions are
  capped globally and per IP; frames are size-capped; and the host user sees
  and controls every pairing. If you modify the relay, keep those five
  properties — they are the security model. Do **not** "protect" a fork by
  obfuscating it; that only gets a mod flagged by reviewers while stopping
  nobody.

## BeamNG forum / repository disclosure

Suggested wording for the mod page (mirrors the existing CDN disclosures in
the main README's moderator section, which also lists this feature):

> **Remote Access (opt-in):** Settings → Remote Access lets you view and
> control *your own* panel from another device (e.g. your phone) through a
> relay at `avcp.malo-interactive.net`. It is **off by default**, starts only
> when you toggle it on, shows a pairing code that you must enter on the other
> device, and ends the moment you toggle it off or close the tab. The relay
> forwards the panel's existing WebSocket traffic and stores nothing — no
> accounts, no telemetry, no game-file access. The mod itself contains no
> server code; this folder (`server/`) is published for transparency and is
> not part of the mod zip.

Keep the feature **off by default**, keep the relay client code
(`js/remote.js`) readable/unminified, and mention the endpoint in the mod
description — that matches how the gallery/CDN fetches were cleared with the
moderators.

## Local testing (no TLS, no game needed for the relay itself)

Covered by the [quick start](#quick-start-on-your-own-pc-windows--macos--linux)
launchers above. Extras worth knowing for development:

- The pairing flow works without BeamNG running — "host" and "client" can be
  two tabs of the same browser (`?remote=1` forces client mode).
- `STRICT_ORIGIN=0` is only needed when the client *page* is served from a
  different origin than the relay (e.g. a separate dev server). Pages the
  relay serves itself pass the origin check as-is, LAN mode included.
- Clear the *Relay server* field in Settings to go back to the official relay
  (the value is stored as `avcp.relayUrl` in localStorage).

## Updating

The panel files the relay serves are the same files in the repo — `git pull`
(or re-copy) in `/opt/avcp`, done; no restart needed for panel files. Restart
`avcp-relay` only when `server/relay.js` itself changes. Active sessions drop
on restart; hosts auto-retry and re-show a code.
