# Architecture

Socrates is a **click-through overlay** on top of **VS Code or Cursor** (Windows). The pet walks on ledges inferred from the real IDE layout, falls when support moves away, and reacts to the pointer without capturing clicks.

## Stack

| Layer | Role |
|-------|------|
| `bin/socrates.js` | Launcher, terminal journal, log files under `%LOCALAPPDATA%\Socrates\logs` |
| `src/` + `src/pet/` | Vite 8 / TypeScript 6 UI: SVG pet renderer, `HabitatPet` state machine |
| `src-tauri/` | Tauri 2 / Rust host: WebView2, transparent always-on-top window, UIA geometry, pointer sampling |

Native dependencies include `uiautomation` for layout inspection, `windows` for Win32 calls, `sysinfo` for process discovery, `serde` / `serde_json` for IPC and logs, and `chrono` for log timestamps. Exact dependency versions are recorded in `companion/package-lock.json` and `companion/src-tauri/Cargo.lock`.

Pet art and behavior live in [`assets/pets/default-cat/pet.json`](../assets/pets/default-cat/pet.json) (clip sheets + weighted activities).

## Geometry (live UIA)

Rust [`surface_mapper.rs`](../companion/src-tauri/src/surface_mapper.rs) polls UI Automation on the foreground window of the **session IDE host** ([`ide_host.rs`](../companion/src-tauri/src/ide_host.rs)—`Code.exe` or `Cursor.exe`, chosen at launch):


- Discover the UIA root via `ElementFromHandle` on the tracked HWND (exact native HWND match only; a desktop → `ProcessId` search returns the same subtree but can stall for tens of seconds behind an unresponsive top-level window). Sash detection accepts 4–9px (VS Code default), `monaco-sash` orientation classes, depth 16, and scores wide horizontal `Tab` strips over the activity bar.
- Recurse children (depth-capped) and emit horizontal **ledge** segments in **window-local pixels**.
- Emit `habitat-surfaces` events to the webview; bump `revision` when segments or HWND change.

Defaults and env flags: [`habitat_config.rs`](../companion/src-tauri/src/habitat_config.rs), `HABITAT_IDE_HOST` in [`ide_host.rs`](../companion/src-tauri/src/ide_host.rs). UIA resolves the **exact** tracked HWND (no same-PID largest-window fallback). Set `HABITAT_LIVE_UIA=0` and `HABITAT_SURFACES_PATH` only if you use a static surfaces JSON file.

The overlay window is created with `visible: false`, `focus: false`, and `focusable: false`; it is shown after positioning on the IDE bounds. The pet loop uses a single monotonic clock ([`pet-loop-clock.ts`](../companion/src/pet-loop-clock.ts)) and a visibility-gated timer fallback when `requestAnimationFrame` stalls.

## Pointer

Read-only **Win32 `GetCursorPos`** plus **logical primary button** (`GetAsyncKeyState`, swap-mouse aware) in Rust → `get_pointer_in_ide_local` (HWND-local coordinates when the cursor is inside the tracked IDE rect; button state travels with the sample). Returns `None` only when cursor position cannot be read. The overlay uses permanent `setIgnoreCursorEvents`; the pet never moves the system cursor.

Proximity reactions use `pet.json` activities `pointer_swipe` and `pointer_pounce` (debug HUD shows the reach box). **Pick up and drag:** ~250 ms click-and-hold inside that same reach box plays `Socs-carried.png`, then release to fall onto a crossed ledge below (`user_carry` in `HabitatPet`, not a weighted activity). Polling at 50 ms cannot guarantee where a press began; IDE clicks and selection still pass through the overlay.

## Presentation vs geometry vs diagnostics

- **Geometry** (`HABITAT_LIVE_UIA`, foreground IDE host) runs unless you turn live UIA off.
- **Presentation** (`HABITAT_DEBUG`, `HABITAT_DEBUG_SURFACES`, `HABITAT_DEBUG_HUD`, `socrates --debug`) toggles HUD and ledge wireframes only.
- **Structured diagnostics** (`HABITAT_DEBUG_LOG`, or the `HABITAT_DEBUG` / `--debug` umbrella) emit coalesced `debug` records on the runtime log bus without requiring overlays.

## Logging

```text
Companion (Rust + WebView) → stdout lines prefixed @socrates-log → runtime journal-*.jsonl (Rust writer)
socrates launcher            → parses stdout for the terminal journal; writes launcher-*.jsonl + development-*.log (raw pipe)
```

The launcher shows structured `debug` lines in the terminal when `HABITAT_DEBUG_LOG=1` or `socrates --debug`, independent of whether HUD/wireframes are on. Raw Cargo/Vite output is echoed only with `socrates --debug`. See [companion/README.md](../companion/README.md) for bug-report file names, session ID, and rotated segments.

## Tests

From `companion/`: `npm test`, `npm run build`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml`. The frontend build does not build the native executable.

## Security and privacy boundaries

The UIA mapper reads element types, class names, and bounding rectangles; it does not request editor text or input values. Pointer sampling uses `GetCursorPos` without injecting input. The application has no telemetry or upload implementation.

Native commands expose geometry, presentation flags, pointer coordinates, and bounded log entries. Static geometry is read only from the shell-configured path. The webview uses local content, Tauri capabilities, and separate development/production CSPs in [`tauri.conf.json`](../companion/src-tauri/tauri.conf.json).

Normal source launches include a localhost Vite server bound to localhost by default. Vite `server.fs.allow` is limited to the companion package and `assets/pets/default-cat/` (sprites and manifest), not the whole repository. Local diagnostic files may still contain paths and error details; review them before sharing. See the [developer guide](../companion/README.md) for retention and development settings.
