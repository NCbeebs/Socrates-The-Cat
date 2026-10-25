/**
 * Phase 4 Windows VSIX pipeline: validate release companion.exe, stage under extension/stage/,
 * copy native binary into extension/bin/win32-x64/, compile, and run vsce for win32-x64.
 * Does not publish; cleans only extension/stage/ and extension/out/ before packaging.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const EXTENSION_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXTENSION_DIR, "..");
const COMPANION_DIR = path.join(REPO_ROOT, "companion");
const RELEASE_EXE = path.join(
  COMPANION_DIR,
  "src-tauri",
  "target",
  "release",
  "companion.exe",
);
const STAGE_DIR = path.join(EXTENSION_DIR, "stage");
const BIN_DIR = path.join(EXTENSION_DIR, "bin", "win32-x64");
const BUNDLED_EXE = path.join(BIN_DIR, "companion.exe");
const PE_MACHINE_AMD64 = 0x8664;

const args = new Set(process.argv.slice(2));
const skipCompanionBuild = args.has("--skip-companion-build");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`package-win: ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: process.env,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} failed in ${cwd}`);
  }
}

function resolveNpmCli(cwd) {
  const candidates = [
    path.join(cwd, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    return require.resolve("npm/bin/npm-cli.js", { paths: [cwd] });
  } catch {
    fail(
      `npm-cli.js not found (checked ${candidates.join(", ")}); install Node.js npm or run npm ci`,
    );
  }
}

function runNpm(commandArgs, cwd) {
  const npmCli = resolveNpmCli(cwd);
  run(process.execPath, [npmCli, ...commandArgs], cwd);
}

function runVsce(commandArgs, cwd) {
  const vsceEntry = path.join(
    EXTENSION_DIR,
    "node_modules",
    "@vscode",
    "vsce",
    "vsce",
  );
  if (!fs.existsSync(vsceEntry)) {
    fail(`vsce not installed; run npm ci in extension/ (${vsceEntry})`);
  }
  run(process.execPath, [vsceEntry, ...commandArgs], cwd);
}

function cleanPackagingOutputs() {
  const extensionResolved = path.resolve(EXTENSION_DIR);
  for (const directory of [STAGE_DIR, path.join(EXTENSION_DIR, "out")]) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(extensionResolved + path.sep)) {
      fail("refusing to clean generated files outside extension/");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGE_DIR, { recursive: true });
}

function assertPe64(exePath) {
  const handle = fs.openSync(exePath, "r");
  try {
    const mz = Buffer.alloc(2);
    fs.readSync(handle, mz, 0, 2, 0);
    if (mz.readUInt16LE(0) !== 0x5a4d) {
      fail(`not a PE executable: ${exePath}`);
    }
    const peOffsetBuf = Buffer.alloc(4);
    fs.readSync(handle, peOffsetBuf, 0, 4, 0x3c);
    const peOffset = peOffsetBuf.readUInt32LE(0);
    const machineBuf = Buffer.alloc(2);
    fs.readSync(handle, machineBuf, 0, 2, peOffset + 4);
    const machine = machineBuf.readUInt16LE(0);
    if (machine !== PE_MACHINE_AMD64) {
      fail(`expected x64 PE (0x8664), got 0x${machine.toString(16)}`);
    }
  } finally {
    fs.closeSync(handle);
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readExtensionVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_DIR, "package.json"), "utf8"),
  );
  return pkg.version;
}

function readCompanionVersion() {
  const cargo = fs.readFileSync(
    path.join(COMPANION_DIR, "src-tauri", "Cargo.toml"),
    "utf8",
  );
  const match = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
  return match?.[1] ?? "unknown";
}

if (!skipCompanionBuild) {
  log("Building companion release (npm ci + tauri:build:release)…");
  runNpm(["ci"], COMPANION_DIR);
  runNpm(["run", "tauri:build:release"], COMPANION_DIR);
} else {
  log("Skipping companion build (--skip-companion-build).");
}

if (!fs.existsSync(RELEASE_EXE)) {
  fail(`missing release binary: ${RELEASE_EXE}`);
}

const { size, mtimeMs } = fs.statSync(RELEASE_EXE);
if (size < 1_000_000) {
  fail(`release binary suspiciously small (${size} bytes)`);
}
assertPe64(RELEASE_EXE);

cleanPackagingOutputs();
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.copyFileSync(RELEASE_EXE, BUNDLED_EXE);

const manifest = {
  packagedAt: new Date().toISOString(),
  extensionVersion: readExtensionVersion(),
  companionVersion: readCompanionVersion(),
  companionExe: {
    source: path.relative(REPO_ROOT, RELEASE_EXE),
    bytes: size,
    mtimeMs,
    sha256: sha256File(BUNDLED_EXE),
    architecture: "x64",
  },
};
fs.writeFileSync(
  path.join(STAGE_DIR, "bundle-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const licenseSrc = path.join(REPO_ROOT, "LICENSE");
if (fs.existsSync(licenseSrc)) {
  fs.copyFileSync(licenseSrc, path.join(EXTENSION_DIR, "LICENSE"));
}

log("Installing extension dependencies…");
runNpm(["ci"], EXTENSION_DIR);

const version = manifest.extensionVersion;
const vsixName = `socrates-the-cat-${version}-win32-x64.vsix`;
const vsixPath = path.join(STAGE_DIR, vsixName);

log(`Packaging ${vsixName}…`);
runVsce(["package", "--target", "win32-x64", "-o", vsixPath], EXTENSION_DIR);

if (!fs.existsSync(vsixPath)) {
  fail(`VSIX not created: ${vsixPath}`);
}

log(`VSIX: ${vsixPath}`);
log(`Companion sha256: ${manifest.companionExe.sha256}`);
log("Inspect with: npx @vscode/vsce ls --tree (from extension/)");
