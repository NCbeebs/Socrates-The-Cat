import {
  closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

/**
 * Opt-in upstream revision check for source installs. `socrates.js` runs it in the background on launch
 * (`SOCRATES_CHECK_UPDATES=1`) and in the foreground for `socrates --check-updates`. It compares local
 * `git` HEAD to the canonical upstream branch with GitHub's compare API, caching results and honoring
 * GitHub-imposed waits in %LOCALAPPDATA%\Socrates\update-check-cache.json. Tests: `tests/check-updates.test.cjs`.
 */

/** Supported until March 2028 (https://docs.github.com/en/rest/about-the-rest-api/api-versions). */
export const GITHUB_API_VERSION = "2022-11-28";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const API_ORIGIN = "https://api.github.com";
const DEFAULT_BRANCH = "main";
const CACHE_VERSION = 2;
const HOUR_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * HOUR_MS;
const LOCAL_FAILURE_BACKOFF_MS = HOUR_MS;
const SERVER_WAIT_MIN_MS = 60_000;
const SERVER_WAIT_MAX_MS = 24 * HOUR_MS;
const CACHE_ENTRY_MAX_AGE_MS = 30 * 24 * HOUR_MS;
const CACHE_MAX_ENTRIES = 20;
const GIT_TIMEOUT_MS = 2_000;
const FETCH_TIMEOUT_MS = 8_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
/** Upper bound of a valid `Date`; larger values make `toISOString()` throw. */
const MAX_TIME_MS = 8.64e15;
/** Owners refresh the lock every heartbeat; a lock untouched for the stale window belongs to a crashed process. */
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 200;
const LOCK_IMMEDIATE_RETRIES = 5;
const TRANSIENT_CREATE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OUTCOME_KINDS = new Set(["update_available", "current", "local_ahead", "diverged"]);

const binDir = path.dirname(fileURLToPath(import.meta.url));

export function defaultCachePath() {
  const base = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  return path.join(base, "Socrates", "update-check-cache.json");
}

export function readPackageVersion(packageJsonPath = path.join(binDir, "..", "package.json")) {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof pkg.version === "string" && /^[\w.+-]+$/.test(pkg.version) ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseRepository(value) {
  const match = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match || [match[1], match[2]].some((part) => /^\.+$/.test(part))) return null;
  return `${match[1]}/${match[2]}`;
}

/** Canonical upstream `owner/repo` from companion `package.json`; override with `SOCRATES_UPDATE_REPO`. */
export function resolveUpdateRepository(packageJsonPath = path.join(binDir, "..", "package.json")) {
  const override = process.env.SOCRATES_UPDATE_REPO?.trim();
  if (override) {
    return parseRepository(override.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, ""));
  }
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const url = pkg.repository?.url ?? pkg.repository;
    if (typeof url !== "string") return null;
    const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    return match ? parseRepository(`${match[1]}/${match[2]}`) : null;
  } catch {
    return null;
  }
}

export function resolveUpdateBranch() {
  return process.env.SOCRATES_UPDATE_BRANCH?.trim() || DEFAULT_BRANCH;
}

