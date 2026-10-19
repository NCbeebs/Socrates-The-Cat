import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createLogStore(directory, session, { maxBytes = 5 * 1024 * 1024, now = () => new Date(), onError = console.error } = {}) {
  let lastDay = "";
  let failed = false;
  function append(kind, extension, text) {
    const date = now();
    const day = localDate(date);
    const filename = path.join(directory, `${kind}-${day}-${session}.${extension}`);
    try {
      mkdirSync(directory, { recursive: true });
      if (lastDay !== day) {
        for (const name of readdirSync(directory)) {
          if (!/^(launcher|development)-\d{4}-\d{2}-\d{2}-[\w-]+(?:\.[1-3])?\.(jsonl|log)$/.test(name)) continue;
          const entry = path.join(directory, name);
          const info = statSync(entry);
          if (info.isFile() && date.getTime() - info.mtimeMs > 14 * 86400_000) unlinkSync(entry);
        }
        lastDay = day;
      }
      if (existsSync(filename) && statSync(filename).size + Buffer.byteLength(text) > maxBytes) {
        const segment = (index) => filename.replace(new RegExp(`\\.${extension}$`), `.${index}.${extension}`);
        if (existsSync(segment(3))) unlinkSync(segment(3));
        for (let index = 2; index >= 1; index--) {
          if (existsSync(segment(index))) renameSync(segment(index), segment(index + 1));
        }
        renameSync(filename, segment(1));
      }
      appendFileSync(filename, text);
      failed = false;
    } catch (error) {
      if (!failed) onError(`[Socrates logger ERROR] Cannot save logs to ${directory}: ${error.stack ?? error}`);
      failed = true;
    }
    return filename;
  }
  return {
    raw: (text) => append("development", "log", text),
    record: (entry) => append("launcher", "jsonl", `${JSON.stringify({ timestamp: now().toISOString(), sessionId: session, ...entry })}\n`),
  };
}
