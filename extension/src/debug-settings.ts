/**
 * Reads `socrates.debug.*` application-scoped settings for managed companion spawn.
 * Used from extension.ts / session.ts; resolution rules live in spawn-options.ts.
 */

import * as vscode from "vscode";

import type { DebugSettingsInput } from "./spawn-options.js";

const SECTION = "socrates";

export function readRequestedDebugSettings(): DebugSettingsInput {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: config.get<boolean>("debug.enabled", false),
    surfaces: config.get<boolean | null>("debug.surfaces", null),
    hud: config.get<boolean | null>("debug.hud", null),
    streamJournal: config.get<boolean | null>("debug.streamJournal", null),
  };
}

export function debugConfigurationAffects(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return (
    event.affectsConfiguration(`${SECTION}.debug.enabled`) ||
    event.affectsConfiguration(`${SECTION}.debug.surfaces`) ||
    event.affectsConfiguration(`${SECTION}.debug.hud`) ||
    event.affectsConfiguration(`${SECTION}.debug.streamJournal`)
  );
}
