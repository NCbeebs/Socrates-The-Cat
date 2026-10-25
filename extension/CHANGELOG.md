# Change Log

Extension-only releases. See the [repository CHANGELOG](../CHANGELOG.md) for the full project.

## 0.1.1

- Phase 7 cleanup: native mutex/SID lifetime fixes, journal flush on Tauri exit, pipe connect/response cleanup and deadlines, packaging clears stale `out/` before compile.
- Marketplace upload requires a new version (0.1.0 `win32-x64` package cannot be replaced).

## 0.1.0

- Initial VS Code UI extension: **Socrates: Start**, **Stop**, and **Show Diagnostics**.
- Windows x64 VSIX bundles release `companion.exe`; managed lifecycle via session-scoped pipe and logon-SID DACL.
- First Marketplace upload (0.1.0); superseded by 0.1.1 for updated bits.
