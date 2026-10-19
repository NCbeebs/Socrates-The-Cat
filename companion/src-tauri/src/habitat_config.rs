//! Runtime presentation flags for the companion overlay (HUD, surface wireframes).
//! Geometry pipeline (`HABITAT_LIVE_UIA`, foreground tracking) is separate — see `lib.rs`.
//! Resolved once at process start from CLI args + `HABITAT_DEBUG*` env vars; exposed to the
//! WebView via `get_habitat_presentation` in `main.ts`. Structured terminal diagnostics use
//! `HABITAT_DEBUG_LOG` (or the `HABITAT_DEBUG` umbrella) — see `debug_log()` and `diagnostics.rs`.

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitatPresentation {
    /// Any developer overlay chrome enabled (HUD or wireframes).
    pub debug: bool,
    pub debug_surfaces: bool,
    pub debug_hud: bool,
    /// Structured diagnostic log lines (`debug` level); independent of HUD/wireframes.
    pub debug_log: bool,
}

struct CliPresentation {
    debug: bool,
    debug_surfaces: bool,
    debug_hud: bool,
}

fn parse_cli() -> CliPresentation {
    let mut out = CliPresentation {
        debug: false,
        debug_surfaces: false,
        debug_hud: false,
    };
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--debug" => out.debug = true,
            "--debug-surfaces" => out.debug_surfaces = true,
            "--debug-hud" => out.debug_hud = true,
            _ => {}
        }
    }
    out
}

/// `None` if unset; `Some(false)` for `0` / `false` / `off`.
fn env_flag(name: &str) -> Option<bool> {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.trim();
            if v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off") {
                Some(false)
            } else {
                Some(true)
            }
        }
        Err(_) => None,
    }
}

fn resolve_subflag(
    env_key: &str,
    cli_sub: bool,
    cli_umbrella: bool,
    env_umbrella: Option<bool>,
) -> bool {
    if let Some(v) = env_flag(env_key) {
        return v;
    }
    if cli_sub || cli_umbrella {
        return true;
    }
    env_umbrella == Some(true)
}

pub fn resolve_presentation() -> HabitatPresentation {
    let cli = parse_cli();
    let env_umbrella = env_flag("HABITAT_DEBUG");
    let debug_surfaces = resolve_subflag(
        "HABITAT_DEBUG_SURFACES",
        cli.debug_surfaces,
        cli.debug,
        env_umbrella,
    );
    let debug_hud = resolve_subflag("HABITAT_DEBUG_HUD", cli.debug_hud, cli.debug, env_umbrella);
    let debug = debug_surfaces || debug_hud;
    HabitatPresentation {
        debug,
        debug_surfaces,
        debug_hud,
        debug_log: resolve_debug_log(&cli, env_umbrella),
    }
}

/// Verbose structured diagnostics for terminal/journal; not tied to overlay chrome.
pub fn debug_log() -> bool {
    presentation().debug_log
}

fn resolve_debug_log(cli: &CliPresentation, env_umbrella: Option<bool>) -> bool {
    if let Some(v) = env_flag("HABITAT_DEBUG_LOG") {
        return v;
    }
    if cli.debug || env_umbrella == Some(true) {
        return true;
    }
    false
}

fn presentation_slot() -> &'static HabitatPresentation {
    static SLOT: OnceLock<HabitatPresentation> = OnceLock::new();
    SLOT.get_or_init(resolve_presentation)
}

pub fn presentation() -> &'static HabitatPresentation {
    presentation_slot()
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn defaults_off_without_env_or_cli() {
        with_env(
            &[
                ("HABITAT_DEBUG", None),
                ("HABITAT_DEBUG_SURFACES", None),
                ("HABITAT_DEBUG_HUD", None),
            ],
            || {
                let p = resolve_presentation();
                assert!(!p.debug);
                assert!(!p.debug_surfaces);
                assert!(!p.debug_hud);
                assert!(!p.debug_log);
            },
        );
    }

    #[test]
    fn debug_log_without_overlay_flags() {
        with_env(
            &[
                ("HABITAT_DEBUG", None),
                ("HABITAT_DEBUG_LOG", Some("1")),
                ("HABITAT_DEBUG_SURFACES", None),
                ("HABITAT_DEBUG_HUD", None),
            ],
            || {
                let p = resolve_presentation();
                assert!(!p.debug_surfaces);
                assert!(!p.debug_hud);
                assert!(p.debug_log);
            },
        );
    }

    #[test]
    fn umbrella_env_enables_both() {
        with_env(
            &[
                ("HABITAT_DEBUG", Some("1")),
                ("HABITAT_DEBUG_SURFACES", None),
                ("HABITAT_DEBUG_HUD", None),
            ],
            || {
                let p = resolve_presentation();
                assert!(p.debug_surfaces);
                assert!(p.debug_hud);
                assert!(p.debug_log);
            },
        );
    }

    #[test]
    fn subflag_can_disable_under_umbrella() {
        with_env(
            &[
                ("HABITAT_DEBUG", Some("1")),
                ("HABITAT_DEBUG_SURFACES", Some("0")),
                ("HABITAT_DEBUG_HUD", None),
            ],
            || {
                let p = resolve_presentation();
                assert!(!p.debug_surfaces);
                assert!(p.debug_hud);
            },
        );
    }

    #[test]
    fn surfaces_only_without_umbrella() {
        with_env(
            &[
                ("HABITAT_DEBUG", None),
                ("HABITAT_DEBUG_SURFACES", Some("1")),
                ("HABITAT_DEBUG_HUD", None),
            ],
            || {
                let p = resolve_presentation();
                assert!(p.debug_surfaces);
                assert!(!p.debug_hud);
            },
        );
    }
}
