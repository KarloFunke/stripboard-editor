/**
 * Every measured number the paper cites, in one place.
 *
 * Source: the offline benchmark harness (tests/solver/sweep.js) over the
 * anonymized layout corpus, aggregated by tests/solver/paperStats.js.
 * Re-run the sweeps, re-run the aggregation, and edit this file; the prose
 * reads from it, so no figure can go stale on its own. The corpus itself is
 * user data and never leaves the local machine.
 *
 * ONE set of projects backs every figure here: the 239 whose stored human
 * layout is complete and conflict-free. The extraction yields 306; two
 * reference component definitions that no longer exist and are unsolvable
 * data rather than hard instances; 65 more were saved with a short or an
 * unconnected net. Tuning studies that need no human reference (the
 * cluster-size sweep, runtime profiling) run over the wider set, but no
 * number in the paper mixes the two.
 */

export const EVALUATED = {
  date: "21 August 2026",
  /** solver source revision the sweeps were verified against — REPIN after
   * committing this revision */
  commit: "pending",
  hardware: "Ryzen 7 7800X3D, 12-way parallel sweep",
};

/** The evaluation corpus: projects whose human layout is a finished board. */
export const CORPUS = {
  projects: 239,
  /** what the extraction produced before the two filters below */
  extracted: 306,
  /** dropped: parts naming component definitions that no longer exist */
  unresolvable: 2,
  /** dropped: human board saved with a short or an unconnected net */
  defective: 65,
  partsMedian: 12,
  partsP90: 31,
  partsMax: 55,
  netsMedian: 10,
  areaMedian: 240,
};

/** The same 239 boards as their authors built them. */
export const HUMAN = {
  aspect: 1.5,
  aspectOver3: 25,
  offAxis: 280,
  crossings: 725,
  wires: 2550,
  cuts: 5362,
  stripCompletePct: 57,
  cleanBoards: 134,
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
  msMedian: number;
}

/** Unconstrained runs: solver picks the board size, nothing locked. */
export const FREE: Config[] = [
  {
    label: "Stage pipeline only",
    note: "before the wire-tidiness work",
    complete: 239,
    areaRatio: 0.98,
    aspect: 2.0,
    aspectOver3: 60,
    offAxis: 714,
    crossings: 997,
    wires: 2187,
    cuts: 3659,
    stripCompletePct: 53,
    cleanBoards: 44,
    msMedian: 76,
  },
  {
    label: "Tidy pass disabled",
    note: "same solver, second pass off",
    complete: 239,
    areaRatio: 0.99,
    aspect: 1.53,
    aspectOver3: 28,
    offAxis: 185,
    crossings: 290,
    wires: 2940,
    cuts: 4050,
    stripCompletePct: 50,
    cleanBoards: 178,
    msMedian: 750,
  },
  {
    label: "Single ordering",
    note: "tidy pass on, one ordering",
    complete: 239,
    areaRatio: 1.0,
    aspect: 1.4,
    aspectOver3: 19,
    offAxis: 79,
    crossings: 106,
    wires: 2947,
    cuts: 3883,
    stripCompletePct: 50,
    cleanBoards: 210,
    msMedian: 1151,
  },
  {
    label: "Portfolio, k = 3",
    note: "three orderings, best kept",
    complete: 239,
    areaRatio: 1.0,
    aspect: 1.42,
    aspectOver3: 20,
    offAxis: 52,
    crossings: 51,
    wires: 2852,
    cuts: 3807,
    stripCompletePct: 50,
    cleanBoards: 218,
    msMedian: 3318,
  },
  {
    label: "Portfolio, k = 10",
    note: "ten orderings, best kept",
    complete: 239,
    areaRatio: 0.93,
    aspect: 1.47,
    aspectOver3: 23,
    offAxis: 24,
    crossings: 27,
    wires: 2805,
    cuts: 3847,
    stripCompletePct: 50,
    cleanBoards: 225,
    msMedian: 12190,
  },
];

/** Table 2 rows by role: the single-ordering ablation and the reference
 * configuration. The shipped default IS the k = 10 row for projects up to
 * 30 parts; larger projects default to k = 3 (31-40 parts) or a single
 * solve (above 40) so a first run stays quick, and the user can raise the
 * count. */
export const SINGLE = FREE[2];
export const PORTFOLIO = FREE[4];

/** Drilled-cuts-only mode, same protocol, k = 10. */
export const DRILLED = {
  complete: 239,
  areaRatio: 0.97,
  offAxis: 35,
  crossings: 24,
  cleanBoards: 225,
  /** between-hole (knife) cuts left over the corpus, vs the normal mode */
  betweenCuts: 352,
  betweenCutsNormal: 867,
  cuts: 3673,
};

