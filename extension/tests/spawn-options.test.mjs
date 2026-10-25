import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManagedChildEnv,
  buildManagedSpawnArgs,
  HABITAT_DEBUG_ENV_KEYS,
  resolveDebugEffective,
} from "../out/spawn-options.js";

test("resolveDebugEffective: debugLog follows enabled or streamJournal", () => {
  assert.deepEqual(
    resolveDebugEffective({
      enabled: false,
      surfaces: null,
      hud: null,
      streamJournal: true,
    }),
    {
      effectiveSurfaces: false,
      effectiveHud: false,
      effectiveStreamJournal: true,
      effectiveDebugLog: true,
    },
  );
  assert.deepEqual(
    resolveDebugEffective({
      enabled: true,
      surfaces: null,
      hud: null,
      streamJournal: false,
    }).effectiveDebugLog,
    true,
  );
});

test("buildManagedSpawnArgs adds --debug only when enabled", () => {
  assert.deepEqual(
    buildManagedSpawnArgs({
      enabled: false,
      surfaces: true,
      hud: null,
      streamJournal: null,
    }),
    ["--habitat-managed"],
  );
  assert.deepEqual(
    buildManagedSpawnArgs({
      enabled: true,
      surfaces: null,
      hud: null,
      streamJournal: null,
    }),
    ["--habitat-managed", "--debug"],
  );
});

test("scrub removes inherited HABITAT_DEBUG_HUD=0 before applying enabled", () => {
  const plan = buildManagedChildEnv(
    {
      HABITAT_DEBUG_HUD: "0",
      HABITAT_DEBUG: "0",
      PATH: "C:\\Windows",
    },
    "C:\\logs\\vscode-managed",
    {
      enabled: true,
      surfaces: null,
      hud: null,
      streamJournal: null,
    },
  );
  assert.equal(plan.env.HABITAT_DEBUG, "1");
  assert.equal(plan.env.HABITAT_DEBUG_HUD, "1");
  assert.equal(plan.env.PATH, "C:\\Windows");
});

test("pet mode clears inherited HABITAT_DEBUG=1", () => {
  const plan = buildManagedChildEnv(
    { HABITAT_DEBUG: "1", HABITAT_DEBUG_LOG: "1" },
    "C:\\logs\\vscode-managed",
    {
      enabled: false,
      surfaces: null,
      hud: null,
      streamJournal: null,
    },
  );
  assert.equal(plan.env.HABITAT_DEBUG, undefined);
  assert.equal(plan.env.HABITAT_DEBUG_LOG, "0");
  for (const key of HABITAT_DEBUG_ENV_KEYS) {
    if (key === "HABITAT_DEBUG") {
      continue;
    }
    assert.equal(plan.env[key], "0");
  }
});

test("enabled false with explicit surfaces only", () => {
  const plan = buildManagedChildEnv(
    {},
    "C:\\logs\\vscode-managed",
    {
      enabled: false,
      surfaces: true,
      hud: null,
      streamJournal: null,
    },
  );
  assert.deepEqual(plan.argv, ["--habitat-managed"]);
  assert.equal(plan.env.HABITAT_DEBUG, undefined);
  assert.equal(plan.env.HABITAT_DEBUG_SURFACES, "1");
  assert.equal(plan.env.HABITAT_DEBUG_HUD, "0");
  assert.equal(plan.env.HABITAT_DEBUG_LOG, "0");
});
