const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const storage = import(pathToFileURL(path.resolve(__dirname, "../bin/log-storage.js")).href);
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "socrates log test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("logs append across restarts, rotate by size and switch files at local midnight", async (t) => {
  const { createLogStore } = await storage;
  const dir = directory(t);
  let clock = new Date(2026, 9, 18, 23, 59);
  const options = { maxBytes: 10, now: () => clock };
  createLogStore(dir, "session", options).raw("first\n");
  createLogStore(dir, "session", options).raw("new\n");
  const store = createLogStore(dir, "session", options);
  assert.equal(readFileSync(path.join(dir, "development-2026-10-18-session.log"), "utf8"), "first\nnew\n");
  store.raw("rotated\n");
  assert.equal(readFileSync(path.join(dir, "development-2026-10-18-session.1.log"), "utf8"), "first\nnew\n");
  clock = new Date(2026, 9, 19, 0, 0);
  store.raw("tomorrow\n");
  assert.equal(readFileSync(path.join(dir, "development-2026-10-19-session.log"), "utf8"), "tomorrow\n");
});

test("retention removes only owned old files", async (t) => {
  const { createLogStore } = await storage;
  const dir = directory(t);
  for (const name of ["development-2026-01-01-session.log", "notes.log"]) {
    const file = path.join(dir, name);
    writeFileSync(file, "old");
    utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1));
  }
  createLogStore(dir, "session", { now: () => new Date(2026, 9, 18) }).raw("new\n");
  assert.ok(readdirSync(dir).includes("notes.log"));
  assert.ok(!readdirSync(dir).includes("development-2026-01-01-session.log"));
});

test("storage failures report directly once and do not stop the journal", async (t) => {
  const { createLogStore } = await storage;
  const file = path.join(directory(t), "not-a-directory");
  writeFileSync(file, "blocked");
  const errors = [];
  const store = createLogStore(file, "session", { onError: (message) => errors.push(message) });
  assert.doesNotThrow(() => { store.raw("one"); store.raw("two"); store.record({ event: "failed" }); });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Cannot save logs/);
});
