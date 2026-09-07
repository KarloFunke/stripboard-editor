/**
 * Every measured number the paper cites, in one place.
 *
 * Source: the offline benchmark harness (tests/solver/sweep.js) over the
 * anonymized layout corpus, aggregated by tests/solver/paperStats.js.
 * Re-run the sweeps, re-run the aggregation, and edit this file; the prose
 * reads from it, so no figure can go stale on its own. The corpus itself is
 * user data and never leaves the local machine.
 *
 * ONE set of projects backs every figure here: the 210 whose author
 * provably never used the solver (last saved before it shipped, or created
 * after usage tracking went live with no recorded run) and whose stored
 * human layout is complete and conflict-free. That extraction yields 273;
 * two reference component definitions that no longer exist and are
 * unsolvable data rather than hard instances; 61 more were saved with a
 * short or an unconnected net. Tuning studies that need no human reference
 * (the cluster-size sweep, runtime profiling) ran over earlier, wider
 * extractions, but no number in the paper mixes the two.
 */

export const EVALUATED = {
  date: "23 August 2026",
  /** Solver source revision the sweeps ran at: v2.1.3 plus the broken-def
   * input validation and the harness lock fix (update this hash after
   * committing). The k = 10 run reproduced all 244 boards shared with the
   * previous corpus revision bit-for-bit. Every sweep runs the shipped
   * configuration, which has the tidy second pass on with an unlimited
   * growth allowance (sweep.js --tidy unlimited). */
  commit: "87b7e5c",
  hardware: "Ryzen 7 7800X3D, 12-way parallel sweep",
};

/** The evaluation corpus: projects whose human layout is a finished board. */
export const CORPUS = {
  projects: 210,
  /** stored projects in the prod copy of 22 August 2026 */
  stored: 796,
  /** provably solver-free: last saved before the solver shipped (16 July
   * 2026), or created after usage tracking went live (31 July 2026) with
   * no recorded run. The rest, uncertain or solver-touched, are dropped. */
  provable: 523,
  /** what the extraction of the provable set produced, before the filters */
  extracted: 273,
  /** dropped: parts naming component definitions that no longer exist */
  unresolvable: 2,
  /** dropped: human board saved with a short or an unconnected net */
  defective: 61,
  partsMedian: 12,
  partsP90: 31,
  partsMax: 55,
  netsMedian: 10,
  areaMedian: 239,
};

/**
 * The 61 projects the comparison subset drops for a defective human board.
 * Their netlists are sound; only the stored layout is defective, so the
 * solver still runs on them. These are the k = 10 portfolio results over
 * that set, from the same sweep as Table 2 (sweep-p22-perm10). No area
 * ratio is kept: an unfinished board is not an area reference.
 */
export const DEFECTIVE = {
  /** count is CORPUS.defective; all of them solve */
  complete: 61,
  offAxis: 14,
  crossings: 16,
  cleanBoards: 57,
};

/** Every extractable project regardless of provenance, k = 10: the 600
 * extracted minus the 3 whose data is unsolvable (two with missing
 * component definitions, one whose custom footprint shorts two nets on one
 * hole by definition). Includes 149 projects whose human layout was never
 * finished. The one incomplete result is the 3PDT switch limitation of
 * Section 9. */
export const FULLSET = {
  projects: 597,
  complete: 596,
};

/** The same 239 boards as their authors built them. */
export const HUMAN = {
  aspect: 1.5,
  aspectOver3: 22,
  offAxis: 151,
  crossings: 521,
  wires: 2024,
  cuts: 4331,
  stripCompletePct: 57,
  cleanBoards: 131,
};

export interface Config {
  label: string;
  note: string;
  /** projects laid out complete and conflict-free, out of the 239 */
  complete: number;
  areaRatio: number;
  aspect: number;
  aspectOver3: number;
  offAxis: number;
  crossings: number;
  wires: number;
  cuts: number;
  stripCompletePct: number;
  cleanBoards: number;
  /** median wall-clock per project: one circuit at a time, a portfolio's
   * orderings solved simultaneously in worker threads, as the editor runs
   * them (tests/solver/timeRun.js; results verified against the sweeps) */
  msMedian: number;
}

