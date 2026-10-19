# Companion

Tauri app that runs Socrates. **Install and run:** see the [repository README](../README.md).

## Layout

```text
companion/
  bin/           socrates launcher
  src/pet/       HabitatPet, draw loop, pet.json consumer
  src-tauri/     UIA surface_mapper, overlay window, logging
assets/pets/     pet.json + PNG sheets (repo root)
```

## Commands

| Command | Use |
|---------|-----|
| `npm start` / `socrates` | Pet + activity journal |
| `npm run debug` / `socrates --debug` | HUD, ledge wireframes, structured diagnostics in terminal, raw tool output |
| `npm run tauri:dev` | Direct `tauri dev` (developer) |
| `npm test` | Regression tests |
| `npm run build` | Production frontend bundle |

## Environment

Full defaults: [`src-tauri/src/habitat_config.rs`](src-tauri/src/habitat_config.rs).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HABITAT_DEBUG` | off | HUD + wireframes + structured diagnostics (with `socrates --debug`) |
| `HABITAT_DEBUG_LOG` | off | Structured `debug` log lines only (no HUD/wireframes; terminal shows them when set for `socrates`) |
| `HABITAT_LIVE_UIA` | on | Live geometry |
| `HABITAT_SURFACES_PATH` | — | Static `.surfaces.json` when live UIA is off |
| `HABITAT_IDE_HOST` | auto | Session IDE: `code`, `cursor`, or `auto` (unset = ancestry walk in Rust at startup) |
| `HABITAT_FOREGROUND_IDE` | on | Foreground window of the session IDE (`0` = largest window of that IDE) |
| `SOCRATES_LOG_DIR` | `%LOCALAPPDATA%\Socrates\logs` | Log directory override |

More detail: [docs/architecture.md](../docs/architecture.md).

### Bug reports

Copy the **session ID** from the launcher header. Attach from `%LOCALAPPDATA%\Socrates\logs` (or `SOCRATES_LOG_DIR`): `journal-*.jsonl` (runtime), `launcher-YYYY-MM-DD-<session>.jsonl` (this terminal), and `development-YYYY-MM-DD-<session>.log` (raw tool output). Rotated segments use `.1`, `.2`, `.3` before the extension.
