const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Exercise the runtime without a WebView or loading sprite images.
function loadTypeScript(filename) {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  const localRequire = (specifier) => loadTypeScript(path.resolve(path.dirname(filename), `${specifier}.ts`));
  new Function("require", "exports", outputText)(localRequire, exports);
  return exports;
}

const habitatPetModule = loadTypeScript(path.resolve(__dirname, "../src/pet/habitat-pet.ts"));
const {
  HabitatPet,
  buildSitLookAngleKeyframes,
  stepSitLookGazeCell,
  nearestSitLookGazeCell,
  pointerBearingDeg,
  convergeSitLookGazeCell,
  shortestSignedAngleDelta,
  SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG,
  stepCarryInputTransition,
  CARRY_HOLD_MS,
} = habitatPetModule;
const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../assets/pets/default-cat/pet.json"), "utf8"));
const meta = { observedAtMs: Date.now(), targetHwnd: 1, scanSequence: 1, surfaceSource: "file" };
const surface = (id, x0, x1, y) => ({ id, role: "ledge", walkable: true, a: { x: x0, y }, b: { x: x1, y }, confidence: 1 });

function clipPixelSize(anim) {
  const grid = anim.clipGrid ?? manifest.habitat.grid.clipGrid;
  const cell = anim.clipCellSize ?? manifest.habitat.grid.clipCellSize ?? manifest.habitat.grid.frameSize;
  if (grid?.columns && grid?.rows && cell) {
    return [grid.columns * cell[0], grid.rows * cell[1]];
  }
  return [512, 512];
}

function makePet() {
  const urls = Object.fromEntries(Object.values(manifest.habitat.animations).map((anim) => [anim.clip, anim.clip]));
  const pet = new HabitatPet(manifest, urls);
  for (const anim of Object.values(manifest.habitat.animations)) {
    pet.clipSizes.set(anim.clip, clipPixelSize(anim));
  }
  pet.activityMsLeft = Infinity;
  pet.portalCooldownUntilMs = Infinity;
  return pet;
}

function update(pet, surfaces, viewport, sx = 1, sy = sx, dt = 16, pointer = null, revision = 1, geometryMeta = meta) {
  return pet.update(dt, surfaces, sx, sy, viewport, pointer, revision, geometryMeta);
}

const liveMeta = (targetHwnd, scanSequence) => ({ observedAtMs: Date.now(), targetHwnd, scanSequence, surfaceSource: "live" });
const statusBar = (x1, y) => ({ ...surface("platform-statusbar-top", 0, x1, y), role: "platform" });

/** Run fall frames until the land clip starts; returns the contact ledge id or null. */
function fallUntilLand(pet, surfaces, viewport, dt, maxMs = 4000) {
  for (let t = 0; t < maxMs; t += dt) {
    update(pet, surfaces, viewport, 1, 1, dt);
    if (pet.fallPhase === "land") return pet.attachment?.surfaceId ?? null;
  }
  return null;
}

function assertInside(state, viewport) {
  const [fw, fh] = manifest.habitat.grid.frameSize;
  assert.ok(Math.round(state.x) >= 0, `left edge: ${state.x}`);
  assert.ok(Math.round(state.y) >= 0, `top edge: ${state.y}`);
  assert.ok(Math.round(state.x) + fw * state.scale <= viewport.w + 0.001, `right edge: ${state.x}`);
  assert.ok(Math.round(state.y) + fh * state.scale <= viewport.h + 0.001, `bottom edge: ${state.y}`);
}

const sitLookAngles = manifest.habitat.animations.sit_look.sitLook.lookAngleByCell;
const sitLookKeyframes = buildSitLookAngleKeyframes(sitLookAngles);

function gazeAngleForCell(cell) {
  return sitLookAngles[String(cell)];
}

