# Changelog

All notable changes to **Luna Mattins AVCP** are documented here. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/); the version
shown matches the badge in the app header. Dates are ISO (YYYY-MM-DD).

---

## v0.4 - 2026-06-10

The customization update: a cross-tab **layout editor**, per-quantity
**units**, **driving alerts**, shareable **profiles**, and an opt-in **online
gallery** fed from the Malo Interactive CDN.

### Added

**Layout editor** (Settings → Interface & layout)
- Every card on every tab can be hidden (👁) or re-ordered - drag on desktop,
  ◀ ▶ arrows everywhere. A floating *Done* pill saves and exits.
- Layouts are stored per tab together with the tab's card count, so they
  self-heal across updates: if a future version changes a tab's card set,
  that tab quietly resets to default instead of scrambling.
- One-click *Reset layout* restores the stock arrangement live.

**Units, per quantity** (Settings → Units)
- Speed (km/h · mph), temperature (°C · °F), distance (km · mi) and pressure
  (psi · bar · kPa) are now independent preferences; the Metric / Imperial
  buttons remain as one-tap presets. Boost readouts (Thermals, Powertrain
  Flow), wheel speeds, altitude/elevation (m ↔ ft) and every existing readout
  follow the granular prefs. Data Lab recordings stay in canonical units
  (km/h · °C · psi) so exports are machine-stable.

**Driving alerts** (Settings → Driving alerts)
- Shift light: flashes the screen edges red when the engine passes the
  redline configured under Gauges (honours a custom RPM ceiling).
- Overspeed warning: amber border above a unit-aware threshold.
- Both are purely visual overlays evaluated on the telemetry stream; the DOM
  is only touched when the alert state changes.

**Profiles** (Settings → Profiles)
- Named snapshots of the entire panel setup - theme, custom colours, units,
  gauges, appearance (background & glass), card layout, alerts, UI scale,
  startup tab. Load applies and reloads; export/import as plain JSON for
  sharing. (A custom uploaded background image stays local; preset and
  online backgrounds travel with the profile.)

**Custom CSS** (Settings → Custom CSS)
- A built-in stylesheet editor: your CSS is appended after the panel's own,
  persisted locally, included in profiles, and toggleable on/off without
  losing the text - a broken rule can never lock you out. Theme tokens set
  inline (`--accent` etc.) are overridable with `!important`; the editor's
  placeholder documents the useful tokens. Capped at 64 KB.

**Online gallery** (Settings → Online gallery)
- Optional, strictly user-triggered: *Browse* fetches a manifest
  (`avcp-gallery-1`) from the Malo Interactive CDN with curated backgrounds
  and profiles, each applying in one click. Themes stay local by design - a
  shared *profile* carries its theme choice instead. Backgrounds display
  straight from their URL (a new "remote" background mode - nothing is
  downloaded into storage). `avcp.galleryUrl` in localStorage overrides the
  manifest URL for testing. The `cdn-upload/` folder in the repo holds the
  ready-to-upload starter manifest, a Track Day profile and CDN docs
  (CORS requirements included).

**Interface** (Settings → Interface & layout)
- Whole-panel UI scale (80–130 %).
- Startup tab: open the panel on any tab, not just the Dashboard.

### Changed
- "Reset all panel settings" now wipes all v0.4 keys too and reloads the
  panel for a clean factory state (recordings still survive; intro plays
  again - it is a factory reset, after all).
- README: customization docs and the moderator disclosure now lists the
  gallery as the third (opt-in) external fetch.

---

## v0.3 - 2026-06-10

The data-extraction update [EXPIE-121445]: a full telemetry **Data Lab**
(recorder → library → analyzer → playback), a one-shot **first-launch intro**,
and a cleanup pass over copy and dead code.

### Added

