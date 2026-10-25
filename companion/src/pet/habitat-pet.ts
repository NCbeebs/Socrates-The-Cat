/**
 * Layout-grounded cat: UIA attachment, fall, weighted sleep (stretch → enter → dream → exit → stretch). Art from `pet.json` + per-clip PNG strips.
 */

import type {
  ActivityDef,
  AnimationDef,
  GeometryMeta,
  HabitatBlock,
  IdeLocalPointer,
  IdeLocalPointerCoords,
  PetManifest,
  SitLookDef,
  SurfaceSeg,
} from "./types";
import { SashMatcher, type TrackedSash } from "./sash-matcher";

export type PetMotionPhase =
  | "grounded"
  | "falling"
  | "await_geometry"
  | "cling"
  | "slide"
  | "carried";

type SleepPhase =
  | "awake"
  | "pre_stretch"
  | "entering"
  | "sleeping"
  | "waking"
  | "post_stretch";

/** Portal open during walking → handoff → ledge-end exit; not a weighted activity. */
type PortalPhase = "awake" | "opening" | "pending_handoff" | "exiting";

type DividerSlidePhase = "awake" | "intro" | "descend" | "land";

interface RawLedge {
  id: string;
  x0: number;
  x1: number;
  y: number;
}

interface SlideWall {
  id: string;
  x: number;
  yTop: number;
  yBottom: number;
  windowEdge: "left" | "right" | null;
}

interface DividerSlideRoute {
  targetHwnd: number;
  wallId: string;
  destSurfaceId: string;
  sourceSurfaceId: string;
  end: "left" | "right";
  gripX: number;
  landingX: number;
  landingY: number;
}

type SegmentedPhase = "intro" | "loop" | "outro";

interface ActiveSegmentedPlay {
  animationKey: string;
  phase: SegmentedPhase;
  phaseIndex: number;
  loopsRemaining: number;
}

export interface PetDrawState {
  activityId: string;
  animationKey: string;
  /** Debug HUD: cosmetic overlay clip (e.g. sleeping `annoyed`); null when host animation only. */
  overlayAnimationKey: string | null;
  frameCol: number;
  frameRow: number;
  clipUrl: string;
  clipSize: [number, number];
  /** Source cell size in the clip image (defaults to habitat `frameSize`). */
  clipCellSize: [number, number];
  x: number;
  y: number;
  scale: number;
  flipX: boolean;
  motionPhase: PetMotionPhase;
  supportId: string | null;
  /**
   * Cosmetic carry drag rotation (degrees) around `swingPivot*`; cleared on release.
   * Wired in `draw-pet.ts`; driven from cursor grip velocity in `HabitatPet.tickCarrySwing`.
   */
  swingDeg: number;
  /** Overlay px hand pivot (`localX`/`localY` grip anchor). */
  swingPivotX: number;
  swingPivotY: number;
  /** Overlay-local px for `npm run tauri:dev:debug` pointer alignment checks. */
  pointerDebug: PetPointerDebug | null;
  /**
   * Overlay-local px when the validated cursor is inside the swipe/pounce reach box.
   * Rendered in `main.ts` as a red dot in normal pet mode (full pointer debug is opt-in).
   */
  pointerNearReach: { x: number; y: number } | null;
}

interface Ledge {
  id: string;
  role: string;
  x0: number;
  x1: number;
  y: number;
  length: number;
  confidence: number;
}

type SupportAttachment =
  | { kind: "ledge"; surfaceId: string; t: number }
  | {
      kind: "sash";
      trackKey: number;
      gripX: number;
      gripY: number;
      reachFromX: number;
      reachFromY: number;
    };

const GRAVITY_LOCAL = 1400;
const FALL_ANIM = "fall";
const FALL_AIR_LAST_CELL = 5;
const FALL_LAND_FIRST_CELL = 6;
const TURN_ANIM = "turn";
const AWAIT_GEOMETRY_MS = 280;
/** Ledge clamp margin in IDE-local px; scales with manifest `grid.frameSize` width (legacy ref 84). */
const FOOT_MARGIN_REF_WIDTH = 84;
const FOOT_MARGIN_REF_PX = 12;
/** Keep the full sprite clear of the IDE border, including pixel rounding. */
const WINDOW_INSET_PX = 8;
const SLEEP_ACTIVITY = "sleep";
const DEFAULT_TRAVEL_SPEED_PX_PER_SEC = 60;
const HANG_REACH_ANIM = "hang_vertical_reach";
const HANG_LOOP_ANIM = "hang_vertical";
const RIDE_GRIP_ACTIVITY_ID = "ride_grip";
const SASH_REACH_PX = 120;
const SASH_VELOCITY_MIN = 32;
/** Ledge Y increase between syncs that triggers detach instead of riding the surface down. */
const SUPPORT_LEDGE_DROP_PX = 5;
/** After a support-drop fall, ignore the departing ledge until the foot clears it. */
const FALL_IGNORE_LEDGE_CLEARANCE_PX = 12;
const SASH_STATIONARY_GRACE_MS = 900;
const SASH_GRIP_MARGIN_X = 24;
/** Live UIA scans can take multiple seconds; avoid false stale during cling. */
const GEOMETRY_STALE_MS = 8000;
const RIDE_COOLDOWN_MS = 12_000;
const PORTAL_OPEN_ANIM = "portal_open";
const PORTAL_EXIT_ANIM = "portal_exit";
const PORTAL_CHANCE_PER_SECOND = 0.12;
const PORTAL_COOLDOWN_MS = 90_000;
const SLIDE_INTRO_ANIM = "divider_slide_intro";
const SLIDE_GRIP_ANIM = "divider_slide_grip";
const SLIDE_LAND_ANIM = "divider_slide_land";
const SLIDE_ACTIVITY_ID = "divider_slide";
const WALL_HIT_PX = 22;
const WINDOW_EDGE_HIT_PX = 18;
const MIN_SLIDE_DROP_PX = 28;
const SLIDE_DESCEND_PX_PER_SEC = 200;
const WALL_WINDOW_LEFT_ID = "wall-window-left";
const WALL_WINDOW_RIGHT_ID = "wall-window-right";
const POINTER_ACTIVITY_PREFIX = "pointer_";
const POINTER_SWIPE_ACTIVITY = "pointer_swipe";
const POINTER_POUNCE_ACTIVITY = "pointer_pounce";
/** Sleep-only pointer reaction; not a weighted activity (`pet.json` `animations.annoyed`). */
const ANNOYED_ANIM = "annoyed";
const POINTER_SAMPLE_MAX_AGE_MS = 500;
/** Ignore tiny left/right jitter when updating `facingLeft` from the cursor. */
const POINTER_FACING_DEADBAND_PX = 10;
/** Extra reach in front of the cat (IDE-local px) along the current facing side. */
const POINTER_PAW_REACH_PX = 40;
const POINTER_REACH_PAD_PX = 12;
/** Click-and-hold in the pointer reach box to pick up and drag (`Socs-carried.png`). */
const CARRY_ACTIVITY_ID = "user_carry";
const CARRIED_PICKUP_ANIM = "carried_pickup";
const CARRIED_HOLD_ANIM = "carried_hold";
const CARRIED_RELEASE_ANIM = "carried_release";
export const CARRY_HOLD_MS = 250;
/** Drop carry after this long without a fresh validated input sample (not a button release). */
const CARRY_INPUT_LOSS_MS = 500;
/** `carried_release` cells played only after ledge contact (index 0 while airborne). */
const CARRY_RELEASE_LAND_FRAME_INDEX = 1;
/** Carry drag: horizontal cursor speed (IDE-local px/s) → swing target angle. */
const CARRY_SWING_VEL_TO_DEG = 0.055;
const CARRY_SWING_MAX_DEG = 11;
const CARRY_SWING_SMOOTH_PER_SEC = 11;

/** Sheet cells for `Socs-swipe-right.png` pointer swipe (`pet.json` `swipe`). */
const SWIPE_INTRO_CELLS = [3, 4, 5] as const;
const SWIPE_BATTER_CELL_MIN = 4;
const SWIPE_BATTER_CELL_MAX = 13;
const SWIPE_INTRO_FRAME_MS = 200;
const SWIPE_EXIT_FRAME_MS = 130;
/** Batter cadence while the cursor is in reach: slow when still, fast when moving. */
const SWIPE_BATTER_FPS_MIN = 4;
const SWIPE_BATTER_FPS_MAX = 16;
/** IDE-local px/s at which batter reaches max fps. */
const SWIPE_BATTER_SPEED_FOR_MAX_FPS = 520;
/** Weighted idle `sit_look` (`Socs-sit_and_look.png` angle-mapped gaze). */
const SIT_LOOK_ACTIVITY_ID = "sit_look";
const SIT_LOOK_ANIM = "sit_look";
/** Below this IDE-local px/s (after smoothing) gaze holds `neutralCell`. */
const SIT_LOOK_STILL_SPEED_PX_PER_SEC = 40;
export const SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG = 4;
const SIT_LOOK_ANGLE_AT_TARGET_EPS_DEG = 0.5;

/** `Socs-pounce-2.png` custom playback (`pointer_pounce`); see spec §8.5.1. */
const POUNCE_ENTRY_CELLS = [0, 1, 2, 3, 4, 5, 6] as const;
const POUNCE_LOOP_CELLS = [7, 8, 9, 10, 11] as const;
const POUNCE_RECOVERY_CELLS = [12, 13, 14, 15] as const;
const POUNCE_EXIT_HYSTERESIS_PX = 8;
/** Taller reach for `classifyReachExit` only; swipe engage/batter use the logical paw box. */
const POUNCE_EXIT_CLASSIFY_PAD_ABOVE_PX = 24;
const POUNCE_EXIT_CLASSIFY_PAD_BELOW_PX = 48;
const POUNCE_MIN_LEDGE_TRAVEL_PX = 16;
const POUNCE_MOTION_GRACE_MS = 150;
const POUNCE_MOTION_JITTER_PX = 2;
/** Travel progress at end of each loop cell (cells 7–11); paws finish on cursor by cell 11. */
const POUNCE_LOOP_TRAVEL_AT_CELL = [0, 0.12, 0.5, 0.88, 1] as const;

type SitLookPhase = "intro" | "gaze" | "exit";

export interface SitLookAngleKeyframe {
  cell: number;
  angleDeg: number;
}

/** Math unit circle: 0° = right, 90° = up (IDE-local Y is down). */
export function pointerBearingDeg(
  footX: number,
  footY: number,
  pointerX: number,
  pointerY: number,
): number {
  const dx = pointerX - footX;
  const dy = pointerY - footY;
  const rad = Math.atan2(-dy, dx);
  let deg = (rad * 180) / Math.PI;
  if (deg < 0) {
    deg += 360;
  }
  return deg;
}

export function shortestSignedAngleDelta(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/** One representative cell per authored look angle (lowest cell index wins ties). */
export function buildSitLookAngleKeyframes(
  lookAngleByCell: Record<string, number>,
): SitLookAngleKeyframe[] {
  const byAngle = new Map<number, number>();
  for (const [cellStr, angleDeg] of Object.entries(lookAngleByCell)) {
    const cell = Number(cellStr);
    const prev = byAngle.get(angleDeg);
    if (prev === undefined || cell < prev) {
      byAngle.set(angleDeg, cell);
    }
  }
  return [...byAngle.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([angleDeg, cell]) => ({ angleDeg, cell }));
}

export function keyframeIndexForSitLookGazeCell(
  cell: number,
  keyframes: readonly SitLookAngleKeyframe[],
  lookAngleByCell: Record<string, number>,
): number {
  const direct = keyframes.findIndex((kf) => kf.cell === cell);
  if (direct >= 0) {
    return direct;
  }
  const angle = lookAngleByCell[String(cell)];
  if (angle === undefined) {
    return 0;
  }
  const byAngle = keyframes.findIndex((kf) => kf.angleDeg === angle);
  return byAngle >= 0 ? byAngle : 0;
}

export function nearestSitLookGazeCell(
  bearingDeg: number,
  lookAngleByCell: Record<string, number>,
  currentCell: number,
  switchMarginDeg: number,
): number {
  let bestCell = currentCell;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [cellStr, angleDeg] of Object.entries(lookAngleByCell)) {
    const cell = Number(cellStr);
    const dist = Math.abs(shortestSignedAngleDelta(angleDeg, bearingDeg));
    if (
      dist < bestDist ||
      (dist === bestDist && cell === currentCell)
    ) {
      bestDist = dist;
      bestCell = cell;
    }
  }
  const currentAngle = lookAngleByCell[String(currentCell)];
  if (currentAngle === undefined || bestCell === currentCell) {
    return bestCell;
  }
  const currentDist = Math.abs(
    shortestSignedAngleDelta(currentAngle, bearingDeg),
  );
  const bestAngle = lookAngleByCell[String(bestCell)]!;
  const candidateDist = Math.abs(
    shortestSignedAngleDelta(bestAngle, bearingDeg),
  );
  if (candidateDist + switchMarginDeg >= currentDist) {
    return currentCell;
  }
  return bestCell;
}

/** Step one sorted angle keyframe toward `bearingDeg` (signed angular delta only). */
export function stepSitLookGazeCell(
  currentCell: number,
  bearingDeg: number,
  lookAngleByCell: Record<string, number>,
  keyframes: readonly SitLookAngleKeyframe[],
  switchMarginDeg: number = SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG,
): number {
  if (!keyframes.length) {
    return currentCell;
  }
  const i = keyframeIndexForSitLookGazeCell(
    currentCell,
    keyframes,
    lookAngleByCell,
  );
  const currentAngle = keyframes[i].angleDeg;
  const toBearing = shortestSignedAngleDelta(currentAngle, bearingDeg);
  const distToBearing = Math.abs(toBearing);
  if (distToBearing <= SIT_LOOK_ANGLE_AT_TARGET_EPS_DEG) {
    return nearestSitLookGazeCell(
      bearingDeg,
      lookAngleByCell,
      currentCell,
      switchMarginDeg,
    );
  }
  const n = keyframes.length;
  const prevIdx = (i - 1 + n) % n;
  const nextIdx = (i + 1) % n;
  const stepIdx = toBearing > 0 ? nextIdx : prevIdx;
  const stepAngle = keyframes[stepIdx].angleDeg;
  const distAfterStep = Math.abs(
    shortestSignedAngleDelta(stepAngle, bearingDeg),
  );
  if (distAfterStep >= distToBearing) {
    return nearestSitLookGazeCell(
      bearingDeg,
      lookAngleByCell,
      currentCell,
      switchMarginDeg,
    );
  }
  return keyframes[stepIdx].cell;
}

/** Simulate gaze scrub until stable; used by regression tests. */
export function convergeSitLookGazeCell(
  startCell: number,
  bearingDeg: number,
  lookAngleByCell: Record<string, number>,
  keyframes: readonly SitLookAngleKeyframe[],
  maxSteps = 256,
): { cell: number; steps: number } {
  let cell = startCell;
  for (let step = 0; step < maxSteps; step += 1) {
    const next = stepSitLookGazeCell(
      cell,
      bearingDeg,
      lookAngleByCell,
      keyframes,
    );
    if (next === cell) {
      return { cell, steps: step };
    }
    cell = next;
  }
  return { cell, steps: maxSteps };
}

function buildSwipeBatterSequence(): readonly number[] {
  const out: number[] = [];
  for (let c = SWIPE_BATTER_CELL_MIN; c <= SWIPE_BATTER_CELL_MAX; c += 1) {
    out.push(c);
  }
  for (let c = SWIPE_BATTER_CELL_MAX - 1; c >= SWIPE_BATTER_CELL_MIN; c -= 1) {
    out.push(c);
  }
  return out;
}

const SWIPE_BATTER_SEQ = buildSwipeBatterSequence();

function swipeBatterSeqIndexForCell(cell: number): number {
  const idx = SWIPE_BATTER_SEQ.indexOf(cell);
  return idx >= 0 ? idx : 0;
}

type SwipePlaybackPhase = "intro" | "batter" | "exit";

interface ActiveSwipePlayback {
  phase: SwipePlaybackPhase;
  gridCell: number;
  frameAccumulator: number;
  introIndex: number;
  batterSeqIndex: number;
  exitCells: number[];
  exitIndex: number;
  cursorInReach: boolean;
}

type PouncePlaybackPhase = "entry" | "loop" | "recovery";

interface ActivePouncePlayback {
  phase: PouncePlaybackPhase;
  gridCell: number;
  frameAccumulator: number;
  entryIndex: number;
  loopIndex: number;
  recoveryIndex: number;
  directionLeft: boolean;
  /** Normalized footpoint along the ledge segment for the active travel cycle. */
  cycleFromT: number;
  cycleToT: number;
  cycleSurfaceId: string;
}

/** One-shot full-sheet playback over the frozen sleep/dream host (`segmentedPlay` retained). */
interface ActiveAnnoyedPlayback {
  frameIndex: number;
  frameAccumulator: number;
}

export interface PetPointerDebug {
  sample: { x: number; y: number } | null;
  reach: { x0: number; y0: number; x1: number; y1: number } | null;
  rejectReason: string | null;
  comboRearm: boolean;
  pounceContinue: boolean;
  pounceDestLocalX: number | null;
  pounceReject: string | null;
}

function isPointerReactionActivity(activityId: string): boolean {
  return activityId.startsWith(POINTER_ACTIVITY_PREFIX);
}

function segmentsIntersect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(x1, y1, x2, y2, x3, y3);
  const d2 = d(x1, y1, x2, y2, x4, y4);
  const d3 = d(x3, y3, x4, y4, x1, y1);
  const d4 = d(x3, y3, x4, y4, x2, y2);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  return false;
}

type ReachBox = { x0: number; y0: number; x1: number; y1: number };

function pointInReachBox(x: number, y: number, reach: ReachBox): boolean {
  return x >= reach.x0 && x <= reach.x1 && y >= reach.y0 && y <= reach.y1;
}

/** IDE-local cursor position when inside the tracked window (`get_pointer_in_ide_local`). */
function idePointerCoords(
  pointer: IdeLocalPointer | null,
): { x: number; y: number } | null {
  if (!pointer || pointer.x == null || pointer.y == null) {
    return null;
  }
  return { x: pointer.x, y: pointer.y };
}

export type CarryInputPhase = "disarmed" | "armed" | "hold_pending";

/** Observed-press carry gesture; exported for regression tests. */
export function stepCarryInputTransition(
  phase: CarryInputPhase,
  holdStartedAtMs: number | null,
  primaryButtonDown: boolean,
  inReach: boolean,
  nowMs: number,
  carryActive: boolean,
): {
  phase: CarryInputPhase;
  holdStartedAtMs: number | null;
  beginCarry: boolean;
  endCarry: boolean;
} {
  let nextPhase = phase;
  let nextHold = holdStartedAtMs;
  let beginCarry = false;
  let endCarry = false;

  if (carryActive) {
    if (!primaryButtonDown) {
      endCarry = true;
    }
    return {
      phase: nextPhase,
      holdStartedAtMs: nextHold,
      beginCarry,
      endCarry,
    };
  }

  if (phase === "disarmed") {
    if (!primaryButtonDown) {
      nextPhase = "armed";
    }
    return { phase: nextPhase, holdStartedAtMs: null, beginCarry, endCarry };
  }

  if (phase === "armed") {
    if (!primaryButtonDown) {
      return { phase: nextPhase, holdStartedAtMs: null, beginCarry, endCarry };
    }
    if (inReach) {
      nextPhase = "hold_pending";
      nextHold = nowMs;
    } else {
      nextPhase = "disarmed";
    }
    return { phase: nextPhase, holdStartedAtMs: nextHold, beginCarry, endCarry };
  }

  if (!primaryButtonDown) {
    nextPhase = "disarmed";
    nextHold = null;
    return { phase: nextPhase, holdStartedAtMs: nextHold, beginCarry, endCarry };
  }

  if (!inReach) {
    nextPhase = "disarmed";
    nextHold = null;
    return { phase: nextPhase, holdStartedAtMs: nextHold, beginCarry, endCarry };
  }

  if (
    nextHold != null &&
    nowMs - nextHold >= CARRY_HOLD_MS
  ) {
    beginCarry = true;
    nextPhase = "armed";
    nextHold = null;
  }

  return { phase: nextPhase, holdStartedAtMs: nextHold, beginCarry, endCarry };
}

