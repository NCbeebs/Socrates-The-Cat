/**
 * VS Code UI extension (Phase 3): Start / Stop / Show Diagnostics for the Windows companion.
 * Launches or attaches to the managed native process; clone `socrates` workflow is unchanged.
 */

import * as vscode from "vscode";

import {
  debugConfigurationAffects,
  readRequestedDebugSettings,
} from "./debug-settings.js";
import { JournalStream } from "./journal-stream.js";
import { queryStatus } from "./managed-pipe.js";
import {
  formatDebugSettingsLine,
  formatEffectiveDebugLine,
  resolveDebugEffective,
} from "./spawn-options.js";
import { managedLogDirectory, ManagedSession } from "./session.js";

const OUTPUT_CHANNEL = "Socrates";

let session: ManagedSession | undefined;
let output: vscode.OutputChannel | undefined;
let journalStream: JournalStream | undefined;

export function activate(context: vscode.ExtensionContext): void {
  if (process.platform !== "win32") {
    void vscode.window.showWarningMessage(
      "Socrates the Cat is only supported on Windows.",
    );
    return;
  }

  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  session = new ManagedSession({
    extensionPath: context.extensionPath,
    logDir: managedLogDirectory(),
    allowDevCompanionFallback:
      context.extensionMode === vscode.ExtensionMode.Development ||
      context.extensionMode === vscode.ExtensionMode.Test,
  });

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("socrates.start", () => startCat()),
    vscode.commands.registerCommand("socrates.stop", () => stopCat()),
    vscode.commands.registerCommand("socrates.showDiagnostics", () =>
      showDiagnostics(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!debugConfigurationAffects(event)) {
        return;
      }
      if (session?.snapshot().attached) {
        void vscode.window.showInformationMessage(
          "Socrates habitat debug settings apply on the next Start. Stop the shared companion, then Start again.",
        );
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  stopJournalStream();
  if (session) {
    await session.dispose();
    session = undefined;
  }
}

async function startCat(): Promise<void> {
  if (!session) {
    return;
  }
  const debugSettings = readRequestedDebugSettings();
  try {
    const { attached } = await session.start(debugSettings);
    if (!attached) {
      return;
    }
    const effective = resolveDebugEffective(debugSettings);
    if (effective.effectiveStreamJournal) {
      ensureJournalStream(session.snapshot().logDir);
    }
    void vscode.window.showInformationMessage("Socrates started.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Start failed: ${message}`);
    void vscode.window.showErrorMessage(`Socrates could not start: ${message}`);
  }
}

async function stopCat(): Promise<void> {
  if (!session) {
    return;
  }
  stopJournalStream();
  try {
    await session.stop();
    void vscode.window.showInformationMessage("Socrates stopped.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Stop failed: ${message}`);
    void vscode.window.showErrorMessage(`Socrates could not stop: ${message}`);
  }
}

async function showDiagnostics(): Promise<void> {
  const channel = output ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  channel.show(true);
  const snap = session?.snapshot();
  const live = await queryStatus();
  const requested = readRequestedDebugSettings();
  const requestedEffective = resolveDebugEffective(requested);

  channel.appendLine("Socrates extension diagnostics");
  channel.appendLine(`Platform: ${process.platform}`);
  channel.appendLine(`Pipe: ${snap?.pipePath ?? "n/a"}`);
  channel.appendLine(`Log directory: ${snap?.logDir ?? managedLogDirectory()}`);
  channel.appendLine(
    `Companion: ${snap?.companionPath ?? "(not resolved yet)"}`,
  );
  channel.appendLine(`Attached: ${snap?.attached ?? false}`);
  channel.appendLine(`Client id: ${snap?.clientId ?? "n/a"}`);
  channel.appendLine(`Spawned child: ${snap?.spawnedChild ?? false}`);
  channel.appendLine("");
  channel.appendLine("Habitat debug (requested for next spawn):");
  channel.appendLine(`  settings: ${formatDebugSettingsLine(requested)}`);
  channel.appendLine(
    `  effective: ${formatEffectiveDebugLine(requestedEffective)}`,
  );
  if (snap?.appliedSpawn) {
    channel.appendLine("Habitat debug (applied when this window spawned):");
    channel.appendLine(`  argv: ${snap.appliedSpawn.argv.join(" ")}`);
    channel.appendLine(
      `  habitatDebugEnv: ${JSON.stringify(snap.appliedSpawn.habitatDebugEnv)}`,
    );
    channel.appendLine(
      `  effective: ${formatEffectiveDebugLine(snap.appliedSpawn.effective)}`,
    );
  } else if (snap?.attached) {
    channel.appendLine(
      "Habitat debug (running companion): unknown (attached to an existing managed instance; another window may have spawned it).",
    );
  }
  if (live) {
    channel.appendLine(
      `Live status: ready=${live.ready} owners=${live.owners} version=${live.version} protocol=${live.protocol}`,
    );
  } else {
    channel.appendLine("Live status: (no response from managed pipe)");
  }
  if (snap?.lastStatus) {
    channel.appendLine(
      `Last attach status: ready=${snap.lastStatus.ready} owners=${snap.lastStatus.owners}`,
    );
  }
}

function ensureJournalStream(logDir: string): void {
  if (journalStream && journalStream.logDir === logDir) {
    return;
  }
  stopJournalStream();
  const channel = output ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  journalStream = new JournalStream(logDir, channel);
}

function stopJournalStream(): void {
  journalStream?.dispose();
  journalStream = undefined;
}

function log(message: string): void {
  output?.appendLine(message);
}