test("sit look gaze converges for every authored start/target angle pair", () => {
  for (const start of sitLookKeyframes) {
    for (const target of sitLookKeyframes) {
      const { cell, steps } = convergeSitLookGazeCell(
        start.cell,
        target.angleDeg,
        sitLookAngles,
        sitLookKeyframes,
      );
      assert.ok(steps < 256, `start ${start.angleDeg}° → ${target.angleDeg}° did not converge`);
      const finalAngle = gazeAngleForCell(cell);
      const err = Math.abs(shortestSignedAngleDelta(finalAngle, target.angleDeg));
      const nearest = nearestSitLookGazeCell(
        target.angleDeg,
        sitLookAngles,
        cell,
        SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG,
      );
      const nearestAngle = gazeAngleForCell(nearest);
      const nearestErr = Math.abs(shortestSignedAngleDelta(nearestAngle, target.angleDeg));
      assert.ok(
        err <= nearestErr + 0.01,
        `start ${start.angleDeg}° target ${target.angleDeg}° landed cell ${cell} (${finalAngle}°)`,
      );
    }
  }
});

test("sit look gaze at 135° reaches 70° bearing without passing 325°", () => {
  const path = [58];
  let cell = 58;
  for (let i = 0; i < 64; i += 1) {
    cell = stepSitLookGazeCell(cell, 70, sitLookAngles, sitLookKeyframes);
    path.push(cell);
    if (gazeAngleForCell(cell) === 70) {
      break;
    }
  }
  assert.ok(!path.includes(36), `must not pass 325° cell: ${path.join("→")}`);
  assert.equal(gazeAngleForCell(cell), 70);
});

test("sit look bearing boundary hysteresis near 102.5°", () => {
  const cell70 = 32;
  const a = nearestSitLookGazeCell(102.4, sitLookAngles, cell70, SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG);
  const b = nearestSitLookGazeCell(102.6, sitLookAngles, a, SIT_LOOK_ANGLE_SWITCH_MARGIN_DEG);
  assert.equal(a, cell70);
  assert.equal(b, a);
});

test("sit look increasing bearing steps through higher look angles (235° → 255°)", () => {
  let cell = 46;
  assert.equal(gazeAngleForCell(cell), 235);
  cell = stepSitLookGazeCell(cell, 245, sitLookAngles, sitLookKeyframes);
  assert.equal(gazeAngleForCell(cell), 245);
  cell = stepSitLookGazeCell(cell, 255, sitLookAngles, sitLookKeyframes);
  assert.equal(gazeAngleForCell(cell), 255);
});

test("sit look bearing uses math unit circle (up = 90°)", () => {
  assert.ok(Math.abs(pointerBearingDeg(0, 0, 0, -100) - 90) < 0.01);
  assert.ok(Math.abs(pointerBearingDeg(0, 0, 100, 0) - 0) < 0.01);
});

test("sit look intro, neutral hold, and stand-up exit reuse frameIndex", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.beginSitLookIntro();
  pet.activityId = "sit_look";
  pet.activityMsLeft = Infinity;
  for (let i = 0; i < 20; i += 1) {
    update(pet, surfaces, viewport, 1, 1, 100, null);
  }
  assert.equal(pet.sitLookPhase, "gaze");
  assert.equal(pet.frameIndex, 17);
  for (let i = 0; i < 8; i += 1) {
    update(pet, surfaces, viewport, 1, 1, 16, null);
  }
  assert.equal(pet.frameIndex, 17);
  pet.beginSitLookExit();
  assert.equal(pet.sitLookPhase, "exit");
  for (let i = 0; i < 24; i += 1) {
    update(pet, surfaces, viewport, 1, 1, 100, null);
  }
  assert.equal(pet.sitLookPhase, null);
});

test("sit look draw stays unmirrored while facing left", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [], viewport);
  pet.facingLeft = true;
  pet.beginSitLookIntro();
  pet.sitLookPhase = "gaze";
  pet.frameIndex = 17;
  const state = pet.toDrawState(pet.viewScale, 1, 1);
  assert.equal(state.flipX, false);
});

test("sit look motion sampler resets on HWND change", () => {
  const pet = makePet();
  pet.activityId = "sit_look";
  pet.sitLookPhase = "gaze";
  pet.sitLookLastMotionSample = { x: 0, y: 0, t: 0, targetHwnd: 1 };
  pet.sitLookPointerSpeedPxPerSec = 0;
  pet.updateSitLookPointerSpeed(
    {
      x: 900,
      y: 0,
      primaryButtonDown: false,
      targetHwnd: 2,
      observedAtMs: 50,
    },
    50,
  );
  assert.ok(pet.sitLookPointerSpeedPxPerSec < 100);
});

