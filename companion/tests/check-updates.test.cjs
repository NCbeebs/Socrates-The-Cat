const assert = require("node:assert/strict");
const realFs = require("node:fs");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } = realFs;
const http = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildCompareUrls,
  checkForUpstreamUpdate,
  formatCheckUpdatesCli,
  githubFetch,
  isValidBranchName,
  resolveUpdateRepository,
  serverWaitUntil,
} = require("../bin/check-updates.js");

const HOUR = 60 * 60 * 1000;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fixture(t, { cacheRoot } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "socrates update "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const companion = path.join(root, "companion");
  mkdirSync(companion, { recursive: true });
  writeFileSync(
    path.join(companion, "package.json"),
    JSON.stringify({ version: "0.1.0", repository: { url: "https://github.com/NCbeebs/Socrates-The-Cat.git" } }),
  );
  return { companion, cachePath: path.join(cacheRoot ?? root, "cache.json") };
}

function git(localSha = SHA_A, branch = "main") {
  return async (_root, args) => (args[1] === "HEAD" ? localSha : branch);
}

function reply(status, body, headers = {}) {
  return {
    response: { ok: status >= 200 && status < 300, status, headers: new Headers(headers) },
    text: body === undefined ? "" : JSON.stringify(body),
  };
}

/** Serves queued replies (functions may throw) and records every request. */
function scriptedFetch(...replies) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    return typeof next === "function" ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** Local server; `handler` defaults to headers plus a partial body that stalls until the test ends. */
async function localServer(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, hits };
}

async function stallingServer(t, { contentLength, status = 200, headers = {} } = {}) {
  const { url, hits } = await localServer(t, (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...(contentLength ? { "content-length": contentLength } : {}), ...headers });
    res.write('{"status":');
  });
  stallingServer.hits = hits;
  return url;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("repository resolution uses package.json and rejects path-like overrides", (t) => {
  const { companion } = fixture(t);
  const pkg = path.join(companion, "package.json");
  assert.equal(resolveUpdateRepository(pkg), "NCbeebs/Socrates-The-Cat");
  withEnv(t, "SOCRATES_UPDATE_REPO", "owner/..");
  assert.equal(resolveUpdateRepository(pkg), null);
  process.env.SOCRATES_UPDATE_REPO = "../..";
  assert.equal(resolveUpdateRepository(pkg), null);
  process.env.SOCRATES_UPDATE_REPO = "https://github.com/someone/fork.git";
  assert.equal(resolveUpdateRepository(pkg), "someone/fork");
});

test("ahead reports an update with a locally built compare link", async (t) => {
  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(reply(200, { status: "ahead", ahead_by: 2, html_url: "https://evil.example/x" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
  assert.equal(result.kind, "update_available");
  assert.match(result.message, /contains 2 commits missing from this checkout/);
  assert.match(result.message, /Stop Socrates before updating/);
  assert.doesNotMatch(result.message, /evil/);
  assert.equal(result.compareUrl, `https://github.com/NCbeebs/Socrates-The-Cat/compare/${SHA_A}...main`);
  assert.equal(fetchFn.calls[0].headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.match(fetchFn.calls[0].headers["User-Agent"], /^Socrates-Companion\/0\.1\.0$/);
});

test("identical is current", async (t) => {
  const { companion, cachePath } = fixture(t);
  const result = await checkForUpstreamUpdate({
    companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn: scriptedFetch(reply(200, { status: "identical" })),
  });
  assert.equal(result.kind, "current");
});

test("behind and diverged results are cached like any other comparison", async (t) => {
  for (const status of ["behind", "diverged"]) {
    const { companion, cachePath } = fixture(t);
    const fetchFn = scriptedFetch(reply(200, { status, ahead_by: 1 }));
    const options = { companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn };
    const first = await checkForUpstreamUpdate(options);
    const second = await checkForUpstreamUpdate(options);
    assert.equal(fetchFn.calls.length, 1, status);
    assert.equal(first.kind, status === "behind" ? "local_ahead" : "diverged");
    assert.deepEqual(second, first);
  }
});

test("feature branches and detached HEAD skip without a request", async (t) => {
  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const feature = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(SHA_A, "feature/foo"), fetchFn });
  const detached = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(SHA_A, "HEAD"), fetchFn });
  assert.equal(feature.reason, "not_default_branch");
  assert.equal(detached.reason, "detached_head");
  assert.equal(fetchFn.calls.length, 0);
});

