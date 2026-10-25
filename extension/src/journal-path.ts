/**
 * Primary runtime journal naming (matches companion `runtime_log.rs`); excludes `.1`–`.3` rotations.
 */

const PRIMARY_JOURNAL_RE = /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/;

export function isPrimaryJournalBasename(name: string): boolean {
  return PRIMARY_JOURNAL_RE.test(name);
}

export function primaryJournalBasename(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `journal-${y}-${m}-${d}.jsonl`;
}