test("interrupting swipe from sit faces the cursor on the first swipe frame", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.facingLeft = true;
  pet.activityId = "sit_look";
  pet.sitLookPhase = "gaze";
  pet.frameIndex = 17;
  pet.localX = 200;
  pet.localY = 595;
  const pointer = {
    x: 320,
    y: 580,
    primaryButtonDown: false,
    targetHwnd: 1,
    observedAtMs: Date.now(),
  };
  pet.frameValidatedPointer = pointer;
  pet.startPointerSwipe();
  assert.equal(pet.facingLeft, false);
  const state = pet.toDrawState(pet.viewScale, 1, 1);
  assert.equal(state.animationKey, "swipe");
  assert.equal(state.flipX, false);
});

test("sash cling clears sit look phase", () => {
  const pet = makePet();
  update(pet, [], { w: 800, h: 600 });
  pet.activityId = "sit_look";
  pet.sitLookPhase = "gaze";
  pet.sitLookAngleKeyframes = sitLookKeyframes;
  pet.beginSashCling({
    trackKey: 1,
    y: 120,
    velocityY: -40,
    x0: 0,
    x1: 800,
  });
  assert.equal(pet.sitLookPhase, null);
  assert.equal(pet.sitLookAngleKeyframes.length, 0);
});

test("walking turns before either window edge and excludes ledges without headroom", () => {
  for (const facingLeft of [false, true]) {
    const pet = makePet();
    const viewport = { w: 800, h: 600 };
    const surfaces = [surface("tab-strip", 0, 800, 30), surface("floor", 0, 800, 595)];
    update(pet, surfaces, viewport);
    assert.equal(pet.attachment.surfaceId, "floor");
    pet.facingLeft = facingLeft;
    pet.activityId = "walk";
    pet.animationKey = "walk";
    let turned = false;
    for (let i = 0; i < 600; i++) {
      const state = update(pet, surfaces, viewport, 1, 1, 48);
      assertInside(state, viewport);
      if (state.animationKey === "turn") { turned = true; break; }
    }
    assert.ok(turned, "walking should turn instead of pushing against the safety clamp");
  }
});

test("all animation pivots and pounce contacts fit at every corner in both directions", () => {
  const viewport = { w: 800, h: 600 };
  const pet = makePet();
  update(pet, [], viewport);
  for (const animationKey of Object.keys(manifest.habitat.animations)) {
    for (const facingLeft of [false, true]) {
      for (const [x, y] of [[-100, -100], [900, -100], [-100, 700], [900, 700]]) {
        for (const gridCell of animationKey === "pounce" ? [7, 8, 9, 10, 11] : [0]) {
          pet.animationKey = animationKey;
          pet.facingLeft = facingLeft;
          pet.pouncePlayback = animationKey === "pounce" ? { gridCell } : null;
          pet.localX = x;
          pet.localY = y;
          const state = pet.toDrawState(pet.viewScale, 1, 1);
          assertInside(state, viewport);
          assert.equal(state.x, pet.localX - pet.pivotForDraw(animationKey)[0] * state.scale);
        }
      }
    }
  }
});

// Regression: the land check rejected crossings whose post-step foot overshot the ledge by >8 px,
// so fast falls passed through and froze at the window-bottom clamp.
for (const dtMs of [16, 16.67, 33, 48]) {
  test(`falls land on every crossed ledge regardless of per-step overshoot (dt=${dtMs}ms)`, () => {
    const viewport = { w: 1600, h: 1100 };
    const surfaces = [surface("tab", 0, 1600, 40), surface("shelf", 0, 1600, 500), statusBar(1600, 1056)];
    for (let y = 60; y < 480; y += 7) {
      const pet = makePet();
      update(pet, surfaces, viewport);
      pet.localX = 400;
      pet.localY = y;
      pet.beginFall();
      assert.equal(fallUntilLand(pet, surfaces, viewport, dtMs), "shelf", `start y=${y}`);
      assert.equal(pet.localY, 500);
    }
  });
}