test("forced checks honor a GitHub-imposed wait, including after the local SHA changes", async (t) => {
  const { companion, cachePath } = fixture(t);
  let now = 1_000_000;
  const fetchFn = scriptedFetch(reply(429, { message: "secondary rate limit" }, { "retry-after": "120" }));
  const limited = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, now: () => now });
  assert.equal(limited.kind, "failed");
  assert.equal(limited.reason, "server_wait");

  now += 60_000;
  const forced = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, force: true, runGitFn: git(), fetchFn, now: () => now });
  const pulled = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, force: true, runGitFn: git(SHA_B), fetchFn, now: () => now });
  assert.equal(forced.reason, "server_wait");
  assert.equal(pulled.reason, "server_wait");
  assert.equal(fetchFn.calls.length, 1);

  now += 61_000;
  fetchFn.calls.length = 0;
  const after = await checkForUpstreamUpdate({
    companionPackageDir: companion, cachePath, runGitFn: git(), now: () => now,
    fetchFn: scriptedFetch(reply(200, { status: "identical" })),
  });
  assert.equal(after.kind, "current");
});

test("server waits follow GitHub's documented header order", () => {
  const t = 1_000_000;
  assert.equal(serverWaitUntil(new Headers({ "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999" }), 0, t), t + 30_000);
  assert.equal(serverWaitUntil(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((t + 600_000) / 1000) }), 0, t), t + 600_000);
  assert.equal(serverWaitUntil(new Headers({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": "99999" }), 0, t), t + 60_000);
  assert.equal(serverWaitUntil(new Headers(), 3, t), t + 8 * 60_000);
  assert.equal(serverWaitUntil(new Headers(), 30, t), t + 24 * HOUR);
});

test("a failed refresh never extends a stale result", async (t) => {
  const { companion, cachePath } = fixture(t);
  let now = 1_000_000;
  const options = (fetchFn) => ({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, now: () => now });
  assert.equal((await checkForUpstreamUpdate(options(scriptedFetch(reply(200, { status: "identical" }))))).kind, "current");

  now += 25 * HOUR;
  const failing = scriptedFetch(() => { throw new Error("offline"); });
  assert.equal((await checkForUpstreamUpdate(options(failing))).reason, "network_error");
  now += 30 * 60_000;
  assert.equal((await checkForUpstreamUpdate(options(failing))).reason, "local_backoff");
  assert.equal(failing.calls.length, 1);

  now += 31 * 60_000;
  const recovered = scriptedFetch(reply(200, { status: "ahead", ahead_by: 1 }));
  assert.equal((await checkForUpstreamUpdate(options(recovered))).kind, "update_available");
  assert.equal(recovered.calls.length, 1);
});

test("ETag revalidation refreshes a stale result on 304", async (t) => {
  const { companion, cachePath } = fixture(t);
  let now = 1_000_000;
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }, { etag: '"v1"' }), reply(304));
  const options = { companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, now: () => now };
  await checkForUpstreamUpdate(options);
  now += 25 * HOUR;
  const revalidated = await checkForUpstreamUpdate(options);
  assert.equal(revalidated.kind, "current");
  assert.equal(fetchFn.calls[1].headers["If-None-Match"], '"v1"');
  now += HOUR;
  await checkForUpstreamUpdate(options);
  assert.equal(fetchFn.calls.length, 2);
});

test("a stalled body times out, reports failure, and backs off", async (t) => {
  const url = await stallingServer(t);
  await assert.rejects(githubFetch(url, { timeoutMs: 200 }), { name: "TimeoutError" });

  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(() => githubFetch(url, { timeoutMs: 200 }));
  const options = { companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn };
  const result = await checkForUpstreamUpdate(options);
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "timeout");
  assert.equal((await checkForUpstreamUpdate(options)).reason, "local_backoff");
  assert.equal(fetchFn.calls.length, 1);
});

test("caller cancellation during the body is a skip and writes no cache", async (t) => {
  const url = await stallingServer(t);
  const { companion, cachePath } = fixture(t);
  const controller = new AbortController();
  const fetchFn = scriptedFetch(() => {
    setTimeout(() => controller.abort(), 100);
    return githubFetch(url, { timeoutMs: 5_000, signal: controller.signal });
  });
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, signal: controller.signal });
  assert.equal(result.kind, "skipped");
  assert.equal(result.reason, "aborted");
  assert.equal(existsSync(cachePath), false);
});

test("oversized bodies are rejected by declared length or streamed size", async (t) => {
  const declared = await stallingServer(t, { contentLength: "999999999" });
  await assert.rejects(githubFetch(declared, { timeoutMs: 2_000 }), { name: "BodyTooLargeError" });
  const streamed = await stallingServer(t);
  await assert.rejects(githubFetch(streamed, { timeoutMs: 2_000, maxBytes: 4 }), { name: "BodyTooLargeError" });
});

