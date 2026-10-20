# Changelog

Notable user-facing changes. This project is an unreleased source preview.

## Unreleased

- Fix fall freeze: any ledge crossed during a fall now lands the cat (fast falls were rejected for overshooting by >8 px, passed through every ledge, and stuck at the window bottom). Empty UIA snapshots no longer interrupt the land clip or teleport a falling cat to the center ledge, and a fall that starts below every ledge (e.g. switching to a shorter IDE window) lands on the status bar.
- Fix cat jumping mid-window every ~30 s: full and cached UIA scans now pick the same `StatusBar` element (the wide one flush with the window bottom), so `platform-statusbar-top` no longer flips to a mid-window status bar on each full scan.
- Fix ~45 s stale layout and unresponsive cursor reactions after switching IDE windows: UIA now resolves the new window directly with `ElementFromHandle` (exact HWND validated, same subtree as before) instead of searching every desktop window, which could stall behind an unresponsive app. Connection time is logged separately as `surface-mapper/uia_connect`.
- Fix cat teleport when the tracked IDE HWND changes: drop attachment and fall instead of re-binding `platform-statusbar-top` (and other stable ids) in the new window’s local coordinates while idle, asleep, or in `await_geometry`.
- README and `.github/FUNDING.yml` link optional [Buy Me a Coffee](https://buymeacoffee.com/generalchromodynamics) support for General Chromodynamics.
- Restore documented install flow: `npm ci`, `npm link`, then `socrates` as the primary path (`npm start` remains the no-link alternative).
- Windows companion for VS Code and Cursor, using live UI Automation geometry and a click-through Tauri overlay. Follows foreground windows of the IDE selected at launch.
- Animated walking, grooming, stretching, pointer reactions, sleep and dreams, falling, split clinging, divider slides, and portal travel.
- `socrates` launcher via `npm link`, with `npm start` and `--debug` alternatives; daily activity journal and rotating local diagnostic logs.
- Monotonic animation clock with a visibility-aware fallback, plus regression coverage for launcher shutdown, logging, geometry, and pet behavior.
- Public source metadata, MIT code license, separate artwork terms, and production/development content security policies.
- Consolidated installation and developer documentation, locked npm installation, current Node guidance, and advice for sharing logs safely.
- Pre-public hardening: restrict Vite dev `fs.allow` to companion + pet assets, narrow runtime log retention to `journal-YYYY-MM-DD` filenames only, and drop unused Tauri window capabilities from the webview.

### Known limitations

- After a tracked IDE window change, bottom-of-window fall recovery can still snap the cat upward to a higher status bar; preventing cross-window attachment rebinding does not eliminate this separate jump.
- Windows only; installation requires a source checkout and the Node/Rust build toolchains. No published installer or IDE extension.
- Broader VS Code layout testing is still needed. A previously reported startup animation pause has a fallback in place, but its effectiveness across cold starts remains unconfirmed.
