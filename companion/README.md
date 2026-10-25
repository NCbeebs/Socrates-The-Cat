# Companion developer guide

For installation and normal use, see the [repository README](../README.md). Run the commands below from `companion/` using the documented Windows, Node, and Rust prerequisites.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Install the locked npm dependencies, including build tools |
| `npm link` | Once per checkout: register `socrates` on your `PATH` (see root README) |
| `socrates` / `npm start` | Source launch with activity journal and diagnostics (`npm start` without linking) |
| `socrates --check-updates` | Compare this `main` checkout to upstream GitHub (no launch; exit 1 on check failure). Bypasses the 24h cache but never a GitHub-imposed wait |
| `npm run debug` / `socrates --debug` | Add HUD, surface outlines, structured debug records, and raw tool output |
| `npm run tauri:dev` | Direct native development launch, without the journal launcher |
| `npm run tauri:dev:debug` | Direct native launch with `HABITAT_DEBUG=1` |
| `npm run dev` | Vite frontend server only; native IPC requires the Tauri host |
| `npm test` | JavaScript/TypeScript regression tests using Node's type stripping |
| `npm run build` | Type-check and bundle the frontend; does not build the native executable |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Standard Rust unit tests (`#[test]` discovery) where the test executable loads |
| `cargo run --locked --manifest-path src-tauri/Cargo.toml --features habitat-unit-tests --bin habitat_unit` | **Optional fallback:** same 31 native assertion functions when `cargo test` fails at load (see below) |
| `npm run tauri:build:release` | Build the native release executable and embedded frontend (no MSI/NSIS) |

### Native tests: standard vs fallback (Windows)

**Preferred:** `cargo test --locked --manifest-path src-tauri/Cargo.toml` (per-test results, filters, future integration tests).

On this developer machine, the `cargo test` executable fails **before any test runs** (`STATUS_ENTRYPOINT_NOT_FOUND`, 0xC0000139). The failing binary imports `userenv.dll!GetUserProfileDirectoryW`; the optional `habitat_unit` dev binary does not. System32’s `userenv.dll` loads and exports that symbol here, so this is a **local loader failure bypassed by an alternative runner**, not a confirmed general Rust or libtest defect (`harness = false` integration tests can fail the same way).

**Fallback (opt-in, not a default Cargo feature):**

```powershell
cargo run --locked --manifest-path src-tauri/Cargo.toml --features habitat-unit-tests --bin habitat_unit
```

Expect `habitat_unit: ok (31 checks)`. Assertion bodies live in shared `unit_tests` helpers; `#[test]` wrappers and the fallback runner both call them.

The launcher starts `tauri dev`, including a Vite server on localhost port 1420. Keep it local. Vite `server.fs.allow` is limited to this package and `../assets/pets/default-cat/` (sprites and manifest), not the whole repository. Logs and other local files can still contain paths; review before sharing. Marketplace distribution is not published yet; local VSIX packaging is documented under [extension/](../extension/).

## VS Code extension (managed mode)

The optional [VS Code extension](../extension/) ships a release `companion.exe` and starts it with `--habitat-managed` / `HABITAT_MANAGED=1` plus `HABITAT_IDE_HOST=code`. That path uses a session-scoped named pipe and mutex (see `managed_lifecycle.rs`); it is **not** used by `socrates` or `npm run tauri:dev`.

| Launch | Managed control plane | Typical logs |
|--------|----------------------|--------------|
| `socrates` / `tauri dev` | Off | `%LOCALAPPDATA%\Socrates\logs` (or `SOCRATES_LOG_DIR`) |
| Extension **Start** | On | `%LOCALAPPDATA%\Socrates\logs\vscode-managed` |

Both can run on the same machine without sharing the managed mutex/pipe. Only extension-managed instances coordinate through the pipe; duplicate `--habitat-managed` starters exit early. Extension **Stop** shuts down the shared managed process; closing one VS Code window only **releases** that window’s attach handle.

Details: [extension/README.md](../extension/README.md), [vsc-ext.md](../vsc-ext.md).

## Environment

Set overrides in your shell before launch. No `.env` file is needed. Boolean flags accept `0`, `false`, or `off` to disable them; leave variables unset for defaults.

| Variable | Default | Purpose |
|---|---|---|
| `HABITAT_IDE_HOST` | ancestry, then Cursor | `code` (also `vscode`), `cursor`, or `auto`; invalid values, including an empty string, warn and fall back to Cursor |
| `HABITAT_MANAGED` | off | Extension-managed sessions only: `1` / `true` / `on`, or pass `--habitat-managed` on the native executable. Source `socrates` does not set this. |
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
| `SOCRATES_CHECK_UPDATES` | off | When `1`, launcher compares `main` to canonical upstream on GitHub (async; does not block `tauri dev`). Sends local SHA + IP; 24h cache in `%LOCALAPPDATA%\Socrates\update-check-cache.json`, serialized across launches by `update-check-cache.json.lock` |
| `SOCRATES_UPDATE_REPO` | from `package.json` | Override upstream `owner/repo` (defaults to NCbeebs/Socrates-The-Cat) |
| `SOCRATES_UPDATE_BRANCH` | `main` | Branch compared against upstream; must be a valid git branch name |

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
