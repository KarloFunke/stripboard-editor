import { Board, BoardPosition, Component, ComponentDef, Cut, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getComponentPinPositions, getRotatedPinPositions } from "./boardLayout";
import { AutoLayoutProgress, AutoLayoutResult, effortMoves } from "./layoutTypes";
import { Rot, allowedDrows } from "./layout2/tileModel";
import { FootprintRect, coveredHoles } from "./flexGeometry";
import { flexBody, flexProfile, rigidGeometry } from "./partGeometry";
import { expandOffBoard, leadSiblings } from "./offBoard";
import { MM_PER_HOLE, bodyWidth, resolvePackage } from "./packageBodies";
import { V5WasmDecoder, WasmDecodeOut, WasmExport, WasmModel } from "./v5wasm/v5Wasm";
import { computeStripSegments } from "./stripSegments";
import { pinKey } from "./keys";
import { FinishOptions, Skeleton, finishRepair, finishSkeleton } from "./layout2/finish";
import { unreachablePins, unreachablePinsIssue } from "./unreachablePins";
import { ConnSides, ENTRY_SIDE, W_BCUT, W_BCUT_DRILL } from "./layout2/boardPrice";

// ── The v5 "skeleton + exact decoder" layouter (beta) ──
//
// Simulated annealing over a purely discrete skeleton: a sequence pair over
// all parts, per-flex orientation (horizontal/vertical) and branch bits,
// per-rigid rotation, and per-net pin groups (a group aspires to one copper
// run). Every skeleton decodes exactly: row coordinates come from a
// difference-constraint solve (group equalities via weighted union-find,
// span windows, sequence-pair separations, locked pins), column coordinates
// from a longest-path compaction, and cuts/segments/link wires are read off
// the decoded grid with realizability-aware pricing. Off-axis and crossing
// wires are priced as a last resort on a geometric ramp synchronized with
// cooling. The best skeleton runs through the real completion pipeline
// (route, compact, channels, slant repair).

export interface AutoLayout5Options {
  // Seed portfolio size (default 6): independent anneals, best final board
  // wins on (validity, off-axis + crossings, rating)
  seeds?: number;
  // Anneal budget per seed (default: scaled with part count)
  moves?: number;
  // Moves per seed as a multiple of the pin-count formula (layoutTypes
  // effortMoves) with no ceiling: the editor's effort setting. A time budget
  // given along with it only guards the wall time (the schedule follows the
  // moves unless the clock runs ahead of them), so an unhurried run repeats
  // exactly on any machine.
  effort?: number;
  // Wall-time budget per seed in ms: the schedule (temperature and mess
  // price) then follows the elapsed share of the budget, the run ends when
  // the budget is spent, never before 40k moves and never past the quality
  // cap (see movesN). A run's length thus depends on the machine, so the
  // same circuit gives a similar board, not always the same one. Ignored
  // when moves is given.
  timeBudgetMs?: number;
  // Decode speed of an earlier run on this machine (ms per move): with it
  // the time budget becomes a fixed move count on a coarse ladder before the
  // run starts, and the schedule follows the count, so the run repeats
  // exactly under similar conditions. Without it the schedule follows the
  // clock (first run of a project).
  msPerMoveHint?: number;
  // What a seed's run came to: its move count, the quality cap, and the
  // decode speed it measured (reported whenever a time budget is given)
  onBudget?: (info: { moves: number; cap: number; msPerMove: number }) => void;
  // Run exactly this one seed (parallel portfolio: the editor spreads seed
  // indices over workers and compares the finished boards)
  seedIndex?: number;
  // First seed of the portfolio (default 0): seeds seedBase .. seedBase+seeds-1
  seedBase?: number;
  // Board edges a connector may count as "on the edge" (default all four);
  // a split half excludes its seam side, which ends up in the interior
  connSides?: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  // the same per part, for a solve where some connectors belong to one edge
  // and others to another (the stacked solve's ports and real connectors)
  connSidesOf?: (componentId: string) => ConnSides | undefined;
  // Only sever strips by drilling holes: knife cuts the drill upgrade
  // cannot absorb are priced in the skeleton and the finish
  drilledCutsOnly?: boolean;
  // No wire may run on top of another in one channel
  noWireStacking?: boolean;
  // Harness-only: log each seed's decoded best (never set by the UI)
  debugSeeds?: boolean;
  // Harness-only: every finalist's skeleton, with the decoder's wiring, before
  // it goes to the finish (stored and replayed by the finish-only runner)
  onSkeleton?: (seed: number, skeleton: Skeleton) => void;
  // Every new best the walk finds in its second half also goes through the
  // repair finish, and the cheapest such board competes with the finish of
  // the final best. The walk is unchanged; the pick among its bests is exact.
  // Off: only the final best is finished.
  exactBest?: boolean;
  // Experiment: a strip group is not dissolved by the decoder. A proposal
  // whose orders contradict a tie is refused instead (true: always, a number:
  // with that probability, else the tie splits as before), so ties change
  // mostly through the group moves. The first decode of a seed still splits,
  // since the initial genome asks every net to share one strip.
  protectTies?: boolean | number;
  // The pull and tie move (v5wasm/decode.c mutate), on unless false: the
  // stacked solve's leaves keep the mix without it
  pullTie?: boolean;
  // The decoder and the anneal loop (v5wasm/decode.c), compiled: a solve
  // needs it, the explainer's lab for everything but the part data
  wasm?: WebAssembly.Module;
  // Harness-only move log: called once per proposal of the anneal with a
  // REUSED record (copy what you keep); see MoveLogRec
  moveLog?: (rec: MoveLogRec) => void;
  // Harness-only: another move mix (see V5WasmDecoder.setMix)
  moveMix?: { early: number[]; late?: number[]; lateFrom?: number };
  // Harness-only schedule overrides for annealing experiments
  schedule?: { t0?: number; t0Scale?: number; tEnd?: number; rampStart?: number; rampEndFrac?: number; hardStart?: number; coldT?: number;
    // cooling curve shape: T = t0 * (tEnd / t0)^(f^shape), above 1 hotter for longer
    shape?: number;
    // lean: moves that cannot change the board (rotating a 1x1 part, merging
    // merged labels, splitting a lone label) return null and are resampled
    // instead of spending the iteration
    lean?: boolean };
  // Explainer-only: hand the decoder, the moves and the anneal loop to the
  // caller instead of running the portfolio (the guide's figures replay the
  // decoder step by step on a small circuit, and the recording script
  // stores its walkthroughs)
  lab?: (api: LabApi) => void;
  // Speed probe instead of a solve: this many decodes of random genomes, then
  // their mean time (ms) goes to onSpeedProbe and nothing is laid out. Early
  // anneal decodes are the slowest, so this overstates a whole run's pace
  // (the settings' first-run estimate scales it down).
  speedProbe?: number;
  onSpeedProbe?: (msPerDecode: number) => void;
}

// ── lab types: what the explainer figures draw ──
// `pos`, `rot` and `end` place the part the way a stored component is placed
// (boardPos, rotation, flexibleEndPos), so a figure can draw its real package
export interface LabPlaced { pi: number; x: number; y: number; w: number; h: number; flex: boolean; pos: BoardPosition; rot: Rot; end?: BoardPosition; pins: { r: number; c: number; net: number; name: string; id: string }[] }
export interface LabSeg { row: number; c1: number; c2: number; net: number }
export interface LabCut { row: number; col: number; kind: "hole" | "knife" }
export interface LabWire { r1: number; c1: number; r2: number; c2: number; net: number; slanted: boolean; crossings: number }
export type LabArrowState = "idle" | "push" | "ok" | "conflict" | "check";
export interface LabArrow { a: number; b: number; w: number; state: LabArrowState }
export interface LabMark { r: number; c: number; kind: "ok" | "bad" }
export interface LabBoard {
  rows: number; cols: number; parts: LabPlaced[]; ghost?: boolean; segs: LabSeg[]; cuts: LabCut[]; wires: LabWire[]; busRows: number[];
  cursor?: { r: number; c: number }; marks?: LabMark[]; hl?: number[]; hlNet?: number; arrows?: LabArrow[];
}
export interface LabLaneGeo { pi: number; top: number; bot: number; h: number; flex: boolean; pins: { node: number; off: number; dc: number; net: number; name: string }[] }
export interface LabTie { u: number; offU: number; v: number; offV: number; state: "idle" | "check" | "conflict" | "split" }
export interface LabLanes { order: number[]; nodeY: number[]; geo: LabLaneGeo[]; arrows: LabArrow[]; ties: LabTie[]; hl?: number[] }
export interface LabFrame { stage: 1 | 2 | 3 | 4 | 5 | 6 | 7; msg: string; lanes?: LabLanes; board?: LabBoard; relations?: { a: number; b: number; rel: "left" | "above" }[]; pair?: [number, number] }
export interface LabDecoded { eBase: number; hard: number; mess: number; H: number; W: number; board: LabBoard; wires: number; wireLen: number; cuts: number; bCuts: number; starved: number; relays: number; connEdge: number }
export interface LabStep { it: number; moves: number; T: number; w: number; g: LabGenome; d: LabDecoded; E: number; best: number; bestG: LabGenome; bestD: LabDecoded; kind: "better" | "worse-kept" | "worse-rejected" | "infeasible" | "null"; done: boolean }
// the lab's random numbers: the state of a mulberry32 stream (the anneal's
// generator), which every draw advances
export interface LabRng { state: number }
export interface LabApi {
  parts: { id: string; comp: Component; kind: "rigid" | "flex"; isConn: boolean; canH: boolean; canV: boolean; spans: [number, number]; pinNames: string[] }[];
  nets: { name: string; color: string; pins: { pi: number; name: string }[] }[];
  rigidIdx: number[];
  flexIdx: number[];
  initGenome: (rng: LabRng) => LabGenome;
  cloneG: (g: LabGenome) => LabGenome;
  mutate: (g: LabGenome, rng: LabRng) => LabGenome | null;
  decode: (g: LabGenome, frames?: boolean) => { d: LabDecoded | null; frames: LabFrame[]; g: LabGenome };
  run: (seed: number, moves: number, every: number, cb: (step: LabStep) => void) => void;
  // both finishes of one description, each stage by stage, with the price
  // each one came to; the editor ships whichever board is cheaper
  finishBoth: (g: LabGenome) => {
    start: LabBoard;
    router: { frames: LabFrame[]; price: number };
    repair: { frames: LabFrame[]; price: number; ok: boolean } | null;
  };
  T_START: number;
}

