# Changelog

Notable user-facing changes. This project is an unreleased source preview.

## Unreleased

- Fix fall landing freeze: crossing-based landing with `establishFallLanding()` (snap foot to ledge Y instead of rejecting overshoot), continue the land clip when `collectLedges` omits the contact ledge, and treat the IDE window bottom (`habitat:window-floor`) as a real walkable surface (HWND swaps fall to floor; ordinary falls use UIA ledges then floor; no timed recovery teleport or missing-ledge re-home).
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

- HWND swaps intentionally drop UIA support and fall to the window floor; horizontal position is preserved within the new window bounds.
- Windows only; installation requires a source checkout and the Node/Rust build toolchains. No published installer or IDE extension.
- Broader VS Code layout testing is still needed. A previously reported startup animation pause has a fallback in place, but its effectiveness across cold starts remains unconfirmed.
