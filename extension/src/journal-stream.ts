/**
 * Tier B: tail today's primary `journal-YYYY-MM-DD.jsonl` into the Socrates output channel.
 * Byte offsets, UTF-8-safe reads, serialized tail queue, disposal-safe.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  applyJournalTailInit,
  consumeJournalText,
  decodeUtf8Tail,
  formatJournalLine,
  journalInstanceId,
  type JournalTailInit,
} from "./journal-tail-core.js";
import { isPrimaryJournalBasename, primaryJournalBasename } from "./journal-path.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINES_PER_WAKE = 40;

interface FileTailState {
  offset: number;
  lineCarry: string;
  byteCarry: Buffer;
  instanceId: string;
}

export class JournalStream implements vscode.Disposable {
  readonly logDir: string;
  private readonly channel: vscode.OutputChannel;
  private readonly fileState = new Map<string, FileTailState>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private tailChain: Promise<void> = Promise.resolve();
  private linesEmittedThisWake = 0;

  constructor(logDir: string, channel: vscode.OutputChannel) {
    this.logDir = logDir;
    this.channel = channel;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const pattern = new vscode.RelativePattern(logDir, "journal-*.jsonl");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(watcher);
    watcher.onDidChange((uri) => {
      if (isPrimaryJournalBasename(path.basename(uri.fsPath))) {
        this.scheduleTail(uri.fsPath);
      }
    });
    watcher.onDidCreate((uri) => {
      this.onPrimaryJournalCreated(uri.fsPath);
    });
    const today = path.join(logDir, primaryJournalBasename());
    const init: JournalTailInit = fs.existsSync(today) ? "eof" : "start";
    this.scheduleTail(today, init);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.fileState.clear();
  }

  private onPrimaryJournalCreated(filePath: string): void {
    if (!isPrimaryJournalBasename(path.basename(filePath))) {
      return;
    }
    this.scheduleTail(filePath, "created");
  }

  private scheduleTail(filePath: string, init?: JournalTailInit): void {
    if (this.disposed || !isPrimaryJournalBasename(path.basename(filePath))) {
      return;
    }
    this.tailChain = this.tailChain.then(() => this.tailFile(filePath, init));
  }

  private reconcileStateForStat(
    prior: FileTailState | undefined,
    stat: fs.Stats,
    position: { instanceId: string; offset: number },
  ): FileTailState {
    const truncated = stat.size < position.offset;
    const offset = truncated ? 0 : position.offset;
    if (
      !truncated &&
      prior &&
      prior.instanceId === position.instanceId
    ) {
      return { ...prior, offset };
    }
    return {
      offset,
      lineCarry: "",
      byteCarry: Buffer.alloc(0),
      instanceId: position.instanceId,
    };
  }

  private refreshStateAfterStat(
    state: FileTailState,
    stat: fs.Stats,
  ): FileTailState {
    const instanceId = journalInstanceId(stat);
    const applied = applyJournalTailInit(
      { instanceId: state.instanceId, offset: state.offset },
      stat.size,
      instanceId,
    );
    return this.reconcileStateForStat(state, stat, applied.position);
  }

  private async tailFile(
    filePath: string,
    init?: JournalTailInit,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.linesEmittedThisWake = 0;
    try {
      let stat = await fs.promises.stat(filePath);
      const instanceId = journalInstanceId(stat);
      const existing = this.fileState.get(filePath);
      const existingPosition = existing
        ? { instanceId: existing.instanceId, offset: existing.offset }
        : undefined;
      const applied = applyJournalTailInit(
        existingPosition,
        stat.size,
        instanceId,
        init,
      );
      let state = this.reconcileStateForStat(existing, stat, applied.position);
      this.fileState.set(filePath, state);
      if (applied.skipRead) {
        return;
      }

      while (
        !this.disposed &&
        state.offset < stat.size &&
        this.linesEmittedThisWake < MAX_LINES_PER_WAKE
      ) {
        const handle = await fs.promises.open(filePath, "r");
        try {
          const toRead = Math.min(
            READ_CHUNK_BYTES,
            stat.size - state.offset,
          );
          if (toRead <= 0) {
            break;
          }
          const buffer = Buffer.alloc(toRead);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            toRead,
            state.offset,
          );
          if (this.disposed) {
            return;
          }
          if (bytesRead <= 0) {
            break;
          }
          state.offset += bytesRead;

          const { text, byteCarry } = decodeUtf8Tail(
            state.byteCarry,
            buffer.subarray(0, bytesRead),
          );
          state.byteCarry = byteCarry;

          const remainingLines = MAX_LINES_PER_WAKE - this.linesEmittedThisWake;
          const parsed = consumeJournalText(
            state.lineCarry,
            text,
            remainingLines,
          );
          if (this.disposed) {
            return;
          }
          state.lineCarry = parsed.nextCarry;

          for (const line of parsed.lines) {
            const formatted = formatJournalLine(line);
            if (formatted) {
              this.channel.appendLine(formatted);
              this.linesEmittedThisWake += 1;
            }
          }

          if (!text && parsed.lines.length === 0) {
            break;
          }
        } finally {
          await handle.close();
        }
        stat = await fs.promises.stat(filePath);
        state = this.refreshStateAfterStat(state, stat);
        this.fileState.set(filePath, state);
      }

      while (
        !this.disposed &&
        this.linesEmittedThisWake < MAX_LINES_PER_WAKE &&
        state.lineCarry.includes("\n")
      ) {
        const parsed = consumeJournalText(
          state.lineCarry,
          "",
          MAX_LINES_PER_WAKE - this.linesEmittedThisWake,
        );
        state.lineCarry = parsed.nextCarry;
        if (parsed.lines.length === 0) {
          break;
        }
        for (const line of parsed.lines) {
          const formatted = formatJournalLine(line);
          if (formatted) {
            this.channel.appendLine(formatted);
            this.linesEmittedThisWake += 1;
          }
        }
      }

      if (!this.disposed) {
        if (state.offset < stat.size || state.lineCarry.includes("\n")) {
          this.scheduleTail(filePath);
        }
      }
    } catch {
      // File may be mid-rotation or locked briefly.
    }
  }
}
