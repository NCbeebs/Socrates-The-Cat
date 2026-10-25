/**
 * Managed companion spawn argv/env from extension debug settings (vsc-ext.md parity).
 * Pure functions used by session.ts at Start and by Node tests; no VS Code imports.
 */

export const HABITAT_DEBUG_ENV_KEYS = [
  "HABITAT_DEBUG",
  "HABITAT_DEBUG_SURFACES",
  "HABITAT_DEBUG_HUD",
  "HABITAT_DEBUG_LOG",
] as const;

export type HabitatDebugEnvKey = (typeof HABITAT_DEBUG_ENV_KEYS)[number];

/** Values read from `socrates.debug.*` user settings (or test fixtures). */
export interface DebugSettingsInput {
  enabled: boolean;
  surfaces: boolean | null;
  hud: boolean | null;
  streamJournal: boolean | null;
}

export interface ResolvedDebugEffective {
  effectiveSurfaces: boolean;
  effectiveHud: boolean;
  effectiveStreamJournal: boolean;
  effectiveDebugLog: boolean;
}

/** Env keys set for habitat debug after scrub (for diagnostics snapshot). */
export type HabitatDebugEnvSnapshot = Partial<
  Record<HabitatDebugEnvKey, string>
>;

/** Recorded after a validated spawn+attach (Show Diagnostics only). */
export interface AppliedSpawnDiagnostics {
  argv: string[];
  habitatDebugEnv: HabitatDebugEnvSnapshot;
  effective: ResolvedDebugEffective;
}

export interface ManagedSpawnPlan {
  argv: string[];
  env: NodeJS.ProcessEnv;
  effective: ResolvedDebugEffective;
  habitatDebugEnv: HabitatDebugEnvSnapshot;
}

export function resolveDebugEffective(
  input: DebugSettingsInput,
): ResolvedDebugEffective {
  const { enabled } = input;
  const effectiveSurfaces = input.surfaces ?? enabled;
  const effectiveHud = input.hud ?? enabled;
  const effectiveStreamJournal = input.streamJournal ?? enabled;
  const effectiveDebugLog = enabled || effectiveStreamJournal;
  return {
    effectiveSurfaces,
    effectiveHud,
    effectiveStreamJournal,
    effectiveDebugLog,
  };
}

export function buildManagedSpawnArgs(input: DebugSettingsInput): string[] {
  const args = ["--habitat-managed"];
  if (input.enabled) {
    args.push("--debug");
  }
  return args;
}

function flagString(on: boolean): string {
  return on ? "1" : "0";
}

/**
 * Copy base env, scrub inherited HABITAT_DEBUG*, apply managed + resolved debug flags.
 */
export function buildManagedChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  logDir: string,
  input: DebugSettingsInput,
): ManagedSpawnPlan {
  const effective = resolveDebugEffective(input);
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of HABITAT_DEBUG_ENV_KEYS) {
    delete env[key];
  }

  env.HABITAT_IDE_HOST = "code";
  env.HABITAT_MANAGED = "1";
  env.SOCRATES_LOG_DIR = logDir;

  const habitatDebugEnv: HabitatDebugEnvSnapshot = {};

  if (input.enabled) {
    env.HABITAT_DEBUG = "1";
    habitatDebugEnv.HABITAT_DEBUG = "1";
  }

  env.HABITAT_DEBUG_SURFACES = flagString(effective.effectiveSurfaces);
  habitatDebugEnv.HABITAT_DEBUG_SURFACES = env.HABITAT_DEBUG_SURFACES;

  env.HABITAT_DEBUG_HUD = flagString(effective.effectiveHud);
  habitatDebugEnv.HABITAT_DEBUG_HUD = env.HABITAT_DEBUG_HUD;

  env.HABITAT_DEBUG_LOG = flagString(effective.effectiveDebugLog);
  habitatDebugEnv.HABITAT_DEBUG_LOG = env.HABITAT_DEBUG_LOG;

  return {
    argv: buildManagedSpawnArgs(input),
    env,
    effective,
    habitatDebugEnv,
  };
}

export function toAppliedSpawnDiagnostics(
  plan: ManagedSpawnPlan,
): AppliedSpawnDiagnostics {
  return {
    argv: plan.argv,
    habitatDebugEnv: { ...plan.habitatDebugEnv },
    effective: { ...plan.effective },
  };
}

export function formatDebugSettingsLine(input: DebugSettingsInput): string {
  const s = input.surfaces === null ? "null" : String(input.surfaces);
  const h = input.hud === null ? "null" : String(input.hud);
  const j = input.streamJournal === null ? "null" : String(input.streamJournal);
  return `enabled=${input.enabled} surfaces=${s} hud=${h} streamJournal=${j}`;
}

export function formatEffectiveDebugLine(
  effective: ResolvedDebugEffective,
): string {
  return `surfaces=${effective.effectiveSurfaces} hud=${effective.effectiveHud} streamJournal=${effective.effectiveStreamJournal} debugLog=${effective.effectiveDebugLog}`;
}