/** Subset of `git check-ref-format --branch`; rejects anything that could alter the API path or the terminal. */
export function isValidBranchName(name) {
  if (typeof name !== "string" || !name || name.length > 255 || name === "@") return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Strips ANSI sequences and remaining C0/C1 controls so GitHub, git, or cache text cannot drive the terminal. */
export function sanitizeForTerminal(text) {
  return stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function buildCompareUrls(repository, localSha, branch) {
  const [owner, repo] = repository.split("/");
  const basehead = `${localSha}...${branch.split("/").map(encodeURIComponent).join("/")}`;
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const apiUrl = new URL(`${API_ORIGIN}/repos/${repoPath}/compare/${basehead}`);
  apiUrl.searchParams.set("per_page", "1");
  return { apiUrl: apiUrl.href, htmlUrl: `https://github.com/${repoPath}/compare/${basehead}` };
}

function cacheKey(repository, branch, localSha) {
  return `${repository}|${branch}|${localSha}`;
}

/** A future `validatedAt` (clock change or edited cache) is treated as stale, never as fresh forever. */
function isFresh(entry, at) {
  return entry?.outcome !== undefined && entry.validatedAt !== undefined
    && entry.validatedAt <= at && at - entry.validatedAt < CACHE_TTL_MS;
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIME_MS ? value : undefined;
}

function formatTime(ms) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "a later time" : date.toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyCache() {
  return { version: CACHE_VERSION, serverWait: Object.create(null), entries: Object.create(null) };
}

function sanitizeOutcome(outcome) {
  if (!isRecord(outcome) || !OUTCOME_KINDS.has(outcome.kind) || typeof outcome.message !== "string") return undefined;
  return {
    kind: outcome.kind,
    message: outcome.message,
    compareUrl: typeof outcome.compareUrl === "string" ? outcome.compareUrl : undefined,
    aheadBy: Number.isInteger(outcome.aheadBy) && outcome.aheadBy >= 0 ? outcome.aheadBy : 0,
  };
}

/** Unreadable, legacy, or tampered caches degrade to empty; only known fields of known shapes survive. */
function readCache(cachePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return emptyCache();
  }
  const cache = emptyCache();
  if (!isRecord(data) || data.version !== CACHE_VERSION) return cache;
  for (const [repository, wait] of Object.entries(isRecord(data.serverWait) ? data.serverWait : {})) {
    const until = isRecord(wait) ? validTime(wait.until) : undefined;
    if (until === undefined) continue;
    cache.serverWait[repository] = {
      until,
      failures: Number.isInteger(wait.failures) && wait.failures > 0 ? Math.min(wait.failures, 32) : 1,
    };
  }
  for (const [key, entry] of Object.entries(isRecord(data.entries) ? data.entries : {})) {
    if (!isRecord(entry)) continue;
    cache.entries[key] = {
      validatedAt: validTime(entry.validatedAt),
      etag: typeof entry.etag === "string" ? entry.etag : undefined,
      outcome: sanitizeOutcome(entry.outcome),
      localRetryAfter: validTime(entry.localRetryAfter),
      touchedAt: validTime(entry.touchedAt) ?? 0,
    };
  }
  return cache;
}

function pruneCache(cache, t) {
  for (const [repository, wait] of Object.entries(cache.serverWait)) {
    if (wait.until < t - CACHE_ENTRY_MAX_AGE_MS) delete cache.serverWait[repository];
  }
  const recent = Object.entries(cache.entries)
    .filter(([, entry]) => t - entry.touchedAt < CACHE_ENTRY_MAX_AGE_MS)
    .sort(([, a], [, b]) => b.touchedAt - a.touchedAt)
    .slice(0, CACHE_MAX_ENTRIES);
  cache.entries = Object.assign(Object.create(null), Object.fromEntries(recent));
}

/** Temp file + rename so concurrent launches never leave a half-written cache. Failures never block launch. */
function writeCache(cachePath, cache, t) {
  pruneCache(cache, t);
  const temp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(cache)}\n`, "utf8");
    renameSync(temp, cachePath);
  } catch {
    try { unlinkSync(temp); } catch { /* Temp file was never created or is already gone. */ }
  }
}

/**
 * GitHub's documented order: `retry-after`, then `x-ratelimit-reset` when remaining is 0, otherwise at least
 * one minute with exponential growth (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
 */
export function serverWaitUntil(headers, previousFailures, receivedAt) {
  return Math.min(unclampedServerWait(headers, previousFailures, receivedAt), MAX_TIME_MS);
}

function unclampedServerWait(headers, previousFailures, receivedAt) {
  const retryAfter = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return receivedAt + Math.max(retryAfter * 1000, 1000);
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
    if (Number.isFinite(reset)) return Math.max(reset * 1000, receivedAt + SERVER_WAIT_MIN_MS);
  }
  return receivedAt + Math.min(SERVER_WAIT_MIN_MS * 2 ** previousFailures, SERVER_WAIT_MAX_MS);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(namedError("AbortError", "aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultLockFs = { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync };

/** Lock identity: token from the JSON body (`null` if unreadable or mid-write) plus mtime. fs errors propagate. */
function inspectLock(fs, file) {
  const { mtimeMs } = fs.statSync(file);
  const raw = fs.readFileSync(file, "utf8");
  let token = null;
  try {
    const data = JSON.parse(raw);
    if (typeof data?.token === "string") token = data.token;
  } catch { /* Foreign or partially written lock: identified by mtime alone. */ }
  return { token, mtimeMs };
}

/**
 * One lock attempt. Results: `acquired`, `retry_now` (a file vanished between calls), `wait` (held by a live
 * owner, or a transient Windows create error), or `error` (persistent filesystem failure: never run unlocked).
 */
function attemptLock(fs, lockPath, staleMs) {
  const token = randomUUID();
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    // A just-deleted file can briefly refuse re-creation on Windows (pending delete).
    if (TRANSIENT_CREATE_ERRORS.has(error?.code)) return { result: "wait", transient: error };
    if (error?.code !== "EEXIST") return { result: "error", step: "create", error };
  }
  if (fd !== undefined) {
    try {
      fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
      fs.closeSync(fd);
      return { result: "acquired", token };
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* Already closed. */ }
      try { fs.unlinkSync(lockPath); } catch { /* Left for stale recovery. */ }
      return { result: "error", step: "create", error };
    }
  }

  let observed;
  try {
    observed = inspectLock(fs, lockPath);
  } catch (error) {
    return error?.code === "ENOENT" ? { result: "retry_now" } : { result: "error", step: "inspect", error };
  }
  if (Date.now() - observed.mtimeMs <= staleMs) return { result: "wait" };

  // Owners refresh mtime every heartbeat, so a stale lock means a crashed owner. Rename is atomic: only one
  // reclaimer moves a given file. Verify the moved file is the stale one inspected above, not a fresh lock
  // another reclaimer created in between.
  const tombstone = `${lockPath}.${randomUUID()}.stale`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch (error) {
    return error?.code === "ENOENT" ? { result: "retry_now" } : { result: "error", step: "reclaim", error };
  }
  let moved = null;
  try { moved = inspectLock(fs, tombstone); } catch { /* Unverifiable: restore it below. */ }
  if (moved && moved.token === observed.token && moved.mtimeMs === observed.mtimeMs) {
    try { fs.unlinkSync(tombstone); } catch { /* A leftover tombstone is not the lock path. */ }
    return { result: "retry_now" };
  }
  // `link` restores without overwriting; if it fails, the displaced owner detects the loss before requesting.
  try { fs.linkSync(tombstone, lockPath); } catch { /* See above. */ }
  try { fs.unlinkSync(tombstone); } catch { /* A leftover tombstone is not the lock path. */ }
  return { result: "wait" };
}

/** Owned lock: heartbeat refreshes mtime while held; release deletes the lock only if it still carries our token. */
function holdLock(fs, lockPath, token, heartbeatMs) {
  const owns = () => {
    try {
      return inspectLock(fs, lockPath).token === token;
    } catch {
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    if (!owns()) {
      clearInterval(heartbeat);
      return;
    }
    const at = new Date();
    try { fs.utimesSync(lockPath, at, at); } catch { /* Next beat retries; staleness needs many missed beats. */ }
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    isHeld: owns,
    release() {
      clearInterval(heartbeat);
      // While we heartbeat, our lock is never stale, so no reclaimer can replace it between check and unlink.
      if (owns()) {
        try { fs.unlinkSync(lockPath); } catch { /* Already gone. */ }
      }
    },
  };
}

/**
 * Cross-process lock (`<cache>.lock`, exclusive create) held from cache read through cache write, so checks
 * from concurrent launches run serially and cannot overwrite each other's GitHub waits
 * (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests).
 * Returns `{ status: "held", lock }`, `{ status: "busy" }`, or `{ status: "error", message }`; throws `AbortError`.
 * Every iteration checks cancellation; only vanished-file races retry immediately (bounded), others wait.
 */
async function acquireLock(lockPath, {
  waitMs, signal, lockFs: fs = defaultLockFs, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS,
}) {
  const lockError = (step, error) => ({
    status: "error",
    message: `Could not ${step} the update-check lock (${error?.code ?? error?.message ?? error}); not checking.`,
  });
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return lockError("prepare", error);
  }
  const deadline = Date.now() + waitMs;
  let immediateRetries = 0;
  for (;;) {
    if (signal?.aborted) throw namedError("AbortError", "aborted");
    const attempt = attemptLock(fs, lockPath, staleMs);
    if (attempt.result === "acquired") return { status: "held", lock: holdLock(fs, lockPath, attempt.token, heartbeatMs) };
    if (attempt.result === "error") return lockError(attempt.step, attempt.error);
    if (attempt.result === "retry_now" && immediateRetries < LOCK_IMMEDIATE_RETRIES) {
      immediateRetries += 1;
      continue;
    }
    if (Date.now() >= deadline) return attempt.transient ? lockError("create", attempt.transient) : { status: "busy" };
    await sleep(LOCK_POLL_MS, signal);
  }
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} options
 */
export function runGit(repoRoot, args, { timeoutMs = GIT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(namedError("AbortError", "aborted"));
      return;
    }
    // `cwd` keeps Windows executable lookup inside the trusted checkout instead of the caller's directory.
    const child = spawn("git", ["-C", repoRoot, ...args], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      finish();
      child.kill();
      reject(namedError("TimeoutError", "git timed out"));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      finish();
      child.kill();
      reject(namedError("AbortError", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(0, 4096); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 4096); });
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (code) => {
      finish();
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (!response.body) return "";
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw namedError("BodyTooLargeError", "GitHub response exceeded the size limit");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw namedError("BodyTooLargeError", "GitHub response exceeded the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function discardBody(response) {
  await response.body?.cancel().catch(() => {});
}

/**
 * Redirects are followed manually so each `location` is checked against the original origin *before* it is
 * requested (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#follow-redirects).
 * Only a 200 body is read; every other status returns headers immediately, so rate-limit headers survive a
 * stalled error body. The timeout and caller signal span all hops and body consumption.
 * Rejections are normalized: caller cancellation → `AbortError`, deadline → `TimeoutError`.
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number }} options
 */
export async function githubFetch(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS, signal, maxBytes = MAX_BODY_BYTES } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const origin = new URL(url).origin;
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, { headers, signal: combined, redirect: "manual" });
      if (REDIRECT_STATUSES.has(response.status)) {
        await discardBody(response);
        const location = response.headers.get("location");
        if (!location) throw new Error(`GitHub returned ${response.status} without a location`);
        if (hop >= MAX_REDIRECTS) throw new Error("GitHub redirected too many times");
        const next = new URL(location, current);
        if (next.origin !== origin) throw new Error("GitHub redirected the request to another origin");
        current = next.href;
        continue;
      }
      if (response.status !== 200) {
        await discardBody(response);
        return { response, text: "" };
      }
      return { response, text: await readBodyCapped(response, maxBytes) };
    }
  } catch (error) {
    if (signal?.aborted) throw namedError("AbortError", "aborted");
    if (timeout.aborted) throw namedError("TimeoutError", "GitHub request timed out");
    throw error;
  }
}

function outcomeFromCompare(body, localSha, branch, compareUrl) {
  const aheadBy = Number.isInteger(body?.ahead_by) && body.ahead_by >= 0 ? body.ahead_by : 0;
  switch (body?.status) {
    case "identical":
      return { kind: "current", message: `This checkout matches upstream ${branch} (${localSha.slice(0, 7)}).`, compareUrl, aheadBy: 0 };
    case "ahead":
      return {
        kind: "update_available",
        message:
          `Update available: upstream ${branch} contains ${aheadBy} commit${aheadBy === 1 ? "" : "s"} missing from this checkout. ` +
          `See changes: ${compareUrl}. Stop Socrates before updating.`,
        compareUrl,
        aheadBy,
      };
    case "behind":
      return { kind: "local_ahead", message: `This checkout is ahead of upstream ${branch} (local commits not on ${branch}).`, compareUrl, aheadBy: 0 };
    case "diverged":
      return { kind: "diverged", message: `This checkout and upstream ${branch} have diverged (both contain unique commits).`, compareUrl, aheadBy };
    default:
      return null;
  }
}

/**
 * @typedef {'update_available' | 'current' | 'local_ahead' | 'diverged' | 'skipped' | 'failed'} UpdateCheckKind
 * @typedef {{ kind: UpdateCheckKind, message: string, compareUrl?: string, aheadBy?: number, reason?: string }} UpdateCheckResult
 */

/**
 * Returns the raw comparison; callers decide presentation (the launcher only surfaces `update_available`).
 * `force` bypasses the 24h TTL and local failure backoff, never a GitHub-imposed wait.
 * @param {{
 *   companionPackageDir?: string,
 *   cachePath?: string,
 *   force?: boolean,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   runGitFn?: typeof runGit,
 *   fetchFn?: typeof githubFetch,
 *   lockOptions?: { lockFs?: object, staleMs?: number, heartbeatMs?: number },
 * }} options
 * @returns {Promise<UpdateCheckResult>}
 */
export async function checkForUpstreamUpdate({
  companionPackageDir = path.join(binDir, ".."),
  cachePath = defaultCachePath(),
  force = false,
  signal,
  now = () => Date.now(),
  runGitFn = runGit,
  fetchFn = githubFetch,
  lockOptions = {},
} = {}) {
  const cancelled = { kind: "skipped", message: "Update check cancelled.", reason: "aborted" };
  const packageJsonPath = path.join(companionPackageDir, "package.json");
  const repository = resolveUpdateRepository(packageJsonPath);
  if (!repository) {
    return { kind: "failed", message: "Could not resolve the upstream GitHub repository (check SOCRATES_UPDATE_REPO).", reason: "no_repository" };
  }
  const branch = resolveUpdateBranch();
  if (!isValidBranchName(branch)) {
    return { kind: "failed", message: "SOCRATES_UPDATE_BRANCH is not a valid git branch name.", reason: "invalid_branch" };
  }

  const repoRoot = path.resolve(companionPackageDir, "..");
  let localSha;
  let localBranch;
  try {
    localSha = await runGitFn(repoRoot, ["rev-parse", "HEAD"], { signal });
    localBranch = await runGitFn(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return cancelled;
    return { kind: "failed", message: `Could not read the git revision: ${error?.message ?? error}.`, reason: "git_error" };
  }
  if (!SHA_PATTERN.test(localSha)) {
    return { kind: "failed", message: "git returned an unexpected revision format.", reason: "invalid_sha" };
  }
  if (localBranch === "HEAD") {
    return { kind: "skipped", message: "Skipped: detached HEAD (update checks run only on a branch).", reason: "detached_head" };
  }
  if (localBranch !== branch) {
    return {
      kind: "skipped",
      message: `Skipped: on branch "${localBranch}" (update checks compare ${branch} only).`,
      reason: "not_default_branch",
    };
  }

  const key = cacheKey(repository, branch, localSha);
  if (!force) {
    const cached = readCache(cachePath).entries[key];
    if (isFresh(cached, now())) return cached.outcome;
  }

  let acquired;
  try {
    acquired = await acquireLock(`${cachePath}.lock`, { ...lockOptions, waitMs: force ? LOCK_WAIT_MS : 0, signal });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return cancelled;
    acquired = { status: "error", message: `Could not use the update-check lock (${error?.message ?? error}); not checking.` };
  }
  if (acquired.status === "error") {
    return { kind: force ? "failed" : "skipped", message: acquired.message, reason: "lock_error" };
  }
  if (acquired.status === "busy") {
    return force
      ? { kind: "failed", message: "Another update check is still running; try again shortly.", reason: "busy" }
      : { kind: "skipped", message: "Skipped: another update check is in progress.", reason: "busy" };
  }
  try {
    return await runLockedCheck({
      cachePath, key, repository, branch, localSha, packageJsonPath, force, signal, now, fetchFn, cancelled, lock: acquired.lock,
    });
  } finally {
    acquired.lock.release();
  }
}

/** Runs under the cache lock: re-read state, decide, request, record. */
async function runLockedCheck({ cachePath, key, repository, branch, localSha, packageJsonPath, force, signal, now, fetchFn, cancelled, lock }) {
  const t = now();
  const cache = readCache(cachePath);
  const entry = cache.entries[key];
  if (!force && isFresh(entry, t)) return entry.outcome;
  const wait = cache.serverWait[repository];
  if (wait && t < wait.until) {
    return {
      kind: "failed",
      message: `GitHub asked clients to wait; next check after ${formatTime(wait.until)}.`,
      reason: "server_wait",
    };
  }
  if (!force && entry?.localRetryAfter !== undefined && t < entry.localRetryAfter) {
    return { kind: "failed", message: "A recent update check failed; retrying later.", reason: "local_backoff" };
  }

  // Re-read before each write and apply only this check's change; an active GitHub wait is never shortened or cleared.
  const commit = (at, mutate) => {
    const fresh = readCache(cachePath);
    mutate(fresh);
    writeCache(cachePath, fresh, at);
  };
  const clearExpiredWait = (fresh, at) => {
    if (fresh.serverWait[repository] && fresh.serverWait[repository].until <= at) delete fresh.serverWait[repository];
  };
  const recordLocalFailure = (message, reason) => {
    const at = now();
    commit(at, (fresh) => {
      fresh.entries[key] = { ...(fresh.entries[key] ?? {}), localRetryAfter: at + LOCAL_FAILURE_BACKOFF_MS, touchedAt: at };
    });
    return { kind: "failed", message, reason };
  };

  const { apiUrl, htmlUrl } = buildCompareUrls(repository, localSha, branch);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `Socrates-Companion/${readPackageVersion(packageJsonPath)}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (entry?.etag && entry.outcome) headers["If-None-Match"] = entry.etag;

  if (!lock.isHeld()) {
    return { kind: "failed", message: "The update-check lock was taken over; not sending a request.", reason: "lock_lost" };
  }

  // A takeover noticed after this point lets the request finish: its result (especially a GitHub wait) is still recorded.
  let response;
  let text;
  try {
    ({ response, text } = await fetchFn(apiUrl, { headers, signal }));
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return cancelled;
    if (error?.name === "TimeoutError") return recordLocalFailure("Update check timed out.", "timeout");
    if (error?.name === "BodyTooLargeError") return recordLocalFailure("GitHub response was too large.", "body_too_large");
    return recordLocalFailure(`Update check failed: ${error?.message ?? error}.`, "network_error");
  }

  // Relative waits count from when the response arrived, not from when the request started.
  const receivedAt = now();

  // 422 is also GitHub's "endpoint has been spammed" response for compare.
  if (response.status === 403 || response.status === 429 || response.status === 422) {
    const failures = wait?.failures ?? 0;
    const until = serverWaitUntil(response.headers, failures, receivedAt);
    commit(receivedAt, (fresh) => {
      const existing = fresh.serverWait[repository];
      fresh.serverWait[repository] = {
        until: Math.max(until, existing?.until ?? 0),
        failures: Math.max(failures, existing?.failures ?? 0) + 1,
      };
    });
    const limited = response.headers.get("x-ratelimit-remaining") === "0" ? "rate limit reached" : `refused the request (${response.status})`;
    return {
      kind: "failed",
      message: `GitHub ${limited}; next check after ${formatTime(until)}.`,
      reason: "server_wait",
    };
  }

  if (response.status === 304 && entry?.outcome) {
    commit(receivedAt, (fresh) => {
      clearExpiredWait(fresh, receivedAt);
      fresh.entries[key] = {
        ...(fresh.entries[key] ?? {}),
        etag: entry.etag,
        outcome: entry.outcome,
        validatedAt: receivedAt,
        localRetryAfter: undefined,
        touchedAt: receivedAt,
      };
    });
    return entry.outcome;
  }

  if (!response.ok) {
    return recordLocalFailure(
      response.status === 404
        ? "Could not compare revisions (GitHub returned 404: the local commit or repository is unknown upstream)."
        : `GitHub compare failed (${response.status}).`,
      "http_error",
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return recordLocalFailure("GitHub compare returned invalid JSON.", "invalid_json");
  }
  const outcome = outcomeFromCompare(body, localSha, branch, htmlUrl);
  if (!outcome) return recordLocalFailure("GitHub compare returned an unrecognized status.", "invalid_status");

  commit(receivedAt, (fresh) => {
    clearExpiredWait(fresh, receivedAt);
    fresh.entries[key] = {
      validatedAt: receivedAt,
      etag: response.headers.get("etag") ?? undefined,
      outcome,
      localRetryAfter: undefined,
      touchedAt: receivedAt,
    };
  });
  return outcome;
}

/** Human-readable line for `socrates --check-updates`. */
export function formatCheckUpdatesCli(result) {
  const prefix =
    result.kind === "update_available"
      ? "UPDATE AVAILABLE"
      : result.kind === "current"
        ? "UP TO DATE"
        : result.kind === "skipped"
          ? "SKIPPED"
          : result.kind === "local_ahead" || result.kind === "diverged"
            ? "NOTE"
            : "FAILED";
  return sanitizeForTerminal(`${prefix}: ${result.message}`);
}
