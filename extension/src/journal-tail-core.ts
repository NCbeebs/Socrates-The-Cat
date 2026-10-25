/**
 * Pure journal tail parsing/formatting for tier B streaming (tested without VS Code).
 */

const MAX_DETAIL_CHARS = 500;

export type JournalTailInit = "eof" | "start" | "created";

export interface JournalTailPosition {
  instanceId: string;
  offset: number;
}

/** Stable identity for a file on disk (replacement gets a new id). */
export function journalInstanceId(stat: {
  birthtimeMs: number;
  ino: number | bigint;
}): string {
  return `${stat.birthtimeMs}:${stat.ino}`;
}

/**
 * Tail position policy: first open uses start/eof; same file instance keeps offset;
 * replacement (new identity) always resets to 0 — including continuation tails (no init).
 */
export function applyJournalTailInit(
  existing: JournalTailPosition | undefined,
  fileSize: number,
  instanceId: string,
  init?: JournalTailInit,
): { position: JournalTailPosition; skipRead: boolean } {
  if (!existing) {
    const offset = init === "eof" ? fileSize : 0;
    return {
      position: { instanceId, offset },
      skipRead: init === "eof" && offset >= fileSize,
    };
  }
  if (existing.instanceId === instanceId) {
    return { position: existing, skipRead: false };
  }
  return { position: { instanceId, offset: 0 }, skipRead: false };
}

export interface ConsumeJournalTextResult {
  nextCarry: string;
  lines: string[];
}

/**
 * Decode UTF-8 bytes, keeping a trailing incomplete code unit in `byteCarry`.
 */
export function decodeUtf8Tail(
  byteCarry: Buffer,
  read: Buffer,
): { text: string; byteCarry: Buffer } {
  if (read.length === 0) {
    return { text: "", byteCarry };
  }
  const buf = Buffer.concat([byteCarry, read]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= 3 && trim < buf.length; trim++) {
    const end = buf.length - trim;
    try {
      const text = decoder.decode(buf.subarray(0, end));
      return { text, byteCarry: buf.subarray(end) };
    } catch {
      continue;
    }
  }
  return { text: "", byteCarry: buf };
}

/**
 * Merge line carry + newly decoded text; emit up to `maxLines` complete JSONL lines.
 * Un-emitted text stays in `nextCarry`. File offset is advanced separately by bytes read.
 */
export function consumeJournalText(
  lineCarry: string,
  chunk: string,
  maxLines: number,
): ConsumeJournalTextResult {
  if (maxLines <= 0) {
    return { nextCarry: lineCarry + chunk, lines: [] };
  }
  if (!chunk) {
    if (!lineCarry) {
      return { nextCarry: "", lines: [] };
    }
  }

  const text = lineCarry + chunk;
  const parts = text.split("\n");
  const incomplete = parts.pop() ?? "";
  const complete = parts;

  const lines: string[] = [];
  let emitIndex = 0;
  while (emitIndex < complete.length && lines.length < maxLines) {
    const line = complete[emitIndex];
    emitIndex += 1;
    if (line.trim()) {
      lines.push(line);
    }
  }

  const nextCarry =
    emitIndex < complete.length
      ? `${complete.slice(emitIndex).join("\n")}\n${incomplete}`
      : incomplete;

  return { nextCarry, lines };
}

export function formatJournalLine(line: string): string | null {
  try {
    const record = JSON.parse(line) as {
      timestamp?: string;
      level?: string;
      message?: string;
      source?: string;
      event?: string;
      details?: unknown;
    };
    if (typeof record.message !== "string") {
      return null;
    }
    const time =
      typeof record.timestamp === "string" && record.timestamp
        ? record.timestamp
        : "";
    const level = record.level ?? "info";
    const source = record.source ? `${record.source}/` : "";
    const event =
      typeof record.event === "string" && record.event
        ? `${record.event} `
        : "";
    const prefix = time
      ? `${time} journal [${level}] ${source}${event}`
      : `journal [${level}] ${source}${event}`;
    let out = `${prefix}${record.message}`;
    if (record.details !== undefined && record.details !== null) {
      const raw =
        typeof record.details === "string"
          ? record.details
          : JSON.stringify(record.details);
      const trimmed = raw.replace(/\r?\n/g, "\n").trim();
      if (trimmed) {
        const bounded =
          trimmed.length > MAX_DETAIL_CHARS
            ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
            : trimmed;
        out += `\n          ${bounded.split("\n").join("\n          ")}`;
      }
    }
    return out;
  } catch {
    return `journal raw ${line}`;
  }
}