/** Unconstrained runs: solver picks the board size, nothing locked. */
export const FREE: Config[] = [
  {
    label: "Tidy pass disabled",
    note: "same solver, second pass off",
    complete: 210,
    areaRatio: 0.93,
    aspect: 1.6,
    aspectOver3: 27,
    offAxis: 140,
    crossings: 242,
    wires: 2423,
    cuts: 3337,
    stripCompletePct: 50,
    cleanBoards: 157,
    msMedian: 272,
  },
  {
    label: "Single ordering",
    note: "tidy pass on, one ordering",
    complete: 210,
    areaRatio: 0.96,
    aspect: 1.47,
    aspectOver3: 18,
    offAxis: 62,
    crossings: 101,
    wires: 2430,
    cuts: 3186,
    stripCompletePct: 50,
    cleanBoards: 188,
    msMedian: 407,
  },
  {
    label: "Portfolio, k = 3",
    note: "three orderings, best kept",
    complete: 210,
    areaRatio: 0.93,
    aspect: 1.47,
    aspectOver3: 18,
    offAxis: 54,
    crossings: 64,
    wires: 2328,
    cuts: 3107,
    stripCompletePct: 50,
    cleanBoards: 194,
    msMedian: 586,
  },
  {
    label: "Portfolio, k = 10",
    note: "ten orderings, best kept",
    complete: 210,
    areaRatio: 0.84,
    aspect: 1.5,
    aspectOver3: 19,
    offAxis: 31,
    crossings: 44,
    wires: 2287,
    cuts: 3137,
    stripCompletePct: 50,
    cleanBoards: 197,
    msMedian: 1209,
  },
];

/** Table 2 rows by role: the single-ordering ablation and the reference
 * configuration. The shipped default IS the k = 10 row for projects up to
 * 30 parts; larger projects default to k = 3 (31-40 parts) or a single
 * solve (above 40) so a first run stays quick, and the user can raise the
 * count. */
export const SINGLE = FREE[1];
export const PORTFOLIO = FREE[3];

/** Drilled-cuts-only mode, same protocol, k = 10. */
export const DRILLED = {
  complete: 210,
  areaRatio: 0.89,
  offAxis: 33,
  crossings: 32,
  cleanBoards: 199,
  /** between-hole (knife) cuts left over the corpus, vs the normal mode */
  betweenCuts: 307,
  betweenCutsNormal: 749,
  cuts: 2939,
};

/** Channel stacking under the depth cap, k = 10. */
export const STACKS = {
  /** boards whose deepest channel reaches the cap of three wires */
  atCap: 4,
  /** boards past the cap: the completeness rescue fired once, on a
   * nine-part board that finishes complete with one four-wire channel */
  overCap: 1,
};

/** Two parts pinned at their human positions; the rest is the solver's. */
export const LOCKED = {
  /** historical: an earlier solver revision on the corpus of 239 as it
   * stood then, kept for the free-hole-invariant narrative of Section 7.4 */
  baseline: { complete: 202, of: 239, areaRatio: 1.38 },
  current: { complete: 210, areaRatio: 1.14, aspectOver3: 11, offAxis: 102, crossings: 160 },
  /** same protocol under the k = 10 portfolio */
  portfolio: { complete: 210, areaRatio: 1.09, offAxis: 62, crossings: 64, cleanBoards: 180 },
};

/** Median area relative to the human board, by project size. */
export const SIZE_BANDS = [
  { band: "2-5", n: 20, current: 0.74, portfolio: 0.74 },
  { band: "6-10", n: 71, current: 0.77, portfolio: 0.71 },
  { band: "11-15", n: 45, current: 1.11, portfolio: 0.97 },
  { band: "16-25", n: 41, current: 1.1, portfolio: 0.9 },
  { band: "26-60", n: 32, current: 1.04, portfolio: 1.04 },
];

/** Residual wire defects grouped by the rigid-join count of the netlist,
 * k = 10 portfolio. */
export const JOIN_BANDS = [
  { band: "0", n: 133, offAxis: 9, crossings: 24 },
  { band: "1-4", n: 41, offAxis: 7, crossings: 3 },
  { band: "5-10", n: 22, offAxis: 1, crossings: 1 },
  { band: "11+", n: 14, offAxis: 14, crossings: 16 },
];

