# Companion developer guide

For installation and normal use, see the [repository README](../README.md). Run the commands below from `companion/` using the documented Windows, Node, and Rust prerequisites.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Install the locked npm dependencies, including build tools |
| `npm link` | Once per checkout: register `socrates` on your `PATH` (see root README) |
| `socrates` / `npm start` | Source launch with activity journal and diagnostics (`npm start` without linking) |
| `npm run debug` / `socrates --debug` | Add HUD, surface outlines, structured debug records, and raw tool output |
| `npm run tauri:dev` | Direct native development launch, without the journal launcher |
| `npm run tauri:dev:debug` | Direct native launch with `HABITAT_DEBUG=1` |
| `npm run dev` | Vite frontend server only; native IPC requires the Tauri host |
| `npm test` | JavaScript/TypeScript regression tests using Node's type stripping |
| `npm run build` | Type-check and bundle the frontend; does not build the native executable |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Native Rust tests |
| `npm run tauri -- build --no-bundle` | Build the native release executable and embedded frontend |

The launcher starts `tauri dev`, including a Vite server on localhost port 1420. Keep it local. Vite `server.fs.allow` is limited to this package and `../assets/pets/default-cat/` (sprites and manifest), not the whole repository. Logs and other local files can still contain paths; review before sharing. Packaged distribution is not yet a supported release workflow.

## Environment

Set overrides in your shell before launch. No `.env` file is needed. Boolean flags accept `0`, `false`, or `off` to disable them; leave variables unset for defaults.

| Variable | Default | Purpose |
|---|---|---|
| `HABITAT_IDE_HOST` | ancestry, then Cursor | `code` (also `vscode`), `cursor`, or `auto`; invalid values, including an empty string, warn and fall back to Cursor |
| `HABITAT_LIVE_UIA` | on | Poll live IDE geometry |
| `HABITAT_SURFACES_PATH` | unset | Optional static surfaces JSON; normally used with live UIA off, also read when no live snapshot is available |
| `HABITAT_FOREGROUND_IDE` | on | Track the session IDE's foreground window; `0` selects its largest visible window |
| `HABITAT_DEBUG` | off | Enable HUD, surface outlines, and native structured diagnostics |
| `HABITAT_DEBUG_HUD` | inherits `HABITAT_DEBUG` | Override the HUD independently |
| `HABITAT_DEBUG_SURFACES` | inherits `HABITAT_DEBUG` | Override surface outlines independently |
| `HABITAT_DEBUG_LOG` | inherits `HABITAT_DEBUG` in the app | Override structured diagnostics; set `1` to show debug records through the normal launcher without raw output |
| `HABITAT_LIVE_POLL_MS` | 500 | Idle geometry polling interval in milliseconds; minimum 100 |
| `HABITAT_LIVE_POLL_FAST_MS` | 50 | Active geometry polling interval in milliseconds; minimum 20 |
| `HABITAT_FOREGROUND_STICKY_MS` | 280 | Briefly retain IDE tracking during transient foreground changes |
| `HABITAT_FOREGROUND_HIDE_MS` | 180 | Delay hiding after focus leaves the IDE |
| `SOCRATES_LOG_DIR` | `%LOCALAPPDATA%\Socrates\logs` | Use a dedicated directory for logs and automatic retention cleanup |
| `SOCRATES_SESSION_ID` | generated | Launcher sets a UUID for its child; direct native launches generate a timestamp/process ID fallback |

`socrates --debug` sets both `HABITAT_DEBUG=1` and `HABITAT_DEBUG_LOG=1`. `HABITAT_DEBUG=1` alone enables native debug records, but the normal launcher displays those records only when `HABITAT_DEBUG_LOG` is also enabled. Presentation subflags can override the umbrella flag.

`TAURI_DEV_HOST` is a Vite development override, not needed for this Windows companion. Changing it can expose the server beyond localhost and conflict with the configured development CSP.

Presentation flags are resolved in [`habitat_config.rs`](src-tauri/src/habitat_config.rs); host selection in [`ide_host.rs`](src-tauri/src/ide_host.rs); geometry and focus timings in [`lib.rs`](src-tauri/src/lib.rs).

## Logs and bug reports

The launcher prints the directory and session ID. Log families are:

| File | Contents |
|---|---|
| `journal-YYYY-MM-DD.jsonl` | Runtime activity and diagnostics, shared across sessions that day |
| `launcher-YYYY-MM-DD-SESSION.jsonl` | Launcher events for one session |
| `development-YYYY-MM-DD-SESSION.log` | Raw development output captured by the launcher, even outside debug mode |

Each file rotates at 5 MiB with three backups (`.1`, `.2`, `.3` before the extension). Retention cleanup runs when writing on a new local date and removes old matching files after 14 days; it does not run while the app is stopped. Direct `tauri:dev` runs produce runtime journal files but no launcher/development file pair.

Review and redact logs, screenshots, and recordings before attaching them to an issue. Errors and raw build output may include usernames, absolute paths, or other private context. Include only relevant excerpts, plus the session ID, Windows/IDE versions, launch command, and reproduction steps.

## Layout

- `bin/`: source launcher and launcher log storage.
- `src/`: TypeScript frontend, SVG renderer, pet behavior, journal, and IPC bridge.
- `src-tauri/`: Rust host, Windows APIs/UI Automation, capabilities, CSP, and native logging.
- `../assets/pets/default-cat/`: required pet manifest and sprite sheets, bundled by Vite.

See [architecture](../docs/architecture.md) for the runtime flow.
