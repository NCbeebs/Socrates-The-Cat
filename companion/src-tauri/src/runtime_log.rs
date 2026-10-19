use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static DROPPED_ENTRIES: AtomicU64 = AtomicU64::new(0);
static FRONTEND_BRIDGE_FAILURES: AtomicU64 = AtomicU64::new(0);

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const PREFIX: &str = "@socrates-log ";

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Entry {
    pub level: String,
    pub source: String,
    pub event: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    timestamp: String,
    session_id: String,
    #[serde(flatten)]
    entry: Entry,
}

enum Work {
    Entry(Entry),
    Flush(mpsc::Sender<()>),
}

static SENDER: OnceLock<mpsc::SyncSender<Work>> = OnceLock::new();

pub fn init() {
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel(512);
        let directory = std::env::var_os("SOCRATES_LOG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)
                    .join("Socrates")
                    .join("logs")
            });
        let session = std::env::var("SOCRATES_SESSION_ID").unwrap_or_else(|_| {
            format!("{}-{}", Local::now().timestamp_millis(), std::process::id())
        });
        std::thread::Builder::new()
            .name("socrates-log".into())
            .spawn(move || {
                let mut last_date = String::new();
                let mut disk_error_reported = false;
                while let Ok(work) = rx.recv() {
                    let entry = match work {
                        Work::Entry(entry) => entry,
                        Work::Flush(done) => {
                            let _ = done.send(());
                            continue;
                        }
                    };
                    let now = Local::now();
                    let day = now.format("%Y-%m-%d").to_string();
                    let record = Record {
                        timestamp: now.to_rfc3339(),
                        session_id: session.clone(),
                        entry,
                    };
                    if let Ok(json) = serde_json::to_string(&record) {
                        // A single writer keeps records atomic even when many native workers log.
                        let _ = writeln!(io::stdout().lock(), "{}{}", PREFIX, json);
                        let result = (|| -> io::Result<()> {
                            fs::create_dir_all(&directory)?;
                            if last_date != day {
                                cleanup(&directory)?;
                                last_date = day.clone();
                            }
                            append(&directory, &day, &format!("{}\n", json))
                        })();
                        match result {
                            Err(error) if !disk_error_reported => {
                                eprintln!(
                                    "[Socrates logger ERROR] Cannot save logs to {}: {}",
                                    directory.display(),
                                    error
                                );
                                disk_error_reported = true;
                            }
                            Ok(()) => {
                                disk_error_reported = false;
                            }
                            _ => {}
                        }
                    }
                }
            })
            .expect("could not start log writer");
        tx
    });
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error(
            "rust",
            "panic",
            &format!("{}\n{}", info, std::backtrace::Backtrace::force_capture()),
        );
        flush();
        previous(info);
    }));
}

