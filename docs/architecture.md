# Architecture

Socrates is a **click-through overlay** on top of **VS Code or Cursor** (Windows). The pet walks on ledges inferred from the real IDE layout, falls when support moves away, and reacts to the pointer without capturing clicks.

## Stack

| Layer | Role |
|-------|------|
| `bin/socrates.js` | Launcher, terminal journal, log files under `%LOCALAPPDATA%\Socrates\logs` |
| `src/` + `src/pet/` | Vite/TypeScript UI: SVG pet renderer, `HabitatPet` state machine |
| `src-tauri/` | Tauri 2 host: transparent always-on-top window, UIA geometry, pointer sampling |

Pet art and behavior live in [`assets/pets/default-cat/pet.json`](../assets/pets/default-cat/pet.json) (clip sheets + weighted activities).

## Geometry (live UIA)

Rust [`surface_mapper.rs`](../companion/src-tauri/src/surface_mapper.rs) polls UI Automation on the foreground window of the **session IDE host** ([`ide_host.rs`](../companion/src-tauri/src/ide_host.rs)—`Code.exe` or `Cursor.exe`, chosen at launch):


- Discover the UIA root via desktop → `ProcessId` children (exact native HWND match only). Sash detection accepts 4–9px (VS Code default), `monaco-sash` orientation classes, depth 16, and scores wide horizontal `Tab` strips over the activity bar.
- Recurse children (depth-capped) and emit horizontal **ledge** segments in **window-local pixels**.
- Emit `habitat-surfaces` events to the webview; bump `revision` when segments or HWND change.

Defaults and env flags: [`habitat_config.rs`](../companion/src-tauri/src/habitat_config.rs), `HABITAT_IDE_HOST` in [`ide_host.rs`](../companion/src-tauri/src/ide_host.rs). UIA resolves the **exact** tracked HWND (no same-PID largest-window fallback). Set `HABITAT_LIVE_UIA=0` and `HABITAT_SURFACES_PATH` only if you use a static surfaces JSON file.

The overlay window is created with `visible: false`, `focus: false`, and `focusable: false`; it is shown after positioning on the IDE bounds. The pet loop uses a single monotonic clock (`pet-loop-clock.js`) with a visibility-gated `requestAnimationFrame` fallback.

## Pointer

Read-only **Win32 `GetCursorPos`** in Rust → `get_pointer_in_ide_local` (same coordinate space as surfaces). The overlay uses `setIgnoreCursorEvents`; the pet never moves the system cursor.

Distance tiers and activities are defined in `pet.json` (`pointer_look`, `pointer_alert`, `pointer_pounce`, `pointer_swipe`).

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

From `companion/`: `npm test`, `npm run build`. Native unit tests: `cargo test` in `src-tauri/`.
