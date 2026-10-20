# Changelog

Notable user-facing changes. This project is an unreleased source preview.

## Unreleased

- Opt-in launcher update check: set `SOCRATES_CHECK_UPDATES=1` to compare a `main` checkout to upstream GitHub on launch (cached 24h), or run `socrates --check-updates` for an explicit check without starting the app. Every mode honors GitHub-imposed waits (`retry-after`, rate-limit reset, then exponential backoff from one minute), and they persist across pulls. Requests time out after 8 s, including the response body, and are cancelled when Socrates exits. Responses are capped at 2 MB. Redirects are followed manually and only within api.github.com, each destination checked before it is requested. Rate-limit headers are processed without reading the error body, and waits count from when the response arrives. A cross-process lock keeps concurrent launches from making parallel requests or erasing each other's waits; the background check skips while another check holds it. The lock carries an owner token and a 5 s heartbeat, so only a lock untouched for 30 s is reclaimed. Reclaiming renames the lock away and verifies it; release deletes the lock only if it still holds that token. A check whose lock was taken over sends no request, and filesystem errors stop the check instead of running unlocked or retrying in a loop. Out-of-range cached timestamps are discarded. The branch override and git output are validated and URL-encoded, the "see changes" link is built locally, terminal control sequences are stripped from output, and the cache is pruned and written atomically.
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

- Existing clones must pull once to receive the update checker and enable automatic checks with `SOCRATES_CHECK_UPDATES=1`; notices appear on a subsequent launch after cache expiry. `socrates --check-updates` requests an explicit check without enabling automatic checks.
- Update-check lock recovery uses a 30 s stale threshold. A paused or delayed live process can also miss heartbeats. Concurrent reclamation can lose mutual exclusion if restoring a displaced lock fails, including when another process recreates the path on a filesystem that supports hard links. A check that notices the loss before its request sends nothing; requests already in flight finish. Cache writes after ownership loss attempt to preserve the later wait but are best effort, not atomic across processes.
- Connection timing diagnostics currently bypass the debug-log setting, and failed connection attempts omit elapsed time.
- After a tracked IDE window change, bottom-of-window fall recovery can still snap the cat upward to a higher status bar; preventing cross-window attachment rebinding does not eliminate this separate jump.
- Windows only; installation requires a source checkout and the Node/Rust build toolchains. No published installer or IDE extension.
- Broader VS Code layout testing is still needed. A previously reported startup animation pause has a fallback in place, but its effectiveness across cold starts remains unconfirmed.