/** The J = 0 band's defects are almost one board: a single 27-part project
 * carries 8 of its 9 off-axis wires and all 24 crossings, one other board
 * has one off-axis wire, and the remaining 131 finish perfect. */
export const J0_OUTLIER = {
  offAxis: 8,
  crossings: 24,
  parts: 27,
  perfect: 131,
};

/** Per-project trimmed-area A/B along the portfolio ladder. */
export const PORTFOLIO_AB = {
  k3vsSingle: { better: 70, same: 118, worse: 22 },
  k10vsK3: { better: 73, same: 123, worse: 14 },
  k10vsSingle: { better: 111, same: 77, worse: 22 },
  /** of the k10-larger boards: how many remove off-axis wires or crossings,
   * and how many instead buy shorter or fewer wires and emptier channels */
  k10LargerTidier: 7,
  k10LargerOtherGains: 15,
  k10LargerWorst: { cells: 220, defectsFrom: 18, defectsTo: 4 },
};

/** The k = 10 portfolio versus the human board, per project, on trimmed
 * area. */
export const VS_HUMAN = {
  smaller: 125,
  equal: 5,
  larger: 80,
  /** quartiles of the per-project area ratio (median is PORTFOLIO.areaRatio) */
  q1: 0.58,
  q3: 1.31,
};

/**
 * Human layouts audited against the solver's own physical rules (span
 * limits, clearances, corridor and footprint overlaps), using the solver's
 * geometry code on each stored human board. Produced, together with
 * VS_HUMAN, by tests/solver/humanPhysics.js --sweep sweep-p22-perm10;
 * area splits are against the k = 10 portfolio.
 */
export const PHYSICS = {
  /** projects whose human board has at least one violation */
  violating: 171,
  /** flexible part bent tighter than its span minimum */
  spanShort: 128,
  /** flexible part stretched past its span maximum */
  spanLong: 15,
  /** parallel flexible bodies closer than the clearance permits */
  tooClose: 132,
  /** flexible body inside a footprint's clearance (adjacent-column packing) */
  onRigid: 136,
  /** of the VS_HUMAN.larger projects, how many violate */
  humanSmallerViolating: 74,
  violatingMedianRatio: 0.95,
  cleanN: 39,
  cleanMedianRatio: 0.63,
  cleanHumanSmaller: 6,
  /** worst per-project ratio among clean human-smaller boards */
  cleanWorstRatio: 2.0,
  /** 6-10 part band, clean references only: median ratio, human-smaller count */
  band6to10CleanMedian: 0.44,
  band6to10CleanHumanSmaller: 0,
};

/**
 * Relaxed-rules runs (sweep.js --relax, same subset and protocol as Table
 * 2, both under the k = 10 portfolio). Adaptive grants, per project and
 * part type, exactly the liberties that human's layout demonstrably took
 * (spans widened to observed, clearances lowered until the human's
 * placements are legal); flat removes clearances and span minimums
 * outright. Both complete all 210 circuits.
 */
export const RELAXED = {
  adaptive: {
    areaRatio: 0.73,
    q1: 0.49,
    q3: 1.0,
    smaller: 157,
    equal: 4,
    larger: 49,
    /** projects where any def was actually relaxed */
    touchedN: 171,
    touchedMedian: 0.75,
    touchedMedianBaseline: 0.95,
    touchedHumanSmaller: 43,
    touchedHumanSmallerBaseline: 74,
    offAxis: 42,
    crossings: 49,
    cleanBoards: 196,
  },
  flat: {
    areaRatio: 0.62,
    q1: 0.37,
    q3: 0.87,
    smaller: 174,
    equal: 1,
    larger: 35,
    offAxis: 40,
    crossings: 51,
    cleanBoards: 192,
  },
};

/**
 * Beam-search experiment: refine every distinct stage-2 construction
 * instead of (or in addition to) varying input orderings. Sources:
 * sweep-p22-beam / sweep-p22-perm5 / sweep-p22-perm10-unguarded /
 * sweep-p22-beam-perm3 on the 210 subset, same protocol and revision as
 * Table 2, every row using the shipped guarded pick except the row that
 * ablates it. Kept in the solver behind an option; not a production
 * setting.
 */
