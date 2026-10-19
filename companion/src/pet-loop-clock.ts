/**
 * Single monotonic simulation clock for the pet render loop (`main.ts`).
 */

export type PetLoopClockOptions = {
  maxStepMs?: number;
  rafStaleMs?: number;
  isVisible?: () => boolean;
  /** Injectable clock for tests; defaults to `performance.now`. */
  now?: () => number;
};

export type PetLoopClock = {
  onAnimationFrame: (ts: number) => void;
  onFallbackTimer: (ts?: number) => void;
  onVisibilityChange: (ts?: number) => void;
  seed: (ts: number) => void;
};

export function createPetLoopClock(
  onStep: (dtMs: number) => void,
  options: PetLoopClockOptions = {},
): PetLoopClock {
  const maxStepMs = options.maxStepMs ?? 48;
  const rafStaleMs = options.rafStaleMs ?? 80;
  const isVisible =
    options.isVisible ??
    (() =>
      typeof document === "undefined" || document.visibilityState === "visible");
  const now = options.now ?? (() => performance.now());

  let lastAdvanceMs = 0;
  let lastRafMs = 0;

  const tryAdvance = (ts: number) => {
    if (!isVisible()) {
      return false;
    }
    const rawDt = ts - lastAdvanceMs;
    if (rawDt <= 0) {
      return false;
    }
    const dt = Math.min(maxStepMs, rawDt);
    lastAdvanceMs = ts;
    onStep(dt);
    return true;
  };

  return {
    onAnimationFrame(ts: number) {
      lastRafMs = ts;
      tryAdvance(ts);
    },
    onFallbackTimer(ts?: number) {
      if (!isVisible()) {
        return;
      }
      const at = ts ?? now();
      if (lastRafMs > 0 && at - lastRafMs <= rafStaleMs) {
        return;
      }
      tryAdvance(at);
    },
    onVisibilityChange(ts?: number) {
      if (isVisible()) {
        const at = ts ?? now();
        lastAdvanceMs = at;
        lastRafMs = at;
      }
    },
    seed(ts: number) {
      lastAdvanceMs = ts;
      lastRafMs = ts;
    },
  };
}
