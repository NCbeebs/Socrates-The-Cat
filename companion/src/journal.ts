import type { PetDrawState } from "./pet/habitat-pet";

export interface LogEntry {
  level: "journal" | "info" | "warn" | "error" | "debug";
  source: string;
  event: string;
  message: string;
  details?: string;
}

/** Observe semantic states, never frame indices or coordinates. */
export class ActivityJournal {
  private current = "";
  private readonly lastWritten = new Map<string, number>();
  private readonly variations = new Map<string, number>();

  constructor(private readonly write: (entry: LogEntry) => void) {}

  observe(state: Pick<PetDrawState, "activityId" | "animationKey" | "motionPhase" | "overlayAnimationKey">, now = Date.now()) {
    const { activityId: activity, animationKey: animation, motionPhase: motion } = state;
    let key = activity;
    let phrases: string[] | undefined;
    if (motion === "falling") {
      key = "falling";
      phrases = ["Taking the scenic route down.", "An unexpected change of altitude."];
    } else if (motion === "cling" || activity === "ride_grip") {
      key = "climbing";
      phrases = ["Holding on. Excellent view from here."];
    } else if (motion === "slide" || activity === "divider_slide") {
      key = "sliding";
      phrases = ["Sliding down to the next perch."];
    } else if (state.overlayAnimationKey === "annoyed") {
      key = "annoyed";
      phrases = ["Trying to nap. The cursor has other ideas."];
    } else if (activity === "sleep") {
      if (animation.startsWith("dream")) {
        // Different dream clips are one continuous nap, not new journal events.
        key = "dreaming";
        phrases = ["Dreaming. Paws twitching.", "Busy chasing something in a dream."];
      } else if (animation === "sleep_exit") {
        key = "waking";
        phrases = ["Awake. That was exhausting.", "Back from a very important nap."];
      } else if (animation === "sleep_enter") {
        key = "sleeping";
        phrases = ["Settling down for a nap.", "Time to rest these paws."];
      } else {
        return;
      }
    } else if (activity.startsWith("groom")) {
      key = "grooming";
      phrases = ["A little grooming. Standards matter.", "Putting every whisker back in place."];
    } else {
      phrases = {
        idle: ["Keeping you company.", "Surveying my domain."],
        walk: ["Patrolling the ledge.", "Taking a stroll. Everything needs inspecting."],
        sit_look: ["Sitting quietly. Watching that cursor."],
        pointer_swipe: ["Spotted the cursor. It knows what it did."],
        pointer_pounce: ["Pouncing on the cursor. Almost had it."],
        portal: ["Taking a shortcut through a portal."],
      }[activity];
    }
    if (key === this.current) return;
    this.current = key;
    if (!phrases || now - (this.lastWritten.get(key) ?? -Infinity) < 30_000) return;
    this.lastWritten.set(key, now);
    const variation = this.variations.get(key) ?? 0;
    this.variations.set(key, variation + 1);
    this.write({ level: "journal", source: "cat", event: key, message: phrases[variation % phrases.length] });
  }
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.stack ?? error.message}${cause && cause !== error ? `\nCaused by: ${String(cause)}` : ""}`;
  }
  try { return typeof error === "string" ? error : JSON.stringify(error) ?? String(error); }
  catch { return String(error); }
}
