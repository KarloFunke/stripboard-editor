import { BoardPosition, Cut } from "@/types";

// Shared contract between the two layout engines (autoLayout = v1,
// autoLayout2 = v2), the worker transport, and the store's apply logic.

// The shipped default for the portfolio search: keep solving alternative
// input orderings for this many seconds, on half the machine's cores. An
// explicit 0 in the project turns the portfolio off.
export const DEFAULT_PERM_TIME_BUDGET = 5;
export function defaultPermWorkers(cores: number): number {
  return Math.max(1, Math.floor(cores / 2));
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
