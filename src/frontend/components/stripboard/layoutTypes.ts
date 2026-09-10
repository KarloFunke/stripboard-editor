import { BoardPosition, Cut } from "@/types";

// Shared contract between the two layout engines (autoLayout = v1,
// autoLayout2 = v2), the worker transport, and the store's apply logic.

// Published iteration of the v2 ("strip-first") layouter, recorded on every
// applied result so stored boards can be grouped by the solver that made
// them. Bump on any change that alters the layouts users get.
export const LAYOUT_VERSION = "2.1.3";

// The shipped default for the layout portfolio: one alternative layout per
// worker, all solved in one wave on three quarters of the machine's cores,
// so every layout gets the full time budget and none queues behind another.
// The user picks the count directly; 1 turns the portfolio off.
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