export const BEAM = {
  poolMedian: 5,
  poolMin: 4,
  poolMax: 9,
  /** full-pool beam against the plain solve of the same ordering, per
   * project on trimmed area: the alternatives are genuinely different
   * boards, but no denser at the median */
  vsSingle: { smaller: 83, same: 103, larger: 24 },
  vsSingleMedianRatio: 1.0,
  /** full-pool beam, single ordering */
  pool: { areaRatio: 0.9, aspect: 1.59, aspectOver3: 36, offAxis: 41, crossings: 60, cleanBoards: 196, msMedian: 2701 },
  /** five orderings: the equal-solve-count portfolio comparison */
  perm5: { areaRatio: 0.9, aspect: 1.5, aspectOver3: 18, offAxis: 39, crossings: 46, cleanBoards: 198, msMedian: 754 },
  /** three orderings x full beam (~15 solves) */
  mixed: { areaRatio: 0.86, aspect: 1.56, aspectOver3: 35, offAxis: 36, crossings: 34, cleanBoards: 196, msMedian: 3431 },
  mixedVsPortfolio: { smaller: 77, same: 65, larger: 68 },
  /** the shipped k = 10 portfolio with the crossings guard turned off */
  /** its solves are the portfolio's own; the pick is free, so its time is
   * the k = 10 row's */
  p10Unguarded: { areaRatio: 0.83, aspect: 1.5, aspectOver3: 19, offAxis: 31, crossings: 55, cleanBoards: 194, msMedian: 1209 },
  /** what the guard costs on the plain portfolio: the boards it changes,
   * all of which grow, against the crossings it removes */
  guardChanged: 7,
  guardHoles: 591,
  guardWorst: { fromRows: 22, fromCols: 29, fromArea: 638, toRows: 23, toCols: 35, toArea: 805, crossingsFrom: 10, crossingsTo: 8 },
  /** squarish under k = 10 (aspect <= 2), a strip under the mixed beam (> 3) */
  squareToStrip: 16,
  worstFlip: { fromRows: 17, fromCols: 31, fromArea: 527, toRows: 10, toCols: 40, toArea: 400 },
  /** per-project WALL-CLOCK ratio, beam-pool (one thread; the pool refines
   * sequentially) vs perms-5 (five parallel workers) */
  msVsPerm5Median: 3.49,
  msVsPerm5P90: 5.64,
  msVsPerm5Over2x: 178,
  /** compute cost of one beamed ordering against one plain solve, both on
   * one thread */
  msVsSingleMedian: 5.25,
  msVsSingleP90: 9.5,
  msVsSingleMax: 25.2,
  /** slowest single beamed ordering in the corpus, seconds */
  slowestOrderingSeconds: 138,
};

/** Solve time of the single-ordering configuration over the corpus.
 * Wall-clock, one circuit at a time, nothing else on the machine. */
export const RUNTIME = {
  medianMs: 407,
  p90Ms: 5792,
  maxMs: 30701,
  /** per-project wall-clock of the k = 10 portfolio over the single solve,
   * orderings in ten parallel workers */
  k10OverSingleMedian: 2.5,
  /** tidy pass share of corpus-total solve time, and the median project's
   * extra cost (Table 2 rows 1 vs 2) */
  tidySharePct: 64,
  tidyMedianExtraPct: 8,
};

/** Fig 2: single-ordering wall-clock by project size, parts rounded to the
 * nearest multiple of 5 (the 2-7 part projects land in the 5 band). All in
 * milliseconds, quartiles interpolated; same timing protocol as the Time
 * column of Table 2. */
