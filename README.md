# Socrates the Cat

A desktop cat that walks the real tab strips, panel edges, and status bar in **VS Code or Cursor**. He grooms, sleeps, dreams, reacts to your pointer, and falls when his ledge disappears. You can **click-and-hold to pick him up** and drop him on another ledge when he blocks your code. The overlay stays click-through so you can keep working.

**Windows.** Easiest install: the **[VS Code Marketplace extension](https://marketplace.visualstudio.com/items?itemName=GeneralChromodynamics.socrates-the-cat)** (bundled native companion; no Node/Rust required). Contributors can still **clone and `socrates`** ([Install from source](#install-from-source)). Built with **Tauri 2, Rust, TypeScript 6, Vite 8, and Windows UI Automation**.

## Status

| Path | Who it is for | How you run Socrates |
|---|---|---|
| **Marketplace extension** | Desktop **VS Code** on Windows x64 | Extensions → search **Socrates the Cat**, or [install from Marketplace](https://marketplace.visualstudio.com/items?itemName=GeneralChromodynamics.socrates-the-cat); then **Command Palette** → **Socrates: Start** / **Stop** / **Show Diagnostics** |
| **GitHub clone** | Contributors and source users | `npm link` → `socrates` in the IDE terminal ([Install from source](#install-from-source)) |
| **Local VSIX** | Pre-release builds or **Cursor** (Open VSX listing not yet) | Build a VSIX ([Extension packaging](#extension-packaging)); **Extensions: Install from VSIX** |

**Cursor:** the in-app store uses [Open VSX](https://open-vsx.org/), not Microsoft’s Marketplace, so search may not list Socrates until it is published there. Use a [Marketplace VSIX download](https://marketplace.visualstudio.com/items?itemName=GeneralChromodynamics.socrates-the-cat) (**Download Extension** on the page) or a VSIX you built from this repo.

Clone and extension both use the same native companion and pet assets. The extension does not replace or block the clone workflow.

## Demo

![Socrates sleeping, dreaming, and waking on an IDE ledge](docs/images/socrates3.gif)

**Pointer play** (Cursor always clicks-through to IDE):

![Batting and pouncing at the cursor](docs/images/socrates2.gif)

**Portal hop** (rare—emerges on another walkable ledge):

![Walking through a portal to another ledge](docs/images/socrates1.gif)

**Pick up and move** — click-and-hold (~250 ms) inside Socrates’s pointer-reach area, then drag and release. The reach box matches swipe/pounce (yellow outline with `socrates --debug`); in normal mode a small red dot on the overlay marks when your cursor is in that reach zone. Release lands him on the next walkable ledge below his feet. Clicks still pass through to the editor; dragging may select text underneath.

He also walks and turns at ledge ends, stretches, grooms, sits and looks at the pointer, clings to moving horizontal splits, and slides down dividers. Activities and clips are in [`pet.json`](assets/pets/default-cat/pet.json).

## Requirements

| Component | Requirement |
|---|---|
| OS / IDE | Windows 10/11 with [VS Code](https://code.visualstudio.com/) or [Cursor](https://cursor.com/) |
| Node.js | [Node 24 LTS](https://nodejs.org/en/download) recommended; Node 22.12+ also meets the build and test requirements |
| Rust | Stable **MSVC** toolchain via [rustup](https://rustup.rs/); `cargo` on your `PATH` |
| Windows build tools | Microsoft C++ Build Tools with **Desktop development with C++**, Windows SDK, and **WebView2 Runtime** |
| Git | Required for the [clone](#install-from-source) path only |
| WebView2 | Required for the Marketplace extension and clone builds |

Follow the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) when building from source. Keep Node, Rust, and WebView2 updated. Node 20 is [end of life](https://nodejs.org/en/about/previous-releases).

## Install from Marketplace

1. Open **Extensions** (**Ctrl+Shift+X**) in **desktop VS Code** on Windows.
2. Search for **Socrates the Cat** (publisher **General Chromodynamics**) and install, or open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=GeneralChromodynamics.socrates-the-cat).
3. **Command Palette** (**Ctrl+Shift+P**) → **Socrates: Start**.

Updates arrive through the normal extension update flow. **WebView2** must be installed. Remote SSH/WSL/dev-container UI is not validated yet ([extension README](extension/README.md)).

## Install from source

Run these commands in the integrated terminal of the IDE where you want Socrates:

```powershell
git clone https://github.com/NCbeebs/Socrates-The-Cat.git
cd Socrates-The-Cat\companion
npm ci
npm link
socrates
```

`npm link` registers the `socrates` command (run it once per checkout). Keep the repo and build tools installed; the launcher runs the app from source. If you move the checkout, run `npm link` again from `companion/`. Remove the global command with `npm unlink -g companion`.

The first launch compiles the native app and can take several minutes. Keep an IDE window focused and the terminal open; press **Ctrl+C** to stop. Socrates follows foreground windows belonging to the launch IDE (all VS Code windows or all Cursor windows) and hides when you switch to another application.

Without linking, run `npm start` from `companion/` each session (same launcher, no global `socrates` on your `PATH`).

### Updating

From your clone root (not `companion/`):

```powershell
git pull --ff-only
cd companion
npm ci    # when package-lock.json changed
```

Stop Socrates (**Ctrl+C** in the launcher terminal) before pulling. If `git pull --ff-only` refuses, your clone has local commits that upstream doesn't; decide how to keep them before updating. Restart with `socrates` when done; the next native build runs automatically if Rust changed.

**Optional update notice (opt-in):** enable it before launch:

```powershell
$env:SOCRATES_CHECK_UPDATES = "1"
socrates
```

On `main` only, the launcher compares your checkout to [upstream `main`](https://github.com/NCbeebs/Socrates-The-Cat) via the GitHub API (your commit SHA and IP are sent; results cache for 24 hours under `%LOCALAPPDATA%\Socrates\`). Or run `socrates --check-updates` without starting the app. For email when tagged releases ship, watch the repo on GitHub (**Watch → Releases**).

From an external terminal, select the IDE explicitly:

```powershell
$env:HABITAT_IDE_HOST = "code" # or "cursor"
socrates
```

Without an explicit selection, startup checks process ancestry and defaults to Cursor when no IDE can be identified.

## Diagnostics and troubleshooting

The terminal shows a live activity journal and technical warnings. Run `socrates --debug` or `npm run debug` for a HUD, surface outlines (green walkable, orange climbable), pointer reach box (yellow), and raw development output with `DEBUG` / `JOURNAL` lines:

![socrates --debug: ledge wireframes, pointer reach box, HUD, and terminal diagnostics](docs/images/debug.png)

Use `socrates --help` for command help.

Logs are stored locally under `%LOCALAPPDATA%\Socrates\logs`; the launcher prints the exact directory and session ID. Files rotate at 5 MiB with three backup segments, with cleanup of old logs after 14 days when logging runs. See the [developer guide](companion/README.md) for file names and overrides.

**Review logs and recordings before sharing them.** Raw build output and errors can contain local paths, usernames, and other machine details. Screen recordings can expose editor and terminal contents. Socrates has no application telemetry or upload feature; the development tools may access package registries during installation and builds.

| Symptom | Try |
|---|---|
| `cargo` not found | Add `%USERPROFILE%\.cargo\bin` to `PATH`, then reopen the terminal |
| No cat or wrong IDE | Launch from the intended IDE's terminal; check the `ide_host` journal entry or set `HABITAT_IDE_HOST` |
| `socrates` not found | Run `npm link` from `companion/`; ensure `npm prefix -g` is on `PATH` |
| PowerShell blocks scripts | Use `npm.cmd` and `socrates.cmd` |
| Unexpected HUD or wireframes | Clear `HABITAT_DEBUG*` shell overrides and launch without `--debug` |
| Build or logging failure | Check the reported error, disk space, and directory permissions; `SOCRATES_LOG_DIR` can select another log directory |
| Extension: no **Socrates** commands | Confirm the extension is enabled; **Ctrl+Shift+P** and search `Socrates`; reload the window once after install or update |
| Extension: Start fails | Run **Socrates: Show Diagnostics**; ensure **WebView2** is installed; rebuild with `npm run package:win` if the bundled `companion.exe` is missing or stale |
| Extension: no debug HUD | Enable **Socrates › Debug: Enabled** (or `socrates.debug.enabled`); **Stop**, then **Start** — settings apply on spawn, not while attached |

## Development

The application is in `companion/`; its required artwork and manifest are in `assets/pets/default-cat/`. Both directories are needed for a source build. Keep both dependency lockfiles for reproducible installs.

From `companion/`:

```powershell
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm run build` builds the frontend only. Release native binary: `npm run tauri:build:release` (see [companion README](companion/README.md)).

### Project layout

| Path | Purpose |
|---|---|
| `companion/` | Tauri host, launcher (`socrates`), pet frontend, Windows UIA |
| `assets/pets/default-cat/` | Sprites and `pet.json` (bundled by Vite) |
| `extension/` | VS Code UI extension (Windows x64 VSIX); see [extension/README.md](extension/README.md) |
| `extension/media/` | Marketplace icon; maintainer screenshot spec (`README.md` not in VSIX) |
| `docs/` | Architecture and images |
| [vsc-ext.md](vsc-ext.md) | Extension implementation tracker (phases 0–7) |

See [architecture](docs/architecture.md) and [changelog](CHANGELOG.md).

### Extension packaging

Published builds ship from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GeneralChromodynamics.socrates-the-cat). To package a local **VSIX** (contributors or Cursor), use **desktop VS Code on Windows** (VS Code 1.74+). The extension runs locally (`extensionKind: ui`); it does not start Socrates inside remote SSH/WSL sessions until that is explicitly tested and documented.

**Build and package** (from repo root; needs a release `companion.exe`):

```powershell
cd companion
npm run tauri:build:release
cd ..\extension
npm ci
npm test
npm run package:win
```

`npm run package:win` runs `npm ci` and `tauri:build:release` in `companion/` by default (`package:win:fast` skips the native rebuild). Output: `extension/stage/socrates-the-cat-*-win32-x64.vsix` and `extension/stage/bundle-manifest.json` (versions and sha256).

**Install VSIX:** Extensions → **…** → **Install from VSIX** → select the VSIX under `extension/stage/`. Open the **Command Palette** (**Ctrl+Shift+P**):

- **Socrates: Start** — launch or attach to the managed cat (targets VS Code via `HABITAT_IDE_HOST=code`)
- **Socrates: Stop** — stop the shared managed instance for this session
- **Socrates: Show Diagnostics** — pipe status, companion path, managed log directory (`%LOCALAPPDATA%\Socrates\logs\vscode-managed`)

**Coexistence:** `socrates` from a clone and the extension-managed cat are independent. Multiple VS Code windows can attach to one managed instance; closing a window releases that window’s ownership (the cat stays up while another window remains attached). **Stop** shuts down the shared managed instance for the session.

**Not yet validated:** Remote SSH/WSL/container UI, upgrade/uninstall with several windows open, or a clean machine with no Node/Rust installed (VSIX ships the native binary). See [vsc-ext.md](vsc-ext.md) Phase 5–6 gaps.

**Extension development (F5):** open this repo in VS Code → **Run and Debug** → **Socrates extension**. Uses the release binary at `companion/src-tauri/target/release/companion.exe` when no bundled exe is present.

Implementation status and release checklist: [vsc-ext.md](vsc-ext.md).

Issues and PRs are welcome. Bug reports should include Windows and IDE versions, launch command, steps to reproduce, session ID, and relevant **reviewed/redacted** logs. Report suspected security vulnerabilities privately to [generalchromodynamics@protonmail.com](mailto:generalchromodynamics@protonmail.com).

## Roadmap

- Open VSX publish (Cursor in-app Extensions search)
- Refined animations
- Linux and Mac support

## License and contact

Source code: [MIT](LICENSE). Cat artwork and animation metadata: [artwork license](assets/pets/LICENSE.md), including attribution for public redistribution.

**General Chromodynamics** — [generalchromodynamics.com](https://generalchromodynamics.com/) · [generalchromodynamics@protonmail.com](mailto:generalchromodynamics@protonmail.com)

Optional support for development: [Buy Me a Coffee](https://buymeacoffee.com/generalchromodynamics). Tips are voluntary; source and artwork stay under the licenses above.
