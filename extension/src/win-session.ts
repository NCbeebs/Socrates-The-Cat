/**
 * Windows session id for managed pipe/mutex names (must match native `managed_lifecycle`).
 * Used by managed-pipe.ts and session.ts; no vscode imports so Node tests can run.
 */

import { execFileSync } from "node:child_process";

let cachedSessionId: number | undefined;

/** Same suffix as Rust `session_id()` — interactive session for this extension host. */
export function getWindowsSessionId(): number {
  if (cachedSessionId !== undefined) {
    return cachedSessionId;
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const out = execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).SessionId"],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  const id = Number.parseInt(out, 10);
  if (!Number.isFinite(id) || id < 0) {
    throw new Error("Could not determine Windows session id for managed pipe.");
  }
  cachedSessionId = id;
  return id;
}

export function managedPipePath(): string {
  return `\\\\.\\pipe\\Socrates.Habitat.Managed.v1.${getWindowsSessionId()}`;
}