/** Earliest edge crossed when leaving the reach box along segment a→b. */
function classifyReachExit(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  reach: ReachBox,
): "left" | "right" | "vertical" | null {
  if (pointInReachBox(ax, ay, reach) && pointInReachBox(bx, by, reach)) {
    return null;
  }
  type EdgeKind = "left" | "right" | "top" | "bottom";
  const edges: { kind: EdgeKind; x0: number; y0: number; x1: number; y1: number }[] =
    [
      { kind: "left", x0: reach.x0, y0: reach.y0, x1: reach.x0, y1: reach.y1 },
      { kind: "right", x0: reach.x1, y0: reach.y0, x1: reach.x1, y1: reach.y1 },
      { kind: "top", x0: reach.x0, y0: reach.y0, x1: reach.x1, y1: reach.y0 },
      {
        kind: "bottom",
        x0: reach.x0,
        y0: reach.y1,
        x1: reach.x1,
        y1: reach.y1,
      },
    ];
  const segDx = bx - ax;
  const segDy = by - ay;
  const tieEps = 1e-4;
  let bestT = Number.POSITIVE_INFINITY;
  const hits: EdgeKind[] = [];
  for (const e of edges) {
    const edgeDx = e.x1 - e.x0;
    const edgeDy = e.y1 - e.y0;
    const denom = segDx * edgeDy - segDy * edgeDx;
    if (Math.abs(denom) < 1e-9) {
      continue;
    }
    const t =
      ((e.x0 - ax) * edgeDy - (e.y0 - ay) * edgeDx) / denom;
    const u =
      ((e.x0 - ax) * segDy - (e.y0 - ay) * segDx) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      if (t < bestT - tieEps) {
        bestT = t;
        hits.length = 0;
        hits.push(e.kind);
      } else if (Math.abs(t - bestT) <= tieEps) {
        hits.push(e.kind);
      }
    }
  }
  if (hits.length === 0) {
    return null;
  }
  const hasHorizontal = hits.includes("left") || hits.includes("right");
  const hasVertical = hits.includes("top") || hits.includes("bottom");
  if (hasHorizontal && hasVertical) {
    return "vertical";
  }
  if (hasVertical) {
    return "vertical";
  }
  if (hits.includes("left")) {
    return "left";
  }
  if (hits.includes("right")) {
    return "right";
  }
  return "vertical";
}

export class HabitatPet {
  private readonly habitat: HabitatBlock;
  private readonly clipUrls: Record<string, string>;
  private readonly clipSizes = new Map<string, [number, number]>();

  private activityId = "idle";
  private animationKey = "idle";
  private frameIndex = 0;
  private frameAccumulator = 0;
  private activityMsLeft = 3000;
  /** Right-authored clips mirror when the pet faces left (walk, idle, turn sheet). */
  private facingLeft = false;
  private localX = 0;
  private localY = 0;
  private attachment: SupportAttachment | null = null;
  private motionPhase: PetMotionPhase = "grounded";
  private clingSubPhase: "reach" | "hang" | null = null;
  /** Foot-pivot animation key used while `clingSubPhase === "reach"` (draw + anchor). */
  private clingReachPivotAnim = "idle";
  private readonly sashMatcher = new SashMatcher();
  /** `Socs-falling.png` airborne (cells 0–5) vs landing recovery (6–15). */
  private fallPhase: "airborne" | "land" | null = null;
  /** Ledge `y` at last successful grounded sync; detects downward drag with stable surface id. */
  private syncedSupportLedgeY: number | null = null;
  /** Departing ledge to skip for immediate re-landing after a support-drop fall. */
  private fallIgnoreLedgeId: string | null = null;
  private rideCooldownMs = 0;
  private fallPrevY = 0;
  private viewSx = 1;
  private viewSy = 1;
  private viewScale = 1;
  private viewport = { w: 0, h: 0 };
  private sleepPhase: SleepPhase = "awake";
  /** Nap budget during `sleeping` (`activities.sleep` minMs/maxMs); wake deferred until dream segment ends when segmented. */
  private sleepRestMsLeft = 0;
  private vyLocal = 0;
  private awaitGeometryMs = 0;
  private lastSurfaceRevision = 0;
  /** Last `GeometryMeta.targetHwnd`; HWND swaps use new window-local ledges — do not re-sync by surface id. */
  private lastGeometryHwnd = 0;
  private carryInputPhase: CarryInputPhase = "disarmed";
  private carryHoldStartedAtMs: number | null = null;
  private carrySubPhase: "pickup" | "held" | null = null;
  /** Locked `facingLeft` for mirror during carry/release fall. */
  private carryFacingLocked: boolean | null = null;
  private carryOwnerHwnd = 0;
  /** Drop uses `carried_release` + crossing-only ledge resolve (no status-bar snap). */
  private fallFromCarry = false;
  /** Cosmetic tilt while `carrySubPhase === "held"`; reset in `resetCarrySwing`. */
  private carrySwingDeg = 0;
  private carrySwingTargetDeg = 0;
  private carrySwingSample: { x: number; observedAtMs: number } | null = null;
  /** IDE-local px traveled while walking; drives walk frame phase when `stridePixelsPerLoop` is set. */
  private walkOdometer = 0;
  /** Previous finalized sample for swept reach; `targetHwnd` must match for segment tests. */
  private lastValidatedPointerPos: {
    x: number;
    y: number;
    targetHwnd: number;
  } | null = null;
  private pointerDebugEnabled = false;
  private pointerRejectReason: string | null = null;
  /** Set each `update` after validation; used for debug overlay + segment crossing. */
  private frameValidatedPointer: IdeLocalPointerCoords | null = null;
  private carryInputStaleMs = 0;
  private swipePlayback: ActiveSwipePlayback | null = null;
  private pouncePlayback: ActivePouncePlayback | null = null;
  /** Last confirmed in-reach sample for lateral exit classification (§8.5.1). */
  private lastInReachPointer: {
    x: number;
    y: number;
    t: number;
    targetHwnd: number;
  } | null = null;
  private pounceLateralAccumPx = 0;
  private pounceLastLateralMotionAtMs = 0;
  private pounceContinuationObs: {
    x: number;
    y: number;
    t: number;
    targetHwnd: number;
  } | null = null;
  private pounceWantsAnotherCycle = false;
  /** HWND that owns an in-flight swipe/pounce; survives pointer-history clears. */
  private pointerReactionOwnerHwnd = 0;
  /** False until the cursor fully leaves reach after a swipe/pounce combo. */
  private pointerComboRearm = true;
  private pounceDebugDestLocalX: number | null = null;
  private pounceDebugReject: string | null = null;
  private annoyedPlayback: ActiveAnnoyedPlayback | null = null;
  /** After one annoyed play, wait until the cursor fully leaves reach before re-arming. */
  private annoyedReachRearm = true;
  /** Smoothed cursor speed (IDE-local px/s) while inside reach; drives swipe batter fps. */
  private pointerSpeedPxPerSec = 0;
  private lastPointerMotionSample: { x: number; y: number; t: number } | null =
    null;
  private segmentedPlay: ActiveSegmentedPlay | null = null;
  private segmentedFrameAccumulator = 0;
  /** `sit_look` intro / gaze / stand-up exit; `frameIndex` is always the grid cell. */
  private sitLookPhase: SitLookPhase | null = null;
  private sitLookAngleKeyframes: SitLookAngleKeyframe[] = [];
  /** Whole-window pointer speed while sitting (swipe batter uses paw reach only). */
  private sitLookPointerSpeedPxPerSec = 0;
  private sitLookLastMotionSample: {
    x: number;
    y: number;
    t: number;
    targetHwnd: number;
  } | null = null;
  private sitLookMotionGraceMsLeft = 0;
  /** Weighted activity pool cooldown (`pet.json` `activities.*.cooldownMs`). */
  private readonly activityCooldownMsLeft = new Map<string, number>();
  private portalPhase: PortalPhase = "awake";
  private portalExitEnd: "left" | "right" = "left";
  private portalTargetHwnd = 0;
  private portalCooldownUntilMs = 0;
  private dividerSlidePhase: DividerSlidePhase = "awake";
  private slideRoute: DividerSlideRoute | null = null;

  constructor(manifest: PetManifest, clipUrls: Record<string, string>) {
    this.habitat = manifest.habitat;
    this.clipUrls = clipUrls;
    this.facingLeft = this.habitat.defaultFacing === "left";
  }

  /** Enables reach outline + sample marker in `PetDrawState.pointerDebug` (companion debug build). */
  setPointerDebugEnabled(enabled: boolean): void {
    this.pointerDebugEnabled = enabled;
  }