// one proposal of the anneal: which move kind, what it would have changed,
// and what happened to it. out: 0 mutate returned null, 1 infeasible decode,
// 2 rejected, 3 accepted. same: decoded to the same board as the current
// state. Deltas are raw counts (proposal minus current) so the log can be
// re-priced; dOther is the rest of eBase (aspect, connector edge, ring/span,
// locked lines). dEcur is at the ramp price of the moment, dEfin at W_MESS.
export interface MoveLogRec {
  it: number; kind: number; out: number; best: number; same: number;
  dEcur: number; dEfin: number; curFin: number;
  dArea: number; dWires: number; dWlen: number; dCuts: number; dBcuts: number;
  dMess: number; dHard: number; dStarv: number; dOther: number;
  // the hard penalty split by source (raw counts)
  dGeo: number; dOverlap: number; dStarvH: number;
}
// move kinds as numbered by mutate
export const MOVE_KINDS = ["throw", "pull", "swapP", "swapN", "swapBoth", "rot", "hv", "br", "grpMerge", "gap", "xgap", "grpSplit", "pullTie"];

const W_MESS = 400;     // final price per off-axis or crossing wire
const RAMP_START = 25;  // their price while the skeleton forms
const T_START = 150;    // anneal start temperature (see solveSeed)
const ROTS: Rot[] = [0, 90, 180, 270];
// the way a part's front face looks at each rotation (front() in rigidBodies)

interface RigidShape {
  w: number;
  h: number;
  dRow: number;
  dCol: number;
  // the package's true body relative to the shape's top-left hole, in
  // hole-centre terms; equals the shape's own cells unless it overhangs
  body: FootprintRect;
  // room held over the board by the package (a pot's shaft), same terms:
  // closed to other parts, but free to hang over the board's edge
  reach?: FootprintRect;
  // the package takes its wires in at one face: which board edge that face
  // looks at in this rotation
  entry?: "left" | "right" | "top" | "bottom";
  pins: { pinId: string; net: number | undefined; rowOff: number; colOff: number }[];
}

interface RigidPart {
  kind: "rigid";
  comp: Component;
  def: ComponentDef;
  locked: boolean;
  isConn: boolean;
  shapes: Map<Rot, RigidShape>;
}

interface FlexPart {
  kind: "flex";
  comp: Component;
  def: ComponentDef;
  locked: boolean;
  isConn: boolean;
  pinIds: [string | undefined, string | undefined];
  na: number | undefined;
  nb: number | undefined;
  minS: number;
  maxS: number;
  vdSet: Set<number>;
  canV: boolean;
  canH: boolean;
  dc0: number;
}

type Part = RigidPart | FlexPart;

export interface LabGenome {
  gp: number[]; gn: number[]; rot: number[]; hv: number[]; br: number[]; grp: number[][]; gap: number[]; xgap: number[];
}
interface Genome {
  gp: number[];
  gn: number[];
  rot: number[];
  hv: number[];
  br: number[];
  grp: number[][];
  // extra blank rows kept below a part (bus-row supply) and blank columns
  // kept right of it (attachment holes beside pins): slack the compaction
  // would otherwise squeeze out
  gap: number[];
  xgap: number[];
}

interface Decoded {
  eBase: number;
  slants: number;
  crossings: number;
  H: number;
  W: number;
  yI: Int32Array;
  xI: Int32Array;
  geo: { w: number; h: number; sh?: RigidShape; mode?: "H" | "V" }[];
  vBot: Map<number, number>;
  dbg?: Record<string, number | string[]>;
}

/** The finish alone, on a stored skeleton of this circuit (harness replay). */
export function finishFromSkeleton(
  board: Board,
  allComponents: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  allAssignments: NetAssignment[],
  skeleton: Skeleton,
  options?: FinishOptions
): AutoLayoutResult {
  const { components, netAssignments } = expandOffBoard(allComponents, componentDefs, allAssignments);
  const repaired = options?.repair === "never" ? null : finishRepair(board, components, componentDefs, nets, netAssignments, skeleton, options);
  if (repaired && (options?.repair === "only" || (options?.repair === "fallback" && repaired.ok))) return repaired.final;
  const routed = finishSkeleton(board, components, componentDefs, nets, netAssignments, skeleton, options);
  return repaired && repaired.ok && repaired.score < routed.score && !options?.repair ? repaired.final : routed.final;
}

