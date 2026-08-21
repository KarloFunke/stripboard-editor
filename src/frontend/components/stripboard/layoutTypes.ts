import { BoardPosition, Cut } from "@/types";

// Shared contract between the two layout engines (autoLayout = v1,
// autoLayout2 = v2), the worker transport, and the store's apply logic.

// Published iteration of the v2 ("strip-first") layouter, recorded on every
// applied result so stored boards can be grouped by the solver that made
// them. Bump on any change that alters the layouts users get.
export const LAYOUT_VERSION = "2.1.3";

// The shipped default for the portfolio search: solve this many alternative
// input orderings (boards) and apply the best, on three quarters of the
// machine's cores. A count of 1 turns the portfolio off (single solve). A
// fixed count is machine-independent, unlike the earlier time budget: the
// same count always solves the same set of orderings.
//
// The default is size-aware, aiming to keep a first click under ~30 s on an
// average machine (assumed 8 cores / 6 workers, 3x slower than the corpus
// benchmark box — which cancels the benchmark's ~3x contention inflation,
// so sweep times read as average-solo times). 10 boards = two waves of 6,
// so the corpus timing bands give: up to 30 parts ~2x(p90 ~17 s) stays near
// the aim; 31-40 parts drop to one wave of 3 (p90 ~27 s); beyond 40 even a
// single solve runs ~23 s median, so the portfolio waits for the user to
// opt in via the slider.
export function defaultPermBoards(parts: number): number {
  if (parts > 40) return 1;
  if (parts > 30) return 3;
  return 10;
}
export function defaultPermWorkers(cores: number): number {
  return Math.max(1, Math.floor((cores * 3) / 4));
}

export interface LayoutPlacement {
  componentId: string;
  boardPos: BoardPosition;
  flexibleEndPos?: BoardPosition; // flexible parts only
  rotation?: 0 | 90 | 180 | 270; // rigid parts only
}

export interface AutoLayoutResult {
  placements: LayoutPlacement[];
  // Full new sets: auto-layout regenerates cuts and wires, it does not augment
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
  // What the user would see: conflicts*100 + incomplete nets + unplaced*2.
  // 0 = fully solved. Lets parallel runs pick the best result.
  quality: number;
  // Nets that could not be completed (for highlighting in the UI)
  starvedNetIds: string[];
  // v2 layouter: the board size the layout was built for — applying the
  // result resizes the board (the solver chooses the size, not the user)
  boardSize?: { rows: number; cols: number };
  // Components that must be taken OFF the board (the new layout could not
  // place them); without this a stale position would survive the apply
  unplaceIds?: string[];
  // Beam-search experiment: the stage-2 ladder's distinct candidate pool,
  // ranked by (bad, cost). Attached only when beamIndex/beamStats is set.
  beamPool?: { bad: number; cost: number; rows: number; cols: number; label?: string }[];
  // How many tiles stage 1 ended up planning. The cluster cap only bounds
  // this: a tile too big for the dimension limits is split again, so the
  // count is the only honest measure of how the board was partitioned.
  // Benchmark instrumentation; the editor ignores it.
  tiles?: number;
}

// Coarse progress for a UI indicator: `frac` is 0..1 within the current
// attempt (attempts restart it — retries are not predictable up front).
export interface AutoLayoutProgress {
  phase: "arrange" | "place" | "repair";
  attempt: number;
  maxAttempts: number;
  frac: number;
}