test("empty snapshot during the land clip still finishes landing", () => {
  const pet = makePet();
  const viewport = { w: 1600, h: 1100 };
  const surfaces = [surface("shelf", 0, 1600, 500), statusBar(1600, 1056)];
  update(pet, surfaces, viewport);
  pet.localX = 400;
  pet.localY = 480;
  pet.beginFall();
  assert.equal(fallUntilLand(pet, surfaces, viewport, 16), "shelf");
  update(pet, [], viewport);
  for (let i = 0; i < 200; i++) update(pet, surfaces, viewport);
  assert.equal(pet.motionPhase, "grounded");
  assert.equal(pet.fallPhase, null);
  assert.equal(pet.animationKey, "idle");
});

test("empty snapshot mid-fall does not respawn the cat on the best ledge", () => {
  const pet = makePet();
  const viewport = { w: 1600, h: 1100 };
  const surfaces = [surface("tab", 0, 1600, 40), surface("shelf", 0, 1600, 500), statusBar(1600, 1056)];
  update(pet, surfaces, viewport);
  pet.localX = 300;
  pet.localY = 200;
  pet.beginFall();
  update(pet, [], viewport);
  update(pet, surfaces, viewport);
  assert.equal(pet.motionPhase, "falling");
  assert.equal(pet.localX, 300);
  assert.equal(fallUntilLand(pet, surfaces, viewport, 16), "shelf");
});

test("fall starting below every ledge lands on the status bar", () => {
  const pet = makePet();
  const viewport = { w: 1600, h: 1100 };
  const surfaces = [surface("tab", 0, 1600, 40), statusBar(1600, 1056)];
  update(pet, surfaces, viewport);
  pet.localX = 400;
  pet.localY = 1090;
  pet.beginFall();
  assert.equal(fallUntilLand(pet, surfaces, viewport, 16), "platform-statusbar-top");
  assert.equal(pet.localY, 1056);
});

test("tracked IDE HWND change falls instead of re-syncing the same ledge id", () => {
  const pet = makePet();
  const viewport = { w: 1600, h: 1100 };
  const statusA = statusBar(1600, 1056);
  update(pet, [statusA], viewport, 1, 1, 16, null, 10, liveMeta(0x10856, 10));
  pet.localX = 1182;
  pet.localY = 1056;
  pet.attachment = { kind: "ledge", surfaceId: "platform-statusbar-top", t: 0.75 };
  pet.motionPhase = "grounded";
  pet.animationKey = "dream_comfy";
  const statusB = statusBar(1600, 942);
  update(pet, [statusB], viewport, 1, 1, 16, null, 12, liveMeta(0x200fa0, 12));
  assert.equal(pet.motionPhase, "falling");
  assert.equal(pet.attachment, null);
  assert.ok(Math.abs(pet.localX - 1182) < 50, `unexpected foot X snap via ledge re-sync: ${pet.localX}`);
});

test("IDE window switch to a shorter window lands on its status bar", () => {
  const pet = makePet();
  const surfacesA = [surface("tab", 0, 1600, 40), surface("explorer", 0, 1600, 900), statusBar(1600, 1056)];
  update(pet, surfacesA, { w: 1600, h: 1100 }, 1, 1, 16, null, 1, liveMeta(1, 1));
  pet.attachment = { kind: "ledge", surfaceId: "explorer", t: 0.25 };
  pet.localY = 900;
  update(pet, surfacesA, { w: 1600, h: 1100 }, 1, 1, 16, null, 1, liveMeta(1, 2));
  const viewportB = { w: 1600, h: 700 };
  const surfacesB = [surface("tab", 0, 1600, 40), statusBar(1600, 656)];
  for (let i = 0; i < 20; i++) update(pet, [], viewportB, 1, 1, 16, null, 2, liveMeta(2, 3 + i));
  for (let i = 0; i < 300; i++) update(pet, surfacesB, viewportB, 1, 1, 16, null, 3, liveMeta(2, 30 + i));
  assert.equal(pet.motionPhase, "grounded");
  assert.equal(pet.fallPhase, null);
  assert.equal(pet.attachment?.surfaceId, "platform-statusbar-top");
  assert.equal(pet.localY, 656);
});

test("resizing and nonuniform DPI mapping constrain active falls, even without geometry", () => {
  const pet = makePet();
  update(pet, [surface("floor", 0, 1600, 1000)], { w: 1600, h: 1100 });
  pet.beginFall();
  for (const [viewport, sx, sy] of [
    [{ w: 640, h: 480 }, 0.5, 0.5],
    [{ w: 320, h: 240 }, 0.5, 0.75],
    [{ w: 80, h: 60 }, 1, 1],
    [{ w: 1600, h: 1000 }, 1, 1],
  ]) {
    pet.localX = 2000;
    pet.localY = 2000;
    assertInside(update(pet, [], viewport, sx, sy), viewport);
  }
});

