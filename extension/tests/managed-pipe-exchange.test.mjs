import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { exchangeOne } from "../out/managed-pipe.js";

/** Minimal net.Socket stand-in for exchangeOne unit tests (no live named pipe). */
class MockPipeSocket extends EventEmitter {
  written = "";

  setEncoding() {}

  write(chunk) {
    this.written = chunk;
    return true;
  }

  off(event, handler) {
    this.removeListener(event, handler);
  }
}

test("exchangeOne accepts a response split across chunks", async () => {
  const socket = new MockPipeSocket();
  const line =
    '{"ok":true,"op":"status","status":{"protocol":1,"version":"0.1.0","ready":true,"owners":0}}\n';
  const promise = exchangeOne(socket, { op: "status", protocol: 1 });
  const half = Math.floor(line.length / 2);
  socket.emit("data", line.slice(0, half));
  socket.emit("data", line.slice(half));
  const response = await promise;
  assert.ok(response.ok);
  assert.equal(response.status?.owners, 0);
});

test("exchangeOne rejects when the pipe closes before a line", async () => {
  const socket = new MockPipeSocket();
  const promise = exchangeOne(socket, { op: "stop" });
  socket.emit("close");
  await assert.rejects(promise, /pipe closed/);
});

test("exchangeOne rejects when aborted mid-flight", async () => {
  const socket = new MockPipeSocket();
  const controller = new AbortController();
  const promise = exchangeOne(socket, { op: "status", protocol: 1 }, 5_000, controller.signal);
  controller.abort();
  await assert.rejects(promise, /aborted/);
});

test("exchangeOne rejects oversized payload without newline", async () => {
  const socket = new MockPipeSocket();
  const promise = exchangeOne(socket, { op: "status", protocol: 1 }, 5_000);
  socket.emit("data", "x".repeat(5000));
  await assert.rejects(promise, /too large/);
});