export const RUNTIME_BANDS = [
  { band: 5, n: 39, min: 2, q1: 24, med: 44, q3: 83, max: 1377 },
  { band: 10, n: 74, min: 60, q1: 131, med: 227, q3: 588, max: 2113 },
  { band: 15, n: 35, min: 137, q1: 299, med: 507, q3: 1967, max: 10515 },
  { band: 20, n: 21, min: 315, q1: 422, med: 784, q3: 1356, max: 30701 },
  { band: 25, n: 12, min: 660, q1: 1282, med: 3187, q3: 5915, max: 23893 },
  { band: 30, n: 13, min: 813, q1: 2192, med: 3892, q3: 8122, max: 17742 },
  { band: 35, n: 4, min: 1260, q1: 1656, med: 1948, q3: 2193, max: 2450 },
  { band: 40, n: 4, min: 1761, q1: 2811, med: 14834, q3: 26769, max: 27555 },
  { band: 45, n: 5, min: 2529, q1: 2700, med: 3128, q3: 9238, max: 24090 },
  { band: 50, n: 2, min: 6848, q1: 8724, med: 10599, q3: 12475, max: 14350 },
  { band: 55, n: 1, min: 18460, q1: 18460, med: 18460, q3: 18460, max: 18460 },
];

/**
 * The guitar-pedal benchmark published with the ASP formulation, measured
 * on the hand-rebuilt reconstruction that is publicly viewable at viewUrl.
 * The public project and the Fig 2 screenshots show the k = 10 run below.
 */
export const PEDAL = {
  parts: 18,
  nets: 12,
  viewUrl: "https://stripboard-editor.com/view/78705b4e-1da6-49ac-8e07-7d6f45ae11c9",
  asp: { rows: 12, cols: 18, area: 216, seconds: 11.92, cuts: 0, wires: 0, strips: 12 },
  /** seconds are wall-clock under the timing protocol of Section 7.6
   * (k = 10 solves its orderings in ten parallel workers), median of three
   * runs */
  runs: [
    { label: "Single ordering", rows: 10, cols: 21, area: 210, cuts: 11, wires: 9, offAxis: 0, crossings: 0, seconds: 0.55 },
    { label: "Portfolio, k = 10", rows: 11, cols: 19, area: 209, cuts: 9, wires: 8, offAxis: 0, crossings: 0, seconds: 1.71 },
  ],
  /** Same netlist, ten seeded input orderings, each solved to completion. */
  orderings: [
    { i: 0, rows: 10, cols: 21, area: 210, wires: 9, cuts: 11 },
    { i: 1, rows: 11, cols: 21, area: 231, wires: 12, cuts: 13 },
    { i: 2, rows: 13, cols: 16, area: 208, wires: 8, cuts: 7 },
    { i: 3, rows: 10, cols: 21, area: 210, wires: 9, cuts: 11 },
    { i: 4, rows: 14, cols: 19, area: 266, wires: 6, cuts: 5 },
    { i: 5, rows: 13, cols: 18, area: 234, wires: 7, cuts: 6 },
    { i: 6, rows: 11, cols: 19, area: 209, wires: 9, cuts: 10 },
    { i: 7, rows: 11, cols: 21, area: 231, wires: 15, cuts: 16 },
    { i: 8, rows: 13, cols: 18, area: 234, wires: 7, cuts: 6 },
    { i: 9, rows: 11, cols: 19, area: 209, wires: 8, cuts: 9 },
  ],
};

/** Tuning constants quoted in the objective section. */
export const CONSTANTS = {
  offAxisFree: 1,
  offAxisRate: 2,
  crossExtra: 8,
  /** channel stacking: price of becoming the second / third wire in a
   * channel; a fourth is barred outside the completeness rescue */
  stackSecond: 4,
  stackThird: 10,
  stackMax: 3,
  stackRescue: 1000,
  relayTax: 1,
  pinSharePenalty: 4,
  /** free board lines a flexible body keeps to any neighbour (a pair shares
   * the moat: the requirement is the larger of the two, not the sum) */
  defaultClearance: 1,
  wireWeight: 8,
  lenWeight: 3,
  wireWeightCapped: 4,
  lenWeightCapped: 1,
  overCapPenalty: 200,
  icMinPins: 4,
  /** the price of one board cell against a hole of wire (lambda_A) */
  areaWeight: 0.35,
  /** shipped portfolio default: orderings solved, reduced on large projects
   * (3 above 30 parts, 1 above 40) to keep a first run quick */
  permBoards: 10,
  permBoardsMid: 3,
  permBoardsMidAbove: 30,
  permBoardsSingleAbove: 40,
};
