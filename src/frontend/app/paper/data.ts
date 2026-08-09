/**
 * Every measured number the paper cites, in one place.
 *
 * Source: the offline benchmark harness (tests/solver/sweep.js) over the
 * anonymized layout corpus. Re-run the sweeps, re-run the aggregation, and
 * edit this file; the prose reads from it, so no figure can go stale on its
 * own. The corpus itself is user data and never leaves the local machine.
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
  date: "5 August 2026",
  /** solver source revision the sweeps were verified against */
  commit: "cad08ed",
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
    areaRatio: 0.89,
    aspect: 1.55,
    aspectOver3: 20,
    offAxis: 171,
    crossings: 281,
    wires: 2943,
    cuts: 4145,
    stripCompletePct: 50,
    cleanBoards: 177,
    msMedian: 847,
  },
  {
    label: "Single ordering",
    note: "tidy pass on, one ordering",
    complete: 239,
    areaRatio: 0.89,
    aspect: 1.44,
    aspectOver3: 16,
    offAxis: 72,
    crossings: 104,
    wires: 2983,
    cuts: 4007,
    stripCompletePct: 48,
    cleanBoards: 213,
    msMedian: 1074,
  },
  {
    label: "Portfolio, k = 3",
    note: "three orderings, best kept",
    complete: 239,
    areaRatio: 0.85,
    aspect: 1.45,
    aspectOver3: 17,
    offAxis: 46,
    crossings: 69,
    wires: 2862,
    cuts: 3932,
    stripCompletePct: 50,
    cleanBoards: 213,
    msMedian: 2784,
  },
  {
    label: "Portfolio, k = 10",
    note: "ten orderings, best kept",
    complete: 239,
    areaRatio: 0.82,
    aspect: 1.5,
    aspectOver3: 16,
    offAxis: 33,
    crossings: 42,
    wires: 2854,
    cuts: 3980,
    stripCompletePct: 50,
    cleanBoards: 223,
    msMedian: 8988,
  },
];

/** Table 2 rows by role: the single-ordering ablation and the reference
 * configuration. The shipped default is a 5-second portfolio budget on half
 * the machine's cores, which lands between the k = 3 and k = 10 rows
 * depending on hardware and board size. */
export const SINGLE = FREE[2];
export const PORTFOLIO = FREE[4];

/** Two parts pinned at their human positions; the rest is the solver's. */
export const LOCKED = {
  baseline: { complete: 202, areaRatio: 1.38, aspectOver3: 37, offAxis: 656, crossings: 826 },
  current: { complete: 239, areaRatio: 1.16, aspectOver3: 12, offAxis: 121, crossings: 213 },
  /** same protocol under the k = 10 portfolio */
  portfolio: { complete: 239, areaRatio: 1.02, offAxis: 78, crossings: 143 },
};

/** Median area relative to the human board, by project size. */
export const SIZE_BANDS = [
  { band: "2-5", n: 26, baseline: 0.84, current: 0.74, portfolio: 0.72 },
  { band: "6-10", n: 72, baseline: 0.8, current: 0.73, portfolio: 0.64 },
  { band: "11-15", n: 54, baseline: 1.04, current: 1.02, portfolio: 0.95 },
  { band: "16-25", n: 47, baseline: 1.0, current: 1.05, portfolio: 0.9 },
  { band: "26-60", n: 39, baseline: 1.38, current: 1.13, portfolio: 1.05 },
];

/** Residual wire defects grouped by the rigid-join count of the netlist,
 * k = 10 portfolio. */
export const JOIN_BANDS = [
  { band: "0", n: 150, offAxis: 2, crossings: 2 },
  { band: "1-4", n: 40, offAxis: 1, crossings: 1 },
  { band: "5-10", n: 23, offAxis: 0, crossings: 2 },
  { band: "11+", n: 26, offAxis: 30, crossings: 37 },
];

/** Per-project trimmed-area A/B along the portfolio ladder. */
export const PORTFOLIO_AB = {
  k3vsSingle: { better: 101, same: 130, worse: 8 },
  k10vsK3: { better: 92, same: 134, worse: 13 },
  k10vsSingle: { better: 152, same: 80, worse: 7 },
};

/** The k = 10 portfolio versus the human board, per project, on trimmed
 * area. */