  /** Decode referenced clips, cache their sizes, and return URLs for SVG playback. */
  async preload(): Promise<string[]> {
    const names = new Set<string>();
    for (const anim of Object.values(this.habitat.animations)) {
      const clip = anim.clip ?? this.habitat.defaultClip;
      if (clip) {
        names.add(clip);
      }
    }
    if (this.habitat.defaultClip) {
      names.add(this.habitat.defaultClip);
    }
    return Promise.all([...names].map(async (name) => {
      const url = this.clipUrls[name];
      if (!url) {
        throw new Error(`pet clip not bundled: ${name}`);
      }
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        throw new Error(`pet clip decode failed: ${name}`);
      }
      this.clipSizes.set(name, [img.naturalWidth, img.naturalHeight]);
      return url;
    }));
  }

  update(
    dtMs: number,
    surfaces: SurfaceSeg[],
    sx: number,
    sy: number,
    viewport: { w: number; h: number },
    pointerSample: IdeLocalPointer | null,
    surfaceRevision: number,
    geometryMeta?: GeometryMeta,
  ): PetDrawState {
    this.viewport = viewport;
    const [fw, fh] = this.habitat.grid.frameSize;
    const inset = this.windowInset();
    const scale = Math.max(
      0,
      Math.min(
        Math.min(sx, sy) * 0.95,
        (viewport.w - 2 * inset) / fw,
        (viewport.h - 2 * inset) / fh,
      ),
    );
    this.viewSx = sx;
    this.viewSy = sy;
    this.viewScale = scale;
    const dt = dtMs / 1000;
    const meta: GeometryMeta = geometryMeta ?? {
      observedAtMs: Date.now(),
      targetHwnd: 0,
      scanSequence: 0,
      surfaceSource: "file",
    };
    const geometryStale = this.geometryIsStale(meta);
    const ledges = this.collectLedges(surfaces);
    if (
      meta.targetHwnd !== 0 &&
      this.lastGeometryHwnd !== 0 &&
      meta.targetHwnd !== this.lastGeometryHwnd
    ) {
      this.onTrackedIdeWindowChanged();
    }
    if (meta.targetHwnd !== 0) {
      this.lastGeometryHwnd = meta.targetHwnd;
    }
    const sashTracks = this.sashMatcher.ingest(
      this.collectHorizontalSashes(surfaces),
      {
        observedAtMs: meta.observedAtMs,
        targetHwnd: meta.targetHwnd,
        surfaceSource: meta.surfaceSource,
        scanSequence: meta.scanSequence,
      },
    );

    if (this.rideCooldownMs > 0) {
      this.rideCooldownMs = Math.max(0, this.rideCooldownMs - dtMs);
    }

    this.tickActivityCooldowns(dtMs);

    this.tickCarryInput(pointerSample, meta, dtMs);
    if (this.motionPhase === "carried") {
      this.noteSurfaceRevision(surfaceRevision, ledges, sashTracks, sy, scale);
      this.frameValidatedPointer = this.validatePointerSample(pointerSample, meta);
      this.tickCarried(dtMs, this.validateCarryInputSample(pointerSample, meta), sx, sy, scale);
      this.tickPointerReachBookkeeping(this.frameValidatedPointer);
      return this.toDrawState(scale, sx, sy);
    }

    const inCling = this.motionPhase === "cling";

    // Sash grab must run before revision/await_geometry demotes grounded → await_geometry.
    if (
      !inCling &&
      this.dividerSlidePhase === "awake" &&
      ledges.length > 0 &&
      !geometryStale &&
      this.canEvaluateSashGrab()
    ) {
      this.tryRespondToMovingDivider(sashTracks, ledges, sy, scale);
    }

    this.noteSurfaceRevision(surfaceRevision, ledges, sashTracks, sy, scale);
    this.frameValidatedPointer = this.validatePointerSample(pointerSample, meta);
    this.enforcePointerReactionOwner(meta);

    if (this.dividerSlidePhase !== "awake") {
      this.tickDividerSlide(dtMs, dt, surfaces, ledges, meta, geometryStale, sy, scale);
      if (
        this.dividerSlidePhase === "intro" ||
        this.dividerSlidePhase === "land"
      ) {
        this.advanceHostAnimationFrames(dtMs);
      }
      this.tickPointerReachBookkeeping(this.frameValidatedPointer);
      return this.toDrawState(scale, sx, sy);
    }

    if (this.awaitGeometryMs > 0) {
      this.awaitGeometryMs = Math.max(0, this.awaitGeometryMs - dtMs);
      if (
        this.awaitGeometryMs > 0 &&
        this.motionPhase !== "cling" &&
        this.motionPhase !== "falling"
      ) {
        this.motionPhase = "await_geometry";
      }
    }

    if (!ledges.length && !inCling && this.motionPhase !== "slide") {
      this.finishPortal();
      this.cancelPointerReactionPlayback();
      // Stay `falling` so the land clip can finish and `spawnOnBestLedge` cannot run mid-fall.
      if (this.motionPhase === "falling") {
        this.tickFallAnimation(dtMs);
      } else {
        this.motionPhase = "await_geometry";
      }
      this.tickPointerReachBookkeeping(this.frameValidatedPointer);
      return this.toDrawState(scale, sx, sy);
    }

    if (this.portalPhase !== "awake") {
      this.tickPortalSafety(meta, geometryStale);
    }

    if (this.motionPhase === "cling") {
      this.tickCling(geometryStale, sx, sy, scale);
      this.advanceHostAnimationFrames(dtMs);
      this.tickPointerReachBookkeeping(this.frameValidatedPointer);
      return this.toDrawState(scale, sx, sy);
    }

    if (
      !this.attachment &&
      this.awaitGeometryMs <= 0 &&
      this.motionPhase !== "falling"
    ) {
      this.spawnOnBestLedge(ledges);
      if (this.attachment) {
        this.motionPhase = "grounded";
      }
    }

    if (this.motionPhase === "await_geometry" && this.awaitGeometryMs <= 0) {
      this.motionPhase = this.attachment ? "grounded" : "falling";
    }

    if (
      (this.motionPhase === "grounded" ||
        this.motionPhase === "await_geometry") &&
      this.dividerSlidePhase === "awake"
    ) {
      this.syncGroundedAttachment(ledges, sashTracks, sy, scale);
    }

    if (this.motionPhase === "falling") {
      this.stepFall(ledges, dt);
      this.tickFallAnimation(dtMs);
    }

    const ledge = this.ledgeFromAttachment(ledges);
    if (this.motionPhase === "grounded" && ledge) {
      this.clampToLedge(ledge);
    }

    this.applyPointerFacing(this.frameValidatedPointer);
    this.updateSitLookPointerSpeed(this.frameValidatedPointer, dtMs);
    this.updatePointerMotionSpeed(this.frameValidatedPointer);
    this.syncSwipeCursorInReach(this.frameValidatedPointer);
    this.tryBeginPounceFromSwipe(
      this.frameValidatedPointer,
      ledges,
      geometryStale,
    );
    const pounceLedge = this.ledgeFromAttachment(ledges);
    this.tickPounceContinuationPointer(this.frameValidatedPointer, pounceLedge);

    this.tickSleepSequence(dtMs);

    const inPointerReact = isPointerReactionActivity(this.activityId);
    const inTurn = this.animationKey === TURN_ANIM;
    const inPortal = this.portalPhase !== "awake";
    const pointerMotionOk =
      this.motionPhase === "grounded" ||
      (this.motionPhase === "await_geometry" &&
        (this.awaitGeometryMs <= 0 || this.groundedSupportStillValid(ledges)));
    if (!inPortal && pointerMotionOk) {
      if (this.sleepPhase === "awake") {
        this.tryPointerSwipe(this.frameValidatedPointer, inTurn);
      } else if (this.sleepPhase === "sleeping") {
        this.tryPointerAnnoyed(this.frameValidatedPointer);
      }
    }

    const act = this.habitat.activities[this.activityId];

    if (
      !inPointerReact &&
      !inPortal &&
      this.dividerSlidePhase === "awake" &&
      this.motionPhase === "grounded" &&
      this.sleepPhase === "awake" &&
      this.awaitGeometryMs <= 0 &&
      act?.travel &&
      ledge &&
      this.animationKey !== TURN_ANIM
    ) {
      const travelAnimKey = act.animation ?? "walk";
      this.animationKey = travelAnimKey;
      const margin = this.footMarginLocal();
      const minX = ledge.x0 + margin;
      const maxX = ledge.x1 - margin;
      const speed = this.travelSpeedPxPerSec(act);
      const step = speed * dt;
      const stepDir = this.facingLeft ? -1 : 1;
      this.localX = Math.max(minX, Math.min(maxX, this.localX + stepDir * step));
      this.walkOdometer += step;
      this.syncWalkFrameFromDistance(act);
      this.writeAttachmentT(ledge);
      const atEndpoint = this.localX >= maxX || this.localX <= minX;
      if (atEndpoint) {
        const end: "left" | "right" = this.localX <= minX ? "left" : "right";
        if (
          this.tryBeginDividerSlideAtEndpoint(
            surfaces,
            ledges,
            end,
            meta,
            geometryStale,
          )
        ) {
          this.advanceHostAnimationFrames(dtMs);
          this.tickPointerReachBookkeeping(this.frameValidatedPointer);
          return this.toDrawState(scale, sx, sy);
        }
        this.beginTurn();
      } else {
        this.tryBeginPortal(dtMs, ledges, meta, geometryStale);
      }
    }

    const turning = this.animationKey === TURN_ANIM;
    if (
      !turning &&
      this.portalPhase === "awake" &&
      this.dividerSlidePhase === "awake"
    ) {
      this.activityMsLeft -= dtMs;
      if (
        this.activityMsLeft <= 0 &&
        !inPointerReact &&
        !act?.oneShot &&
        this.sleepPhase === "awake" &&
        this.motionPhase === "grounded" &&
        this.awaitGeometryMs <= 0
      ) {
        if (
          this.activityId === SIT_LOOK_ACTIVITY_ID &&
          this.sitLookPhase !== null &&
          this.sitLookPhase !== "exit"
        ) {
          this.beginSitLookExit();
        } else if (
          this.activityId !== SIT_LOOK_ACTIVITY_ID ||
          this.sitLookPhase !== "exit"
        ) {
          this.pickNextActivity();
        }
      }
    }

    const walkAnimKey = act?.animation ?? "walk";
    const travelAnim = act?.travel
      ? this.habitat.animations[walkAnimKey]
      : undefined;
    // Distance-based walk frames during grounded/await_geometry travel only (not while falling on idle clip).
    const walkPhaseLock =
      act?.travel &&
      (this.motionPhase === "grounded" ||
        this.motionPhase === "await_geometry") &&
      this.animationKey === walkAnimKey &&
      travelAnim?.stridePixelsPerLoop != null &&
      travelAnim.stridePixelsPerLoop > 0;

    const pouncePlaybackOk =
      this.activityId === POINTER_POUNCE_ACTIVITY &&
      this.pouncePlayback &&
      !walkPhaseLock &&
      this.motionPhase === "grounded" &&
      this.awaitGeometryMs <= 0 &&
      !geometryStale &&
      pounceLedge != null &&
      this.groundedSupportStillValid(ledges);
    if (pouncePlaybackOk) {
      this.advancePouncePlayback(dtMs, pounceLedge);
    } else if (
      this.activityId === POINTER_POUNCE_ACTIVITY &&
      this.pouncePlayback
    ) {
      this.cancelPointerReactionPlayback();
    } else if (
      !walkPhaseLock &&
      this.motionPhase !== "falling" &&
      (this.dividerSlidePhase === "awake" ||
        this.dividerSlidePhase === "intro" ||
        this.dividerSlidePhase === "land")
    ) {
      this.advanceHostAnimationFrames(dtMs);
    }

    if (this.portalPhase === "pending_handoff") {
      this.tryCompletePortalHandoff(ledges, meta, geometryStale);
    }

    this.tickPointerReachBookkeeping(this.frameValidatedPointer);

    return this.toDrawState(scale, sx, sy);
  }

  private tickSleepSequence(dtMs: number) {
    if (
      this.sleepPhase !== "sleeping" ||
      this.motionPhase !== "grounded" ||
      this.awaitGeometryMs > 0
    ) {
      return;
    }

    if (this.annoyedPlayback) {
      return;
    }

    this.sleepRestMsLeft -= dtMs;
    if (this.sleepRestMsLeft <= 0 && !this.activeSleepDreamSegmentedPlay()) {
      this.beginSleepExit();
    }
  }

  /** True while a manifest dream/rest clip is playing via `segmentedPlay` during `sleeping`. */
  private activeSleepDreamSegmentedPlay(): boolean {
    if (this.sleepPhase !== "sleeping" || !this.segmentedPlay) {
      return false;
    }
    return this.isDreamAnimationKey(this.segmentedPlay.animationKey);
  }

  /** Manifest `activities.sleep.preSleepAnimation` when it has `segmentedLoop`. */
  private sleepBookendPreKey(): string | null {
    const key = this.habitat.activities[SLEEP_ACTIVITY]?.preSleepAnimation;
    if (!key) {
      return null;
    }
    const anim = this.habitat.animations[key];
    if (!anim?.segmentedLoop?.loop.length) {
      return null;
    }
    return key;
  }

  /** Manifest `activities.sleep.postSleepAnimation` when it has `segmentedLoop`. */
  private sleepBookendPostKey(): string | null {
    const key = this.habitat.activities[SLEEP_ACTIVITY]?.postSleepAnimation;
    if (!key) {
      return null;
    }
    const anim = this.habitat.animations[key];
    if (!anim?.segmentedLoop?.loop.length) {
      return null;
    }
    return key;
  }

  private beginSleepPreStretch(stretchKey: string) {
    this.clearSegmentedPlay();
    this.activityId = SLEEP_ACTIVITY;
    this.sleepPhase = "pre_stretch";
    this.animationKey = stretchKey;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.sleepRestMsLeft = 0;
    if (!this.startSegmentedPlay(stretchKey)) {
      this.beginSleepEnter();
    }
  }

  private beginSleepPostStretch(stretchKey: string) {
    this.clearSegmentedPlay();
    this.sleepPhase = "post_stretch";
    this.animationKey = stretchKey;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.sleepRestMsLeft = 0;
    if (!this.startSegmentedPlay(stretchKey)) {
      this.finishWake();
    }
  }

  private beginSleepEnter() {
    this.clearSegmentedPlay();
    this.activityId = SLEEP_ACTIVITY;
    this.sleepPhase = "entering";
    this.animationKey = "sleep_enter";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.sleepRestMsLeft = 0;
  }

  private beginSleepDreaming() {
    const def = this.habitat.activities[SLEEP_ACTIVITY];
    this.sleepPhase = "sleeping";
    this.sleepRestMsLeft = def ? this.randMs(def) : 20_000;
    this.beginSleepDreamSegment();
  }

  /** Next rest/spectacle clip during `sleeping`; chains until `sleepRestMsLeft` expires at a segment boundary. */
  private beginSleepDreamSegment() {
    const dreamKey = this.pickSleepDreamAnimation();
    if (!dreamKey) {
      this.beginSleepExit();
      return;
    }
    this.animationKey = dreamKey;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.startSegmentedPlay(dreamKey);
  }

  /**
   * Manifest `dreamRestAnimation` vs `dreamAnimations` using `dreamRestWeight` /
   * `dreamSpectacleWeight` (defaults 2:1). Legacy: uniform over `dream_*` when unset.
   */
  private pickSleepDreamAnimation(): string | null {
    const def = this.habitat.activities[SLEEP_ACTIVITY];
    if (!def) {
      return null;
    }
    const restKey = def.dreamRestAnimation;
    const restClip = restKey ? this.habitat.animations[restKey]?.clip : undefined;
    const restAnim = restKey && restClip ? restKey : null;
    const restWeight = restAnim ? (def.dreamRestWeight ?? 2) : 0;
    const specWeight = def.dreamSpectacleWeight ?? 1;

    const spectacle = (def.dreamAnimations?.length
      ? def.dreamAnimations
      : Object.keys(this.habitat.animations).filter(
          (k) => k.startsWith("dream_") && k !== restKey,
        )
    ).filter((key) => this.habitat.animations[key]?.clip);

    const total = restWeight + specWeight;
    if (total > 0 && (restAnim || spectacle.length)) {
      const roll = Math.random() * total;
      if (restAnim && roll < restWeight) {
        return restAnim;
      }
      if (spectacle.length) {
        return (
          spectacle[Math.floor(Math.random() * spectacle.length)] ?? restAnim
        );
      }
      return restAnim;
    }

    const legacy = Object.keys(this.habitat.animations).filter((k) =>
      k.startsWith("dream_"),
    ).filter((key) => this.habitat.animations[key]?.clip);
    if (!legacy.length) {
      return null;
    }
    return legacy[Math.floor(Math.random() * legacy.length)] ?? null;
  }

  private isDreamAnimationKey(animationKey: string): boolean {
    const def = this.habitat.activities[SLEEP_ACTIVITY];
    if (def?.dreamRestAnimation === animationKey) {
      return true;
    }
    if (def?.dreamAnimations?.includes(animationKey)) {
      return true;
    }
    return animationKey.startsWith("dream_");
  }

  private beginSleepExit() {
    this.clearAnnoyedPlayback();
    this.clearSegmentedPlay();
    if (!this.habitat.animations.sleep_exit) {
      this.finishWake();
      return;
    }
    this.sleepPhase = "waking";
    this.animationKey = "sleep_exit";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.sleepRestMsLeft = 0;
  }

  private finishWake() {
    this.armActivityCooldown(SLEEP_ACTIVITY);
    this.sleepPhase = "awake";
    this.sleepRestMsLeft = 0;
    this.startIdle();
  }

  private clearSleepSequence() {
    if (this.sleepPhase === "awake") {
      return;
    }
    this.clearAnnoyedPlayback();
    this.clearSegmentedPlay();
    this.sleepPhase = "awake";
    this.sleepRestMsLeft = 0;
    this.activityId = "idle";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  private toDrawState(scale: number, sx: number, sy: number): PetDrawState {
    const drawKey = this.effectiveAnimationKey();
    const anim = this.habitat.animations[drawKey];
    const pivotAnim =
      this.motionPhase === "cling" && this.clingSubPhase === "reach"
        ? this.clingReachPivotAnim
        : drawKey;
    const pivot = this.pivotForDraw(pivotAnim);
    // Enforce the same boundary for falls, sash rides, portal exits, and pivot changes.
    // Move the physics anchor too so pointer reactions follow the visible cat.
    const safe = this.safeFootBounds(pivot);
    this.localX = Math.max(safe.x0, Math.min(safe.x1, this.localX));
    this.localY = Math.max(safe.y0, Math.min(safe.y1, this.localY));
    const drawX = this.localX * sx - pivot[0] * scale;
    const drawY = this.localY * sy - pivot[1] * scale;
    const { url, size } = this.resolveClip(drawKey);
    const gridCell = this.drawGridCell(drawKey);
    const { col, row } = this.gridCellToFrameCell(drawKey, gridCell);
    const [fw, fh] = this.habitat.grid.frameSize;
    const clipCellSize =
      anim?.clipCellSize ??
      this.habitat.grid.clipCellSize ?? [fw, fh];
    return {
      activityId: this.activityId,
      animationKey: this.animationKey,
      overlayAnimationKey: this.annoyedPlayback ? ANNOYED_ANIM : null,
      frameCol: col,
      frameRow: row,
      clipUrl: url,
      clipSize: size,
      clipCellSize,
      x: drawX,
      y: drawY,
      scale,
      flipX: this.clipMirroredForDraw(drawKey),
      motionPhase: this.motionPhase,
      supportId: this.supportIdLabel(),
      swingDeg:
        this.motionPhase === "carried" && this.carrySubPhase === "held"
          ? this.carrySwingDeg
          : 0,
      swingPivotX: this.localX * sx,
      swingPivotY: this.localY * sy,
      pointerDebug: this.buildPointerDebug(sx, sy, this.frameValidatedPointer),
      pointerNearReach: this.buildPointerNearReachHint(
        sx,
        sy,
        this.frameValidatedPointer,
      ),
    };
  }

  private buildPointerNearReachHint(
    sx: number,
    sy: number,
    pointer: IdeLocalPointerCoords | null,
  ): { x: number; y: number } | null {
    if (!pointer || !this.pointerEngagesReach(pointer)) {
      return null;
    }
    return { x: pointer.x * sx, y: pointer.y * sy };
  }

  private buildPointerDebug(
    sx: number,
    sy: number,
    pointer: IdeLocalPointerCoords | null,
  ): PetPointerDebug | null {
    if (!this.pointerDebugEnabled) {
      return null;
    }
    const reach = this.pointerReachBoxLocal();
    return {
      sample: pointer
        ? { x: pointer.x * sx, y: pointer.y * sy }
        : null,
      reach: {
        x0: reach.x0 * sx,
        y0: reach.y0 * sy,
        x1: reach.x1 * sx,
        y1: reach.y1 * sy,
      },
      rejectReason: this.pointerRejectReason,
      comboRearm: this.pointerComboRearm,
      pounceContinue: this.pounceWantsAnotherCycle,
      pounceDestLocalX:
        this.pounceDebugDestLocalX != null
          ? this.pounceDebugDestLocalX * sx
          : null,
      pounceReject: this.pounceDebugReject,
    };
  }

  private supportIdLabel(): string | null {
    if (!this.attachment) {
      return null;
    }
    if (this.attachment.kind === "sash") {
      return `sash:${this.attachment.trackKey}`;
    }
    return this.attachment.surfaceId;
  }

  private resolveClip(animationKey: string): { url: string; size: [number, number] } {
    const anim = this.habitat.animations[animationKey];
    const idle = this.habitat.animations.idle;
    const clipName =
      anim?.clip ?? idle?.clip ?? this.habitat.defaultClip ?? "socs-idle.png";
    const url = this.clipUrls[clipName];
    const size = this.clipSizes.get(clipName);
    if (!url || !size) {
      throw new Error(`pet clip unavailable: ${clipName}`);
    }
    return { url, size };
  }

  private pivotForAnimation(animationKey: string): [number, number] {
    const anim = this.habitat.animations[animationKey];
    return anim?.pivotOverride ?? this.habitat.pivot;
  }

  /** Mirror pivot X when the clip is flipped so paw/foot anchors stay on `localX`/`localY`. */
  private pivotForDraw(animationKey: string): [number, number] {
    const [px, py] =
      animationKey === "pounce" && this.pouncePlayback
        ? this.pounceContactPivot(this.pouncePlayback.gridCell)
        : this.pivotForAnimation(animationKey);
    if (this.clipMirroredForDraw(animationKey)) {
      const fw = this.habitat.grid.frameSize[0];
      return [fw - px, py];
    }
    return [px, py];
  }

  /** `noFlip` clips (sit gaze) and draw must agree with `pivotForDraw`. */
  private clipMirroredForDraw(animationKey: string): boolean {
    if (this.habitat.animations[animationKey]?.noFlip) {
      return false;
    }
    if (this.carryFacingLocked !== null) {
      return this.carryFacingLocked;
    }
    return this.facingLeft;
  }

  /** Right-authored contact point for a pounce sheet cell (`pet.json` `pounceContactByCell`). */
  private pounceContactPivot(cell: number): [number, number] {
    const anim = this.habitat.animations.pounce;
    const mapped = anim?.pounceContactByCell?.[String(cell)];
    if (mapped) {
      return mapped;
    }
    return this.pivotForAnimation("pounce");
  }

  /** Horizontal lead from habitat foot pivot to landing paw contact (right-facing sheet). */
  private pounceLandLeadPx(): number {
    const landCell = POUNCE_LOOP_CELLS[POUNCE_LOOP_CELLS.length - 1];
    const contact = this.pounceContactPivot(landCell);
    const base = this.pivotForAnimation("pounce");
    return contact[0] - base[0];
  }

  /** `localX` so the landing paw contact sits on `pointerX` (IDE-local). */
  private pounceFootTargetX(pointerX: number, directionLeft: boolean): number {
    const lead = this.pounceLandLeadPx();
    return directionLeft ? pointerX + lead : pointerX - lead;
  }

  private pivotForPounceCellDraw(cell: number): [number, number] {
    const [px, py] = this.pounceContactPivot(cell);
    if (this.facingLeft) {
      const fw = this.habitat.grid.frameSize[0];
      return [fw - px, py];
    }
    return [px, py];
  }

  private shiftPounceContactPivot(fromCell: number, toCell: number): void {
    if (fromCell === toCell) {
      return;
    }
    const oldP = this.pivotForPounceCellDraw(fromCell);
    const newP = this.pivotForPounceCellDraw(toCell);
    const sx = this.viewSx;
    const sy = this.viewSy;
    const scale = this.viewScale;
    this.localX += ((newP[0] - oldP[0]) * scale) / sx;
    this.localY += ((newP[1] - oldP[1]) * scale) / sy;
  }

  private footMarginLocal(): number {
    const w = this.habitat.grid.frameSize[0];
    return Math.max(
      8,
      Math.round((w / FOOT_MARGIN_REF_WIDTH) * FOOT_MARGIN_REF_PX),
    );
  }

  private windowInset(): number {
    return Math.min(
      WINDOW_INSET_PX,
      Math.floor(Math.min(this.viewport.w, this.viewport.h) / 4),
    );
  }

  /**
   * Foreground tracked IDE window changed (`lib.rs` HWND). Surface ids like `platform-statusbar-top`
   * are stable but Y/X are window-local; `syncAttachmentFromLedgeT` must not run across HWNDs.
   */
  private onTrackedIdeWindowChanged(): void {
    this.carryInputPhase = "disarmed";
    this.carryHoldStartedAtMs = null;
    this.fallIgnoreLedgeId = null;
    this.awaitGeometryMs = 0;
    if (this.motionPhase === "carried") {
      this.abortCarryInterrupted();
      return;
    }
    if (this.motionPhase === "cling") {
      this.clingSubPhase = null;
    }
    if (this.motionPhase !== "falling") {
      this.beginFall();
    } else {
      this.clearCarryDropPlaybackState();
      this.attachment = null;
      this.fallPhase = "airborne";
      this.frameIndex = this.fallAirHoldFrameIndex();
      this.animationKey = FALL_ANIM;
    }
  }

  /** Convert sprite extents from overlay pixels to the UIA geometry's local coordinates. */
  private safeFootBounds([px, py]: [number, number]): ReachBox {
    const [fw, fh] = this.habitat.grid.frameSize;
    const inset = this.windowInset();
    const scale = this.viewScale;
    return {
      x0: (inset + px * scale) / this.viewSx,
      x1: (this.viewport.w - inset - (fw - px) * scale) / this.viewSx,
      y0: (inset + py * scale) / this.viewSy,
      y1: (this.viewport.h - inset - (fh - py) * scale) / this.viewSy,
    };
  }

  private noteSurfaceRevision(
    revision: number,
    ledges: Ledge[],
    sashTracks: TrackedSash[],
    sy: number,
    scale: number,
  ) {
    if (revision === this.lastSurfaceRevision) {
      return;
    }
    const hadPrior = this.lastSurfaceRevision !== 0;
    this.lastSurfaceRevision = revision;
    if (!hadPrior) {
      return;
    }
    if (
      this.motionPhase === "cling" ||
      this.motionPhase === "falling" ||
      this.dividerSlidePhase !== "awake"
    ) {
      return;
    }
    if (this.groundedSupportStillValid(ledges)) {
      if (this.shouldDetachForDownwardSupport(ledges, sashTracks, sy, scale)) {
        const ledge = this.ledgeFromAttachment(ledges);
        this.beginFallFromSupportDrop(ledge?.id ?? null);
      }
      return;
    }
    this.awaitGeometryMs = AWAIT_GEOMETRY_MS;
  }

  private groundedSupportStillValid(ledges: Ledge[]): boolean {
    if (this.motionPhase !== "grounded" && this.motionPhase !== "await_geometry") {
      return false;
    }
    const att = this.attachment;
    if (!att || att.kind !== "ledge") {
      return false;
    }
    const ledge = ledges.find((l) => l.id === att.surfaceId);
    if (!ledge) {
      return false;
    }
    const margin = this.footMarginLocal();
    return (
      this.localX >= ledge.x0 - margin &&
      this.localX <= ledge.x1 + margin &&
      Math.abs(this.localY - ledge.y) <= 6
    );
  }

  private geometryIsStale(meta: GeometryMeta): boolean {
    if (!meta.observedAtMs) {
      return true;
    }
    return Date.now() - meta.observedAtMs > GEOMETRY_STALE_MS;
  }

  /** UIA horizontal panel sashes (`ledge-h-*` from `surface_mapper.rs`). */
  private collectHorizontalSashes(surfaces: SurfaceSeg[]) {
    const out: { id: string; y: number; x0: number; x1: number }[] = [];
    for (const s of surfaces) {
      if (!s.id.startsWith("ledge-h-")) {
        continue;
      }
      const dy = Math.abs(s.b.y - s.a.y);
      const dx = Math.abs(s.b.x - s.a.x);
      if (dy >= 4 || dx <= 80) {
        continue;
      }
      const x0 = Math.min(s.a.x, s.b.x);
      const x1 = Math.max(s.a.x, s.b.x);
      const y = (s.a.y + s.b.y) / 2;
      out.push({ id: s.id, y, x0, x1 });
    }
    return out;
  }

  private hangPivot(): [number, number] {
    const anim = this.habitat.animations[HANG_LOOP_ANIM];
    return anim?.pivotOverride ?? [64, 8];
  }

  private pawYFromFoot(footY: number, sy: number, scale: number): number {
    const footPivot = this.habitat.pivot;
    const hangPivot = this.hangPivot();
    return footY + ((hangPivot[1] - footPivot[1]) * scale) / sy;
  }

  private horizontalDistanceToSash(x: number, track: TrackedSash): number {
    if (x < track.x0) {
      return track.x0 - x;
    }
    if (x > track.x1) {
      return x - track.x1;
    }
    return 0;
  }

  private clampSashGripX(x: number, track: TrackedSash): number {
    return Math.max(
      track.x0 + SASH_GRIP_MARGIN_X,
      Math.min(track.x1 - SASH_GRIP_MARGIN_X, x),
    );
  }

  private footYFromGrip(gripY: number, sy: number, scale: number): number {
    const footPivot = this.habitat.pivot;
    const hangPivot = this.hangPivot();
    return gripY + ((footPivot[1] - hangPivot[1]) * scale) / sy;
  }

  /** Keep overlay draw position when swapping pivot / anchor animation. */
  private shiftAnchorPivot(
    fromAnim: string,
    toAnim: string,
    sx: number,
    sy: number,
    scale: number,
  ): void {
    const oldP = this.pivotForDraw(fromAnim);
    const newP = this.pivotForDraw(toAnim);
    this.localX += ((newP[0] - oldP[0]) * scale) / sx;
    this.localY += ((newP[1] - oldP[1]) * scale) / sy;
  }

  private canEvaluateSashGrab(): boolean {
    if (
      this.motionPhase === "cling" ||
      this.motionPhase === "falling" ||
      this.motionPhase === "slide" ||
      this.motionPhase === "carried"
    ) {
      return false;
    }
    if (this.motionPhase === "grounded") {
      return true;
    }
    return (
      this.motionPhase === "await_geometry" &&
      this.attachment?.kind === "ledge"
    );
  }

  private canStartSashGrab(): boolean {
    if (!this.canEvaluateSashGrab() || this.sleepPhase !== "awake") {
      return false;
    }
    if (this.portalPhase !== "awake" || this.dividerSlidePhase !== "awake") {
      return false;
    }
    if (
      this.animationKey === TURN_ANIM ||
      isPointerReactionActivity(this.activityId)
    ) {
      return false;
    }
    if (this.activityId.startsWith("groom")) {
      return false;
    }
    if (this.segmentedPlay) {
      return false;
    }
    if (this.rideCooldownMs > 0) {
      return false;
    }
    return true;
  }

  /** Closest horizontal sash divider at the paw/foot (shared proximity for up-hang and down-fall). */
  private findDividerTrackAtFoot(
    tracks: TrackedSash[],
    sy: number,
    scale: number,
  ): TrackedSash | null {
    const footY = this.localY;
    const pawY = this.pawYFromFoot(footY, sy, scale);
    let best: { track: TrackedSash; dist: number } | null = null;
    for (const track of tracks) {
      if (this.horizontalDistanceToSash(this.localX, track) > SASH_REACH_PX) {
        continue;
      }
      const gripX = this.clampSashGripX(this.localX, track);
      if (
        gripX < track.x0 + SASH_GRIP_MARGIN_X ||
        gripX > track.x1 - SASH_GRIP_MARGIN_X
      ) {
        continue;
      }
      const pawToSash = Math.abs(track.y - pawY);
      if (pawToSash > SASH_REACH_PX) {
        continue;
      }
      const dist = Math.abs(track.y - footY);
      if (!best || dist < best.dist) {
        best = { track, dist };
      }
    }
    return best?.track ?? null;
  }

  private shouldDetachForDownwardSupport(
    ledges: Ledge[],
    tracks: TrackedSash[],
    sy: number,
    scale: number,
  ): boolean {
    const track = this.findDividerTrackAtFoot(tracks, sy, scale);
    if (track && track.velocityY > SASH_VELOCITY_MIN) {
      return true;
    }
    const ledge = this.ledgeFromAttachment(ledges);
    if (
      ledge &&
      this.syncedSupportLedgeY != null &&
      ledge.y - this.syncedSupportLedgeY > SUPPORT_LEDGE_DROP_PX
    ) {
      return true;
    }
    return false;
  }

  private tryRespondToMovingDivider(
    tracks: TrackedSash[],
    ledges: Ledge[],
    sy: number,
    scale: number,
  ): void {
    if (!this.canEvaluateSashGrab()) {
      return;
    }
    const track = this.findDividerTrackAtFoot(tracks, sy, scale);
    if (!track) {
      return;
    }
    if (track.velocityY > SASH_VELOCITY_MIN) {
      const ledge = this.ledgeFromAttachment(ledges);
      this.beginFallFromSupportDrop(ledge?.id ?? null);
      return;
    }
    if (!this.canStartSashGrab() || track.velocityY > -SASH_VELOCITY_MIN) {
      return;
    }
    this.beginSashCling(track);
  }

  private beginSashCling(track: TrackedSash): void {
    this.clearSegmentedPlay();
    this.clearSitLookState();
    this.activityId = RIDE_GRIP_ACTIVITY_ID;
    this.motionPhase = "cling";
    this.clingSubPhase = "reach";
    this.clingReachPivotAnim =
      this.animationKey === TURN_ANIM ? "idle" : this.animationKey;
    const gripX = this.clampSashGripX(this.localX, track);
    this.attachment = {
      kind: "sash",
      trackKey: track.trackKey,
      gripX,
      gripY: track.y,
      reachFromX: this.localX,
      reachFromY: this.localY,
    };
    this.animationKey = HANG_REACH_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.vyLocal = 0;
  }

  private tickCling(
    stale: boolean,
    sx: number,
    sy: number,
    scale: number,
  ): void {
    const att = this.attachment;
    if (att?.kind !== "sash") {
      this.releaseSashCling(true, sx, sy, scale);
      return;
    }
    const track = this.sashMatcher.trackByKey(att.trackKey);
    if (!track || stale) {
      this.releaseSashCling(true, sx, sy, scale);
      return;
    }
    if (this.clingSubPhase === "reach") {
      const reachAnim = this.habitat.animations[HANG_REACH_ANIM];
      const frameCount = reachAnim?.frames.length ?? 1;
      const progress =
        frameCount <= 1 ? 1 : this.frameIndex / (frameCount - 1);
      const targetFootY = this.footYFromGrip(track.y, sy, scale);
      this.localX = att.reachFromX + (att.gripX - att.reachFromX) * progress;
      this.localY = att.reachFromY + (targetFootY - att.reachFromY) * progress;
      return;
    }
    this.followSashFootOnTrack(att, track);
    if (
      this.clingSubPhase === "hang" &&
      track.stationaryMs >= SASH_STATIONARY_GRACE_MS
    ) {
      this.releaseSashCling(false, sx, sy, scale);
    }
  }

  private followSashFootOnTrack(
    att: Extract<SupportAttachment, { kind: "sash" }>,
    track: TrackedSash,
  ): void {
    att.gripY = track.y;
    att.gripX = this.clampSashGripX(att.gripX, track);
    this.localX = att.gripX;
    this.localY = track.y;
  }

  private attachToLedgePreserveFoot(ledge: Ledge): void {
    const span = ledge.x1 - ledge.x0;
    const t = span > 1 ? (this.localX - ledge.x0) / span : 0.5;
    this.attachment = {
      kind: "ledge",
      surfaceId: ledge.id,
      t: Math.max(0, Math.min(1, t)),
    };
    this.localY = ledge.y;
  }

  private releaseSashCling(
    aborted: boolean,
    sx: number,
    sy: number,
    scale: number,
  ): void {
    const att = this.attachment;
    const wasHang = att?.kind === "sash" && this.clingSubPhase === "hang";

    if (wasHang) {
      this.shiftAnchorPivot(HANG_LOOP_ANIM, FALL_ANIM, sx, sy, scale);
    }

    this.clingSubPhase = null;
    this.attachment = null;
    this.beginFall();
    this.fallPrevY = this.localY;
    if (!aborted) {
      this.rideCooldownMs = RIDE_COOLDOWN_MS;
    }
  }

  private completeHangReach(sx: number, sy: number, scale: number): void {
    const att = this.attachment;
    const track =
      att?.kind === "sash"
        ? this.sashMatcher.trackByKey(att.trackKey)
        : undefined;
    this.shiftAnchorPivot(this.clingReachPivotAnim, HANG_LOOP_ANIM, sx, sy, scale);
    this.clingSubPhase = "hang";
    this.animationKey = HANG_LOOP_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    if (track && att?.kind === "sash") {
      att.gripY = track.y;
      att.gripX = this.clampSashGripX(att.gripX, track);
      this.localX = att.gripX;
      this.localY = att.gripY;
    }
  }

  private advanceHostAnimationFrames(dtMs: number): void {
    if (this.portalPhase === "pending_handoff") {
      return;
    }
    if (this.annoyedPlayback) {
      this.advanceAnnoyedPlayback(dtMs);
      return;
    }
    if (
      this.activityId === SIT_LOOK_ACTIVITY_ID &&
      this.sitLookPhase !== null
    ) {
      this.advanceSitLookFrames(dtMs);
      return;
    }
    if (
      this.activityId === POINTER_SWIPE_ACTIVITY &&
      this.swipePlayback
    ) {
      this.advanceSwipePlayback(dtMs);
      return;
    }
    if (this.segmentedPlay?.animationKey === this.animationKey) {
      this.advanceSegmentedFrames(dtMs);
      return;
    }
    const anim = this.hostAnimation();
    if (!anim?.frames.length) {
      return;
    }
    this.frameAccumulator += dtMs;
    const frameDuration = 1000 / (anim.fps || 6);
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      const current = this.hostAnimation();
      if (!current?.frames.length) {
        break;
      }
      if (!this.advanceFrame(current)) {
        break;
      }
    }
  }

  private clientLocalSize(): { w: number; h: number } {
    return {
      w: this.viewport.w / this.viewSx,
      h: this.viewport.h / this.viewSy,
    };
  }

  private collectRawWalkableHorizontals(surfaces: SurfaceSeg[]): RawLedge[] {
    const out: RawLedge[] = [];
    for (const s of surfaces) {
      if (!s.walkable || s.role === "wall") {
        continue;
      }
      const dy = Math.abs(s.a.y - s.b.y);
      const dx = Math.abs(s.b.x - s.a.x);
      if (dy >= 2 || dx <= 80) {
        continue;
      }
      out.push({
        id: s.id,
        x0: Math.min(s.a.x, s.b.x),
        x1: Math.max(s.a.x, s.b.x),
        y: (s.a.y + s.b.y) / 2,
      });
    }
    return out;
  }

  private collectUiaWalls(surfaces: SurfaceSeg[]): SlideWall[] {
    const out: SlideWall[] = [];
    for (const s of surfaces) {
      if (s.role !== "wall" || !s.climbable) {
        continue;
      }
      const x = (s.a.x + s.b.x) / 2;
      const yTop = Math.min(s.a.y, s.b.y);
      const yBottom = Math.max(s.a.y, s.b.y);
      if (yBottom - yTop < MIN_SLIDE_DROP_PX) {
        continue;
      }
      out.push({
        id: s.id,
        x,
        yTop,
        yBottom,
        windowEdge: null,
      });
    }
    return out;
  }

  private syntheticWindowWalls(
    sourceRaw: RawLedge,
    end: "left" | "right",
    clientW: number,
    clientH: number,
  ): SlideWall | null {
    const endpointX = end === "right" ? sourceRaw.x1 : sourceRaw.x0;
    const atRight =
      end === "right" && endpointX >= clientW - WINDOW_EDGE_HIT_PX;
    const atLeft = end === "left" && endpointX <= WINDOW_EDGE_HIT_PX;
    if (!atRight && !atLeft) {
      return null;
    }
    const x = atRight ? clientW : 0;
    return {
      id: atRight ? WALL_WINDOW_RIGHT_ID : WALL_WINDOW_LEFT_ID,
      x,
      yTop: sourceRaw.y,
      yBottom: clientH,
      windowEdge: atRight ? "right" : "left",
    };
  }

  private slideFootYFromGrip(gripY: number, sy: number, scale: number): number {
    const footPivot = this.habitat.pivot;
    const gripPivot = this.pivotForDraw(SLIDE_GRIP_ANIM);
    return gripY + ((footPivot[1] - gripPivot[1]) * scale) / sy;
  }

  private gripYFromFoot(footY: number, sy: number, scale: number): number {
    const footPivot = this.habitat.pivot;
    const gripPivot = this.pivotForDraw(SLIDE_GRIP_ANIM);
    return footY + ((gripPivot[1] - footPivot[1]) * scale) / sy;
  }

  private drawableGripX(wall: SlideWall): number {
    const gripSafe = this.safeFootBounds(this.pivotForDraw(SLIDE_GRIP_ANIM));
    if (wall.windowEdge === "right") {
      return gripSafe.x1;
    }
    if (wall.windowEdge === "left") {
      return gripSafe.x0;
    }
    return Math.max(gripSafe.x0, Math.min(gripSafe.x1, wall.x));
  }

  private landingFitsWindow(
    landingX: number,
    landingY: number,
    landAnim: string,
  ): boolean {
    const pivot = this.pivotForDraw(landAnim);
    const safe = this.safeFootBounds(pivot);
    return (
      landingX >= safe.x0 &&
      landingX <= safe.x1 &&
      landingY >= safe.y0 &&
      landingY <= safe.y1
    );
  }

  private slideClipsReady(): boolean {
    const intro = this.habitat.animations[SLIDE_INTRO_ANIM];
    const grip = this.habitat.animations[SLIDE_GRIP_ANIM];
    const land = this.habitat.animations[SLIDE_LAND_ANIM];
    return Boolean(
      intro?.frames.length && grip?.frames.length && land?.frames.length,
    );
  }

  private resolveSlideWall(
    surfaces: SurfaceSeg[],
    sourceRaw: RawLedge,
    end: "left" | "right",
  ): SlideWall | null {
    const { w: clientW, h: clientH } = this.clientLocalSize();
    const endpointX = end === "right" ? sourceRaw.x1 : sourceRaw.x0;
    for (const candidate of this.collectUiaWalls(surfaces)) {
      if (Math.abs(candidate.x - endpointX) > WALL_HIT_PX) {
        continue;
      }
      if (candidate.yTop > sourceRaw.y + 4) {
        continue;
      }
      if (candidate.yBottom < sourceRaw.y + MIN_SLIDE_DROP_PX) {
        continue;
      }
      return candidate;
    }
    return this.syntheticWindowWalls(sourceRaw, end, clientW, clientH);
  }

  private routeForSlideDestination(
    wall: SlideWall,
    sourceRaw: RawLedge,
    dest: RawLedge,
    destDrawable: Ledge,
    end: "left" | "right",
    targetHwnd: number,
  ): DividerSlideRoute | null {
    const margin = this.footMarginLocal();
    const landingY = destDrawable.y;
    const landingX = Math.max(
      destDrawable.x0 + margin,
      Math.min(
        destDrawable.x1 - margin,
        wall.windowEdge === "right"
          ? destDrawable.x1 - margin
          : wall.windowEdge === "left"
            ? destDrawable.x0 + margin
            : wall.x,
      ),
    );
    if (!this.landingFitsWindow(landingX, landingY, SLIDE_LAND_ANIM)) {
      return null;
    }
    const gripX = this.drawableGripX(wall);
    const gripSafe = this.safeFootBounds(this.pivotForDraw(SLIDE_GRIP_ANIM));
    if (gripX < gripSafe.x0 || gripX > gripSafe.x1) {
      return null;
    }
    const gripYStart = this.gripYFromFoot(
      sourceRaw.y,
      this.viewSy,
      this.viewScale,
    );
    const gripYEnd = this.gripYFromFoot(landingY, this.viewSy, this.viewScale);
    if (gripYEnd <= gripYStart + 4) {
      return null;
    }
    return {
      targetHwnd,
      wallId: wall.id,
      destSurfaceId: dest.id,
      sourceSurfaceId: sourceRaw.id,
      end,
      gripX,
      landingX,
      landingY,
    };
  }

  private findDividerSlideRoute(
    surfaces: SurfaceSeg[],
    sourceRaw: RawLedge,
    end: "left" | "right",
    targetHwnd: number,
    drawableLedges: Ledge[],
  ): DividerSlideRoute | null {
    if (!this.slideClipsReady()) {
      return null;
    }
    const wall = this.resolveSlideWall(surfaces, sourceRaw, end);
    if (!wall) {
      return null;
    }
    const { w: clientW } = this.clientLocalSize();
    const margin = this.footMarginLocal();
    const below = this.collectRawWalkableHorizontals(surfaces)
      .filter(
        (l) =>
          l.id !== sourceRaw.id &&
          l.y > sourceRaw.y + MIN_SLIDE_DROP_PX - 2 &&
          wall.yBottom >= l.y - 4,
      )
      .sort((a, b) => a.y - b.y);
    for (const candidate of below) {
      if (wall.windowEdge === "right") {
        if (candidate.x1 < clientW - WINDOW_EDGE_HIT_PX) {
          continue;
        }
      } else if (wall.windowEdge === "left") {
        if (candidate.x0 > WINDOW_EDGE_HIT_PX) {
          continue;
        }
      } else if (
        wall.x < candidate.x0 - margin ||
        wall.x > candidate.x1 + margin
      ) {
        continue;
      }
      const destDrawable = drawableLedges.find((l) => l.id === candidate.id);
      if (!destDrawable) {
        continue;
      }
      const route = this.routeForSlideDestination(
        wall,
        sourceRaw,
        candidate,
        destDrawable,
        end,
        targetHwnd,
      );
      if (route) {
        return route;
      }
    }
    return null;
  }

  private tryBeginDividerSlideAtEndpoint(
    surfaces: SurfaceSeg[],
    ledges: Ledge[],
    end: "left" | "right",
    meta: GeometryMeta,
    geometryStale: boolean,
  ): boolean {
    if (
      this.dividerSlidePhase !== "awake" ||
      this.portalPhase !== "awake" ||
      this.sleepPhase !== "awake"
    ) {
      return false;
    }
    if (geometryStale && meta.surfaceSource !== "file") {
      return false;
    }
    const sourceDrawable = this.ledgeFromAttachment(ledges);
    if (!sourceDrawable) {
      return false;
    }
    const rawLedges = this.collectRawWalkableHorizontals(surfaces);
    const raw = rawLedges.find((l) => l.id === sourceDrawable.id);
    if (!raw) {
      return false;
    }
    const route = this.findDividerSlideRoute(
      surfaces,
      raw,
      end,
      meta.targetHwnd,
      ledges,
    );
    if (!route || Math.random() >= 0.5) {
      return false;
    }
    this.clearSegmentedPlay();
    this.slideRoute = route;
    this.dividerSlidePhase = "intro";
    this.activityId = SLIDE_ACTIVITY_ID;
    this.animationKey = SLIDE_INTRO_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.activityMsLeft = Math.max(this.activityMsLeft, 60_000);
    return true;
  }

  private refreshDividerSlideRoute(
    surfaces: SurfaceSeg[],
    ledges: Ledge[],
    meta: GeometryMeta,
    geometryStale: boolean,
  ): boolean {
    const route = this.slideRoute;
    if (!route) {
      return false;
    }
    if (route.targetHwnd !== 0 && meta.targetHwnd !== route.targetHwnd) {
      return false;
    }
    if (geometryStale && meta.surfaceSource !== "file") {
      return false;
    }
    const raw = this.collectRawWalkableHorizontals(surfaces).find(
      (l) => l.id === route.sourceSurfaceId,
    );
    if (!raw) {
      return false;
    }
    const refreshed = this.findDividerSlideRoute(
      surfaces,
      raw,
      route.end,
      meta.targetHwnd,
      ledges,
    );
    if (
      !refreshed ||
      refreshed.destSurfaceId !== route.destSurfaceId ||
      refreshed.wallId !== route.wallId
    ) {
      return false;
    }
    this.slideRoute = refreshed;
    return ledges.some((l) => l.id === refreshed.destSurfaceId);
  }

  private tickDividerSlide(
    dtMs: number,
    dt: number,
    surfaces: SurfaceSeg[],
    ledges: Ledge[],
    meta: GeometryMeta,
    geometryStale: boolean,
    sy: number,
    scale: number,
  ): void {
    if (!this.refreshDividerSlideRoute(surfaces, ledges, meta, geometryStale)) {
      this.abortDividerSlide();
      return;
    }
    if (this.dividerSlidePhase === "descend") {
      this.tickDividerSlideDescend(dtMs, dt, sy, scale, ledges);
    }
  }

  private beginDividerSlideDescend(sx: number, sy: number, scale: number): void {
    const route = this.slideRoute;
    if (!route) {
      return;
    }
    const footY = this.localY;
    this.localX = route.gripX;
    this.localY = this.gripYFromFoot(footY, sy, scale);
    this.shiftAnchorPivot(SLIDE_INTRO_ANIM, SLIDE_GRIP_ANIM, sx, sy, scale);
    this.dividerSlidePhase = "descend";
    this.motionPhase = "slide";
    this.animationKey = SLIDE_GRIP_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.attachment = null;
  }

  private tickDividerSlideDescend(
    dtMs: number,
    dt: number,
    sy: number,
    scale: number,
    ledges: Ledge[],
  ): void {
    const route = this.slideRoute;
    if (!route) {
      return;
    }
    const footY = this.slideFootYFromGrip(this.localY, sy, scale);
    if (footY >= route.landingY - 2) {
      this.beginDividerSlideLand(ledges, sy, scale);
      return;
    }
    const gripAnim = this.habitat.animations[SLIDE_GRIP_ANIM];
    const loopFrames = gripAnim?.frames.length ?? 0;
    const fps = gripAnim?.fps ?? 10;
    if (loopFrames > 0) {
      this.frameAccumulator += dtMs;
      const frameDuration = 1000 / fps;
      while (this.frameAccumulator >= frameDuration) {
        this.frameAccumulator -= frameDuration;
        this.frameIndex = (this.frameIndex + 1) % loopFrames;
      }
    }
    const nextFootY = Math.min(
      route.landingY,
      footY + SLIDE_DESCEND_PX_PER_SEC * dt,
    );
    this.localY = this.gripYFromFoot(nextFootY, sy, scale);
    this.localX = route.gripX;
  }

  private beginDividerSlideLand(
    ledges: Ledge[],
    sy: number,
    scale: number,
  ): void {
    const route = this.slideRoute;
    const dest = ledges.find((l) => l.id === route?.destSurfaceId);
    if (!route || !dest) {
      this.abortDividerSlide();
      return;
    }
    this.localY = this.gripYFromFoot(route.landingY, sy, scale);
    this.localX = route.gripX;
    this.shiftAnchorPivot(
      SLIDE_GRIP_ANIM,
      SLIDE_LAND_ANIM,
      this.viewSx,
      sy,
      scale,
    );
    this.localX = route.landingX;
    this.localY = route.landingY;
    this.attachToLedgePreserveFoot(dest);
    this.syncedSupportLedgeY = route.landingY;
    this.vyLocal = 0;
    this.dividerSlidePhase = "land";
    this.motionPhase = "grounded";
    this.animationKey = SLIDE_LAND_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  private finishDividerSlide(): void {
    this.dividerSlidePhase = "awake";
    this.slideRoute = null;
    const act = this.habitat.activities.walk;
    if (act?.travel) {
      this.activityId = "walk";
      this.animationKey = act.animation ?? "walk";
      this.resetWalkCyclePhase();
      this.activityMsLeft = this.randMs(act);
    } else {
      this.startIdle();
    }
  }

  private clearDividerSlideState(convertGripPivot: boolean): void {
    if (this.dividerSlidePhase === "awake") {
      return;
    }
    if (
      convertGripPivot &&
      (this.dividerSlidePhase === "descend" || this.motionPhase === "slide")
    ) {
      this.shiftAnchorPivot(
        SLIDE_GRIP_ANIM,
        SLIDE_INTRO_ANIM,
        this.viewSx,
        this.viewSy,
        this.viewScale,
      );
    }
    this.dividerSlidePhase = "awake";
    this.slideRoute = null;
  }

  private abortDividerSlide(): void {
    this.clearDividerSlideState(true);
    this.beginFall(false, true);
  }

  private collectLedges(surfaces: SurfaceSeg[]): Ledge[] {
    const out: Ledge[] = [];
    const [px, py] = this.habitat.pivot;
    const safe = this.safeFootBounds([px, py]);
    const mirrored = this.safeFootBounds([this.habitat.grid.frameSize[0] - px, py]);
    const margin = this.footMarginLocal();
    for (const s of surfaces) {
      if (!s.walkable || s.role === "wall") continue;
      const dy = Math.abs(s.a.y - s.b.y);
      const dx = Math.abs(s.b.x - s.a.x);
      if (dy >= 2 || dx <= 80) continue;
      // Existing travel/portal/pounce callers inset by footMarginLocal themselves.
      const x0 = Math.max(
        Math.min(s.a.x, s.b.x),
        Math.max(safe.x0, mirrored.x0) - margin,
      );
      const x1 = Math.min(
        Math.max(s.a.x, s.b.x),
        Math.min(safe.x1, mirrored.x1) + margin,
      );
      const y = (s.a.y + s.b.y) / 2;
      if (x1 - x0 < 2 * margin || y < safe.y0) continue;
      out.push({
        id: s.id,
        role: s.role,
        x0,
        x1,
        y: Math.min(y, safe.y1),
        length: x1 - x0,
        confidence: s.confidence ?? 0.5,
      });
    }
    return out;
  }

  private scoreLedge(l: Ledge): number {
    let score = Math.min(l.length, 600);
    score += l.confidence * 120;
    if (l.id.includes("tab-strip")) score += 450;
    if (l.role === "ledge" && !l.id.includes("statusbar")) score += 180;
    if (l.id.includes("explorer")) score += 80;
    if (l.id.includes("statusbar")) score += 40;
    return score;
  }

  private spawnOnBestLedge(ledges: Ledge[]) {
    const sorted = [...ledges].sort((a, b) => this.scoreLedge(b) - this.scoreLedge(a));
    const pick = sorted[0];
    if (!pick) return;
    this.attachTo(pick, 0.5);
  }

  private attachTo(ledge: Ledge, t: number) {
    const clamped = Math.max(0.05, Math.min(0.95, t));
    this.attachment = { kind: "ledge", surfaceId: ledge.id, t: clamped };
    this.localX = ledge.x0 + (ledge.x1 - ledge.x0) * clamped;
    this.localY = ledge.y;
    this.syncedSupportLedgeY = ledge.y;
    this.vyLocal = 0;
  }

  /** Portal exits use the foot margin instead of `attachTo`'s fractional inset. */
  private attachToLedgeEndpoint(ledge: Ledge, end: "left" | "right"): void {
    const margin = this.footMarginLocal();
    const x = end === "left" ? ledge.x0 + margin : ledge.x1 - margin;
    const t = (x - ledge.x0) / ledge.length;
    this.attachment = { kind: "ledge", surfaceId: ledge.id, t };
    this.localX = x;
    this.localY = ledge.y;
    this.syncedSupportLedgeY = ledge.y;
    this.vyLocal = 0;
  }

  private portalHwndMismatch(meta: GeometryMeta): boolean {
    if (this.portalTargetHwnd === 0 || meta.targetHwnd === 0) {
      return false;
    }
    return meta.targetHwnd !== this.portalTargetHwnd;
  }

  private portalHandoffGeometryReady(
    meta: GeometryMeta,
    geometryStale: boolean,
  ): boolean {
    if (this.awaitGeometryMs > 0) {
      return false;
    }
    if (meta.surfaceSource === "file") {
      return true;
    }
    return !geometryStale;
  }

  private tickPortalSafety(meta: GeometryMeta, geometryStale: boolean): void {
    if (
      this.portalHwndMismatch(meta) ||
      (meta.surfaceSource !== "file" &&
        geometryStale &&
        this.portalPhase !== "opening")
    ) {
      this.finishPortal();
    }
  }

  /** Open anywhere along the current walk; exit still uses `attachToLedgeEndpoint` on another ledge. */
  private tryBeginPortal(
    dtMs: number,
    ledges: Ledge[],
    meta: GeometryMeta,
    geometryStale: boolean,
  ): void {
    if (this.dividerSlidePhase !== "awake") {
      return;
    }
    if (
      Date.now() < this.portalCooldownUntilMs ||
      !this.portalHandoffGeometryReady(meta, geometryStale)
    ) {
      return;
    }
    const open = this.habitat.animations[PORTAL_OPEN_ANIM];
    const exit = this.habitat.animations[PORTAL_EXIT_ANIM];
    if (!open?.frames.length || open.loop || !exit?.frames.length || exit.loop) {
      return;
    }
    const ledge = this.ledgeFromAttachment(ledges);
    if (!ledge || !ledges.some((other) => other.id !== ledge.id)) {
      return;
    }
    // Preserve the same probability per second across different render frame rates.
    const chance = 1 - (1 - PORTAL_CHANCE_PER_SECOND) ** (dtMs / 1000);
    if (Math.random() >= chance) {
      return;
    }
    this.beginPortalOpen(meta);
  }

  private beginPortalOpen(meta: GeometryMeta): void {
    this.clearAnnoyedPlayback();
    this.clearSegmentedPlay();
    this.portalPhase = "opening";
    this.portalTargetHwnd = meta.targetHwnd;
    this.activityId = "portal";
    this.animationKey = PORTAL_OPEN_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  /** Keep `localX` on the ledge from stored attachment `t` (portal open / normal grounded). */
  private syncAttachmentFromLedgeT(ledge: Ledge): void {
    const span = ledge.x1 - ledge.x0;
    const t =
      this.attachment?.kind === "ledge" ? this.attachment.t : 0.5;
    this.localX = ledge.x0 + span * t;
    this.localY = ledge.y;
  }

  private pickRandomOtherLedge(ledges: Ledge[], excludeId: string): Ledge | null {
    const pool = ledges.filter((l) => l.id !== excludeId);
    if (!pool.length) {
      return null;
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  private tryCompletePortalHandoff(
    ledges: Ledge[],
    meta: GeometryMeta,
    geometryStale: boolean,
  ): void {
    if (this.portalPhase !== "pending_handoff") {
      return;
    }
    if (!this.portalHandoffGeometryReady(meta, geometryStale)) {
      return;
    }
    const source = this.ledgeFromAttachment(ledges);
    const dest = source && this.pickRandomOtherLedge(ledges, source.id);
    if (!dest) {
      this.finishPortal();
      return;
    }
    this.portalExitEnd = Math.random() < 0.5 ? "left" : "right";
    this.facingLeft = this.portalExitEnd === "right";
    this.attachToLedgeEndpoint(dest, this.portalExitEnd);
    this.animationKey = PORTAL_EXIT_ANIM;
    this.portalPhase = "exiting";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  private finishPortal(): void {
    if (this.portalPhase === "awake") {
      return;
    }
    this.portalPhase = "awake";
    this.portalTargetHwnd = 0;
    this.portalCooldownUntilMs = Date.now() + PORTAL_COOLDOWN_MS;
    this.startIdle();
  }

  private writeAttachmentT(ledge: Ledge) {
    if (this.attachment?.kind !== "ledge" || this.attachment.surfaceId !== ledge.id) {
      return;
    }
    const span = ledge.x1 - ledge.x0;
    if (span <= 1) return;
    this.attachment.t = (this.localX - ledge.x0) / span;
    this.localY = ledge.y;
  }

  private ledgeFromAttachment(ledges: Ledge[]): Ledge | null {
    if (this.attachment?.kind !== "ledge") {
      return null;
    }
    const id = this.attachment.surfaceId;
    return ledges.find((l) => l.id === id) ?? null;
  }

  private syncGroundedAttachment(
    ledges: Ledge[],
    sashTracks: TrackedSash[],
    sy: number,
    scale: number,
  ) {
    const ledge = this.ledgeFromAttachment(ledges);
    if (!ledge) {
      this.finishPortal();
      if (this.attachment && this.motionPhase !== "await_geometry") {
        this.beginFall();
      } else if (!this.attachment && this.awaitGeometryMs <= 0) {
        this.spawnOnBestLedge(ledges);
      }
      return;
    }

    if (this.shouldDetachForDownwardSupport(ledges, sashTracks, sy, scale)) {
      this.beginFallFromSupportDrop(ledge.id);
      return;
    }

    if (this.portalPhase === "exiting") {
      this.attachToLedgeEndpoint(ledge, this.portalExitEnd);
    } else {
      this.syncAttachmentFromLedgeT(ledge);
    }
    this.syncedSupportLedgeY = ledge.y;

    if (this.motionPhase === "await_geometry") {
      return;
    }

    this.motionPhase = "grounded";
  }

  private beginFallFromSupportDrop(ignoreLedgeId: string | null): void {
    if (this.motionPhase === "falling") {
      return;
    }
    this.fallIgnoreLedgeId = ignoreLedgeId;
    this.syncedSupportLedgeY = null;
    this.awaitGeometryMs = 0;
    this.beginFall(false);
    this.fallPrevY = this.localY;
  }

  private beginFall(clearDepartingLedgeIgnore = true, skipDividerSlideClear = false) {
    if (this.motionPhase === "carried") {
      this.beginCarryDrop();
      return;
    }
    if (clearDepartingLedgeIgnore) {
      this.fallIgnoreLedgeId = null;
    }
    if (!skipDividerSlideClear) {
      this.clearDividerSlideState(true);
    }
    this.resetPointerReactionState();
    this.clearAnnoyedPlayback();
    this.clearSegmentedPlay();
    this.clearSitLookState();
    this.finishPortal();
    this.cancelTurn();
    this.clingSubPhase = null;
    this.motionPhase = "falling";
    this.fallPhase = "airborne";
    this.vyLocal = 0;
    this.attachment = null;
    this.activityId = "idle";
    this.animationKey = FALL_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    if (this.sleepPhase !== "awake") {
      this.clearSleepSequence();
    }
  }

  private fallAirHoldFrameIndex(): number {
    const anim = this.habitat.animations[FALL_ANIM];
    if (!anim?.frames.length) {
      return 0;
    }
    let hold = 0;
    for (let i = 0; i < anim.frames.length; i += 1) {
      if (anim.frames[i] <= FALL_AIR_LAST_CELL) {
        hold = i;
      }
    }
    return hold;
  }

  private fallLandStartFrameIndex(): number {
    const anim = this.habitat.animations[FALL_ANIM];
    if (!anim?.frames.length) {
      return 0;
    }
    const idx = anim.frames.indexOf(FALL_LAND_FIRST_CELL);
    return idx >= 0 ? idx : this.fallAirHoldFrameIndex() + 1;
  }

  private tickFallAnimation(dtMs: number) {
    if (this.fallPhase === null) {
      return;
    }
    if (this.fallFromCarry) {
      this.tickCarryReleaseFallAnimation(dtMs);
      return;
    }
    const anim = this.habitat.animations[FALL_ANIM];
    if (!anim?.frames.length) {
      return;
    }
    const airHoldIdx = this.fallAirHoldFrameIndex();
    this.frameAccumulator += dtMs;
    const frameDuration = 1000 / (anim.fps || 12);
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      if (this.fallPhase === "airborne") {
        if (this.frameIndex < airHoldIdx) {
          this.frameIndex += 1;
        }
        break;
      }
      if (this.fallPhase === "land") {
        if (this.frameIndex + 1 < anim.frames.length) {
          this.frameIndex += 1;
          continue;
        }
        this.completeFallLanding();
        break;
      }
      break;
    }
  }

  private completeFallLanding() {
    const fromCarry = this.fallFromCarry;
    this.fallPhase = null;
    this.fallIgnoreLedgeId = null;
    this.fallFromCarry = false;
    this.carryFacingLocked = null;
    this.motionPhase = "grounded";
    if (fromCarry) {
      this.pointerComboRearm = true;
    }
    this.startIdle();
  }

  private onFallLedgeContact(ledge: Ledge) {
    this.localY = ledge.y;
    this.attachToLedgePreserveFoot(ledge);
    this.syncedSupportLedgeY = ledge.y;
    this.fallPhase = "land";
    if (this.fallFromCarry) {
      const release = this.habitat.animations[CARRIED_RELEASE_ANIM];
      const landStart = Math.min(
        CARRY_RELEASE_LAND_FRAME_INDEX,
        (release?.frames.length ?? 1) - 1,
      );
      this.frameIndex = Math.max(this.frameIndex, landStart);
      this.animationKey = CARRIED_RELEASE_ANIM;
    } else {
      this.frameIndex = this.fallLandStartFrameIndex();
      this.animationKey = FALL_ANIM;
    }
    this.frameAccumulator = 0;
    this.vyLocal = 0;
  }

  private stepFall(ledges: Ledge[], dt: number) {
    if (this.fallPhase === "land") {
      if (this.ledgeFromAttachment(ledges)) {
        return;
      }
      this.attachment = null;
      this.fallPhase = "airborne";
      if (this.fallFromCarry) {
        this.frameIndex = 0;
        this.animationKey = CARRIED_RELEASE_ANIM;
        return;
      }
      this.frameIndex = this.fallAirHoldFrameIndex();
      this.animationKey = FALL_ANIM;
    }

    this.fallPrevY = this.localY;
    this.vyLocal += GRAVITY_LOCAL * dt;
    this.localY += this.vyLocal * dt;

    const land =
      this.findLandingLedgeCrossing(ledges, this.localX, this.fallPrevY, this.localY) ??
      (this.fallFromCarry
        ? this.highestWalkableLedgeUnderFoot(
            ledges,
            CARRIED_RELEASE_ANIM,
            8,
          )
        : this.highestWalkableLedgeUnderFoot(ledges, FALL_ANIM, 0));
    if (land) {
      this.onFallLedgeContact(land);
    }
  }

  /**
   * Pin to the highest walkable ledge under `localX` when the foot is at the window bottom
   * (`bottomInsetPx` lets carry drops engage slightly before the hard clamp).
   */
  private highestWalkableLedgeUnderFoot(
    ledges: Ledge[],
    pivotAnim: string,
    bottomInsetPx: number,
  ): Ledge | null {
    const safe = this.safeFootBounds(this.pivotForDraw(pivotAnim));
    if (this.localY < safe.y1 - bottomInsetPx) {
      return null;
    }
    const margin = this.footMarginLocal();
    const under = ledges.filter(
      (l) =>
        this.localX >= l.x0 - margin &&
        this.localX <= l.x1 + margin,
    );
    return under.sort((a, b) => b.y - a.y)[0] ?? null;
  }

  private findLandingLedgeCrossing(
    ledges: Ledge[],
    x: number,
    y0: number,
    y1: number,
  ): Ledge | null {
    const margin = this.footMarginLocal();
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const candidates = ledges
      .filter(
        (l) =>
          x >= l.x0 - margin &&
          x <= l.x1 + margin &&
          l.y > top - 2 &&
          l.y <= bottom + 4 &&
          !(
            this.fallIgnoreLedgeId &&
            l.id === this.fallIgnoreLedgeId &&
            this.localY < l.y + FALL_IGNORE_LEDGE_CLEARANCE_PX
          ),
      )
      .sort((a, b) => a.y - b.y);
    return candidates[0] ?? null;
  }

  private validateCarryInputSample(
    pointer: IdeLocalPointer | null,
    meta: GeometryMeta,
  ): IdeLocalPointer | null {
    if (!pointer) {
      return null;
    }
    const age = Date.now() - pointer.observedAtMs;
    if (age > POINTER_SAMPLE_MAX_AGE_MS) {
      return null;
    }
    if (meta.targetHwnd === 0) {
      return null;
    }
    if (
      pointer.targetHwnd !== 0 &&
      meta.targetHwnd !== pointer.targetHwnd
    ) {
      return null;
    }
    return pointer;
  }

  private tickCarryInput(
    sample: IdeLocalPointer | null,
    meta: GeometryMeta,
    dtMs: number,
  ): void {
    const input = this.validateCarryInputSample(sample, meta);
    if (!input) {
      if (this.motionPhase === "carried") {
        this.carryInputStaleMs += dtMs;
        if (this.carryInputStaleMs >= CARRY_INPUT_LOSS_MS) {
          this.abortCarryInterrupted();
        }
      } else if (this.carryInputPhase === "hold_pending") {
        this.carryInputPhase = "disarmed";
        this.carryHoldStartedAtMs = null;
      }
      return;
    }
    this.carryInputStaleMs = 0;

    if (
      this.motionPhase === "carried" &&
      this.carryOwnerHwnd !== 0 &&
      input.targetHwnd !== this.carryOwnerHwnd
    ) {
      this.abortCarryInterrupted();
      return;
    }

    const coords = idePointerCoords(input);
    const inReach =
      coords != null &&
      this.pointInReach(coords.x, coords.y, this.pointerReachBoxLocal());
    const carryActive = this.motionPhase === "carried";
    const transition = stepCarryInputTransition(
      this.carryInputPhase,
      this.carryHoldStartedAtMs,
      input.primaryButtonDown,
      inReach,
      input.observedAtMs,
      carryActive,
    );
    this.carryInputPhase = transition.phase;
    this.carryHoldStartedAtMs = transition.holdStartedAtMs;
    if (transition.endCarry) {
      this.beginCarryDrop();
      return;
    }
    if (transition.beginCarry && this.motionPhase !== "carried") {
      this.beginCarry(meta);
    }
  }

  private clearCarryDropPlaybackState(): void {
    this.fallFromCarry = false;
    this.carrySubPhase = null;
    this.carryFacingLocked = null;
    this.carryOwnerHwnd = 0;
    this.resetCarrySwing();
  }

  /** Clears drag swing so release/fall draw is upright (`draw-pet.ts` reads `swingDeg`). */
  private resetCarrySwing(): void {
    this.carrySwingDeg = 0;
    this.carrySwingTargetDeg = 0;
    this.carrySwingSample = null;
  }

  /** Input loss / HWND cancel — not a deliberate user drop. */
  private abortCarryInterrupted(): void {
    this.carryInputPhase = "disarmed";
    this.carryHoldStartedAtMs = null;
    this.carryInputStaleMs = 0;
    if (this.motionPhase !== "carried") {
      return;
    }
    const sx = this.viewSx;
    const sy = this.viewSy;
    const scale = this.viewScale;
    if (this.carrySubPhase === "held") {
      this.shiftAnchorPivot(CARRIED_HOLD_ANIM, FALL_ANIM, sx, sy, scale);
    }
    this.clearCarryDropPlaybackState();
    this.motionPhase = "grounded";
    this.beginFall(false, true);
  }

  private beginCarry(meta: GeometryMeta): void {
    this.cancelPointerReactionPlayback();
    this.clearAnnoyedPlayback();
    if (this.sleepPhase !== "awake") {
      this.clearSleepSequence();
    }
    this.finishPortal();
    this.cancelTurn();
    this.clearDividerSlideState(true);
    this.clearSegmentedPlay();
    this.clearSitLookState();

    this.carryFacingLocked = this.facingLeft;
    this.carryOwnerHwnd = meta.targetHwnd;
    this.pointerComboRearm = true;
    this.motionPhase = "carried";
    this.carrySubPhase = "pickup";
    this.activityId = CARRY_ACTIVITY_ID;
    this.animationKey = CARRIED_PICKUP_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.attachment = null;
    this.awaitGeometryMs = 0;
    this.syncedSupportLedgeY = null;
    this.resetCarrySwing();
  }

  private tickCarried(
    dtMs: number,
    input: IdeLocalPointer | null,
    sx: number,
    sy: number,
    scale: number,
  ): void {
    if (this.carrySubPhase === "pickup") {
      this.advanceCarriedPickup(dtMs, sx, sy, scale, input);
    } else if (this.carrySubPhase === "held") {
      this.syncCarryGripToPointer(input);
      this.tickCarrySwing(dtMs, input);
      this.advanceHostAnimationFrames(dtMs);
    }
  }

  /** Sample cursor speed at poll cadence, then ease the tilt on the animation clock. */
  private tickCarrySwing(dtMs: number, input: IdeLocalPointer | null): void {
    if (dtMs <= 0) {
      return;
    }
    if (!input || input.x == null || input.y == null) {
      this.carrySwingSample = null;
      this.carrySwingTargetDeg = 0;
    } else {
      const previous = this.carrySwingSample;
      if (!previous || input.observedAtMs > previous.observedAtMs) {
        if (previous) {
          const vx = ((input.x - previous.x) * 1000) /
            (input.observedAtMs - previous.observedAtMs);
          // SVG rotates after mirroring, so drag direction is independent of facing.
          this.carrySwingTargetDeg = Math.max(
            -CARRY_SWING_MAX_DEG,
            Math.min(CARRY_SWING_MAX_DEG, vx * CARRY_SWING_VEL_TO_DEG),
          );
        }
        this.carrySwingSample = { x: input.x, observedAtMs: input.observedAtMs };
      }
    }
    const alpha = 1 - Math.exp((-CARRY_SWING_SMOOTH_PER_SEC * dtMs) / 1000);
    this.carrySwingDeg += (this.carrySwingTargetDeg - this.carrySwingDeg) * alpha;
  }

  private advanceCarriedPickup(
    dtMs: number,
    sx: number,
    sy: number,
    scale: number,
    input: IdeLocalPointer | null,
  ): void {
    const anim = this.habitat.animations[CARRIED_PICKUP_ANIM];
    if (!anim?.frames.length) {
      this.enterCarriedHeld(sx, sy, scale, input);
      return;
    }
    this.frameAccumulator += dtMs;
    const frameDuration = 1000 / (anim.fps || 12);
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      if (this.frameIndex + 1 < anim.frames.length) {
        this.frameIndex += 1;
      } else {
        this.enterCarriedHeld(sx, sy, scale, input);
        break;
      }
    }
  }

  private enterCarriedHeld(
    sx: number,
    sy: number,
    scale: number,
    input: IdeLocalPointer | null,
  ): void {
    if (this.carrySubPhase === "held") {
      return;
    }
    this.shiftAnchorPivot(
      CARRIED_PICKUP_ANIM,
      CARRIED_HOLD_ANIM,
      sx,
      sy,
      scale,
    );
    this.carrySubPhase = "held";
    this.animationKey = CARRIED_HOLD_ANIM;
    const holdAnim = this.habitat.animations[CARRIED_HOLD_ANIM];
    const pickupFrames =
      this.habitat.animations[CARRIED_PICKUP_ANIM]?.frames ?? [];
    const pickupEndCell = pickupFrames[pickupFrames.length - 1];
    const holdFrames = holdAnim?.frames ?? [];
    let holdStart =
      pickupEndCell !== undefined
        ? holdFrames.indexOf(pickupEndCell)
        : -1;
    // Pickup may end on sheet cell 11 (authoring label 12); hold wiggle peaks at 10 (label 11).
    if (holdStart < 0 && holdFrames.length > 0) {
      const peakCell = Math.max(...holdFrames);
      holdStart = holdFrames.indexOf(peakCell);
    }
    this.frameIndex = holdStart >= 0 ? holdStart : 0;
    this.frameAccumulator = 0;
    this.syncCarryGripToPointer(input);
  }

  /** Grip pivot anchor tracks the cursor in IDE-local space (`pivotForDraw` subtracts cell offset). */
  private syncCarryGripToPointer(input: IdeLocalPointer | null): void {
    const coords = idePointerCoords(input);
    if (!coords) {
      return;
    }
    this.localX = coords.x;
    this.localY = coords.y;
  }

  private beginCarryDrop(): void {
    this.resetCarrySwing();
    if (this.motionPhase === "carried") {
      const fromAnim =
        this.carrySubPhase === "held"
          ? CARRIED_HOLD_ANIM
          : CARRIED_PICKUP_ANIM;
      this.shiftAnchorPivot(
        fromAnim,
        CARRIED_RELEASE_ANIM,
        this.viewSx,
        this.viewSy,
        this.viewScale,
      );
    }
    this.carrySubPhase = null;
    this.motionPhase = "falling";
    this.fallPhase = "airborne";
    this.fallFromCarry = true;
    this.attachment = null;
    this.activityId = CARRY_ACTIVITY_ID;
    this.animationKey = CARRIED_RELEASE_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.vyLocal = 0;
    this.fallPrevY = this.localY;
    this.fallIgnoreLedgeId = null;
    this.carryInputPhase = "disarmed";
    this.carryHoldStartedAtMs = null;
  }

  private tickCarryReleaseFallAnimation(dtMs: number): void {
    const anim = this.habitat.animations[CARRIED_RELEASE_ANIM];
    if (!anim?.frames.length || this.fallPhase === null) {
      return;
    }
    this.frameAccumulator += dtMs;
    const frameDuration = 1000 / (anim.fps || 12);
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      if (this.fallPhase === "airborne") {
        break;
      }
      if (this.fallPhase === "land") {
        if (this.frameIndex + 1 < anim.frames.length) {
          this.frameIndex += 1;
          continue;
        }
        this.completeFallLanding();
        break;
      }
      break;
    }
  }

  private validatePointerSample(
    pointer: IdeLocalPointer | null,
    meta: GeometryMeta,
  ): IdeLocalPointerCoords | null {
    if (!pointer) {
      this.pointerRejectReason = "no_sample";
      this.lastValidatedPointerPos = null;
      return null;
    }
    if (pointer.x == null || pointer.y == null) {
      this.pointerRejectReason = "outside_ide";
      this.lastValidatedPointerPos = null;
      return null;
    }
    const age = Date.now() - pointer.observedAtMs;
    if (age > POINTER_SAMPLE_MAX_AGE_MS) {
      this.pointerRejectReason = "stale_sample";
      this.lastValidatedPointerPos = null;
      return null;
    }
    if (
      meta.targetHwnd !== 0 &&
      pointer.targetHwnd !== 0 &&
      meta.targetHwnd !== pointer.targetHwnd
    ) {
      this.pointerRejectReason = "hwnd_mismatch";
      this.lastValidatedPointerPos = null;
      this.cancelPointerReactionPlayback();
      return null;
    }
    if (
      this.lastValidatedPointerPos &&
      pointer.targetHwnd !== 0 &&
      this.lastValidatedPointerPos.targetHwnd !== 0 &&
      pointer.targetHwnd !== this.lastValidatedPointerPos.targetHwnd
    ) {
      this.lastValidatedPointerPos = null;
      this.cancelPointerReactionPlayback();
    }
    this.pointerRejectReason = null;
    return {
      x: pointer.x,
      y: pointer.y,
      primaryButtonDown: pointer.primaryButtonDown,
      targetHwnd: pointer.targetHwnd,
      observedAtMs: pointer.observedAtMs,
    };
  }

  /** Rearm annoyed + commit crossing history; run every tick after reach evaluation. */
  private tickPointerReachBookkeeping(pointer: IdeLocalPointerCoords | null): void {
    this.updatePointerAnnoyedRearm(pointer);
    this.updatePointerComboRearm(pointer);
    this.finalizePointerSample(pointer);
  }

  private updatePointerComboRearm(pointer: IdeLocalPointerCoords | null): void {
    if (!pointer) {
      return;
    }
    const reach = this.pointerReachBoxLocal();
    if (!this.pointInReach(pointer.x, pointer.y, reach)) {
      this.pointerComboRearm = true;
    }
  }

  private enforcePointerReactionOwner(meta: GeometryMeta): void {
    if (!this.swipePlayback && !this.pouncePlayback) {
      return;
    }
    const owner = this.pointerReactionOwnerHwnd;
    if (owner === 0 || meta.targetHwnd === 0) {
      return;
    }
    if (meta.targetHwnd !== owner) {
      this.cancelPointerReactionPlayback();
    }
  }

  private finalizePointerSample(pointer: IdeLocalPointerCoords | null): void {
    if (pointer) {
      this.lastValidatedPointerPos = {
        x: pointer.x,
        y: pointer.y,
        targetHwnd: pointer.targetHwnd,
      };
    }
  }

  private pointerEngagesReach(pointer: IdeLocalPointerCoords): boolean {
    return this.pointerHitsReach(pointer, this.pointerReachBoxLocal());
  }

  private updatePointerAnnoyedRearm(pointer: IdeLocalPointerCoords | null): void {
    if (!pointer) {
      return;
    }
    const reach = this.pointerReachBoxLocal();
    if (!this.pointInReach(pointer.x, pointer.y, reach)) {
      this.annoyedReachRearm = true;
    }
  }

  private pointerReachBoxLocal(): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } {
    const [fw, fh] = this.habitat.grid.frameSize;
    const [px, py] = this.habitat.pivot;
    let x0 = this.localX - px - POINTER_REACH_PAD_PX;
    let x1 = this.localX + (fw - px) + POINTER_REACH_PAD_PX;
    if (this.facingLeft) {
      x0 -= POINTER_PAW_REACH_PX;
    } else {
      x1 += POINTER_PAW_REACH_PX;
    }
    const y0 = this.localY - py - POINTER_REACH_PAD_PX;
    const y1 = this.localY + (fh - py) + POINTER_REACH_PAD_PX;
    return { x0, y0, x1, y1 };
  }

  /** Wider vertical band so diagonal batter exits can still count as left/right. */
  private pointerReachBoxForPounceExitClassify(): ReachBox {
    const reach = this.pointerReachBoxLocal();
    return {
      x0: reach.x0,
      x1: reach.x1,
      y0: reach.y0 - POUNCE_EXIT_CLASSIFY_PAD_ABOVE_PX,
      y1: reach.y1 + POUNCE_EXIT_CLASSIFY_PAD_BELOW_PX,
    };
  }

  private pointInReach(
    x: number,
    y: number,
    reach: { x0: number; y0: number; x1: number; y1: number },
  ): boolean {
    return x >= reach.x0 && x <= reach.x1 && y >= reach.y0 && y <= reach.y1;
  }

  private segmentIntersectsReach(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    reach: { x0: number; y0: number; x1: number; y1: number },
  ): boolean {
    if (this.pointInReach(x0, y0, reach) || this.pointInReach(x1, y1, reach)) {
      return true;
    }
    const edges: [number, number, number, number][] = [
      [reach.x0, reach.y0, reach.x1, reach.y0],
      [reach.x1, reach.y0, reach.x1, reach.y1],
      [reach.x1, reach.y1, reach.x0, reach.y1],
      [reach.x0, reach.y1, reach.x0, reach.y0],
    ];
    for (const [ax, ay, bx, by] of edges) {
      if (segmentsIntersect(x0, y0, x1, y1, ax, ay, bx, by)) {
        return true;
      }
    }
    return false;
  }

  private pointerHitsReach(
    pointer: IdeLocalPointerCoords,
    reach: { x0: number; y0: number; x1: number; y1: number },
  ): boolean {
    if (this.pointInReach(pointer.x, pointer.y, reach)) {
      return true;
    }
    const prev = this.lastValidatedPointerPos;
    if (!prev) {
      return false;
    }
    if (
      prev.targetHwnd !== 0 &&
      pointer.targetHwnd !== 0 &&
      prev.targetHwnd !== pointer.targetHwnd
    ) {
      return false;
    }
    return this.segmentIntersectsReach(
      prev.x,
      prev.y,
      pointer.x,
      pointer.y,
      reach,
    );
  }

  private applyPointerFacing(pointer: IdeLocalPointerCoords | null): void {
    if (!pointer || this.portalPhase !== "awake") {
      return;
    }
    if (this.dividerSlidePhase !== "awake") {
      return;
    }
    if (this.sleepPhase !== "awake") {
      return;
    }
    if (this.activityId === POINTER_POUNCE_ACTIVITY) {
      return;
    }
    if (this.activityId === SIT_LOOK_ACTIVITY_ID) {
      return;
    }
    if (
      this.motionPhase === "falling" ||
      this.motionPhase === "cling" ||
      this.motionPhase === "slide"
    ) {
      return;
    }
    // Only the current nearby position controls facing; past crossings are for swipes.
    if (!this.pointInReach(pointer.x, pointer.y, this.pointerReachBoxLocal())) {
      return;
    }
    this.syncFacingFromPointer(pointer);
  }

  /** Paw-reach facing for walk/swipe clips (not used during `noFlip` sit gaze). */
  private syncFacingFromPointer(pointer: IdeLocalPointerCoords): void {
    const dx = pointer.x - this.localX;
    if (dx < -POINTER_FACING_DEADBAND_PX) {
      this.facingLeft = true;
    } else if (dx > POINTER_FACING_DEADBAND_PX) {
      this.facingLeft = false;
    }
  }

  private tryPointerSwipe(pointer: IdeLocalPointerCoords | null, inTurn: boolean) {
    if (!pointer) {
      return;
    }
    if (isPointerReactionActivity(this.activityId)) {
      return;
    }
    const def = this.habitat.activities[POINTER_SWIPE_ACTIVITY];
    const animKey = def?.animation;
    if (!def || !animKey || !this.habitat.animations[animKey]) {
      return;
    }
    if (!this.pointerComboRearm) {
      return;
    }
    if (!this.pointerEngagesReach(pointer)) {
      return;
    }
    if (inTurn) {
      this.cancelTurn();
    }
    this.startPointerSwipe();
  }

  private tryPointerAnnoyed(pointer: IdeLocalPointerCoords | null): void {
    if (!pointer || this.annoyedPlayback || !this.annoyedReachRearm) {
      return;
    }
    const anim = this.habitat.animations[ANNOYED_ANIM];
    if (!anim?.frames.length || !anim.clip) {
      return;
    }
    if (!this.pointerEngagesReach(pointer)) {
      return;
    }
    this.beginAnnoyedPlayback();
  }

  private beginAnnoyedPlayback(): void {
    this.annoyedPlayback = { frameIndex: 0, frameAccumulator: 0 };
    this.annoyedReachRearm = false;
  }

  private clearAnnoyedPlayback(): void {
    this.annoyedPlayback = null;
    this.annoyedReachRearm = true;
  }

  private finishAnnoyedPlayback(): void {
    this.annoyedPlayback = null;
  }

  private advanceAnnoyedPlayback(dtMs: number): void {
    const ap = this.annoyedPlayback;
    if (!ap) {
      return;
    }
    const anim = this.habitat.animations[ANNOYED_ANIM];
    const n = anim?.frames.length ?? 0;
    if (!anim || n <= 0) {
      this.clearAnnoyedPlayback();
      return;
    }
    ap.frameAccumulator += dtMs;
    const frameDuration = 1000 / (anim.fps || 10);
    while (ap.frameAccumulator >= frameDuration) {
      ap.frameAccumulator -= frameDuration;
      if (ap.frameIndex + 1 < n) {
        ap.frameIndex += 1;
        continue;
      }
      this.finishAnnoyedPlayback();
      break;
    }
  }

  private startPointerSwipe(): void {
    const def = this.habitat.activities[POINTER_SWIPE_ACTIVITY];
    const animKey = def?.animation ?? "swipe";
    this.clearSegmentedPlay();
    this.clearSitLookState();
    this.clearAnnoyedPlayback();
    const pointer = this.frameValidatedPointer;
    this.swipePlayback = {
      phase: "intro",
      gridCell: SWIPE_INTRO_CELLS[0],
      frameAccumulator: 0,
      introIndex: 0,
      batterSeqIndex: 0,
      exitCells: [],
      exitIndex: 0,
      cursorInReach: true,
    };
    this.activityId = POINTER_SWIPE_ACTIVITY;
    this.animationKey = animKey;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.activityMsLeft = 60_000;
    this.pointerComboRearm = false;
    this.pointerReactionOwnerHwnd = pointer?.targetHwnd ?? 0;
    if (pointer) {
      this.syncFacingFromPointer(pointer);
    }
  }

  private syncSwipeCursorInReach(pointer: IdeLocalPointerCoords | null): void {
    if (!this.swipePlayback || this.activityId !== POINTER_SWIPE_ACTIVITY) {
      return;
    }
    const reach = this.pointerReachBoxLocal();
    const inReach = pointer
      ? this.pointInReach(pointer.x, pointer.y, reach)
      : false;
    this.swipePlayback.cursorInReach = inReach;
    if (pointer && inReach && this.swipePlayback.phase === "batter") {
      this.lastInReachPointer = {
        x: pointer.x,
        y: pointer.y,
        t: pointer.observedAtMs,
        targetHwnd: pointer.targetHwnd,
      };
    }
  }

  private updatePointerMotionSpeed(pointer: IdeLocalPointerCoords | null): void {
    if (!pointer) {
      this.pointerSpeedPxPerSec *= 0.85;
      return;
    }
    const reach = this.pointerReachBoxLocal();
    if (!this.pointInReach(pointer.x, pointer.y, reach)) {
      this.pointerSpeedPxPerSec *= 0.85;
      return;
    }
    const prev = this.lastPointerMotionSample;
    if (prev) {
      const dtMs = pointer.observedAtMs - prev.t;
      if (dtMs > 0 && dtMs < 600) {
        const dist = Math.hypot(pointer.x - prev.x, pointer.y - prev.y);
        const speed = (dist / dtMs) * 1000;
        this.pointerSpeedPxPerSec =
          this.pointerSpeedPxPerSec * 0.55 + speed * 0.45;
      }
    }
    this.lastPointerMotionSample = {
      x: pointer.x,
      y: pointer.y,
      t: pointer.observedAtMs,
    };
  }

  private swipeBatterFps(): number {
    const t = Math.min(
      1,
      this.pointerSpeedPxPerSec / SWIPE_BATTER_SPEED_FOR_MAX_FPS,
    );
    return (
      SWIPE_BATTER_FPS_MIN +
      t * (SWIPE_BATTER_FPS_MAX - SWIPE_BATTER_FPS_MIN)
    );
  }

  private swipeFrameDurationMs(phase: SwipePlaybackPhase): number {
    if (phase === "intro") {
      return SWIPE_INTRO_FRAME_MS;
    }
    if (phase === "exit") {
      return SWIPE_EXIT_FRAME_MS;
    }
    return 1000 / this.swipeBatterFps();
  }

  private beginSwipeExit(sp: ActiveSwipePlayback): void {
    const cells: number[] = [];
    for (let c = sp.gridCell + 1; c <= 15; c += 1) {
      cells.push(c);
    }
    if (cells.length === 0) {
      this.finishSwipePlayback();
      return;
    }
    sp.phase = "exit";
    sp.exitCells = cells;
    sp.exitIndex = 0;
    sp.gridCell = cells[0];
    sp.frameAccumulator = 0;
  }

  private finishSwipePlayback(): void {
    this.swipePlayback = null;
    this.startIdle();
  }

  private advanceSwipePlayback(dtMs: number): void {
    const sp = this.swipePlayback;
    if (!sp) {
      return;
    }
    const duration = this.swipeFrameDurationMs(sp.phase);
    sp.frameAccumulator += dtMs;
    if (sp.frameAccumulator < duration) {
      return;
    }
    sp.frameAccumulator -= duration;

    if (sp.phase === "intro") {
      if (sp.introIndex + 1 < SWIPE_INTRO_CELLS.length) {
        sp.introIndex += 1;
        sp.gridCell = SWIPE_INTRO_CELLS[sp.introIndex];
        return;
      }
      if (sp.cursorInReach) {
        sp.phase = "batter";
        sp.batterSeqIndex = swipeBatterSeqIndexForCell(sp.gridCell);
        sp.gridCell = SWIPE_BATTER_SEQ[sp.batterSeqIndex];
        sp.frameAccumulator = 0;
      } else {
        this.beginSwipeExit(sp);
      }
      return;
    }

    if (sp.phase === "batter") {
      if (!sp.cursorInReach) {
        return;
      }
      sp.batterSeqIndex =
        (sp.batterSeqIndex + 1) % SWIPE_BATTER_SEQ.length;
      sp.gridCell = SWIPE_BATTER_SEQ[sp.batterSeqIndex];
      return;
    }

    if (sp.exitIndex + 1 < sp.exitCells.length) {
      sp.exitIndex += 1;
      sp.gridCell = sp.exitCells[sp.exitIndex];
      return;
    }
    this.finishSwipePlayback();
  }

  private resetPointerReactionState(): void {
    this.swipePlayback = null;
    this.pouncePlayback = null;
    this.lastInReachPointer = null;
    this.pointerReactionOwnerHwnd = 0;
    this.resetPounceContinuationMotion();
    this.pounceWantsAnotherCycle = false;
    this.pounceDebugDestLocalX = null;
    this.pounceDebugReject = null;
  }

  private cancelPointerReactionPlayback(): void {
    const had =
      this.swipePlayback !== null ||
      this.pouncePlayback !== null ||
      isPointerReactionActivity(this.activityId);
    this.resetPointerReactionState();
    if (!had) {
      return;
    }
    this.activityId = "idle";
    this.animationKey = "idle";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.activityMsLeft = this.idleSlotDurationMs();
  }

  private pounceFrameDurationMs(): number {
    const anim = this.habitat.animations.pounce;
    const fps = anim?.fps ?? 12;
    return fps > 0 ? 1000 / fps : 1000 / 12;
  }

  private attachmentTOnLedge(ledge: Ledge, localX: number): number {
    const span = ledge.x1 - ledge.x0;
    if (span <= 1) {
      return 0.5;
    }
    return (localX - ledge.x0) / span;
  }

  private localXFromAttachmentT(ledge: Ledge, t: number): number {
    const span = ledge.x1 - ledge.x0;
    return ledge.x0 + t * span;
  }

  private remainingLedgeTravelPx(ledge: Ledge, directionLeft: boolean): number {
    const margin = this.footMarginLocal();
    const minX = ledge.x0 + margin;
    const maxX = ledge.x1 - margin;
    return directionLeft ? this.localX - minX : maxX - this.localX;
  }

  /** Clamp foot `localX` onto the ledge without reversing the committed pounce direction. */
  private pounceTargetT(
    ledge: Ledge,
    footTargetX: number,
    directionLeft: boolean,
  ): number {
    const margin = this.footMarginLocal();
    const directionalX = directionLeft
      ? Math.min(this.localX, footTargetX)
      : Math.max(this.localX, footTargetX);
    const targetX = Math.max(
      ledge.x0 + margin,
      Math.min(ledge.x1 - margin, directionalX),
    );
    return this.attachmentTOnLedge(ledge, targetX);
  }

  private tryBeginPounceFromSwipe(
    pointer: IdeLocalPointerCoords | null,
    ledges: Ledge[],
    geometryStale: boolean,
  ): void {
    const sp = this.swipePlayback;
    if (
      !sp ||
      sp.phase !== "batter" ||
      this.activityId !== POINTER_SWIPE_ACTIVITY
    ) {
      return;
    }
    this.pounceDebugReject = null;
    if (!pointer) {
      this.beginSwipeExit(sp);
      return;
    }
    if (
      this.motionPhase !== "grounded" ||
      this.portalPhase !== "awake" ||
      this.awaitGeometryMs > 0 ||
      geometryStale ||
      !this.groundedSupportStillValid(ledges)
    ) {
      this.pounceDebugReject = "geometry_gate";
      this.beginSwipeExit(sp);
      return;
    }
    const reach = this.pointerReachBoxLocal();
    if (this.pointInReach(pointer.x, pointer.y, reach)) {
      return;
    }
    const prev = this.lastInReachPointer;
    if (
      !prev ||
      (pointer.targetHwnd !== 0 &&
        prev.targetHwnd !== 0 &&
        pointer.targetHwnd !== prev.targetHwnd)
    ) {
      this.beginSwipeExit(sp);
      return;
    }
    const gap = pointer.observedAtMs - prev.t;
    if (gap > POUNCE_MOTION_GRACE_MS) {
      this.beginSwipeExit(sp);
      return;
    }
    const exit = classifyReachExit(
      prev.x,
      prev.y,
      pointer.x,
      pointer.y,
      this.pointerReachBoxForPounceExitClassify(),
    );
    if (exit !== "left" && exit !== "right") {
      this.beginSwipeExit(sp);
      return;
    }
    const directionLeft = exit === "left";
    const beyond = directionLeft
      ? pointer.x < reach.x0 - POUNCE_EXIT_HYSTERESIS_PX
      : pointer.x > reach.x1 + POUNCE_EXIT_HYSTERESIS_PX;
    if (!beyond) {
      return;
    }
    const ledge = this.ledgeFromAttachment(ledges);
    if (
      !ledge ||
      this.remainingLedgeTravelPx(ledge, directionLeft) <
        POUNCE_MIN_LEDGE_TRAVEL_PX
    ) {
      this.beginSwipeExit(sp);
      return;
    }
    this.startPointerPounce(directionLeft, ledge, pointer);
  }

  private startPointerPounce(
    directionLeft: boolean,
    ledge: Ledge,
    pointer: IdeLocalPointerCoords,
  ): void {
    const def = this.habitat.activities[POINTER_POUNCE_ACTIVITY];
    const animKey = def?.animation ?? "pounce";
    if (!def || !this.habitat.animations[animKey]) {
      if (this.swipePlayback) {
        this.beginSwipeExit(this.swipePlayback);
      }
      return;
    }
    this.facingLeft = directionLeft;
    this.clearSegmentedPlay();
    this.clearAnnoyedPlayback();
    this.swipePlayback = null;
    this.resetPounceContinuationMotion();
    this.pounceWantsAnotherCycle = false;
    this.pointerComboRearm = false;
    this.pointerReactionOwnerHwnd = pointer.targetHwnd;
    const footTargetX = this.pounceFootTargetX(pointer.x, directionLeft);
    const targetT = this.pounceTargetT(ledge, footTargetX, directionLeft);
    this.pouncePlayback = {
      phase: "entry",
      gridCell: POUNCE_ENTRY_CELLS[0],
      frameAccumulator: 0,
      entryIndex: 0,
      loopIndex: 0,
      recoveryIndex: 0,
      directionLeft,
      cycleFromT: this.attachmentTOnLedge(ledge, this.localX),
      cycleToT: targetT,
      cycleSurfaceId: ledge.id,
    };
    this.pounceDebugDestLocalX = pointer.x;
    this.activityId = POINTER_POUNCE_ACTIVITY;
    this.animationKey = animKey;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.activityMsLeft = 60_000;
  }

  private beginPounceLoopCycle(
    pp: ActivePouncePlayback,
    ledge: Ledge | null,
  ): void {
    pp.phase = "loop";
    pp.loopIndex = 0;
    if (!ledge) {
      pp.cycleFromT = 0.5;
      pp.cycleToT = 0.5;
      pp.cycleSurfaceId = "";
      this.pounceDebugDestLocalX = null;
      return;
    }
    pp.cycleSurfaceId = ledge.id;
    const entryCell = POUNCE_ENTRY_CELLS[POUNCE_ENTRY_CELLS.length - 1];
    const loopCell = POUNCE_LOOP_CELLS[0];
    this.shiftPounceContactPivot(entryCell, loopCell);
    pp.gridCell = loopCell;
    pp.cycleFromT = this.attachmentTOnLedge(ledge, this.localX);
    const pointer = this.frameValidatedPointer;
    const footTargetX = pointer
      ? this.pounceFootTargetX(pointer.x, pp.directionLeft)
      : this.localXFromAttachmentT(ledge, pp.cycleToT);
    pp.cycleToT = this.pounceTargetT(ledge, footTargetX, pp.directionLeft);
    this.pounceDebugDestLocalX = pointer?.x ?? null;
  }

  private snapPounceCycleEnd(pp: ActivePouncePlayback, ledge: Ledge | null): void {
    if (!ledge || ledge.id !== pp.cycleSurfaceId) {
      return;
    }
    this.localX = this.localXFromAttachmentT(ledge, pp.cycleToT);
    this.clampToLedge(ledge);
  }

  private syncPounceRootX(pp: ActivePouncePlayback, ledge: Ledge | null): void {
    if (pp.phase !== "loop" || !ledge || ledge.id !== pp.cycleSurfaceId) {
      return;
    }
    const duration = this.pounceFrameDurationMs();
    const sub = duration > 0 ? Math.min(1, pp.frameAccumulator / duration) : 0;
    const atCell = POUNCE_LOOP_TRAVEL_AT_CELL[pp.loopIndex];
    const atNext =
      POUNCE_LOOP_TRAVEL_AT_CELL[
        Math.min(pp.loopIndex + 1, POUNCE_LOOP_TRAVEL_AT_CELL.length - 1)
      ];
    const progress = atCell + (atNext - atCell) * sub;
    const t = Math.min(1, Math.max(0, progress));
    const attachT = pp.cycleFromT + (pp.cycleToT - pp.cycleFromT) * t;
    this.localX = this.localXFromAttachmentT(ledge, attachT);
    this.clampToLedge(ledge);
  }

  private pointerBeyondReachSide(
    pointer: IdeLocalPointerCoords,
    directionLeft: boolean,
    reach: ReachBox,
  ): boolean {
    return directionLeft
      ? pointer.x < reach.x0 - POUNCE_EXIT_HYSTERESIS_PX
      : pointer.x > reach.x1 + POUNCE_EXIT_HYSTERESIS_PX;
  }

  private pointerInContinuationBand(
    pointer: IdeLocalPointerCoords,
    reach: ReachBox,
  ): boolean {
    return pointer.y >= reach.y0 && pointer.y <= reach.y1;
  }

  private tickPounceContinuationPointer(
    pointer: IdeLocalPointerCoords | null,
    ledge: Ledge | null,
  ): void {
    const pp = this.pouncePlayback;
    if (!pp || pp.phase !== "loop") {
      this.pounceWantsAnotherCycle = false;
      return;
    }
    if (!pointer || !ledge || ledge.id !== pp.cycleSurfaceId) {
      this.pounceWantsAnotherCycle = false;
      this.resetPounceContinuationMotion();
      return;
    }
    const reach = this.pointerReachBoxLocal();
    if (this.pointInReach(pointer.x, pointer.y, reach)) {
      this.pounceWantsAnotherCycle = false;
      this.resetPounceContinuationMotion();
      return;
    }
    if (
      this.remainingLedgeTravelPx(ledge, pp.directionLeft) <
      POUNCE_MOTION_JITTER_PX
    ) {
      this.pounceWantsAnotherCycle = false;
      return;
    }
    if (
      !this.pointerBeyondReachSide(pointer, pp.directionLeft, reach) ||
      !this.pointerInContinuationBand(pointer, reach)
    ) {
      this.pounceWantsAnotherCycle = false;
      this.resetPounceContinuationMotion();
      return;
    }
    this.pounceWantsAnotherCycle = this.accumulatePounceContinuationMotion(
      pointer,
      pp.directionLeft,
    );
  }

  private resetPounceContinuationMotion(): void {
    this.pounceLateralAccumPx = 0;
    this.pounceLastLateralMotionAtMs = 0;
    this.pounceContinuationObs = null;
  }

  private pounceContinuationMotionFresh(nowMs: number): boolean {
    return (
      this.pounceLastLateralMotionAtMs > 0 &&
      nowMs - this.pounceLastLateralMotionAtMs <= POUNCE_MOTION_GRACE_MS &&
      this.pounceLateralAccumPx >= POUNCE_MOTION_JITTER_PX
    );
  }

  private accumulatePounceContinuationMotion(
    pointer: IdeLocalPointerCoords,
    directionLeft: boolean,
  ): boolean {
    const now = pointer.observedAtMs;
    const sample = {
      x: pointer.x,
      y: pointer.y,
      t: now,
      targetHwnd: pointer.targetHwnd,
    };
    const prev = this.pounceContinuationObs;
    if (!prev) {
      this.pounceContinuationObs = sample;
      return false;
    }
    if (
      prev.targetHwnd !== 0 &&
      pointer.targetHwnd !== 0 &&
      prev.targetHwnd !== pointer.targetHwnd
    ) {
      this.resetPounceContinuationMotion();
      this.pounceContinuationObs = sample;
      return false;
    }
    const gap = now - prev.t;
    if (gap <= 0) {
      return this.pounceContinuationMotionFresh(now);
    }
    if (gap > POUNCE_MOTION_GRACE_MS) {
      this.pounceLateralAccumPx = 0;
      this.pounceLastLateralMotionAtMs = 0;
      this.pounceContinuationObs = sample;
      return false;
    }
    const dx = pointer.x - prev.x;
    const dy = pointer.y - prev.y;
    if (
      Math.abs(dy) > Math.abs(dx) &&
      Math.abs(dy) > POUNCE_MOTION_JITTER_PX
    ) {
      this.resetPounceContinuationMotion();
      this.pounceContinuationObs = sample;
      return false;
    }
    const lateral = directionLeft ? -dx : dx;
    if (lateral < -POUNCE_MOTION_JITTER_PX) {
      this.resetPounceContinuationMotion();
      this.pounceContinuationObs = sample;
      return false;
    }
    if (lateral > 0) {
      this.pounceLateralAccumPx += lateral;
      this.pounceLastLateralMotionAtMs = now;
    }
    this.pounceContinuationObs = sample;
    return this.pounceContinuationMotionFresh(now);
  }

  private advancePouncePlayback(dtMs: number, ledge: Ledge | null): void {
    const pp = this.pouncePlayback;
    if (!pp) {
      return;
    }
    if (ledge && ledge.id !== pp.cycleSurfaceId && pp.phase === "loop") {
      this.cancelPointerReactionPlayback();
      return;
    }
    const duration = this.pounceFrameDurationMs();
    pp.frameAccumulator += dtMs;
    while (pp.frameAccumulator >= duration) {
      pp.frameAccumulator -= duration;
      if (pp.phase === "entry") {
        if (pp.entryIndex + 1 < POUNCE_ENTRY_CELLS.length) {
          pp.entryIndex += 1;
          pp.gridCell = POUNCE_ENTRY_CELLS[pp.entryIndex];
          continue;
        }
        this.beginPounceLoopCycle(pp, ledge);
        continue;
      }
      if (pp.phase === "loop") {
        if (pp.loopIndex + 1 < POUNCE_LOOP_CELLS.length) {
          const prevCell = pp.gridCell;
          pp.loopIndex += 1;
          pp.gridCell = POUNCE_LOOP_CELLS[pp.loopIndex];
          this.shiftPounceContactPivot(prevCell, pp.gridCell);
          continue;
        }
        this.snapPounceCycleEnd(pp, ledge);
        const pointer = this.frameValidatedPointer;
        if (
          this.pounceWantsAnotherCycle &&
          ledge &&
          ledge.id === pp.cycleSurfaceId &&
          pointer &&
          this.pointerBeyondReachSide(
            pointer,
            pp.directionLeft,
            this.pointerReachBoxLocal(),
          ) &&
          this.remainingLedgeTravelPx(ledge, pp.directionLeft) >=
            POUNCE_MOTION_JITTER_PX
        ) {
          this.resetPounceContinuationMotion();
          this.beginPounceLoopCycle(pp, ledge);
          continue;
        }
        this.shiftPounceContactPivot(
          POUNCE_LOOP_CELLS[POUNCE_LOOP_CELLS.length - 1],
          POUNCE_RECOVERY_CELLS[0],
        );
        pp.phase = "recovery";
        pp.recoveryIndex = 0;
        pp.gridCell = POUNCE_RECOVERY_CELLS[0];
        continue;
      }
      if (pp.recoveryIndex + 1 < POUNCE_RECOVERY_CELLS.length) {
        pp.recoveryIndex += 1;
        pp.gridCell = POUNCE_RECOVERY_CELLS[pp.recoveryIndex];
        continue;
      }
      this.finishPouncePlayback();
      return;
    }
    this.syncPounceRootX(pp, ledge);
  }

  private finishPouncePlayback(): void {
    this.pouncePlayback = null;
    this.startIdle();
  }

  private sitLookDef(): SitLookDef | null {
    return this.habitat.animations[SIT_LOOK_ANIM]?.sitLook ?? null;
  }

  private beginSitLookIntro(): void {
    const def = this.sitLookDef();
    if (!def) {
      this.startIdle();
      return;
    }
    this.sitLookPhase = "intro";
    this.sitLookAngleKeyframes = buildSitLookAngleKeyframes(
      def.lookAngleByCell,
    );
    this.sitLookPointerSpeedPxPerSec = 0;
    this.sitLookLastMotionSample = null;
    this.sitLookMotionGraceMsLeft = 0;
    this.animationKey = SIT_LOOK_ANIM;
    this.frameIndex = def.introFirstCell;
    this.frameAccumulator = 0;
  }

  private beginSitLookExit(): void {
    const def = this.sitLookDef();
    if (!def) {
      this.pickNextActivity();
      return;
    }
    const wasGaze = this.sitLookPhase === "gaze";
    this.sitLookPhase = "exit";
    if (wasGaze) {
      this.frameIndex = def.neutralCell;
    } else {
      this.frameIndex = Math.min(this.frameIndex, def.neutralCell);
    }
    this.frameAccumulator = 0;
  }

  private clearSitLookState(): void {
    this.sitLookPhase = null;
    this.sitLookAngleKeyframes = [];
    this.sitLookPointerSpeedPxPerSec = 0;
    this.sitLookLastMotionSample = null;
    this.sitLookMotionGraceMsLeft = 0;
  }

  private finishSitLookExit(): void {
    this.clearSitLookState();
    this.pickNextActivity();
  }

  private updateSitLookPointerSpeed(
    pointer: IdeLocalPointerCoords | null,
    dtMs: number,
  ): void {
    if (this.activityId !== SIT_LOOK_ACTIVITY_ID || this.sitLookPhase !== "gaze") {
      this.sitLookPointerSpeedPxPerSec *= 0.85;
      if (this.sitLookMotionGraceMsLeft > 0) {
        this.sitLookMotionGraceMsLeft = Math.max(
          0,
          this.sitLookMotionGraceMsLeft - dtMs,
        );
      }
      return;
    }
    if (!pointer) {
      this.sitLookPointerSpeedPxPerSec *= 0.85;
      this.sitLookLastMotionSample = null;
      this.sitLookMotionGraceMsLeft = Math.max(
        0,
        this.sitLookMotionGraceMsLeft - dtMs,
      );
      return;
    }
    const prev = this.sitLookLastMotionSample;
    if (
      prev &&
      pointer.targetHwnd !== 0 &&
      prev.targetHwnd !== 0 &&
      pointer.targetHwnd !== prev.targetHwnd
    ) {
      this.sitLookPointerSpeedPxPerSec = 0;
      this.sitLookMotionGraceMsLeft = 0;
    } else if (prev) {
      const dtSample = pointer.observedAtMs - prev.t;
      if (dtSample > 0 && dtSample < 600) {
        const dist = Math.hypot(pointer.x - prev.x, pointer.y - prev.y);
        const speed = (dist / dtSample) * 1000;
        this.sitLookPointerSpeedPxPerSec =
          this.sitLookPointerSpeedPxPerSec * 0.55 + speed * 0.45;
        if (dist >= POUNCE_MOTION_JITTER_PX) {
          this.sitLookMotionGraceMsLeft = POUNCE_MOTION_GRACE_MS;
        }
      }
    }
    this.sitLookLastMotionSample = {
      x: pointer.x,
      y: pointer.y,
      t: pointer.observedAtMs,
      targetHwnd: pointer.targetHwnd,
    };
    if (this.sitLookMotionGraceMsLeft > 0) {
      this.sitLookMotionGraceMsLeft = Math.max(
        0,
        this.sitLookMotionGraceMsLeft - dtMs,
      );
    }
  }

  private sitLookPointerMoving(): boolean {
    return (
      this.sitLookMotionGraceMsLeft > 0 ||
      this.sitLookPointerSpeedPxPerSec >= SIT_LOOK_STILL_SPEED_PX_PER_SEC
    );
  }

  private advanceSitLookFrames(dtMs: number): void {
    const def = this.sitLookDef();
    const anim = this.habitat.animations[SIT_LOOK_ANIM];
    if (!def || !anim || this.sitLookPhase === null) {
      return;
    }
    const frameDuration = 1000 / (anim.fps || 12);
    this.frameAccumulator += dtMs;
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      if (this.sitLookPhase === "intro") {
        if (this.frameIndex < def.introLastCell) {
          this.frameIndex += 1;
          continue;
        }
        this.frameIndex = def.neutralCell;
        this.sitLookPhase = "gaze";
        continue;
      }
      if (this.sitLookPhase === "exit") {
        if (this.frameIndex > def.introFirstCell) {
          this.frameIndex -= 1;
          continue;
        }
        this.finishSitLookExit();
        return;
      }
      if (this.sitLookPhase === "gaze") {
        const pointer = this.frameValidatedPointer;
        if (!pointer || !this.sitLookPointerMoving()) {
          this.frameIndex = def.neutralCell;
          break;
        }
        const bearing = pointerBearingDeg(
          this.localX,
          this.localY,
          pointer.x,
          pointer.y,
        );
        this.frameIndex = stepSitLookGazeCell(
          this.frameIndex,
          bearing,
          def.lookAngleByCell,
          this.sitLookAngleKeyframes,
        );
        break;
      }
      break;
    }
  }

  private clampToLedge(ledge: Ledge) {
    const margin = this.footMarginLocal();
    const minX = ledge.x0 + margin;
    const maxX = ledge.x1 - margin;
    if (this.localX < minX) this.localX = minX;
    if (this.localX > maxX) this.localX = maxX;
    this.writeAttachmentT(ledge);
  }

  private startIdle() {
    this.clearSegmentedPlay();
    this.clearAnnoyedPlayback();
    this.clearSitLookState();
    this.resetPointerReactionState();
    this.activityId = "idle";
    this.animationKey = "idle";
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.activityMsLeft = this.idleSlotDurationMs();
  }

  private armActivityCooldown(activityId: string): void {
    const def = this.habitat.activities[activityId];
    if (def?.cooldownMs != null && def.cooldownMs > 0) {
      this.activityCooldownMsLeft.set(activityId, def.cooldownMs);
    }
  }

  /** Entries eligible for `pickNextActivity` weighted roll. */
  private weightedActivityPool(respectCooldown: boolean): [string, ActivityDef][] {
    return Object.entries(this.habitat.activities).filter(([id, def]) => {
      if (def.weight <= 0) {
        return false;
      }
      if (id === SLEEP_ACTIVITY && !this.habitat.animations.sleep_enter) {
        return false;
      }
      if (respectCooldown && (this.activityCooldownMsLeft.get(id) ?? 0) > 0) {
        return false;
      }
      return true;
    });
  }

  private pickNextActivity() {
    this.armActivityCooldown(this.activityId);
    this.clearAnnoyedPlayback();
    this.clearSegmentedPlay();
    let pool = this.weightedActivityPool(true);
    if (!pool.length) {
      pool = this.weightedActivityPool(false);
    }
    if (!pool.length) {
      this.startIdle();
      return;
    }
    const total = pool.reduce((s, [, d]) => s + d.weight, 0);
    let r = Math.random() * total;
    let chosen: [string, ActivityDef] = pool[0];
    for (const entry of pool) {
      r -= entry[1].weight;
      if (r <= 0) {
        chosen = entry;
        break;
      }
    }
    const [id, def] = chosen;

    if (id === SLEEP_ACTIVITY) {
      const pre = this.sleepBookendPreKey();
      if (pre) {
        this.beginSleepPreStretch(pre);
      } else {
        this.beginSleepEnter();
      }
      return;
    }

    this.activityId = id;

    if (id === SIT_LOOK_ACTIVITY_ID) {
      this.beginSitLookIntro();
      this.activityMsLeft = this.randMs(def);
      return;
    }

    if (def.travel) {
      const wantLeft = Math.random() > 0.5;
      this.walkOdometer = 0;
      this.activityMsLeft = this.randMs(def);
      if (wantLeft !== this.facingLeft) {
        this.beginTurn();
      } else {
        this.animationKey = def.animation ?? "walk";
        this.resetWalkCyclePhase();
      }
      return;
    }

    const animKey = def.animation ?? "idle";
    this.animationKey = animKey;
    this.activityMsLeft = this.randMs(def);
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    // Idle one-shots with `segmentedLoop` (e.g. groom_4) use the same player as sleep/dream clips.
    this.startSegmentedPlay(animKey);
  }

  private randMs(def: ActivityDef): number {
    if (def.minMs >= def.maxMs) return def.minMs;
    return def.minMs + Math.random() * (def.maxMs - def.minMs);
  }

  /** Recovery idle and post-interrupt idle use `activities.idle` timing (same as weighted idle picks). */
  private idleSlotDurationMs(): number {
    const def = this.habitat.activities.idle;
    if (def) {
      return this.randMs(def);
    }
    return 3000;
  }

  private hostAnimation(): AnimationDef | undefined {
    return this.habitat.animations[this.animationKey];
  }

  private effectiveAnimationKey(): string {
    if (this.annoyedPlayback) {
      return ANNOYED_ANIM;
    }
    return this.animationKey;
  }

  private effectiveFrameIndex(): number {
    if (this.annoyedPlayback) {
      return this.annoyedPlayback.frameIndex;
    }
    return this.frameIndex;
  }

  /** Decrements `activities.*.cooldownMs` timers (paused during annoyed overlay). */
  private tickActivityCooldowns(dtMs: number): void {
    if (this.annoyedPlayback) {
      return;
    }
    for (const [id, left] of this.activityCooldownMsLeft) {
      if (left > 0) {
        this.activityCooldownMsLeft.set(id, Math.max(0, left - dtMs));
      }
    }
  }

  /** Travel speed: activity override, else stride×fps/frameCount from walk animation (`pet.json`). */
  private travelSpeedPxPerSec(act: ActivityDef): number {
    if (act.speedPxPerSec != null && act.speedPxPerSec > 0) {
      return act.speedPxPerSec;
    }
    const animKey = act.animation ?? "walk";
    const anim = this.habitat.animations[animKey];
    const stride = anim?.stridePixelsPerLoop;
    const frameCount = anim?.frames.length ?? 0;
    if (
      anim &&
      stride != null &&
      stride > 0 &&
      frameCount > 0 &&
      anim.fps > 0
    ) {
      return (stride * anim.fps) / frameCount;
    }
    return DEFAULT_TRAVEL_SPEED_PX_PER_SEC;
  }

  private resetWalkCyclePhase(): void {
    this.frameIndex = 0;
    this.frameAccumulator = 0;
    this.walkOdometer = 0;
  }

  /** One-shot turn at ledge or before walk; keeps pre-turn `facingLeft` (mirrors turn sheet). */
  private beginTurn(): void {
    if (!this.habitat.animations[TURN_ANIM] || this.animationKey === TURN_ANIM) {
      return;
    }
    this.animationKey = TURN_ANIM;
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  private finishTurn(): void {
    this.facingLeft = !this.facingLeft;
    const act = this.habitat.activities[this.activityId];
    if (act?.travel) {
      this.animationKey = act.animation ?? "walk";
      this.resetWalkCyclePhase();
    }
  }

  /** Fall interrupts turn without reversing facing. */
  private cancelTurn(): void {
    if (this.animationKey !== TURN_ANIM) {
      return;
    }
    const act = this.habitat.activities[this.activityId];
    if (act?.travel) {
      this.animationKey = act.animation ?? "walk";
    } else {
      this.animationKey = act?.animation ?? "idle";
    }
    this.frameIndex = 0;
    this.frameAccumulator = 0;
  }

  /** Lock walk cel to distance so foot slide matches `stridePixelsPerLoop`. */
  private syncWalkFrameFromDistance(act: ActivityDef): void {
    const animKey = act.animation ?? "walk";
    const anim = this.habitat.animations[animKey];
    const stride = anim?.stridePixelsPerLoop;
    const n = anim?.frames.length ?? 0;
    if (!anim || !stride || stride <= 0 || n <= 0) {
      return;
    }
    const phase = (this.walkOdometer % stride) / stride;
    this.frameIndex = Math.min(n - 1, Math.floor(phase * n));
  }

  private drawGridCell(animationKey: string): number {
    if (
      animationKey === SIT_LOOK_ANIM &&
      this.activityId === SIT_LOOK_ACTIVITY_ID &&
      this.sitLookPhase !== null
    ) {
      return this.frameIndex;
    }
    if (
      animationKey === "pounce" &&
      this.pouncePlayback &&
      this.activityId === POINTER_POUNCE_ACTIVITY
    ) {
      return this.pouncePlayback.gridCell;
    }
    if (
      animationKey === "swipe" &&
      this.swipePlayback &&
      this.activityId === POINTER_SWIPE_ACTIVITY
    ) {
      return this.swipePlayback.gridCell;
    }
    if (this.segmentedPlay?.animationKey === animationKey) {
      return this.segmentedGridCell();
    }
    const anim = this.habitat.animations[animationKey];
    if (!anim?.frames.length) {
      return 0;
    }
    const idx = this.effectiveFrameIndex() % anim.frames.length;
    return anim.frames[idx] ?? 0;
  }

  private gridCellToFrameCell(
    animationKey: string,
    cell: number,
  ): { col: number; row: number } {
    const anim = this.habitat.animations[animationKey];
    const grid = anim?.clipGrid ?? this.habitat.grid.clipGrid;
    const cols = grid?.columns ?? 0;
    if (cols > 0) {
      return { col: cell % cols, row: Math.floor(cell / cols) };
    }
    return { col: cell, row: anim?.row ?? 0 };
  }

  private startSegmentedPlay(animationKey: string): boolean {
    const anim = this.habitat.animations[animationKey];
    const seg = anim?.segmentedLoop;
    if (!seg?.loop.length) {
      return false;
    }
    const min = seg.minLoops;
    const max = seg.maxLoops;
    const loops =
      min >= max ? min : min + Math.floor(Math.random() * (max - min + 1));
    const hasIntro = (seg.intro?.length ?? 0) > 0;
    this.segmentedPlay = {
      animationKey,
      phase: hasIntro ? "intro" : "loop",
      phaseIndex: 0,
      loopsRemaining: loops,
    };
    this.segmentedFrameAccumulator = 0;
    return true;
  }

  private clearSegmentedPlay(): void {
    this.segmentedPlay = null;
    this.segmentedFrameAccumulator = 0;
  }

  private segmentedPhaseCells(): number[] {
    const seg = this.habitat.animations[this.segmentedPlay?.animationKey ?? ""]
      ?.segmentedLoop;
    if (!this.segmentedPlay || !seg) {
      return [];
    }
    if (this.segmentedPlay.phase === "intro") {
      return seg.intro ?? [];
    }
    if (this.segmentedPlay.phase === "loop") {
      return seg.loop;
    }
    return seg.outro ?? [];
  }

  private segmentedGridCell(): number {
    const cells = this.segmentedPhaseCells();
    if (!cells.length) {
      return 0;
    }
    const idx = Math.min(this.segmentedPlay!.phaseIndex, cells.length - 1);
    return cells[idx] ?? 0;
  }

  private finishSegmentedPlay(): void {
    const key = this.segmentedPlay?.animationKey;
    const phase = this.sleepPhase;
    this.clearSegmentedPlay();
    if (!key) {
      return;
    }
    if (phase === "pre_stretch" && key === this.sleepBookendPreKey()) {
      this.beginSleepEnter();
      return;
    }
    if (phase === "post_stretch" && key === this.sleepBookendPostKey()) {
      this.finishWake();
      return;
    }
    if (this.isDreamAnimationKey(key) && phase === "sleeping") {
      if (this.sleepRestMsLeft > 0) {
        this.beginSleepDreamSegment();
      } else {
        this.beginSleepExit();
      }
      return;
    }
    const act = this.habitat.activities[this.activityId];
    if (act?.oneShot && act.animation === key) {
      this.pickNextActivity();
    }
  }

  private advanceSegmentedPhaseFrame(): void {
    if (!this.segmentedPlay) {
      return;
    }
    const anim = this.habitat.animations[this.segmentedPlay.animationKey];
    const seg = anim?.segmentedLoop;
    if (!seg) {
      this.clearSegmentedPlay();
      return;
    }

    const cells = this.segmentedPhaseCells();
    if (!cells.length) {
      if (this.segmentedPlay.phase === "intro") {
        this.segmentedPlay.phase = "loop";
        this.segmentedPlay.phaseIndex = 0;
        return;
      }
      if (this.segmentedPlay.phase === "loop") {
        this.segmentedPlay.loopsRemaining -= 1;
        if (this.segmentedPlay.loopsRemaining > 0) {
          this.segmentedPlay.phaseIndex = 0;
          return;
        }
        if ((seg.outro?.length ?? 0) > 0) {
          this.segmentedPlay.phase = "outro";
          this.segmentedPlay.phaseIndex = 0;
          return;
        }
        this.finishSegmentedPlay();
        return;
      }
      this.finishSegmentedPlay();
      return;
    }

    if (this.segmentedPlay.phaseIndex + 1 < cells.length) {
      this.segmentedPlay.phaseIndex += 1;
      return;
    }

    if (this.segmentedPlay.phase === "intro") {
      this.segmentedPlay.phase = "loop";
      this.segmentedPlay.phaseIndex = 0;
      return;
    }
    if (this.segmentedPlay.phase === "loop") {
      this.segmentedPlay.loopsRemaining -= 1;
      if (this.segmentedPlay.loopsRemaining > 0) {
        this.segmentedPlay.phaseIndex = 0;
        return;
      }
      if ((seg.outro?.length ?? 0) > 0) {
        this.segmentedPlay.phase = "outro";
        this.segmentedPlay.phaseIndex = 0;
        return;
      }
      this.finishSegmentedPlay();
      return;
    }
    this.finishSegmentedPlay();
  }

  private advanceSegmentedFrames(dtMs: number): void {
    if (!this.segmentedPlay) {
      return;
    }
    const anim = this.habitat.animations[this.segmentedPlay.animationKey];
    if (!anim?.segmentedLoop) {
      this.clearSegmentedPlay();
      return;
    }
    this.segmentedFrameAccumulator += dtMs;
    const seg = anim.segmentedLoop;
    const phaseFps =
      this.segmentedPlay.phase === "loop" && seg.loopFps != null
        ? seg.loopFps
        : anim.fps || 6;
    const frameDuration = 1000 / phaseFps;
    while (this.segmentedFrameAccumulator >= frameDuration) {
      this.segmentedFrameAccumulator -= frameDuration;
      this.advanceSegmentedPhaseFrame();
      if (!this.segmentedPlay) {
        break;
      }
    }
  }

  /** Advance one host clip frame; `true` when the timing loop may consume another tick. */
  private advanceFrame(anim: AnimationDef | undefined): boolean {
    if (!anim) return false;
    const max = anim.frames.length;
    if (max === 0) return false;
    if (this.frameIndex + 1 < max) {
      this.frameIndex += 1;
      return true;
    }
    if (anim.loop) {
      this.frameIndex = 0;
      return true;
    }
    if (
      this.animationKey === HANG_REACH_ANIM &&
      this.motionPhase === "cling"
    ) {
      this.completeHangReach(this.viewSx, this.viewSy, this.viewScale);
      return false;
    }
    if (this.animationKey === "sleep_enter") {
      this.beginSleepDreaming();
      return false;
    }
    if (this.animationKey === "sleep_exit") {
      const post = this.sleepBookendPostKey();
      if (post) {
        this.beginSleepPostStretch(post);
      } else {
        this.finishWake();
      }
      return false;
    }
    if (isPointerReactionActivity(this.activityId)) {
      this.startIdle();
      return false;
    }
    if (this.animationKey === SLIDE_INTRO_ANIM) {
      this.beginDividerSlideDescend(this.viewSx, this.viewSy, this.viewScale);
      return false;
    }
    if (this.animationKey === SLIDE_LAND_ANIM) {
      this.finishDividerSlide();
      return false;
    }
    if (this.animationKey === PORTAL_OPEN_ANIM) {
      this.portalPhase = "pending_handoff";
      return false;
    }
    if (this.animationKey === PORTAL_EXIT_ANIM) {
      this.finishPortal();
      return false;
    }
    if (this.animationKey === TURN_ANIM) {
      this.finishTurn();
      return false;
    }
    const def = this.habitat.activities[this.activityId];
    if (def?.oneShot) {
      this.pickNextActivity();
    } else {
      this.frameIndex = 0;
    }
    return false;
  }
}
