/**
 * TEMPORARY — delete this file once fall-landing freezes are understood and fixed.
 * Wired from `main.ts` when `socrates --debug` (`presentation.debugLog`).
 * Search logs for: `pet/fall_probe`.
 */

export type FallProbeSink = (
  source: string,
  event: string,
  message: string,
) => void;

let enabled = false;
let sink: FallProbeSink = () => {};

export function setFallProbeSink(next: FallProbeSink): void {
  sink = next;
}

export function setFallProbeEnabled(on: boolean): void {
  enabled = on;
}

export function fallProbe(event: string, message: string): void {
  if (!enabled) {
    return;
  }
  sink("pet/fall_probe", event, message);
}