export const VS_HUMAN = {
  smaller: 151,
  equal: 4,
  larger: 84,
  /** quartiles of the per-project area ratio (median is PORTFOLIO.areaRatio) */
  q1: 0.55,
  q3: 1.15,
};

/**
 * Human layouts audited against the solver's own physical rules (span
 * limits, clearance halos, corridor and footprint overlaps), using the
 * solver's geometry code on each stored human board. Produced, together
 * with VS_HUMAN, by tests/solver/humanPhysics.js --sweep sweep-perm10e2e;
 * area splits are against the k = 10 portfolio.
 */
export const PHYSICS = {
  /** projects whose human board has at least one violation */
  violating: 175,
  /** flexible part bent tighter than its span minimum */
  spanShort: 138,
  /** flexible part stretched past its span maximum */
  spanLong: 15,
  /** parallel flexible bodies closer than contact plus halos */
  tooClose: 146,
  /** of the VS_HUMAN.larger projects, how many violate */
  humanSmallerViolating: 76,
  violatingMedianRatio: 0.9,
  cleanN: 64,
  cleanMedianRatio: 0.61,
  cleanHumanSmaller: 8,
  /** worst per-project ratio among clean human-smaller boards */
  cleanWorstRatio: 1.88,
  /** 6-10 part band, clean references only: median ratio, human-smaller count */
  band6to10CleanMedian: 0.4,
  band6to10CleanHumanSmaller: 0,
};

/**
 * Relaxed-rules runs (sweep.js --relax, same subset and protocol as Table
 * 2, both under the k = 10 portfolio). Adaptive grants, per project and
 * part type, exactly the liberties that human's layout demonstrably took
 * (spans widened to observed, halos lowered until the human's placements
 * are legal); flat removes halos and span minimums outright. Both complete
 * all 239 circuits.
 */
export const RELAXED = {
  adaptive: {
    areaRatio: 0.7,
    q1: 0.5,
    q3: 1.0,
    smaller: 177,
    equal: 8,
    larger: 54,
    /** projects where any def was actually relaxed */
    touchedN: 174,
    touchedMedian: 0.75,
    touchedMedianBaseline: 0.9,
    touchedHumanSmaller: 45,
    touchedHumanSmallerBaseline: 75,
    offAxis: 39,
    crossings: 43,
    cleanBoards: 216,
  },
  flat: {
    areaRatio: 0.63,
    q1: 0.43,
    q3: 0.88,
    smaller: 197,
    equal: 8,
    larger: 34,
    offAxis: 65,
    crossings: 67,
    cleanBoards: 203,
  },
};

/**
 * Beam-search experiment: refine every distinct stage-2 construction
 * instead of (or in addition to) varying input orderings. Sources:
 * beam-oracle.json (50-circuit subsample, every pool entry solved end to
 * end) and sweep-beampool / sweep-perm5e2e / sweep-beamperm3 on the 239
 * subset. Kept in the solver behind an option; not a production setting.
 */
export const BEAM = {
  poolMedian: 5,
  poolMin: 4,
  poolMax: 7,
  oracleN: 50,
  oracleImproved: 35,
  /** median best-over-pool area vs the plain solve */
  oracleAreaRatio: 0.92,
  /** share of alternative starts that converge back to the plain solve's board */
  convergedPct: 32,
  /** full-pool beam, single ordering */
  pool: { areaRatio: 0.83, aspect: 1.5, aspectOver3: 25, offAxis: 76, crossings: 100, cleanBoards: 209, msMedian: 5885 },
  /** five orderings: the equal-solve-count portfolio comparison */
  perm5: { areaRatio: 0.83, aspect: 1.46, aspectOver3: 15, offAxis: 44, crossings: 55, cleanBoards: 219, msMedian: 4558 },
  /** three orderings x full beam (~15 solves) */
  mixed: { areaRatio: 0.77, aspect: 1.55, aspectOver3: 25, offAxis: 52, crossings: 63, cleanBoards: 212, msMedian: 18074 },
  mixedVsPortfolio: { smaller: 93, same: 92, larger: 54 },
  /** crossings-guarded final pick (fewest crossings, then the rating) */
  mixedGuarded: { areaRatio: 0.8, aspect: 1.57, aspectOver3: 25, offAxis: 38, crossings: 22, cleanBoards: 222, msMedian: 18327 },
  p10Guarded: { areaRatio: 0.83, aspect: 1.5, aspectOver3: 16, offAxis: 33, crossings: 26, cleanBoards: 225, msMedian: 9415 },
  /** guarded pick on the plain portfolio: the only boards it changes, all larger */
  p10GuardedLarger: 7,
  p10GuardedHoles: 632,
  p10GuardedWorst: { fromRows: 21, fromCols: 18, fromArea: 378, toRows: 27, toCols: 22, toArea: 594, crossings: 3 },
  /** squarish under k = 10 (aspect <= 2), a strip under the mixed beam (> 3) */
  squareToStrip: 10,
  worstFlip: { fromRows: 19, fromCols: 18, fromArea: 342, toRows: 38, toCols: 8, toArea: 304 },
  /** per-project solve-time ratio, beam-pool vs perms-5 */
  msVsPerm5Median: 1.15,
  msVsPerm5P90: 1.97,
  msVsPerm5Over2x: 22,
  /** circuits whose first beamed ordering alone outlasts the shipped budget */
  overBudget: 132,
  overBudgetSingle: 51,
  /** cost of one beamed ordering against one plain solve */
  msVsSingleMedian: 4.5,
  msVsSingleP90: 8.7,
  msVsSingleMax: 31.3,
  /** slowest single beamed ordering in the corpus, seconds */
  slowestOrderingSeconds: 275,
};

