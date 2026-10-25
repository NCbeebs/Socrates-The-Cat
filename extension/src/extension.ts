/**
 * VS Code UI extension (Phase 3): Start / Stop / Show Diagnostics for the Windows companion.
 * Launches or attaches to the managed native process; clone `socrates` workflow is unchanged.
 */

import * as vscode from "vscode";

import { queryStatus } from "./managed-pipe.js";
import { managedLogDirectory, ManagedSession } from "./session.js";

const OUTPUT_CHANNEL = "Socrates";

let session: ManagedSession | undefined;
let output: vscode.OutputChannel | undefined;

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
  );
}

export async function deactivate(): Promise<void> {
  if (session) {
    await session.dispose();
    session = undefined;
  }
}

async function startCat(): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.start();
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

function log(message: string): void {
  output?.appendLine(message);
}
