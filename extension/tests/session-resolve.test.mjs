import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  managedLogDirectory,
  resolveCompanionExecutable,
} from "../out/session.js";

test("resolveCompanionExecutable prefers bundled bin path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-ext-"));
  const bundled = path.join(root, "bin", "win32-x64", "companion.exe");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, "stub");
  assert.equal(resolveCompanionExecutable(root, false), bundled);
  assert.equal(resolveCompanionExecutable(root, true), bundled);
  fs.rmSync(root, { recursive: true, force: true });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-ext-empty-"));
  assert.throws(() => resolveCompanionExecutable(empty, false));
  fs.rmSync(empty, { recursive: true, force: true });
});

test("managedLogDirectory uses LOCALAPPDATA when set", () => {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join("C:", "Users", "test", "AppData", "Local");
  const dir = managedLogDirectory();
  assert.match(dir, /Socrates[\\/]logs[\\/]vscode-managed$/);
  if (previous === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = previous;
  }
});
