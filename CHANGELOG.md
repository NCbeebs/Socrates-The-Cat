# Changelog

Notable changes only. Session notes and no-code reviews are omitted.

## Unreleased

### Docs

- README roadmap narrowed to refined animations and Linux/Mac support.

### Public release prep

- MIT `LICENSE`; `license` in `companion/package.json` and `companion/src-tauri/Cargo.toml`
- Tauri: `com.ncbeebs.socrates` identifier, strict CSP + `devCsp`, `withGlobalTauri` off
- Product naming: “Socrates the Cat” in `tauri.conf.json`, overlay title, and `index.html`
- Root `.gitattributes`; `.cursor/` gitignored and removed from the index (local-only)
- Public tree trim: removed `scripts/`, Phase 0 matrix, 1k-line research spec, `habitat_probe`, `.vscode`, unused art; slim READMEs; added `docs/architecture.md`
- Artwork terms (`assets/pets/LICENSE.md`); demo GIFs `docs/images/socrates3.gif`, `socrates2.gif`; project metadata and contact

### Launcher & logging

- `socrates` command (`npm link` from `companion/`); `npm start` / `npm run debug`
- Normal launch: daily activity journal; debug: HUD-style dev output
- JSONL diagnostics under local Socrates log dir (rotation, 14-day retention)
- **Verbose diagnostics (`HABITAT_DEBUG_LOG` / `--debug`):** `debug` log level on the existing `@socrates-log` bus; coalesced geometry/UIA summaries, overlay visibility, startup config, native runtime ready, frontend first-frame (after draw) and coalesced geometry delivery; session ID and three log file families in the launcher header; `HABITAT_DEBUG_LOG=1` shows structured terminal lines without HUD or raw tool output
- Verified Windows shutdown coverage includes descendant processes.

### Companion (Windows)

- **IDE host:** Session tied to the launch app (`HABITAT_IDE_HOST`: `code` / `cursor` / `auto`); Rust ancestry at startup; follows that app’s foreground windows (not a single HWND lock). Invalid env values warn and fall back to Cursor.
- **VS Code UIA:** 4px sashes, semantic `monaco-sash` (disabled sashes excluded from generic heuristics), editor `tabs-container` over terminal tabs, tree depth 16; exact HWND match for live geometry.
- **Overlay:** `visible: false`, `focus: false`, `focusable: false`; size/position before `show()`.
- **Pet loop:** `pet-loop-clock.ts` — one monotonic clock, visibility-gated `requestAnimationFrame` fallback when WebView2 throttles.
- **Tests:** 41 JS + 15 Rust; `npm test` uses Node `--experimental-strip-types` (use Node 22+ for the test script).

### Docs

- Root README and [companion/README.md](companion/README.md): VS Code + Cursor, `HABITAT_IDE_HOST`, env tables; [docs/architecture.md](docs/architecture.md) for geometry and pointer flow.

### Pet (`pet.json` / `HabitatPet`)

- **Sit and look:** `Socs-sit_and_look.png`, gaze cells + angle fixes
- **Divider slide:** `Socs-sliding.png` — walk endpoint → slide down wall to lower ledge
- **Pointer:** swipe batter on `Socs-swipe-right`; follow-up pounce on `Socs-pounce-2` toward cursor X on ledge
- **Sleep:** `dream_comfy`; stretch bookends; sleep exit via `sleep_exit` only; annoyed overlay when poked while sleeping
- **Portal:** can open mid-walk (exit still on another ledge)
- **Idle pool:** activity `cooldownMs`, idle blink hold, groom weights, weight rebalance (idle/walk/groom/sit/sleep)
- **Misc:** stretch hold cell 9; pounce contact pivots; cat clamped inside IDE (8px margin); removed manifest `nested[]` engine and `chromaKey`

### Art (not always committed)

- Edits to falling, grooming, pounce, maximum comfy, slide sheets (backups under `out/artwork/`)

### Companion

- Known VS Code issues: test-runner compatibility with documented Node 20 support remains open. A reported startup animation pause clears after pointer interaction; its runtime cause and the mitigation's cold-start effectiveness remain unconfirmed.
- Terminal journal + Rust/TS diagnostic hooks
- Dropped unused opener plugin and starter SVGs; sash matcher dead exports removed
- Retained SVG clip renderer (from 10-17)

---

## 2026-10-17

- **Pointer:** cached Cursor PIDs; swipe custom playback; reach AABB + crossing; sleep annoyed overlay; facing only when cursor near
- **Sash / fall:** horizontal sash cling (`Socs-hang-vertical`); downward sash / ledge drop → shared `Socs-falling` clip; landing tolerance tweaks
- **Portal:** `portal_open` / `portal_exit` clips; walk-time open roll
- **Groom:** `Socs-grooming.png`, `-2`, `-3` weighted activities
- **Geometry:** adaptive 50 ms / 500 ms UIA poll; `habitat-surfaces` + `scanSequence`; live session cache per HWND
- **Renderer:** reuse SVG image/clip nodes per frame (flicker fix)

---

## 2026-10-16

- **Walk:** `Socs-turning.png`, distance-locked frames, `stridePixelsPerLoop`, 128×128 cells, pivot Y 115
- **Revision:** bump only on layout/HWND change (not every poll)
- **Sleep:** weighted activity on `Socs-sleep.png` (enter → dream → exit)
- **Dreams:** `dream_birds` / `dream_mice` segmented loops; stretch pre/post sleep
- **Docs:** spec §9 per-clip contract; cursor rules for art/activities

---

## 2026-10-15

- **Phase 1–2 spike (Windows / Cursor):** live UIA overlay, foreground HWND, idle/walk pet, read-only pointer pounce
- **Debug:** `HABITAT_DEBUG*` + `tauri:dev` vs `tauri:dev:debug` (presentation only)
- **Assets:** per-clip PNGs + `pet.json` v2; `pet-clips` glob from `assets/pets/default-cat/`
- **Phase 0:** `scripts/inspect-uia.ps1`, compare, surfaces → `out/`
- Restored runnable spritesheet placeholder after art experiment; later moved to per-clip pipeline same week