fn append(directory: &Path, day: &str, line: &str) -> io::Result<()> {
    let path = directory.join(format!("journal-{}.jsonl", day));
    if fs::metadata(&path)
        .map(|m| m.len() + line.len() as u64 > MAX_FILE_BYTES)
        .unwrap_or(false)
    {
        // Keep three size segments per date; retention also bounds old dates.
        let oldest = directory.join(format!("journal-{}.3.jsonl", day));
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for index in (1..=2).rev() {
            let from = directory.join(format!("journal-{}.{}.jsonl", day, index));
            if from.exists() {
                fs::rename(
                    from,
                    directory.join(format!("journal-{}.{}.jsonl", day, index + 1)),
                )?;
            }
        }
        fs::rename(&path, directory.join(format!("journal-{}.1.jsonl", day)))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

fn cleanup(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("journal-")
            && name.ends_with(".jsonl")
            && entry.file_type()?.is_file()
            && entry.metadata()?.modified()?.elapsed().unwrap_or_default() > RETENTION
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

pub fn write(entry: Entry) -> Result<(), String> {
    let sender = SENDER.get().ok_or("log writer unavailable")?;
    sender.try_send(Work::Entry(entry)).map_err(|error| {
        DROPPED_ENTRIES.fetch_add(1, Ordering::Relaxed);
        eprintln!("[Socrates logger ERROR] Log queue unavailable: {}", error);
        error.to_string()
    })
}

pub fn dropped_entries() -> u64 {
    DROPPED_ENTRIES.load(Ordering::Relaxed)
}

pub fn frontend_bridge_failures() -> u64 {
    FRONTEND_BRIDGE_FAILURES.load(Ordering::Relaxed)
}

pub fn note_frontend_bridge_failure() {
    FRONTEND_BRIDGE_FAILURES.fetch_add(1, Ordering::Relaxed);
}

pub fn debug(source: &str, event: &str, message: &str) {
    let _ = write(Entry {
        level: "debug".into(),
        source: source.into(),
        event: event.into(),
        message: message.into(),
        details: None,
    });
}

pub fn info(source: &str, event: &str, message: &str) {
    let _ = write(Entry {
        level: "info".into(),
        source: source.into(),
        event: event.into(),
        message: message.into(),
        details: None,
    });
}

pub fn warn(source: &str, event: &str, message: &str) {
    let _ = write(Entry {
        level: "warn".into(),
        source: source.into(),
        event: event.into(),
        message: message.into(),
        details: None,
    });
}

struct Failure {
    details: String,
    repeats: usize,
    last_report: Instant,
}
fn failures() -> &'static Mutex<HashMap<String, Failure>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, Failure>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn error(source: &str, event: &str, details: &str) {
    let mut repeats = 0;
    if let Ok(mut failures) = failures().lock() {
        let key = format!("{}:{}", source, event);
        if let Some(last) = failures.get_mut(&key) {
            if last.details == details && last.last_report.elapsed() < Duration::from_secs(30) {
                last.repeats += 1;
                return;
            }
            repeats = last.repeats;
        }
        failures.insert(
            key,
            Failure {
                details: details.into(),
                repeats: 0,
                last_report: Instant::now(),
            },
        );
    }
    let _ = write(Entry {
        level: "error".into(),
        source: source.into(),
        event: event.into(),
        message: event.replace('_', " "),
        details: Some(format!(
            "{}\nAdditional repeats since last report: {}",
            details, repeats
        )),
    });
}

pub fn recovery(source: &str, event: &str) {
    let previous = failures()
        .lock()
        .ok()
        .and_then(|mut failures| failures.remove(&format!("{}:{}", source, event)));
    if let Some(previous) = previous {
        info(
            source,
            &format!("{}_recovered", event),
            &format!(
                "{}: recovered ({} additional failures suppressed).",
                event.replace('_', " "),
                previous.repeats
            ),
        );
    }
}

pub fn flush() {
    if let Some(sender) = SENDER.get() {
        let (done, wait) = mpsc::channel();
        if sender.try_send(Work::Flush(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(2));
        }
    }
}

#[tauri::command]
pub(crate) fn write_runtime_log(entry: Entry) -> Result<(), String> {
    if !["journal", "info", "warn", "error", "debug"].contains(&entry.level.as_str())
        || entry.source.len() > 128
        || entry.event.len() > 128
        || entry.message.len() > 4096
        || entry
            .details
            .as_ref()
            .map(|s| s.len() > 32_768)
            .unwrap_or(false)
    {
        return Err("invalid or oversized log entry".into());
    }
    write(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_rotates_without_overwriting_recent_records() {
        let directory =
            std::env::temp_dir().join(format!("socrates-logger-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let day = "2026-10-18";
        append(&directory, day, "first\n").unwrap();
        append(&directory, day, "second\n").unwrap();
        assert_eq!(
            fs::read_to_string(directory.join(format!("journal-{}.jsonl", day))).unwrap(),
            "first\nsecond\n"
        );
        let file = OpenOptions::new()
            .write(true)
            .open(directory.join(format!("journal-{}.jsonl", day)))
            .unwrap();
        file.set_len(MAX_FILE_BYTES).unwrap();
        append(&directory, day, "after rotation\n").unwrap();
        assert_eq!(
            fs::read_to_string(directory.join(format!("journal-{}.jsonl", day))).unwrap(),
            "after rotation\n"
        );
        assert!(directory.join(format!("journal-{}.1.jsonl", day)).exists());
        append(&directory, "2026-10-19", "new day\n").unwrap();
        assert!(directory.join("journal-2026-10-19.jsonl").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
