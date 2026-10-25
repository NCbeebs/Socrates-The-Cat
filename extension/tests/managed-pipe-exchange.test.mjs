import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import net from "node:net";
import { test } from "node:test";

import { connectPipe, exchangeOne } from "../out/managed-pipe.js";

/** Socket stand-in for connection and exchange checks (no live named pipe). */
class MockPipeSocket extends EventEmitter {
  written = "";
  destroyed = false;

  setEncoding() {}

  write(chunk) {
    this.written = chunk;
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

test("connectPipe abort destroys the pending socket and removes its listeners", async (t) => {
  const socket = new MockPipeSocket();
  t.mock.method(net, "connect", () => socket);
  const controller = new AbortController();
  const promise = connectPipe(controller.signal);
  controller.abort();
  await assert.rejects(promise, /aborted/);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.eventNames(), []);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("connectPipe times out and destroys a connection that never completes", async (t) => {
  const socket = new MockPipeSocket();
  t.mock.method(net, "connect", () => socket);
  await assert.rejects(connectPipe(undefined, 20), /connection timeout/);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.eventNames(), []);
});

test("connectPipe error releases socket and abort listener", async (t) => {
  const socket = new MockPipeSocket();
  t.mock.method(net, "connect", () => socket);
  const controller = new AbortController();
  const promise = connectPipe(controller.signal);
  socket.emit("error", new Error("connection refused"));
  await assert.rejects(promise, /connection refused/);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("connectPipe success preserves unrelated listeners and transfers socket ownership", async (t) => {
  const socket = new MockPipeSocket();
  const onClose = () => {};
  socket.on("close", onClose);
  t.mock.method(net, "connect", () => socket);
  const controller = new AbortController();
  const promise = connectPipe(controller.signal);
  socket.emit("connect");
  assert.equal(await promise, socket);
  controller.abort();
  assert.equal(socket.destroyed, false);
  assert.deepEqual(socket.listeners("close"), [onClose]);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

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
