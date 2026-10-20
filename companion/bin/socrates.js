#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createLogStore, localDate } from "./log-storage.js";
import { checkForUpstreamUpdate, formatCheckUpdatesCli, sanitizeForTerminal } from "./check-updates.js";

const args = process.argv.slice(2);
const debug = args.includes("--debug");
const checkUpdatesOnly = args.includes("--check-updates");
const unknown = args.filter((a) => a !== "--debug" && a !== "--check-updates");

if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(
    "Usage: socrates [--debug] [--check-updates]\n\nLaunch Socrates' daily journal from this checkout.\n  --debug           Verbose diagnostics, HUD, surface wireframes, and raw development output\n  --check-updates   Compare this checkout to upstream main on GitHub (no launch)\n\nOptional update notice on launch (opt-in, PowerShell):\n  $env:SOCRATES_CHECK_UPDATES = \"1\"\n  GitHub receives your local commit SHA and your IP; cached 24h under %LOCALAPPDATA%\\Socrates\\.\n\nLogs (14-day retention):\n  journal-*.jsonl     runtime (@socrates-log from the app)\n  launcher-*.jsonl    this terminal session\n  development-*.log   raw tool output (always saved)\n\nKeep this terminal open; press Ctrl+C to stop.",
  );
} else if (unknown.length > 0) {
  console.error("Unknown arguments. Usage: socrates [--debug] [--check-updates]");
  process.exitCode = 1;
} else if (checkUpdatesOnly && debug) {
  console.error("Use --check-updates alone (without --debug) to check for updates without launching.");
  process.exitCode = 1;
} else if (checkUpdatesOnly) {
  runCheckUpdatesCli();
} else {
  launch();
}

async function runCheckUpdatesCli() {
  const result = await checkForUpstreamUpdate({
    companionPackageDir: fileURLToPath(new URL("../", import.meta.url)),
    force: true,
  });
  console.log(formatCheckUpdatesCli(result));
  process.exitCode = result.kind === "failed" ? 1 : 0;
}

function envTruthy(name) {
  const value = process.env[name]?.trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  return !(value === "0" || lower === "false" || lower === "off");
}