test("cross-origin redirects are rejected before the destination is requested", async (t) => {
  const destination = await localServer(t, (_req, res) => res.end('{"status":"identical"}'));
  const origin = await localServer(t, (_req, res) => {
    res.writeHead(302, { location: destination.url });
    res.end();
  });
  await assert.rejects(githubFetch(origin.url, { timeoutMs: 2_000 }), /another origin/);
  assert.equal(destination.hits.length, 0);
});

test("same-origin redirects are followed with a bounded hop count", async (t) => {
  const moved = await localServer(t, (req, res) => {
    if (req.url === "/") {
      res.writeHead(307, { location: "/final" });
      res.end();
    } else {
      res.end('{"status":"identical"}');
    }
  });
  const { text } = await githubFetch(moved.url, { timeoutMs: 2_000 });
  assert.equal(JSON.parse(text).status, "identical");
  assert.deepEqual(moved.hits, ["/", "/final"]);

  const loop = await localServer(t, (_req, res) => {
    res.writeHead(301, { location: "/again" });
    res.end();
  });
  await assert.rejects(githubFetch(loop.url, { timeoutMs: 2_000 }), /too many/);
  assert.equal(loop.hits.length, 4);
});

test("a rate-limit response with a stalled body still records GitHub's wait", async (t) => {
  const url = await stallingServer(t, { status: 429, headers: { "retry-after": "3600" } });
  const hits = stallingServer.hits;
  const { companion, cachePath } = fixture(t);
  const fetchFn = (_apiUrl, options) => githubFetch(url, { ...options, timeoutMs: 1_000 });
  const limited = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
  assert.equal(limited.reason, "server_wait");
  const forced = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, force: true, runGitFn: git(), fetchFn });
  assert.equal(forced.reason, "server_wait");
  assert.equal(hits.length, 1);
});

test("relative waits start when the response arrives", async (t) => {
  const { companion, cachePath } = fixture(t);
  let now = 1_000_000;
  const slow = scriptedFetch(async () => {
    now += 7_000;
    return reply(429, undefined, { "retry-after": "1" });
  });
  const options = { companionPackageDir: companion, cachePath, force: true, runGitFn: git(), fetchFn: slow, now: () => now };
  await checkForUpstreamUpdate(options);
  now += 500;
  assert.equal((await checkForUpstreamUpdate(options)).reason, "server_wait");
  assert.equal(slow.calls.length, 1);
  now += 600;
  await checkForUpstreamUpdate(options);
  assert.equal(slow.calls.length, 2);
});

test("overlapping checks run serially and keep GitHub's wait", async (t) => {
  const { companion, cachePath } = fixture(t);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const limited = scriptedFetch(async () => {
    await gate;
    return reply(429, undefined, { "retry-after": "3600" });
  });
  const ok = scriptedFetch(reply(200, { status: "identical" }));
  const base = { companionPackageDir: companion, cachePath, runGitFn: git() };

  const first = checkForUpstreamUpdate({ ...base, fetchFn: limited });
  await waitFor(() => limited.calls.length === 1);
  const background = await checkForUpstreamUpdate({ ...base, fetchFn: ok });
  assert.equal(background.kind, "skipped");
  assert.equal(background.reason, "busy");

  const forced = checkForUpstreamUpdate({ ...base, force: true, fetchFn: ok });
  setTimeout(releaseFirst, 300);
  assert.equal((await first).reason, "server_wait");
  assert.equal((await forced).reason, "server_wait");
  assert.equal(ok.calls.length, 0);
  assert.equal(existsSync(`${cachePath}.lock`), false);
});

test("a stale lock left by a crashed check is reclaimed", async (t) => {
  const { companion, cachePath } = fixture(t);
  const lock = `${cachePath}.lock`;
  writeFileSync(lock, "12345");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
  assert.equal(result.kind, "current");
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(existsSync(lock), false);
});

function fsError(code) {
  return () => { throw Object.assign(new Error(code), { code }); };
}