test("portal endpoints stay inside the window and interior ledges retain their geometry", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595), surface("interior", 200, 600, 300)];
  update(pet, surfaces, viewport);
  const ledges = pet.collectLedges(surfaces);
  assert.deepEqual(ledges.find((l) => l.id === "interior"), {
    id: "interior", role: "ledge", x0: 200, x1: 600, y: 300, length: 400, confidence: 1,
  });
  for (const end of ["left", "right"]) {
    pet.attachToLedgeEndpoint(ledges[0], end);
    pet.animationKey = "portal_exit";
    assertInside(pet.toDrawState(pet.viewScale, 1, 1), viewport);
  }
});

const wallSurface = (x, y0, y1) => ({
  id: `wall-v-${x}`,
  role: "wall",
  walkable: false,
  climbable: true,
  confidence: 1,
  a: { x, y: y0 },
  b: { x, y: y1 },
});

test("divider slide route prefers nearest lower ledge sharing the window edge", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [], viewport);
  const surfaces = [
    surface("top", 0, 800, 40),
    surface("lower-right", 620, 800, 220),
    surface("lower-full", 0, 800, 480),
  ];
  const top = pet.collectRawWalkableHorizontals(surfaces).find((l) => l.id === "top");
  const route = pet.findDividerSlideRoute(
    surfaces,
    top,
    "right",
    1,
    pet.collectLedges(surfaces),
  );
  assert.ok(route);
  assert.equal(route.destSurfaceId, "lower-right");
  assert.equal(route.wallId, "wall-window-right");
});

test("divider slide rejects a lower ledge that does not reach the same window edge", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [], viewport);
  const surfaces = [
    surface("top", 0, 800, 40),
    surface("short-panel", 0, 520, 220),
  ];
  const top = pet.collectRawWalkableHorizontals(surfaces).find((l) => l.id === "top");
  assert.equal(
    pet.findDividerSlideRoute(
      surfaces,
      top,
      "right",
      1,
      pet.collectLedges(surfaces),
    ),
    null,
  );
});

test("divider slide skips an invalid nearest ledge and uses the next valid one", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [], viewport);
  const surfaces = [
    surface("top", 0, 800, 120),
    surface("narrow-edge", 715, 800, 200),
    surface("full-lower", 0, 800, 380),
  ];
  const top = pet.collectRawWalkableHorizontals(surfaces).find((l) => l.id === "top");
  const route = pet.findDividerSlideRoute(
    surfaces,
    top,
    "right",
    1,
    pet.collectLedges(surfaces),
  );
  assert.ok(route);
  assert.equal(route.destSurfaceId, "full-lower");
});

test("divider slide intro survives activity expiry on the start frame", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [
    surface("upper-right", 600, 800, 120),
    surface("lower-right", 600, 800, 360),
    wallSurface(800, 120, 600),
  ];
  update(pet, surfaces, viewport);
  pet.activityId = "walk";
  pet.animationKey = "walk";
  pet.facingLeft = false;
  pet.activityMsLeft = 1;
  const ledges = pet.collectLedges(surfaces);
  const upper = ledges.find((l) => l.id === "upper-right");
  pet.attachToLedgeEndpoint(upper, "right");
  const random = Math.random;
  Math.random = () => 0;
  update(pet, surfaces, viewport, 1, 1, 16);
  assert.equal(pet.dividerSlidePhase, "intro");
  assert.equal(pet.animationKey, "divider_slide_intro");
  Math.random = random;
});

