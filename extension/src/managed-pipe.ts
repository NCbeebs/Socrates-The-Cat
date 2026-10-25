/**
 * Windows named-pipe client for the native managed lifecycle (protocol v1).
 * Used by extension.ts; keep free of vscode imports so Node tests can exercise parsing.
 */

import * as net from "node:net";

import { managedPipePath } from "./win-session.js";

export const PROTOCOL_VERSION = 1;
export const MAX_PIPE_MESSAGE_BYTES = 4096;

export type PipeOp = "attach" | "release" | "status" | "stop";

export interface PipeRequest {
  op: PipeOp;
  client_id?: string;
  protocol?: number;
}

export interface StatusPayload {
  protocol: number;
  version: string;
  ready: boolean;
  owners: number;
}

export interface PipeResponse {
  ok: boolean;
  op: string;
  error?: string;
  status?: StatusPayload;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function parseStatusPayload(value: unknown): StatusPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== PROTOCOL_VERSION) {
    return null;
  }
  if (typeof record.version !== "string" || !SEMVER_PATTERN.test(record.version)) {
    return null;
  }
  if (typeof record.ready !== "boolean") {
    return null;
  }
  if (
    typeof record.owners !== "number" ||
    !Number.isInteger(record.owners) ||
    record.owners < 0
  ) {
    return null;
  }
  return {
    protocol: record.protocol,
    version: record.version,
    ready: record.ready,
    owners: record.owners,
  };
}

export function parsePipeResponse(line: string): PipeResponse | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_PIPE_MESSAGE_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(trimmed) as PipeResponse;
    if (typeof value.ok !== "boolean" || typeof value.op !== "string") {
      return null;
    }
    if (value.status !== undefined) {
      const status = parseStatusPayload(value.status);
      if (!status) {
        return null;
      }
      value.status = status;
    }
    return value;
  } catch {
    return null;
  }
}

export function formatRequest(request: PipeRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function pipePath(): string {
  return managedPipePath();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("operation aborted");
  }
}

export function connectPipe(signal?: AbortSignal, timeoutMs = 8_000): Promise<net.Socket> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath());
    socket.setEncoding("utf8");
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("operation aborted"));
    const onClose = () => fail(new Error("pipe closed"));
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const timer = setTimeout(() => fail(new Error("pipe connection timeout")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", onClose);
      socket.off("connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.once("error", fail);
    socket.once("close", onClose);
    socket.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function exchangeOne(
  socket: net.Socket,
  request: PipeRequest,
  timeoutMs = 8_000,
  signal?: AbortSignal,
): Promise<PipeResponse> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("pipe response timeout"));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("operation aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const onData = (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_PIPE_MESSAGE_BYTES && !buffer.includes("\n")) {
        cleanup();
        reject(new Error("pipe response too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      cleanup();
      const parsed = parsePipeResponse(line);
      if (!parsed) {
        reject(new Error("invalid pipe response"));
        return;
      }
      resolve(parsed);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("pipe closed"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onClose);
    socket.write(formatRequest(request));
  });
}

export async function queryStatus(
  timeoutMs = 2_000,
  signal?: AbortSignal,
): Promise<StatusPayload | null> {
  throwIfAborted(signal);
  let socket: net.Socket | undefined;
  try {
    socket = await connectPipe(signal, timeoutMs);
    const response = await exchangeOne(
      socket,
      { op: "status", protocol: PROTOCOL_VERSION },
      timeoutMs,
      signal,
    );
    if (!response.ok || !response.status) {
      return null;
    }
    return response.status;
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("operation aborted");
    }
    if (error instanceof Error && error.message === "operation aborted") {
      throw error;
    }
    return null;
  } finally {
    socket?.destroy();
  }
}

export async function waitForReady(
  deadlineMs = 60_000,
  pollMs = 250,
  signal?: AbortSignal,
): Promise<StatusPayload> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const status = await queryStatus(pollMs, signal);
    if (status?.ready) {
      return status;
    }
    await delay(pollMs, signal);
  }
  throw new Error("Timed out waiting for managed companion readiness.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