**Data Lab - new tab** (recorder, library & analyzer for engineers and tuners)
- Telemetry recorder: samples the live streams into named channels at a
  selectable 1–60 Hz. Record the full "extensive" channel set or narrow it
  per category - *Driver inputs*, *Powertrain*, *Dynamics*, *Thermals*,
  *Brakes* (per-wheel temperature & fade) and *Wheels & tires* (per-wheel
  speed / slip / vertical load / drive & brake torque; channel lists adapt to
  the vehicle's actual wheel count).
- Markers can be dropped mid-take (⚑ button or the `M` shortcut) and appear as
  flags in the graph and as comment rows in CSV exports.
- Recording library: takes auto-save on stop into the browser's IndexedDB
  (`avcp_telemetry` - sandboxed, never a game-file write). Reload, export as
  CSV or JSON, delete (two-step confirm), and re-import JSON exports, so takes
  can be shared between machines and people.
- Analyzer: overlay mode and per-channel lane mode (data-logger style),
  min/max-binned rendering that stays alias-free at any zoom level, mouse-wheel
  zoom around the pointer, minimap pan strip, double-click to fit, a data
  cursor with interpolated per-channel readouts, and a per-channel
  min / avg / max stats table.
- Playback transport: play/pause, jump-to-start, loop, 0.25–4× speed. **Drive
  dashboard** feeds the recorded values back into the panel's shared telemetry
  state so the real speedo / tach / pedals / G-meter replay the take (live
  telemetry is ignored until it's switched off).
- **Actuate vehicle**: replays the recorded driver inputs (throttle, brake,
  clutch, steering, handbrake, gear) into the real car while playing -
  open-loop `input.event` replay with the DIRECT filter; gear changes go
  through the vehicle's own controller. Controls are zeroed and handed back
  the instant playback stops. Recording while actuating is allowed on purpose
  (baseline-vs-setup A/B runs). The armed button blinks amber.
- Handbrake joined the Driver-inputs channel set (recorded, replayed to the
  dashboard, and actuated).
- "Delete all recordings" control in Settings → Storage (kept separate from
  the settings reset so a factory reset can't nuke your data).

**First-launch intro**
- Plays the Malo Interactive splash once per browser/CEF profile, picking the
  portrait (9:16) or landscape (16:9) cut to fit the screen. Click anywhere,
  `Esc`, or the Skip pill to dismiss; optional sound toggle.
- Misfire-proofed: the "seen" flag is persisted the moment the intro is
  *attempted* (a crash mid-video can never loop it), `prefers-reduced-motion`
  suppresses it entirely, and a watchdog dismisses it if the video can't load.
- Local files under `media/` are tried first; if a build ships without them
  the intro streams once from the Malo Interactive CDN instead, then never
  again. Settings → *Intro video* disables it permanently or replays it.

### Changed
- Settings → Storage copy now covers all three storage locations
  (localStorage prefs, background-image IndexedDB, telemetry IndexedDB) and
  the reset button intentionally leaves recordings alone.
- Credits copy cleaned up (typos, clearer development note); the Diagnostics
  repair button dropped its "[kinda broken]" label.
- `package-mod.ps1` now bundles `media/` automatically (like `images/`) and
  the two new modules `js/splash.js` + `js/datalab.js`.
- README: documented the Data Lab, the intro, and tightened the moderator
  disclosure - the panel's only external fetches are the Credits-tab Discord
  widget and the intro-video CDN fallback; no analytics, no phone-home.

### Fixed
- Credits avatar image pointed at `images/transparent.png`, which doesn't
  exist (the file lives in `media/`) - it 404'd in every install.
- Removed a dead duplicate of the Quick-Spawn button grid and of
  `refreshMatrix()` in `app.js` (the second definition silently replaced the
  first; only one set of buttons was ever visible).

---

## v0.2 - 2026-06-06

The first big feature release after the initial build: a full **Settings** tab,
**personalization** (custom local backgrounds + glassmorphism), a **live
performance monitor**, several new telemetry cards, and a batch of
vehicle-control fixes.

### Added

**Settings - new tab**
- 7 built-in colour themes (Ember, Ion, Toxic, Redline, Synthwave, Hazard,
  Graphite) plus custom accent / data colour pickers. Themes re-skin the whole
  panel, canvas gauges included.
- Metric / Imperial units toggle that drives the speed dial and every readout
  (km/h ↔ mph, °C ↔ °F, km ↔ mi).
- Per-gauge configuration: speed-dial max, RPM max (or auto), redline %, needle
  smoothing, tick marks, speed decimals.
- Global keyboard shortcuts with a toggle and an on-screen shortcut list.
- "Storage & reset" card to wipe all panel settings in one click.
- Preferences persist in the browser's sandboxed **localStorage** (namespaced
  `avcp.`) - never written to BeamNG game files.

**Personalization - custom backgrounds & glassmorphism** (in Settings)
- Upload your own local background image. It is stored in the browser's
  **IndexedDB** (sandboxed, auto-downscaled, never uploaded anywhere) and never
  touches game files.
- 4 file-free gradient presets: Aurora (follows your theme colours), Midnight,
  Sunset, Carbon.
- Background blur and dim controls to keep cards legible over busy images.
- Glassmorphism mode: frosted, translucent cards and top bar with backdrop blur,
  plus glass-blur and solidity sliders. Choosing a background enables glass
  automatically the first time.

**Live performance monitor** (in Session Statistics)
- Live **FPS** with min / average / max and frame-time (ms), plus a rolling
  history graph.
- **Memory**: BeamNG process working set in GB with a system-RAM bar and history.
- **GPU / VRAM**: video memory in use (GB and %), with history.
- **System** card: CPU / GPU / RAM info read from the engine.
- **Resource hogs**: samples BeamNG's game-engine Lua VM for ~2 s and ranks the
  functions that ate the most time - the closest "what's eating the frame"
  breakdown the game exposes to a UI. It profiles only the GE Lua thread (not
  C++ render/physics or the vehicle VM), adds a little overhead while sampling,
  then switches itself back off.

**Telemetry**
- CSV telemetry logger (Session Statistics): records speed / RPM / inputs / temps
  to memory and exports a CSV via a client-side download - nothing is written to
  the game folder.

**Dashboard**
- Navigation card: a heading-up positional radar/compass with a breadcrumb trail
  of your recent path.

**Vehicle**
- Fuel / Energy card: set the fuel (or EV charge) level on the active vehicle.
- Drivetrain / Off-road card: live transfer-case / range-box / differential
  controls (2WD/4WD/AWD, high/low range, lock/open diffs).
- Spawn box autocomplete: model suggestions populated from the game's own
  vehicle list.

**Diagnostics** (renamed *Wheel / DT Info*)
- Damage card: deflated-tyre count, structural damage, engine state, check-engine.

**Suspension**
- Pre-Runner Suspension Travel: per-corner travel derived from vertical contact
  load, plus articulation / cross-axle flex, airtime, and session peaks.
- Per-corner ground-material chip (dirt / mud / rock / gravel / sand / asphalt /
  …) read from each wheel's contact ground-model.
- New pre-runner compression graph and a separate per-corner load graph.

**Credits**
- Community card with a Discord invite and a live server widget.

**Connection / setup**
- In-game setup warning: when the panel can't reach BeamNG's external-UI web
  server, it now raises a **BeamNG toast and a game-log line** (buffered, so a
  late connection still delivers it). The warning reaches you inside the game
  itself instead of only on the browser page.

**Tooling**
- `package-mod.ps1` build script that produces a correctly structured mod zip
  with forward-slash VFS entry names (`LunaMattinsAVCP.zip`).

### Changed
- Renamed tabs: *Statistics* → *Session Statistics*, *Diagnostics* →
  *Wheel / DT Info*.
- Diagnostics cards relabelled and expanded: *Thermals* → *Thermals & Engine
  load*; *Brakes* → *Brake Power & Temp* (per-wheel kW / kN with brake-temp and
  thermal-fade colouring).
- Suspension: *Damper Activity* → *Damper Rebound*; the old *Per-corner Load
  History* became the *Pre-runner suspension compression graph*, with a separate
  per-corner load graph added alongside.
- Layout consistency pass (desktop widths): fixed ragged rows and large
  right-hand gaps on the **AI & Traffic**, **World** and **Credits** tabs so
  every row fills evenly.
- WebSocket bridge now reconnects with exponential backoff instead of a fixed
  retry interval.
- Render performance: only the active tab's widgets are drawn each frame, and
  DOM-list rebuilds are throttled.

### Fixed
- **Gear shifting** - was calling functions that don't exist in the vehicle Lua
  VM, so it silently did nothing. Now uses the correct keybind press/release
  pairs.
- **Engine ignition / starter** - the momentary starter is now released
  correctly instead of being held.
- **Differential lock / drivetrain mode** switching now applies reliably (uses
  the real powertrain device-mode calls).
- **Recover-to-road** now starts and stops recovery correctly instead of
  potentially running indefinitely.
- Corrected two dashboard indicator labels (*P-BRAKE* and *LOW FUEL* had
  stray/missing brackets).
- Mod zip now uses forward-slash entry names so BeamNG's VFS actually serves the
  files (back-slash entries used to register but return 404).

---

## v0.1 - Initial release

Browser-based control panel and live-telemetry dashboard for **BeamNG.drive**,
talking to the game over its own `bng-ext-app-v1` WebSocket protocol
(re-implemented from scratch - no game files modified, no Lua extension, runs
read-only from the browser).

Tabs:
- **Dashboard** - speedo & tach, gear, G-force meter with trail, throttle / brake
  / clutch / steering bars, warning indicators, speed/RPM history, per-wheel
  slip, raw-telemetry table.
- **Vehicle** - recover / repair / reset / reload, lights & electrics, spawn /
  replace / delete vehicles.
- **World** - time of day, simulation speed, gravity, camera modes, fog / clouds
  / wind.
- **Chaos** - instant physics triggers, time-dilation + hold-to-slow-mo, gravity
  matrix.
- **AI & Traffic** - behaviour matrix, quick-spawn grid, player AI modes, traffic
  system.
- **Statistics** - top speed, max RPM, max lateral/longitudinal G, 0–100 km/h &
  0–60 mph timers, distance, odometer, vehicle info.
- **Diagnostics** - thermals, brakes, live powertrain-flow node diagram.
- **Suspension** - chassis load map, damper activity, per-corner load history,
  roll/pitch/vertical-G attitude.
- **Console** - run arbitrary Lua in the game-engine or active-vehicle VM.

Every card can be maximised to full-screen; the UI is fully responsive and
touch-friendly.
