const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function load(invoke, errors = []) {
  const listeners = {};
  const compiled = (name) => ts.transpileModule(readFileSync(path.join(__dirname, `../src/${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const journal = {};
  new Function("exports", compiled("journal"))(journal);
  const exports = {};
  new Function("require", "exports", "window", "console", compiled("runtime-log"))(
    (name) => name === "./journal" ? journal : { invoke }, exports,
    { addEventListener: (event, handler) => { listeners[event] = handler; } },
    { error: (...args) => errors.push(args) },
  );
  return { ...exports, listeners };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("repeated frontend errors are summarized and recovery clears the failure", async () => {
  const entries = [];
  const logger = load(async (_, { entry }) => entries.push(entry));
  const error = new Error("pointer unavailable");
  logger.reportFailure("pointer", "poll_failed", error);
  logger.reportFailure("pointer", "poll_failed", error);
  logger.reportFailure("pointer", "poll_failed", error);
  logger.reportRecovery("pointer", "poll_failed");
  logger.reportRecovery("pointer", "poll_failed");
  await settle();
  assert.equal(entries.length, 2);
  assert.match(entries[0].details, /Error: pointer unavailable/);
  assert.equal(entries[1].event, "poll_failed_recovered");
  assert.match(entries[1].details, /2 repeated failures/);
  logger.reportFailure("pointer", "poll_failed", error);
  await settle();
  assert.equal(entries.length, 3);
});

test("global exceptions and rejected promises preserve their diagnostics", async () => {
  const entries = [];
  const logger = load(async (_, { entry }) => entries.push(entry));
  logger.listeners.error({ error: new Error("render failed"), filename: "main.ts", lineno: 42, colno: 3 });
  logger.listeners.unhandledrejection({ reason: "backend disconnected" });
  await settle();
  assert.match(entries[0].details, /render failed[\s\S]*main.ts:42:3/);
  assert.match(entries[1].details, /backend disconnected/);
});

test("bridge failure falls back without recursive logging", async () => {
  const commands = [];
  const errors = [];
  const logger = load(async (cmd) => {
    commands.push(cmd);
    if (cmd === "write_runtime_log") throw new Error("IPC unavailable");
  }, errors);
  logger.writeLog({ level: "info", source: "test", event: "first", message: "one" });
  logger.writeLog({ level: "info", source: "test", event: "second", message: "two" });
  await settle();
  assert.equal(commands.filter((cmd) => cmd === "write_runtime_log").length, 2);
  assert.equal(commands.filter((cmd) => cmd === "note_log_bridge_failure").length, 2);
  assert.equal(errors.filter((args) => args[0] === "Socrates logging bridge failed").length, 1);
  assert.equal(errors.filter((args) => args[0] === "Unsaved Socrates entry").length, 2);
});