/** Channel stacking under the depth cap, k = 10. */
export const STACKS = {
  /** boards whose deepest channel reaches the cap of three wires */
  atCap: 8,
  /** boards past the cap (the completeness rescue) */
  overCap: 0,
};

/** Two parts pinned at their human positions; the rest is the solver's. */
export const LOCKED = {
  baseline: { complete: 202, areaRatio: 1.38, aspectOver3: 37, offAxis: 656, crossings: 826 },
  current: { complete: 239, areaRatio: 1.23, aspectOver3: 10, offAxis: 139, crossings: 204 },
  /** same protocol under the k = 10 portfolio */
  portfolio: { complete: 239, areaRatio: 1.12, offAxis: 100, crossings: 106, cleanBoards: 201 },
};

/** Median area relative to the human board, by project size. */
export const SIZE_BANDS = [
  { band: "2-5", n: 26, baseline: 0.84, current: 0.81, portfolio: 0.81 },
  { band: "6-10", n: 72, baseline: 0.8, current: 0.81, portfolio: 0.75 },
  { band: "11-15", n: 54, baseline: 1.04, current: 1.18, portfolio: 1.0 },
  { band: "16-25", n: 47, baseline: 1.0, current: 1.12, portfolio: 0.99 },
  { band: "26-60", n: 39, baseline: 1.38, current: 1.22, portfolio: 1.12 },
];

/** Residual wire defects grouped by the rigid-join count of the netlist,
 * k = 10 portfolio. */
export const JOIN_BANDS = [
  { band: "0", n: 150, offAxis: 1, crossings: 0 },
  { band: "1-4", n: 40, offAxis: 2, crossings: 2 },
  { band: "5-10", n: 23, offAxis: 1, crossings: 1 },
  { band: "11+", n: 26, offAxis: 20, crossings: 24 },
];

/** Per-project trimmed-area A/B along the portfolio ladder. */
export const PORTFOLIO_AB = {
  k3vsSingle: { better: 80, same: 131, worse: 28 },
  k10vsK3: { better: 82, same: 141, worse: 16 },
  k10vsSingle: { better: 129, same: 84, worse: 26 },
  /** of the k10-larger boards: how many remove off-axis wires or crossings,
   * and how many instead buy shorter or fewer wires and emptier channels */
  k10LargerTidier: 10,
  k10LargerOtherGains: 16,
  k10LargerWorst: { cells: 252, defectsFrom: 12, defectsTo: 2 },
};

/** The k = 10 portfolio versus the human board, per project, on trimmed
 * area. */
export const VS_HUMAN = {
  smaller: 130,
  equal: 8,
  larger: 101,
  /** quartiles of the per-project area ratio (median is PORTFOLIO.areaRatio) */
  q1: 0.63,
  q3: 1.32,
};

/**
 * Human layouts audited against the solver's own physical rules (span
 * limits, clearances, corridor and footprint overlaps), using the solver's
 * geometry code on each stored human board. Produced, together with
 * VS_HUMAN, by tests/solver/humanPhysics.js --sweep sweep-aw035-perm10;
 * area splits are against the k = 10 portfolio.
 */
export const PHYSICS = {
  /** projects whose human board has at least one violation */
  violating: 193,
  /** flexible part bent tighter than its span minimum */
  spanShort: 138,
  /** flexible part stretched past its span maximum */
  spanLong: 15,
  /** parallel flexible bodies closer than the clearance permits */
  tooClose: 146,
  /** flexible body inside a footprint's clearance (adjacent-column packing) */
  onRigid: 159,
  /** of the VS_HUMAN.larger projects, how many violate */
  humanSmallerViolating: 94,
  violatingMedianRatio: 1.0,
  cleanN: 46,
  cleanMedianRatio: 0.67,
  cleanHumanSmaller: 7,
  /** worst per-project ratio among clean human-smaller boards */
  cleanWorstRatio: 2.0,
  /** 6-10 part band, clean references only: median ratio, human-smaller count */
  band6to10CleanMedian: 0.5,
  band6to10CleanHumanSmaller: 0,
};

/**
 * Relaxed-rules runs (sweep.js --relax, same subset and protocol as Table
 * 2, both under the k = 10 portfolio). Adaptive grants, per project and
 * part type, exactly the liberties that human's layout demonstrably took
 * (spans widened to observed, clearances lowered until the human's
 * placements are legal); flat removes clearances and span minimums
 * outright. Both complete all 239 circuits.
 */