function launch() {
  const showRawDevOutput = debug;
  const showStructuredDiagnostics = debug || envTruthy("HABITAT_DEBUG_LOG");
  const session = randomUUID();
  const base = process.env.LOCALAPPDATA ?? (process.platform === "win32" ? tmpdir() : path.join(homedir(), ".local", "share"));
  const directory = process.env.SOCRATES_LOG_DIR ?? path.join(base, "Socrates", "logs");
  const store = createLogStore(directory, session);
  let displayDay = localDate();
  console.log(
    `SOCRATES' JOURNAL · ${displayDay}\nSession: ${session}\nLogs: ${directory}\n  journal-*.jsonl  launcher-${localDate()}-${session}.jsonl  development-${localDate()}-${session}.log\n`,
  );
  function display(entry) {
    const date = new Date(entry.timestamp ?? Date.now());
    const day = localDate(date);
    if (day !== displayDay) {
      console.log(`\nSOCRATES' JOURNAL · ${day}\n`);
      displayDay = day;
    }
    const time = date.toLocaleTimeString("en-GB", { hour12: false });
    const level = entry.level ?? "info";
    const diagnostic = level === "warn" || level === "error";
    const structured = debug || (showStructuredDiagnostics && level === "debug");
    const label = structured
      ? `${level.toUpperCase()} [${entry.source}/${entry.event ?? "event"}] `
      : diagnostic
        ? `${level.toUpperCase()} [${entry.source}] `
        : "";
    const output = diagnostic ? process.stderr : process.stdout;
    output.write(`${time}  ${label}${stripVTControlCharacters(entry.message)}\n`);
    if (entry.details) output.write(`${stripVTControlCharacters(String(entry.details)).split("\n").map((line) => `          ${line}`).join("\n")}\n`);
  }
  function log(level, event, message, details) {
    const entry = { level, source: "launcher", event, message, details };
    store.record(entry);
    display(entry);
  }
  const require = createRequire(import.meta.url);
  let cli;
  try {
    cli = require.resolve("@tauri-apps/cli/tauri.js");
  } catch (error) {
    log("error", "missing_dependencies", "Socrates dependencies are missing. Run npm install in the checkout's companion directory.", error.stack);
    process.exitCode = 1;
  }

  if (cli) {
    const companionPackageDir = fileURLToPath(new URL("../", import.meta.url));
    const updateAbort = new AbortController();
    // Resolve from the launcher, since a globally linked command can run anywhere.
    if (process.env.HABITAT_IDE_HOST?.trim()) {
      log("info", "ide_host", `Using HABITAT_IDE_HOST=${process.env.HABITAT_IDE_HOST.trim()} from environment.`);
    }
    if (envTruthy("SOCRATES_CHECK_UPDATES")) {
      setImmediate(() => {
        checkForUpstreamUpdate({ companionPackageDir, signal: updateAbort.signal })
          .then((result) => {
            if (result.kind === "update_available" && !updateAbort.signal.aborted) {
              log("warn", "update_available", sanitizeForTerminal(result.message));
            }
          })
          .catch(() => {
            /* checkForUpstreamUpdate does not throw; guard launch either way. */
          });
      });
    }
    log("info", "starting", "Getting Socrates ready. The first build may take a moment.");
    const child = spawn(process.execPath, [cli, "dev"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        SOCRATES_LOG_DIR: directory,
        SOCRATES_SESSION_ID: session,
        ...(debug ? { HABITAT_DEBUG: "1", HABITAT_DEBUG_LOG: "1" } : {}),
      },
    });
    let tail = "";
    let stopping = false;
    let killTimer;
    const diagnosticBlock = { stdout: false, stderr: false };
    const handleLine = (line, stream) => {
      const prefix = "@socrates-log ";
      const marker = line.indexOf(prefix);
      if (marker >= 0) {
        try {
          const record = JSON.parse(line.slice(marker + prefix.length));
          const level = record.level;
          if (!["journal", "info", "warn", "error", "debug"].includes(level) || typeof record.message !== "string"
            || typeof record.source !== "string" || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("Invalid record");
          if (level === "debug" && !showStructuredDiagnostics) return;
          display(record);
          return;
        } catch { /* Preserve malformed records as raw diagnostics. */ }
      }
      store.raw(`[${stream}] ${line}\n`);
      tail = `${tail}${line}\n`.slice(-24_000);
      if (showRawDevOutput) (stream === "stderr" ? process.stderr : process.stdout).write(`${line}\n`);
      else {
        // Cargo uses carriage-return progress updates and ANSI even through pipes.
        for (const clean of stripVTControlCharacters(line).split("\r")) {
          if (/\b(error|warning|warn|panic|panicked|fatal)\b/i.test(clean)) {
            diagnosticBlock[stream] = true;
            log(/\b(warning|warn)\b/i.test(clean) ? "warn" : "error", "tool_diagnostic", clean.trim());
          } else if (!clean.trim()) {
            diagnosticBlock[stream] = false;
          } else if (diagnosticBlock[stream]) {
            process.stderr.write(`          ${clean}\n`);
          }
        }
      }
    };
    // Decode UTF-8 and buffer records split across arbitrary pipe chunks.
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          handleLine(pending.slice(0, newline).replace(/\r$/, ""), name);
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 64_000) { handleLine(pending, name); pending = ""; }
      });
      stream.on("end", () => { if (pending) handleLine(pending, name); });
      stream.on("error", (error) => log("error", "output_pipe_failed", `${name} capture failed.`, error.stack));
    }
    const stop = () => {
      if (stopping) return;
      stopping = true;
      updateAbort.abort();
      log("info", "stopping", "Socrates is signing off.");
      if (!child.pid) return;
      if (process.platform === "win32") {
        // Tauri owns Cargo, Vite and the app; include all descendants.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let killError = "";
        killer.stderr.setEncoding("utf8");
        killer.stderr.on("data", (chunk) => { killError = `${killError}${chunk}`.slice(-4096); });
        killer.on("error", (error) => {
          log("error", "shutdown_failed", "Could not stop the process tree.", error.stack);
          child.kill();
        });
        killer.on("exit", (code) => {
          if (code && child.exitCode === null) {
            log("error", "shutdown_failed", `Process-tree shutdown exited with code ${code}; attempting to stop the CLI directly.`, killError);
            child.kill();
          }
        });
      } else {
        child.kill("SIGINT");
        killTimer = setTimeout(() => child.kill("SIGTERM"), 3000);
        killTimer.unref();
      }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("error", (error) => {
      updateAbort.abort();
      log("error", "launch_failed", `Could not launch Socrates: ${error.message}`, error.stack);
      process.exitCode = 1;
    });
    child.on("close", (code, signal) => {
      // A pending update request must not keep the launcher alive after Socrates exits.
      updateAbort.abort();
      clearTimeout(killTimer);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (!stopping && code !== 0) {
        log("error", "unexpected_exit", `Socrates exited unexpectedly (${signal ?? code}). Attach session ${session} and files under ${directory}.`, tail);
      } else if (!stopping) {
        log("info", "stopped", "Socrates has signed off.");
      }
      process.exitCode = stopping ? 130 : code ?? (signal === "SIGINT" ? 130 : 1);
    });
  }
}
