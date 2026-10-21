const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const output = ts.transpileModule(readFileSync(path.join(__dirname, "../src/journal.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = {};
new Function("exports", output)(loaded);
const { ActivityJournal, errorDetails } = loaded;
const state = (activityId, animationKey = activityId, motionPhase = "grounded", overlayAnimationKey = null) => ({ activityId, animationKey, motionPhase, overlayAnimationKey });

test("journal records real transitions, groups grooming and dream variants, and limits repeats", () => {
  const entries = [];
  const journal = new ActivityJournal((entry) => entries.push(entry));
  journal.observe(state("walk"), 0);
  journal.observe(state("walk", "turn"), 16);
  journal.observe(state("groom_face"), 100);
  journal.observe(state("groom_body"), 200);
  journal.observe(state("walk"), 300);
  journal.observe(state("sleep", "sleep_enter"), 500);
  journal.observe(state("sleep", "dream_1"), 1000);
  journal.observe(state("sleep", "dream_2"), 2000);
  journal.observe(state("sleep", "sleep_exit"), 3000);
  journal.observe(state("walk"), 31_000);
  assert.deepEqual(entries.map((e) => e.event), ["walk", "grooming", "sleeping", "dreaming", "waking", "walk"]);
  assert.notEqual(entries[0].message, entries.at(-1).message);
});

test("motion and sleep reactions take precedence over the underlying activity", () => {
  const entries = [];
  const journal = new ActivityJournal((entry) => entries.push(entry));
  journal.observe(state("walk", "fall", "falling"), 0);
  journal.observe(state("ride_grip", "hang_vertical", "cling"), 100);
  journal.observe(state("divider_slide", "divider_slide_land", "slide"), 200);
  journal.observe(state("sleep", "dream_1", "grounded", "annoyed"), 300);
  assert.deepEqual(entries.map((e) => e.event), ["falling", "climbing", "sliding", "annoyed"]);
});

test("carry motion is journaled separately from idle", () => {
  const entries = [];
  const journal = new ActivityJournal((entry) => entries.push(entry));
  journal.observe(state("user_carry", "carried_pickup", "carried"), 0);
  journal.observe(state("idle", "idle", "grounded"), 100);
  assert.deepEqual(entries.map((e) => e.event), ["carried", "idle"]);
});

test("error details preserve stacks, causes and non-Error rejections", () => {
  const error = new Error("asset failed", { cause: new Error("not found") });
  assert.match(errorDetails(error), /asset failed[\s\S]*Caused by: Error: not found/);
  assert.equal(errorDetails({ reason: "backend failed" }), '{"reason":"backend failed"}');
});
