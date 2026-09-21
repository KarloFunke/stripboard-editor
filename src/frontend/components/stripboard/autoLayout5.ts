import { Board, BoardPosition, Component, ComponentDef, Cut, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getComponentPinPositions, getRotatedPinPositions } from "./boardLayout";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { Rot, allowedDrows } from "./layout2/tileModel";
import { Capsule, FootprintRect, bodyRectsClash, capsuleClashesRect, capsulesClash, coveredHoles, segmentsIntersect, wireStackDepth } from "./flexGeometry";
import { flexBody, flexCoveredHoles, flexProfile, rigidGeometry } from "./partGeometry";
import { expandOffBoard, leadSiblings } from "./offBoard";
import { resolvePackage } from "./packageBodies";
import { alignCuts } from "./layout2/alignCuts";
import { padAroundEdgeConnectors } from "./layout2/edgePadding";
import { drillRemainingCuts } from "./autoFinish";
import { computeStripSegments } from "./stripSegments";
import { Chooser } from "./layout2/chooser";
import { compactPlacements } from "./layout2/compaction";
import { insertWireChannels } from "./layout2/channelPass";
import { repairSlantWires } from "./layout2/slantRepairPass";
import { trimResult } from "./layout2/trimResult";
import { wireMessScore } from "./layout2/tidyScore";
import { rateResult } from "./autoLayout2";
import { pinKey } from "./keys";

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
  // Only sever strips by drilling holes: knife cuts the drill upgrade
  // cannot absorb are priced in the skeleton and the finish
  drilledCutsOnly?: boolean;
  // No wire may run on top of another in one channel
  noWireStacking?: boolean;
  // Harness-only: log each seed's decoded best (never set by the UI)
  debugSeeds?: boolean;
  // Harness-only landscape instrumentation (never set by the UI): trace is
  // called once per 1% of the anneal with window statistics, probe once per
  // seed after the anneal with the engine closures
  trace?: (rec: LandscapeTrace) => void;
  probe?: (api: LandscapeProbe) => void;
  // Harness-only move log: called once per proposal of the anneal with a
  // REUSED record (copy what you keep); see MoveLogRec
  moveLog?: (rec: MoveLogRec) => void;
  // Harness-only experiment: the row scan hands a boundary's spare holes to
  // the neighbouring segment that would otherwise have none (knife cut
  // instead of drilling the only spare hole), so a pin between two cuts is
  // not declared starved when the finish could still cut with a knife
  cutAwareScan?: boolean;
  // Harness-only schedule overrides for annealing experiments
  schedule?: { t0?: number; t0Scale?: number; tEnd?: number; rampStart?: number; rampEndFrac?: number; hardStart?: number; coldT?: number;
    // lean: moves that cannot change the board (rotating a 1x1 part, merging
    // merged labels, splitting a lone label) return null and are resampled
    // instead of spending the iteration
    lean?: boolean;
    // adaptive: the move mix follows each kind's recent accepted improvement
    // per proposal (window in iterations, floor share per kind)
    adaptive?: { window?: number; floor?: number } };
  // Explainer-only: hand the decoder, the moves and the anneal loop to the
  // caller instead of running the portfolio (the guide's figures replay the
  // decoder step by step on a small circuit)
  lab?: (api: LabApi) => void;
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
export interface LabApi {
  parts: { id: string; comp: Component; kind: "rigid" | "flex"; isConn: boolean; canH: boolean; canV: boolean; spans: [number, number]; pinNames: string[] }[];
  nets: { name: string; color: string; pins: { pi: number; name: string }[] }[];
  rigidIdx: number[];
  flexIdx: number[];
  initGenome: (rng: () => number) => LabGenome;
  cloneG: (g: LabGenome) => LabGenome;
  mutate: (g: LabGenome, rng: () => number) => LabGenome | null;
  decode: (g: LabGenome, frames?: boolean) => { d: LabDecoded | null; frames: LabFrame[]; g: LabGenome };
  run: (seed: number, moves: number, every: number, cb: (step: LabStep) => void) => void;
  // the finishing pass on one description, stage by stage
  finish: (g: LabGenome) => LabFrame[];
  W_MESS: number;
  RAMP_START: number;
  T_START: number;
}

export interface LandscapeTrace {
  seed: number; it: number; T: number; w: number;
  cur: number; best: number; curFin: number;
  acc: number; accUp: number; up: number; nulls: number; infeasible: number;
  H: number; W: number;
}
export interface LandscapeProbe {
  seed: number;
  best: { E: number; g: unknown; d: unknown };
  decode: (g: unknown) => unknown;
  mutate: (g: unknown, rng: () => number) => unknown;
  initGenome: (rng: () => number) => unknown;
  cloneG: (g: unknown) => unknown;
  price: (d: unknown, w: number) => number;
  t0: number;
  W_MESS: number;
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
export const MOVE_KINDS = ["throw", "pull", "swapP", "swapN", "swapBoth", "rot", "hv", "br", "grpMerge", "gap", "xgap", "grpSplit"];

const W_AREA = 0.35;
const W_WIRE = 4;       // per link wire
const W_WLEN = 0.4;     // per row of wire length
const W_CUT = 0.05;     // cuts are nearly free
const W_BCUT = 2;       // between-holes cuts stay visibly priced
const W_BCUT_DRILL = 24; // a knife cut under drilled-cuts-only: worth several wires, so a rotation that avoids one pays
const W_MESS = 400;     // final price per off-axis or crossing wire
const W_TALL = 2;       // rows of cells each row beyond the board width costs
const RAMP_START = 25;  // their price while the skeleton forms
const T_START = 150;    // anneal start temperature (see solveSeed)
const W_LOCKOVER = 150; // per line over a locked dimension
const W_SIBLING = 0.5;  // per hole the pads of one off-board part sit further apart than they must
const ROTS: Rot[] = [0, 90, 180, 270];
// the way a part's front face looks at each rotation (front() in rigidBodies)
const ENTRY_SIDE: Record<Rot, "left" | "right" | "top" | "bottom"> = { 0: "right", 90: "bottom", 180: "left", 270: "top" };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  hardPen: number;
  // which margin lines the skeleton's wiring attached to: the finish must
  // keep the padding outside a flush connector on those sides
  marginUsed: { top: boolean; bottom: boolean; left: boolean; right: boolean };
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
  // where the cap now sits. A time budget can only lower the count.
  const nPins = netPins.reduce((n, l) => n + l.length, 0);
  const capMoves = Math.min(1280000, Math.max(40000, 16000 * (nPins - 13)));
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
  const initGenome = (rng: () => number): Genome => {
    const shuffle = (a: number[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    return {
      gp: shuffle([...Array(nP).keys()]),
      gn: shuffle([...Array(nP).keys()]),
      rot: rigidIdx.map(() => 0),
      hv: flexIdx.map(() => 0),
      br: flexIdx.map(() => 0),
      grp: netPins.map((pins) => pins.map(() => 0)),
      gap: parts.map(() => 0),
      xgap: parts.map(() => 0),
    };
  };
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

  // ── lab recorder (explainer figures only; off in every real run) ──
  let labMode: 0 | 1 | 2 = 0; // 0 off, 1 final board only, 2 every frame
  let labFin = false;         // record the finishing pass stage by stage
  let labFinFrames: LabFrame[] = [];
  let labFrames: LabFrame[] = [];
  let labBoardOut: LabBoard | null = null;
  const pushF = (f: LabFrame) => { if (labMode === 2) labFrames.push(f); };
  const labelOf = (pi: number) => parts[pi].comp.label;
  const netName = (n: number) => (n >= 0 && n < nets.length ? nets[n].name : "an unconnected pin");
  const pinNameOf = (pi: number, pinId: string | undefined, end: number | undefined) => {
    const p = parts[pi];
    if (p.kind === "rigid") return p.def.pins.find((q) => q.id === pinId)?.name ?? pinId ?? "";
    return String((end ?? 0) + 1);
  };
  const rowsWord = (k: number) => `${k} row${k === 1 ? "" : "s"}`;

  // ── decoder ──
  // constraint-graph edge buffers, sized for the largest graph a decode
  // can build (every ordered pair at most once, plus source, span and
  // locked-pin edges); reused across decodes
  const maxE = nP + flexIdx.length + 1 + 2 * flexIdx.length + Math.ceil((nP * nP) / 2) + 2 * nP + 8;
  const eU = new Int32Array(maxE), eV = new Int32Array(maxE), eW = new Float64Array(maxE);
  const rU = new Int32Array(maxE), rV = new Int32Array(maxE), rW = new Float64Array(maxE), rRank = new Int32Array(maxE), rE = new Int32Array(maxE);
  const ordBuf = new Int32Array(maxE), rankCnt = new Int32Array(2 * nP + 4);
  const xU = new Int32Array(maxE), xV = new Int32Array(maxE), xW = new Float64Array(maxE);
  const vBotArr = new Int32Array(nP);
  // Prim key buffers: a net has at most one segment per pin
  const maxK = Math.max(1, ...netPins.map((pins) => pins.length));
  const kTotal = new Float64Array(maxK), kA = new Int32Array(maxK), kCross = new Int32Array(maxK);
  const kLen = new Int32Array(maxK), kCol = new Int32Array(maxK), kOff = new Uint8Array(maxK);
  const linkCount = new Int32Array(maxK), inTree = new Uint8Array(maxK);
  const kRow = new Int32Array(maxK), kCA = new Int32Array(maxK), kCB = new Int32Array(maxK);
  // per-decode scratch grids, grown on demand and cleared over the used
  // prefix only (a fresh allocation per decode was a tenth of the run)
  let gridCap = 0;
  let occBuf = new Int8Array(0), ownerBuf = new Int16Array(0), pinNetBuf = new Int32Array(0);
  let usedBuf = new Uint8Array(0), bodyPreBuf = new Int32Array(0), hopBuf = new Int32Array(0);
  const ensureGrid = (n: number) => {
    if (n <= gridCap) return;
    gridCap = Math.max(n, gridCap * 2);
    occBuf = new Int8Array(gridCap);
    ownerBuf = new Int16Array(gridCap);
    pinNetBuf = new Int32Array(gridCap);
    usedBuf = new Uint8Array(gridCap);
    bodyPreBuf = new Int32Array(gridCap);
  };
  function decode(g: Genome): Decoded | null {
    const posP = new Int32Array(nP), posN = new Int32Array(nP);
    g.gp.forEach((p, i) => (posP[p] = i));
    g.gn.forEach((p, i) => (posN[p] = i));
    if (labMode === 2) {
      const rels: { a: number; b: number; rel: "left" | "above" }[] = [];
      for (const a of g.gp) for (const b of g.gp) if (a !== b && posP[a] < posP[b]) rels.push({ a, b, rel: posN[a] < posN[b] ? "left" : "above" });
      pushF({ stage: 1, msg: "The two orders, and nothing else.", relations: [] });
      rels.forEach((r, i) => pushF({ stage: 1, msg: `${labelOf(r.a)} comes before ${labelOf(r.b)} in ${r.rel === "left" ? `both orders: ${labelOf(r.a)} is left of ${labelOf(r.b)}` : `the first order but after it in the second: ${labelOf(r.a)} is above ${labelOf(r.b)}`}.`, relations: rels.slice(0, i + 1), pair: [r.a, r.b] }));
      pushF({ stage: 1, msg: "Every pair has exactly one relation. That is the whole packing, still without a single coordinate.", relations: rels });
    }

    const geo = parts.map((p, pi) => {
      if (p.kind === "rigid") {
        const sh = p.shapes.get(rotOfPart(g, pi))!;
        return { w: sh.w, h: sh.h, sh };
      }
      const mode: "H" | "V" = flexBit(g.hv, pi) === 1 && p.canH ? "H" : "V";
      return mode === "H" ? { w: p.dc0 + 1, h: 1, mode } : { w: 1, h: 0, mode };
    });

    const vBot = new Map<number, number>();
    let nNode = nP;
    for (const pi of flexIdx) if (geo[pi].mode === "V") vBot.set(pi, nNode++);
    const SRC = nNode++;

    // lab: lane geometry and node names
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

    const pinYExpr = (pin: { pi: number; kind: string; end?: number; pinId?: string }): [number, number] => {
      const p = parts[pin.pi];
      if (pin.kind === "rigid") {
        const sh = geo[pin.pi].sh!;
        const sp = sh.pins.find((x) => x.pinId === pin.pinId)!;
        return [pin.pi, sp.rowOff];
      }
      if (geo[pin.pi].mode === "H") return [pin.pi, 0];
      const isTop = (pin.end === 0) === (flexBit(g.br, pin.pi) === 0);
      return [isTop ? pin.pi : vBot.get(pin.pi)!, 0];
    };

    // optimistic: the part's own clearance below it; real pair clearances
    // are checked EXACTLY at decoded coordinates (bodiesTooClose /
    // bodyIntersectsRect) and priced. Independent of the part below, which
    // the nearest-successor edge pruning relies on.
    const vgapOf = (i: number, _j: number) => Math.max(1, clrOf[i]);

    let nE = 0;
    const addE = (u: number, v: number, w: number) => {
      eU[nE] = u;
      eV[nE] = v;
      eW[nE] = w;
      nE++;
    };
    for (let i = 0; i < nNode - 1; i++) addE(SRC, i, 0);
    for (const pi of flexIdx) {
      if (geo[pi].mode !== "V") continue;
      const p = parts[pi] as FlexPart;
      const b = vBot.get(pi)!;
      addE(pi, b, p.minS);
      addE(b, pi, -p.maxS);
    }
    vBotArr.fill(-1);
    for (const [pi, b2] of vBot) vBotArr[pi] = b2;
    for (let i = 0; i < nP; i++) {
      if (parts[i].locked) continue;
      // the part's bottom node and its offset: a V flex ends at its bottom
      // pin node, anything else at its own node plus its height
      const bu = vBotArr[i] >= 0 ? vBotArr[i] : i;
      const w0 = (vBotArr[i] >= 0 ? 0 : geo[i].h - 1) + vgapOf(i, 0) + g.gap[i];
      const pi_ = posP[i], ni = posN[i];
      // nearest successors only: any other part below i is reached through
      // one of them with at least this edge's weight (the weight does not
      // depend on j), so the longest paths are the same with far fewer edges
      let seen = -1;
      for (let q = pi_ + 1; q < nP; q++) {
        const j = g.gp[q];
        const nj = posN[j];
        if (nj > ni || parts[j].locked) continue;
        if (nj < seen) continue;
        seen = nj;
        addE(bu, j, w0);
      }
    }
    const lockedY = new Map<number, number>();
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked) continue;
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        lockedY.set(pi, p.comp.boardPos!.row + sh.dRow);
      } else {
        const bp = p.comp.boardPos!;
        const ep = p.comp.flexibleEndPos ?? bp;
        lockedY.set(pi, Math.min(bp.row, ep.row));
        if (vBot.has(pi)) lockedY.set(vBot.get(pi)!, Math.max(bp.row, ep.row));
      }
    }
    for (const [n, v] of lockedY) {
      addE(SRC, n, v);
      addE(n, SRC, -v);
    }