test("divider slide endpoint roll starts slide or turn without portal on that frame", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [
    surface("upper-right", 600, 800, 120),
    surface("lower-right", 600, 800, 360),
    wallSurface(800, 120, 600),
  ];
  update(pet, surfaces, viewport);
  pet.activityId = "walk";
  pet.animationKey = "walk";
  pet.facingLeft = false;
  const margin = pet.footMarginLocal();
  const ledges = pet.collectLedges(surfaces);
  const upper = ledges.find((l) => l.id === "upper-right");
  assert.ok(upper, "upper-right ledge should be drawable");
  pet.attachToLedgeEndpoint(upper, "right");
  pet.localX = upper.x1 - margin;
  const random = Math.random;
  Math.random = () => 0.99;
  update(pet, surfaces, viewport, 1, 1, 16);
  assert.equal(pet.animationKey, "turn");
  assert.equal(pet.dividerSlidePhase, "awake");
  Math.random = () => 0;
  pet.animationKey = "walk";
  pet.dividerSlidePhase = "awake";
  pet.portalPhase = "awake";
  update(pet, surfaces, viewport, 1, 1, 16);
  assert.equal(pet.dividerSlidePhase, "intro");
  assert.equal(pet.portalPhase, "awake");
  Math.random = random;
});

test("divider slide stays inside the window through descent and landing", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [
    surface("upper-right", 600, 800, 120),
    surface("lower-right", 600, 800, 360),
    wallSurface(800, 120, 600),
  ];
  update(pet, surfaces, viewport);
  pet.activityId = "walk";
  pet.facingLeft = false;
  const ledges = pet.collectLedges(surfaces);
  const upper = ledges.find((l) => l.id === "upper-right");
  assert.ok(upper);
  pet.attachToLedgeEndpoint(upper, "right");
  const random = Math.random;
  Math.random = () => 0;
  update(pet, surfaces, viewport, 1, 1, 16);
  for (let i = 0; i < 400; i++) {
    const state = update(pet, surfaces, viewport, 1, 1, 32);
    assertInside(state, viewport);
    if (pet.dividerSlidePhase === "awake" && pet.activityId === "walk") {
      break;
    }
  }
  assert.equal(pet.dividerSlidePhase, "awake");
  Math.random = random;
});

test("beginFall clears divider slide ownership", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [], viewport);
  pet.portalPhase = "opening";
  pet.dividerSlidePhase = "descend";
  pet.motionPhase = "slide";
  pet.slideRoute = {
    targetHwnd: 1,
    wallId: "wall-v-400",
    destSurfaceId: "floor",
    sourceSurfaceId: "top",
    end: "right",
    gripX: 400,
    landingX: 400,
    landingY: 220,
  };
  pet.beginFall();
  assert.equal(pet.dividerSlidePhase, "awake");
  assert.equal(pet.portalPhase, "awake");
});

test("carry input requires release before arming after startup", () => {
  let phase = "disarmed";
  let hold = null;
  let r = stepCarryInputTransition(phase, hold, true, true, 1000, false);
  assert.equal(r.phase, "disarmed");
  assert.equal(r.beginCarry, false);
  r = stepCarryInputTransition(r.phase, r.holdStartedAtMs, false, false, 1001, false);
  assert.equal(r.phase, "armed");
  r = stepCarryInputTransition(r.phase, r.holdStartedAtMs, true, true, 1002, false);
  assert.equal(r.phase, "hold_pending");
  r = stepCarryInputTransition(
    r.phase,
    r.holdStartedAtMs,
    true,
    true,
    1002 + CARRY_HOLD_MS,
    false,
  );
  assert.equal(r.beginCarry, true);
});

test("carry pending hold clears on invalid input until release", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.localX = 400;
  pet.localY = 595;
  const t0 = Date.now();
  const ptr = (down, t = Date.now()) => ({
    x: 400,
    y: 580,
    primaryButtonDown: down,
    targetHwnd: 1,
    observedAtMs: t,
  });
  update(pet, surfaces, viewport, 1, 1, 16, ptr(false, t0));
  update(pet, surfaces, viewport, 1, 1, 16, ptr(true, t0 + 10));
  assert.equal(pet.carryInputPhase, "hold_pending");
  update(pet, surfaces, viewport, 1, 1, 16, null);
  assert.equal(pet.carryInputPhase, "disarmed");
  update(pet, surfaces, viewport, 1, 1, 16, ptr(true, t0 + CARRY_HOLD_MS + 500));
  assert.notEqual(pet.motionPhase, "carried");
});

