import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyJournalTailInit,
  consumeJournalText,
  decodeUtf8Tail,
  formatJournalLine,
} from "../out/journal-tail-core.js";
import {
  isPrimaryJournalBasename,
  primaryJournalBasename,
} from "../out/journal-path.js";

test("consumeJournalText batches without duplicating when offset advances separately", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `{"message":"m${i}"}`);
  const chunk = `${lines.join("\n")}\n`;
  let lineCarry = "";
  const first = consumeJournalText(lineCarry, chunk, 40);
  lineCarry = first.nextCarry;
  assert.equal(first.lines.length, 40);
  const second = consumeJournalText(lineCarry, "", 40);
  assert.equal(second.lines.length, 40);
  const third = consumeJournalText(second.nextCarry, "", 40);
  assert.equal(third.lines.length, 20);
  assert.equal(
    first.lines.length + second.lines.length + third.lines.length,
    100,
  );
});

test("decodeUtf8Tail preserves emoji split across byte chunks", () => {
  const payload = Buffer.from('{"message":"🐈"}\n', "utf8");
  const split = payload.indexOf(0xf0);
  const a = payload.subarray(0, split + 1);
  const b = payload.subarray(split + 1);
  const first = decodeUtf8Tail(Buffer.alloc(0), a);
  const second = decodeUtf8Tail(first.byteCarry, b);
  const parsed = consumeJournalText("", first.text + second.text, 10);
  assert.equal(parsed.lines.length, 1);
  assert.equal(JSON.parse(parsed.lines[0]).message, "🐈");
  assert.equal(formatJournalLine(parsed.lines[0]).includes("🐈"), true);
});

test("formatJournalLine includes timestamp and bounded details", () => {
  const line = JSON.stringify({
    timestamp: "2026-10-25T12:00:00.000Z",
    level: "error",
    source: "native",
    event: "boot_failed",
    message: "Could not start",
    details: "WebView2 missing",
  });
  const formatted = formatJournalLine(line);
  assert.match(formatted, /2026-10-25T12:00:00.000Z/);
  assert.match(formatted, /boot_failed/);
  assert.match(formatted, /WebView2 missing/);
});

test("applyJournalTailInit is idempotent for duplicate start/create on same instance", () => {
  const id = "1000:42";
  const afterStart = applyJournalTailInit(
    undefined,
    10,
    id,
    "start",
  ).position;
  assert.equal(afterStart.offset, 0);
  const progressed = { instanceId: id, offset: 8 };
  const afterCreate = applyJournalTailInit(progressed, 10, id, "created");
  assert.equal(afterCreate.position.offset, 8);
  const replacement = applyJournalTailInit(progressed, 0, "2000:42", "created");
  assert.equal(replacement.position.offset, 0);
  assert.equal(replacement.position.instanceId, "2000:42");
});

test("applyJournalTailInit resets on instance change without init (rotation race)", () => {
  const progressed = { instanceId: "1000:42", offset: 80 };
  const rotated = applyJournalTailInit(progressed, 12, "2000:99");
  assert.equal(rotated.position.offset, 0);
  assert.equal(rotated.position.instanceId, "2000:99");
  const same = applyJournalTailInit(progressed, 12, "1000:42");
  assert.equal(same.position.offset, 80);
});

test("primary journal basename excludes rotation archives", () => {
  assert.equal(isPrimaryJournalBasename(primaryJournalBasename()), true);
  assert.equal(isPrimaryJournalBasename("journal-2026-10-25.1.jsonl"), false);
});