function withinMs(ms, promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function writeLock(lock, token, ageMs = 0) {
  writeFileSync(lock, JSON.stringify({ token }));
  if (ageMs) {
    const at = new Date(Date.now() - ageMs);
    utimesSync(lock, at, at);
  }
}

test("persistent filesystem errors during stale-lock recovery return promptly without a request", async (t) => {
  for (const failure of [{ renameSync: fsError("EACCES") }, { statSync: fsError("EACCES") }, { readFileSync: fsError("EACCES") }]) {
    const { companion, cachePath } = fixture(t);
    writeLock(`${cachePath}.lock`, "crashed", 60_000);
    const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
    const lockOptions = { lockFs: { ...realFs, ...failure } };
    for (const force of [false, true]) {
      const result = await withinMs(1_000, checkForUpstreamUpdate({
        companionPackageDir: companion, cachePath, force, runGitFn: git(), fetchFn, lockOptions,
      }));
      assert.equal(result.reason, "lock_error", Object.keys(failure)[0]);
      assert.equal(result.kind, force ? "failed" : "skipped");
    }
    assert.equal(fetchFn.calls.length, 0);
  }
});

test("lock creation failures never fall back to an unlocked request", async (t) => {
  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const base = { companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn };
  const eperm = await withinMs(1_000, checkForUpstreamUpdate({ ...base, lockOptions: { lockFs: { ...realFs, openSync: fsError("EPERM") } } }));
  assert.equal(eperm.reason, "lock_error");
  for (const force of [false, true]) {
    const noDir = await withinMs(1_000, checkForUpstreamUpdate({ ...base, force, lockOptions: { lockFs: { ...realFs, mkdirSync: fsError("EACCES") } } }));
    assert.equal(noDir.reason, "lock_error");
  }
  assert.equal(fetchFn.calls.length, 0);
});

test("an old owner never deletes a replacement lock", async (t) => {
  const { companion, cachePath } = fixture(t);
  const lock = `${cachePath}.lock`;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const replaced = scriptedFetch(async () => {
    writeLock(lock, "replacement");
    await gate;
    return reply(200, { status: "identical" });
  });
  const ok = scriptedFetch(reply(200, { status: "identical" }));
  const base = { companionPackageDir: companion, cachePath, runGitFn: git() };

  const first = checkForUpstreamUpdate({ ...base, fetchFn: replaced });
  await waitFor(() => replaced.calls.length === 1);
  releaseFirst();
  assert.equal((await first).kind, "current");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "replacement");

  rmSync(cachePath);
  const third = await checkForUpstreamUpdate({ ...base, fetchFn: ok });
  assert.equal(third.reason, "busy");
  assert.equal(ok.calls.length, 0);
});

test("a check whose lock was taken over before its request sends nothing", async (t) => {
  const { companion, cachePath } = fixture(t);
  const lock = `${cachePath}.lock`;
  const lockFs = {
    ...realFs,
    readFileSync: (file, encoding) => (file === lock ? JSON.stringify({ token: "someone-else" }) : realFs.readFileSync(file, encoding)),
  };
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, lockOptions: { lockFs } });
  assert.equal(result.reason, "lock_lost");
  assert.equal(fetchFn.calls.length, 0);
});

test("the heartbeat keeps a long-running owner's lock from being reclaimed", async (t) => {
  const { companion, cachePath } = fixture(t);
  const lockOptions = { staleMs: 150, heartbeatMs: 30 };
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const slow = scriptedFetch(async () => {
    await gate;
    return reply(200, { status: "identical" });
  });
  const ok = scriptedFetch(reply(200, { status: "identical" }));
  const base = { companionPackageDir: companion, cachePath, runGitFn: git(), lockOptions };

  const first = checkForUpstreamUpdate({ ...base, fetchFn: slow });
  await waitFor(() => slow.calls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await checkForUpstreamUpdate({ ...base, fetchFn: ok });
  assert.equal(second.reason, "busy");
  releaseFirst();
  assert.equal((await first).kind, "current");
  assert.equal(ok.calls.length, 0);
});

test("reclaiming restores a fresh lock created by a competing reclaimer", async (t) => {
  const { companion, cachePath } = fixture(t);
  const lock = `${cachePath}.lock`;
  writeLock(lock, "crashed", 60_000);
  let raced = false;
  const lockFs = {
    ...realFs,
    renameSync: (from, to) => {
      if (!raced && from === lock) {
        raced = true;
        writeLock(lock, "winner");
      }
      return realFs.renameSync(from, to);
    },
  };
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn, lockOptions: { lockFs } });
  assert.equal(result.reason, "busy");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "winner");
  assert.equal(fetchFn.calls.length, 0);
});

test("cancellation while waiting for the lock returns promptly", async (t) => {
  const { companion, cachePath } = fixture(t);
  writeLock(`${cachePath}.lock`, "live-owner");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const result = await withinMs(1_000, checkForUpstreamUpdate({
    companionPackageDir: companion, cachePath, force: true, runGitFn: git(), fetchFn, signal: controller.signal,
  }));
  assert.equal(result.reason, "aborted");
  assert.equal(fetchFn.calls.length, 0);
});