test("carry input disarms on press outside reach until release", () => {
  let r = stepCarryInputTransition("armed", null, true, false, 0, false);
  assert.equal(r.phase, "disarmed");
  r = stepCarryInputTransition("disarmed", null, true, true, 100, false);
  assert.equal(r.phase, "disarmed");
  r = stepCarryInputTransition("disarmed", null, false, false, 200, false);
  assert.equal(r.phase, "armed");
});

test("carry ends on button release while active", () => {
  const r = stepCarryInputTransition("armed", null, false, false, 0, true);
  assert.equal(r.endCarry, true);
});

test("pick up and drop via reach-box hold", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.localX = 400;
  pet.localY = 595;
  const ptr = (down, t = Date.now()) => ({
    x: 400,
    y: 580,
    primaryButtonDown: down,
    targetHwnd: 1,
    observedAtMs: t,
  });
  const t0 = Date.now();
  update(pet, surfaces, viewport, 1, 1, 16, ptr(false, t0));
  update(pet, surfaces, viewport, 1, 1, 16, ptr(true, t0 + 10));
  const held = update(
    pet,
    surfaces,
    viewport,
    1,
    1,
    16,
    ptr(true, t0 + CARRY_HOLD_MS + 20),
  );
  assert.equal(pet.motionPhase, "carried");
  assert.equal(held.activityId, "user_carry");
  update(pet, surfaces, viewport, 1, 1, 16, ptr(false, Date.now()));
  assert.equal(pet.motionPhase, "falling");
  assert.equal(pet.fallFromCarry, true);
});

test("abort carry preserves draw Y when switching from grip to fall", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.carryFacingLocked = false;
  pet.carryOwnerHwnd = 1;
  pet.animationKey = "carried_hold";
  pet.localX = 400;
  pet.localY = 300;
  const before = pet.toDrawState(pet.viewScale, 1, 1).y;
  pet.carryInputStaleMs = 500;
  update(pet, surfaces, viewport, 1, 1, 0, null);
  assert.equal(pet.motionPhase, "falling");
  assert.equal(pet.fallFromCarry, false);
  const after = pet.toDrawState(pet.viewScale, 1, 1).y;
  assert.ok(Math.abs(after - before) < 2, `draw Y jumped ${before} -> ${after}`);
});

test("HWND change during carry drop uses normal fall playback", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [surface("floor", 0, 800, 595)], viewport);
  pet.motionPhase = "falling";
  pet.fallPhase = "airborne";
  pet.fallFromCarry = true;
  pet.animationKey = "carried_release";
  pet.frameIndex = 2;
  pet.lastGeometryHwnd = 1;
  const meta = liveMeta(2, 2);
  pet.update(16, [surface("floor", 0, 800, 595)], 1, 1, viewport, null, 2, meta);
  assert.equal(pet.fallFromCarry, false);
  assert.equal(pet.animationKey, "fall");
});

test("carry drag swing follows horizontal motion and resets on release", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  update(pet, surfaces, viewport);
  pet.localX = 400;
  pet.localY = 595;
  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.carryFacingLocked = false;
  pet.animationKey = "carried_hold";
  pet.activityId = "user_carry";
  const t0 = Date.now();
  const ptr = (x, observedAtMs, down = true) => ({
    x,
    y: 300,
    primaryButtonDown: down,
    targetHwnd: 1,
    observedAtMs,
  });
  update(pet, surfaces, viewport, 1, 1, 16, ptr(400, t0));
  update(pet, surfaces, viewport, 1, 1, 50, ptr(460, t0 + 50));
  const dragged = pet.toDrawState(pet.viewScale, 1, 1);
  assert.ok(dragged.swingDeg > 0.5 && dragged.swingDeg <= 11);
  assert.equal(dragged.swingPivotX, 460);
  assert.equal(dragged.swingPivotY, 300);
  update(pet, surfaces, viewport, 1, 1, 16, ptr(460, t0 + 100, false));
  const released = pet.toDrawState(pet.viewScale, 1, 1);
  assert.equal(released.swingDeg, 0);
});

