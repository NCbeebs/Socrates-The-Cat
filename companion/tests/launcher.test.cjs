const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

function fixture(t, withCli = true, source) {
  const root = mkdtempSync(path.join(tmpdir(), "socrates launcher "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "checkout", "companion");
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), '{"type":"module"}');
  const launcher = path.join(packageDir, "bin", "socrates.js");
  copyFileSync(path.resolve(__dirname, "../bin/socrates.js"), launcher);
  copyFileSync(path.resolve(__dirname, "../bin/log-storage.js"), path.join(packageDir, "bin", "log-storage.js"));
  copyFileSync(path.resolve(__dirname, "../bin/check-updates.js"), path.join(packageDir, "bin", "check-updates.js"));
  const logDir = path.join(root, "logs");
  if (withCli) {
    const cliDir = path.join(packageDir, "node_modules", "@tauri-apps", "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(path.join(cliDir, "tauri.js"), source ?? `
      console.log("VITE ready: technical build chatter");
      console.log("@socrates-log " + JSON.stringify({ timestamp: new Date().toISOString(), level: "journal", source: "cat", event: "fixture", message: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), debug: process.env.HABITAT_DEBUG }) }));
      process.exitCode = 7;
    `);
  }
  return {
    packageDir,
    logs: () => readdirSync(logDir).map((name) => readFileSync(path.join(logDir, name), "utf8")).join("\n"),
    logDir,
    runWithHook: (hookSource) => {
      const hook = path.join(root, "signal-hook.cjs");
      writeFileSync(hook, hookSource);
      return spawnSync(process.execPath, ["--require", hook, launcher], {
        cwd: root, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, HABITAT_DEBUG: "0", SOCRATES_LOG_DIR: logDir },
      });
    },
    run: (...args) => spawnSync(process.execPath, [launcher, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HABITAT_DEBUG: "0", SOCRATES_LOG_DIR: logDir },
    }),
  };
}

test("launcher runs from an unrelated directory with spaces and preserves the child exit code", (t) => {
  const { packageDir, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.match(/\{.*\}/)[0]), { cwd: packageDir, args: ["dev"], debug: "0" });
  assert.doesNotMatch(result.stdout, /technical build chatter/);
  assert.match(result.stderr, /technical build chatter/); // failure reveals the diagnostic tail
});

test("--debug enables diagnostics in the child", (t) => {
  const result = fixture(t).run("--debug");
  assert.equal(result.status, 7, result.stderr);
  assert.equal(JSON.parse(result.stdout.match(/\{.*\}/)[0]).debug, "1");
  assert.match(result.stdout, /technical build chatter/);
});

test("help and invalid arguments do not launch Tauri", (t) => {
  const { run } = fixture(t, false);
  assert.equal(run("--help").status, 0);
  assert.match(run("-h").stdout, /Usage: socrates/);
  assert.match(run("--help").stdout, /SOCRATES_CHECK_UPDATES/);
  const invalid = run("--unknown");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown arguments/);
  assert.equal(run("--debug", "extra").status, 1);
  assert.equal(run("--check-updates", "--debug").status, 1);
  assert.equal(run("--help", "--debug").status, 1);
});

test("missing dependencies produce an actionable error", (t) => {
  const setup = fixture(t, false);
  const result = setup.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run npm install/);
  assert.match(setup.logs(), /missing_dependencies/);
});

test("split records, multiline errors and final output survive pipe boundaries", (t) => {
  const setup = fixture(t, true, `
    const record = "@socrates-log " + JSON.stringify({ timestamp: new Date().toISOString(), level: "error", source: "renderer", event: "failed", message: "Render failed", details: "Error: missing clip\\n    at render (main.ts:12)" });
    process.stdout.write("@socrates-log not-json\\nVITE ready\\n" + record.slice(0, 9));
    setTimeout(() => { process.stdout.write(record.slice(9)); }, 20);
  `);
  const result = setup.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ERROR \[renderer\] Render failed/);
  assert.match(result.stderr, /at render \(main.ts:12\)/);
  assert.doesNotMatch(result.stdout, /VITE ready|not-json/);
  assert.match(setup.logs(), /not-json/);
});

test("quiet success saves raw output; verbose runtime failures still reach the terminal", (t) => {
  const setup = fixture(t, true, `
    console.log("VITE build details");
    console.error("\\x1b[91m[Socrates logger ERROR] disk unavailable\\x1b[0m\\n    at writeLog (logger.js:7)");
  `);
  const result = setup.run();
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /VITE build details/);
  assert.match(result.stderr, /disk unavailable/);
  assert.match(result.stderr, /at writeLog \(logger.js:7\)/);
  assert.doesNotMatch(result.stderr, /\x1b/);
  assert.match(setup.logs(), /VITE build details/);
});

test("Windows Ctrl+C stops the owned CLI and its grandchild", { skip: process.platform !== "win32" }, (t) => {
  let ownedPids = [];
  const setup = fixture(t, true, `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const path = require("node:path");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    fs.writeFileSync(path.join(process.env.SOCRATES_LOG_DIR, "fixture.pid"), JSON.stringify([process.pid, child.pid]));
    console.log("@socrates-log " + JSON.stringify({ timestamp: new Date().toISOString(), level: "info", source: "fixture", event: "ready", message: "owned fixture ready" }));
    setInterval(() => {}, 1000);
  `);
  t.after(() => {
    // These PIDs are exclusively fixture-owned; clean up even after a failing assertion.
    for (const pid of ownedPids) {
      try { process.kill(pid, 0); spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); }
      catch { /* Already stopped. */ }
    }
  });
  const result = setup.runWithHook(`
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      const written = original(...args);
      if (String(args[0]).includes("owned fixture ready")) setTimeout(() => process.emit("SIGINT"), 30);
      return written;
    };
  `);
  ownedPids = JSON.parse(readFileSync(path.join(setup.logDir, "fixture.pid"), "utf8"));
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stdout, /signing off/);
  for (const pid of ownedPids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
});
