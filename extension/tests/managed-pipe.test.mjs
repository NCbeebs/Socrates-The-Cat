import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatRequest,
  parsePipeResponse,
  parseStatusPayload,
  PROTOCOL_VERSION,
} from "../out/managed-pipe.js";
import { managedPipePath } from "../out/win-session.js";

test("pipe path is session-scoped", () => {
  assert.match(managedPipePath(), /^\\\\\.\\pipe\\Socrates\.Habitat\.Managed\.v1\.\d+$/);
  assert.equal(PROTOCOL_VERSION, 1);
});

test("formatRequest appends newline", () => {
  assert.equal(
    formatRequest({ op: "status", protocol: 1 }),
    '{"op":"status","protocol":1}\n',
  );
});

test("parsePipeResponse accepts status payload", () => {
  const line =
    '{"ok":true,"op":"status","status":{"protocol":1,"version":"0.1.0","ready":true,"owners":2}}';
  const parsed = parsePipeResponse(line);
  assert.ok(parsed?.ok);
  assert.equal(parsed?.status?.owners, 2);
});

test("parseStatusPayload rejects non-boolean ready", () => {
  assert.equal(
    parseStatusPayload({
      protocol: 1,
      version: "0.1.0",
      ready: "yes",
      owners: 0,
    }),
    null,
  );
});

test("parseStatusPayload rejects protocol mismatch", () => {
  assert.equal(
    parseStatusPayload({
      protocol: 99,
      version: "99.0.0",
      ready: true,
      owners: 0,
    }),
    null,
  );
});

test("parsePipeResponse rejects invalid json", () => {
  assert.equal(parsePipeResponse("{"), null);
});

test("waitForReady aborts promptly", async () => {
  const { waitForReady } = await import("../out/managed-pipe.js");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => waitForReady(60_000, 250, controller.signal),
    /aborted/,
  );
});
