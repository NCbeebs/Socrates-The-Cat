/**
 * Per–extension-host session: spawn or attach to the managed companion and hold pipe ownership.
 * Wired from extension.ts Start/Stop/deactivate; does not stop unrelated source-launched cats.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import {
  connectPipe,
  exchangeOne,
  pipePath,
  PROTOCOL_VERSION,
  queryStatus,
  type StatusPayload,
  waitForReady,
} from "./managed-pipe.js";

export interface SessionOptions {
  extensionPath: string;
  logDir: string;
  allowDevCompanionFallback: boolean;
}

export interface SessionSnapshot {
  attached: boolean;
  clientId: string | null;
  companionPath: string | null;
  lastStatus: StatusPayload | null;
  spawnedChild: boolean;
  pipePath: string;
  logDir: string;
}

export class ManagedSession {
  private readonly clientId = crypto.randomUUID();
  private socket: net.Socket | null = null;
  private child: ChildProcess | null = null;
  private lastStatus: StatusPayload | null = null;
  private companionPath: string | null = null;
  private readonly options: SessionOptions;
  private opChain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Aborts the current or queued Start attempt (created when Start is enqueued). */
  private startAttemptAbort: AbortController | null = null;

  constructor(options: SessionOptions) {
    this.options = options;
  }

  snapshot(): SessionSnapshot {
    return {
      attached: this.socket !== null,
      clientId: this.socket ? this.clientId : null,
      companionPath: this.companionPath,
      lastStatus: this.lastStatus,
      spawnedChild: this.child !== null,
      pipePath: pipePath(),
      logDir: this.options.logDir,
    };
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const attempt = this.beginStartAttempt();
    return this.enqueue(async () => {
      if (this.disposed || attempt.signal.aborted || this.socket) {
        this.finishStartAttempt(attempt);
        return;
      }
      const signal = attempt.signal;

      let spawned: ChildProcess | null = null;
      try {
        const exe = resolveCompanionExecutable(
          this.options.extensionPath,
          this.options.allowDevCompanionFallback,
        );
        this.companionPath = exe;
        const existing = await queryStatus(2_000, signal);
        this.assertStartStillValid(signal);

        if (!existing?.ready) {
          spawned = spawn(
            exe,
            ["--habitat-managed"],
            {
              cwd: path.dirname(exe),
              env: {
                ...process.env,
                HABITAT_IDE_HOST: "code",
                HABITAT_MANAGED: "1",
                SOCRATES_LOG_DIR: this.options.logDir,
              },
              windowsHide: true,
              stdio: "ignore",
            },
          );
          this.child = spawned;
          spawned.once("error", () => {
            if (this.child === spawned) {
              this.child = null;
            }
          });
          spawned.once("exit", () => {
            if (this.child === spawned) {
              this.child = null;
            }
          });
          this.assertStartStillValid(signal);
          this.lastStatus = await waitForReady(60_000, 250, signal);
        } else {
          this.lastStatus = existing;
        }

        this.assertStartStillValid(signal);

        const socket = await connectPipe(signal);
        try {
          const attached = await exchangeOne(
            socket,
            {
              op: "attach",
              client_id: this.clientId,
              protocol: PROTOCOL_VERSION,
            },
            8_000,
            signal,
          );
          if (!attached.ok) {
            throw new Error(attached.error ?? "attach failed");
          }
          this.assertStartStillValid(signal);
          this.lastStatus = attached.status ?? this.lastStatus;
          this.socket = socket;
          this.bindAttachedSocket(socket);
        } catch (error) {
          socket.destroy();
          throw error;
        }
      } catch (error) {
        if (this.child === spawned) {
          this.child = null;
        }
        if (error instanceof Error && error.message === "operation aborted") {
          return;
        }
        throw error;
      } finally {
        this.finishStartAttempt(attempt);
      }
    });
  }

  stop(): Promise<void> {
    this.cancelStartAttempts();
    return this.enqueue(async () => {
      const attached = this.socket;
      if (attached) {
        try {
          await exchangeOne(attached, { op: "stop" });
        } catch {
          // Server may already be exiting.
        }
        attached.destroy();
        if (this.socket === attached) {
          this.socket = null;
        }
      } else {
        const socket = await connectPipe().catch(() => null);
        if (socket) {
          try {
            await exchangeOne(socket, { op: "stop" });
          } finally {
            socket.destroy();
          }
        }
      }
      this.child = null;
      this.lastStatus = null;
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.cancelStartAttempts();
    return this.enqueue(async () => {
      const attached = this.socket;
      if (attached) {
        try {
          await exchangeOne(attached, {
            op: "release",
            client_id: this.clientId,
          });
        } catch {
          // Best-effort release on window close.
        }
        attached.destroy();
        if (this.socket === attached) {
          this.socket = null;
        }
      }
      this.child = null;
    });
  }

  private beginStartAttempt(): AbortController {
    this.startAttemptAbort?.abort();
    const attempt = new AbortController();
    this.startAttemptAbort = attempt;
    return attempt;
  }

  private finishStartAttempt(attempt: AbortController): void {
    if (this.startAttemptAbort === attempt) {
      this.startAttemptAbort = null;
    }
  }

  private cancelStartAttempts(): void {
    this.startAttemptAbort?.abort();
    this.startAttemptAbort = null;
  }

  private bindAttachedSocket(socket: net.Socket): void {
    const onLost = () => {
      if (this.socket === socket) {
        this.socket = null;
      }
    };
    socket.on("error", onLost);
    socket.on("close", onLost);
  }

  private assertStartStillValid(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) {
      throw new Error("operation aborted");
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.opChain.then(task);
    this.opChain = next.catch(() => undefined);
    return next;
  }
}

export function resolveCompanionExecutable(
  extensionPath: string,
  allowDevCompanionFallback: boolean,
): string {
  const bundled = path.join(extensionPath, "bin", "win32-x64", "companion.exe");
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  if (!allowDevCompanionFallback) {
    throw new Error(
      `Companion executable not found at ${bundled}. Reinstall the extension or run package:win.`,
    );
  }
  const devBuild = path.join(
    extensionPath,
    "..",
    "companion",
    "src-tauri",
    "target",
    "release",
    "companion.exe",
  );
  if (fs.existsSync(devBuild)) {
    return devBuild;
  }
  throw new Error(
    `Companion executable not found. Build with "npm run tauri:build:release" in companion/, or stage ${bundled}.`,
  );
}

export function managedLogDirectory(): string {
  const base = process.env.LOCALAPPDATA;
  if (base) {
    return path.join(base, "Socrates", "logs", "vscode-managed");
  }
  return path.join(process.env.TEMP ?? ".", "Socrates", "logs", "vscode-managed");
}