test("a success never clears a wait recorded by another process during the request", async (t) => {
  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(() => {
    writeFileSync(cachePath, JSON.stringify({
      version: 2,
      serverWait: { "NCbeebs/Socrates-The-Cat": { until: Date.now() + HOUR, failures: 1 } },
      entries: {},
    }));
    return reply(200, { status: "identical" });
  });
  const base = { companionPackageDir: companion, cachePath, runGitFn: git() };
  assert.equal((await checkForUpstreamUpdate({ ...base, fetchFn })).kind, "current");
  assert.equal((await checkForUpstreamUpdate({ ...base, force: true, fetchFn })).reason, "server_wait");
  assert.equal(fetchFn.calls.length, 1);
});

test("out-of-range timestamps never crash the checker", async (t) => {
  const { companion, cachePath } = fixture(t);
  const key = `NCbeebs/Socrates-The-Cat|main|${SHA_A}`;
  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    serverWait: { "NCbeebs/Socrates-The-Cat": { until: 1e100, failures: 1 } },
    entries: { [key]: { validatedAt: Date.now() + 10 * HOUR, touchedAt: Date.now(), outcome: { kind: "current", message: "future" } } },
  }));
  const fetchFn = scriptedFetch(reply(429, undefined, { "retry-after": "99999999999999999999" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(result.reason, "server_wait");
  const again = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, force: true, runGitFn: git(), fetchFn });
  assert.match(again.message, /next check after/);
  assert.equal(fetchFn.calls.length, 1);
});

test("branch names are validated and encoded per path segment", async (t) => {
  assert.equal(isValidBranchName("release#preview"), true);
  for (const bad of ["bad..name", "-x", "a b", "x?y", "x\u001b[31m", "x.lock", ".hidden", "a//b", "trailing/", ""]) {
    assert.equal(isValidBranchName(bad), false, JSON.stringify(bad));
  }
  const { apiUrl } = buildCompareUrls("NCbeebs/Socrates-The-Cat", SHA_A, "release#preview");
  assert.equal(apiUrl, `https://api.github.com/repos/NCbeebs/Socrates-The-Cat/compare/${SHA_A}...release%23preview?per_page=1`);
  assert.match(buildCompareUrls("o/r", SHA_A, "feature/x").apiUrl, /\.\.\.feature\/x\?per_page=1$/);

  const { companion, cachePath } = fixture(t);
  withEnv(t, "SOCRATES_UPDATE_BRANCH", "release#preview");
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(SHA_A, "release#preview"), fetchFn });
  assert.match(fetchFn.calls[0].url, /release%23preview\?per_page=1$/);

  process.env.SOCRATES_UPDATE_BRANCH = "bad..name";
  const invalid = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
  assert.equal(invalid.reason, "invalid_branch");
  assert.equal(fetchFn.calls.length, 1);
});

test("unexpected git output fails before any request", async (t) => {
  const { companion, cachePath } = fixture(t);
  const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
  const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git("not-a-sha/../x"), fetchFn });
  assert.equal(result.reason, "invalid_sha");
  assert.equal(fetchFn.calls.length, 0);
});

test("malformed or tampered caches are ignored and rewritten", async (t) => {
  for (const contents of ["{not json", JSON.stringify({ version: 2, entries: {
    [`NCbeebs/Socrates-The-Cat|main|${SHA_A}`]: { validatedAt: Date.now(), touchedAt: Date.now(), outcome: { kind: "evil", message: "\u001b]0;pwn\u0007" } },
  } })]) {
    const { companion, cachePath } = fixture(t);
    writeFileSync(cachePath, contents);
    const fetchFn = scriptedFetch(reply(200, { status: "identical" }));
    const result = await checkForUpstreamUpdate({ companionPackageDir: companion, cachePath, runGitFn: git(), fetchFn });
    assert.equal(result.kind, "current");
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 2);
  }
});

test("CLI output labels results and strips terminal control sequences", () => {
  assert.match(formatCheckUpdatesCli({ kind: "update_available", message: "x" }), /^UPDATE AVAILABLE/);
  assert.match(formatCheckUpdatesCli({ kind: "current", message: "x" }), /^UP TO DATE/);
  assert.match(formatCheckUpdatesCli({ kind: "diverged", message: "x" }), /^NOTE/);
  assert.match(formatCheckUpdatesCli({ kind: "skipped", message: "x" }), /^SKIPPED/);
  const hostile = formatCheckUpdatesCli({ kind: "failed", message: "a\u001b[31m b\u0007c\u001b]0;title\u0007d\re\u009b2J" });
  assert.doesNotMatch(hostile, /[\x00-\x1f\x7f-\x9f]/);
  assert.equal(hostile, "FAILED: a bcde");
});
