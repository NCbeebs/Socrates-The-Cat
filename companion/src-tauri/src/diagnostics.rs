//! Verbose habitat diagnostics for terminal and journal files (`runtime_log`).
//! Gated by `habitat_config::debug_log()` — not overlay HUD/wireframes.
//! Coalesces high-frequency geometry and scan lines; failures stay immediate.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::habitat_config;
use crate::runtime_log;

const COALESCE: Duration = Duration::from_secs(1);
const HEALTH: Duration = Duration::from_secs(30);

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

pub fn mark_process_start() {
    PROCESS_START.get_or_init(Instant::now);
}

pub fn elapsed_ms() -> u64 {
    PROCESS_START
        .get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

fn verbose() -> bool {
    habitat_config::debug_log()
}

pub fn log_startup_config(
    version: &str,
    live_uia: bool,
    poll_idle_ms: u64,
    poll_active_ms: u64,
    foreground_mode: &str,
    presentation_hud: bool,
    presentation_surfaces: bool,
) {
    if !verbose() {
        return;
    }
    let session = std::env::var("SOCRATES_SESSION_ID")
        .map(|s| format!(" session_id={}", s.trim()))
        .unwrap_or_default();
    runtime_log::debug(
        "app",
        "config",
        &format!(
            "version={} live_uia={} poll_idle_ms={} poll_active_ms={} foreground_mode={} presentation_hud={} presentation_surfaces={} debug_log=true{}",
            version,
            live_uia,
            poll_idle_ms,
            poll_active_ms,
            foreground_mode,
            presentation_hud,
            presentation_surfaces,
            session
        ),
    );
}

pub fn log_native_runtime_ready() {
    if !verbose() {
        return;
    }
    runtime_log::debug(
        "app",
        "native_runtime_ready",
        &format!("elapsed_ms={}", elapsed_ms()),
    );
}

pub fn note_emit_failure(event: &str, details: &str) {
    runtime_log::error("geometry", event, details);
}

#[derive(Clone)]
pub struct GeometrySnapshot {
    pub revision: u64,
    pub sequence: u64,
    pub hwnd: isize,
    pub width: f64,
    pub height: f64,
    pub surface_count: usize,
    pub walkable: usize,
    pub climbable: usize,
    pub role_counts: HashMap<String, usize>,
    /// Nodes from the last full UIA walk; omitted on cached rescans.
    pub last_full_walk_nodes: Option<usize>,
    pub sash_like: usize,
}

pub fn note_geometry(snapshot: GeometrySnapshot) {
    if !verbose() {
        return;
    }
    state().geometry_pending = Some(snapshot);
    state().flush_coalesced();
}

pub struct UiaScanNote {
    pub scan_kind: &'static str,
    pub poll_mode: &'static str,
    pub duration_ms: u64,
    pub ms_since_last_success: u64,
    pub fallback_reason: Option<&'static str>,
}

pub fn note_uia_scan(note: UiaScanNote) {
    if !verbose() {
        return;
    }
    let mut st = state();
    if let Some(reason) = note.fallback_reason {
        runtime_log::debug(
            "uia",
            "fallback",
            &format!(
                "cached_to_full reason={} poll_mode={} duration_ms={}",
                reason,
                note.poll_mode,
                note.duration_ms
            ),
        );
    }
    if note.scan_kind == "full" {
        runtime_log::debug(
            "uia",
            "scan",
            &format!(
                "scan_kind=full poll_mode={} duration_ms={} ms_since_last_success={}",
                note.poll_mode,
                note.duration_ms,
                note.ms_since_last_success
            ),
        );
    } else {
        st.uia_pending = Some(note);
    }
    st.flush_coalesced();
}

pub fn note_poll_mode_change(from: &'static str, to: &'static str) {
    if !verbose() || from == to {
        return;
    }
    runtime_log::debug(
        "uia",
        "poll_mode",
        &format!("poll_mode={} previous={}", to, from),
    );
}

pub fn note_overlay_visibility(visible: bool, reason: &str) {
    if !verbose() {
        return;
    }
    let mut st = state();
    if st.overlay_visible == Some(visible) && (!visible && st.overlay_hide_reason.as_deref() == Some(reason)) {
        return;
    }
    if visible {
        if st.overlay_visible == Some(true) {
            return;
        }
        st.overlay_visible = Some(true);
        st.overlay_hide_reason = None;
        runtime_log::debug("overlay", "visibility", "visible=true");
    } else {
        if st.overlay_visible == Some(false) && st.overlay_hide_reason.as_deref() == Some(reason) {
            return;
        }
        st.overlay_visible = Some(false);
        st.overlay_hide_reason = Some(reason.to_string());
        runtime_log::debug(
            "overlay",
            "visibility",
            &format!("visible=false reason={}", reason),
        );
    }
}

/// Map fast-scan fallback errors to stable reason tokens (allowlisted).
pub fn fallback_reason_from_error(err: &str) -> &'static str {
    if err.contains("window size changed") {
        "window_size_changed"
    } else if err.contains("vertical wall") {
        "vertical_wall_stale"
    } else if err.contains("sash element") {
        "horizontal_sash_stale"
    } else {
        "fast_scan_failed"
    }
}

