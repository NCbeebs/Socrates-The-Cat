/**
 * Stable horizontal panel-sash tracking across UIA polls (`ledge-h-{y}` id churn).
 * Used by `HabitatPet` for terminal/panel divider drag and cling continuity.
 */

export interface SashSegment {
  id: string;
  y: number;
  x0: number;
  x1: number;
}

export interface TrackedSash {
  trackKey: number;
  y: number;
  x0: number;
  x1: number;
  velocityY: number;
  stationaryMs: number;
}

export interface SashMatcherMeta {
  observedAtMs: number;
  targetHwnd: number;
  surfaceSource: string;
  scanSequence: number;
}

const MAX_MATCH_DY = 200;
const MIN_SPAN_OVERLAP = 0.35;
/** Below `SASH_VELOCITY_MIN` in `habitat-pet.ts` so grabs are not cut short while slowing. */
export const SASH_MOVING_VELOCITY = 20;
const AMBIGUOUS_COST_EPS = 4;

function spanOverlap(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (hi <= lo) {
    return 0;
  }
  const overlap = hi - lo;
  const minSpan = Math.min(a1 - a0, b1 - b0);
  if (minSpan <= 0) {
    return 0;
  }
  return overlap / minSpan;
}

function pairIsAmbiguous(
  pair: { trackIdx: number; sashIdx: number; cost: number },
  pairs: { trackIdx: number; sashIdx: number; cost: number }[],
): boolean {
  for (const other of pairs) {
    if (other.trackIdx === pair.trackIdx && other.sashIdx !== pair.sashIdx) {
      if (Math.abs(other.cost - pair.cost) <= AMBIGUOUS_COST_EPS) {
        return true;
      }
    }
    if (other.sashIdx === pair.sashIdx && other.trackIdx !== pair.trackIdx) {
      if (Math.abs(other.cost - pair.cost) <= AMBIGUOUS_COST_EPS) {
        return true;
      }
    }
  }
  return false;
}

export class SashMatcher {
  private tracks: TrackedSash[] = [];
  private nextKey = 1;
  private lastObservedAtMs = 0;
  private lastHwnd: number | null = null;
  private lastSource: string | null = null;
  private lastIngestScanSequence = -1;
  private lastIngestObservedAtMs = 0;

  reset(): void {
    this.tracks = [];
    this.lastObservedAtMs = 0;
    this.lastHwnd = null;
    this.lastSource = null;
    this.lastIngestScanSequence = -1;
    this.lastIngestObservedAtMs = 0;
  }

  ingest(sashes: SashSegment[], meta: SashMatcherMeta): TrackedSash[] {
    if (
      meta.scanSequence > 0 &&
      meta.scanSequence === this.lastIngestScanSequence
    ) {
      return this.tracks;
    }
    if (
      meta.scanSequence === 0 &&
      meta.observedAtMs > 0 &&
      meta.observedAtMs === this.lastIngestObservedAtMs
    ) {
      return this.tracks;
    }

    if (
      this.lastHwnd != null &&
      (meta.targetHwnd !== this.lastHwnd ||
        meta.surfaceSource !== this.lastSource)
    ) {
      this.reset();
    }
    this.lastHwnd = meta.targetHwnd;
    this.lastSource = meta.surfaceSource;
    if (meta.scanSequence > 0) {
      this.lastIngestScanSequence = meta.scanSequence;
    }
    this.lastIngestObservedAtMs = meta.observedAtMs;

    const dtMs =
      this.lastObservedAtMs > 0
        ? Math.max(1, meta.observedAtMs - this.lastObservedAtMs)
        : 0;
    this.lastObservedAtMs = meta.observedAtMs;

    if (!sashes.length) {
      this.tracks = [];
      return [];
    }

    const prev = this.tracks;
    const usedSash = new Set<number>();
    const usedTrack = new Set<number>();
    const next: TrackedSash[] = [];

    type Pair = { trackIdx: number; sashIdx: number; cost: number };
    const pairs: Pair[] = [];
    for (let ti = 0; ti < prev.length; ti += 1) {
      const t = prev[ti];
      for (let si = 0; si < sashes.length; si += 1) {
        const s = sashes[si];
        const dy = Math.abs(s.y - t.y);
        if (dy > MAX_MATCH_DY) {
          continue;
        }
        const overlap = spanOverlap(t.x0, t.x1, s.x0, s.x1);
        if (overlap < MIN_SPAN_OVERLAP) {
          continue;
        }
        pairs.push({ trackIdx: ti, sashIdx: si, cost: dy + (1 - overlap) * 40 });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);

    for (const pair of pairs) {
      if (usedTrack.has(pair.trackIdx) || usedSash.has(pair.sashIdx)) {
        continue;
      }
      if (pairIsAmbiguous(pair, pairs)) {
        continue;
      }
      const t = prev[pair.trackIdx];
      const s = sashes[pair.sashIdx];
      usedTrack.add(pair.trackIdx);
      usedSash.add(pair.sashIdx);

      const velocityY = dtMs > 0 ? ((s.y - t.y) / dtMs) * 1000 : 0;
      const moving = Math.abs(velocityY) >= SASH_MOVING_VELOCITY;
      const stationaryMs = moving ? 0 : t.stationaryMs + dtMs;

      next.push({
        trackKey: t.trackKey,
        y: s.y,
        x0: s.x0,
        x1: s.x1,
        velocityY,
        stationaryMs,
      });
    }

    for (let si = 0; si < sashes.length; si += 1) {
      if (usedSash.has(si)) {
        continue;
      }
      const s = sashes[si];
      next.push({
        trackKey: this.nextKey++,
        y: s.y,
        x0: s.x0,
        x1: s.x1,
        velocityY: 0,
        stationaryMs: 0,
      });
    }

    this.tracks = next;
    return next;
  }

  trackByKey(key: number): TrackedSash | undefined {
    return this.tracks.find((t) => t.trackKey === key);
  }
}