export function computeAutoLayout5(
  board: Board,
  allComponents: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  allAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout5Options
): AutoLayoutResult {
  // An off-board part comes onto the board as one solder pad per wired pin,
  // each an ordinary one-hole connector from here on. Their placements go
  // back under the pads' own ids; the caller folds them onto the parent.
  const { components, netAssignments } = expandOffBoard(allComponents, componentDefs, allAssignments);
  const report = (phase: AutoLayoutProgress["phase"], frac: number) =>
    onProgress?.({ phase, attempt: 1, maxAttempts: 1, frac });

  const netIdx = new Map(nets.map((n, i) => [n.id, i]));
  const netByPin = new Map(netAssignments.map((a) => [a.componentId + ":" + a.pinId, netIdx.get(a.netId)]));

  // ── model ──
  const parts: Part[] = [];
  const skipped: Component[] = [];
  for (const c of components) {
    if (c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) {
      skipped.push(c);
      continue;
    }
    const locked = !!(c.locked && c.boardPos);
    const isConn = def.category === "connector";
    if (def.flexible) {
      const p0 = def.pins[0];
      const p1 = def.pins[1];
      const na = p0 !== undefined ? netByPin.get(c.id + ":" + p0.id) : undefined;
      const nb = p1 !== undefined ? netByPin.get(c.id + ":" + p1.id) : undefined;
      const D = allowedDrows(def);
      const vd = [...D.entries()].filter(([dr, dc]) => dr >= 1 && dc === 0).map(([dr]) => dr);
      const dc0 = D.get(0);
      if (vd.length === 0 && dc0 === undefined) {
        skipped.push(c);
        continue;
      }
      parts.push({
        kind: "flex", comp: c, def, locked, isConn,
        pinIds: [p0?.id, p1?.id], na, nb,
        minS: vd.length ? Math.min(...vd) : 0,
        maxS: vd.length ? Math.max(...vd) : 0,
        vdSet: new Set(vd),
        canV: vd.length > 0, canH: dc0 !== undefined, dc0: dc0 ?? 0,
      });
    } else {
      const shapes = new Map<Rot, RigidShape>();
      const pkg = resolvePackage(def, def.part?.value, def.part?.package);
      const sideEntry = pkg?.kind === "rigid" && !!pkg.spec.sideEntry;
      for (const rot of ROTS) {
        // every hole the package lies over, which is what it takes from the
        // board; an overhanging body is wider than its footprint cells
        const { body: body0, reach: reach0 } = rigidGeometry(def, { row: 0, col: 0 }, rot);
        const b0 = coveredHoles(body0);
        const pins: RigidShape["pins"] = [];
        for (const p of getRotatedPinPositions(def, { row: 0, col: 0 }, rot)) {
          pins.push({ pinId: p.pinId, net: netByPin.get(c.id + ":" + p.pinId), rowOff: p.row - b0.minRow, colOff: p.col - b0.minCol });
        }
        shapes.set(rot, {
          w: b0.maxCol - b0.minCol + 1, h: b0.maxRow - b0.minRow + 1, dRow: b0.minRow, dCol: b0.minCol, pins,
          body: { minRow: body0.minRow - b0.minRow, maxRow: body0.maxRow - b0.minRow, minCol: body0.minCol - b0.minCol, maxCol: body0.maxCol - b0.minCol },
          ...(sideEntry ? { entry: ENTRY_SIDE[rot] } : {}),
          ...(reach0 ? { reach: { minRow: reach0.minRow - b0.minRow, maxRow: reach0.maxRow - b0.minRow, minCol: reach0.minCol - b0.minCol, maxCol: reach0.maxCol - b0.minCol } } : {}),
        });
      }
      parts.push({ kind: "rigid", comp: c, def, locked, isConn, shapes });
    }
  }
  const nP = parts.length;
  // pads of one off-board part, which the builder wires as a bundle
  const siblingGroups = leadSiblings(parts.map((p) => p.comp))
    .map((ids) => ids.map((id) => parts.findIndex((p) => p.comp.id === id)));
  const flexIdx = parts.map((p, i) => (p.kind === "flex" ? i : -1)).filter((i) => i >= 0);
  const rigidIdx = parts.map((p, i) => (p.kind === "rigid" ? i : -1)).filter((i) => i >= 0);
  const lean = !!options?.schedule?.lean;
  // positions in rigidIdx of the parts a rotation can change
  const rotK = rigidIdx.map((pi, k) => { const sh = (parts[pi] as RigidPart).shapes.get(0); return sh && sh.w === 1 && sh.h === 1 && sh.pins.length <= 1 ? -1 : k; }).filter((k) => k >= 0);

  const emptyResult = (issues: string[]): AutoLayoutResult => ({
    placements: [], cuts: [], wires: [], issues, quality: skipped.length * 2,
    starvedNetIds: [], unplaceIds: skipped.map((c) => c.id),
  });
  if (nP === 0) return emptyResult(skipped.length ? ["no placeable components"] : []);

  const netPins: { pi: number; kind: "flex" | "rigid"; end?: number; pinId?: string }[][] = nets.map(() => []);
  parts.forEach((p, pi) => {
    if (p.kind === "flex") {
      if (p.na !== undefined) netPins[p.na].push({ pi, kind: "flex", end: 0 });
      if (p.nb !== undefined) netPins[p.nb].push({ pi, kind: "flex", end: 1 });
    } else {
      for (const sp of p.shapes.get(0)!.pins) {
        if (sp.net !== undefined) netPins[sp.net].push({ pi, kind: "rigid", pinId: sp.pinId });
      }
    }
  });

  const lockedColsCap = board.lockedCols ? board.cols : undefined;
  const lockedRowsCap = board.lockedRows ? board.rows : undefined;
  const seedsN = Math.max(1, options?.seeds ?? 6);
  // quality cap by pin count, measured on the hand-built corpus
  // (2026-09-08): up to ~16 pins a run is done well before 40k moves; from
  // there the useful length grows about linearly with the pin count, each
  // doubling still buying ~5% at eight times the old cap of 160k, which is
  // where the cap now sits. A time budget can only lower the count. An
  // effort scales the formula instead and drops the ceiling.
  const nPins = netPins.reduce((n, l) => n + l.length, 0);
  const capMoves = options?.effort !== undefined ? effortMoves(nPins, options.effort) : Math.min(1280000, Math.max(40000, 16000 * (nPins - 13)));
  // a time budget with a known speed becomes a count on a ladder: 5k steps up
  // to 100k, 5% steps above, so ordinary load noise lands on the same rung
  const plannedMoves = (n: number) => {
    const step = Math.max(5000, Math.round((n * 0.05) / 1000) * 1000);
    return Math.min(capMoves, Math.max(40000, Math.round(n / step) * step));
  };
  const movesN = options?.moves ??
    (options?.timeBudgetMs !== undefined && options?.msPerMoveHint ? plannedMoves(options.timeBudgetMs / options.msPerMoveHint) : capMoves);
  const wBCut = options?.drilledCutsOnly ? W_BCUT_DRILL : W_BCUT;
  const anyLockedPart = parts.some((p) => p.locked);
  // free board lines a flexible body keeps to any neighbour: what the user
  // asked for, or what its real width takes anyway, whichever is more
  const profOf = parts.map((p) => (p.kind === "flex" ? flexProfile(p.def) : undefined));
  // free lines each part asks for on top of its size; a rigid part only when
  // the project wants extra room between all parts
  const linesOf = parts.map((p, i) => profOf[i]?.lines ?? p.def.clearance ?? 0);
  const clrOf = parts.map((p, i) => {
    const prof = profOf[i];
    if (!prof) return linesOf[i];
    const r = flexBody(prof, { row: 0, col: 0 }, { row: Math.max(1, (p as FlexPart).minS), col: 0 }).r;
    return Math.max(prof.lines, Math.ceil(r - 0.5 - 1e-6));
  });
  // only a body about a pitch wide or more covers holes beside its own line
  const fatOf = clrOf.map((_, i) => {
    const prof = profOf[i];
    return !!prof && flexBody(prof, { row: 0, col: 0 }, { row: Math.max(1, (parts[i] as FlexPart).minS), col: 0 }).r > 0.95;
  });
  // a pair can be too close from as far as both reaches together
  const clrPad = 2 + 2 * Math.max(0, ...clrOf);
  const connSides = options?.connSides ?? { top: true, bottom: true, left: true, right: true };
  const mCol = anyLockedPart || lockedColsCap !== undefined ? 0 : 1;
  const mRow = anyLockedPart || lockedRowsCap !== undefined ? 0 : 1;

  // ── genotype ──
  const cloneG = (g: Genome): Genome => ({
    gp: g.gp.slice(), gn: g.gn.slice(), rot: g.rot.slice(),
    hv: g.hv.slice(), br: g.br.slice(), grp: g.grp.map((a) => a.slice()), gap: g.gap.slice(), xgap: g.xgap.slice(),
  });
  const rotOfPart = (g: Genome, pi: number): Rot => {
    const p = parts[pi];
    if (p.locked) return (ROTS as number[]).includes(p.comp.rotation) ? (p.comp.rotation as Rot) : 0;
    return ROTS[g.rot[rigidIdx.indexOf(pi)] ?? 0];
  };
  const flexBit = (arr: number[], pi: number) => arr[flexIdx.indexOf(pi)];

  // ── explainer wording ──
  const labelOf = (pi: number) => parts[pi].comp.label;
  const netName = (n: number) => (n >= 0 && n < nets.length ? nets[n].name : "an unconnected pin");
  const pinNameOf = (pi: number, pinId: string | undefined, end: number | undefined) => {
    const p = parts[pi];
    if (p.kind === "rigid") return p.def.pins.find((q) => q.id === pinId)?.name ?? pinId ?? "";
    return String((end ?? 0) + 1);
  };
  const rowsWord = (k: number) => `${k} row${k === 1 ? "" : "s"}`;

  // each part's size and shape under a genome
  const geoOf = (g: Genome): Decoded["geo"] => parts.map((p, pi) => {
    if (p.kind === "rigid") {
      const sh = p.shapes.get(rotOfPart(g, pi))!;
      return { w: sh.w, h: sh.h, sh };
    }
    const mode: "H" | "V" = flexBit(g.hv, pi) === 1 && p.canH ? "H" : "V";
    return mode === "H" ? { w: p.dc0 + 1, h: 1, mode } : { w: 1, h: 0, mode };
  });

  // ── the decoder, in WebAssembly ──
  const wasmModel = (): WasmModel => {
    const sideMask = (s: ConnSides) => (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.top ? 4 : 0) | (s.bottom ? 8 : 0);
    const sideCode = { left: 0, right: 1, top: 2, bottom: 3 };
    const rect = (r: FootprintRect): [number, number, number, number] => [r.minRow, r.maxRow, r.minCol, r.maxCol];
    const shapeKinds: Record<string, number> = { axial: 1, can: 2, led: 3 };
    const pullGroups = netPins.map((pins, net) => ({ net, parts: [...new Set(pins.map((x) => x.pi))] })).filter((g) => g.parts.length >= 2);
    return {
      parts: parts.map((p, pi) => {
        const sidesOf = options?.connSidesOf?.(p.comp.id);
        const common = { locked: p.locked, isConn: p.isConn, clr: clrOf[pi], lines: linesOf[pi], fat: fatOf[pi], sides: sidesOf ? sideMask(sidesOf) : -1 };
        if (p.kind === "rigid") {
          const lockRot = p.locked ? Math.max(0, (ROTS as number[]).indexOf(p.comp.rotation)) : 0;
          const lsh = p.shapes.get(ROTS[lockRot])!;
          return {
            ...common, kind: 0 as const, idx: rigidIdx.indexOf(pi), lockRot,
            lockY0: p.locked ? p.comp.boardPos!.row + lsh.dRow : 0, lockY1: 0, lockX: p.locked ? p.comp.boardPos!.col + lsh.dCol : 0,
            shapes: ROTS.map((r) => {
              const sh = p.shapes.get(r)!;
              return { w: sh.w, h: sh.h, entry: sh.entry ? sideCode[sh.entry] : -1, body: rect(sh.body), reach: sh.reach && rect(sh.reach), pins: sh.pins.map((q) => ({ rowOff: q.rowOff, colOff: q.colOff, net: q.net ?? -1 })) };
            }),
          };
        }
        const bp = p.comp.boardPos, ep = p.comp.flexibleEndPos ?? bp;
        const spec = profOf[pi]!.spec;
        return {
          ...common, kind: 1 as const, idx: flexIdx.indexOf(pi), lockRot: 0,
          lockY0: p.locked ? Math.min(bp!.row, ep!.row) : 0, lockY1: p.locked ? Math.max(bp!.row, ep!.row) : 0, lockX: p.locked ? Math.min(bp!.col, ep!.col) : 0,
          flex: {
            na: p.na ?? -1, nb: p.nb ?? -1, minS: p.minS, maxS: p.maxS, canH: p.canH, dc0: p.dc0,
            vd: Array.from({ length: p.maxS + 1 }, (_, s) => p.vdSet.has(s)),
            hasSpec: !!spec, shape: spec ? shapeKinds[spec.shape] ?? 0 : 0, mark: !!spec?.mark, len: spec?.len ?? 0, r: spec ? bodyWidth(spec) / 2 / MM_PER_HOLE : 0,
          },
        };
      }),
      nNets: nets.length,
      netPins: netPins.map((pins) => pins.map((q) => ({
        pi: q.pi, kind: q.kind === "rigid" ? 0 as const : 1 as const, end: q.end ?? 0,
        pinIdx: q.kind === "rigid" ? ROTS.map((r) => (parts[q.pi] as RigidPart).shapes.get(r)!.pins.findIndex((x) => x.pinId === q.pinId)) : [0, 0, 0, 0],
      }))),
      flexIdx, rigidIdx, siblingGroups,
      mRow, mCol, lockedRowsCap: lockedRowsCap ?? -1, lockedColsCap: lockedColsCap ?? -1,
      sidesDef: sideMask(connSides), clrPad, wBCut,
      conns: parts.map((p, i) => (p.isConn && !p.locked ? i : -1)).filter((i) => i >= 0),
      pullNets: pullGroups.map((g) => g.parts),
      pullNet: pullGroups.map((g) => g.net),
      halfTurn: rigidIdx.map((pi) => !!parts[pi].def.halfTurnOnly),
      canHV: flexIdx.map((pi) => { const p = parts[pi] as FlexPart; return p.canH && p.canV; }),
      rotK,
    };
  };
  const wasmOf = (): WebAssembly.Module => {
    if (!options?.wasm) throw new Error("the v5 layouter needs its WebAssembly module (v5wasm/v5decode.wasm)");
    return options.wasm;
  };

  // ── the decoder's board and walkthrough, from the WebAssembly export ──
  // A decode with the export on (a decoder of its own: the anneal's keeps
  // its state) lists the board the way the explainer and the repair finish
  // draw it; with the trace on it also lists the decoder's steps, which this
  // turns into the explainer's frames.
  let exportDec: V5WasmDecoder | null = null;
  const exportDecoder = () => (exportDec ??= new V5WasmDecoder(wasmOf(), wasmModel()));
  const exportDecode = (g: Genome, trace: boolean): { o: WasmDecodeOut; ex: WasmExport } => {
    exportDecoder().setExport(true, trace);
    const w = exportDecoder();
    w.writeGenome(g);
    const o = w.decode();
    w.grpBack(g.grp);
    return { o, ex: w.exported() };
  };
  function labWalk(g: Genome, o: WasmDecodeOut, ex: WasmExport, withFrames: boolean): { board: LabBoard | null; frames: LabFrame[] } {
    const frames: LabFrame[] = [];
    const pushF = (f: LabFrame) => { if (withFrames) frames.push(f); };
    const posP = new Int32Array(nP), posN = new Int32Array(nP);
    g.gp.forEach((p, i) => (posP[p] = i));
    g.gn.forEach((p, i) => (posN[p] = i));
    if (withFrames) {
      const rels: { a: number; b: number; rel: "left" | "above" }[] = [];
      for (const a of g.gp) for (const b of g.gp) if (a !== b && posP[a] < posP[b]) rels.push({ a, b, rel: posN[a] < posN[b] ? "left" : "above" });
      pushF({ stage: 1, msg: "The two orders, and nothing else.", relations: [] });
      rels.forEach((r, i) => pushF({ stage: 1, msg: `${labelOf(r.a)} comes before ${labelOf(r.b)} in ${r.rel === "left" ? `both orders: ${labelOf(r.a)} is left of ${labelOf(r.b)}` : `the first order but after it in the second: ${labelOf(r.a)} is above ${labelOf(r.b)}`}.`, relations: rels.slice(0, i + 1), pair: [r.a, r.b] }));
      pushF({ stage: 1, msg: "Every pair has exactly one relation. That is the whole packing, still without a single coordinate.", relations: rels });
    }
    const geo = geoOf(g);
    const vBot = new Map<number, number>();
    let nNode = nP;
    for (const pi of flexIdx) if (geo[pi].mode === "V") vBot.set(pi, nNode++);
    nNode++;
    const vBotArr = new Int32Array(nP).fill(-1);
    for (const [pi, b2] of vBot) vBotArr[pi] = b2;
    const nodePart = (n: number) => { for (const [pi, b] of vBot) if (b === n) return pi; return n; };
    const nodeName = (n: number) => { const pi = nodePart(n); return n === pi ? labelOf(pi) : `${labelOf(pi)}'s lower end`; };
    const labLaneGeo = (): LabLaneGeo[] => parts.map((p, pi) => {
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        return { pi, top: pi, bot: pi, h: sh.h, flex: false, pins: sh.pins.map((sp) => ({ node: pi, off: sp.rowOff, dc: sp.colOff, net: sp.net ?? -1, name: pinNameOf(pi, sp.pinId, undefined) })) };
      }
      const br = flexBit(g.br, pi);
      const nA = (br === 0 ? p.na : p.nb) ?? -1, nB = (br === 0 ? p.nb : p.na) ?? -1;
      if (geo[pi].mode === "H") return { pi, top: pi, bot: pi, h: 1, flex: true, pins: [{ node: pi, off: 0, dc: 0, net: nA, name: br === 0 ? "1" : "2" }, { node: pi, off: 0, dc: p.dc0, net: nB, name: br === 0 ? "2" : "1" }] };
      const b = vBot.get(pi)!;
      return { pi, top: pi, bot: b, h: 0, flex: true, pins: [{ node: pi, off: 0, dc: 0, net: nA, name: br === 0 ? "1" : "2" }, { node: b, off: 0, dc: 0, net: nB, name: br === 0 ? "2" : "1" }] };
    });
    // the y and x constraint edges, as the trace lists them
    let eU: number[] = [], eV: number[] = [], eW: number[] = [], nE = 0;
    let xU: number[] = [], xV: number[] = [], xW: number[] = [], nX = 0;
    const SRC = nNode - 1, XS = nP;
    const labArrows = (state: LabArrowState, nE2: number, hot = -1): LabArrow[] => {
      const out: LabArrow[] = [];
      for (let ei = 0; ei < nE2; ei++) { if (eU[ei] === SRC || eV[ei] === SRC || eW[ei] < 0) continue; out.push({ a: eU[ei], b: eV[ei], w: eW[ei], state: ei === hot ? "push" : state }); }
      return out;
    };
    const labLanes = (nodeY: number[], arrows: LabArrow[], ties: LabTie[], hl?: number[]): LabLanes => ({ order: g.gp.slice(), nodeY, geo: labLaneGeo(), arrows, ties, hl });
    const labPlaced = (yArr: ArrayLike<number>, xArr: ArrayLike<number>, shift: number): LabPlaced[] => parts.map((p, pi) => {
      const yv = (n: number) => (yArr[n] < -1e17 ? 0 : yArr[n]) + shift, xv = (n: number) => (xArr[n] < -1e17 ? 0 : xArr[n]) + shift;
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        return { pi, x: xv(pi), y: yv(pi), w: sh.w, h: sh.h, flex: false, pos: { row: yv(pi) - sh.dRow, col: xv(pi) - sh.dCol }, rot: rotOfPart(g, pi), pins: sh.pins.map((sp) => ({ r: yv(pi) + sp.rowOff, c: xv(pi) + sp.colOff, net: sp.net ?? -1, name: pinNameOf(pi, sp.pinId, undefined), id: sp.pinId })) };
      }
      const br = flexBit(g.br, pi);
      const nA = (br === 0 ? p.na : p.nb) ?? -1, nB = (br === 0 ? p.nb : p.na) ?? -1;
      if (geo[pi].mode === "H") return { pi, x: xv(pi), y: yv(pi), w: p.dc0 + 1, h: 1, flex: true, rot: 0, pos: { row: yv(pi), col: xv(pi) + (br === 0 ? 0 : p.dc0) }, end: { row: yv(pi), col: xv(pi) + (br === 0 ? p.dc0 : 0) }, pins: [{ r: yv(pi), c: xv(pi), net: nA, name: br === 0 ? "1" : "2", id: br === 0 ? "1" : "2" }, { r: yv(pi), c: xv(pi) + p.dc0, net: nB, name: br === 0 ? "2" : "1", id: br === 0 ? "2" : "1" }] };
      const b = vBot.get(pi)!;
      return { pi, x: xv(pi), y: yv(pi), w: 1, h: yv(b) - yv(pi) + 1, flex: true, rot: 0, pos: { row: br === 0 ? yv(pi) : yv(b), col: xv(pi) }, end: { row: br === 0 ? yv(b) : yv(pi), col: xv(pi) }, pins: [{ r: yv(pi), c: xv(pi), net: nA, name: br === 0 ? "1" : "2", id: br === 0 ? "1" : "2" }, { r: yv(b), c: xv(pi), net: nB, name: br === 0 ? "2" : "1", id: br === 0 ? "2" : "1" }] };
    });
    const tieIdle = (t: LabTie): LabTie => ({ ...t, state: "idle" });
    const tieConflict = (t: LabTie): LabTie => ({ ...t, state: "conflict" });
    let labTies: LabTie[] = [];
    let rootArr: number[] = [];
    let y: number[] = [];
    let xd: number[] = new Array(nP + 1).fill(-1e18);
    xd[XS] = 0;
    const labXArrows = (state: LabArrowState, hot = -1): LabArrow[] => { const out: LabArrow[] = []; for (let ei = 0; ei < nX; ei++) { if (xU[ei] === XS || xV[ei] === XS) continue; out.push({ a: xU[ei], b: xV[ei], w: xW[ei], state: ei === hot ? "push" : state }); } return out; };
    const labRowsNow = () => { let h = 0; for (let pi = 0; pi < nP; pi++) h = Math.max(h, (vBotArr[pi] >= 0 ? y[vBotArr[pi]] : y[pi] + geo[pi].h - 1) + 1); return h; };
    const labColsNow = () => { let w = 0; for (let pi = 0; pi < nP; pi++) w = Math.max(w, (xd[pi] < -1e17 ? 0 : xd[pi]) + geo[pi].w); return w; };
    const labY0 = new Array(nNode - 1).fill(0);
    const GH = ex.GH, GW = ex.GW;
    let labParts: LabPlaced[] = [];
    const labSegs: LabSeg[] = [], labCuts: LabCut[] = [], labWires: LabWire[] = [], busRows: number[] = [];
    let nSegAt = 0, nWireAt = 0;
    const segOf = (i: number): LabSeg => ({ row: ex.segs[4 * i], c1: ex.segs[4 * i + 1], c2: ex.segs[4 * i + 2], net: ex.segs[4 * i + 3] });
    const wireOf = (i: number): LabWire => ({ r1: ex.wires[7 * i], c1: ex.wires[7 * i + 1], r2: ex.wires[7 * i + 2], c2: ex.wires[7 * i + 3], net: ex.wires[7 * i + 4], slanted: ex.wires[7 * i + 5] === 1, crossings: ex.wires[7 * i + 6] });
    const labBoard5 = (extra: Partial<LabBoard> = {}): LabBoard => ({ rows: GH, cols: GW, parts: labParts, segs: [...labSegs], cuts: [...labCuts], wires: [...labWires], busRows: [...busRows], ...extra });
    const labBoardAt = (fromRow: number, extra: Partial<LabBoard> = {}): LabBoard => ({ rows: GH, cols: GW, parts: labParts, segs: [...labSegs, ...Array.from({ length: GH - fromRow }, (_, k) => ({ row: fromRow + k, c1: 0, c2: GW - 1, net: -1 }))], cuts: [...labCuts], wires: [...labWires], busRows: [], ...extra });
    // the board once rows and columns are known: parts, then the row scan
    const scan = () => {
      labParts = labPlaced(o.yI, o.xI, 0).map((p) => ({ ...p, x: p.x + mCol, y: p.y + mRow, pos: { row: p.pos.row + mRow, col: p.pos.col + mCol }, end: p.end && { row: p.end.row + mRow, col: p.end.col + mCol }, pins: p.pins.map((q) => ({ ...q, r: q.r + mRow, c: q.c + mCol })) }));
      pushF({ stage: 4, msg: `The board gets ${mRow ? "one blank line of margin on every side, and" : ""} every row is one copper strip. Now each row is read from left to right.`, board: labBoardAt(0) });
      let ci = 0;
      const nScan = ex.segs.length / 4 - relays;
      for (let r = 0; r < GH; r++) {
        if (nSegAt < nScan && ex.segs[4 * nSegAt] === r && ex.segs[4 * nSegAt + 3] === -1 && busRowSet.has(r)) {
          busRows.push(r);
          labSegs.push(segOf(nSegAt++));
          pushF({ stage: 4, msg: `Row ${r + 1} carries no pin at all: a bus row, spare copper any net may borrow to travel sideways.`, board: labBoardAt(r + 1, { busRows: [...busRows], cursor: { r, c: GW - 1 } }) });
          continue;
        }
        pushF({ stage: 4, msg: `Row ${r + 1}.`, board: labBoardAt(r, { busRows: [...busRows], cursor: { r, c: 0 } }) });
        while (ci < ex.cuts.length / 4 && ex.cuts[4 * ci] === r) {
          const prev = segOf(nSegAt++);
          labSegs.push(prev);
          const cut = { row: r, col: ex.cuts[4 * ci + 1], kind: ex.cuts[4 * ci + 2] === 1 ? "knife" as const : "hole" as const };
          labCuts.push(cut);
          const next = segOf(nSegAt);
          pushF({ stage: 4, msg: `Row ${r + 1}: ${netName(prev.net)} on the left, ${netName(next.net)} on the right. The strip is cut ${cut.kind === "hole" ? "by drilling out the spare hole between them" : "with a knife between the two holes, since no spare hole is free"}.`, board: labBoardAt(r + 1, { busRows: [...busRows], cursor: { r, c: ex.cuts[4 * ci + 3] }, segs: [...labSegs, { row: r, c1: next.c1, c2: GW - 1, net: -1 }, ...Array.from({ length: GH - r - 1 }, (_, q) => ({ row: r + 1 + q, c1: 0, c2: GW - 1, net: -1 }))] }) });
          ci++;
        }
        labSegs.push(segOf(nSegAt++));
      }
      pushF({ stage: 4, msg: `${o.cuts} cuts${o.bCuts ? `, ${o.bCuts} of them with a knife` : ""}, ${busRows.length} bus rows. Every strip segment now carries one net or none.`, board: labBoardAt(GH, { busRows: [...busRows] }) });
    };
    const busRowSet = new Set(ex.busRows);
    const relays = o.status === 2 ? o.relays : 0;
    // replay the trace
    const T = ex.trace;
    let p = 0, net = -1;
    const vals = (n: number) => Array.from(T.subarray(p, (p += n)));
    while (withFrames && p < T.length) {
      const code = T[p++];
      if (code === 1) {
        nE = T[p++];
        eU = []; eV = []; eW = [];
        for (let ei = 0; ei < nE; ei++) { eU.push(T[p++]); eV.push(T[p++]); eW.push(T[p++]); }
        pushF({ stage: 2, msg: "Every part starts on row 0. Each above-relation becomes an arrow: the lower part must sit at least the upper part's height plus its clearance further down.", lanes: labLanes(new Array(nNode - 1).fill(0), labArrows("idle", nE), []) });
      } else if (code === 2) {
        labTies = [];
      } else if (code === 3) {
        const [n, k, u, ou, v, ov] = vals(6);
        const pins = netPins[n];
        pushF({ stage: 2, msg: nodePart(u) === nodePart(v)
          ? `Two ${nets[n].name} pins of ${labelOf(nodePart(u))} sit on different rows of the part, yet they are asked to share a strip. That cannot hold, so one of them is split into a strip group of its own; it will get a link wire later instead.`
          : `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} are asked to share a strip too, but the ties already fix those parts at a distance that puts these pins on different rows. That cannot hold, so the ${nets[n].name} pin of ${labelOf(pins[k].pi)} is split into a strip group of its own; it will get a link wire later instead.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map(tieIdle).concat([{ u, offU: ou, v, offV: ov, state: "split" as const }]), [nodePart(u), nodePart(v)]) });
      } else if (code === 4) {
        const [n, u, ou, v, ov] = vals(5);
        pushF({ stage: 2, msg: `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} share a strip as well, and the distance already fits.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map(tieIdle).concat([{ u, offU: ou, v, offV: ov, state: "check" as const }]), [nodePart(u), nodePart(v)]) });
      } else if (code === 5) {
        const [n, u, ou, v, ov, dd] = vals(6);
        labTies.push({ u, offU: ou, v, offV: ov, state: "idle" });
        pushF({ stage: 2, msg: `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} are asked to share a strip, so ${nodeName(v)} is tied to ${nodeName(u)}: from now on they move together, ${dd === 0 ? "tops level" : `${nodeName(v)} ${rowsWord(Math.abs(dd))} ${dd > 0 ? "below" : "above"}`}.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map((t, i): LabTie => ({ ...t, state: i === labTies.length - 1 ? "check" : "idle" })), [nodePart(u), nodePart(v)]) });
      } else if (code === 6) {
        rootArr = vals(nNode);
      } else if (code === 7) {
        const [cu, cv, cw, offU, offV] = vals(5);
        pushF({ stage: 2, msg: `The ties fix ${nodeName(cv)} ${rowsWord(Math.abs(offV - offU))} ${offV >= offU ? "below" : "above"} ${nodeName(cu)}, but the orders say ${nodeName(cv)} is below ${nodeName(cu)} by at least ${rowsWord(cw)}. Both cannot hold.`, lanes: labLanes(labY0, labArrows("idle", nE).map((a) => (a.a === cu && a.b === cv ? { ...a, state: "conflict" } : a)), labTies.map(tieConflict), [nodePart(cu), nodePart(cv)]) });
      } else if (code === 8 || code === 11) {
        const [n, k] = vals(2);
        pushF({ stage: 2, msg: code === 8
          ? `The decoder splits the ${nets[n].name} pin of ${labelOf(netPins[n][k].pi)} into a strip group of its own and starts over. That pin will get a link wire later instead.`
          : `No rows can satisfy all of them at once. The decoder splits the ${nets[n].name} pin of ${labelOf(netPins[n][k].pi)} into a strip group of its own and starts over.`, lanes: labLanes(labY0, labArrows("idle", nE), [], [netPins[n][k].pi]) });
      } else if (code === 9) {
        const oe = T[p++];
        const nodeY = vals(nNode - 1);
        const tgt = eV[oe], src = eU[oe];
        const mates = [...Array(nP).keys()].filter((q) => q !== nodePart(tgt) && rootArr[q] === rootArr[tgt]).map(labelOf);
        const span = nodePart(src) === nodePart(tgt);
        pushF({ stage: 2, msg: span
          ? `${nodeName(tgt)} sits at least ${rowsWord(eW[oe])} below its upper end, so it moves down to row ${nodeY[tgt] + 1}.`
          : `${nodeName(tgt)} must be at least ${rowsWord(eW[oe])} below ${nodeName(src)}, so it moves down to row ${nodeY[tgt] + 1}${mates.length ? `, and ${mates.join(" and ")}, tied to it, ${mates.length > 1 ? "move" : "moves"} along` : ""}.`,
          lanes: labLanes(nodeY, labArrows("idle", nE, oe), labTies, [nodePart(tgt), ...mates.map((m) => parts.findIndex((q) => q.comp.label === m))]) });
      } else if (code === 10) {
        const it = T[p++];
        pushF({ stage: 2, msg: `Sweep ${it + 1}: parts are still moving down. The arrows chase each other in a circle through the ties.`, lanes: labLanes(vals(nNode - 1), labArrows("check", nE), labTies) });
      } else if (code === 12) {
        y = vals(nNode - 1);
        pushF({ stage: 2, msg: "Nothing moves any more. These are the rows.", lanes: labLanes(Array.from({ length: nNode - 1 }, (_, n) => y[n]), labArrows("ok", nE), []) });
      } else if (code === 13) {
        nX = T[p++];
        xU = []; xV = []; xW = [];
        for (let ei = 0; ei < nX; ei++) { xU.push(T[p++]); xV.push(T[p++]); xW.push(T[p++]); }
        pushF({ stage: 3, msg: "Rows are known, so the parts can be drawn. Every part starts in column 0. Each left-of relation becomes an arrow: the right part must sit at least the left part's width plus the gap further right.", board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(y, xd, 0), ghost: true, segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("idle") } });
      } else if (code === 14) {
        const ei = T[p++];
        xd = vals(nP + 1);
        const u = xU[ei], v = xV[ei];
        pushF({ stage: 3, msg: `${labelOf(v)} must be at least ${xW[ei]} columns right of ${labelOf(u)}, so it moves to column ${Math.round(xd[v]) + 1}.`, board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(y, xd, 0), ghost: true, segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("idle", ei), hl: [v] } });
      } else if (code === 15) {
        for (let i = 0; i < nP; i++) xd[i] = o.xI[i];
        pushF({ stage: 3, msg: `Nothing moves any more. Every part has a row and a column: a ${labRowsNow()} by ${labColsNow()} board, as tight as the relations allow.`, board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(o.yI, o.xI, 0), segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("ok") } });
        scan();
      } else if (code === 16) {
        net = T[p++];
        const k = T[p++];
        pushF({ stage: 5, msg: `${netName(net)} has pins on ${k} strip segments. They have to be joined by link wires.`, board: labBoard5({ hlNet: net }) });
      } else if (code === 17) {
        const w1 = wireOf(nWireAt++), w2 = wireOf(nWireAt++);
        labWires.push(w1, w2);
        labSegs.push(segOf(nSegAt++));
        pushF({ stage: 5, msg: `${netName(net)}: no column has a free hole on both segments, so the decoder takes a detour: one hop along column ${w1.c1 + 1} to bus row ${w1.r2 + 1}, ${Math.abs(w1.c1 - w2.c1)} holes of borrowed copper, and a hop back along column ${w2.c1 + 1}. Two straight wires instead of one slanted one.`, board: labBoard5({ hlNet: net }) });
      } else if (code === 18) {
        const w = wireOf(nWireAt++);
        labWires.push(w);
        const nm = T[p++];
        const marks: LabMark[] = [];
        for (let m = 0; m < nm; m++) {
          const c = T[p++], ok = T[p++] === 1;
          marks.push({ r: w.r1, c, kind: ok ? "ok" : "bad" }, { r: w.r2, c, kind: ok ? "ok" : "bad" });
        }
        pushF({ stage: 5, msg: `${netName(net)}: the cheapest link runs straight down column ${w.c1 + 1}, ${Math.abs(w.r1 - w.r2)} holes long${w.crossings ? `, over ${w.crossings} part${w.crossings === 1 ? "" : "s"}, which is charged as mess` : ""}.`, board: labBoard5({ hlNet: net, marks }) });
      } else if (code === 19) {
        labWires.push(wireOf(nWireAt++));
        pushF({ stage: 5, msg: `${netName(net)}: no straight link and no relay either. The decoder records a slanted wire and charges for it, so the annealer knows this description is nearly right, not hopeless.`, board: labBoard5({ hlNet: net }) });
      } else if (code === 20) {
        const n = T[p++];
        pushF({ stage: 5, msg: `${netName(n)}: one of its segments has no free hole left for a wire to attach to. The decoder charges a heavy price for the starved pin and moves on.`, board: labBoard5({ hlNet: n }) });
      } else throw new Error(`v5 trace: unknown event ${code}`);
    }
    if (o.status !== 2) return { board: null, frames };
    if (!withFrames) {
      // the whole board at once
      labParts = labPlaced(o.yI, o.xI, 0).map((q) => ({ ...q, x: q.x + mCol, y: q.y + mRow, pos: { row: q.pos.row + mRow, col: q.pos.col + mCol }, end: q.end && { row: q.end.row + mRow, col: q.end.col + mCol }, pins: q.pins.map((pp) => ({ ...pp, r: pp.r + mRow, c: pp.c + mCol })) }));
      for (let i = 0; i < ex.segs.length / 4; i++) labSegs.push(segOf(i));
      for (let i = 0; i < ex.cuts.length / 4; i++) labCuts.push({ row: ex.cuts[4 * i], col: ex.cuts[4 * i + 1], kind: ex.cuts[4 * i + 2] === 1 ? "knife" : "hole" });
      for (let i = 0; i < ex.wires.length / 7; i++) labWires.push(wireOf(i));
      busRows.push(...ex.busRows);
    }
    const board = labBoard5();
    const mess = o.slants + o.crossings;
    pushF({ stage: 5, msg: `Every net is joined: ${o.wires} link wire${o.wires === 1 ? "" : "s"} of total length ${o.wireLen} hole${o.wireLen === 1 ? "" : "s"}.`, board });
    pushF({ stage: 6, msg: `Board ${GH} by ${GW} = ${GH * GW} cells, ${o.wires} link wires of total length ${o.wireLen}, ${o.cuts} cuts${o.bCuts ? ` (${o.bCuts} with a knife)` : ""}, ${mess} messy wire${mess === 1 ? "" : "s"}${o.starvedHard ? `, ${o.starvedHard} starved pin${o.starvedHard === 1 ? "" : "s"}` : ""}${o.connEdge ? `, a connector away from the edge` : ""}. Score ${(o.eBase + W_MESS * mess).toFixed(1)}.`, board });
    return { board, frames };
  }

  // the anneal's own decoder (the loop in C keeps its state there)
  let annealDecInst: V5WasmDecoder | null = null;
  const annealDec = () => (annealDecInst ??= new V5WasmDecoder(wasmOf(), wasmModel()));

  if (options?.speedProbe) {
    const w = annealDec();
    w.rngSet(1);
    const t0p = performance.now();
    for (let i = 0; i < options.speedProbe; i++) {
      w.writeGenome(w.labInit());
      w.decode();
    }
    options.onSpeedProbe?.((performance.now() - t0p) / options.speedProbe);
    return emptyResult([]);
  }

  // ── SA with penalty ramp ──
  // the Decoded of a board the WebAssembly decoder measured
  const decodedOf = (g: Genome, o: WasmDecodeOut): Decoded => {
    const geo = geoOf(g);
    const vBot = new Map<number, number>();
    let nNode = nP;
    for (const pi of flexIdx) if (geo[pi].mode === "V") vBot.set(pi, nNode++);
    return {
      eBase: o.eBase, slants: o.slants, crossings: o.crossings, H: o.H, W: o.W, yI: o.yI, xI: o.xI, geo, vBot,
      dbg: { wires: o.wires, wireLen: o.wireLen, relays: o.relays, cuts: o.cuts, bCuts: o.bCuts, starved: o.starved, starvedHard: o.starvedHard, geoBad: o.geoBad, overlapBad: o.overlapBad, connEdge: o.connEdge, lockOver: o.lockOver, spanBad: o.spanBad, hardSegs: [] },
    };
  };
  // one seed's walk, run by the loop in C, which stops at every new best for
  // the exact finish
  function solveSeed(seed: number, seedPos: number): { E: number; g: Genome; d: Decoded; exact: { final: AutoLayoutResult; score: number } | null; exactN: number } | null {
    const w = annealDec();
    if (options?.pullTie === false) w.setPullTie(false);
    if (options?.moveMix) w.setMix(options.moveMix.early, options.moveMix.late, options.moveMix.lateFrom);
    w.setShape(options?.schedule?.shape ?? 1);
    const timed = options?.timeBudgetMs !== undefined && options?.moves === undefined && !options?.msPerMoveHint;
    const t0 = options?.schedule?.t0 ?? T_START * (options?.schedule?.t0Scale ?? 1);
    const tEnd = options?.schedule?.tEnd ?? 0.15;
    w.onReport = (f) => report("arrange", options?.seedIndex !== undefined ? f : (seedPos + f) / seedsN);
    w.annealStart({
      seedState: ((seed + 1) * 0x9e3779b9) >>> 0, strictSeed: ((seed + 1) * 0x85ebca6b) >>> 0,
      protect: options?.protectTies === true ? 1 : Number(options?.protectTies ?? 0),
      movesN, timed, budgetMs: options?.timeBudgetMs ?? 0, t0, tEnd, coldT: options?.schedule?.coldT ?? 0, cool: Math.pow(tEnd / t0, 1 / movesN),
      rampStart: options?.schedule?.rampStart ?? RAMP_START, rampEnd: movesN * (options?.schedule?.rampEndFrac ?? 1), hardStart: options?.schedule?.hardStart ?? 1,
      reportEvery: Math.max(400, Math.floor(movesN / 100)), lean,
    });
    const ml = options?.moveLog;
    w.setMoveLog(!!ml);
    if (ml) {
      const rec: MoveLogRec = { it: 0, kind: -1, out: 0, best: 0, same: 0, dEcur: 0, dEfin: 0, curFin: 0, dArea: 0, dWires: 0, dWlen: 0, dCuts: 0, dBcuts: 0, dMess: 0, dHard: 0, dStarv: 0, dOther: 0, dGeo: 0, dOverlap: 0, dStarvH: 0 };
      const keys = ["it", "kind", "out", "best", "same", "dEcur", "dEfin", "curFin", "dArea", "dWires", "dWlen", "dCuts", "dBcuts", "dMess", "dHard", "dStarv", "dOther", "dGeo", "dOverlap", "dStarvH"] as const;
      w.onMoveLog = (rows, n) => {
        for (let r = 0; r < n; r++) {
          for (let k = 0; k < keys.length; k++) rec[keys[k]] = rows[20 * r + k];
          ml(rec);
        }
      };
    }
    let best: { E: number; g: Genome; d: Decoded } | null = null;
    let exact: { final: AutoLayoutResult; score: number } | null = null, exactN = 0, tStart = 0, it = 0;
    for (;;) {
      const ev = w.annealStep();
      if (ev < 0) return null;
      if (ev === 0) break;
      const c = w.cur();
      const g = c.g as Genome, d = decodedOf(g, c.o);
      it = c.it;
      if (!best) tStart = performance.now();
      else if (exactOn && c.frac >= 0.5) {
        exactN++;
        const r = finishRepair(board, components, componentDefs, nets, netAssignments, skeletonOf(cloneG(g), d, true), finishOpts);
        if (r && r.ok && (!exact || r.score < exact.score)) exact = { final: r.final, score: r.score };
      }
      best = { E: c.E, g, d };
    }
    it = w.cur().it;
    if (options?.timeBudgetMs !== undefined) options.onBudget?.({ moves: it, cap: capMoves, msPerMove: (performance.now() - tStart) / Math.max(1, it) });
    return best ? { ...best, exact, exactN } : null;
  }
  // ── finalize through the real completion pipeline ──
  const finishOpts = { drilledCutsOnly: options?.drilledCutsOnly ?? false, noWireStacking: options?.noWireStacking ?? false };
  const exactOn = !!options?.exactBest && !options?.lab;
  // A routed board (components, cuts, wires) in the shape the explainer
  // draws. Only used by the lab hook.
  const labFinBoard = (virtual: Component[], rows: number, cols: number, cuts: Cut[], wires: { from: BoardPosition; to: BoardPosition }[]): LabBoard => {
    const netIdx = new Map(nets.map((n, i) => [n.id, i]));
    const idToPi = new Map(parts.map((pp, pi) => [pp.comp.id, pi]));
    const netOfPin2 = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));
    const segsRaw = computeStripSegments({ ...board, rows, cols, cuts, wires: [] }, virtual, componentDefs, netAssignments);
    const segAt = (r: number, c: number) => segsRaw.findIndex((sg) => sg.row === r && sg.startCol <= c && c <= sg.endCol);
    const segNet = segsRaw.map((sg) => (sg.netIds.length ? netIdx.get(sg.netIds[0]) ?? -1 : -1));
    // a strip without a pin of its own, a relay or bus strip, belongs to the
    // net of the wires that land on it
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const wr of wires) {
        const a = segAt(wr.from.row, wr.from.col), b = segAt(wr.to.row, wr.to.col);
        if (a < 0 || b < 0) continue;
        if (segNet[a] >= 0 && segNet[b] < 0) { segNet[b] = segNet[a]; changed = true; }
        else if (segNet[b] >= 0 && segNet[a] < 0) { segNet[a] = segNet[b]; changed = true; }
      }
      if (!changed) break;
    }
    const netAt = (r: number, c: number) => { const i = segAt(r, c); return i < 0 ? -1 : segNet[i]; };
    const labParts: LabPlaced[] = [];
    for (const c of virtual) {
      if (!c.boardPos || c.boardExcluded) continue;
      const def = resolveComponentDef(c, componentDefs);
      const pi = idToPi.get(c.id);
      if (!def || pi === undefined) continue;
      const pins = getComponentPinPositions(c, def).map((q) => ({
        r: q.row, c: q.col, net: netIdx.get(netOfPin2.get(pinKey(c.id, q.pinId)) ?? "") ?? -1,
        name: pinNameOf(pi, q.pinId, undefined), id: q.pinId,
      }));
      let y: number, x: number, h: number, w: number;
      if (def.flexible) {
        const e = c.flexibleEndPos ?? c.boardPos;
        y = Math.min(c.boardPos.row, e.row); x = Math.min(c.boardPos.col, e.col);
        h = Math.abs(c.boardPos.row - e.row) + 1; w = Math.abs(c.boardPos.col - e.col) + 1;
      } else {
        const b = getComponentBounds(def, c.boardPos, c.rotation);
        y = b.minRow; x = b.minCol; h = b.maxRow - b.minRow + 1; w = b.maxCol - b.minCol + 1;
      }
      labParts.push({ pi, x, y, w, h, flex: !!def.flexible, pos: c.boardPos, rot: c.rotation, end: c.flexibleEndPos, pins });
    }
    return {
      rows, cols, parts: labParts,
      segs: segsRaw.map((sg, i) => ({ row: sg.row, c1: sg.startCol, c2: sg.endCol, net: segNet[i] })),
      cuts: cuts.map((k) => ({ row: k.row, col: k.col, kind: k.kind === "hole" ? "hole" as const : "knife" as const })),
      wires: wires.map((wr) => ({ r1: wr.from.row, c1: wr.from.col, r2: wr.to.row, c2: wr.to.col, net: netAt(wr.from.row, wr.from.col), slanted: wr.from.col !== wr.to.col, crossings: 0 })),
      busRows: [],
    };
  };

  // What the anneal hands to the finish: the decoded placement of every
  // part and what the decoder measured. With `wiring` the record also
  // carries the decoder's own cuts and wires, for the repair finish.
  function skeletonOf(bestG: Genome, d: Decoded, wiring: boolean): Skeleton {
    const placed: Skeleton["placed"] = [];
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (p.kind === "rigid") {
        const sh = d.geo[pi].sh!;
        placed.push(p.locked
          ? { id: p.comp.id, boardPos: p.comp.boardPos!, rotation: p.comp.rotation, locked: true }
          : { id: p.comp.id, boardPos: { row: d.yI[pi] - sh.dRow, col: d.xI[pi] - sh.dCol }, rotation: rotOfPart(bestG, pi) });
      } else if (d.geo[pi].mode === "H") {
        const brBit = flexBit(bestG.br, pi);
        const x1 = d.xI[pi], x2 = d.xI[pi] + (p as FlexPart).dc0;
        placed.push({ id: p.comp.id, boardPos: { row: d.yI[pi], col: brBit === 0 ? x1 : x2 }, rotation: 0, flexibleEndPos: { row: d.yI[pi], col: brBit === 0 ? x2 : x1 } });
      } else {
        const brBit = flexBit(bestG.br, pi);
        const t = d.yI[pi], b = d.yI[d.vBot.get(pi)!];
        placed.push({ id: p.comp.id, boardPos: { row: brBit === 0 ? t : b, col: d.xI[pi] }, rotation: 0, flexibleEndPos: { row: brBit === 0 ? b : t, col: d.xI[pi] } });
      }
    }
    let wiringOut: LabBoard | undefined;
    if (wiring) {
      const { o, ex } = exportDecode(bestG, false);
      wiringOut = labWalk(bestG, o, ex, false).board ?? undefined;
    }
    const dg = (d.dbg ?? {}) as Record<string, number>;
    return {
      rows: d.H, cols: d.W, placed, skippedIds: skipped.map((c) => c.id),
      metrics: { eBase: d.eBase, mess: d.slants + d.crossings, wires: dg.wires, wireLen: dg.wireLen, cuts: dg.cuts, bCuts: dg.bCuts },
      ...(wiringOut ? { wiring: wiringOut } : {}),
    };
  }

  function finalize(bestG: Genome, d: Decoded, seed?: number) {
    // Two finishes are offered and the cheaper board wins, by the same price
    // the anneal scored the skeleton with: the repair, which keeps the
    // decoder's own cuts and wires and fixes only what the editor's rules
    // reject, and the router, which starts over. The repair is the cheaper
    // board on most skeletons but not on all, and it cannot win with a board
    // that is not valid, clean and geometrically sound.
    const sk = skeletonOf(bestG, d, true);
    if (seed !== undefined) options?.onSkeleton?.(seed, sk);
    const repaired = finishRepair(board, components, componentDefs, nets, netAssignments, sk, finishOpts);
    const routed = finishSkeleton(board, components, componentDefs, nets, netAssignments, sk, finishOpts);
    return repaired && repaired.ok && repaired.score < routed.score ? { final: repaired.final, score: repaired.score } : routed;
  }

  // ── lab: hand everything to the explainer and stop ──
  if (options?.lab) {
    const labDecoded = (o: WasmDecodeOut, board: LabBoard): LabDecoded => ({ eBase: o.eBase, hard: o.hardPen, mess: o.slants + o.crossings, H: o.H, W: o.W, board, wires: o.wires, wireLen: o.wireLen, cuts: o.cuts, bCuts: o.bCuts, starved: o.starvedHard, relays: o.relays, connEdge: o.connEdge });
    const labDecode = (g: Genome, frames: boolean) => {
      const { o, ex } = exportDecode(g, frames);
      const walk = labWalk(g, o, ex, frames);
      return { d: o.status === 2 && walk.board ? labDecoded(o, walk.board) : null, frames: walk.frames, g };
    };
    const labFinishBoth: LabApi["finishBoth"] = (g) => {
      const g2 = cloneG(g as Genome);
      const { o, ex } = exportDecode(g2, false);
      const start = labWalk(g2, o, ex, false).board;
      const d = o.status === 2 ? decodedOf(g2, o) : null;
      const empty = { start: start!, router: { frames: [], price: 0 }, repair: null };
      if (!d || !start) return empty;
      const sk = skeletonOf(g2, d, true);
      const routerFrames: LabFrame[] = [];
      const routed = finishSkeleton(board, components, componentDefs, nets, netAssignments, sk, finishOpts, { frames: routerFrames, board: labFinBoard });
      const repairFrames: LabFrame[] = [];
      const repaired = finishRepair(board, components, componentDefs, nets, netAssignments, sk, finishOpts, { frames: repairFrames, board: labFinBoard });
      // each finish's own score, which on a valid, mess-free board is exactly
      // the price the anneal would have put on it
      return {
        start,
        router: { frames: routerFrames, price: routed.score },
        repair: repaired ? { frames: repairFrames, price: repaired.score, ok: repaired.ok } : null,
      };
    };
    // the moves and starting genomes of the anneal, drawing from the lab's rng
    const labInit = (r: LabRng): Genome => {
      const w = exportDecoder();
      w.rngSet(r.state);
      const g = w.labInit() as Genome;
      r.state = w.rngGet();
      return g;
    };
    const labMutate = (g: Genome, r: LabRng): Genome | null => {
      const w = exportDecoder();
      w.rngSet(r.state);
      const g2 = w.labMutate(g) as Genome | null;
      r.state = w.rngGet();
      return g2;
    };
    // a short anneal as the explainer runs it: the plain schedule, every
    // proposal decoded in full (no same-board shortcut, no protected ties)
    const labRun: LabApi["run"] = (seed, movesN2, every, cb) => {
      const rng: LabRng = { state: ((seed + 1) * 0x9e3779b9) >>> 0 };
      const wOf = (it: number) => Math.min(W_MESS, RAMP_START * Math.pow(W_MESS / RAMP_START, it / movesN2));
      const price = (o: WasmDecodeOut, w: number) => o.eBase + w * (o.slants + o.crossings);
      // the board of a state, built only when a snapshot shows it
      type State = { g: Genome; o: WasmDecodeOut; ex: WasmExport; d?: LabDecoded };
      const dOf = (st: State): LabDecoded => {
        if (!st.d) {
          st.d = labDecoded(st.o, labWalk(st.g, st.o, st.ex, false).board!);
        }
        return st.d;
      };
      const dec = (g: Genome): State | null => {
        const { o, ex } = exportDecode(g, false);
        return o.status === 2 ? { g, o, ex } : null;
      };
      let cur = dec(labInit(rng));
      let tries = 0;
      while (!cur && tries++ < 50) cur = dec(labInit(rng));
      if (!cur) return;
      const cool = Math.pow(0.15 / T_START, 1 / movesN2);
      let T = T_START;
      let best = { E: price(cur.o, W_MESS), st: { ...cur, g: cloneG(cur.g) } as State };
      for (let it = 0; it < movesN2; it++) {
        T *= cool;
        const w = wOf(it);
        const g2 = labMutate(cur.g, rng);
        let kind: LabStep["kind"] = "null";
        if (g2) {
          const r2 = dec(g2);
          if (!r2) kind = "infeasible";
          else {
            const dE = price(r2.o, w) - price(cur.o, w);
            const wd = exportDecoder();
            wd.rngSet(rng.state);
            const take = dE <= 0 || wd.rand() < Math.exp(-dE / T);
            if (dE > 0) rng.state = wd.rngGet();
            if (take) {
              kind = dE <= 0 ? "better" : "worse-kept";
              cur = r2;
              const eFin = price(r2.o, W_MESS);
              if (eFin < best.E) best = { E: eFin, st: { ...r2, g: cloneG(r2.g) } };
            } else kind = "worse-rejected";
          }
        }
        if ((it + 1) % every === 0 || it === movesN2 - 1) cb({ it: it + 1, moves: movesN2, T, w, g: cur.g, d: dOf(cur), E: price(cur.o, w), best: best.E, bestG: best.st.g, bestD: dOf(best.st), kind, done: it === movesN2 - 1 });
      }
    };
    options.lab({
      parts: parts.map((p) => ({ id: p.comp.label, comp: p.comp, kind: p.kind, isConn: p.isConn, canH: p.kind === "flex" ? p.canH : false, canV: p.kind === "flex" ? p.canV : false, spans: p.kind === "flex" ? [p.minS, p.maxS] : [0, 0], pinNames: p.kind === "rigid" ? p.def.pins.map((q) => q.name) : ["1", "2"] })),
      nets: nets.map((n, ni) => ({ name: n.name, color: n.color, pins: netPins[ni].map((q) => ({ pi: q.pi, name: pinNameOf(q.pi, q.pinId, q.end) })) })),
      rigidIdx, flexIdx, cloneG,
      initGenome: (rng) => labInit(rng),
      mutate: (g, rng) => labMutate(g as Genome, rng),
      decode: (g, frames = true) => labDecode(g as Genome, frames),
      run: labRun,
      finishBoth: labFinishBoth,
      T_START,
    });
    return emptyResult([]);
  }

  // ── run the portfolio ──
  const seedBests: { E: number; g: Genome; d: Decoded; seed: number; exact: { final: AutoLayoutResult; score: number } | null; exactN: number }[] = [];
  const seedList = options?.seedIndex !== undefined ? [options.seedIndex] : [...Array(seedsN).keys()].map((k) => k + (options?.seedBase ?? 0));
  for (const [pos, seed] of seedList.entries()) {
    const r = solveSeed(seed, pos);
    if (r) seedBests.push({ ...r, seed });
    if (r && options?.debugSeeds) {
      console.log(`[v5 seed ${seed}] E ${r.E.toFixed(1)} decoded ${r.d.H}x${r.d.W}`, JSON.stringify(r.d.dbg));
      if (r.exactN) console.log(`[v5 seed ${seed}] exact ${r.exactN} bests finished${r.exact ? `, cheapest ${r.exact.score.toFixed(1)}` : ""}`);
    }
  }
  // pins no board can wire leave their nets open whatever the search does:
  // name them, so the result says why and what to change
  const unreachable = unreachablePins(components, componentDefs, netAssignments).map(unreachablePinsIssue);
  if (seedBests.length === 0) return emptyResult([...unreachable, "auto-layout found no feasible arrangement"]);
  seedBests.sort((a, b) => a.E - b.E);
  let bestFin: { final: AutoLayoutResult; score: number } | null = null;
  const finalists = seedBests.slice(0, 4);
  finalists.forEach((r, i) => {
    report("place", i / finalists.length);
    const f = finalize(r.g, r.d, r.seed);
    if (!bestFin || f.score < bestFin.score) bestFin = f;
  });
  // the exact bests of every seed, finalist or not
  for (const r of seedBests) if (r.exact && (!bestFin || r.exact.score < bestFin.score)) bestFin = r.exact;
  report("place", 1);
  const final: AutoLayoutResult = bestFin!.final;
  return unreachable.length ? { ...final, issues: [...unreachable, ...final.issues] } : final;
}
