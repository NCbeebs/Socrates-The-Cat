# Change Log

Extension-only releases. See the [repository CHANGELOG](../CHANGELOG.md) for the full project.

## 0.1.2

- Habitat debug parity: `socrates.debug.enabled` / `.surfaces` / `.hud` / `.streamJournal` (application scope), managed spawn env scrub + `--debug`, Show Diagnostics requested/applied/unknown, optional journal tail to the **Socrates** output channel.
- Journal stream: serialized tail reads, correct offset accounting, primary-file-only watcher, EOF startup, richer error lines; Start only opens stream after attach; spawn diagnostics committed only after validated spawn+attach.
- Journal tail: byte offsets advance by `bytesRead`; UTF-8 byte carry; no mtime-based EOF skip on append; instance id (`birthtime` + `ino`) with stat refresh on rotation; idempotent create/init; truncation clears line and byte carry.

## 0.1.1

- Phase 7 cleanup: native mutex/SID lifetime fixes, journal flush on Tauri exit, pipe connect/response cleanup and deadlines, packaging clears stale `out/` before compile.
- Marketplace upload requires a new version (0.1.0 `win32-x64` package cannot be replaced).

## 0.1.0

- Initial VS Code UI extension: **Socrates: Start**, **Stop**, and **Show Diagnostics**.
- Windows x64 VSIX bundles release `companion.exe`; managed lifecycle via session-scoped pipe and logon-SID DACL.
- First Marketplace upload (0.1.0); superseded by 0.1.1 for updated bits.