/** Solve time of the default configuration over the corpus. */
export const RUNTIME = {
  medianMs: 1074,
  p90Ms: 9943,
  maxMs: 58104,
  /** same solves re-run one at a time: how much the 12-way sweep inflates them */
  contentionMedian: 3.2,
  contentionSampleN: 20,
};

/**
 * The guitar-pedal benchmark published with the ASP formulation, measured
 * on the hand-rebuilt reconstruction that is publicly viewable at viewUrl
 * (the live project's board is byte-identical to the k = 10 result below;
 * its screenshots ship in /public).
 */
export const PEDAL = {
  parts: 18,
  nets: 12,
  viewUrl: "https://stripboard-editor.com/view/78705b4e-1da6-49ac-8e07-7d6f45ae11c9",
  asp: { rows: 12, cols: 18, area: 216, seconds: 11.92, cuts: 0, wires: 0, strips: 12 },
  runs: [
    { label: "Single ordering", rows: 10, cols: 21, area: 210, cuts: 10, wires: 8, offAxis: 0, crossings: 0, seconds: 0.52 },
    { label: "Portfolio, k = 10", rows: 11, cols: 18, area: 198, cuts: 6, wires: 5, offAxis: 0, crossings: 0, seconds: 4.38 },
  ],
  /** Same netlist, ten seeded input orderings, each solved to completion. */
  orderings: [
    { i: 0, rows: 10, cols: 21, area: 210, wires: 8, cuts: 10 },
    { i: 1, rows: 14, cols: 16, area: 224, wires: 7, cuts: 6 },
    { i: 2, rows: 12, cols: 20, area: 240, wires: 7, cuts: 7 },
    { i: 3, rows: 10, cols: 21, area: 210, wires: 8, cuts: 10 },
    { i: 4, rows: 14, cols: 18, area: 252, wires: 6, cuts: 5 },
    { i: 5, rows: 12, cols: 20, area: 240, wires: 7, cuts: 7 },
    { i: 6, rows: 11, cols: 18, area: 198, wires: 5, cuts: 6 },
    { i: 7, rows: 14, cols: 17, area: 238, wires: 9, cuts: 8 },
    { i: 8, rows: 13, cols: 20, area: 260, wires: 8, cuts: 7 },
    { i: 9, rows: 11, cols: 18, area: 198, wires: 6, cuts: 7 },
  ],
};

/** Tuning constants quoted in the objective section. */
export const CONSTANTS = {
  offAxisFree: 1,
  offAxisRate: 2,
  crossExtra: 8,
  overlapRate: 2,
  relayTax: 1,
  pinSharePenalty: 4,
  defaultClearance: 0.5,
  wireWeight: 8,
  lenWeight: 3,
  wireWeightCapped: 4,
  lenWeightCapped: 1,
  overCapPenalty: 200,
  icMinPins: 4,
  /** shipped portfolio default: budget seconds, on half the cores */
  permBudgetSeconds: 5,
};
