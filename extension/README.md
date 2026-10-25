# Socrates the Cat

A desktop cat that walks the real tab strips, panel edges, and status bar in **VS Code**. He grooms, sleeps, dreams, reacts to your pointer, and falls when his ledge disappears. You can **click-and-hold to pick him up** and drop him on another ledge when he blocks your code. The overlay stays click-through so you can keep working.

This **Windows desktop extension** starts, stops, and diagnoses the managed native companion (`companion.exe`). It does **not** replace the GitHub clone workflow - contributors still use `socrates` from `companion/`. Built with **Tauri 2, Rust, TypeScript, Vite, and Windows UI Automation** (same pet and binary as the [source repo](https://github.com/NCbeebs/Socrates-The-Cat)).

| Path | Who it is for | How you run Socrates |
|---|---|---|
| **This extension** | Desktop VS Code on Windows x64 without the clone launcher | Install a VSIX ([below](#install-local-vsix)); **Command Palette** → **Socrates: Start** / **Stop** / **Show Diagnostics** |
| **GitHub clone** | Contributors and source users | `npm link` → `socrates` in the IDE terminal ([install on GitHub](https://github.com/NCbeebs/Socrates-The-Cat#install-and-run)) |
| **Marketplace** | Everyone (future) | **Not published yet** - local VSIX only for now |

Clone and extension both use the same native companion and pet assets. The extension does not replace or block the clone workflow.

## Demo

![Socrates sleeping, dreaming, and waking on an IDE ledge](https://github.com/NCbeebs/Socrates-The-Cat/raw/main/docs/images/socrates3.gif)

**Pointer play** (overlay stays click-through to the IDE):

![Batting and pouncing at the cursor](https://github.com/NCbeebs/Socrates-The-Cat/raw/main/docs/images/socrates2.gif)

**Portal hop** (rare - emerges on another walkable ledge):

![Walking through a portal to another ledge](https://github.com/NCbeebs/Socrates-The-Cat/raw/main/docs/images/socrates1.gif)

**Pick up and move** - click-and-hold (~250 ms) inside Socrates's pointer-reach area, then drag and release. The reach box matches swipe/pounce (yellow outline with `socrates --debug` from a clone launch). Release lands him on the next walkable ledge below his feet. Clicks still pass through to the editor; dragging may select text underneath.

He also walks and turns at ledge ends, stretches, grooms, sits and looks at the pointer, clings to moving horizontal splits, and slides down dividers. Activities and clips are in [`pet.json`](https://github.com/NCbeebs/Socrates-The-Cat/blob/main/assets/pets/default-cat/pet.json).

**Developer layout overlay** (`socrates --debug` from the clone launcher; extension managed mode uses the same companion without requiring `--debug`):

![socrates --debug: ledge wireframes, pointer reach box, HUD, and terminal diagnostics](https://github.com/NCbeebs/Socrates-The-Cat/raw/main/docs/images/debug.png)

## Requirements

| Component | Requirement |
|---|---|
| OS / IDE | **Windows 10/11** with **desktop VS Code 1.74+** (x64, UI extension) |
| Runtime | **WebView2** (same as Tauri/WebView2 apps) |
| Remote hosts | **Remote SSH / WSL / dev container** UI not validated yet |

## Install (local VSIX)

From the repo root, after building the native binary:

```powershell
cd companion
npm run tauri:build:release
cd ..\extension
npm ci
npm run package:win
```

Install `extension/stage/socrates-the-cat-*-win32-x64.vsix` via **Extensions → … → Install from VSIX**.

`npm run package:win` rebuilds the native binary by default (`package:win:fast` skips that step). Output includes `extension/stage/bundle-manifest.json` (versions and sha256). Packaging does **not** run `git commit`, `git push`, or `vsce publish`.

## Commands

Open the **Command Palette** (**Ctrl+Shift+P**):

- **Socrates: Start** - launch or attach to the managed cat (targets VS Code via `HABITAT_IDE_HOST=code`)
- **Socrates: Stop** - stop the shared managed instance for this session
- **Socrates: Show Diagnostics** - pipe status, companion path, managed log directory (`%LOCALAPPDATA%\Socrates\logs\vscode-managed`)

**Coexistence:** `socrates` from a clone and the extension-managed cat are independent. Multiple VS Code windows can attach to one managed instance; closing a window releases that window's ownership (the cat stays up while another window remains attached). **Stop** shuts down the shared managed instance for the session.

## Logs and troubleshooting

Managed runs log to `%LOCALAPPDATA%\Socrates\logs\vscode-managed` (`SOCRATES_LOG_DIR`). Source `socrates` launches keep using `%LOCALAPPDATA%\Socrates\logs` unless overridden.

| Symptom | Try |
|---|---|
| No **Socrates** commands | Confirm the extension is enabled; **Ctrl+Shift+P** and search `Socrates`; reload the window once after installing a VSIX |
| Start fails | Run **Socrates: Show Diagnostics**; ensure **WebView2** is installed; rebuild with `npm run package:win` if the bundled `companion.exe` is missing or stale |

More diagnostics: [GitHub README - troubleshooting](https://github.com/NCbeebs/Socrates-The-Cat#diagnostics-and-troubleshooting).

## Privacy

No extension telemetry. Diagnostics read the local named pipe and print paths/status to an output channel only. The native companion reads IDE layout via UI Automation (geometry only, not editor text). Review logs and recordings before sharing them.

## License and contact

The extension package is **MIT** ([LICENSE](LICENSE)). Cat artwork and animation metadata: [artwork license](https://github.com/NCbeebs/Socrates-The-Cat/blob/main/assets/pets/LICENSE.md) (attribution for public redistribution). The bundled `companion.exe` embeds sprite artwork under those terms.

**General Chromodynamics** - [generalchromodynamics.com](https://generalchromodynamics.com/) · [generalchromodynamics@protonmail.com](mailto:generalchromodynamics@protonmail.com)

Optional support for development: [Buy Me a Coffee](https://buymeacoffee.com/generalchromodynamics). Tips are voluntary; source and artwork stay under the licenses above.

Report suspected security vulnerabilities privately to [generalchromodynamics@protonmail.com](mailto:generalchromodynamics@protonmail.com).
