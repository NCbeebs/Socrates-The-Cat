mod diagnostics;
mod habitat_config;
mod ide_host;
mod runtime_log;
mod surface_mapper;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Pushed from the live UIA worker (`spawn_live_uia_thread`); ordered by `scanSequence`.
const HABITAT_SURFACES_EVENT: &str = "habitat-surfaces";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Surface {
    id: String,
    role: String,
    a: Point,
    b: Point,
    confidence: f64,
    walkable: bool,
    climbable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SurfacesFile {
    window_local_rect: WindowRect,
    surfaces: Vec<Surface>,
    /// `live` (UIA poll) or `file` (HABITAT_SURFACES_PATH snapshot).
    #[serde(skip_serializing_if = "Option::is_none")]
    surface_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    /// Live UIA walk size (debug); expect ~100+ on Cursor when geometry is visible.
    #[serde(skip_serializing_if = "Option::is_none")]
    uia_node_count: Option<usize>,
    /// Monotonic per successful live scan (even when `revision` is unchanged).
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_sequence: Option<u64>,
    /// UTC millis when the cached snapshot was last refreshed from a successful scan.
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_observed_at_ms: Option<u64>,
    /// HWND the surfaces were mapped against (live UIA only).
    #[serde(skip_serializing_if = "Option::is_none")]
    target_hwnd: Option<isize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct WindowRect {
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct IdeBounds {
    hwnd: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct LiveCache {
    surfaces: Option<SurfacesFile>,
    revision: u64,
    scan_sequence: u64,
}

fn live_cache() -> &'static Mutex<LiveCache> {
    static CACHE: OnceLock<Mutex<LiveCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(LiveCache {
            surfaces: None,
            revision: 0,
            scan_sequence: 0,
        })
    })
}

/// Live UIA refresh is on by default; set `HABITAT_LIVE_UIA=0` to use only `HABITAT_SURFACES_PATH`.
fn live_uia_enabled() -> bool {
    match std::env::var("HABITAT_LIVE_UIA") {
        Ok(v) => {
            let v = v.trim();
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
        Err(_) => true,
    }
}

fn live_poll_idle_ms() -> u64 {
    std::env::var("HABITAT_LIVE_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&ms| ms >= 100)
        .unwrap_or(500)
}

fn live_poll_fast_ms() -> u64 {
    std::env::var("HABITAT_LIVE_POLL_FAST_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&ms| ms >= 20)
        .unwrap_or(50)
}

fn horizontal_sash_layout_changed(prev: &[Surface], next: &[Surface]) -> bool {
    let mut prev_y: Vec<i32> = prev
        .iter()
        .filter(|s| s.id.starts_with("ledge-h-"))
        .map(|s| s.a.y.round() as i32)
        .collect();
    let mut next_y: Vec<i32> = next
        .iter()
        .filter(|s| s.id.starts_with("ledge-h-"))
        .map(|s| s.a.y.round() as i32)
        .collect();
    prev_y.sort_unstable();
    next_y.sort_unstable();
    prev_y != next_y
}

fn surface_role_counts(surfaces: &[Surface]) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for s in surfaces {
        *out.entry(s.role.clone()).or_insert(0) += 1;
    }
    out
}

fn commit_live_scan(
    app: &tauri::AppHandle,
    mapped: &surface_mapper::MappedSurfaces,
    surfaces: Vec<Surface>,
    hwnd: isize,
    scan_kind: &'static str,
) {
    if let Ok(mut cache) = live_cache().lock() {
        let observed_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        cache.scan_sequence += 1;
        let revision = match cache.surfaces.as_ref() {
            None => {
                cache.revision += 1;
                cache.revision
            }
            Some(prev) => {
                let geometry_changed = prev.window_local_rect
                    != WindowRect {
                        width: mapped.window_local_rect.width,
                        height: mapped.window_local_rect.height,
                    }
                    || prev.surfaces != surfaces;
                if geometry_changed {
                    cache.revision += 1;
                }
                cache.revision
            }
        };
        let walkable = surfaces.iter().filter(|s| s.walkable).count();
        let climbable = surfaces.iter().filter(|s| s.climbable).count();
        let role_counts = surface_role_counts(&surfaces);
        let surface_count = surfaces.len();
        let next = mapped_to_surfaces_file(
            mapped,
            surfaces,
            revision,
            cache.scan_sequence,
            observed_ms,
            hwnd,
        );
        cache.surfaces = Some(next.clone());
        if let Err(error) = app.emit(HABITAT_SURFACES_EVENT, &next) {
            diagnostics::note_emit_failure("surface_event_emit_failed", &error.to_string());
        }
        diagnostics::note_geometry(diagnostics::GeometrySnapshot {
            revision,
            sequence: cache.scan_sequence,
            hwnd,
            width: mapped.window_local_rect.width,
            height: mapped.window_local_rect.height,
            surface_count,
            walkable,
            climbable,
            role_counts,
            last_full_walk_nodes: if scan_kind == "full" {
                Some(mapped.debug_node_count)
            } else {
                None
            },
            sash_like: mapped.debug_group_sash_like,
        });
    }
}

fn surfaces_from_mapped(mapped: &surface_mapper::MappedSurfaces) -> Vec<Surface> {
    mapped
        .surfaces
        .iter()
        .map(|s| Surface {
            id: s.id.clone(),
            role: s.role.clone(),
            a: Point { x: s.a.x, y: s.a.y },
            b: Point { x: s.b.x, y: s.b.y },
            confidence: s.confidence,
            walkable: s.walkable,
            climbable: s.climbable,
        })
        .collect()
}

fn mapped_to_surfaces_file(
    mapped: &surface_mapper::MappedSurfaces,
    surfaces: Vec<Surface>,
    revision: u64,
    scan_sequence: u64,
    scan_observed_at_ms: u64,
    target_hwnd: isize,
) -> SurfacesFile {
    SurfacesFile {
        window_local_rect: WindowRect {
            width: mapped.window_local_rect.width,
            height: mapped.window_local_rect.height,
        },
        surfaces,
        surface_source: Some("live".to_string()),
        revision: Some(revision),
        uia_node_count: Some(mapped.debug_node_count),
        scan_sequence: Some(scan_sequence),
        scan_observed_at_ms: Some(scan_observed_at_ms),
        target_hwnd: Some(target_hwnd),
    }
}

fn load_surfaces_from_file() -> Result<SurfacesFile, String> {
    let path = surfaces_path()?;
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let text = text.trim_start_matches('\u{feff}');
    let mut file: SurfacesFile =
        serde_json::from_str(text).map_err(|e| format!("parse surfaces json: {}", e))?;
    file.surface_source = Some("file".to_string());
    file.revision = None;
    file.uia_node_count = None;
    file.scan_sequence = None;
    file.scan_observed_at_ms = None;
    file.target_hwnd = None;
    Ok(file)
}

#[tauri::command]
fn load_surfaces() -> Result<SurfacesFile, String> {
    if live_uia_enabled() {
        if let Ok(cache) = live_cache().lock() {
            if let Some(s) = cache.surfaces.clone() {
                return Ok(s);
            }
        }
    }
    load_surfaces_from_file()
}

fn surfaces_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("HABITAT_SURFACES_PATH") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    Err(
        "Set HABITAT_SURFACES_PATH to a .surfaces.json file, or enable live UIA (default)"
            .to_string(),
    )
}

#[tauri::command]
fn get_ide_bounds() -> Result<IdeBounds, String> {
    let session = ide_host::session_ide_host();
    ide_bounds().ok_or_else(|| {
        format!(
            "Could not find a visible {} main window",
            session.host.display_name()
        )
    })
}

/// Developer overlay chrome (HUD, wireframes). Geometry polling is unchanged when these are off.
#[tauri::command]
fn get_habitat_presentation() -> habitat_config::HabitatPresentation {
    *habitat_config::presentation()
}

/// Global OS cursor in HWND-local pixels (same space as UIA surfaces). `None` if IDE untracked or pointer outside window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct IdeLocalPointer {
    x: f64,
    y: f64,
    target_hwnd: isize,
    observed_at_ms: u64,
}

#[tauri::command]
fn get_pointer_in_ide_local() -> Option<IdeLocalPointer> {
    #[cfg(windows)]
    {
        return windows::pointer_in_ide_local();
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn ide_bounds() -> Option<IdeBounds> {
    #[cfg(windows)]
    {
        return windows::resolve_ide_bounds();
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Default on: track `GetForegroundWindow` for the session IDE host. Set `HABITAT_FOREGROUND_IDE=0` for largest-window mode.
fn foreground_ide_enabled() -> bool {
    match std::env::var("HABITAT_FOREGROUND_IDE") {
        Ok(v) => {
            let v = v.trim();
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
        Err(_) => true,
    }
}

/// Positions the overlay on the tracked IDE window, or hides it when none (e.g. another app foreground).
fn sync_overlay_to_ide(window: &WebviewWindow) -> Result<(), String> {
    match ide_bounds() {
        Some(b) => {
            window
                .set_position(PhysicalPosition::new(b.x, b.y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(PhysicalSize::new(b.width as u32, b.height as u32))
                .map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            diagnostics::note_overlay_visibility(true, "tracked_ide");
            Ok(())
        }
        None => {
            window.hide().map_err(|e| e.to_string())?;
            diagnostics::note_overlay_visibility(false, "no_tracked_ide");
            Ok(())
        }
    }
}

fn clear_live_cache_if_hwnd_changed(hwnd: isize) {
    static LAST_HWND: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
    let slot = LAST_HWND.get_or_init(|| Mutex::new(None));
    if let Ok(mut last) = slot.lock() {
        if *last != Some(hwnd) {
            *last = Some(hwnd);
            if let Ok(mut cache) = live_cache().lock() {
                // Drop stale geometry; bump revision so the frontend never sees the same
                // revision after an HWND swap (reset-to-zero caused 1→1 and skipped await_geometry).
                cache.surfaces = None;
                cache.revision += 1;
            }
        }
    }
}

fn spawn_live_uia_thread(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        if !live_uia_enabled() {
            return;
        }
        std::thread::spawn(move || {
            use std::time::{Duration, Instant};

            let fast = Duration::from_millis(live_poll_fast_ms());
            let idle = Duration::from_millis(live_poll_idle_ms());
            let full_period = Duration::from_secs(30);

            let mut uia_session: Option<surface_mapper::LiveUiaSession> = None;
            let mut last_full_scan = Instant::now();
            let mut fast_mode_until = Instant::now();
            let mut interval = idle;
            let mut prev_surfaces: Vec<Surface> = Vec::new();
            let mut last_poll_mode: &'static str = "idle";
            let mut last_uia_success = Instant::now();

            loop {
                std::thread::sleep(interval);
                if !live_uia_enabled() {
                    continue;
                }
                if let Some(bounds) = ide_bounds() {
                    clear_live_cache_if_hwnd_changed(bounds.hwnd);
                    let hwnd_changed = uia_session
                        .as_ref()
                        .map(|s| s.hwnd() != bounds.hwnd)
                        .unwrap_or(true);
                    if hwnd_changed {
                        uia_session = match surface_mapper::LiveUiaSession::connect(bounds.hwnd) {
                            Ok(s) => Some(s),
                            Err(e) => {
                                runtime_log::error(
                                    "surface-mapper",
                                    "uia_connect_failed",
                                    &e.to_string(),
                                );
                                None
                            }
                        };
                    }

                    let in_fast_mode = std::time::Instant::now() < fast_mode_until;
                    let need_full =
                        hwnd_changed || (last_full_scan.elapsed() >= full_period && !in_fast_mode);

                    let mut fast_scan_succeeded = false;
                    let mut scan_kind: &'static str = "full";
                    let mut fallback_reason: Option<&'static str> = None;
                    let scan_started = Instant::now();
                    let ms_since_last_success = last_uia_success.elapsed().as_millis() as u64;
                    let poll_mode = if in_fast_mode { "active" } else { "idle" };
                    if last_poll_mode != poll_mode {
                        diagnostics::note_poll_mode_change(last_poll_mode, poll_mode);
                        last_poll_mode = poll_mode;
                    }

                    let mapped = if let Some(session) = uia_session.as_mut() {
                        if need_full {
                            last_full_scan = Instant::now();
                            scan_kind = "full";
                            match session.scan_full() {
                                Ok(m) => Some(m),
                                Err(e) => {
                                    runtime_log::error(
                                        "surface-mapper",
                                        "uia_full_scan_failed",
                                        &e.to_string(),
                                    );
                                    uia_session = None;
                                    None
                                }
                            }
                        } else {
                            scan_kind = "cached";
                            match session.scan_fast() {
                                Ok(m) => {
                                    fast_scan_succeeded = true;
                                    Some(m)
                                }
                                Err(e) => {
                                    let reason =
                                        diagnostics::fallback_reason_from_error(&e.to_string());
                                    fallback_reason = Some(reason);
                                    runtime_log::error(
                                        "surface-mapper",
                                        "uia_fast_scan_failed",
                                        &e.to_string(),
                                    );
                                    last_full_scan = Instant::now();
                                    scan_kind = "full";
                                    match session.scan_full() {
                                        Ok(m) => Some(m),
                                        Err(e2) => {
                                            runtime_log::error(
                                                "surface-mapper",
                                                "uia_full_scan_failed",
                                                &e2.to_string(),
                                            );
                                            uia_session = None;
                                            None
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        None
                    };

                    if let Some(mapped) = mapped {
                        let duration_ms = scan_started.elapsed().as_millis() as u64;
                        diagnostics::note_uia_scan(diagnostics::UiaScanNote {
                            scan_kind,
                            poll_mode,
                            duration_ms,
                            ms_since_last_success,
                            fallback_reason,
                        });
                        last_uia_success = Instant::now();
                        runtime_log::recovery("surface-mapper", "uia_connect_failed");
                        runtime_log::recovery("surface-mapper", "uia_full_scan_failed");
                        if fast_scan_succeeded {
                            runtime_log::recovery("surface-mapper", "uia_fast_scan_failed");
                        }
                        let new_surfaces = surfaces_from_mapped(&mapped);
                        let moving = horizontal_sash_layout_changed(&prev_surfaces, &new_surfaces);
                        if moving {
                            fast_mode_until =
                                std::time::Instant::now() + std::time::Duration::from_millis(400);
                        }
                        let in_fast_mode = std::time::Instant::now() < fast_mode_until;
                        interval = if in_fast_mode { fast } else { idle };
                        prev_surfaces = new_surfaces.clone();
                        commit_live_scan(
                            &app,
                            &mapped,
                            new_surfaces,
                            bounds.hwnd,
                            scan_kind,
                        );
                    }
                }
                diagnostics::tick_coalesce();
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tauri::command]
fn note_log_bridge_failure() {
    runtime_log::note_frontend_bridge_failure();
}

pub fn run() {
    runtime_log::init();
    diagnostics::mark_process_start();
    let ide_session = ide_host::session_ide_host();
    let mode = if foreground_ide_enabled() {
        "foreground"
    } else {
        "largest_window"
    };
    runtime_log::info(
        "app",
        "ide_host",
        &format!(
            "host={} source={} mode={}",
            ide_session.host.env_value(),
            ide_session.source,
            mode
        ),
    );
    if ide_session.source == "default" {
        runtime_log::warn(
            "app",
            "ide_host_ambiguous",
            "Could not detect VS Code or Cursor from launch ancestry; defaulting to Cursor. Set HABITAT_IDE_HOST=code or cursor to override.",
        );
    } else if ide_session.source == "invalid" {
        let raw = std::env::var("HABITAT_IDE_HOST").unwrap_or_default();
        runtime_log::warn(
            "app",
            "ide_host_invalid",
            &format!(
                "Invalid HABITAT_IDE_HOST=\"{}\"; expected code, cursor, or auto. Defaulting to Cursor.",
                raw.trim()
            ),
        );
    }
    runtime_log::info("app", "starting", "Socrates is starting.");
    let presentation = habitat_config::presentation();
    diagnostics::log_startup_config(
        env!("CARGO_PKG_VERSION"),
        live_uia_enabled(),
        live_poll_idle_ms(),
        live_poll_fast_ms(),
        mode,
        presentation.debug_hud,
        presentation.debug_surfaces,
    );
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_surfaces,
            get_ide_bounds,
            get_pointer_in_ide_local,
            get_habitat_presentation,
            note_log_bridge_failure,
            runtime_log::write_runtime_log
        ])
        .setup(|app| {
            spawn_live_uia_thread(app.handle().clone());

            let window = app
                .get_webview_window("main")
                .expect("main webview window missing");
            let presentation = habitat_config::presentation();
            let title = if presentation.debug {
                "Socrates the Cat — debug"
            } else {
                "Socrates the Cat"
            };
            window.set_title(title).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            #[cfg(windows)]
            {
                if let Ok(hwnd) = window.hwnd() {
                    windows::register_overlay_hwnd(hwnd.0 as isize);
                }
            }
            if let Err(error) = sync_overlay_to_ide(&window) {
                runtime_log::error("overlay", "positioning_failed", &error);
            }
            diagnostics::log_native_runtime_ready();

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(200));
                diagnostics::tick_coalesce();
                if let Some(w) = handle.get_webview_window("main") {
                    match sync_overlay_to_ide(&w) {
                        Ok(()) => runtime_log::recovery("overlay", "positioning_failed"),
                        Err(error) => runtime_log::error("overlay", "positioning_failed", &error),
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = &result {
        runtime_log::error("app", "runtime_failed", &error.to_string());
    } else {
        runtime_log::info("app", "stopped", "Socrates has signed off.");
    }
    runtime_log::flush();
    result.expect("error while running tauri application");
}

#[cfg(windows)]
mod windows {
    use super::{ide_host, IdeBounds, IdeLocalPointer};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowRect,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, GA_ROOT,
    };

    const IDE_PID_REFRESH: Duration = Duration::from_secs(5);
    const POINTER_BOUNDS_FAST_PATH: Duration = Duration::from_millis(120);

    struct IdePidCache {
        pids: Vec<u32>,
        refreshed_at: Instant,
    }

    static IDE_PID_CACHE: OnceLock<Mutex<IdePidCache>> = OnceLock::new();

    struct PointerBoundsCache {
        bounds: IdeBounds,
        refreshed_at: Instant,
    }

    static POINTER_BOUNDS_CACHE: OnceLock<Mutex<Option<PointerBoundsCache>>> = OnceLock::new();

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn ide_pid_cache() -> &'static Mutex<IdePidCache> {
        IDE_PID_CACHE.get_or_init(|| {
            Mutex::new(IdePidCache {
                pids: Vec::new(),
                refreshed_at: Instant::now() - IDE_PID_REFRESH,
            })
        })
    }

    fn ide_process_ids_cached() -> Vec<u32> {
        let mut cache = ide_pid_cache().lock().expect("ide pid cache");
        if cache.refreshed_at.elapsed() >= IDE_PID_REFRESH || cache.pids.is_empty() {
            cache.pids = ide_process_ids_refresh();
            cache.refreshed_at = Instant::now();
        }
        cache.pids.clone()
    }

    fn ide_process_ids_refresh() -> Vec<u32> {
        let host = ide_host::session_ide_host().host;
        use sysinfo::{ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        system
            .processes()
            .iter()
            .filter(|(_, p)| host.matches_process_name(&p.name().to_string_lossy()))
            .map(|(pid, _)| pid.as_u32())
            .collect()
    }

    fn refresh_bounds_rect(hwnd: HWND, pids: &[u32]) -> Option<IdeBounds> {
        bounds_for_ide_hwnd(hwnd, pids)
    }

    fn resolve_pointer_target_bounds() -> Option<IdeBounds> {
        let pids = ide_process_ids_cached();
        if pids.is_empty() {
            return None;
        }

        if let Ok(slot) = POINTER_BOUNDS_CACHE.get_or_init(|| Mutex::new(None)).lock() {
            if let Some(cached) = slot.as_ref() {
                if cached.refreshed_at.elapsed() < POINTER_BOUNDS_FAST_PATH {
                    let hwnd = HWND(cached.bounds.hwnd as *mut _);
                    if unsafe { IsWindow(Some(hwnd)).as_bool() } {
                        let fg = unsafe { GetForegroundWindow() };
                        let still_target = if fg.0 != std::ptr::null_mut() {
                            bounds_for_ide_hwnd(fg, &pids)
                                .map(|b| b.hwnd == cached.bounds.hwnd)
                                .unwrap_or(false)
                        } else {
                            false
                        };
                        if still_target {
                            if let Some(fresh) = refresh_bounds_rect(hwnd, &pids) {
                                return Some(fresh);
                            }
                        }
                    }
                }
            }
        }

        let bounds = resolve_ide_bounds()?;
        if let Ok(mut slot) = POINTER_BOUNDS_CACHE.get_or_init(|| Mutex::new(None)).lock() {
            *slot = Some(PointerBoundsCache {
                bounds: bounds.clone(),
                refreshed_at: Instant::now(),
            });
        }
        Some(bounds)
    }

    /// `GetCursorPos` → window-local; read-only, does not move or capture the cursor (spec §7.3).
    pub fn pointer_in_ide_local() -> Option<IdeLocalPointer> {
        let mut pt = POINT::default();
        unsafe {
            if GetCursorPos(&mut pt).is_err() {
                return None;
            }
        }
        let ide = resolve_pointer_target_bounds()?;
        let lx = pt.x - ide.x;
        let ly = pt.y - ide.y;
        if lx < 0 || ly < 0 || lx > ide.width || ly > ide.height {
            return None;
        }
        Some(IdeLocalPointer {
            x: f64::from(lx),
            y: f64::from(ly),
            target_hwnd: ide.hwnd,
            observed_at_ms: now_ms(),
        })
    }

    static OVERLAY_HWND: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

    struct ForegroundTracker {
        last_ide: Option<IdeBounds>,
        last_ide_seen: Option<Instant>,
        hide_pending_since: Option<Instant>,
    }

    static FG_TRACKER: OnceLock<Mutex<ForegroundTracker>> = OnceLock::new();

    fn fg_tracker() -> &'static Mutex<ForegroundTracker> {
        FG_TRACKER.get_or_init(|| {
            Mutex::new(ForegroundTracker {
                last_ide: None,
                last_ide_seen: None,
                hide_pending_since: None,
            })
        })
    }

    pub fn register_overlay_hwnd(hwnd: isize) {
        let slot = OVERLAY_HWND.get_or_init(|| Mutex::new(None));
        if let Ok(mut g) = slot.lock() {
            *g = Some(hwnd);
        }
    }

    fn overlay_hwnd() -> Option<isize> {
        OVERLAY_HWND
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|g| *g)
    }

    fn sticky_ms() -> u64 {
        std::env::var("HABITAT_FOREGROUND_STICKY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(280)
    }

    fn hide_debounce_ms() -> u64 {
        std::env::var("HABITAT_FOREGROUND_HIDE_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(180)
    }

    pub fn resolve_ide_bounds() -> Option<IdeBounds> {
        if super::foreground_ide_enabled() {
            return resolve_foreground_ide_bounds();
        }
        find_largest_ide_window_bounds()
    }

    fn resolve_foreground_ide_bounds() -> Option<IdeBounds> {
        let pids = ide_process_ids_cached();
        if pids.is_empty() {
            return None;
        }

        let fg = unsafe { GetForegroundWindow() };
        let mut candidate = if fg.0 != std::ptr::null_mut() {
            bounds_for_ide_hwnd(fg, &pids)
        } else {
            None
        };

        if candidate.is_none() && fg.0 != std::ptr::null_mut() {
            let root = unsafe { GetAncestor(fg, GA_ROOT) };
            if root.0 != std::ptr::null_mut() {
                candidate = bounds_for_ide_hwnd(root, &pids);
            }
        }

        if let Some(overlay) = overlay_hwnd() {
            if fg.0 as isize == overlay {
                if let Ok(tracker) = fg_tracker().lock() {
                    return tracker.last_ide.clone();
                }
            }
        }

        let now = Instant::now();
        let sticky = Duration::from_millis(sticky_ms());
        let hide_wait = Duration::from_millis(hide_debounce_ms());

        let mut tracker = fg_tracker().lock().ok()?;

        if let Some(bounds) = candidate {
            tracker.last_ide = Some(bounds.clone());
            tracker.last_ide_seen = Some(now);
            tracker.hide_pending_since = None;
            return Some(bounds);
        }

        if let Some(seen) = tracker.last_ide_seen {
            if now.duration_since(seen) < sticky {
                return tracker.last_ide.clone();
            }
        }

        if tracker.hide_pending_since.is_none() {
            tracker.hide_pending_since = Some(now);
        }

        if let Some(since) = tracker.hide_pending_since {
            if now.duration_since(since) < hide_wait {
                return tracker.last_ide.clone();
            }
        }

        tracker.last_ide = None;
        tracker.last_ide_seen = None;
        tracker.hide_pending_since = None;
        None
    }

    fn bounds_for_ide_hwnd(hwnd: HWND, pids: &[u32]) -> Option<IdeBounds> {
        unsafe {
            if IsWindowVisible(hwnd).as_bool() == false {
                return None;
            }
        }
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if !pids.contains(&pid) {
            return None;
        }
        let mut rect = RECT::default();
        unsafe {
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return None;
            }
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w < 400 || h < 300 {
            return None;
        }
        Some(IdeBounds {
            hwnd: hwnd.0 as isize,
            x: rect.left,
            y: rect.top,
            width: w,
            height: h,
        })
    }

    pub fn find_largest_ide_window_bounds() -> Option<IdeBounds> {
        let pids = ide_process_ids_cached();
        if pids.is_empty() {
            return None;
        }
        let mut best: Option<IdeBounds> = None;
        let mut best_area = 0i64;
        unsafe {
            let _ = EnumWindows(
                Some(enum_window),
                LPARAM(&mut EnumState {
                    pids: &pids,
                    best: &mut best,
                    best_area: &mut best_area,
                } as *mut EnumState as isize),
            );
        }
        best
    }

    struct EnumState<'a> {
        pids: &'a [u32],
        best: &'a mut Option<IdeBounds>,
        best_area: &'a mut i64,
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut EnumState);
        if let Some(b) = bounds_for_ide_hwnd(hwnd, state.pids) {
            let area = i64::from(b.width) * i64::from(b.height);
            if area > *state.best_area {
                *state.best_area = area;
                *state.best = Some(b);
            }
        }
        TRUE
    }
}
