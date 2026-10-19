import assert from "node:assert/strict";
import test from "node:test";
import { createPetLoopClock } from "../src/pet-loop-clock.ts";

test("skips nonpositive and duplicate timestamps", () => {
  const steps = [];
  const clock = createPetLoopClock((dt) => steps.push(dt), { isVisible: () => true });
  clock.seed(100);
  clock.onAnimationFrame(116.9);
  assert.equal(steps.length, 1);
  assert.ok(Math.abs(steps[0] - 16.9) < 0.001);
  clock.onAnimationFrame(116.5);
  assert.equal(steps.length, 1);
  clock.onAnimationFrame(133.6);
  assert.equal(steps.length, 2);
  assert.ok(Math.abs(steps[1] - 16.7) < 0.001);
});

test("fallback does not double-step when rAF is active", () => {
  const steps = [];
  const clock = createPetLoopClock((dt) => steps.push(dt), {
    isVisible: () => true,
    rafStaleMs: 80,
  });
  clock.seed(0);
  clock.onAnimationFrame(16);
  clock.onFallbackTimer(20);
  assert.deepEqual(steps, [16]);
});

test("fallback does not advance while hidden", () => {
  let visible = true;
  const steps = [];
  const clock = createPetLoopClock((dt) => steps.push(dt), {
    isVisible: () => visible,
    rafStaleMs: 10,
  });
  clock.seed(0);
  visible = false;
  clock.onFallbackTimer(500);
  assert.deepEqual(steps, []);
});

test("visibility resume resets timing without a huge jump", () => {
  const steps = [];
  const clock = createPetLoopClock((dt) => steps.push(dt), { isVisible: () => true });
  clock.seed(0);
  clock.onAnimationFrame(16);
  clock.onVisibilityChange(10_000);
  clock.onAnimationFrame(10_016);
  assert.deepEqual(steps, [16, 16]);
});
