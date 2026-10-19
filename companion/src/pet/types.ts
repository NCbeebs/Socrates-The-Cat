/** Types shared with `assets/pets/default-cat/pet.json` habitat block (companion overlay). */

export interface PetManifest {
  id: string;
  habitat: HabitatBlock;
}

export interface HabitatBlock {
  /** Default strip when an animation omits `clip`. */
  defaultClip?: string;
  grid: {
    /** On-screen / physics cell size (IDE overlay). */
    frameSize: [number, number];
    /** Default clip layout when an animation omits `clipGrid` / `clipCellSize`. */
    clipGrid?: { columns: number; rows: number };
    clipCellSize?: [number, number];
    /** Typical full clip PNG size (authoring reference; not required at runtime). */
    sheetSize?: [number, number];
  };
  pivot: [number, number];
  /** Initial mirror for right-authored clips (`flipX` when grounded facing left). */
  defaultFacing?: "left" | "right";
  animations: Record<string, AnimationDef>;
  activities: Record<string, ActivityDef>;
}

/** Intro → repeated loop body → outro using grid cell indices (`pet.json` on an animation). */
export interface SegmentedLoopDef {
  intro?: number[];
  loop: number[];
  minLoops: number;
  maxLoops: number;
  outro?: number[];
  /** When set, loop phase uses this fps instead of the parent animation `fps` (intro/outro unchanged). */
  loopFps?: number;
}

export interface AnimationDef {
  /** Strip PNG in `assets/pets/default-cat/` (e.g. `socs-idle.png`). Row is always 0. */
  clip?: string;
  row?: number;
  /** When set, each `frames[]` value is a row-major cell index (0..cols*rows-1). */
  clipGrid?: { columns: number; rows: number };
  /** Pixel size of one cell in the clip PNG; scaled to `habitat.grid.frameSize` when drawing. */
  clipCellSize?: [number, number];
  frames: number[];
  fps: number;
  loop: boolean;
  /**
   * IDE-local px moved per full `frames` loop. With `travel`, `HabitatPet` sets
   * speed to `stridePixelsPerLoop * fps / frames.length` unless the activity sets `speedPxPerSec`.
   */
  stridePixelsPerLoop?: number;
  /** Play `intro` once, repeat `loop` a random inclusive count, then `outro` once. */
  segmentedLoop?: SegmentedLoopDef;
  /** Foot/grip anchor in clip cell pixels; mirrored when `flipX` (see `HabitatPet` draw). */
  pivotOverride?: [number, number];
  /**
   * `pointer_pounce` only: right-facing row-major cell index → paw/foot contact on the
   * ledge (cell px). Mirrored when `flipX`; used for draw anchor and cursor landing offset.
   */
  pounceContactByCell?: Record<string, [number, number]>;
  /** Directional sit + cursor gaze (`Socs-sit_and_look.png`); cells are row-major grid indices. */
  noFlip?: boolean;
  sitLook?: SitLookDef;
}

/** `sit_look` animation: intro sit-down, neutral hold, angle-mapped gaze cells (`HabitatPet`). */
export interface SitLookDef {
  introFirstCell: number;
  introLastCell: number;
  neutralCell: number;
  /** Grid cell index (string key) → look bearing in degrees (math unit circle, 0° = right). */
  lookAngleByCell: Record<string, number>;
}

export interface ActivityDef {
  animation?: string;
  weight: number;
  /** Idle/walk: activity duration. `sleep`: fallback timer if the chosen dream clip has no `segmentedLoop`. */
  minMs: number;
  maxMs: number;
  /** `sleep` only: uniform random pick when entering the dream rest phase (`HabitatPet.beginSleepDreaming`). */
  dreamAnimations?: string[];
  /** `sleep` only: `segmentedLoop` clip before `sleep_enter` (e.g. yawn/stretch). */
  preSleepAnimation?: string;
  /** `sleep` only: same style clip after `sleep_exit` before idle pool. */
  postSleepAnimation?: string;
  oneShot?: boolean;
  travel?: boolean;
  /** Overrides stride-derived walk speed when set. */
  speedPxPerSec?: number;
  /** After this activity ends (`pickNextActivity`), it is excluded from the weighted pool for this many ms. */
  cooldownMs?: number;
}

export interface SurfaceSeg {
  id: string;
  role: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  walkable: boolean;
  climbable?: boolean;
  confidence?: number;
}

/** Live-surface freshness from `load_surfaces` (companion `main.ts` → `HabitatPet`). */
export interface GeometryMeta {
  observedAtMs: number;
  targetHwnd: number;
  scanSequence: number;
  surfaceSource: string;
}

/** Rust `get_pointer_in_ide_local` sample (HWND-local px, same space as UIA surfaces). */
export interface IdeLocalPointer {
  x: number;
  y: number;
  targetHwnd: number;
  observedAtMs: number;
}
