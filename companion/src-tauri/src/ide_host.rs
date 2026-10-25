//! Session IDE host selection (VS Code vs Cursor) for overlay and UIA tracking.
//! Resolved once at process start from `HABITAT_IDE_HOST` and launch-process ancestry;
//! consumed by `lib.rs` window discovery and logged for diagnostics.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdeHost {
    Code,
    Cursor,
}

#[derive(Debug, Clone, Copy)]
pub struct SessionIdeHost {
    pub host: IdeHost,
    /// `env`, `ancestry`, `default`, or `invalid` when `HABITAT_IDE_HOST` is not recognized.
    pub source: &'static str,
}

impl IdeHost {
    pub fn matches_process_name(&self, name: &str) -> bool {
        match self {
            IdeHost::Code => name.eq_ignore_ascii_case("Code.exe") || name == "Code",
            IdeHost::Cursor => name.eq_ignore_ascii_case("Cursor.exe") || name == "Cursor",
        }
    }

    pub fn env_value(self) -> &'static str {
        match self {
            IdeHost::Code => "code",
            IdeHost::Cursor => "cursor",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            IdeHost::Code => "VS Code",
            IdeHost::Cursor => "Cursor",
        }
    }
}

/// Nearest matching IDE host walking from child toward root (first match wins).
pub(crate) fn host_from_ancestor_process_names(names: &[&str]) -> Option<IdeHost> {
    for name in names {
        if IdeHost::Code.matches_process_name(name) {
            return Some(IdeHost::Code);
        }
        if IdeHost::Cursor.matches_process_name(name) {
            return Some(IdeHost::Cursor);
        }
    }
    None
}

fn parse_explicit_host(raw: &str) -> Option<IdeHost> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "code" | "vscode" => Some(IdeHost::Code),
        "cursor" => Some(IdeHost::Cursor),
        "auto" => None,
        _ => None,
    }
}

#[cfg(windows)]
fn detect_host_from_ancestry() -> Option<IdeHost> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut pid = Pid::from_u32(std::process::id());
    for _ in 0..64 {
        let Some(process) = system.process(pid) else {
            break;
        };
        let name = process.name().to_string_lossy();
        if let Some(host) = host_from_ancestor_process_names(&[&name]) {
            return Some(host);
        }
        let Some(parent) = process.parent() else {
            break;
        };
        if parent.as_u32() == 0 || parent == pid {
            break;
        }
        pid = parent;
    }
    None
}

#[cfg(not(windows))]
fn detect_host_from_ancestry() -> Option<IdeHost> {
    None
}

fn resolve_from_auto_or_ancestry() -> SessionIdeHost {
    if let Some(host) = detect_host_from_ancestry() {
        SessionIdeHost {
            host,
            source: "ancestry",
        }
    } else {
        SessionIdeHost {
            host: IdeHost::Cursor,
            source: "default",
        }
    }
}

fn resolve_session_ide_host() -> SessionIdeHost {
    match std::env::var("HABITAT_IDE_HOST") {
        Ok(raw) => {
            let trimmed = raw.trim();
            if let Some(host) = parse_explicit_host(trimmed) {
                return SessionIdeHost {
                    host,
                    source: "env",
                };
            }
            if trimmed.eq_ignore_ascii_case("auto") {
                return resolve_from_auto_or_ancestry();
            }
            SessionIdeHost {
                host: IdeHost::Cursor,
                source: "invalid",
            }
        }
        Err(_) => resolve_from_auto_or_ancestry(),
    }
}

pub fn session_ide_host() -> SessionIdeHost {
    static SLOT: OnceLock<SessionIdeHost> = OnceLock::new();
    *SLOT.get_or_init(resolve_session_ide_host)
}

#[cfg(any(test, feature = "habitat-unit-tests"))]
mod unit_tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_env<F: FnOnce()>(pairs: &[(&str, Option<&str>)], f: F) {
        let _guard = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<&str> = pairs.iter().map(|(k, _)| *k).collect();
        for (k, v) in pairs {
            match v {
                Some(val) => unsafe { std::env::set_var(k, val) },
                None => unsafe { std::env::remove_var(k) },
            }
        }
        f();
        for k in keys {
            unsafe { std::env::remove_var(k) };
        }
    }

    pub(super) fn parse_host_values() {
        assert_eq!(parse_explicit_host("code"), Some(IdeHost::Code));
        assert_eq!(parse_explicit_host("vscode"), Some(IdeHost::Code));
        assert_eq!(parse_explicit_host("cursor"), Some(IdeHost::Cursor));
        assert!(parse_explicit_host("auto").is_none());
        assert!(parse_explicit_host("cod").is_none());
    }

    pub(super) fn env_code_overrides_auto() {
        with_env(&[("HABITAT_IDE_HOST", Some("code"))], || {
            let s = resolve_session_ide_host();
            assert_eq!(s.host, IdeHost::Code);
            assert_eq!(s.source, "env");
        });
    }

    pub(super) fn invalid_env_is_not_auto() {
        with_env(&[("HABITAT_IDE_HOST", Some("cod"))], || {
            let s = resolve_session_ide_host();
            assert_eq!(s.host, IdeHost::Cursor);
            assert_eq!(s.source, "invalid");
        });
    }

    pub(super) fn ancestry_walk_prefers_nearest_ide() {
        assert_eq!(
            host_from_ancestor_process_names(&["pwsh.exe", "Code.exe", "explorer.exe"]),
            Some(IdeHost::Code)
        );
        assert_eq!(
            host_from_ancestor_process_names(&["node.exe", "Cursor.exe"]),
            Some(IdeHost::Cursor)
        );
        assert_eq!(
            host_from_ancestor_process_names(&["node.exe", "pwsh.exe"]),
            None
        );
    }

    pub(super) fn process_name_matching() {
        assert!(IdeHost::Code.matches_process_name("Code.exe"));
        assert!(IdeHost::Cursor.matches_process_name("Cursor.exe"));
        assert!(!IdeHost::Code.matches_process_name("Cursor.exe"));
    }
}

#[cfg(test)]
mod tests {
    use super::unit_tests;

    #[test]
    fn parse_host_values() {
        unit_tests::parse_host_values();
    }

    #[test]
    fn env_code_overrides_auto() {
        unit_tests::env_code_overrides_auto();
    }

    #[test]
    fn invalid_env_is_not_auto() {
        unit_tests::invalid_env_is_not_auto();
    }

    #[test]
    fn ancestry_walk_prefers_nearest_ide() {
        unit_tests::ancestry_walk_prefers_nearest_ide();
    }

    #[test]
    fn process_name_matching() {
        unit_tests::process_name_matching();
    }
}

#[cfg(feature = "habitat-unit-tests")]
pub(crate) fn run_unit_tests() {
    unit_tests::parse_host_values();
    unit_tests::env_code_overrides_auto();
    unit_tests::invalid_env_is_not_auto();
    unit_tests::ancestry_walk_prefers_nearest_ide();
    unit_tests::process_name_matching();
}
