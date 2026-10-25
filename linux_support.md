# Linux support: research and implementation plan

Research date: 2026-10-24. Code reviewed: `e331f71`. Status: proposal; Linux support is not implemented or runtime-validated.

## Recommendation and support boundary

Keep one Tauri/Rust/TypeScript application, one pet state machine, and one set of sprites. Add Linux implementations at the native desktop boundaries. Preserve the working Windows implementation and use its current behavior as the regression baseline.

**X11 is the smallest credible first implementation. KDE Plasma on Wayland is the intended CachyOS destination, subject to an early feasibility gate.** The desktop/session preference remains unconfirmed. An X11 milestone must be described as X11 support, not general CachyOS or native Wayland support.

CachyOS offers multiple desktops and window managers, including both X11 and Wayland options; the distribution name alone does not define the integration API. KDE has announced that Plasma 6.8 will remove the X11 session, so a long-term KDE plan cannot depend on an X11 login session remaining available. The installed Plasma version and session must be recorded during validation. [CachyOS desktop choices](https://wiki.cachyos.org/installation/desktop_environments/), [KDE's Wayland roadmap](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/).

| Environment | Proposed status | Main condition |
|---|---|---|
| Windows 10/11, VS Code and Cursor | Preserve existing support | Existing Win32/UIA behavior and defaults pass regression checks |
| Arch/CachyOS, actual X11 session with a compositing, EWMH-compatible window manager | First Linux milestone | X11 tracking, AT-SPI geometry, transparency, and click-through all pass |
| Arch/CachyOS, KDE Plasma Wayland | Intended second milestone; feasibility unproven | KWin integration supplies tracking, passive pointer/buttons, and reliable overlay placement |
| Wayland session, both applications using Xwayland | Experimental compatibility case | Verify focus, pointer/buttons, scaling, and overlay behavior on the named compositor |
| Other Wayland compositors | Outside initial implementation | Require a separately validated integration |

Scope is local, unsandboxed IDE processes and source launches on x86_64 Linux. Flatpak/Snap IDE sandbox integration, remote graphical sessions, installers/AUR publication, macOS, and a replacement renderer are outside this plan. A local IDE connected to a remote workspace still has local window chrome; launching Socrates inside an SSH/container terminal is a separate process-discovery case.

## What the current code actually requires

The root [README](README.md) correctly describes a Windows source preview. Existing `cfg(windows)` blocks are useful boundaries, but they do not constitute Linux support: the other branches return no window and no pointer, and no live mapper starts.

Source locations below use `startLine:endLine:filepath` and refer to the reviewed revision.

| Subsystem and evidence | Linux work | Preserve/reuse |
|---|---|---|
| [Cargo dependencies](companion/src-tauri/Cargo.toml), `24:35:companion/src-tauri/Cargo.toml`: `windows` and `uiautomation` are unconditional dependencies | Put these under a Windows target dependency table; add only selected Linux dependencies under a Linux target table | Existing dependency versions and shared Tauri/serde/chrono dependencies |
| [Host selection](companion/src-tauri/src/ide_host.rs), `20:94:companion/src-tauri/src/ide_host.rs`: Windows executable matching; ancestry disabled elsewhere | Enable tested Linux ancestry and executable identity matching | `HABITAT_IDE_HOST`, nearest-ancestor selection, explicit override, existing Windows matching/default |
| [Window tracking](companion/src-tauri/src/lib.rs), `670:1016:companion/src-tauri/src/lib.rs`: Win32 foreground window, PID matching, bounds, enumeration, focus debounce | X11/EWMH provider; KWin provider for the selected Wayland session | Foreground versus largest-window semantics, own-overlay exclusion, Windows timing/cache behavior |
| [Geometry mapper](companion/src-tauri/src/surface_mapper.rs), `5:792:companion/src-tauri/src/surface_mapper.rs`: exact HWND lookup, UIA roles/classes/rectangles, cached nodes | AT-SPI accessibility reader and Linux-specific element classification | Surface output shape, existing role/ID conventions, bounded scans, exact target-window requirement |
| [Live worker](companion/src-tauri/src/lib.rs), `389:555:companion/src-tauri/src/lib.rs`: Windows-only worker, 500 ms idle / 50 ms active / 30 s full scan | Select a real mapper on Linux; bound D-Bus work and reconnect after invalidation | Revision/sequence semantics and current Windows scan algorithm |
| [Pointer sampling](companion/src-tauri/src/lib.rs), `305:337:companion/src-tauri/src/lib.rs` and `784:825:companion/src-tauri/src/lib.rs`: global position and swap-aware primary button | X11 query-pointer state or a proven compositor input observer | Read-only input, coordinates nullable outside IDE, independent release state, observation time |
| [Overlay synchronization](companion/src-tauri/src/lib.rs), `351:387:companion/src-tauri/src/lib.rs` and `619:657:companion/src-tauri/src/lib.rs` | Validate Linux placement, scale, focus, stacking, transparency, and empty input region | Initial hidden/nonfocusable window and 200 ms Windows synchronization |
| [Frontend IPC](companion/src/main.ts), [pet types](companion/src/pet/types.ts), [pet behavior](companion/src/pet/habitat-pet.ts), [sash matcher](companion/src/pet/sash-matcher.ts): `targetHwnd` flows into freshness, carry, portal, slide, attachment checks, and sash-track resets | A coordinated neutral window-identity name; no OS branches in pet behavior | All identity comparisons, zero sentinel, animation decisions, 50 ms pointer polling, monotonic animation clock |
| [Launcher](companion/bin/socrates.js), `115:225:companion/bin/socrates.js`: Windows tree termination; other systems signal only the direct CLI child | Owned Linux process-group shutdown and descendant coverage | Windows `taskkill` path, streamed logs, update cancellation, exit behavior |
| [Storage](companion/bin/socrates.js), [update checker](companion/bin/check-updates.js), [native logger](companion/src-tauri/src/runtime_log.rs): inconsistent non-Windows defaults | One Linux path policy for launcher/direct native runs and persisted update state | Windows paths, explicit log override, rotation/retention, update locking/backoff |

The frontend already scales native local coordinates to the SVG viewport using `windowLocalRect`; both surfaces and pointer samples must use that same native coordinate space. It is not necessary to replace the SVG renderer, animation clock, sash-matching algorithm, journal, manifest, or artwork. The manifest's 30 clip references matched on-disk filenames case-sensitively in this review. WebKitGTK rendering and bundled asset loading still need Linux verification.

## Linux equivalents and research findings

### X11: close equivalents exist

Use X11/EWMH directly from Rust, with `x11rb` as the initial candidate. Maintain connections instead of launching command-line tools on every pointer sample. Its current upstream API provides X11 requests and events. [x11rb documentation](https://docs.rs/x11rb/latest/x11rb/).

| Windows operation | X11 equivalent / implementation direction |
|---|---|
| `GetForegroundWindow` | Read `_NET_ACTIVE_WINDOW`; verify the target belongs to the selected IDE |
| `EnumWindows`, PID matching | `_NET_CLIENT_LIST` / stacking list plus `_NET_WM_PID`, `WM_CLASS`, and process identity |
| `GetWindowRect` | X11 geometry and translation to root coordinates; account explicitly for client/frame decoration offsets |
| Visible/current target | Mapped state, minimized state, current workspace, destruction, and focus notifications |
| `GetCursorPos` | `QueryPointer` root or target-window coordinates |
| `GetAsyncKeyState` plus swapped primary button | Logical button state from `QueryPointer`; validate left-handed/device mappings |
| Always-on-top/click-through overlay | Tauri/GTK window hints and input region, tested against the chosen window manager |

EWMH defines the active window, client lists, process hints, frame extents, desktops, and stacking state. These are window-manager conventions, so support must be checked at connection time. A PID alone cannot distinguish two IDE windows. [EWMH specification](https://specifications.freedesktop.org/wm/latest-single/). Arch's `XQueryPointer` manual documents both coordinate results and logical button-state masks; a stale/destroyed window can produce an error. [Arch XQueryPointer manual](https://man.archlinux.org/man/XQueryPointer.3.en).

Useful diagnostic equivalents are `wmctrl -lpGx`, `xprop`, and `xdotool getactivewindow` / `getmouselocation --shell`. They help inspect identities and geometry; they do not expose IDE tab strips or split dividers. They are investigation tools, not the proposed polling architecture. [Arch wmctrl manual](https://man.archlinux.org/man/wmctrl.1.en), [Arch xdotool manual](https://man.archlinux.org/man/xdotool.1.en).

### UI Automation becomes AT-SPI, with an evidence gate

Arch supplies `at-spi2-core`, whose accessibility protocol uses D-Bus. The Rust `atspi` crate is a candidate client. Use the accessibility bus discovered through the session bus, not an assumed system-bus endpoint. [Arch package](https://archlinux.org/packages/extra/x86_64/at-spi2-core/), [atspi crate](https://docs.rs/atspi/latest/atspi/).

AT-SPI's Component interface supplies element bounds, and its coordinate types distinguish screen from top-level-window coordinates. Bounds are meaningful for visible/showing components. Prefer window-relative geometry when available; establish the actual origin and units experimentally. Neither this API nor its screen-coordinate option guarantees useful global coordinates from every Wayland application. [Component API](https://docs.gtk.org/atspi2/iface.Component.html), [coordinate types](https://docs.gtk.org/atspi2/enum.CoordType.html).

**The unresolved issue is element coverage.** The Windows mapper relies on `monaco-sash`, disabled/orientation classes, editor-versus-terminal tab classes, and UIA `Group`, `Tab`, `Tree`, and `StatusBar`. AT-SPI is not a one-to-one projection of that tree. Before implementation, inspect both Linux IDEs for:

- Horizontal/vertical split dividers, including disabled and resized dividers.
- Editor tab strips versus activity-bar and terminal tabs.
- The bottom status bar versus similarly named nested elements.
- Explorer/panel boundaries, visibility changes, zoom, and custom/native title bars.
- An unambiguous association between the desktop window and its accessible top-level object when one process owns several windows.

Accessibility activation is also part of the experiment. Electron can expose its accessibility tree, and Chromium documents Linux inspection plus `--force-renderer-accessibility`. Test whether the actual VS Code/Cursor builds need an explicit launch flag or preference and record any effect on editor behavior. Socrates should diagnose a missing tree; it should not silently restart or reconfigure the IDE. [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility), [Chromium inspection tools](https://www.chromium.org/developers/accessibility/testing/automated-testing/ax-inspect/).

Collect only roles, necessary structural attributes, bounds, visibility, and identity metadata. Do not introduce text/value extraction or window-title logging to solve matching. If necessary surfaces are absent, stop the parity claim. A reduced-layout mode would be a separate product decision; static surfaces or guessed panel percentages do not replace live IDE geometry. An IDE extension is not automatically a solution to access to internal editor chrome and would need separate research.

### Wayland: three independent problems

1. **Tracking other windows:** core Wayland does not provide the Win32/EWMH discovery model used here. A selected compositor must supply identity, geometry, activation, workspace, and lifecycle information.
2. **Observing input while remaining click-through:** core pointer events are relative to the focused surface. An overlay with no input region cannot use its own DOM pointer handlers to observe input destined for the IDE. [Wayland pointer protocol](https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_pointer).
3. **Placing the overlay:** the locked Tao version, `0.37.1`, documents native Wayland limitations for absolute positioning, always-on-top, and cursor-position queries. Simply implementing AT-SPI and enabling Tauri's Linux target will not fix those calls. [Tao 0.37.1 window API](https://docs.rs/tao/0.37.1/tao/window/struct.Window.html).

For KDE, investigate one narrowly scoped KWin bridge. The documented workspace/window APIs expose activation, geometry, native identity, and cursor position. The effects API additionally documents `mouseChanged` with button state and mouse polling. **A normal KWin window-management script must not be assumed to have the same input capabilities as an effect.** Confirm the installed API, non-consuming input behavior, and whether an effect/plugin is necessary. These are candidate mechanisms, not a verified ready-made replacement. [KWin API](https://develop.kde.org/docs/plasma/kwin/api/).

The bridge must provide all of: exact target identity/bounds/focus, cursor plus logical primary-button state, and an overlay-placement strategy. Start the feasibility test with compositor-managed positioning/stacking of a normal Socrates window. If that fails, evaluate GTK layer-shell integration before choosing an implementation. Layer-shell provides a different surface role for desktop overlays; compatibility with Tauri's window-creation lifecycle and multi-output placement must be proven. Do not assume it can be retrofitted onto an already initialized window. [GTK layer-shell project](https://github.com/wmww/gtk-layer-shell).

Keep any accepted bridge in this repository and Linux-only. It should transport bounded geometry/input snapshots, with connection identity, ordering, timeout, reconnect, and install/uninstall ownership. It must not contain a second pet renderer or animation engine. Loss of the bridge must invalidate the target and cancel held-input state. A separate bridge is justified only by a proven compositor requirement.

The InputCapture portal is not a passive substitute: active capture routes input to the capturing application instead of normal pointer handling. It would change the interaction contract. Similarly, input injection and direct privileged device access do not solve this read-only desktop-overlay design. [InputCapture portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.InputCapture.html).

Xwayland runs X11 clients within a Wayland session; it does not turn native Wayland windows into X11 windows. Forcing only Socrates to X11 cannot provide X11 discovery of a native Wayland IDE. Even when both run under Xwayland, test global input, focus transitions, and scaling rather than assuming full X11 equivalence. [Arch Xwayland manual](https://man.archlinux.org/man/Xwayland.1), [Wayland's X11 integration documentation](https://wayland.freedesktop.org/docs/book/Xwayland.html).

Hyprland has its own IPC rather than KWin's API. Supporting it would be another backend and another validation matrix; defer it unless chosen as the primary desktop. [Hyprland IPC](https://wiki.hypr.land/IPC/).

### Build, launch, and storage

Tauri's Arch prerequisites include WebKitGTK 4.1 and native build packages. Use a current, fully updated Arch/CachyOS installation with the existing Node requirement and a Linux Rust toolchain. The upstream baseline command is:

```sh
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

This is a setup reference, not a command run during this review. AT-SPI and any selected compositor integration have additional requirements. Keep runtime requirements separate from optional inspectors (`accerciser`, `wmctrl`, `xorg-xprop`). Pin new Rust dependencies after the feasibility test; do not upgrade the working Windows stack as part of the port. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux), [Cargo target dependencies](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#platform-specific-dependencies).

Proposed Linux storage policy: logs in `${XDG_STATE_HOME:-$HOME/.local/state}/socrates/logs`; the existing update-check file and lock in the same `socrates` state directory. Although named a cache, that file also persists server-imposed waits, so keeping it as state avoids splitting its locking/backoff mechanism. Honor `SOCRATES_LOG_DIR` exactly as today. Ignore empty/relative XDG base overrides according to the specification; launcher and direct native launches must agree. Preserve all Windows path behavior. [XDG Base Directory specification](https://specifications.freedesktop.org/basedir/latest/).

On Linux, launch the CLI in an owned process group, retain supervision and output pipes, and forward shutdown to that group with bounded escalation. Node documents `detached` process-group creation on non-Windows systems; this needs a Linux-only branch. Never signal the launch terminal's group, unrelated IDEs, or processes selected by name. Test descendants, repeated signals, early CLI failure, and process exit during escalation. [Node child-process documentation](https://nodejs.org/api/child_process.html#optionsdetached).

Research limitation: direct ArchWiki pages for Wayland, accessibility, and VS Code were blocked by the site's access challenge. The Arch manuals and package database above were readable and reviewed, alongside CachyOS and upstream documentation. No Linux desktop, AT-SPI tree, or compositor bridge was exercised in this Windows review.

## Shared-code design and downstream invariants

Use compile-time Windows/Linux selection and small concrete implementations. Avoid a plugin registry, speculative backends, or a general accessibility framework. Keep the current inline Windows module and UIA implementation unless moving a block is necessary for an actual caller; do not copy them into a second implementation.

The shared boundary needs only target resolution, pointer sampling, live surface scanning, and overlay synchronization. Windows keeps Win32/UIA; Linux selects the proven desktop integration and AT-SPI. Keep blocking accessibility work off pointer sampling and the webview event loop. Run GTK-specific mutations on the appropriate UI thread.

| Contract | Required invariant and affected consumers |
|---|---|
| Window identity | Rename shared `hwnd` / `targetHwnd` fields to `windowId` / `targetWindowId` in one coordinated change. Preserve Windows numeric values, equality behavior, and the current `0` sentinel. Linux opaque identities get stable JavaScript-safe numeric tokens for their live lifetime, invalidated on destruction/reconnect; retain actual XID/KWin/bus identities inside the backend. Never truncate a UUID into an integer |
| Ownership transitions | Update Rust serialization, TypeScript interfaces, frontend ingestion, diagnostics, tests, sash-matcher metadata/reset checks, and all attachment/carry/portal/divider-slide/pointer owner fields together. Preserve falling and cancellation on target change. No parallel old/new fields or compatibility reader in bundled IPC |
| Coordinate space | Surface endpoints, pointer coordinates, and `windowLocalRect` share one IDE-local origin and unit. Separate desktop position from local geometry. Normalize Linux decoration/scale differences at the native boundary and use the existing SVG scale once; leave Windows arithmetic unchanged |
| Geometry freshness | Keep monotonic scan ordering and revision changes. Reject results whose target changed during a scan. Clear stale Linux data on target destruction, bus loss, or bridge loss; do not recycle an old sequence after reconnect |
| Pointer state | Keep `null` samples distinct from valid samples outside the IDE (`x/y = null`). Carry release must remain detectable outside the rectangle. Never represent unavailable button state as a trustworthy released button or silently advertise pickup support |
| Surface identity | Preserve the current role/ID conventions: `ledge-h-{y}`, `wall-v-{x}`, tab-strip, explorer, and status-bar surfaces. Existing sash IDs change with rounded position; `SashMatcher` already handles their continuity. Reuse that behavior initially, keep deterministic segment ordering, and do not introduce a second tracking scheme or localized text IDs |
| Configuration | Preserve every existing Windows setting/default. Initially retain the active public `HABITAT_LIVE_UIA` spelling for live geometry on both systems, documenting the historical name; rename internal shared functions to live-surfaces terms. Avoid adding a duplicate environment switch or unused alias |
| Diagnostics | Use backend-neutral common geometry fields/HUD labels where shared; retain correctly scoped Windows UIA events. Linux failures must identify unavailable session, geometry, or input capability without dumping editor contents |

AT-SPI and compositor snapshots must be associated with the same exact IDE window, not merely the same process. Handle two windows of the same application, duplicate titles, IDE restart, and a focus change during an in-flight D-Bus response. If matching is ambiguous, report it and hide rather than attaching to an arbitrary sibling window.

Detect the session using environment hints plus the actual connected display/backend. `DISPLAY` can exist in Wayland sessions, and desktop-name variables are not sufficient proof of capabilities. Do not silently select the X11 provider for native Wayland windows.

Minimal expected file changes:

- Existing Rust: `Cargo.toml`/lockfile, `lib.rs`, `surface_mapper.rs`, `ide_host.rs`, `diagnostics.rs`, and `runtime_log.rs`.
- Existing frontend: `main.ts`, `pet/types.ts`, and identity-related names in `pet/habitat-pet.ts` and `pet/sash-matcher.ts`; behavior and artwork stay shared.
- Existing launcher/storage: `bin/socrates.js`, `bin/log-storage.js`, and `bin/check-updates.js`; reuse an existing storage helper for common JavaScript path selection where it fits.
- Existing tests: extend launcher, storage/update, geometry/ownership tests, and Rust module tests. Add a focused Linux fixture/test file only when existing files cannot reasonably own it.
- New production files: at most an initial `src-tauri/src/linux.rs` for desktop integration, plus a KWin bridge package only if the feasibility gate establishes that it is required. AT-SPI can start as a Linux module in `surface_mapper.rs`; extract only for real clarity/size needs.
- Configuration: change `tauri.conf.json` or capabilities only for a demonstrated Linux requirement. Prefer platform-specific configuration over altering Windows window options or widening webview permissions. Leave `package.json`, Vite, CSS, renderer, and sprite assets alone unless verification identifies a concrete issue.

## Implementation phases and acceptance gates

### Phase 0 — establish feasibility and the Windows baseline

1. Run the existing checks on Windows and capture representative behavior/diagnostic timings before any shared-code edit. Separate existing documented limitations from regressions introduced by the port.
2. Record Arch/CachyOS, desktop/compositor, session protocol, IDE build/package, rendering backend, monitor scales, and GPU/driver versions. Use an actual desktop session; a headless build is insufficient.
3. Inspect the AT-SPI trees for both IDEs and every required surface. Record compact, reviewed structural fixtures without editor text. Establish exact window association and coordinate conversions.
4. Prove a transparent, permanently click-through Tauri overlay on X11. Exercise focus, primary-button state, and movement between monitors.
5. For KDE Wayland, prove tracking, passive button observation, and placement together. Determine whether a script, effect/plugin, or layer-shell integration is actually required before committing to that design.

**Exit gate:** a written result in this document identifies the tested sessions, accessible surfaces, coordinate model, and smallest viable integration. Missing divider geometry or passive buttons blocks a parity claim. An X11-only release can be scoped explicitly, but does not complete the intended KDE Wayland milestone. Remove throwaway probes rather than merging experimental alternatives.

### Phase 1 — isolate platform dependencies and shared contracts

1. Target-gate Windows dependencies without changing their versions. Add only the selected Linux libraries; retain a single lockfile.
2. Add narrow dispatch at the existing native call sites and the coordinated window-identity rename described above. Generalize shared node-count labels without changing Windows mapping or pet decisions.
3. Replace the Linux `None`/no-worker placeholders with real paths as their implementations land. For unsupported sessions, emit one actionable startup failure instead of running an indefinitely hidden overlay. Keep other OS targets explicitly unsupported.
4. Extend `ide_host.rs` for observed Linux process/executable names and ancestry. Do not match every `electron` process or infer IDE identity from document titles.

**Exit gate:** Windows checks and smoke behavior match the baseline; Linux build/dependency selection is real, with unavailable capabilities reported accurately. Search every renamed field and caller, including test fixtures, before proceeding.

### Phase 2 — implement the X11 desktop and AT-SPI path

1. Implement window discovery/foreground tracking, largest-visible-window mode, lifecycle changes, and pointer/button queries through a persistent X11 connection.
2. Implement the verified AT-SPI classifications. Bound traversal depth/node count and D-Bus call/scan duration; handle unavailable or defunct objects, bus-owner changes, and IDE restarts. Keep the selected subtree/cache scoped to the exact target.
3. Reuse the live snapshot/event path. Begin with bounded full/cached scans; add event-driven invalidation only where it improves measured correctness or cost. Preserve ID families, revision changes, and scan ordering.
4. Apply Linux coordinate normalization and validate client/frame offsets, scaling, and zoom. Keep input sampling independent of a slow or failed accessibility scan.

**Exit gate:** both IDEs exhibit live tab/panel/status-bar walking, split interaction, pointer reactions, carry/release, and focus hiding in the named X11 session. Compare idle and resize CPU/latency with the Phase 0 baseline; no unbounded D-Bus backlog or repeated process spawning.

### Phase 3 — implement the selected KDE Wayland integration

1. Implement only the mechanism proven in Phase 0. Feed the same target/pointer/surface contracts; reuse AT-SPI and all frontend behavior.
2. Add the minimal bridge packaging/lifecycle if needed. Verify its version handshake, sender/session association, payload bounds, teardown, and loss/reconnect behavior. Provide explicit installation/removal instructions and do not leave an autoloading helper behind after removal.
3. Integrate the proven placement mechanism. Test overlay focus, input region, workspaces/activities, minimize/fullscreen, screen lock, scaling, and IDE windows spanning outputs. A successful API call alone is not proof that the compositor placed the window correctly.
4. Exercise native Wayland IDEs and label any separately tested Xwayland combination accurately. Do not add unimplemented GNOME/Hyprland branches.

**Exit gate:** KDE Wayland passes the same feature matrix, including click-through primary-button pickup and release. If it cannot, report the precise unsupported capability and revise scope; do not substitute captured input or silently disable a promised feature.

### Phase 4 — finish Linux launch/storage and documentation

1. Implement Linux process-group supervision and verify CLI, Cargo, Vite, app, and any owned helper terminate without affecting the terminal or IDE. Cover Ctrl+C during compilation and after startup, SIGTERM, and early failure.
2. Implement consistent Linux state/log paths for source launcher, direct native runs, and explicit update checks. Keep update-cache locking and persisted waits intact. Test missing, empty, relative, and custom XDG bases and existing `SOCRATES_LOG_DIR` behavior.
3. Test `npm ci`, source launch from an unrelated directory, `npm link`, `--debug`, direct `tauri:dev`, and `--check-updates` using controlled fixtures for update requests. Keep the update notice opt-in.
4. Update the root/developer READMEs, architecture, and changelog to describe the exact validated support matrix, prerequisites, session restrictions, diagnostics, and commands. Do not claim general Linux support based on compilation alone.

**Exit gate:** Linux setup/shutdown and direct launches behave consistently; Windows paths, help behavior where applicable, update semantics, and shutdown tests remain valid.

### Phase 5 — integration and Windows regression verification

Run on both Windows and a Linux development host, from `companion/`:

```sh
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle
```

Run formatting and compiler/lint checks appropriate to touched files on both targets. Investigate new warnings without suppressing dead code or broadening the port into unrelated cleanup. A Linux-native build is required; a Windows cross-check cannot validate GTK/WebKit or desktop behavior.

| Area | Required scenarios |
|---|---|
| Layout | Tabs, explorer, terminal/panels, horizontal/vertical splits, disabled/removed sash, hidden status bar, IDE zoom, title-bar variants |
| Ownership/focus | Two same-IDE windows, VS Code plus Cursor, identical titles, rapid switching, switch during scan/carry/portal/slide/sleep, minimize/restore, close/reopen |
| Input | Swipe/pounce, hold pickup, swing, release inside/outside, swapped primary button, stale/disconnected samples, target change while held; IDE still receives clicks/drags |
| Coordinates | 100%, fractional, and 200% scaling; mixed-scale monitors; negative desktop origins; move/resize/maximize; cross-output windows |
| Rendering | All manifest clips load case-sensitively, alpha background, clipped/mirrored/rotated sprites, cold start, hidden/resume animation timing |
| Failures/lifecycle | Missing accessibility tree, slow IDE, stale object, bus/bridge disconnect, session mismatch, lock/unlock, clean shutdown, no orphan processes/files |
| Windows invariants | Original UIA classifications/cache, focus delays, poll rates, pointer mapping, bounds math, source launch, log locations, and all pet regressions unchanged |

Extend existing tests with meaningful cross-platform failures: mismatched window identity, late scans, missing button samples, coordinate conversion, multi-window association, Linux descendants, and path selection. Run real desktop smoke tests for transparency, stacking, AT-SPI coverage, and focus; unit fixtures cannot establish compositor support. Retain the existing nap, fall, status-bar selection, and cross-window attachment regressions.

**Exit gate:** record results per OS/session/IDE in this document, including remaining restrictions. A failing Windows regression blocks release of the Linux changes. No Windows regression-free claim is made by this research-only review.

### Phase 6 — final cleanup: completeness, correctness, and minimalism

1. Trace startup → host selection → window identity → mapping → IPC → pet ownership → rendering, and input → carry/release, on every supported backend. Confirm shutdown and reconnect release all connections, subscriptions, timers, and owned helpers.
2. Remove replaced Linux stubs, abandoned probes, duplicate conversions, unused dependencies/features/imports, temporary debug output, orphan files, and superseded IPC fields in the same changes that replace them. Keep active Windows code and documented working interfaces; platform-gated code is not dead merely because it is excluded on the other OS.
3. Search the full source/test/doc tree for obsolete shared `targetHwnd` references, misleading UIA-only labels, unhandled platform branches, placeholder returns, and calls to removed helpers. Windows-local HWND/UIA names and the intentionally supported public environment setting remain legitimate.
4. Confirm every new file has a live caller or documented installation role. Remove speculative abstractions and unimplemented compositor options. Each new dependency must have an actual use; review target dependency trees and lockfile changes for accidental Windows upgrades.
5. Audit the diff: no incidental formatting/refactors, sprite edits, renderer forks, altered Windows timings/defaults, expanded permissions without a demonstrated requirement, or unnecessary config files. Ensure Linux coordinate fixes cannot affect Windows arithmetic.
6. Confirm documentation matches tested behavior and contains no claim for an unverified session. Sync `README.md`, `companion/README.md`, `docs/architecture.md`, and `CHANGELOG.md`; mark this plan's phases with actual outcomes rather than leaving obsolete alternatives as instructions.
7. Run the affected checks after cleanup and the final Windows/Linux smoke matrix. Verify `git diff --check` and review the final changed-file list. Do not commit or publish as part of implementation unless separately requested.

**Completion requires all three:** implemented behavior is complete for the declared support matrix; correctness is demonstrated on Windows and those Linux sessions; the final code contains only the smallest maintained implementations and their necessary integration/tests/docs.
