import { BoardPosition, Cut } from "@/types";

// Shared contract between the two layout engines (autoLayout = v1,
// autoLayout2 = v2), the worker transport, and the store's apply logic.

// Published iteration of the layouter that full runs use, recorded on every
// applied result so stored boards can be grouped by the solver that made
// them. Bump on any change that alters the layouts users get.
export const LAYOUT_VERSION = "5.3.0";

// The shipped default for the layout portfolio: one alternative layout per
// worker, all solved in one wave on three quarters of the machine's cores,
// so every layout gets the full time budget and none queues behind another.
// The user picks the count directly; 1 turns the portfolio off.
export function defaultPermWorkers(cores: number): number {
  return Math.max(1, Math.floor((cores * 3) / 4));
}

// v5 effort: the setting's stops, Quick to Exhaustive. A project stores the
// stop by its key (until 2026-09-27 the key was also the moves multiplier);
// what a stop runs comes from effortPlan.
export const V5_EFFORT_STOPS = [0.25, 0.5, 1, 2, 4];
export const V5_EFFORT_DEFAULT = 0.5;

/** What one effort stop runs: how many layouts, and each one's moves as a multiple of the pin-count formula. */
export interface EffortPlan { seeds: number; effort: number }

// Fitted on the sweep of 2026-09-27 (auto-layouter-data/movelog/sweep-2026-09-27:
// 200 projects under 50 pins, 80 of 50-100, 40 of 100-200 and the 4 stacked
// ones, up to 32 seeds at each of seven move levels, the best of every seed
// count from their order statistics). Each stop takes the seeds and moves that
// deliver the cheapest board, messy wires priced as in the anneal, within its
// CPU: Normal the CPU of eight layouts at half the formula, Quick half of it,
// Thorough, Very thorough and Exhaustive two, four and sixteen times, and no
// stop under 1, 3, 6, 12 and 48 s on a typical 8-thread PC (WebAssembly runs
// 1.18x native with twelve layouts at once); a stop never searches shorter
// than the one before. Small circuits gain most from many short searches, big
// ones from long ones. Messy wires counted as the editor counts them: refitted
// 2026-09-28, when the harness turned out to measure parts without their
// package, which had made long searches on big boards look messy. Exhaustive
// doubles the seeds of the best measured plan at 50-99 pins and stacked (more
// seeds are never worse).
const EFFORT_PLANS: { maxPins: number; stops: EffortPlan[] }[] = [
  { maxPins: 25, stops: [{ seeds: 16, effort: 1 / 8 }, { seeds: 32, effort: 1 / 8 }, { seeds: 32, effort: 1 / 4 }, { seeds: 32, effort: 1 / 2 }, { seeds: 32, effort: 1 }] },
  { maxPins: 50, stops: [{ seeds: 8, effort: 1 / 8 }, { seeds: 16, effort: 1 / 8 }, { seeds: 32, effort: 1 / 8 }, { seeds: 32, effort: 1 / 2 }, { seeds: 32, effort: 1 }] },
  { maxPins: 100, stops: [{ seeds: 4, effort: 1 / 2 }, { seeds: 8, effort: 1 / 2 }, { seeds: 10, effort: 1 }, { seeds: 16, effort: 1 }, { seeds: 32, effort: 1 }] },
  { maxPins: Infinity, stops: [{ seeds: 4, effort: 1 / 2 }, { seeds: 8, effort: 1 / 2 }, { seeds: 16, effort: 1 / 2 }, { seeds: 8, effort: 2 }, { seeds: 8, effort: 4 }] },
];
// Stacked: 8 x 4 was checked against 16 x 2 on 2026-09-28 (the four stacked
// corpus boards and a 3-bit ADC) and lost on three of five, 2.6 % on average.
const STACKED_PLAN: EffortPlan[] = [{ seeds: 4, effort: 1 / 2 }, { seeds: 8, effort: 1 / 2 }, { seeds: 8, effort: 1 }, { seeds: 8, effort: 2 }, { seeds: 16, effort: 2 }];

/** The layouts and moves of an effort stop on a circuit of nPins wired pins (stacked: the stacked solve). */
export function effortPlan(stop: number, nPins: number, stacked: boolean): EffortPlan {
  const i = V5_EFFORT_STOPS.indexOf(stop);
  const stops = stacked ? STACKED_PLAN : (EFFORT_PLANS.find((r) => nPins < r.maxPins) ?? EFFORT_PLANS[EFFORT_PLANS.length - 1]).stops;
  return stops[i >= 0 ? i : V5_EFFORT_STOPS.indexOf(V5_EFFORT_DEFAULT)];
}

/** Moves per v5 layout at an effort: the pin-count formula times the effort. */
export function effortMoves(nPins: number, effort: number): number {
  // small circuits search briefly, many times over (effortPlan); the floor was 40000 until 2026-09-27
  return Math.max(5000, Math.round(16000 * Math.max(0, nPins - 13) * effort));
}

// A first-run estimate of a layout's seconds at an effort, from the mean time
// of decoding random genomes on this machine (the worker's speed probe).
// Random genomes decode slower than the anneal's proposals, and more so on
// big boards, so a move costs probe^0.7 rather than the probe: fitted
// 2026-09-26 on the Thorough run of all 984 joint projects (pins, parts, nets
// or connectors add nothing once the probe is in), coefficient refitted
// 2026-09-28 on 48 of them with twelve layouts at once in WebAssembly (80 %
// within 0.92-1.5x). Stacked: 4 boards, ±30 %.
export function probeRunS(msPerDecode: number, nPins: number, effort: number, stacked: boolean): number {
  const moves = effortMoves(nPins, effort);
  return stacked ? (msPerDecode * 0.015 * moves) / 1000 : 6.3e-5 * Math.pow(msPerDecode, 0.7) * moves;
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
