import { invoke } from "@tauri-apps/api/core";
import { errorDetails, type LogEntry } from "./journal";

// One bounded queue prevents slow disk/IPC from accumulating work in the render loop.
const pending: LogEntry[] = [];
let sending = false;
let fallbackReported = false;
let droppedFrontend = 0;

export function writeLog(entry: LogEntry) {
  if (pending.length >= 128) {
    droppedFrontend += 1;
    console.error("Socrates log queue full; record not saved", entry);
    return;
  }
  pending.push(entry);
  void drain();
}

async function drain() {
  if (sending) return;
  sending = true;
  try {
    while (pending.length) {
      const entry = pending.shift()!;
      try { await invoke("write_runtime_log", { entry }); }
      catch (error) {
        // Never feed logger failures back through the logger.
        void invoke("note_log_bridge_failure").catch(() => {});
        if (!fallbackReported) {
          fallbackReported = true;
          console.error("Socrates logging bridge failed", error);
        }
        console.error("Unsaved Socrates entry", entry);
      }
    }
  } finally { sending = false; }
}

const failures = new Map<string, { details: string; repeats: number; lastReport: number }>();

export function reportFailure(source: string, event: string, error: unknown, context = "") {
  const details = `${errorDetails(error)}${context ? `\nContext: ${context}` : ""}`;
  const key = `${source}:${event}`;
  const previous = failures.get(key);
  const now = Date.now();
  if (previous?.details === details && now - previous.lastReport < 30_000) {
    previous.repeats++;
    return;
  }
  failures.set(key, { details, repeats: 0, lastReport: now });
  writeLog({ level: "error", source, event, message: `${event.replace(/_/g, " ")}${previous?.repeats ? ` (${previous.repeats} additional failures)` : ""}`, details });
}

export function writeDebug(source: string, event: string, message: string) {
  writeLog({ level: "debug", source, event, message });
}

export function reportRecovery(source: string, event: string) {
  const key = `${source}:${event}`;
  const previous = failures.get(key);
  if (!previous) return;
  failures.delete(key);
  writeLog({ level: "info", source, event: `${event}_recovered`, message: `${event.replace(/_/g, " ")}: recovered.`, details: `${previous.repeats} repeated failures suppressed since the last report.` });
}

window.addEventListener("error", (event) => {
  reportFailure("frontend", "uncaught_exception", event.error ?? event.message, `${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener("unhandledrejection", (event) => reportFailure("frontend", "unhandled_rejection", event.reason));