    if (labMode === 2) pushF({ stage: 2, msg: "Every part starts on row 0. Each above-relation becomes an arrow: the lower part must sit at least the upper part's height plus its clearance further down.", lanes: labLanes(new Array(nNode - 1).fill(0), labArrows("idle", nE), []) });
    // group equalities via weighted union-find; conflicts split the pin out
    // of its group persistently (genotype write-back)
    // node rank along the first sequence (source first, a flex part's
    // bottom right after its top): the relaxation order of the y-solve
    const rankOf = new Int32Array(nNode);
    for (let pi = 0; pi < nP; pi++) rankOf[pi] = 2 * posP[pi] + 1;
    for (const [pi, b2] of vBot) rankOf[b2] = 2 * posP[pi] + 2;
    const dist = new Float64Array(nNode).fill(-1e18);
    const walkSeen = new Int32Array(nNode);
    let walkStamp = 0;
    let solved = false;
    for (let attempt = 0; attempt < 400 && !solved; attempt++) {
      const parent = new Int32Array(nNode);
      const poff = new Int32Array(nNode);
      for (let i = 0; i < nNode; i++) parent[i] = i;
      const find = (v0: number): [number, number] => {
        let v = v0, off = 0;
        while (parent[v] !== v) {
          off += poff[v];
          v = parent[v];
        }
        return [v, off];
      };
      const members = new Map<number, { net: number; k: number }[]>();
      let conflict: { net: number; k: number } | "hard" | null = null;
      const labTies: LabTie[] = [];
    const tieIdle = (t: LabTie): LabTie => ({ ...t, state: "idle" });
    const tieConflict = (t: LabTie): LabTie => ({ ...t, state: "conflict" });
      const labY0 = new Array(nNode - 1).fill(0);
      for (let n = 0; n < nets.length && !conflict; n++) {
        const pins = netPins[n];
        const anchorOf = new Map<number, number>();
        for (let k = 0; k < pins.length; k++) {
          const gl = g.grp[n][k];
          if (!anchorOf.has(gl)) {
            anchorOf.set(gl, k);
            continue;
          }
          const [u, ou] = pinYExpr(pins[anchorOf.get(gl)!]);
          const [v, ov] = pinYExpr(pins[k]);
          const [ru, du] = find(u);
          const [rv, dv] = find(v);
          if (ru === rv) {
            if (du + ou !== dv + ov) {
              g.grp[n][k] = Math.max(...g.grp[n]) + 1;
              if (labMode === 2) pushF({ stage: 2, msg: nodePart(u) === nodePart(v)
                ? `Two ${nets[n].name} pins of ${labelOf(nodePart(u))} sit on different rows of the part, yet they are asked to share a strip. That cannot hold, so one of them is split into a strip group of its own; it will get a link wire later instead.`
                : `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} are asked to share a strip too, but the ties already fix those parts at a distance that puts these pins on different rows. That cannot hold, so the ${nets[n].name} pin of ${labelOf(pins[k].pi)} is split into a strip group of its own; it will get a link wire later instead.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map(tieIdle).concat([{ u, offU: ou, v, offV: ov, state: "split" as const }]), [nodePart(u), nodePart(v)]) });
            } else if (labMode === 2) pushF({ stage: 2, msg: `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} share a strip as well, and the distance already fits.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map(tieIdle).concat([{ u, offU: ou, v, offV: ov, state: "check" as const }]), [nodePart(u), nodePart(v)]) });
            continue;
          }
          parent[rv] = ru;
          poff[rv] = du + ou - dv - ov;
          if (labMode === 2) {
            labTies.push({ u, offU: ou, v, offV: ov, state: "idle" });
            const dd = poff[rv] + dv - du; // rows v's top sits below u's top
            pushF({ stage: 2, msg: `The ${nets[n].name} pins of ${nodeName(u)} and ${nodeName(v)} are asked to share a strip, so ${nodeName(v)} is tied to ${nodeName(u)}: from now on they move together, ${dd === 0 ? "tops level" : `${nodeName(v)} ${rowsWord(Math.abs(dd))} ${dd > 0 ? "below" : "above"}`}.`, lanes: labLanes(labY0, labArrows("idle", nE), labTies.map((t, i): LabTie => ({ ...t, state: i === labTies.length - 1 ? "check" : "idle" })), [nodePart(u), nodePart(v)]) });
          }
          const mu = members.get(ru) ?? [];
          const mv = members.get(rv);
          if (mv) {
            mu.push(...mv);
            members.delete(rv);
          }
          mu.push({ net: n, k });
          members.set(ru, mu);
        }
      }
      const rootArr = new Int32Array(nNode), offArr = new Int32Array(nNode);
      for (let v = 0; v < nNode; v++) {
        const [r, o] = find(v);
        rootArr[v] = r;
        offArr[v] = o;
      }
      let nR = 0;
      for (let ei = 0; ei < nE; ei++) {
        const ru = rootArr[eU[ei]], rv = rootArr[eV[ei]];
        const w = eW[ei] + offArr[eU[ei]] - offArr[eV[ei]];
        if (ru === rv) {
          if (w > 0 && !conflict) {
            const mm = members.get(ru);
            conflict = mm && mm.length ? mm[mm.length - 1] : "hard";
            if (labMode === 2 && conflict !== "hard") pushF({ stage: 2, msg: `The ties fix ${nodeName(eV[ei])} ${rowsWord(Math.abs(offArr[eV[ei]] - offArr[eU[ei]]))} ${offArr[eV[ei]] >= offArr[eU[ei]] ? "below" : "above"} ${nodeName(eU[ei])}, but the orders say ${nodeName(eV[ei])} is below ${nodeName(eU[ei])} by at least ${rowsWord(eW[ei])}. Both cannot hold.`, lanes: labLanes(labY0, labArrows("idle", nE).map((a) => (a.a === eU[ei] && a.b === eV[ei] ? { ...a, state: "conflict" } : a)), labTies.map(tieConflict), [nodePart(eU[ei]), nodePart(eV[ei])]) });
          }
          continue;
        }
        rU[nR] = ru;
        rV[nR] = rv;
        rW[nR] = w;
        rRank[nR] = rankOf[eU[ei]];
        rE[nR] = ei;
        nR++;
      }
      if (conflict) {
        if (conflict === "hard") return null;
        g.grp[conflict.net][conflict.k] = Math.max(...g.grp[conflict.net]) + 1;
        if (labMode === 2) pushF({ stage: 2, msg: `The decoder splits the ${nets[conflict.net].name} pin of ${labelOf(netPins[conflict.net][conflict.k].pi)} into a strip group of its own and starts over. That pin will get a link wire later instead.`, lanes: labLanes(labY0, labArrows("idle", nE), [], [netPins[conflict.net][conflict.k].pi]) });
        continue;
      }
      // relax in first-sequence order: every SP edge points down that
      // sequence, so a feasible graph settles in a few sweeps
      const ord = ordBuf, cnt = rankCnt;
      cnt.fill(0);
      for (let ei = 0; ei < nR; ei++) cnt[rRank[ei] + 1]++;
      for (let b2 = 1; b2 < cnt.length; b2++) cnt[b2] += cnt[b2 - 1];
      for (let ei = 0; ei < nR; ei++) ord[cnt[rRank[ei]]++] = ei;
      dist.fill(-1e18);
      dist[SRC] = 0;
      const pred = new Int32Array(nNode).fill(-1);
      let changed = false, lastEdge = -1, cycleAt = -1;
      for (let it = 0; it < nNode + 2; it++) {
        changed = false;
        for (let k = 0; k < nR; k++) {
          const ei = ord[k];
          const u = rU[ei], v = rV[ei];
          if (dist[u] + rW[ei] > dist[v] + 1e-9) {
            dist[v] = dist[u] + rW[ei];
            pred[v] = ei;
            changed = true;
            lastEdge = ei;
            if (labMode === 2 && it < 2) {
              const oe = rE[ei];
              if (eU[oe] !== SRC && eV[oe] !== SRC) {
                const nodeY = Array.from({ length: nNode - 1 }, (_, n) => (dist[rootArr[n]] < -1e17 ? 0 : dist[rootArr[n]]) + offArr[n]);
                const tgt = eV[oe], src = eU[oe];
                const mates = [...Array(nP).keys()].filter((q) => q !== nodePart(tgt) && rootArr[q] === rootArr[tgt]).map(labelOf);
                const span = nodePart(src) === nodePart(tgt);
                pushF({ stage: 2, msg: span
                  ? `${nodeName(tgt)} sits at least ${rowsWord(eW[oe])} below its upper end, so it moves down to row ${nodeY[tgt] + 1}.`
                  : `${nodeName(tgt)} must be at least ${rowsWord(eW[oe])} below ${nodeName(src)}, so it moves down to row ${nodeY[tgt] + 1}${mates.length ? `, and ${mates.join(" and ")}, tied to it, ${mates.length > 1 ? "move" : "moves"} along` : ""}.`,
                  lanes: labLanes(nodeY, labArrows("idle", nE, oe), labTies, [nodePart(tgt), ...mates.map((m) => parts.findIndex((p) => p.comp.label === m))]) });
              }
            }
          }
        }
        if (labMode === 2 && changed && it >= 2) pushF({ stage: 2, msg: `Sweep ${it + 1}: parts are still moving down. The arrows chase each other in a circle through the ties.`, lanes: labLanes(Array.from({ length: nNode - 1 }, (_, n) => (dist[rootArr[n]] < -1e17 ? 0 : dist[rootArr[n]]) + offArr[n]), labArrows("check", nE), labTies) });
        if (!changed) break;
        // a positive cycle closes the predecessor walk long before the
        // round bound would prove it: stop at the first closed walk
        if (it >= 2) {
          walkStamp++;
          let cur = rV[lastEdge];
          for (let s2 = 0; s2 <= nNode; s2++) {
            if (walkSeen[cur] === walkStamp) {
              cycleAt = cur;
              break;
            }
            walkSeen[cur] = walkStamp;
            const ei = pred[cur];
            if (ei < 0) break;
            cur = rU[ei];
          }
          if (cycleAt >= 0) break;
        }
      }
      if (!changed) {
        for (let v = 0; v < nNode; v++) dist[v] = dist[rootArr[v]] + offArr[v];
        solved = true;
        break;
      }
      let cur = cycleAt >= 0 ? cycleAt : rV[lastEdge];
      for (let s = 0; s < nNode + 2; s++) {
        const ei = pred[cur];
        if (ei < 0) break;
        cur = rU[ei];
      }
      let fixed = false;
      const start = cur;
      for (let s = 0; s < nNode + 2 && !fixed; s++) {
        const mm = members.get(cur);
        if (mm && mm.length) {
          const m = mm[mm.length - 1];
          g.grp[m.net][m.k] = Math.max(...g.grp[m.net]) + 1;
          if (labMode === 2) pushF({ stage: 2, msg: `No rows can satisfy all of them at once. The decoder splits the ${nets[m.net].name} pin of ${labelOf(netPins[m.net][m.k].pi)} into a strip group of its own and starts over.`, lanes: labLanes(labY0, labArrows("idle", nE), [], [netPins[m.net][m.k].pi]) });
          fixed = true;
          break;
        }
        const ei = pred[cur];
        if (ei < 0) break;
        cur = rU[ei];
        if (cur === start) break;
      }
      if (!fixed) return null;
    }
    if (!solved) return null;
    const y = dist;
    if (labMode === 2) pushF({ stage: 2, msg: "Nothing moves any more. These are the rows.", lanes: labLanes(Array.from({ length: nNode - 1 }, (_, n) => y[n]), labArrows("ok", nE), []) });

    // x: SP left edges + locked pins; longest path
    const XS = nP;
    let nX = 0;
    const addX = (u: number, v: number, w: number) => {
      xU[nX] = u;
      xV[nX] = v;
      xW[nX] = w;
      nX++;
    };
    for (let i = 0; i < nP; i++) addX(XS, i, 0);
    // two parts that share rows always keep one free column between them:
    // every pin segment then has an attachment hole on at least one side,
    // so a proposal can no longer starve a net by packing parts edge to
    // edge (starved proposals were rejected outright and cut the landscape
    // into pieces the walk could not cross)
    const hgap = (i: number, j: number) => {
      const fi = parts[i].kind === "flex", fj = parts[j].kind === "flex";
      if (fi && fj) return 1 + Math.max(1, clrOf[i], clrOf[j]);
      if (!fi && !fj) return 2;
      const f = fi ? i : j;
      return geo[f].mode === "V" ? 1 + Math.max(1, clrOf[f]) : 2;
    };
    // edges in first-sequence order, so the sweep below settles fast
    for (let r = 0; r < nP; r++) {
      const i = g.gp[r];
      if (parts[i].locked) continue;
      const ti = y[i], bi = vBotArr[i] >= 0 ? y[vBotArr[i]] : ti + geo[i].h - 1;
      const pi_ = posP[i], ni = posN[i];
      for (let q = pi_ + 1; q < nP; q++) {
        const j = g.gp[q];
        if (ni > posN[j] || parts[j].locked) continue;
        const tj = y[j], bj = vBotArr[j] >= 0 ? y[vBotArr[j]] : tj + geo[j].h - 1;
        const margin = vgapOf(i, j) >= 2 ? 1.5 : 0.5;
        if (!(bi < tj - margin || bj < ti - margin)) addX(i, j, geo[i].w - 1 + hgap(i, j) + g.xgap[i]);
      }
    }
    const lockedX = new Map<number, number>();
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked) continue;
      if (p.kind === "rigid") lockedX.set(pi, p.comp.boardPos!.col + geo[pi].sh!.dCol);
      else {
        const bp = p.comp.boardPos!;
        const ep = p.comp.flexibleEndPos ?? bp;
        lockedX.set(pi, Math.min(bp.col, ep.col));
      }
    }
    for (const [n, v] of lockedX) {
      addX(XS, n, v);
      addX(n, XS, -v);
    }
    const xd = new Float64Array(nP + 1).fill(-1e18);
    xd[XS] = 0;
    const labXArrows = (state: LabArrowState, hot = -1): LabArrow[] => { const out: LabArrow[] = []; for (let ei = 0; ei < nX; ei++) { if (xU[ei] === XS || xV[ei] === XS) continue; out.push({ a: xU[ei], b: xV[ei], w: xW[ei], state: ei === hot ? "push" : state }); } return out; };
    const labRowsNow = () => { let h = 0; for (let pi = 0; pi < nP; pi++) h = Math.max(h, (vBotArr[pi] >= 0 ? y[vBotArr[pi]] : y[pi] + geo[pi].h - 1) + 1); return h; };
    const labColsNow = () => { let w = 0; for (let pi = 0; pi < nP; pi++) w = Math.max(w, (xd[pi] < -1e17 ? 0 : xd[pi]) + geo[pi].w); return w; };
    if (labMode === 2) pushF({ stage: 3, msg: "Rows are known, so the parts can be drawn. Every part starts in column 0. Each left-of relation becomes an arrow: the right part must sit at least the left part's width plus the gap further right.", board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(y, xd, 0), ghost: true, segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("idle") } });
    let xOK = true;
    for (let it = 0; it < nP + 3; it++) {
      let ch = false;
      for (let ei = 0; ei < nX; ei++) {
        const u = xU[ei], v = xV[ei];
        if (xd[u] + xW[ei] > xd[v] + 1e-9) {
          xd[v] = xd[u] + xW[ei];
          ch = true;
          if (labMode === 2 && u !== XS) pushF({ stage: 3, msg: `${labelOf(v)} must be at least ${xW[ei]} columns right of ${labelOf(u)}, so it moves to column ${Math.round(xd[v]) + 1}.`, board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(y, xd, 0), ghost: true, segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("idle", ei), hl: [v] } });
        }
      }
      if (!ch) {
        xOK = true;
        break;
      }
      xOK = false;
    }
    if (!xOK) return null;

    const yI = new Int32Array(nNode), xI = new Int32Array(nP);
    for (let i = 0; i < nNode - 1; i++) yI[i] = Math.round(y[i]);
    for (let i = 0; i < nP; i++) xI[i] = Math.round(xd[i]);
    if (labMode === 2) pushF({ stage: 3, msg: `Nothing moves any more. Every part has a row and a column: a ${labRowsNow()} by ${labColsNow()} board, as tight as the relations allow.`, board: { rows: labRowsNow(), cols: labColsNow(), parts: labPlaced(yI, xI, 0), segs: [], cuts: [], wires: [], busRows: [], arrows: labXArrows("ok") } });

    // ── grid + exact measurement ──
    let H = 0, W = 0;
    for (let pi = 0; pi < nP; pi++) {
      const bot = geo[pi].mode === "V" ? yI[vBot.get(pi)!] : yI[pi] + geo[pi].h - 1;
      H = Math.max(H, bot + 1);
      W = Math.max(W, xI[pi] + geo[pi].w);
    }
    // the grid carries one blank line of margin on every free side: the
    // finish pads the route board the same way, so edge segments really do
    // have an attachment hole there and the rim rows serve as bus rows
    const GH = H + 2 * mRow, GW = W + 2 * mCol;
    ensureGrid((GH + 1) * GW);
    const occ = occBuf.fill(0, 0, GH * GW);
    const owner = ownerBuf.fill(-1, 0, GH * GW);
    const pinNetAt = pinNetBuf.fill(-1, 0, GH * GW);
    const at = (r: number, c: number) => r * GW + c;
    let overlapBad = 0;
    const claim = (r: number, c: number, v: number, net: number | undefined, pi: number) => {
      if (r < 0 || c < 0 || r >= H || c >= W) {
        overlapBad++;
        return;
      }
      const i = at(r + mRow, c + mCol);
      if (occ[i] !== 0 && owner[i] !== pi) overlapBad++;
      if (v === 2 || occ[i] === 0) {
        occ[i] = v;
        owner[i] = pi;
        if (v === 2 && net !== undefined && net >= 0) pinNetAt[i] = net;
      }
    };
    // a pin without a net still breaks the strip it sits on (the router
    // isolates floating pins), so it claims a private pseudo-net: the cuts
    // it forces get counted and the copper beyond it no longer joins nets
    let floatNet = nets.length;
    const lockedBoxes: { r1: number; r2: number; c1: number; c2: number }[] = [];
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked || p.kind !== "rigid") continue;
      const sh = geo[pi].sh!;
      lockedBoxes.push({ r1: yI[pi], r2: yI[pi] + sh.h - 1, c1: xI[pi], c2: xI[pi] + sh.w - 1 });
    }
    const flexCellBad = (r: number, c: number, mode: "H" | "V") => {
      for (const b of lockedBoxes) {
        const inRing = r >= b.r1 - 1 && r <= b.r2 + 1 && c >= b.c1 - 1 && c <= b.c2 + 1;
        if (!inRing) continue;
        if (mode === "V" && r >= b.r1 && r <= b.r2) return true;
        if (mode === "H" && c >= b.c1 && c <= b.c2) return true;
        if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) return true;
      }
      return false;
    };
    // A body wider than the line between its legs (a can) lies over holes of
    // its own: nothing else may use them, and a link through them runs under
    // the part. Off the board's edge it simply hangs over.
    const claimBody = (pi: number, p1: BoardPosition, p2: BoardPosition) => {
      if (!fatOf[pi]) return;
      for (const h of flexCoveredHoles(flexBody(profOf[pi]!, p1, p2))) {
        if (h.row >= 0 && h.col >= 0 && h.row < H && h.col < W) claim(h.row, h.col, 1, undefined, pi);
      }
    };
    let ringBad = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        for (let r = 0; r < sh.h; r++) for (let c = 0; c < sh.w; c++) claim(yI[pi] + r, xI[pi] + c, 1, undefined, pi);
        for (const sp of sh.pins) claim(yI[pi] + sp.rowOff, xI[pi] + sp.colOff, 2, sp.net ?? floatNet++, pi);
      } else if (geo[pi].mode === "H") {
        for (let c = 0; c <= p.dc0; c++) {
          if (c > 0 && c < p.dc0) claim(yI[pi], xI[pi] + c, 1, undefined, pi);
          if (flexCellBad(yI[pi], xI[pi] + c, "H")) ringBad++;
        }
        claimBody(pi, { row: yI[pi], col: xI[pi] }, { row: yI[pi], col: xI[pi] + p.dc0 });
        const brBit = flexBit(g.br, pi);
        claim(yI[pi], xI[pi], 2, (brBit === 0 ? p.na : p.nb) ?? floatNet++, pi);
        claim(yI[pi], xI[pi] + p.dc0, 2, (brBit === 0 ? p.nb : p.na) ?? floatNet++, pi);
      } else {
        const t = yI[pi], b = yI[vBot.get(pi)!];
        for (let r = t; r <= b; r++) {
          if (r > t && r < b) claim(r, xI[pi], 1, undefined, pi);
          if (flexCellBad(r, xI[pi], "V")) ringBad++;
        }
        claimBody(pi, { row: t, col: xI[pi] }, { row: b, col: xI[pi] });
        const brBit = flexBit(g.br, pi);
        claim(t, xI[pi], 2, (brBit === 0 ? p.na : p.nb) ?? floatNet++, pi);
        claim(b, xI[pi], 2, (brBit === 0 ? p.nb : p.na) ?? floatNet++, pi);
      }
    }

    // lab: the grid as drawn, copper strips per segment as they are found
    const labSegs: LabSeg[] = [], labCuts: LabCut[] = [], labWires: LabWire[] = [];
    const labParts = labMode ? labPlaced(yI, xI, 0).map((p) => ({ ...p, x: p.x + mCol, y: p.y + mRow, pos: { row: p.pos.row + mRow, col: p.pos.col + mCol }, end: p.end && { row: p.end.row + mRow, col: p.end.col + mCol }, pins: p.pins.map((q) => ({ ...q, r: q.r + mRow, c: q.c + mCol })) })) : [];
    const labBoardAt = (fromRow: number, extra: Partial<LabBoard> = {}): LabBoard => ({ rows: GH, cols: GW, parts: labParts, segs: [...labSegs, ...Array.from({ length: GH - fromRow }, (_, k) => ({ row: fromRow + k, c1: 0, c2: GW - 1, net: -1 }))], cuts: [...labCuts], wires: [...labWires], busRows: [], ...extra });
    if (labMode === 2) pushF({ stage: 4, msg: `The board gets ${mRow ? "one blank line of margin on every side, and" : ""} every row is one copper strip. Now each row is read from left to right.`, board: labBoardAt(0) });
    // runs, cuts, segments per row
    let cuts = 0, bCuts = 0;
    const cutAware = !!options?.cutAwareScan;
    // cut-aware scan: a net with a single run never needs a link, so its
    // segment needs no free hole
    const runsOfNet = cutAware ? new Int32Array(nets.length) : null;
    if (runsOfNet) {
      for (let r = 0; r < GH; r++) {
        let prev = -1;
        for (let c = 0; c < GW; c++) {
          const i = at(r, c);
          if (occ[i] !== 2 || pinNetAt[i] < 0) continue;
          if (pinNetAt[i] !== prev) runsOfNet[pinNetAt[i]]++;
          prev = pinNetAt[i];
        }
      }
    }
    const segsOfNet = new Map<number, { row: number; c1: number; c2: number }[]>();
    // pin-free rows are bus rows: copper a net may claim over a span to
    // travel horizontally between two vertical hops (the router's relays)
    const busRows: number[] = [];
    const busClaims = new Map<number, { c1: number; c2: number; net: number }[]>();
    for (let r = 0; r < GH; r++) {
      const rowPins: { c: number; net: number }[] = [];
      for (let c = 0; c < GW; c++) {
        const i = at(r, c);
        if (occ[i] === 2 && pinNetAt[i] >= 0) rowPins.push({ c, net: pinNetAt[i] });
      }
      if (rowPins.length === 0) {
        busRows.push(r);
        if (labMode) labSegs.push({ row: r, c1: 0, c2: GW - 1, net: -1 });
        if (labMode === 2) pushF({ stage: 4, msg: `Row ${r + 1} carries no pin at all: a bus row, spare copper any net may borrow to travel sideways.`, board: labBoardAt(r + 1, { busRows: [...busRows], cursor: { r, c: GW - 1 } }) });
        continue;
      }
      if (labMode === 2) pushF({ stage: 4, msg: `Row ${r + 1}.`, board: labBoardAt(r, { busRows: [...busRows], cursor: { r, c: 0 } }) });
      let segStart = 0;
      let curNet = rowPins[0].net;
      let lastPinC = rowPins[0].c;
      const flush = (endC: number, net: number) => {
        if (!segsOfNet.has(net)) segsOfNet.set(net, []);
        segsOfNet.get(net)!.push({ row: r, c1: segStart, c2: endC });
        if (labMode) labSegs.push({ row: r, c1: segStart, c2: endC, net });
      };
      if (runsOfNet) {
        const runEnd: number[] = [];
        for (let k = rowPins.length - 1, e = rowPins.length - 1; k >= 0; k--) {
          if (k < rowPins.length - 1 && rowPins[k].net !== rowPins[k + 1].net) e = k;
          runEnd[k] = e;
        }
        const freeBetween = (a: number, b: number) => { let n = 0; for (let c = a; c <= b; c++) if (occ[at(r, c)] === 0) n++; return n; };
        let freeA = freeBetween(0, rowPins[0].c);
        for (let k = 1; k < rowPins.length; k++) {
          if (rowPins[k].net === curNet) { freeA += freeBetween(lastPinC + 1, rowPins[k].c); lastPinC = rowPins[k].c; continue; }
          cuts++;
          const gap = rowPins[k].c - lastPinC;
          const needA = runsOfNet[curNet] >= 2 && freeA === 0;
          const eb = runEnd[k];
          const needB = runsOfNet[rowPins[k].net] >= 2 && freeBetween(rowPins[k].c, eb === rowPins.length - 1 ? GW - 1 : rowPins[eb].c) === 0;
          const sp: number[] = [];
          for (let c = lastPinC + 1; c < rowPins[k].c; c++) if (occ[at(r, c)] === 0) sp.push(c);
          let endA = lastPinC, startB: number;
          if (sp.length === 0 || (!needA && !needB)) {
            if (gap >= 2) startB = lastPinC + 2;
            else { bCuts++; startB = rowPins[k].c; }
          } else if (needA && (sp.length >= 3 || (sp.length === 2 && !needB))) {
            endA = sp[1] - 1; startB = sp[1] + 1;
          } else if (needA && (sp.length === 2 || !needB)) {
            bCuts++; endA = sp[0]; startB = sp[0] + 1;
          } else if (sp.length >= 2 || sp[0] !== lastPinC + 1) {
            startB = lastPinC + 2;
          } else {
            bCuts++; startB = lastPinC + 1;
          }
          flush(endA, curNet);
          segStart = startB;
          curNet = rowPins[k].net;
          freeA = freeBetween(startB, rowPins[k].c);
          lastPinC = rowPins[k].c;
        }
        flush(GW - 1, curNet);
        continue;
      }
      for (let k = 1; k < rowPins.length; k++) {
        if (rowPins[k].net !== curNet) {
          cuts++;
          const gap = rowPins[k].c - lastPinC;
          const prevNet = curNet;
          if (gap >= 2) {
            flush(lastPinC + 1 - 1, curNet);
            segStart = lastPinC + 2;
            if (labMode) labCuts.push({ row: r, col: lastPinC + 1, kind: "hole" });
          } else {
            bCuts++;
            flush(lastPinC, curNet);
            segStart = rowPins[k].c;
            if (labMode) labCuts.push({ row: r, col: lastPinC, kind: "knife" });
          }
          curNet = rowPins[k].net;
          if (labMode === 2) pushF({ stage: 4, msg: `Row ${r + 1}: ${netName(prevNet)} on the left, ${netName(curNet)} on the right. The strip is cut ${gap >= 2 ? "by drilling out the spare hole between them" : "with a knife between the two holes, since no spare hole is free"}.`, board: labBoardAt(r + 1, { busRows: [...busRows], cursor: { r, c: rowPins[k].c }, segs: [...labSegs, { row: r, c1: segStart, c2: GW - 1, net: -1 }, ...Array.from({ length: GH - r - 1 }, (_, q) => ({ row: r + 1 + q, c1: 0, c2: GW - 1, net: -1 }))] }) });
        }
        lastPinC = rowPins[k].c;
      }
      flush(GW - 1, curNet);
    }
    if (labMode === 2) pushF({ stage: 4, msg: `${cuts} cuts${bCuts ? `, ${bCuts} of them with a knife` : ""}, ${busRows.length} bus rows. Every strip segment now carries one net or none.`, board: labBoardAt(GH, { busRows: [...busRows] }) });

    // wires: per-net MST over segments, realizability-aware
    const used = usedBuf.fill(0, 0, GH * GW);
    // body cells per column above each row, so the bodies a vertical wire
    // would cross between two rows come out of one subtraction
    const bodyPre = bodyPreBuf;
    for (let c = 0; c < GW; c++) {
      let n = 0;
      for (let r = 0; r < GH; r++) {
        bodyPre[r * GW + c] = n;
        if (occ[r * GW + c] === 1) n++;
      }
      bodyPre[GH * GW + c] = n;
    }
    let wires = 0, wireLen = 0, slants = 0, crossings = 0, starved = 0, starvedHard = 0, relays = 0;
    const hardSegs: string[] = [];
    // cleanest hop column from a segment to a bus row: free holes at both
    // ends, fewest bodies between
    const hop = (S: { row: number; c1: number; c2: number }, r: number): number => {
      const rowS = S.row * GW, rowR = r * GW;
      const preTop = (Math.min(S.row, r) + 1) * GW, preBot = Math.max(S.row, r) * GW;
      let bestC = -1, bestCross = Infinity;
      for (let c = S.c1; c <= S.c2; c++) {
        if (occ[rowS + c] !== 0 || occ[rowR + c] !== 0 || used[rowS + c] || used[rowR + c]) continue;
        const cr = bodyPre[preBot + c] - bodyPre[preTop + c];
        if (cr < bestCross) {
          bestCross = cr;
          bestC = c;
        }
        if (cr === 0) break;
      }
      return bestC < 0 ? -1 : bestC + (bestCross << 16);
    };
    const labBoard5 = (extra: Partial<LabBoard> = {}): LabBoard => ({ rows: GH, cols: GW, parts: labParts, segs: [...labSegs], cuts: [...labCuts], wires: [...labWires], busRows: [...busRows], ...extra });
    for (const [net, segs] of segsOfNet) {
      if (segs.length < 2) continue;
      if (labMode === 2) pushF({ stage: 5, msg: `${netName(net)} has pins on ${segs.length} strip segments. They have to be joined by link wires.`, board: labBoard5({ hlNet: net }) });
      const labStarved0 = starvedHard + starved;
      const k = segs.length;
      linkCount.fill(0, 0, k);
      inTree.fill(0, 0, k);
      const tree = [0];
      inTree[0] = 1;
      // Prim keys: per outside segment, its cheapest link from the tree
      // (earliest tree member on ties, so the pick matches a full scan in
      // tree order). A link only consumes holes on its two rows, so keys
      // of segments elsewhere stay exact and are not recomputed.
      // hop columns per (segment, bus row), found once and reused while
      // the two holes they end on stay free
      const nBus = busRows.length;
      if (hopBuf.length < k * nBus) hopBuf = new Int32Array(Math.max(k * nBus, hopBuf.length * 2));
      const hopCache = hopBuf.fill(-2, 0, k * nBus);
      const hopCached = (si: number, bi2: number): number => {
        const idx = si * nBus + bi2;
        let h = hopCache[idx];
        if (h >= 0) {
          const c = h & 0xffff;
          if (used[segs[si].row * GW + c] || used[busRows[bi2] * GW + c]) h = -2;
        }
        if (h === -2) {
          h = hop(segs[si], busRows[bi2]);
          hopCache[idx] = h;
        }
        return h;
      };
      const offer = (ti: number, b2: number, force: boolean) => {
        const A = segs[tree[ti]], B = segs[b2];
        const rowA = A.row * GW;
        const lo = Math.max(A.c1, B.c1), hi = Math.min(A.c2, B.c2);
        let cost: number, cross = 0, bestCol = -1;
        if (A.row === B.row) cost = 50;
        else if (lo <= hi) {
          let bestCross = Infinity;
          const rowB = B.row * GW;
          const preTop = (Math.min(A.row, B.row) + 1) * GW, preBot = Math.max(A.row, B.row) * GW;
          for (let c = lo; c <= hi; c++) {
            if (occ[rowA + c] !== 0 || occ[rowB + c] !== 0) continue;
            if (used[rowA + c] || used[rowB + c]) continue;
            const cr = bodyPre[preBot + c] - bodyPre[preTop + c];
            if (cr < bestCross) {
              bestCross = cr;
              bestCol = c;
            }
            if (cr === 0) break;
          }
          if (bestCross === Infinity) cost = 50;
          else {
            cost = 1 + bestCross * 8;
            cross = bestCross;
          }
        } else cost = 50;
        let len = Math.abs(A.row - B.row);
        let total = cost + len * 0.1;
        let relayRow = -1, cA = -1, cB = -1;
        if (cost >= 50 && busRows.length) {
          // no shared column: a bus-row relay, two vertical hops joined by
          // a claimed span of pin-free copper. A clean relay through a row
          // between the strips is the cheapest possible and ends the search
          const rLo = Math.min(A.row, B.row), rHi = Math.max(A.row, B.row);
          const sa = tree[ti];
          for (let bi2 = 0; bi2 < busRows.length; bi2++) {
            const r = busRows[bi2];
            if (r === A.row || r === B.row) continue;
            const hA = hopCached(sa, bi2);
            if (hA < 0) continue;
            const hB = hopCached(b2, bi2);
            if (hB < 0) continue;
            const ca = hA & 0xffff, cb = hB & 0xffff;
            const lo2 = Math.min(ca, cb), hi2 = Math.max(ca, cb);
            const claims = busClaims.get(r);
            let taken = false;
            if (claims) for (const cl of claims) if (cl.net !== net && cl.c1 <= hi2 && lo2 <= cl.c2) { taken = true; break; }
            if (taken) continue;
            const cr = (hA >> 16) + (hB >> 16);
            const rl = Math.abs(A.row - r) + Math.abs(B.row - r);
            const t = 3 + cr * 8 + rl * 0.1;
            if (t < total) {
              total = t;
              cross = cr;
              len = rl;
              relayRow = r;
              cA = ca;
              cB = cb;
              if (cr === 0 && r > rLo && r < rHi) break;
            }
          }
        }
        if (force || total < kTotal[b2]) {
          kTotal[b2] = total;
          kA[b2] = ti;
          kCross[b2] = cross;
          kLen[b2] = len;
          kCol[b2] = bestCol;
          kOff[b2] = relayRow < 0 && cost >= 50 ? 1 : 0;
          kRow[b2] = relayRow;
          kCA[b2] = cA;
          kCB[b2] = cB;
        }
      };
      const rekey = (b2: number) => {
        offer(0, b2, true);
        for (let ti = 1; ti < tree.length; ti++) offer(ti, b2, false);
      };
      for (let b2 = 1; b2 < k; b2++) rekey(b2);
      while (tree.length < k) {
        let bb = -1;
        for (let b2 = 0; b2 < k; b2++) {
          if (inTree[b2]) continue;
          if (bb < 0 || kTotal[b2] < kTotal[bb] || (kTotal[b2] === kTotal[bb] && kA[b2] < kA[bb])) bb = b2;
        }
        const a = tree[kA[bb]];
        inTree[bb] = 1;
        tree.push(bb);
        wireLen += kLen[bb];
        crossings += kCross[bb];
        if (kOff[bb]) slants++;
        if (labMode) {
          const A = segs[a], B = segs[bb];
          if (kRow[bb] >= 0) {
            const r = kRow[bb];
            labWires.push({ r1: A.row, c1: kCA[bb], r2: r, c2: kCA[bb], net, slanted: false, crossings: 0 }, { r1: r, c1: kCB[bb], r2: B.row, c2: kCB[bb], net, slanted: false, crossings: 0 });
            labSegs.push({ row: r, c1: Math.min(kCA[bb], kCB[bb]), c2: Math.max(kCA[bb], kCB[bb]), net });
            if (labMode === 2) pushF({ stage: 5, msg: `${netName(net)}: no column has a free hole on both segments, so the decoder takes a detour: one hop along column ${kCA[bb] + 1} to bus row ${r + 1}, ${Math.abs(kCA[bb] - kCB[bb])} holes of borrowed copper, and a hop back along column ${kCB[bb] + 1}. Two straight wires instead of one slanted one.`, board: labBoard5({ hlNet: net }) });
          } else if (kCol[bb] >= 0) {
            labWires.push({ r1: A.row, c1: kCol[bb], r2: B.row, c2: kCol[bb], net, slanted: false, crossings: kCross[bb] });
            if (labMode === 2) {
              const marks: LabMark[] = [];
              const lo = Math.max(A.c1, B.c1), hi = Math.min(A.c2, B.c2);
              const preTop = (Math.min(A.row, B.row) + 1) * GW, preBot = Math.max(A.row, B.row) * GW;
              for (let c = lo; c <= hi; c++) {
                const ok = occ[A.row * GW + c] === 0 && occ[B.row * GW + c] === 0 && (c === kCol[bb] || (!used[A.row * GW + c] && !used[B.row * GW + c])) && bodyPre[preBot + c] - bodyPre[preTop + c] === 0;
                marks.push({ r: A.row, c, kind: ok ? "ok" : "bad" }, { r: B.row, c, kind: ok ? "ok" : "bad" });
              }
              pushF({ stage: 5, msg: `${netName(net)}: the cheapest link runs straight down column ${kCol[bb] + 1}, ${Math.abs(A.row - B.row)} holes long${kCross[bb] ? `, over ${kCross[bb]} part${kCross[bb] === 1 ? "" : "s"}, which is charged as mess` : ""}.`, board: labBoard5({ hlNet: net, marks }) });
            }
          } else {
            labWires.push({ r1: A.row, c1: Math.round((A.c1 + A.c2) / 2), r2: B.row, c2: Math.round((B.c1 + B.c2) / 2), net, slanted: true, crossings: 0 });
            if (labMode === 2) pushF({ stage: 5, msg: `${netName(net)}: no straight link and no relay either. The decoder records a slanted wire and charges for it, so the annealer knows this description is nearly right, not hopeless.`, board: labBoard5({ hlNet: net }) });
          }
        }
        if (kRow[bb] >= 0) {
          const r = kRow[bb];
          used[segs[a].row * GW + kCA[bb]] = 1;
          used[r * GW + kCA[bb]] = 1;
          used[r * GW + kCB[bb]] = 1;
          used[segs[bb].row * GW + kCB[bb]] = 1;
          if (!busClaims.has(r)) busClaims.set(r, []);
          busClaims.get(r)!.push({ c1: Math.min(kCA[bb], kCB[bb]), c2: Math.max(kCA[bb], kCB[bb]), net });
          wires += 2;
          relays++;
        } else {
          wires++;
          if (kCol[bb] >= 0) {
            used[segs[a].row * GW + kCol[bb]] = 1;
            used[segs[bb].row * GW + kCol[bb]] = 1;
          }
        }
        linkCount[a]++;
        linkCount[bb]++;
        // a consumed hole only ever raises a pair's cost, and only when the
        // key relied on that hole: just those keys are recomputed, the
        // rest only hear the new member's offer (claims never collide
        // inside one net, so relay keys depend on their four holes alone)
        const tn = tree.length - 1;
        for (let b2 = 0; b2 < k; b2++) {
          if (inTree[b2]) continue;
          const rb = segs[b2].row * GW, ra = segs[tree[kA[b2]]].row * GW;
          let stale = false;
          if (kRow[b2] >= 0) {
            const rr = kRow[b2] * GW;
            stale = !!(used[ra + kCA[b2]] || used[rr + kCA[b2]] || used[rr + kCB[b2]] || used[rb + kCB[b2]]);
          } else if (kCol[b2] >= 0) {
            stale = !!(used[ra + kCol[b2]] || used[rb + kCol[b2]]);
          }
          if (stale) rekey(b2);
          else offer(tn, b2, false);
        }
      }
      // a linked segment without any free hole cannot take its wire at all
      // (hard); one whose only free hole the link consumes leaves the
      // router no slack (headroom, soft)
      for (let s = 0; s < segs.length; s++) {
        if (linkCount[s] === 0) continue;
        let free = 0, spare = 0;
        for (let c = segs[s].c1; c <= segs[s].c2 && spare === 0; c++) {
          if (occ[at(segs[s].row, c)] !== 0) continue;
          free++;
          if (!used[segs[s].row * GW + c]) spare++;
        }
        if (free === 0) {
          starvedHard++;
          if (options?.debugSeeds) hardSegs.push(`${segs[s].row}:${segs[s].c1}-${segs[s].c2}/n${net}`);
        } else if (spare === 0) starved++;
      }
      if (labMode === 2 && starvedHard + starved > labStarved0) pushF({ stage: 5, msg: `${netName(net)}: one of its segments has no free hole left for a wire to attach to. The decoder charges a heavy price for the starved pin and moves on.`, board: labBoard5({ hlNet: net }) });
    }


    let spanBad = 0;
    for (const pi of flexIdx) {
      if (geo[pi].mode !== "V") continue;
      const span = yI[vBot.get(pi)!] - yI[pi];
      if (!(parts[pi] as FlexPart).vdSet.has(span)) spanBad++;
    }

    // exact clearance checks at decoded coordinates (the pair-exact rules
    // the blanket gaps approximated); bbox prefilter keeps it cheap
    let geoBad = 0;
    {
      interface PR { pi: number; kind: "rigid" | "flex"; p1?: BoardPosition; p2?: BoardPosition; cap?: Capsule; body?: FootprintRect; reach?: FootprintRect; minRow: number; maxRow: number; minCol: number; maxCol: number }
      const rects: PR[] = [];
      for (let pi = 0; pi < nP; pi++) {
        const g2 = geo[pi];
        if (parts[pi].kind === "rigid") {
          const bd = g2.sh!.body;
          const at = (o: FootprintRect): FootprintRect => ({ minRow: yI[pi] + o.minRow, maxRow: yI[pi] + o.maxRow, minCol: xI[pi] + o.minCol, maxCol: xI[pi] + o.maxCol });
          const reach = g2.sh!.reach ? at(g2.sh!.reach) : undefined;
          // the prefilter box has to take in the reach, or a part under a
          // shaft is never even compared with it
          rects.push({ pi, kind: "rigid", body: at(bd), reach,
            minRow: Math.floor(Math.min(yI[pi], reach?.minRow ?? Infinity)), maxRow: Math.ceil(Math.max(yI[pi] + g2.h - 1, reach?.maxRow ?? -Infinity)),
            minCol: Math.floor(Math.min(xI[pi], reach?.minCol ?? Infinity)), maxCol: Math.ceil(Math.max(xI[pi] + g2.w - 1, reach?.maxCol ?? -Infinity)) });
        } else if (g2.mode === "H") {
          const dc0 = (parts[pi] as FlexPart).dc0;
          const p1 = { row: yI[pi], col: xI[pi] }, p2 = { row: yI[pi], col: xI[pi] + dc0 };
          rects.push({ pi, kind: "flex", p1, p2, cap: flexBody(profOf[pi]!, p1, p2),
            minRow: yI[pi], maxRow: yI[pi], minCol: xI[pi], maxCol: xI[pi] + dc0 });
        } else {
          const b = yI[vBot.get(pi)!];
          const p1 = { row: yI[pi], col: xI[pi] }, p2 = { row: b, col: xI[pi] };
          rects.push({ pi, kind: "flex", p1, p2, cap: flexBody(profOf[pi]!, p1, p2),
            minRow: yI[pi], maxRow: b, minCol: xI[pi], maxCol: xI[pi] });
        }
      }
      // sorted by top row, a pair is skipped as soon as B starts below A's reach
      rects.sort((p, q) => p.minRow - q.minRow);
      for (let a = 0; a < rects.length; a++) {
        const A = rects[a];
        for (let b2 = a + 1; b2 < rects.length; b2++) {
          const B = rects[b2];
          if (B.minRow > A.maxRow + clrPad) break;
          if (A.minCol > B.maxCol + clrPad || B.minCol > A.maxCol + clrPad) continue;
          if (A.kind === "flex" && B.kind === "flex") {
            if (segmentsIntersect(A.p1!, A.p2!, B.p1!, B.p2!)) geoBad++;
            else if (capsulesClash(A.cap!, B.cap!, Math.max(linesOf[A.pi], linesOf[B.pi]))) geoBad++;
          } else if (A.kind === "flex" || B.kind === "flex") {
            const F = A.kind === "flex" ? A : B;
            const R = A.kind === "flex" ? B : A;
            if (capsuleClashesRect(F.cap!, R.body!, Math.max(linesOf[F.pi], linesOf[R.pi])) || (R.reach && capsuleClashesRect(F.cap!, R.reach))) geoBad++;
          } else if (
            // two packages whose plastic overhangs their cells into each
            // other, or one sitting under what the other holds over the board
            bodyRectsClash(A.body!, B.body!, Math.max(linesOf[A.pi], linesOf[B.pi])) ||
            (A.reach && bodyRectsClash(A.reach, B.body!)) || (B.reach && bodyRectsClash(B.reach, A.body!)) ||
            (A.reach && B.reach && bodyRectsClash(A.reach, B.reach))
          ) {
            geoBad++;
          }
        }
      }
    }

    const lockOver =
      (lockedColsCap !== undefined ? Math.max(0, W - lockedColsCap) : 0) +
      (lockedRowsCap !== undefined ? Math.max(0, H - lockedRowsCap) : 0);
    // shape: humans build wide boards (corpus median rows/cols 0.75, the
    // solver's 1.06), so every row beyond the width is priced like a full
    // row of cells; a wide board pays only beyond the 2:1 ribbon (v2's
    // rule). A user-locked dimension is the user's own shape choice and
    // exempts the board
    const aspectOver = lockedColsCap !== undefined || lockedRowsCap !== undefined ? 0
      : W_TALL * Math.max(0, H - W) * W + Math.max(0, W - 2 * H) * H;
    // a locked dimension is a physical board already cut: charge its FULL
    // extent (narrower/shorter content saves nothing), so the anneal trades
    // the locked dimension for the free one
    const physW = lockedColsCap !== undefined ? Math.max(W, lockedColsCap) : W;
    const physH = lockedRowsCap !== undefined ? Math.max(H, lockedRowsCap) : H;
    // connectors belong on a board edge, any of the four (on edge 0, 1 away
    // 50%, 2 away 75%, then 100% of the full price; the small slope keeps a
    // gradient on the plateau); a locked connector is the user's placement
    // a margin line the wiring attached to becomes a real board line in
    // the finish (padding outside), so a connector flush on that side sits
    // one line in and is priced that way: the anneal weighs the channel
    // against the connectors it pushes off the edge
    const marginUsed = { top: false, bottom: false, left: false, right: false };
    if (mRow) for (let c = 0; c < GW; c++) { if (used[c]) marginUsed.top = true; if (used[(GH - 1) * GW + c]) marginUsed.bottom = true; }
    if (mCol) for (let r = 0; r < GH; r++) { if (used[r * GW]) marginUsed.left = true; if (used[r * GW + GW - 1]) marginUsed.right = true; }
    let connEdge = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.isConn || p.locked) continue;
      const h = geo[pi].mode === "V" ? yI[vBot.get(pi)!] - yI[pi] + 1 : geo[pi].h;
      const w = geo[pi].w;
      const FAR = 50;
      const dl = connSides.left ? xI[pi] + (marginUsed.left ? 1 : 0) : FAR;
      const dr = connSides.right ? physW - (xI[pi] + w) + (marginUsed.right ? 1 : 0) : FAR;
      const dt = connSides.top ? yI[pi] + (marginUsed.top ? 1 : 0) : FAR;
      const db = connSides.bottom ? physH - (yI[pi] + h) + (marginUsed.bottom ? 1 : 0) : FAR;
      const d = Math.min(dl, dr, dt, db);
      // a multi-pin connector should run along its nearest edge, not point
      // into the board, or its external wires come in across the parts. The
      // orientation is priced at any distance, so that a step inward is no
      // way out of it: only a rotation is
      const along = ((dl === d || dr === d) && h >= w) || ((dt === d || db === d) && w >= h);
      const CONN_FULL = 30;
      // a screw terminal that opens toward the parts is as hard to wire as one
      // in the middle of the board, so looking the wrong way costs the same
      const entry = geo[pi].sh?.entry;
      const facesOut = !entry || { left: dl, right: dr, top: dt, bottom: db }[entry] === d;
      connEdge += (d <= 0 ? 0 : d === 1 ? 0.5 * CONN_FULL : d === 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d + (along ? 0 : 0.75 * CONN_FULL) + (facesOut ? 0 : CONN_FULL);
    }
    // a shaft goes through the panel, so it belongs out over the board's
    // edge: whatever share of it lies over the board instead is priced like
    // a connector kept off the edge
    let shaftIn = 0;
    for (const pi of rigidIdx) {
      const reach = geo[pi].sh?.reach;
      if (!reach || parts[pi].locked) continue;
      const r0 = yI[pi] + reach.minRow - 0.5, r1 = yI[pi] + reach.maxRow + 0.5;
      const c0 = xI[pi] + reach.minCol - 0.5, c1 = xI[pi] + reach.maxCol + 0.5;
      const inside =
        Math.max(0, Math.min(r1, physH - 0.5) - Math.max(r0, -0.5)) * Math.max(0, Math.min(c1, physW - 0.5) - Math.max(c0, -0.5));
      shaftIn += 30 * (inside / ((r1 - r0) * (c1 - c0)));
    }
    // the pads of one off-board part are wired as a bundle, so they are worth
    // keeping together; a small price, well under what an edge place is worth
    let sibling = 0;
    for (const group of siblingGroups) {
      let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
      for (const pi of group) {
        r0 = Math.min(r0, yI[pi]); r1 = Math.max(r1, yI[pi]);
        c0 = Math.min(c0, xI[pi]); c1 = Math.max(c1, xI[pi]);
      }
      sibling += W_SIBLING * Math.max(0, r1 - r0 + (c1 - c0) - (group.length - 1));
    }
    const eBase =
      W_AREA * (physH * physW + aspectOver) + W_WIRE * wires + W_WLEN * wireLen +
      W_CUT * cuts + wBCut * bCuts + W_LOCKOVER * lockOver + connEdge + shaftIn + sibling +
      overlapBad * 500 + geoBad * 450 + ringBad * 120 + spanBad * 60 + starved * 20 + starvedHard * 450;
    const hardPen = overlapBad * 500 + geoBad * 450 + starvedHard * 450;
    if (labMode) {
      labBoardOut = labBoard5();
      pushF({ stage: 5, msg: `Every net is joined: ${wires} link wire${wires === 1 ? "" : "s"} of total length ${wireLen} hole${wireLen === 1 ? "" : "s"}.`, board: labBoardOut });
      pushF({ stage: 6, msg: `Board ${GH} by ${GW} = ${GH * GW} cells, ${wires} link wires of total length ${wireLen}, ${cuts} cuts${bCuts ? ` (${bCuts} with a knife)` : ""}, ${slants + crossings} messy wire${slants + crossings === 1 ? "" : "s"}${starvedHard ? `, ${starvedHard} starved pin${starvedHard === 1 ? "" : "s"}` : ""}${connEdge ? `, a connector away from the edge` : ""}. Score ${(eBase + W_MESS * (slants + crossings)).toFixed(1)}.`, board: labBoardOut });
    }
    return { eBase, hardPen, marginUsed, slants, crossings, H, W, yI, xI, geo, vBot, dbg: { wires, wireLen, relays, cuts, bCuts, starved, starvedHard, geoBad, overlapBad, connEdge, lockOver, spanBad, hardSegs } };
  }

  // ── mutation ──
  // r bands of the move kinds (MOVE_KINDS order), for forcing a kind
  const KIND_BANDS: [number, number][] = [[0, 0.06], [0.06, 0.17], [0.17, 0.336], [0.336, 0.502], [0.502, 0.585], [0.585, 0.6514], [0.6514, 0.7344], [0.7344, 0.8008], [0.8008, 0.9004], [0.9004, 0.92115], [0.92115, 0.9419], [0.9419, 1]];
  function mutate(g: Genome, rng: () => number, cold = false, tag?: { kind: number }, force?: number): Genome | null {
    let r = rng();
    if (tag) tag.kind = -1;
    if (force !== undefined) { const b = KIND_BANDS[force]; r = b[0] + rng() * (b[1] - b[0]); }
    if (cold) {
      // low-temperature mix: only the move kinds that stay on the plateau
      // (pull, sequence swaps, branch flip, label merge, gap toggles)
      const bands: [number, number, number][] = [[0.06, 0.17, 8], [0.17, 0.336, 22], [0.336, 0.502, 22], [0.502, 0.585, 12], [0.7344, 0.8008, 6], [0.8008, 0.9004, 14], [0.9004, 0.92115, 8], [0.92115, 0.9419, 8]];
      let x = rng() * 100, b = bands[0];
      for (const bb of bands) { if (x < bb[2]) { b = bb; break; } x -= bb[2]; }
      r = b[0] + rng() * (b[1] - b[0]);
    }
    const gg = cloneG(g);
    const ri = (n: number) => Math.floor(rng() * n);
    // side-switch teleport: throw a connector to the opposite extreme of
    // both sequences (the other board edge). Connectors stacked on one edge
    // set the board height; the area pricing already prefers a split, but
    // ordinary swaps cannot carry a connector across the board.
    if (r < 0.06 && nP >= 3) {
      if (tag) tag.kind = 0;
      const conns = parts.map((p, i) => (p.isConn && !p.locked ? i : -1)).filter((i) => i >= 0);
      if (!conns.length) return null;
      const a = conns[ri(conns.length)];
      const back = rng() < 0.5;
      for (const arr of [gg.gp, gg.gn]) {
        arr.splice(arr.indexOf(a), 1);
        if (back) arr.push(a);
        else arr.unshift(a);
      }
      return gg;
    }
    if (r < 0.17 && nP >= 3) {
      if (tag) tag.kind = 1;
      const cand: number[][] = [];
      for (let n = 0; n < nets.length; n++) {
        const ps = [...new Set(netPins[n].map((x) => x.pi))];
        if (ps.length >= 2) cand.push(ps);
      }
      if (!cand.length) return null;
      const ps = cand[ri(cand.length)];
      const a = ps[ri(ps.length)];
      let b = ps[ri(ps.length)];
      if (a === b) b = ps[(ps.indexOf(b) + 1) % ps.length];
      if (a === b) return null;
      const side = rng() < 0.5 ? 0 : 1;
      for (const arr of [gg.gp, gg.gn]) {
        arr.splice(arr.indexOf(a), 1);
        arr.splice(arr.indexOf(b) + side, 0, a);
      }
      return gg;
    }
    r = (r - 0.17) / 0.83;
    const swapNear = (arr: number[]) => {
      const i = ri(arr.length - 1);
      const j = Math.min(arr.length - 1, i + 1 + ri(3));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    };
    if (nP < 2) {
      if (tag) tag.kind = 5;
      if (rigidIdx.length > 0 && !parts[rigidIdx[0]].locked) {
        gg.rot[0] = (gg.rot[0] + 1 + ri(3)) % 4;
        return gg;
      }
      return null;
    }
    if (r < 0.2) { if (tag) tag.kind = 2; swapNear(gg.gp); }
    else if (r < 0.4) { if (tag) tag.kind = 3; swapNear(gg.gn); }
    else if (r < 0.5) {
      if (tag) tag.kind = 4;
      swapNear(gg.gp);
      swapNear(gg.gn);
    } else if (r < 0.58 && rigidIdx.length > 0) {
      if (tag) tag.kind = 5;
      if (lean && !rotK.length) return null;
      const k = lean ? rotK[ri(rotK.length)] : ri(rigidIdx.length);
      gg.rot[k] = (gg.rot[k] + 1 + ri(3)) % 4;
    } else if (r < 0.68 && flexIdx.length > 0) {
      if (tag) tag.kind = 6;
      const k = ri(flexIdx.length);
      const p = parts[flexIdx[k]] as FlexPart;
      if (p.canH && p.canV) gg.hv[k] = 1 - gg.hv[k];
      else return null;
    } else if (r < 0.76 && flexIdx.length > 0) {
      if (tag) tag.kind = 7;
      const k = ri(flexIdx.length);
      gg.br[k] = 1 - gg.br[k];
    } else if (r < 0.88) {
      if (tag) tag.kind = 8;
      const n = ri(nets.length);
      const pins = netPins[n];
      if (pins.length < 2) return null;
      const a = ri(pins.length);
      let b = ri(pins.length);
      if (a === b) b = (b + 1) % pins.length;
      if (lean && gg.grp[n][a] === gg.grp[n][b]) return null;
      gg.grp[n][a] = gg.grp[n][b];
    } else if (r < 0.905) {
      if (tag) tag.kind = 9;
      // open or close a blank row below a part (bus-row supply)
      const i = ri(nP);
      gg.gap[i] = gg.gap[i] > 0 ? 0 : 1 + ri(2);
    } else if (r < 0.93) {
      if (tag) tag.kind = 10;
      // open or close blank columns right of a part (attachment holes)
      const i = ri(nP);
      gg.xgap[i] = gg.xgap[i] > 0 ? 0 : 1 + ri(2);
    } else {
      if (tag) tag.kind = 11;
      const n = ri(nets.length);
      const pins = netPins[n];
      if (pins.length < 2) return null;
      const a = ri(pins.length);
      if (lean && gg.grp[n].indexOf(gg.grp[n][a]) === gg.grp[n].lastIndexOf(gg.grp[n][a])) return null;
      gg.grp[n][a] = 1 + Math.max(...gg.grp[n]);
    }
    return gg;
  }

  // ── SA with penalty ramp ──
  function solveSeed(seed: number, seedPos: number): { E: number; g: Genome; d: Decoded } | null {
    const rng = mulberry32((seed + 1) * 0x9e3779b9);
    const rampStart = options?.schedule?.rampStart ?? RAMP_START;
    const rampEnd = movesN * (options?.schedule?.rampEndFrac ?? 1);
    const wOf = (it: number) => Math.min(W_MESS, rampStart * Math.pow(W_MESS / rampStart, it / rampEnd));
    const hardStart = options?.schedule?.hardStart ?? 1;
    const hardOf = (it: number) => hardStart >= 1 ? 1 : Math.min(1, hardStart * Math.pow(1 / hardStart, it / rampEnd));
    let hardScale = 1;
    const price = (d: Decoded, w: number) => d.eBase + w * (d.slants + d.crossings) + (hardScale - 1) * d.hardPen;
    const priceFin = (d: Decoded) => d.eBase + W_MESS * (d.slants + d.crossings);
    let g = initGenome(rng);
    let cur = decode(g);
    if (options?.debugSeeds && cur) console.log('FP0 gp=' + g.gp.slice(0, 8).join(',') + ' eBase=' + cur.eBase.toFixed(2) + ' HxW=' + cur.H + 'x' + cur.W + ' ySum=' + cur.yI.reduce((a, b) => a + b, 0) + ' xSum=' + cur.xI.reduce((a, b) => a + b, 0) + ' grp=' + g.grp.map((a) => a.join('')).join('|') + ' xI=' + Array.from(cur.xI).join(','));
    let tries = 0;
    while (!cur && tries++ < 50) {
      g = initGenome(rng);
      cur = decode(g);
    }
    if (!cur) return null;
    if (options?.debugSeeds) console.log("FP gp=" + g.gp.join(",") + " gn=" + g.gn.join(","));

    // fixed start temperature: the landscape is plateaus between penalty
    // cliffs (400–450 per violation); above ~150 the walk is random, and the
    // calibrated start (2000–8000) wasted the first third of every run
    const t0 = options?.schedule?.t0 ?? T_START * (options?.schedule?.t0Scale ?? 1);
    const tEnd = options?.schedule?.tEnd ?? 0.15;
    const coldT = options?.schedule?.coldT ?? 0;
    const cool = Math.pow(tEnd / t0, 1 / movesN);
    let T = t0;
    // time budget: the schedule follows the elapsed share of the budget (or
    // the share of the move cap, whichever is further along), the clock is
    // read every 32 iterations
    const timed = options?.timeBudgetMs !== undefined && options?.moves === undefined && !options?.msPerMoveHint;
    const budgetMs = options?.timeBudgetMs ?? 0;
    const tStart = options?.timeBudgetMs !== undefined ? performance.now() : 0;
    let fTime = 0, f = 0;
    let best = { E: priceFin(cur), g: cloneG(g), d: cur };
    const reportEvery = Math.max(2000, Math.floor(movesN / 20));
    const traceEvery = Math.max(1, Math.floor(movesN / 100));
    let tAcc = 0, tAccUp = 0, tUp = 0, tNull = 0, tInf = 0;
    const ml = options?.moveLog;
    const ad = options?.schedule?.adaptive;
    const tag = ml || ad ? { kind: -1 } : undefined;
    const K = MOVE_KINDS.length;
    const adWin = ad?.window ?? 2000, adFloor = ad?.floor ?? 0.02;
    const BASE_MIX = KIND_BANDS.map(([a, b]) => b - a);
    let adP = BASE_MIX.slice();
    const adN = new Float64Array(K), adG = new Float64Array(K), adY = new Float64Array(K);
    const pickKind = () => { let x = rng(); for (let k = 0; k < K; k++) { x -= adP[k]; if (x < 0) return k; } return K - 1; };
    const rec: MoveLogRec = { it: 0, kind: -1, out: 0, best: 0, same: 0, dEcur: 0, dEfin: 0, curFin: 0, dArea: 0, dWires: 0, dWlen: 0, dCuts: 0, dBcuts: 0, dMess: 0, dHard: 0, dStarv: 0, dOther: 0, dGeo: 0, dOverlap: 0, dStarvH: 0 };
    const sameBoard = (a: Decoded, b: Decoded) => {
      if (a.H !== b.H || a.W !== b.W || a.eBase !== b.eBase || a.hardPen !== b.hardPen) return false;
      for (let i = 0; i < nP; i++) {
        if (a.yI[i] !== b.yI[i] || a.xI[i] !== b.xI[i] || a.geo[i].w !== b.geo[i].w || a.geo[i].h !== b.geo[i].h) return false;
      }
      return true;
    };
    const logMove = (it: number, out: number, e2: Decoded | null, w: number, isBest: boolean) => {
      rec.it = it; rec.kind = tag!.kind; rec.out = out; rec.best = isBest ? 1 : 0; rec.curFin = priceFin(cur!);
      if (e2) {
        const a = cur!, b = e2;
        const da = a.dbg as Record<string, number>, db = b.dbg as Record<string, number>;
        rec.same = sameBoard(a, b) ? 1 : 0;
        rec.dEcur = price(b, w) - price(a, w);
        rec.dEfin = priceFin(b) - priceFin(a);
        rec.dArea = b.H * b.W - a.H * a.W;
        rec.dWires = db.wires - da.wires;
        rec.dWlen = db.wireLen - da.wireLen;
        rec.dCuts = db.cuts - da.cuts;
        rec.dBcuts = db.bCuts - da.bCuts;
        rec.dMess = b.slants + b.crossings - a.slants - a.crossings;
        rec.dHard = b.hardPen - a.hardPen;
        rec.dStarv = db.starved - da.starved;
        rec.dGeo = db.geoBad - da.geoBad;
        rec.dOverlap = db.overlapBad - da.overlapBad;
        rec.dStarvH = db.starvedHard - da.starvedHard;
        rec.dOther = b.eBase - a.eBase - (W_AREA * rec.dArea + W_WIRE * rec.dWires + W_WLEN * rec.dWlen + W_CUT * rec.dCuts + wBCut * rec.dBcuts + rec.dHard + 20 * rec.dStarv);
      } else {
        rec.same = 0; rec.dEcur = rec.dEfin = 0;
        rec.dArea = rec.dWires = rec.dWlen = rec.dCuts = rec.dBcuts = rec.dMess = rec.dHard = rec.dStarv = rec.dOther = rec.dGeo = rec.dOverlap = rec.dStarvH = 0;
      }
      ml!(rec);
    };
    let it = 0;
    for (; it < movesN; it++) {
      let itV = it;
      if (timed) {
        if ((it & 31) === 0) fTime = (performance.now() - tStart) / budgetMs;
        f = Math.max(it / movesN, fTime);
        if (f >= 1 && it >= 40000) break;
        if (f >= 1) f = 1;
        T = t0 * Math.pow(tEnd / t0, f);
        itV = f * movesN;
      } else T *= cool;
      if (it % reportEvery === 0) report("arrange", (options?.seedIndex !== undefined ? (timed ? f : it / movesN) : (seedPos + (timed ? f : it / movesN)) / seedsN));
      if (options?.trace && it % traceEvery === 0) {
        options.trace({ seed, it, T, w: wOf(itV), cur: price(cur, wOf(it)), best: best.E, curFin: priceFin(cur), acc: tAcc, accUp: tAccUp, up: tUp, nulls: tNull, infeasible: tInf, H: cur.H, W: cur.W });
        tAcc = tAccUp = tUp = tNull = tInf = 0;
      }
      let g2: Genome | null = null;
      for (let tries = 0; tries < 50; tries++) {
        g2 = mutate(g, rng, T < coldT, tag, ad ? pickKind() : undefined);
        if (g2 || !lean) break;
      }
      if (!g2) { tNull++; if (ml) logMove(it, 0, null, 0, false); continue; }
      const e2 = decode(g2);
      if (!e2) { tInf++; if (ml) logMove(it, 1, null, 0, false); continue; }
      const w = wOf(itV);
      hardScale = hardOf(itV);
      const dE = price(e2, w) - price(cur, w);
      if (dE > 0) tUp++;
      const accepted = dE <= 0 || rng() < Math.exp(-dE / T);
      if (ad && tag!.kind >= 0) {
        adN[tag!.kind]++;
        if (accepted && dE < 0) adG[tag!.kind] -= dE;
        if (it % adWin === adWin - 1) {
          let sum = 0;
          for (let k = 0; k < K; k++) { adY[k] = 0.5 * adY[k] + 0.5 * adG[k] / Math.max(1, adN[k]); sum += adY[k]; adN[k] = adG[k] = 0; }
          if (sum > 0) adP = adY.map((y) => adFloor + (1 - K * adFloor) * y / sum) as unknown as number[];
          else adP = BASE_MIX.slice();
        }
      }
      if (accepted) {
        tAcc++;
        if (dE > 0) tAccUp++;
        const eFin = priceFin(e2);
        const isBest = eFin < best.E;
        if (ml) logMove(it, 3, e2, w, isBest);
        g = g2;
        cur = e2;
        if (isBest) best = { E: eFin, g: cloneG(g2), d: e2 };
      } else if (ml) logMove(it, 2, e2, w, false);
    }
    if (options?.timeBudgetMs !== undefined) options.onBudget?.({ moves: it, cap: capMoves, msPerMove: (performance.now() - tStart) / Math.max(1, it) });
    if (options?.probe) options.probe({ seed, best, decode, mutate, initGenome, cloneG, price: (d: Decoded) => priceFin(d), t0, W_MESS } as unknown as LandscapeProbe);
    return best;
  }

  // ── finalize through the real completion pipeline ──
  const hasLocked = parts.some((p) => p.locked);
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

  function finalize(bestG: Genome, d: Decoded) {
    // decoded coordinates first; the routing room around the skeleton is
    // added below (padAroundEdgeConnectors), none under locked parts or a
    // locked dimension
    const dRow = 0, dCol = 0;
    const padRows = hasLocked || lockedRowsCap !== undefined ? 0 : 1;
    const padCols = hasLocked || lockedColsCap !== undefined ? 0 : 1;
    const comps0: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0 as Rot }));
    const byId = new Map(comps0.map((c) => [c.id, c]));
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      const c = byId.get(p.comp.id)!;
      if (p.kind === "rigid") {
        const sh = d.geo[pi].sh!;
        c.boardPos = { row: d.yI[pi] - sh.dRow + dRow, col: d.xI[pi] - sh.dCol + dCol };
        c.rotation = rotOfPart(bestG, pi);
        if (p.locked) {
          c.boardPos = p.comp.boardPos;
          c.rotation = p.comp.rotation;
          c.locked = true;
        }
      } else if (d.geo[pi].mode === "H") {
        const brBit = flexBit(bestG.br, pi);
        const x1 = d.xI[pi] + dCol, x2 = d.xI[pi] + (p as FlexPart).dc0 + dCol;
        c.boardPos = { row: d.yI[pi] + dRow, col: brBit === 0 ? x1 : x2 };
        c.flexibleEndPos = { row: d.yI[pi] + dRow, col: brBit === 0 ? x2 : x1 };
      } else {
        const brBit = flexBit(bestG.br, pi);
        const t = d.yI[pi] + dRow, b = d.yI[d.vBot.get(pi)!] + dRow;
        c.boardPos = { row: brBit === 0 ? t : b, col: d.xI[pi] + dCol };
        c.flexibleEndPos = { row: brBit === 0 ? b : t, col: d.xI[pi] + dCol };
      }
    }
    const padded = padAroundEdgeConnectors(comps0, componentDefs, d.H, d.W, { top: padRows, bottom: padRows, left: padCols, right: 2 * padCols }, d.marginUsed);
    const comps = padded.comps;
    const H = lockedRowsCap !== undefined ? Math.max(padded.rows, lockedRowsCap) : padded.rows;
    const W = lockedColsCap !== undefined ? Math.max(padded.cols, lockedColsCap) : padded.cols;
    const routeBoard: Board = { ...board, rows: H, cols: W, cuts: [], wires: [] };
    const movedIds = new Set(parts.map((p) => p.comp.id));
    const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, options?.drilledCutsOnly ?? false, true, options?.noWireStacking ?? false);
    chooser.route(comps, H, W, movedIds);
    chooser.freezePool();
    const pushFin = (msg: string) => {
      const c = chooser.chosen;
      if (!c) return;
      labFinFrames.push({ stage: 7, msg, board: labFinBoard(c.virtual, c.rows, c.cols, c.plan.cuts, c.plan.wires) });
    };
    if (labFin) {
      const c = chooser.chosen!;
      const full = labFinBoard(c.virtual, c.rows, c.cols, c.plan.cuts, c.plan.wires);
      const nWires = full.wires.length;
      const knives = c.plan.cuts.filter((k) => k.kind !== "hole").length;
      labFinFrames.push({ stage: 7, msg: `The editor's own router starts over from the same components. First it buys routing room: a blank line on each side and two on the right, except where such a line would push a connector off the rim, in which case it goes just inside that connector, or is left out where nothing fits. Then the cuts: ${full.cuts.length}${knives === 0 ? ", every one of them a drilled-out spare hole" : `, ${knives} of them cut with a knife between two holes`}.`, board: { ...full, wires: [] } });
      full.wires.forEach((w, k) => {
        const name = w.net >= 0 ? nets[w.net]?.name ?? "A net" : "A net";
        const how = w.c1 === w.c2
          ? `straight down column ${w.c1 + 1}, from row ${Math.min(w.r1, w.r2) + 1} to row ${Math.max(w.r1, w.r2) + 1}`
          : w.r1 === w.r2 ? `along row ${w.r1 + 1}, from column ${Math.min(w.c1, w.c2) + 1} to column ${Math.max(w.c1, w.c2) + 1}` : `slanted, from row ${w.r1 + 1} column ${w.c1 + 1} to row ${w.r2 + 1} column ${w.c2 + 1}`;
        labFinFrames.push({ stage: 7, msg: `${name}: wire ${k + 1} of ${nWires}, ${how}.${k === 0 ? " Each wire is the shortest straight link between two free holes of its net that lies on no other wire and crosses no component." : ""}`, board: { ...full, wires: full.wires.slice(0, k + 1), hlNet: w.net >= 0 ? w.net : undefined } });
      });
      labFinFrames.push({ stage: 7, msg: `Every net is joined and no wire lies on another. ${c.mess === 0 ? "Nothing is messy" : `${c.mess} wire${c.mess === 1 ? " is" : "s are"} still slanted, crossing or stacked`}.`, board: full });
    }
    const netOfPin = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));
    const c0 = chooser.chosen!;
    const anyLock = lockedColsCap !== undefined || lockedRowsCap !== undefined;
    if (c0.bad === 0 && !anyLock) {
      // under a locked dimension the board is a physical given: the harvest
      // would only drag edge-flush parts inward for no gain
      const full = compactPlacements(c0.virtual, componentDefs, netOfPin, c0.rows, c0.cols);
      if (full.removals > 0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds);
      if (labFin && chooser.chosen !== c0) pushFin(`Lines that carry nothing are squeezed out and the board is routed again: ${full.removals} line${full.removals === 1 ? "" : "s"} gone.`);
    }
    // hard zero-mess rule: buy bus rows and channel columns until every
    // wire is vertical and crosses nothing; a locked dimension cannot grow
    // and locked parts must not shift, so under those the mess may remain
    const cCh = chooser.chosen!;
    if (chooser.chosen!.bad === 0 && !hasLocked) {
      insertWireChannels(chooser, componentDefs, {
        ...(lockedRowsCap !== undefined ? { maxRows: lockedRowsCap } : {}),
        ...(lockedColsCap !== undefined ? { maxCols: lockedColsCap } : {}),
      }, false, true);
    }
    if (labFin && chooser.chosen !== cCh) pushFin("Wherever a wire would still have to slant, cross something or lie on another wire, the finish buys a blank row or column at the best place it can find and routes again, as often as it takes. That is what a straight, crossing-free board costs in area.");
    const cSl = chooser.chosen!;
    if (chooser.chosen!.bad === 0) repairSlantWires(chooser, routeBoard, componentDefs, netAssignments, new Set());
    if (labFin && chooser.chosen !== cSl) pushFin("A last look at each wire that is not yet straight: the router tries to give it a column of its own by shifting what stands in the way.");
    // a line that carries nothing, or nothing but wires, is blank board the
    // user would buy: a channel the router did not use in the end, a wire
    // that would fit a column next to a part just as well, a connector
    // column pushed out by such a wire. Try to free each such line on its
    // own; the router finds the wires another line, and the chooser keeps a
    // try only if the board still routes as cleanly and rates better
    const cFree = chooser.chosen!;
    if (!anyLock && !hasLocked) {
      for (let round = 0; round < 24; round++) {
        const c1 = chooser.chosen!;
        if (c1.bad !== 0 || c1.mess !== 0) break;
        const partRows = new Set<number>(), partCols = new Set<number>();
        for (const c of c1.virtual) {
          if (!c.boardPos || c.boardExcluded) continue;
          const def = resolveComponentDef(c, componentDefs);
          if (!def) continue;
          let r1: number, r2: number, k1: number, k2: number;
          if (def.flexible) {
            const e = c.flexibleEndPos ?? c.boardPos;
            r1 = Math.min(c.boardPos.row, e.row); r2 = Math.max(c.boardPos.row, e.row);
            k1 = Math.min(c.boardPos.col, e.col); k2 = Math.max(c.boardPos.col, e.col);
          } else {
            const b = getComponentBounds(def, c.boardPos, c.rotation);
            r1 = b.minRow; r2 = b.maxRow; k1 = b.minCol; k2 = b.maxCol;
          }
          for (let r = r1; r <= r2; r++) partRows.add(r);
          for (let k = k1; k <= k2; k++) partCols.add(k);
        }
        for (const cut of c1.plan.cuts) {
          partRows.add(cut.row);
          partCols.add(cut.col);
          if (cut.kind !== "hole") partCols.add(cut.col + 1);
        }
        const tries: [number, boolean][] = [];
        for (let k = c1.cols - 1; k >= 0; k--) if (!partCols.has(k)) tries.push([k, true]);
        for (let r = c1.rows - 1; r >= 0; r--) if (!partRows.has(r)) tries.push([r, false]);
        let freed = false;
        for (const [line, isCol] of tries) {
          // every other line stays; only this one may go
          const keep = { rows: new Set<number>(), cols: new Set<number>() };
          for (let k = 0; k < c1.cols; k++) if (!isCol || k !== line) keep.cols.add(k);
          for (let r = 0; r < c1.rows; r++) if (isCol || r !== line) keep.rows.add(r);
          const again = compactPlacements(c1.virtual, componentDefs, netOfPin, c1.rows, c1.cols, 1, undefined, keep);
          if (again.removals === 0) continue;
          chooser.route(again.comps, again.rows, again.cols, c1.movedIds);
          if (chooser.chosen !== c1) { freed = true; break; }
        }
        if (!freed) break;
      }
    }
    if (labFin && chooser.chosen !== cFree) pushFin("A line that carries nothing but a wire is board you would have to buy. Each one is offered back to the router on its own, and kept out whenever the wires find another way.");
    const ch = chooser.chosen!;
    const unplaceIds = [
      ...skipped.map((c) => c.id),
      ...components.filter((c) => !c.boardExcluded && !movedIds.has(c.id) && !skipped.some((s) => s.id === c.id)).map((c) => c.id),
    ];
    const issues: string[] = [];
    for (const c of skipped) issues.push(`${c.label ?? c.id} could not be planned`);
    if (ch.plan.unresolvedConflicts > 0) issues.push(`${ch.plan.unresolvedConflicts} strip conflicts remain`);
    if (lockedColsCap !== undefined && ch.cols > lockedColsCap) issues.push(`does not fit the locked ${lockedColsCap} columns (needs ${ch.cols})`);
    if (lockedRowsCap !== undefined && ch.rows > lockedRowsCap) issues.push(`does not fit the locked ${lockedRowsCap} rows (needs ${ch.rows})`);
    const stacked = options?.noWireStacking
      ? ch.plan.wires.filter((w, i) => wireStackDepth(w.from, w.to, ch.plan.wires.slice(0, i)) > 0).length
      : 0;
    if (ch.mess - stacked > 0) issues.push(`${ch.mess - stacked} wire${ch.mess - stacked === 1 ? "" : "s"} could not be made straight and crossing-free`);
    if (stacked > 0) issues.push(`${stacked} wire${stacked === 1 ? "" : "s"} still run on top of another wire`);
    const result: AutoLayoutResult = {
      placements: ch.virtual
        .filter((c) => movedIds.has(c.id) && c.boardPos)
        .map((c) => {
          const def = resolveComponentDef(c, componentDefs)!;
          return def.flexible
            ? { componentId: c.id, boardPos: c.boardPos!, flexibleEndPos: c.flexibleEndPos }
            : { componentId: c.id, boardPos: c.boardPos!, rotation: c.rotation };
        }),
      cuts: ch.plan.cuts,
      wires: ch.plan.wires,
      issues,
      quality: ch.plan.unresolvedConflicts * 100 + ch.plan.starvedNetIds.length + skipped.length * 2,
      starvedNetIds: ch.plan.starvedNetIds,
      boardSize: { rows: ch.rows, cols: ch.cols },
      unplaceIds,
    };
    let final: AutoLayoutResult;
    if (anyLock) {
      // locked dimensions come back EXACTLY as locked (the physical board);
      // only the free dimension is trimmed, and nothing is shifted
      let maxR = 0, maxC = 0, minR = Infinity, minC = Infinity;
      const see = (r: number, c: number) => {
        maxR = Math.max(maxR, r);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        minC = Math.min(minC, c);
      };
      for (const c of ch.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const e = c.flexibleEndPos ?? c.boardPos;
          see(c.boardPos.row, c.boardPos.col);
          see(e.row, e.col);
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          see(b.minRow, b.minCol);
          see(b.maxRow, b.maxCol);
        }
      }
      for (const cut of ch.plan.cuts) see(cut.row, cut.col);
      for (const w of ch.plan.wires) {
        see(w.from.row, w.from.col);
        see(w.to.row, w.to.col);
      }
      if (!isFinite(minR)) { minR = 0; minC = 0; }
      // shift leading emptiness out of the FREE dimension only: the locked
      // dimension's frame is the physical board (shifting columns under a
      // locked width would drag edge-flush connectors off the rim), and
      // locked parts pin everything absolutely
      const shiftR = !hasLocked && lockedRowsCap === undefined ? minR : 0;
      const shiftC = !hasLocked && lockedColsCap === undefined ? minC : 0;
      if (shiftR > 0 || shiftC > 0) {
        const mv = (p: BoardPosition): BoardPosition => ({ row: p.row - shiftR, col: p.col - shiftC });
        result.placements = result.placements.map((pl) => ({
          ...pl, boardPos: mv(pl.boardPos),
          ...(pl.flexibleEndPos ? { flexibleEndPos: mv(pl.flexibleEndPos) } : {}),
        }));
        result.cuts = result.cuts.map((cut) => ({ ...cut, row: cut.row - shiftR, col: cut.col - shiftC }));
        result.wires = result.wires.map((w) => ({ from: mv(w.from), to: mv(w.to) }));
      }
      const rows = lockedRowsCap !== undefined ? Math.max(lockedRowsCap, maxR + 1) : maxR - shiftR + 1;
      const cols = lockedColsCap !== undefined ? Math.max(lockedColsCap, maxC + 1) : maxC - shiftC + 1;
      final = { ...result, boardSize: { rows, cols } };
    } else {
      const trimmed = trimResult(result, routeBoard, ch.virtual, componentDefs, hasLocked);
      final = { ...result, ...trimmed };
    }
    // purely visual: line the cuts up on shared columns (v2 does the same)
    if (final.quality === 0) {
      final = alignCuts(final, routeBoard, components, componentDefs);
      if (options?.drilledCutsOnly && final.boardSize) {
        // alignment may have slid a stuck knife cut next to a drillable hole
        const byPl = new Map(final.placements.map((p) => [p.componentId, p]));
        const virtual = components.map((c) => {
          const p = byPl.get(c.id);
          return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
        });
        const vBoard: Board = { ...board, rows: final.boardSize.rows, cols: final.boardSize.cols, cuts: [], wires: [] };
        final = { ...final, cuts: drillRemainingCuts(vBoard, virtual, componentDefs, netAssignments, final.cuts, final.wires) };
      }
    }
    if (labFin && final.boardSize) {
      const byPl2 = new Map(final.placements.map((pl) => [pl.componentId, pl]));
      const virt = components.map((c) => {
        const pl = byPl2.get(c.id);
        return pl ? { ...c, boardPos: pl.boardPos, rotation: pl.rotation ?? c.rotation, flexibleEndPos: pl.flexibleEndPos } : c;
      });
      const knives = final.cuts.filter((k) => k.kind !== "hole").length;
      labFinFrames.push({
        stage: 7,
        msg: `The board is trimmed to what it uses, and every cut that can be is turned into a drilled hole rather than a knife stroke between two holes, then lined up with the others in one column where possible. ${final.boardSize.rows} by ${final.boardSize.cols}, ${final.wires.length} link wire${final.wires.length === 1 ? "" : "s"}, ${final.cuts.length} cut${final.cuts.length === 1 ? "" : "s"}${knives ? `, ${knives} of them with a knife` : ", none of them with a knife"}. This is the board you get.`,
        board: labFinBoard(virt, final.boardSize.rows, final.boardSize.cols, final.cuts, final.wires),
      });
    }
    const rate = rateResult(result, routeBoard, ch.virtual, componentDefs, options?.drilledCutsOnly ?? false);
    const offAxis = final.wires.filter((w) => w.from.col !== w.to.col).length;
    const crossings = wireMessScore(final, comps, componentDefs).crossings;
    const overCap =
      (lockedColsCap !== undefined ? Math.max(0, (final.boardSize?.cols ?? 0) - lockedColsCap) : 0) +
      (lockedRowsCap !== undefined ? Math.max(0, (final.boardSize?.rows ?? 0) - lockedRowsCap) : 0);
    const score = (final.quality + overCap * 40) * 1e9 + (offAxis + crossings) * 1e4 + rate;
    return { final, score };
  }

  // ── lab: hand everything to the explainer and stop ──
  if (options?.lab) {
    const labDecode = (g: Genome, mode: 1 | 2) => {
      labMode = mode;
      labFrames = [];
      labBoardOut = null;
      const d = decode(g);
      const frames = labFrames, board = labBoardOut as LabBoard | null;
      labMode = 0;
      labFrames = [];
      labBoardOut = null;
      const dg = (d?.dbg ?? {}) as unknown as Record<string, number>;
      const ld: LabDecoded | null = d && board ? { eBase: d.eBase, hard: d.hardPen, mess: d.slants + d.crossings, H: d.H, W: d.W, board, wires: dg.wires, wireLen: dg.wireLen, cuts: dg.cuts, bCuts: dg.bCuts, starved: dg.starvedHard, relays: dg.relays, connEdge: dg.connEdge } : null;
      return { d: ld, frames, g };
    };
    const labFinish: LabApi["finish"] = (g) => {
      const g2 = cloneG(g as Genome);
      labMode = 1;
      labFrames = [];
      labBoardOut = null;
      const d = decode(g2);
      const start = labBoardOut as LabBoard | null;
      labMode = 0;
      labFrames = [];
      labBoardOut = null;
      if (!d || !start) return [];
      labFin = true;
      labFinFrames = [{ stage: 7, msg: "What the annealer hands over: the board its decoder scored. It is complete, but the decoder is a fast approximation, so nothing about its cuts and wires is final.", board: start }];
      try {
        finalize(g2, d);
      } finally {
        labFin = false;
      }
      const out = labFinFrames;
      labFinFrames = [];
      return out;
    };
    const labRun: LabApi["run"] = (seed, movesN2, every, cb) => {
      const rng = mulberry32((seed + 1) * 0x9e3779b9);
      const wOf = (it: number) => Math.min(W_MESS, RAMP_START * Math.pow(W_MESS / RAMP_START, it / movesN2));
      const price = (d: LabDecoded, w: number) => d.eBase + w * d.mess;
      let g = initGenome(rng);
      let cur = labDecode(g, 1);
      let tries = 0;
      while (!cur.d && tries++ < 50) { g = initGenome(rng); cur = labDecode(g, 1); }
      if (!cur.d) return;
      g = cur.g;
      const cool = Math.pow(0.15 / T_START, 1 / movesN2);
      let T = T_START;
      let best = { E: price(cur.d, W_MESS), g: cloneG(g), d: cur.d };
      for (let it = 0; it < movesN2; it++) {
        T *= cool;
        const w = wOf(it);
        const g2 = mutate(g, rng, false);
        let kind: LabStep["kind"] = "null";
        if (g2) {
          const r2 = labDecode(g2, 1);
          if (!r2.d) kind = "infeasible";
          else {
            const dE = price(r2.d, w) - price(cur.d!, w);
            if (dE <= 0 || rng() < Math.exp(-dE / T)) {
              kind = dE <= 0 ? "better" : "worse-kept";
              g = r2.g;
              cur = r2;
              const eFin = price(r2.d, W_MESS);
              if (eFin < best.E) best = { E: eFin, g: cloneG(g), d: r2.d };
            } else kind = "worse-rejected";
          }
        }
        if ((it + 1) % every === 0 || it === movesN2 - 1) cb({ it: it + 1, moves: movesN2, T, w, g, d: cur.d!, E: price(cur.d!, w), best: best.E, bestG: best.g, bestD: best.d, kind, done: it === movesN2 - 1 });
      }
    };
    options.lab({
      parts: parts.map((p) => ({ id: p.comp.label, comp: p.comp, kind: p.kind, isConn: p.isConn, canH: p.kind === "flex" ? p.canH : false, canV: p.kind === "flex" ? p.canV : false, spans: p.kind === "flex" ? [p.minS, p.maxS] : [0, 0], pinNames: p.kind === "rigid" ? p.def.pins.map((q) => q.name) : ["1", "2"] })),
      nets: nets.map((n, ni) => ({ name: n.name, color: n.color, pins: netPins[ni].map((q) => ({ pi: q.pi, name: pinNameOf(q.pi, q.pinId, q.end) })) })),
      rigidIdx, flexIdx, initGenome, cloneG,
      mutate: (g, rng) => mutate(g, rng, false),
      decode: (g, frames = true) => labDecode(g, frames ? 2 : 1),
      run: labRun,
      finish: labFinish,
      W_MESS, RAMP_START, T_START,
    });
    return emptyResult([]);
  }

  // ── run the portfolio ──
  const seedBests: { E: number; g: Genome; d: Decoded }[] = [];
  const seedList = options?.seedIndex !== undefined ? [options.seedIndex] : [...Array(seedsN).keys()].map((k) => k + (options?.seedBase ?? 0));
  for (const [pos, seed] of seedList.entries()) {
    const r = solveSeed(seed, pos);
    if (r) seedBests.push(r);
    if (r && options?.debugSeeds) {
      console.log(`[v5 seed ${seed}] E ${r.E.toFixed(1)} decoded ${r.d.H}x${r.d.W}`, JSON.stringify(r.d.dbg));
    }
  }
  if (seedBests.length === 0) return emptyResult(["auto-layout found no feasible arrangement"]);
  seedBests.sort((a, b) => a.E - b.E);
  let bestFin: { final: AutoLayoutResult; score: number } | null = null;
  const finalists = seedBests.slice(0, 4);
  finalists.forEach((r, i) => {
    report("place", i / finalists.length);
    const f = finalize(r.g, r.d);
    if (!bestFin || f.score < bestFin.score) bestFin = f;
  });
  report("place", 1);
  return bestFin!.final;
}