struct DiagnosticsState {
    geometry_pending: Option<GeometrySnapshot>,
    uia_pending: Option<UiaScanNote>,
    last_coalesce: Instant,
    last_health: Instant,
    overlay_visible: Option<bool>,
    overlay_hide_reason: Option<String>,
}

fn state() -> std::sync::MutexGuard<'static, DiagnosticsState> {
    static SLOT: OnceLock<Mutex<DiagnosticsState>> = OnceLock::new();
    SLOT.get_or_init(|| {
        Mutex::new(DiagnosticsState {
            geometry_pending: None,
            uia_pending: None,
            last_coalesce: Instant::now(),
            last_health: Instant::now(),
            overlay_visible: None,
            overlay_hide_reason: None,
        })
    })
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

impl DiagnosticsState {
    fn flush_coalesced(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_coalesce) < COALESCE {
            return;
        }
        if let Some(g) = self.geometry_pending.take() {
            let roles = format_role_counts(&g.role_counts);
            let nodes = match g.last_full_walk_nodes {
                Some(n) => format!(" last_full_walk_nodes={}", n),
                None => String::new(),
            };
            runtime_log::debug(
                "geometry",
                "snapshot",
                &format!(
                    "revision={} sequence={} hwnd={:#x} size={}x{} surfaces={} walkable={} climbable={} sash_like={}{}{}",
                    g.revision,
                    g.sequence,
                    g.hwnd,
                    g.width.round() as i64,
                    g.height.round() as i64,
                    g.surface_count,
                    g.walkable,
                    g.climbable,
                    g.sash_like,
                    nodes,
                    if roles.is_empty() {
                        String::new()
                    } else {
                        format!(" roles={}", roles)
                    }
                ),
            );
        }
        if let Some(u) = self.uia_pending.take() {
            runtime_log::debug(
                "uia",
                "scan",
                &format!(
                    "scan_kind=cached poll_mode={} duration_ms={} ms_since_last_success={}",
                    u.poll_mode,
                    u.duration_ms,
                    u.ms_since_last_success
                ),
            );
        }
        self.last_coalesce = now;
        if now.duration_since(self.last_health) >= HEALTH {
            self.emit_health();
            self.last_health = now;
        }
    }

    fn emit_health(&self) {
        let dropped = runtime_log::dropped_entries();
        let bridge = runtime_log::frontend_bridge_failures();
        runtime_log::debug(
            "logger",
            "health",
            &format!(
                "dropped_native={} frontend_bridge_failures={} overlay_visible={}",
                dropped,
                bridge,
                self.overlay_visible
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "unknown".into())
            ),
        );
    }
}

pub fn tick_coalesce() {
    if !verbose() {
        return;
    }
    state().flush_coalesced();
}

fn format_role_counts(counts: &HashMap<String, usize>) -> String {
    let mut keys: Vec<_> = counts.keys().collect();
    keys.sort();
    keys.iter()
        .map(|k| format!("{}:{}", k, counts[*k]))
        .collect::<Vec<_>>()
        .join(",")
}

