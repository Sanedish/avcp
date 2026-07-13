# Luna Mattins AVCP - Advanced Vehicle Control Panel

A remastered, browser-based control panel & live-telemetry dashboard for
**BeamNG.drive**. It replaces the broken experience you get when opening the
game's internal `main` UI in a normal web browser with a purpose-built,
phone-friendly cockpit.

| | |
|---|---|
| **Mod name** | Luna Mattins AVCP |
| **DB id** | `lunamattinsavcp` |
| **Type** | UI mod (additive, HTML/CSS/JS only - no Lua extension, no native code) |
| **Version** | shown in the app header (e.g. `v0.2`) |
| **Dependencies** | none - dependency-free vanilla JS |
| **Runs** | client-side in your browser, talking to the game over its own WebSocket |

> **It runs in your browser, not in the game.** Open it on the **same machine**
> the game is running on:
>
> ```
> http://localhost:8084/ui/webcontrolpanel/index.html
> ```
>
> `8084` is the game's external-UI server port. If you changed it, use yours.
> Works in any modern desktop or mobile browser, and in the game's own CEF view.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Features](#features)
3. [Data Lab - telemetry recorder & analyzer](#data-lab--telemetry-recorder--analyzer)
4. [For BeamNG repository moderators](#for-beamng-repository-moderators)
5. [Project layout](#project-layout)
6. [How it works - the bridge](#how-it-works--the-bridge)
7. [Customizing the UI](#customizing-the-ui)
   - [Edit & hot-reload workflow](#edit--hot-reload-workflow)
   - [Theming with CSS variables](#theming-with-css-variables)
   - [Adding a tab](#adding-a-tab)
   - [Adding a button / action](#adding-a-button--action)
   - [Reading telemetry (streams)](#reading-telemetry-streams)
   - [The render loop & performance rules](#the-render-loop--performance-rules)
   - [Fullscreen & responsive layout](#fullscreen--responsive-layout)
8. [Bridge API reference](#bridge-api-reference)
9. [BeamNG Lua cookbook](#beamng-lua-cookbook)
10. [Packaging as a mod](#packaging-as-a-mod)
11. [Distribution / uploading to the repository](#distribution--uploading-to-the-repository)
12. [Troubleshooting](#troubleshooting)
13. [Known limitations](#known-limitations)
14. [Uninstall](#uninstall)
15. [Credits & license](#credits--license)

---

## Quick start

1. Make sure the loose files live at
   `<userfolder>/ui/webcontrolpanel/` **or** the packaged zip is in
   `<userfolder>/mods/` (see [Packaging](#packaging-as-a-mod)).
   - `<userfolder>` is typically
     `C:\Users\<you>\AppData\Local\BeamNG\BeamNG.drive\<version>\`.
2. Launch BeamNG.drive.
3. Open `http://localhost:8084/ui/webcontrolpanel/index.html` in a browser on the
   same PC (or your phone - see below).
4. The connection dot (top-right) turns green when the bridge attaches.

**Using your phone:** find your PC's LAN IP (e.g. `192.168.1.20`) and open
`http://192.168.1.20:8084/ui/webcontrolpanel/index.html`. Both devices must be on
the same network, and your firewall must allow inbound `8084`. The UI is fully
responsive and touch-friendly.

---

## Features

| Tab | What it does |
|---|---|
| **Dashboard** | Live speedo & tach, gear, G-force meter with trail, throttle/brake/clutch/steering bars, warning indicators (signals, lights, ABS, TCS, ESC, low fuel…), speed/RPM history, per-wheel speed & slip, raw-telemetry table. |
| **Vehicle** | Recover / repair / reset / reload, lights / signals / horn, ignition & shifting, spawn / replace / delete vehicles. |
| **World** | Time of day (slider + presets + time flow), simulation speed, gravity presets, camera modes, fog / clouds / wind. |
| **Chaos** | Instant physics triggers (ignite, extinguish, deflate tyres, break hinges/breakgroups, repair), interactive time-dilation + hold-to-slow-mo, gravity matrix. |
| **AI & Traffic** | Per-vehicle AI behaviour matrix, quick-spawn grid (traffic / police patrol / police chase / demolition derby / clear), Chaos-Factor slider, player AI mode/aggression/target-speed. |
| **Statistics** | Session top speed, max RPM, max lateral/longitudinal G, 0–100 km/h & 0–60 mph timers, distance, odometer, vehicle info. |
| **Data Lab** | Telemetry recorder (full "extensive" channel set or per-category, 1–60 Hz, markers), a recording library persisted in the browser with CSV / JSON export + JSON import, and a multi-channel analyzer: overlay & per-channel lane graphs, wheel zoom + minimap, data cursor with interpolated readouts, per-channel min/avg/max, and a playback transport (0.25–4×, loop) that can **replay a take onto the live dashboard gauges**. |
| **Diagnostics** | Thermals (coolant, oil, turbo boost, load, fuel), per-wheel brake temps + thermal-efficiency fade **and brake power in kW / kN**, live powertrain-flow node diagram. |
| **Suspension** | Chassis load map (per-corner vertical load), damper bump/rebound activity bars, per-corner load-history graph, roll/pitch/vertical-G attitude. |
| **Console** | Run arbitrary Lua in the game-engine or active-vehicle VM and see the returned value. |

Every card has a **maximize button** (⛶) to expand it full-screen; press `Esc`,
click the backdrop, or the button again to exit.

On the very first launch the panel plays a short intro video (portrait or
landscape cut depending on your screen). Click anywhere to skip it; Settings →
*Intro video* disables it permanently or replays it on demand.

### Customization (Settings tab)

- **Layout editor** - hide and re-order every card on every tab (drag, or the
  ◀ ▶ arrows on touch). Layouts persist per tab and self-heal across updates:
  if a new version changes a tab's card set, that tab quietly resets instead
  of scrambling.
- **Per-quantity units** - speed, temperature, distance and **pressure
  (psi / bar / kPa)** are set independently; the Metric/Imperial buttons stay
  as one-tap presets. km/h with boost in bar? Go ahead.
- **Driving alerts** - a shift light that flashes the screen edges at your
  configured redline, and an overspeed warning with a unit-aware threshold.
  Purely visual; nothing is sent to the game.
- **Profiles** - save the entire setup (theme, units, gauges, background &
  glass, layout, alerts, scale, startup tab) under a name, switch between
  them, and export/import them as JSON to share.
- **Custom CSS** - a built-in editor for your own stylesheet, applied on top
  of the panel's. Persisted locally, carried inside profiles, and toggleable
  with one click if a rule misbehaves. Theme tokens (`--accent`, `--data`, …)
  are overridable with `!important`.
- **Online gallery** - optional, user-triggered: browse curated backgrounds
  and profiles from the Malo Interactive CDN and apply them with one click.
  Nothing is fetched until you press *Browse*. Themes are deliberately local
  (presets + custom colours); to share a look, share a profile.
- **Remote Access** - opt-in: control your own panel from a phone through a
  pairing relay. The relay endpoint is a setting, so you can point it at a
  self-hosted instance (full server + guide in `server/`); the card shows a
  notice if the official relay is down.
- **Interface** - whole-panel UI scale (80–130 %) and a startup-tab choice,
  plus the existing themes, custom colours, backgrounds, glassmorphism and
  per-gauge configuration.

---

## Data Lab - telemetry recorder & analyzer

The Data Lab tab is the panel's data-extraction toolkit for mod authors,
vehicle-config tuners and anyone who likes graphs:

- **Record** the live streams into named channels at 1–60 Hz. Channel
  categories: *Driver inputs*, *Powertrain*, *Dynamics*, *Thermals*, *Brakes*
  (per-wheel temps & fade) and *Wheels & tires* (per-wheel speed / slip /
  vertical load / drive & brake torque - channel lists adapt to the actual
  wheel count). Record everything, or narrow the scope for long sessions.
- **Markers** can be dropped mid-take with the ⚑ button or the `M` shortcut -
  flag a corner entry, a landing, a dyno pull - and show up in the graph.
- **Library**: a take auto-saves on stop into the browser's IndexedDB
  (sandboxed; never a game-file write). Export as **CSV** (wide table, opens in
  any spreadsheet/analysis tool) or **JSON**; JSON re-imports losslessly so
  takes can be shared.
- **Analyzer**: overlay all channels or stack one scaled lane per channel
  (data-logger style); min/max-binned rendering stays alias-free at any zoom;
  mouse-wheel zooms around the pointer, the minimap strip pans, the cursor
  reads out interpolated values for every visible channel, and a stats table
  shows per-channel min / avg / max.
- **Playback**: a transport with 0.25–4× speed and loop. Switch on **Drive
  dashboard** and the recorded values are fed back into the panel's shared
  telemetry state - the real speedo, tach, pedals and G-meter replay the take
  (live telemetry is ignored until you switch it back off).
- **Actuate vehicle**: replays the recorded *driver inputs* - throttle, brake,
  clutch, steering, handbrake and gear - into the real car while playing, via
  `input.event(…, FILTER_DIRECT)` in the vehicle VM (gear goes through the
  vehicle's own controller, so automatics/DCTs shift exactly as recorded).
  Recording **while** actuating is allowed on purpose: replay a baseline run
  on a modified setup and capture the response for a true A/B comparison.

### Quirks & gotchas (worth reading once)

- **The sample rate is a ceiling, not a promise.** Sampling rides on the
  game's external-UI stream cadence, which BeamNG pushes at roughly 15–20 Hz
  over the WebSocket. Setting 20 Hz typically nets ~16–17 Hz effective; the
  time axis is always exact regardless, because every sample stores its real
  timestamp.
- **Actuation is open-loop input replay, not a position-locked ghost.** Start
  from the same spot with the same vehicle/config and the run reproduces
  closely, but soft-body physics divergence accumulates - expect drift on long
  takes. Repair/reset the vehicle and replay from the start for best results.
- **Actuation overrides your controller** (~20 inputs/s) while playing. The
  moment you pause, stop, or the take ends, throttle/brake/steering/clutch are
  zeroed and control is handed straight back - the car *keeps rolling*; brake
  yourself. The handbrake is left wherever the recording last put it.
- **Gear replay needs the Powertrain category** in the recording, and inputs
  replay needs Driver inputs - takes recorded without those categories
  actuate whatever channels they do have.
- **Replaying onto a different vehicle is allowed** (it's sometimes exactly
  what you want - same inputs, different chassis) but obviously won't
  reproduce the original motion.
- **Yaw wraps at ±180°** - the sawtooth jumps in the yaw graph when you drive
  through south are real data, not a glitch.
- **Drive dashboard mutes live telemetry by design**; turning on Actuate
  switches Drive dashboard off automatically so the gauges show the car's
  *real* response to the replayed inputs.
- **Wheel & tire channels are graph-only** during Drive-dashboard replay (the
  dashboard's wheel tiles hold their last live values).

---

## For BeamNG repository moderators

This section summarizes everything relevant to a content review. The whole mod is
plain text (HTML/CSS/JS) and can be read top-to-bottom in a few minutes.

**Compliance checklist**

- ✅ **Additive only.** Adds files exclusively under `ui/webcontrolpanel/`. It
  does **not** modify, patch, replace, or shadow any original game file.
- ✅ **Does not override `ui/entrypoints/main`** (or any stock entrypoint), so the
  in-game CEF UI is untouched.
- ✅ **No game-file writes.** The mod never writes, patches, or mutates any
  BeamNG file or game setting; it runs read-only straight from the zip. It does
  use the browser's own sandboxed **localStorage** (panel preferences - theme,
  units, gauge config, intro-seen flag, etc.) and **IndexedDB** (a custom
  background image if the user picks one, and Data Lab telemetry recordings).
  All of it lives in the browser / in-game CEF profile, **not** in game files,
  and is wiped by clearing the browser cache. No cookies, no network storage.
- ✅ **No Lua extension / no `modScript`.** Nothing auto-loads or executes on game
  start. The mod is inert until a user opens the page in a browser.
- ✅ **No native code, no executables shipped to the game.** Only `.html`, `.css`,
  `.js`. (`package-mod.ps1` is a build-time helper for the author and is **not**
  part of the mounted mod / not executed by the game.)
- ✅ **No bundled game assets.** The header logo is *referenced* from the stock
  `/ui/images/beamng_logo_50x50.png`; if absent it falls back to a glyph. No
  copyrighted game asset is redistributed. Images under `images/` (e.g. credits
  avatars) are supplied by the author.
- ✅ **No analytics / phone-home / external libraries.** The panel's working
  connection is a WebSocket to the **game's own** external-app server on the
  page's host:port (`bng-ext-app-v1`). Nothing about the user or the session is
  ever sent anywhere. Full disclosure - there are exactly **four** narrowly
  scoped external connections, all inert until reached:
  1. The **Credits tab** embeds Discord's standard server widget in a sandboxed
     `<iframe>` (loads from discord.com only when that tab is opened).
  2. The **first-launch intro video** is bundled locally under `media/`; only
     if those files are missing or the host refuses to serve them does the
     panel fall back to streaming the same files once from the Malo Interactive
     CDN (`cdn.boykisser.cloud`). After the first launch the intro never runs
     again unless replayed manually, and it can be disabled outright in
     Settings.
  3. The **online gallery** (Settings) downloads a manifest of backgrounds and
     profiles from the same Malo Interactive CDN - but only when the user
     explicitly presses *Browse*, and applied backgrounds are displayed
     straight from their URL (never stored). No automatic checks, no update
     pings. (The user-authored **Custom CSS** setting can reference external
     URLs, like any stylesheet - that is user content, not something the mod
     ships or fetches.)
  4. **Remote Access** (Settings) is a strictly **opt-in** toggle - OFF by
     default, never persisted across sessions - that lets the user view and
     control *their own* panel from another device (e.g. a phone) through a
     pairing relay at `avcp.malo-interactive.net` **or a self-hosted relay**
     (the endpoint is a plain setting; the full server plus a self-hosting
     guide and wire-protocol spec ship in this repo under `server/`). Nothing
     connects until the toggle is turned on; it shows a pairing code, the user
     enters it on the other device, and everything stops the moment the toggle
     goes off or the tab closes. The relay forwards the panel's existing
     WebSocket frames verbatim and stores nothing (no accounts, no logs of
     traffic). The mod zip itself contains no server code (`js/remote.js` is
     the plain-JS client, human-readable like everything else). One auxiliary
     fetch belongs to this feature: when the user opens the **Settings tab**,
     the panel reads a small plain-text status file from the Malo Interactive
     CDN to warn if the official relay is down (`STATUS=`/`REASON=` lines,
     rendered as text). It sends nothing, runs only on that user action, and
     is skipped entirely when a custom relay is configured.
- ✅ **No obfuscation / no minification.** Source is original and human-readable.

**Capabilities to be aware of (full disclosure)**

- The **Console** tab and many buttons send Lua to the game over the
  `bng-ext-app-v1` protocol - the *same capability the stock external-app UI
  already exposes*. This protocol is only reachable from the machine running the
  game (and any LAN client the user deliberately allows through their firewall).
  The mod does not open ports or escalate privileges; it is a **client** to a
  server BeamNG itself runs. Disabling the external-app server in-game disables
  this mod entirely.
- **Remote Access** (disclosure item 4 above) extends that reach to one remote
  device *only* while the user has the toggle on and has shared the pairing
  code - the same trust decision as reading out a remote-desktop code. The
  host panel shows a persistent "client connected" state with a kick button,
  allows exactly one client, and both legs of the connection are TLS via the
  relay; neither device learns the other's IP.

---

## Project layout

```
ui/webcontrolpanel/
├── index.html          # markup: top bar, tab buttons, one <section> per page
├── css/
│   └── style.css        # all styling + theme tokens + responsive + fullscreen
├── js/
│   ├── settings.js      # persisted prefs: themes, units, gauges, appearance
│   ├── splash.js        # first-launch intro video (one-shot, user-disableable)
│   ├── bridge.js        # WebSocket bridge: Lua calls, streams, hooks, callbacks
│   ├── remote.js        # opt-in Remote Access: relay pairing (host + client roles)
│   ├── gauges.js        # dependency-free canvas widgets (Gauge, GMeter, Chart, bar)
│   ├── customize.js     # layout editor, profiles, alerts, online gallery, scale
│   ├── datalab.js       # telemetry recorder, library (IndexedDB) & analyzer
│   └── app.js           # wires the bridge to widgets, tabs, actions, console
├── images/              # author-supplied art (credits PFPs, icons) - auto-bundled
├── media/               # intro splash videos (16:9 + 9:16) + credits art - auto-bundled
├── server/              # Remote Access relay (self-hostable; NOT in the mod zip)
├── package-mod.ps1      # build script → LunaMattinsAVCP.zip (author tool only)
└── README.md            # this file
```

Separation of concerns:

- **`bridge.js`** knows nothing about the UI - it only speaks the protocol.
- **`gauges.js`** knows nothing about BeamNG - reusable canvas drawing.
- **`settings.js`** owns persistence (localStorage via `AVCP.Store` + the
  background-image IndexedDB) and the theme/unit system.
- **`splash.js`** is fully self-contained; delete the file and the intro is gone.
- **`datalab.js`** only reads/writes browser storage and the shared telemetry
  state handed to it by `app.js` - it never speaks Lua itself.
- **`app.js`** is the glue: subscribes to streams, builds buttons, renders tabs.

---

## How it works - the bridge

The panel speaks BeamNG's documented `bng-ext-app-v1` WebSocket protocol (the same
channel the stock external UI uses), re-implemented from scratch in `bridge.js`.

**Outbound message prefixes**

| Prefix | Meaning |
|---|---|
| `GL` | run Lua in the **game-engine** VM |
| `PO` | run Lua in the **active vehicle** VM |
| `PB` | run Lua in **all** vehicle objects |
| `SE` | subscribe to telemetry streams (`{vehicles:[{byPlayerId:0,streams:[…]}]}`) |

**Inbound message prefixes**

| Prefix | Meaning |
|---|---|
| `H#` | hooks (events), incl. `onBNGAPICallback` return values |
| `S#` | stream data frames |
| `I#` | base info about the running game |

Return values are obtained by asking the engine to fire the `onBNGAPICallback`
hook with a request id; the bridge resolves a `Promise` when that id comes back.

---

## Customizing the UI

You don't need a build step or any tooling - it's hand-written HTML/CSS/JS.

### Edit & hot-reload workflow

1. Work on the **loose** copy in `<userfolder>/ui/webcontrolpanel/`. The game's
   web server serves this folder overlay automatically - no repackaging needed
   while developing.
2. Edit a file, **refresh the browser** (`Ctrl`+`F5` to bust the cache). That's
   the whole loop. The game does not need restarting for UI edits.
3. When happy, run `package-mod.ps1` to fold your changes into the zip.

> If you have **both** the loose folder and the mod zip installed, remove one -
> otherwise the files are mounted twice and you may load a stale copy.

### Theming with CSS variables

All colours, radii, and motion live as custom properties in `:root` at the top of
`css/style.css`. Change these and the whole UI re-themes:

```css
:root{
  --bg:#0c1014;          /* page background        */
  --surface:#141a22;     /* card background        */
  --surface-2:#10151c;   /* inset surfaces         */
  --field:#0b0f15;       /* inputs / console       */
  --line:#222b37;        /* hairline borders       */
  --txt:#e9eef4;         /* primary text           */
  --dim:#8d9aa9;         /* secondary text         */
  --accent:#ff7a18;      /* brand / actions (orange)*/
  --data:#3cc6ff;        /* live data (cyan)       */
  --ok:#34d058; --warn:#ffd21a; --bad:#ff4d4d;
  --r-md:10px; --r-lg:14px; --r-pill:999px;
  --ease:cubic-bezier(.4,0,.2,1); --dur:.15s;
}
```

### Adding a tab

1. **Markup** - add a button to the nav and a page section in `index.html`. The
   page id must be `page-` + the button's `data-tab`:

   ```html
   <button class="tab" data-tab="mytab">My Tab</button>
   <!-- … -->
   <section class="page" id="page-mytab">
     <div class="grid">
       <div class="card">
         <div class="card-h">My Card</div>
         <div class="btn-grid" id="myButtons"></div>
       </div>
     </div>
   </section>
   ```

2. Tab switching is wired **automatically** by the generic handler in `app.js`
   (it shows `#page-<data-tab>` and hides the rest). No JS needed just to switch.

3. The maximize button is auto-injected into every `.card` at boot, so your new
   cards get full-screen support for free.

### Adding a button / action

`app.js` provides helpers. `buildButtons(containerSelector, defs)` fills a grid:

```js
buildButtons("#myButtons", [
  { label: "Repair",      primary: true, fn: aoLua("beamstate.reset()") },
  { label: "Ignite",      cls: "danger big", fn: aoLua("fire.igniteVehicle()") },
  { label: "Set noon",    fn: geLua("core_environment.setTimeOfDay({time=0.5})") },
  { label: "Custom",      fn: function(){ br.engineLua("print('hi')"); toast("sent"); } },
]);
```

- `aoLua(cmd)` → returns a handler that runs `cmd` in the **active vehicle** and
  toasts.
- `geLua(cmd)` → same for the **game engine**.
- Button option flags: `primary` (accent fill), `big` (large), `cls` (extra
  classes such as `danger`, `ok`, `big`).
- `toast("message")` shows a transient notification.

For sliders/inputs, just `addEventListener("input", …)` and call
`br.engineLua(...)` / `br.activeObjectLua(...)` with the value interpolated.

### Reading telemetry (streams)

Subscribe once (the panel already subscribes to the common ones on connect), then
read from the shared `T` state inside the render loop. To add a stream:

```js
br.addStreams(["electrics", "sensors", "wheelInfo"]);   // ref-counted
br.on("streams", function (s) {
  if (s.electrics) T.electrics = s.electrics;
});
```

**Available streams** (the only ones the game produces): `electrics`,
`engineInfo`, `wheelInfo`, `sensors`, `stats`, `environment`,
`genericGraphAdvanced`.

**`electrics`** - large object of vehicle values. Common keys:
`rpm`, `maxrpm`, `idlerpm`, `wheelspeed`, `airspeed`, `gear`, `gearIndex`,
`throttle`, `brake`, `clutch`, `clutchRatio`, `steering`, `fuel`, `fuelVolume`,
`watertemp`, `oiltemp`, `turboBoost`/`boost`, `engineLoad`, `driveshaft`,
`mode4WD`, `parkingbrake`, `signal_L`, `signal_R`, `abs`, `tcsActive`,
`escActive`, `lights_state`, `odometer`, and
`wheelThermals` → `{FL,FR,RL,RR:{brakeCoreTemperature, brakeSurfaceTemperature,
brakeThermalEfficiency}}`.

**`engineInfo`** - array; `[1]` = max RPM, `[4]` = current RPM.

**`sensors`** - `gx2`/`gy2`/`gz2` (smoothed accel, m/s²), `roll`/`pitch`/`yaw`
(radians), `gravity`, `position`.

**`wheelInfo`** - an **object keyed numerically** (not a plain array). Each row is
an array; **0-based JS indices**:

| idx | field | idx | field |
|---|---|---|---|
| 0 | name (`"FL"`…) | 5 | lastSlip |
| 1 | radius (m) | 6 | _(deprecated, 0)_ |
| 2 | wheelDir | 7 | **downForce** (N, vertical load) |
| 3 | angularVelocity (rad/s) | 8 | **brakingTorque** (N·m, applied now) |
| 4 | propulsionTorque (N·m) | 9 | brakeTorque (N·m, max capacity) |

Handy derivations: brake power `= |brakingTorque| · |angularVelocity|` (W);
brake force `= brakingTorque / radius` (N); wheel speed
`= |angularVelocity · radius|` (m/s).

### The render loop & performance rules

`app.js` runs one `requestAnimationFrame` loop. **Follow these rules or the panel
will lag in real browsers** (the in-game CEF / headless previews throttle rAF and
hide the cost, so always test in a real browser):

- **Only render the active tab.** Each tab's draw is gated behind
  `if ($("#page-<tab>").classList.contains("active"))`. Don't draw hidden widgets.
- **Throttle DOM rebuilds.** Rebuilding `innerHTML` 60×/s forces reflow. Use a
  frame counter (e.g. `if (histAccum % 3 === 0)`) for list rebuilds; keep only
  smooth canvas gauges at full rate.
- **No per-frame `ctx.shadowBlur`** - it's extremely expensive, especially on
  high-DPI screens.
- Canvas widgets read `clientWidth`/`clientHeight` and re-fit each draw, so they
  resize correctly on layout/fullscreen changes automatically.

### Fullscreen & responsive layout

- **Grid:** a 12-column grid; cards use `grid-column: span N`. On phones (≤680px)
  everything spans the full 12 (full width). **Do not shrink the grid to 6
  columns** - items still spanning 12 then create broken implicit tracks.
- **Body is a flex column** (`topbar` + scrollable `#main`), so the layout stays
  correct even when the top bar wraps to two rows on mobile.
- **Maximize:** every `.card` gets a JS-injected `.maxbtn`; toggling adds
  `.card.maximized` (`position:fixed`) + a backdrop.
- **Gotcha:** a `transform` on **any ancestor** makes `position:fixed` resolve
  against that ancestor instead of the viewport, which breaks maximize. Keep
  page-transition animations **opacity-only** (see `@keyframes fade`). Use
  `visibility` (not just opacity) to hide the backdrop so a frozen transition can
  never leave a stuck full-screen dim.

---

## Bridge API reference

`var br = new Bridge();` then `br.connect();`

**Fire-and-forget Lua**

```js
br.engineLua("core_environment.setGravity(-1.62)");   // GL - engine VM
br.activeObjectLua("electrics.toggle_lights()");        // PO - active vehicle VM
br.queueAllObjectLua("recovery.recoverInPlace()");      // PB - all vehicles
```

**Lua with a return value → `Promise`**

```js
br.engineLuaCb("core_vehicles.getCurrentVehicleDetails()").then(d => { … });
br.activeObjectLuaCb("electrics.values.rpm").then(rpm => { … });
```

> The active-vehicle callback works because `guihooks` does **not** exist in the
> vehicle VM, so `bridge.js` evaluates the expression in the vehicle, then bounces
> the `serialize()`d result through the engine VM (which can fire
> `onBNGAPICallback`). Numbers, strings, and nested tables all round-trip as JSON.

**Streams**

```js
br.addStreams(["electrics", "wheelInfo"]);   // ref-counted subscribe
br.removeStreams(["wheelInfo"]);
```

**Events**

```js
br.on("connection", state => { /* "open" | "closed" */ });
br.on("streams", (flat, raw) => { /* merged stream object */ });
br.on("info", beamng => { /* base game info (I#) */ });
br.on("hook", (name, args) => { /* any engine hook */ });
br.on("hook:VehicleFocusChanged", args => { /* a specific hook */ });
```

`br.serializeToLua(jsValue)` converts a JS value to a Lua literal (handy for
passing tables to Lua functions).

---

## BeamNG Lua cookbook

Reachable through `engineLua` (GE) or `activeObjectLua` (vehicle), as used by the
panel:

```lua
-- Vehicle (PO)
beamstate.reset()                          -- repair in place
recovery.recoverInPlace()                  -- unflip
fire.igniteVehicle() / fire.extinguishVehicle()
beamstate.breakHinges() / beamstate.breakAllBreakgroups()
for i=0,wheels.wheelCount-1 do beamstate.deflateTire(i) end
electrics.toggle_lights() / electrics.toggle_warn_signal()
ai.setMode('chase')                        -- traffic|random|span|flee|chase|follow|stop|disabled
ai.setTargetObjectID(<id>); ai.setMode('chase')   -- chase/follow/flee need a target

-- Engine (GL)
core_environment.setGravity(-9.81)
core_environment.setTimeOfDay({time=0.5})
simTimeAuthority.set(0.1)                   -- slow motion
core_vehicles.spawnNewVehicle("etk800")
be:getPlayerVehicleID(0)
getAllVehicles()                           -- list; each :getId(), :getJBeamFilename()
be:getObjectByID(id):queueLuaCommand("ai.setMode('flee')")   -- target a specific vehicle
extensions.gameplay_traffic.setupTraffic(amount, policeRatio)  -- police is a ratio 0..1
extensions.gameplay_police.setPursuitMode(2, be:getPlayerVehicleID(0))
```

---

## Packaging as a mod

From this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\package-mod.ps1
```

Produces `LunaMattinsAVCP.zip` with this internal layout:

```
LunaMattinsAVCP.zip
└── ui/
    └── webcontrolpanel/
        ├── index.html
        ├── css/style.css
        ├── js/{settings,splash,bridge,gauges,customize,datalab,app}.js
        ├── images/…            (everything in images/ is auto-included)
        ├── media/…             (intro videos + art - auto-included)
        └── README.md
```

Drop the zip into `<userfolder>/mods/`. BeamNG auto-mounts it into the virtual
file system at `/ui/webcontrolpanel/…`, so the URL keeps working.

> **Critical packaging detail:** BeamNG's VFS (physfs) requires **forward-slash**
> path separators inside the zip. PowerShell's built-in `Compress-Archive` writes
> back-slashes, which makes the mod register but never serve (404). The script
> uses `System.IO.Compression` with explicit `ui/webcontrolpanel/…` entry names to
> avoid this. If you roll your own packaging, do the same.

A hot-swap of the zip under a live mount needs `deactivateMod` → `activateMod`
(or `initDB`) to refresh; the simplest path is to restart the game.

---

## Distribution / uploading to the repository

- Ship **only** the zip; do **not** include the loose folder in the user's install
  (it would double-mount).
- `package-mod.ps1` is an author-side build tool and is **not** added to the zip
  (the script bundles only the UI files + this README). Users never need it.
- Suggested repo metadata: category **UI/Apps**, tags like *telemetry, dashboard,
  control panel, tools*. State clearly that it is opened in a **browser**, not as
  an in-game app, and that it requires the game's external-app server.
- Because nothing executes on game start, the mod is safe to leave installed; it
  has zero effect until the page is opened.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Connection dot stays red | Game not running, wrong port, or the external-app server is disabled. Confirm `http://localhost:8084/` responds. |
| 404 for the page | Files not mounted. Check the loose folder path, or that the zip uses **forward-slash** entries (see packaging note). |
| Mod registers but never serves | Almost always the back-slash zip-path bug - repackage with the script. |
| Stale UI after edits | Hard-refresh (`Ctrl`+`F5`); or you have both loose + zip installed - remove one. |
| Lags in a normal browser | A widget is drawing while its tab is hidden, or rebuilding DOM every frame - see the performance rules. |
| Maximize doesn't fill the screen | An ancestor has a `transform` (e.g. a transition keyframe) - keep page animations opacity-only. |
| Phone can't connect | Use the PC's LAN IP, same network, and allow `8084` through the firewall. |

---

## Known limitations

- Requires the game's **external-app server** to be enabled and reachable.
- Telemetry is limited to the streams BeamNG exposes (listed above). There is
  **no** stream for raw suspension travel or damper force, so the Suspension tab
  visualizes per-corner load (`downForce`) + chassis attitude rather than raw
  damper curves.
- Some values are vehicle-config dependent (e.g. turbo boost only on forced-
  induction engines).

---

## Uninstall

- **Mod:** delete `LunaMattinsAVCP.zip` from `<userfolder>/mods/` (or deactivate
  it in the in-game mod manager).
- **Loose dev copy:** delete `<userfolder>/ui/webcontrolpanel/`.

No game files were changed, so there is nothing else to revert.

---

## Credits & license

- Built by **Luna Mattins**. All HTML/CSS/JS here is original work; **no
  third-party libraries are bundled or fetched**.
- The BeamNG logo is referenced from the stock game asset and not redistributed.
- Protocol behaviour was re-implemented against BeamNG's documented
  `bng-ext-app-v1` channel; it does not copy or redistribute game code.

You're encouraged to fork, re-theme, and extend it. If you redistribute a modified
version, please credit the original and keep the compliance properties intact
(additive-only, no game-file overrides, no game-file writes).
