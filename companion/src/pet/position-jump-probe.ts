// PRIVATE — remove before next PR: temporary diagnostics for unexplained cat teleport / center respawn.
// Wired from `main.ts` when `HABITAT_DEBUG_LOG` / presentation `debugLog` is on.

export type PositionJumpProbeSink = (event: string, message: string) => void;

let sink: PositionJumpProbeSink | null = null;

/** Enables `emitPositionJumpProbe` delivery into runtime logs (`main.ts`). */
export function setPositionJumpProbeSink(next: PositionJumpProbeSink | null): void {
  sink = next;
}

export function emitPositionJumpProbe(event: string, message: string): void {
  sink?.(event, message);
}