export const RELAXED = {
  adaptive: {
    areaRatio: 0.79,
    q1: 0.55,
    q3: 1.04,
    smaller: 166,
    equal: 9,
    larger: 64,
    /** projects where any def was actually relaxed */
    touchedN: 192,
    touchedMedian: 0.81,
    touchedMedianBaseline: 1.0,
    touchedHumanSmaller: 56,
    touchedHumanSmallerBaseline: 93,
    offAxis: 43,
    crossings: 34,
    cleanBoards: 220,
  },
  flat: {
    areaRatio: 0.67,
    q1: 0.44,
    q3: 0.95,
    smaller: 187,
    equal: 8,
    larger: 44,
    offAxis: 46,
    crossings: 34,
    cleanBoards: 216,
  },
};

/**
 * Beam-search experiment: refine every distinct stage-2 construction
 * instead of (or in addition to) varying input orderings. Sources:
 * sweep-ac-beam-pool / sweep-ac-perm5 / sweep-ac-perm10-unguarded /
 * sweep-ac-beam-perm3 on the 239 subset, same protocol and revision as
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
  vsSingle: { smaller: 88, same: 125, larger: 26 },
  vsSingleMedianRatio: 1.0,
  /** full-pool beam, single ordering */
  pool: { areaRatio: 0.97, aspect: 1.55, aspectOver3: 35, offAxis: 67, crossings: 85, cleanBoards: 218, msMedian: 6241 },
  /** five orderings: the equal-solve-count portfolio comparison */
  perm5: { areaRatio: 0.95, aspect: 1.4, aspectOver3: 19, offAxis: 38, crossings: 33, cleanBoards: 223, msMedian: 5301 },
  /** three orderings x full beam (~15 solves) */
  mixed: { areaRatio: 0.9, aspect: 1.46, aspectOver3: 34, offAxis: 40, crossings: 42, cleanBoards: 220, msMedian: 20190 },
  mixedVsPortfolio: { smaller: 86, same: 77, larger: 76 },
  /** the shipped k = 10 portfolio with the crossings guard turned off */
  p10Unguarded: { areaRatio: 0.93, aspect: 1.47, aspectOver3: 23, offAxis: 29, crossings: 41, cleanBoards: 221, msMedian: 10984 },
  /** what the guard costs on the plain portfolio: the boards it changes,
   * all of which grow, against the crossings it removes */
  guardChanged: 8,
  guardHoles: 812,
  guardWorst: { fromRows: 21, fromCols: 18, fromArea: 378, toRows: 27, toCols: 22, toArea: 594, crossingsFrom: 6, crossingsTo: 2 },
  /** squarish under k = 10 (aspect <= 2), a strip under the mixed beam (> 3) */
  squareToStrip: 15,
  worstFlip: { fromRows: 17, fromCols: 31, fromArea: 527, toRows: 10, toCols: 40, toArea: 400 },
  /** per-project solve-time ratio, beam-pool vs perms-5 */
  msVsPerm5Median: 1.11,
  msVsPerm5P90: 1.81,
  msVsPerm5Over2x: 13,
  /** cost of one beamed ordering against one plain solve */
  msVsSingleMedian: 4.95,
  msVsSingleP90: 9.42,
  msVsSingleMax: 37.3,
  /** slowest single beamed ordering in the corpus, seconds */
  slowestOrderingSeconds: 326,
};

/** Solve time of the single-ordering configuration over the corpus. */
export const RUNTIME = {
  medianMs: 1151,
  p90Ms: 12997,
  maxMs: 61010,
  /** same solves re-run one at a time: how much the 12-way sweep inflates
   * them (measured 5 August 2026; a property of the machine, not the solver) */
  contentionMedian: 3.2,
  contentionSampleN: 20,
  /** tidy pass share of corpus-total solve time, and the median project's
   * extra cost (Table 2 rows 2 vs 3) */
  tidySharePct: 63,
  tidyMedianExtraPct: 26,
};

/**
 * The guitar-pedal benchmark published with the ASP formulation, measured
 * on the hand-rebuilt reconstruction that is publicly viewable at viewUrl.
 * NOTE: the public project's board and the Fig 2 screenshots still show the
 * previous revision's 11x18 result; regenerate both from the k = 10 run
 * below before publishing.
 */
export const PEDAL = {
  parts: 18,
  nets: 12,
  viewUrl: "https://stripboard-editor.com/view/78705b4e-1da6-49ac-8e07-7d6f45ae11c9",
  asp: { rows: 12, cols: 18, area: 216, seconds: 11.92, cuts: 0, wires: 0, strips: 12 },
  runs: [
    { label: "Single ordering", rows: 10, cols: 21, area: 210, cuts: 11, wires: 9, offAxis: 0, crossings: 0, seconds: 1.03 },
    { label: "Portfolio, k = 10", rows: 11, cols: 19, area: 209, cuts: 9, wires: 8, offAxis: 0, crossings: 0, seconds: 7.95 },
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