test("carry swing follows 50 ms samples consistently across render rates and facing", () => {
  for (const facingLeft of [false, true]) {
    for (const direction of [-1, 1]) {
      for (const frameMs of [10, 25]) {
        const pet = makePet();
        pet.carryFacingLocked = facingLeft;
        const sample = (t) => {
          const pollTime = Math.floor(t / 50) * 50;
          return {
            x: 400 + direction * Math.min(pollTime, 1000) * 0.1,
            y: 300,
            primaryButtonDown: true,
            targetHwnd: 1,
            observedAtMs: 1000 + pollTime,
          };
        };
        pet.tickCarrySwing(frameMs, sample(0));
        for (let t = frameMs; t <= 1000; t += frameMs) {
          pet.tickCarrySwing(frameMs, sample(t));
          if (t >= 800) {
            assert.ok(
              Math.abs(pet.carrySwingDeg - direction * 5.5) < 0.01,
              `steady swing: facingLeft=${facingLeft}, frameMs=${frameMs}, angle=${pet.carrySwingDeg}`,
            );
          }
        }
        for (let t = 1000 + frameMs; t <= 2000; t += frameMs) {
          pet.tickCarrySwing(frameMs, sample(t));
        }
        assert.ok(Math.abs(pet.carrySwingDeg) < 0.01, "stopping settles upright");
      }
    }
  }
});

test("carry swing settles on input loss and does not kick when coordinates return", () => {
  const pet = makePet();
  const sample = (x, t) => ({ x, y: 300, primaryButtonDown: true, targetHwnd: 1, observedAtMs: t });
  pet.tickCarrySwing(16, sample(400, 1000));
  pet.tickCarrySwing(50, sample(460, 1050));
  const movingAngle = pet.carrySwingDeg;
  for (let i = 0; i < 10; i++) pet.tickCarrySwing(40, null);
  assert.ok(Math.abs(pet.carrySwingDeg) < movingAngle * 0.02);
  const settledAngle = pet.carrySwingDeg;
  pet.tickCarrySwing(16, sample(800, 1500));
  assert.ok(Math.abs(pet.carrySwingDeg) <= settledAngle, "returning input seeds a new velocity sample");

  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.animationKey = "carried_hold";
  pet.abortCarryInterrupted();
  assert.equal(pet.carrySwingDeg, 0, "cancellation clears swing immediately");
});

test("carried hold ping-pongs authoring cells 7-11 (manifest indices 6-10)", () => {
  const holdFrames = manifest.habitat.animations.carried_hold.frames;
  assert.deepEqual(holdFrames, [6, 7, 8, 9, 10, 9, 8]);
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const surfaces = [surface("floor", 0, 800, 595)];
  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.animationKey = "carried_hold";
  pet.frameIndex = holdFrames.indexOf(10);
  const ptr = () => ({
    x: 400,
    y: 580,
    primaryButtonDown: true,
    targetHwnd: 1,
    observedAtMs: Date.now(),
  });
  const cells = [holdFrames[pet.frameIndex]];
  const frameMs = 1000 / 12;
  for (let i = 0; i < 7; i += 1) {
    update(pet, surfaces, viewport, 1, 1, frameMs + 1, ptr());
    cells.push(holdFrames[pet.frameIndex]);
  }
  assert.deepEqual(cells, [10, 9, 8, 6, 7, 8, 9, 10]);
});

test("carry grip anchor uses cursor IDE-local position", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  update(pet, [surface("floor", 0, 800, 595)], viewport);
  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.carryFacingLocked = false;
  pet.animationKey = "carried_hold";
  const ptr = {
    x: 412,
    y: 288,
    primaryButtonDown: true,
    targetHwnd: 1,
    observedAtMs: Date.now(),
  };
  update(pet, [surface("floor", 0, 800, 595)], viewport, 1, 1, 16, ptr);
  assert.equal(pet.localX, 412);
  assert.equal(pet.localY, 288);
});

test("carry drop lands on the first ledge crossed below the foot", () => {
  const pet = makePet();
  const viewport = { w: 800, h: 600 };
  const upper = surface("upper", 0, 800, 400);
  const lower = surface("lower", 0, 800, 595);
  update(pet, [upper, lower], viewport);
  pet.localX = 400;
  pet.localY = 395;
  pet.motionPhase = "carried";
  pet.carrySubPhase = "held";
  pet.carryFacingLocked = false;
  pet.animationKey = "carried_hold";
  pet.activityId = "user_carry";
  pet.beginCarryDrop();
  assert.equal(pet.fallFromCarry, true);
  const landed = fallUntilLand(pet, [upper, lower], viewport, 16);
  assert.equal(landed, "lower");
});
