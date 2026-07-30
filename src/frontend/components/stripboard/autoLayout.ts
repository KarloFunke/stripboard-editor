import {
  Board,
  BoardPosition,
  Component,
  ComponentDef,
  Cut,
  Net,
  NetAssignment,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  getComponentBounds,
  getComponentPinPositions,
  getFlexiblePinPositions,
  getRotatedBodyCells,
  getRotatedPinPositions,
} from "./boardLayout";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { checkNetCompleteness } from "./netCompleteness";
import { deriveCompletion } from "./autoFinish";
import { computeAutoPlace, FlexPlacement } from "./autoPlace";
import {
  DIAGONAL_PENALTY,
  FLEXIBLE_CORRIDOR_RADIUS,
  FootprintRect,
  bodyIntersectsRect,
  pointSegmentDistance,
  corridorHoles,
  bodiesTooClose,
  segmentsIntersect,
  spanLimits,
  clearanceOf,
} from "./flexGeometry";

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
}

// One stage-A/stage-B configuration; the retry ladder walks these
export interface AttemptConfig {
  spacing: number;
  bboxWeight: number;
}

export interface AutoLayoutOptions {
  // Subset of the retry ladder to run (parallel callers run one each)
  attempts?: AttemptConfig[];
  // Anneal RNG seed: different seeds explore different arrangements
  seed?: number;
  // Re-layout only these components; everything else stays exactly as it is
  // (cuts and wires are still regenerated for the whole board)
  onlyIds?: string[];
}

// Coarse progress for a UI indicator: `frac` is 0..1 within the current
// attempt (attempts restart it — retries are not predictable up front).
export interface AutoLayoutProgress {
  phase: "arrange" | "place" | "repair";
  attempt: number;
  maxAttempts: number;
  frac: number;
}

interface FlexOptimizeResult {
  placements: FlexPlacement[];
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
  // Nets still starved after all flexible-level repair: fixing these needs
  // rigid moves, which only stage A can do
  starvedNets: string[];
  // Pin positions of the exact strip groups that starved
  starvedPins: BoardPosition[];
}

// ── Cost weights (build effort, lower is better) ───────
const COST_CUT = 1; // cuts are quick work: cheap, so tight strip reuse wins
const COST_WIRE = 6; // strip + 2 joints: pricier than a cut
const COST_WIRE_LEN = 0.5;
const COST_SPAN = 0.2; // flexible pin-to-pin manhattan length
// Overall bounding box (half-perimeter): pulls stray parts and jumpers
// toward the assembly when their nets would allow them anywhere. Kept mild:
// completability beats compactness on crowded boards.
const COST_BBOX = 0.25;
const COST_UNRESOLVED = 1000; // conflicts / failed jumpers: near-hard reject

// ── Search parameters ──────────────────────────────────
const TOP_K = 14; // candidates per part that get the full evaluator
// When every evaluated candidate starves a net (leaves it without a free
// hole to attach a wire), keep evaluating further candidates up to this cap
const MAX_EVALS = 48;
const MAX_PER_ROW_PAIR = 3; // pool diversity: don't let one strip pair crowd out the rest
const MAX_SWEEPS = 4;
const SEARCH_RADIUS = 14; // pin-1 candidates stay this close to the part's nets

interface Movable {
  comp: Component;
  def: ComponentDef;
  netA: string;
  netB: string;
  min: number;
  max: number;
}

interface Placement {
  p1: BoardPosition;
  p2: BoardPosition;
  clr?: number; // the part's extra body clearance (fixed obstacles only)
}

/** Map that counts its mutations, so derived caches know when to refresh */
class VersionedMap<K, V> extends Map<K, V> {
  version = 0;
  set(key: K, value: V): this {
    this.version++;
    return super.set(key, value);
  }
  delete(key: K): boolean {
    this.version++;
    return super.delete(key);
  }
}

function holeKey(row: number, col: number): string {
  return `${row},${col}`;
}

function manhattan(a: BoardPosition, b: BoardPosition): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

// All (dr, dc) offsets whose Euclidean length lies within a span range,
// memoized per range: the candidate enumeration visits them millions of
// times, so the hypot + range check must not run per pair.
const ringCache = new Map<string, [number, number][]>();
function ringOffsets(min: number, max: number): [number, number][] {
  const key = `${min}:${max}`;
  let ring = ringCache.get(key);
  if (!ring) {
    ring = [];
    const s = Math.ceil(max);
    for (let dr = -s; dr <= s; dr++) {
      for (let dc = -s; dc <= s; dc++) {
        const d = Math.hypot(dr, dc);
        if (d >= min - 1e-6 && d <= max + 1e-6) ring.push([dr, dc]);
      }
    }
    ringCache.set(key, ring);
  }
  return ring;
}

/**
 * Stage B: place all unplaced flexible 2-pin parts and derive cuts/wires in
 * one joint optimization. Seed with the greedy placer, then hill-climb by
 * ripping up one part at a time and re-placing it wherever the full
 * completion cost (cuts + jumpers + wire length + spans) is lowest. A pin
 * may land on any strip — the evaluator prices the cuts that make it legal.
 * Placed components are never moved here.
 */
function optimizeFlexibles(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (frac: number, phase: "place" | "repair") => void
): FlexOptimizeResult {
  const issues: string[] = [];

  // ── Movable parts ────────────────────────────────────
  const movables: Movable[] = [];
  for (const comp of components) {
    if (comp.boardPos || comp.boardExcluded || comp.locked) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def || !def.flexible) continue;
    const a = netAssignments.find((x) => x.componentId === comp.id && x.pinId === def.pins[0]?.id);
    const b = netAssignments.find((x) => x.componentId === comp.id && x.pinId === def.pins[1]?.id);
    if (!a || !b) {
      issues.push(`${comp.label}: pins not fully wired in the schematic, skipped`);
      continue;
    }
    movables.push({ comp, def, netA: a.netId, netB: b.netId, ...spanLimits(def) });
  }

  // ── Static occupancy from everything that never moves ──
  const hard = new Set<string>(); // pins, rigid bodies, wire ends: corridor may not cross
  const blocked = new Set<string>(); // + drilled holes, fixed corridors: endpoints only
  const fixedBodies: Placement[] = [];
  const rigidRects: FootprintRect[] = []; // rigid footprints: no flexible body may cross

  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      hard.add(holeKey(pin.row, pin.col));
    }
    if (def.flexible) {
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (p1 && p2) {
        fixedBodies.push({ p1: { row: p1.row, col: p1.col }, p2: { row: p2.row, col: p2.col }, clr: clearanceOf(def) });
        for (const h of corridorHoles(p1, p2)) blocked.add(holeKey(h.row, h.col));
      }
    } else {
      for (const cell of getRotatedBodyCells(def, comp.boardPos, comp.rotation)) {
        hard.add(holeKey(cell.row, cell.col));
      }
      rigidRects.push(getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }
  for (const wire of board.wires) {
    hard.add(holeKey(wire.from.row, wire.from.col));
    hard.add(holeKey(wire.to.row, wire.to.col));
  }
  for (const cut of board.cuts) {
    if (cut.kind === "hole") blocked.add(holeKey(cut.row, cut.col));
  }

  // ── Guarded pins: protect the last free hole of a fixed pin's strip run ──
  // A fixed pin whose net has more pins than its own strip run must receive
  // a jumper (or a same-net movable pin) on that run, and a jumper end needs
  // a free hole there. The run is known up front: bounded by different-net
  // pins (a cut will be forced between), drilled holes and board edges;
  // bodies and corridors only occupy holes, the copper continues underneath.
  // A candidate that swallows the run's last free hole makes the net
  // incompletable — no later cut or wire can fix it.
  interface PinGuard {
    netId: string;
    row: number;
    minCol: number;
    maxCol: number;
    runPins: number; // fixed pins of this net inside the run
    netTotal: number; // the net's total pin count
    free: BoardPosition[];
  }
  const guards: PinGuard[] = [];
  {
    const excludedComp = new Set(components.filter((c) => c.boardExcluded).map((c) => c.id));
    const netTotals = new Map<string, number>();
    for (const a of netAssignments) {
      if (excludedComp.has(a.componentId)) continue;
      netTotals.set(a.netId, (netTotals.get(a.netId) ?? 0) + 1);
    }
    const pinKeyAt = new Map<string, string>();
    const fixedPins: { row: number; col: number; netId: string | null }[] = [];
    for (const comp of components) {
      if (!comp.boardPos || comp.boardExcluded) continue;
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      for (const pin of getComponentPinPositions(comp, def)) {
        const a = netAssignments.find(
          (x) => x.componentId === comp.id && x.pinId === pin.pinId
        );
        pinKeyAt.set(holeKey(pin.row, pin.col), a?.netId ?? `nc:${comp.id}:${pin.pinId}`);
        fixedPins.push({ row: pin.row, col: pin.col, netId: a?.netId ?? null });
      }
    }
    const severed = new Set<string>();
    const drilled = new Set<string>();
    for (const cut of board.cuts) {
      if (cut.kind === "hole") drilled.add(holeKey(cut.row, cut.col));
      else severed.add(`${cut.row}:${cut.col}`);
    }
    const seen = new Set<string>();
    for (const p of fixedPins) {
      if (!p.netId) continue;
      const total = netTotals.get(p.netId) ?? 0;
      if (total < 2) continue;
      let minCol = p.col, maxCol = p.col, runPins = 1;
      const free: BoardPosition[] = [];
      for (const dir of [-1, 1] as const) {
        for (let col = p.col + dir; col >= 0 && col < board.cols; col += dir) {
          if (severed.has(`${p.row}:${Math.min(col, col - dir)}`)) break;
          const k = holeKey(p.row, col);
          if (drilled.has(k)) break;
          const pk = pinKeyAt.get(k);
          if (pk !== undefined) {
            if (pk !== p.netId) break;
            runPins++;
          } else if (!hard.has(k) && !blocked.has(k)) {
            free.push({ row: p.row, col });
          }
          if (col < minCol) minCol = col;
          if (col > maxCol) maxCol = col;
        }
      }
      if (total <= runPins) continue; // the run alone completes the net
      const id = `${p.netId}:${p.row}:${minCol}`;
      if (seen.has(id)) continue;
      seen.add(id);
      guards.push({ netId: p.netId, row: p.row, minCol, maxCol, runPins, netTotal: total, free });
    }
  }

  // ── Current solution state ───────────────────────────
  const pos = new VersionedMap<string, Placement>();
  const seed = computeAutoPlace(board, components, componentDefs, netAssignments);
  for (const p of seed.placements) {
    pos.set(p.componentId, { p1: p.boardPos, p2: p.flexibleEndPos });
  }

  // Net of every assigned pin, for the hot lookups below
  const assignedNetOf = new Map<string, string>();
  for (const a of netAssignments) {
    assignedNetOf.set(`${a.componentId}:${a.pinId}`, a.netId);
  }

  const virtualComponents = (): Component[] =>
    components.map((c) => {
      const p = pos.get(c.id);
      return p ? { ...c, boardPos: p.p1, flexibleEndPos: p.p2 } : c;
    });

  // Static extent of everything already placed (rigids and fixed flexibles);
  // movable parts and wires extend it per evaluation.
  const staticExtent = { minR: Infinity, maxR: -Infinity, minC: Infinity, maxC: -Infinity };
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      staticExtent.minR = Math.min(staticExtent.minR, pin.row);
      staticExtent.maxR = Math.max(staticExtent.maxR, pin.row);
      staticExtent.minC = Math.min(staticExtent.minC, pin.col);
      staticExtent.maxC = Math.max(staticExtent.maxC, pin.col);
    }
  }

  // ── Full evaluator: run the router, price the completion ──
  // `problems` counts unresolved conflicts and issues (starved nets etc.);
  // `bad` = any problem — never settle for those when avoidable.
  const fullCost = (): { cost: number; bad: boolean; problems: number; starvedNets: string[] } => {
    const plan = deriveCompletion(board, virtualComponents(), componentDefs, nets, netAssignments);
    let cost =
      plan.cuts.length * COST_CUT +
      plan.wires.length * COST_WIRE +
      // Messy wires (long off-axis runs, crossings over components) are
      // priced like extra wire length, so placements that allow tidy
      // wiring win over ones that force ugly jumpers
      plan.wireMess * COST_WIRE_LEN +
      (plan.unresolvedConflicts + plan.issues.length) * COST_UNRESOLVED;
    const ext = { ...staticExtent };
    const extend = (p: BoardPosition) => {
      ext.minR = Math.min(ext.minR, p.row);
      ext.maxR = Math.max(ext.maxR, p.row);
      ext.minC = Math.min(ext.minC, p.col);
      ext.maxC = Math.max(ext.maxC, p.col);
    };
    for (const w of plan.wires) {
      cost += COST_WIRE_LEN * Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
      extend(w.from);
      extend(w.to);
    }
    for (const p of pos.values()) {
      cost += COST_SPAN * manhattan(p.p1, p.p2);
      if (p.p1.row !== p.p2.row && p.p1.col !== p.p2.col) cost += DIAGONAL_PENALTY;
      extend(p.p1);
      extend(p.p2);
    }
    if (ext.minR !== Infinity) {
      cost += COST_BBOX * (ext.maxR - ext.minR + (ext.maxC - ext.minC));
    }
    const problems = plan.unresolvedConflicts + plan.issues.length;
    return {
      cost,
      bad: problems > 0,
      problems,
      starvedNets: plan.starvedNetIds,
    };
  };

  // ── Cheap ranking evaluator for candidate placements ──
  // Routing the whole board per candidate is what made the anneal slow:
  // a candidate only moves ONE part, so only its two nets can route
  // differently. Route just those (deriveCompletion evalNets mode) and
  // price the other nets from a baseline captured once per part. The
  // baseline ignores the candidate's exact pins, so this ranks rather
  // than measures — the chosen winner is re-measured with fullCost().
  interface EvalBase {
    wireCost: number; // other nets: wires, mess, lengths
    starved: number;
    ext: { minR: number; maxR: number; minC: number; maxC: number };
  }
  const captureEvalBase = (partNets: Set<string>): EvalBase => {
    const others = new Set(nets.filter((n) => !partNets.has(n.id)).map((n) => n.id));
    const plan = deriveCompletion(board, virtualComponents(), componentDefs, nets, netAssignments, { evalNets: others });
    let wireCost = plan.wires.length * COST_WIRE + plan.wireMess * COST_WIRE_LEN;
    const ext = { ...staticExtent };
    for (const w of plan.wires) {
      wireCost += COST_WIRE_LEN * Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
      for (const p of [w.from, w.to]) {
        ext.minR = Math.min(ext.minR, p.row);
        ext.maxR = Math.max(ext.maxR, p.row);
        ext.minC = Math.min(ext.minC, p.col);
        ext.maxC = Math.max(ext.maxC, p.col);
      }
    }
    return { wireCost, starved: plan.starvedNetIds.length, ext };
  };
  const evalCost = (partNets: Set<string>, base: EvalBase): { cost: number; bad: boolean; problems: number } => {
    const plan = deriveCompletion(board, virtualComponents(), componentDefs, nets, netAssignments, { evalNets: partNets });
    // cuts and cut issues are derived globally even in eval mode, so they
    // come from this call; the baseline contributes only wire terms
    let cost =
      base.wireCost +
      plan.cuts.length * COST_CUT +
      plan.wires.length * COST_WIRE +
      plan.wireMess * COST_WIRE_LEN +
      (plan.unresolvedConflicts + plan.issues.length + base.starved) * COST_UNRESOLVED;
    const ext = { ...base.ext };
    const extend = (p: BoardPosition) => {
      ext.minR = Math.min(ext.minR, p.row);
      ext.maxR = Math.max(ext.maxR, p.row);
      ext.minC = Math.min(ext.minC, p.col);
      ext.maxC = Math.max(ext.maxC, p.col);
    };
    for (const w of plan.wires) {
      cost += COST_WIRE_LEN * Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
      extend(w.from);
      extend(w.to);
    }
    for (const p of pos.values()) {
      cost += COST_SPAN * manhattan(p.p1, p.p2);
      if (p.p1.row !== p.p2.row && p.p1.col !== p.p2.col) cost += DIAGONAL_PENALTY;
      extend(p.p1);
      extend(p.p2);
    }
    if (ext.minR !== Infinity) {
      cost += COST_BBOX * (ext.maxR - ext.minR + (ext.maxC - ext.minC));
    }
    const problems = plan.unresolvedConflicts + plan.issues.length + base.starved;
    return { cost, bad: problems > 0, problems };
  };

  // ── Geometric validity of a candidate against everything else ──
  const clrById = new Map<string, number>();
  for (const m of movables) clrById.set(m.comp.id, clearanceOf(m.def));
  const isValid = (selfId: string, p1: BoardPosition, p2: BoardPosition): boolean => {
    const selfClr = clrById.get(selfId) ?? 0;
    for (const rect of rigidRects) {
      if (bodyIntersectsRect(p1, p2, rect, selfClr)) return false;
    }
    for (const h of corridorHoles(p1, p2)) {
      if (h.row === p1.row && h.col === p1.col) continue;
      if (h.row === p2.row && h.col === p2.col) continue;
      if (hard.has(holeKey(h.row, h.col))) return false;
    }
    const clashes = (other: Placement, otherClr: number): boolean =>
      segmentsIntersect(p1, p2, other.p1, other.p2) ||
      bodiesTooClose(p1, p2, other.p1, other.p2, selfClr + otherClr) ||
      // endpoints inside the other's corridor and vice versa
      pointSegmentDistance(p1, other.p1, other.p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(p2, other.p1, other.p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(other.p1, p1, p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(other.p2, p1, p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6;

    for (const body of fixedBodies) {
      if (clashes(body, body.clr ?? 0)) return false;
    }
    for (const [id, p] of pos) {
      if (id !== selfId && clashes(p, clrById.get(id) ?? 0)) return false;
    }
    return true;
  };

  // Holes covered by the placed movables' corridors, cached against the
  // position map's version: endpointFree runs for every board hole during
  // pool building, so a per-hole distance scan over all parts is too slow.
  // corridorHoles uses the same distance predicate, so this is equivalent.
  let posBlockedVersion = -1;
  const posBlocked = new Set<string>();
  const posBlockedNow = (): Set<string> => {
    if (posBlockedVersion !== pos.version) {
      posBlocked.clear();
      for (const p of pos.values()) {
        for (const h of corridorHoles(p.p1, p.p2)) posBlocked.add(holeKey(h.row, h.col));
      }
      posBlockedVersion = pos.version;
    }
    return posBlocked;
  };

  const endpointFree = (row: number, col: number): boolean => {
    if (row < 0 || row >= board.rows || col < 0 || col >= board.cols) return false;
    const k = holeKey(row, col);
    return !hard.has(k) && !blocked.has(k) && !posBlockedNow().has(k);
  };

  // Would this candidate swallow a guarded run's last free hole? Exception:
  // when the candidate's own pin joins the run and thereby completes the
  // net, no jumper is needed there and the run may fill up (e.g. a diode
  // pin directly beside the IC pin it connects to).
  const movableById = new Map(movables.map((mm) => [mm.comp.id, mm]));
  const violatesGuard = (
    selfId: string,
    netA: string,
    netB: string,
    p1: BoardPosition,
    p2: BoardPosition
  ): boolean => {
    if (guards.length === 0) return false;
    const consumed = new Set<string>([holeKey(p1.row, p1.col), holeKey(p2.row, p2.col)]);
    for (const h of corridorHoles(p1, p2)) consumed.add(holeKey(h.row, h.col));
    for (const g of guards) {
      let touches = false;
      for (const h of g.free) {
        if (consumed.has(holeKey(h.row, h.col))) {
          touches = true;
          break;
        }
      }
      if (!touches) continue;
      const inRun = (p: BoardPosition, netId: string): boolean =>
        netId === g.netId && p.row === g.row && p.col >= g.minCol && p.col <= g.maxCol;
      let pins = g.runPins + (inRun(p1, netA) ? 1 : 0) + (inRun(p2, netB) ? 1 : 0);
      for (const [id, pl] of pos) {
        if (id === selfId) continue;
        const om = movableById.get(id);
        if (!om) continue;
        if (inRun(pl.p1, om.netA)) pins++;
        if (inRun(pl.p2, om.netB)) pins++;
      }
      if (g.netTotal <= pins) continue;
      let hasFree = false;
      for (const h of g.free) {
        if (consumed.has(holeKey(h.row, h.col))) continue;
        if (!endpointFree(h.row, h.col)) continue;
        hasFree = true;
        break;
      }
      if (!hasFree) return true;
    }
    return false;
  };

  // ── Cheap candidate score: distance to the nets' copper ──
  // Strips carrying each net, from the current virtual layout (part ripped
  // out). A segment only counts as a net's copper when it carries that net
  // alone — a contested segment will be cut up, so of it only the net's own
  // pin holes are a safe landing area.
  const netStripsFor = (): Map<string, { row: number; startCol: number; endCol: number }[]> => {
    const virtual = virtualComponents();
    const segments = computeStripSegments(board, virtual, componentDefs, netAssignments);
    const map = new Map<string, { row: number; startCol: number; endCol: number }[]>();
    const add = (netId: string, row: number, startCol: number, endCol: number) => {
      if (!map.has(netId)) map.set(netId, []);
      map.get(netId)!.push({ row, startCol, endCol });
    };
    for (const seg of segments) {
      if (seg.netIds.length === 1) add(seg.netIds[0], seg.row, seg.startCol, seg.endCol);
    }
    for (const comp of virtual) {
      if (!comp.boardPos || comp.boardExcluded) continue;
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      for (const pin of getComponentPinPositions(comp, def)) {
        const netId = assignedNetOf.get(`${comp.id}:${pin.pinId}`);
        if (netId !== undefined) add(netId, pin.row, pin.col, pin.col);
      }
    }
    return map;
  };

  const distToNet = (
    strips: Map<string, { row: number; startCol: number; endCol: number }[]>,
    h: BoardPosition,
    netId: string
  ): number => {
    let best = Infinity;
    for (const s of strips.get(netId) ?? []) {
      const dc = h.col < s.startCol ? s.startCol - h.col : h.col > s.endCol ? h.col - s.endCol : 0;
      best = Math.min(best, Math.hypot(h.row - s.row, dc));
    }
    return best;
  };

  // Estimated extra cost of landing a pin off its net (jumper-ish)
  const offNetCost = (d: number): number => (d === 0 ? 0 : 3 + 0.5 * d);

  // How far a hole would stretch the assembly's current extent — the cheap
  // counterpart of the bbox cost, so candidate ranking prefers the cluster
  const extGrowth = (row: number, col: number): number => {
    if (staticExtent.minR === Infinity) return 0;
    return (
      Math.max(0, staticExtent.minR - row, row - staticExtent.maxR) +
      Math.max(0, staticExtent.minC - col, col - staticExtent.maxC)
    );
  };

  // ── Re-place one part optimally (rip-up must be done by caller) ──
  // digTarget: keep evaluating past TOP_K until a candidate has at most
  // this many problems (conflicts + starved nets). On a clean board that is
  // 0 (hunt until nothing starves); on an already-bad board the caller sets
  // its baseline, so pre-existing problems don't burn the whole eval cap on
  // every part.
  const findBest = (
    m: Movable,
    evalCap = MAX_EVALS,
    digTarget = 0
  ): { cand: Placement; cost: number; bad: boolean; problems: number } | null => {
    const strips = netStripsFor();
    // Candidates are ranked with the cheap evaluator against a baseline of
    // the other nets; the winner is re-measured exactly below. When the
    // exact measure exposes a problem the ranking could not see (this
    // part's pins starving another net on a tight board), the search
    // reruns with the full evaluator.
    const partNets = new Set([m.netA, m.netB]);
    const evalBase = captureEvalBase(partNets);
    let useCheap = true;
    const evaluate = () => (useCheap ? evalCost(partNets, evalBase) : fullCost());

    // Pin-1 pool: free holes near either net's copper (whole board if none)
    const anchors = [...(strips.get(m.netA) ?? []), ...(strips.get(m.netB) ?? [])];
    const pool1: BoardPosition[] = [];
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (!endpointFree(r, c)) continue;
        if (anchors.length > 0) {
          let near = false;
          for (const s of anchors) {
            const dc = c < s.startCol ? s.startCol - c : c > s.endCol ? c - s.endCol : 0;
            if (Math.hypot(r - s.row, dc) <= SEARCH_RADIUS) {
              near = true;
              break;
            }
          }
          if (!near) continue;
        }
        pool1.push({ row: r, col: c });
      }
    }

    // Rank all span-valid pairs cheaply, then full-evaluate in rank order.
    // Geometric validity, pin guards and per-strip-pair diversity are checked
    // during the ranked walk, so invalid candidates never use up eval slots.
    // Stop after TOP_K once a placement exists that leaves every net
    // connectable; keep digging (up to the eval cap) while all evaluated
    // candidates starve a net.
    // Candidates live in flat arrays bucketed by score (half-unit steps):
    // the walk usually consumes only the best few buckets, so the tail is
    // never sorted and no per-pair objects are allocated.
    // Off-net cost of landing pin 2 on a hole, cached per hole: the same
    // hole is a pin-2 candidate for many pin-1 anchors.
    const dBCache = new Float64Array(board.rows * board.cols).fill(-1);
    const dBAt = (r: number, c: number): number => {
      const i = r * board.cols + c;
      let v = dBCache[i];
      if (v < 0) {
        v = offNetCost(distToNet(strips, { row: r, col: c }, m.netB));
        dBCache[i] = v;
      }
      return v;
    };

    const search = (bboxBias: boolean, cap: number): { cand: Placement; cost: number; bad: boolean; problems: number } | null => {
      const candP1: BoardPosition[] = [];
      const candRow: number[] = [];
      const candCol: number[] = [];
      const candScore: number[] = [];
      const buckets: number[][] = [];
      const ring = ringOffsets(m.min, m.max);
      for (const p1 of pool1) {
        const dA = offNetCost(distToNet(strips, p1, m.netA));
        const g1 = bboxBias ? extGrowth(p1.row, p1.col) : 0;
        for (const [dr, dc] of ring) {
          const r = p1.row + dr;
          const c = p1.col + dc;
          if (!endpointFree(r, c)) continue;
          const diag = dr !== 0 && dc !== 0 ? DIAGONAL_PENALTY : 0;
          const score =
            Math.abs(dr) + Math.abs(dc) + diag + dA + dBAt(r, c) +
            (bboxBias ? COST_BBOX * (g1 + extGrowth(r, c)) : 0);
          const idx = candScore.length;
          candP1.push(p1);
          candRow.push(r);
          candCol.push(c);
          candScore.push(score);
          const b = Math.min(511, Math.max(0, Math.floor(score * 2)));
          (buckets[b] ??= []).push(idx);
        }
      }

      let best: { cand: Placement; cost: number; bad: boolean; problems: number } | null = null;
      let evals = 0;
      const perRowPair = new Map<string, number>();
      outer: for (const bucket of buckets) {
        if (!bucket) continue;
        bucket.sort((a, b) => candScore[a] - candScore[b]);
        for (const ci of bucket) {
          if (evals >= cap) break outer;
          const p1 = candP1[ci];
          const p2 = { row: candRow[ci], col: candCol[ci] };
          // Diversity: an attractive strip pair may take at most a few slots,
          // so the full evaluator always sees alternatives on other strips
          const rowPair = `${p1.row}:${p2.row}`;
          const same = perRowPair.get(rowPair) ?? 0;
          if (same >= MAX_PER_ROW_PAIR) continue;
          if (!isValid(m.comp.id, p1, p2)) continue;
          if (violatesGuard(m.comp.id, m.netA, m.netB, p1, p2)) continue;
          perRowPair.set(rowPair, same + 1);
          pos.set(m.comp.id, { p1, p2 });
          const r = evaluate();
          pos.delete(m.comp.id);
          evals++;
          if (!best || r.cost < best.cost) {
            best = { cand: { p1, p2 }, cost: r.cost, bad: r.bad, problems: r.problems };
          }
          if (evals >= TOP_K && best && best.problems <= digTarget) break outer;
        }
      }
      return best;
    };

    // Last resort when every pooled candidate failed geometric validity:
    // the ranked pools check validity only after scoring, so on crowded
    // boards they can fill entirely with well-scored-but-invalid spots
    // while a valid one in open space never enters. Scan the whole board
    // validity-first (straight placements only) and evaluate what fits.
    const searchAnyValid = (respectGuards: boolean): { cand: Placement; cost: number; bad: boolean; problems: number } | null => {
      const valid: (Placement & { score: number })[] = [];
      let budget = 3000;
      for (let r = 0; r < board.rows && budget > 0 && valid.length < 60; r++) {
        for (let c = 0; c < board.cols && budget > 0 && valid.length < 60; c++) {
          if (!endpointFree(r, c)) continue;
          const p1 = { row: r, col: c };
          for (const [ur, uc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            for (let s = Math.ceil(m.min); s <= Math.floor(m.max); s++) {
              if (--budget <= 0) break;
              const p2 = { row: r + ur * s, col: c + uc * s };
              if (!endpointFree(p2.row, p2.col)) continue;
              if (!isValid(m.comp.id, p1, p2)) continue;
              if (respectGuards && violatesGuard(m.comp.id, m.netA, m.netB, p1, p2)) continue;
              valid.push({
                p1, p2,
                score:
                  manhattan(p1, p2) +
                  offNetCost(distToNet(strips, p1, m.netA)) +
                  offNetCost(distToNet(strips, p2, m.netB)) +
                  COST_BBOX * (extGrowth(p1.row, p1.col) + extGrowth(p2.row, p2.col)),
              });
            }
          }
        }
      }
      valid.sort((a, b) => a.score - b.score);
      let best: { cand: Placement; cost: number; bad: boolean; problems: number } | null = null;
      for (const v of valid.slice(0, 16)) {
        pos.set(m.comp.id, { p1: v.p1, p2: v.p2 });
        const r = evaluate();
        pos.delete(m.comp.id);
        if (!best || r.cost < best.cost) {
          best = { cand: { p1: v.p1, p2: v.p2 }, cost: r.cost, bad: r.bad, problems: r.problems };
        }
      }
      return best;
    };

    // Compact placements first; when the cluster is too congested for any
    // usable spot, rescan without the compactness bias, and as a last
    // resort take anything geometrically valid anywhere on the board —
    // first respecting the pin guards, then (rather than leaving the part
    // unplaced) even a guard-violating spot the evaluator will price.
    const runSearches = (): { cand: Placement; cost: number; bad: boolean; problems: number } | null => {
      let best = search(true, evalCap);
      if (!best || best.problems > digTarget) {
        const alt = search(false, evalCap);
        if (alt && (!best || (best.bad && !alt.bad) || (best.bad === alt.bad && alt.cost < best.cost))) {
          best = alt;
        }
      }
      if (!best) best = searchAnyValid(true);
      if (!best) best = searchAnyValid(false);
      return best;
    };
    let best = runSearches();
    // Exact re-measure of the winner: the caller compares against
    // fullCost-scale numbers, and the ranking evaluator only approximates
    // the other nets' reaction to this part's pins. If the exact measure
    // finds problems the ranking missed, redo the search with the full
    // evaluator — that is the tight-board case where the interaction IS
    // the signal.
    if (best) {
      pos.set(m.comp.id, best.cand);
      const exact = fullCost();
      pos.delete(m.comp.id);
      if (exact.problems > digTarget && best.problems <= digTarget) {
        useCheap = false;
        best = runSearches();
      } else {
        best = { cand: best.cand, cost: exact.cost, bad: exact.bad, problems: exact.problems };
      }
    }
    return best;
  };

  // ── Hill-climb: rip up and re-place until no sweep improves ──
  // Sweeps cover the first 85% of this stage's progress, repair the rest;
  // early sweep termination just jumps the bar forward.
  const seedState = fullCost();
  let currentCost = seedState.cost;
  let currentProblems = seedState.problems;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improved = false;
    for (const [mi, m] of movables.entries()) {
      onProgress?.(((sweep + mi / movables.length) / MAX_SWEEPS) * 0.85, "place");
      const had = pos.get(m.comp.id);
      if (had) pos.delete(m.comp.id);
      // Dig for a candidate that is at least as clean as the current state;
      // pre-existing problems are not this part's fault.
      const best = findBest(m, MAX_EVALS, currentProblems);
      // An unplaced part is always placed if possible, even at a cost
      // increase; a placed one only moves when it beats its old spot.
      if (best && (!had || best.cost < currentCost - 1e-6)) {
        pos.set(m.comp.id, best.cand);
        currentCost = best.cost;
        currentProblems = best.problems;
        improved = true;
      } else if (had) {
        pos.set(m.comp.id, had);
      }
    }
    if (!improved) break;
  }

  // ── Repair: violation-driven, escalating ─────────────
  // The fix for a starved net is often a placement the ranked pools above
  // pruned away (the cheap score can't see starvation). Repair runs only
  // while the completion is bad, and escalates: cheap local nudges of every
  // placed part first, then deep unpruned re-placement of the implicated
  // parts — net members, spatial neighbours of the starved pins, and parts
  // that found no position at all.
  const REPAIR_ROUNDS = 3;
  const REPAIR_RADIUS = 2;
  const REPAIR_EVALS = 240;
  // Hard deterministic ceiling on repair's evaluator calls: small boards
  // never come near it, but with dozens of parts the unpruned repair walks
  // otherwise grind for minutes.
  const REPAIR_EVAL_BUDGET = 3000;
  let repairEvals = 0;
  for (let round = 0; round < REPAIR_ROUNDS; round++) {
    if (repairEvals >= REPAIR_EVAL_BUDGET) break;
    const state = fullCost();
    if (!state.bad) break;
    const starved = new Set(state.starvedNets);
    let repairCost = state.cost;
    let improved = false;
    const roundBase = 0.85 + (0.15 * round) / REPAIR_ROUNDS;
    const roundSpan = 0.15 / REPAIR_ROUNDS;

    // Phase 1: nudge every placed part, starved-net members first. Nudges
    // are whole-part translations plus single-endpoint moves — stretching
    // or shortening a part by a hole is often the entire fix.
    const nudgeOrder = movables
      .filter((m) => pos.has(m.comp.id))
      .sort((a, b) => {
        const ai = starved.has(a.netA) || starved.has(a.netB) ? 0 : 1;
        const bi = starved.has(b.netA) || starved.has(b.netB) ? 0 : 1;
        return ai - bi;
      });
    for (const [ni, m] of nudgeOrder.entries()) {
      if (repairEvals >= REPAIR_EVAL_BUDGET) break;
      onProgress?.(roundBase + roundSpan * 0.4 * (ni / nudgeOrder.length), "repair");
      const cur = pos.get(m.comp.id)!;
      pos.delete(m.comp.id);
      const candidates: Placement[] = [];
      for (let dr = -REPAIR_RADIUS; dr <= REPAIR_RADIUS; dr++) {
        for (let dc = -REPAIR_RADIUS; dc <= REPAIR_RADIUS; dc++) {
          if (dr === 0 && dc === 0) continue;
          candidates.push({
            p1: { row: cur.p1.row + dr, col: cur.p1.col + dc },
            p2: { row: cur.p2.row + dr, col: cur.p2.col + dc },
          });
          if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1) {
            candidates.push({ p1: { row: cur.p1.row + dr, col: cur.p1.col + dc }, p2: cur.p2 });
            candidates.push({ p1: cur.p1, p2: { row: cur.p2.row + dr, col: cur.p2.col + dc } });
          }
        }
      }
      let best: { cand: Placement; cost: number } | null = null;
      for (const { p1, p2 } of candidates) {
        const d = Math.hypot(p1.row - p2.row, p1.col - p2.col);
        if (d < m.min - 1e-6 || d > m.max + 1e-6) continue;
        if (!endpointFree(p1.row, p1.col) || !endpointFree(p2.row, p2.col)) continue;
        if (!isValid(m.comp.id, p1, p2)) continue;
        pos.set(m.comp.id, { p1, p2 });
        const r = fullCost();
        repairEvals++;
        pos.delete(m.comp.id);
        if (!best || r.cost < best.cost) best = { cand: { p1, p2 }, cost: r.cost };
      }
      if (best && best.cost < repairCost - 1e-6) {
        pos.set(m.comp.id, best.cand);
        repairCost = best.cost;
        improved = true;
      } else {
        pos.set(m.comp.id, cur);
      }
    }

    // Phase 2: still bad → deep re-place of everything implicated
    const after = fullCost();
    if (after.bad) {
      const starved2 = new Set(after.starvedNets);
      repairCost = after.cost;

      // Pins of the starved nets: their spatial neighbours are suspects too
      // (the blocker is often a part of a different net sitting on the
      // starved segment's last free hole)
      const starvedPins: BoardPosition[] = [];
      const virtual = virtualComponents();
      for (const comp of virtual) {
        if (!comp.boardPos || comp.boardExcluded) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        for (const p of getComponentPinPositions(comp, def)) {
          const netId = assignedNetOf.get(`${comp.id}:${p.pinId}`);
          if (netId !== undefined && starved2.has(netId)) starvedPins.push({ row: p.row, col: p.col });
        }
      }
      const nearStarved = (pl: Placement) =>
        starvedPins.some(
          (sp) =>
            Math.max(Math.abs(sp.row - pl.p1.row), Math.abs(sp.col - pl.p1.col)) <= 3 ||
            Math.max(Math.abs(sp.row - pl.p2.row), Math.abs(sp.col - pl.p2.col)) <= 3
        );

      for (const [pi, m] of movables.entries()) {
        const cur = pos.get(m.comp.id);
        const implicated =
          !cur || starved2.has(m.netA) || starved2.has(m.netB) || nearStarved(cur);
        if (!implicated) continue;
        const evalCap = Math.min(REPAIR_EVALS, REPAIR_EVAL_BUDGET - repairEvals);
        if (evalCap <= 0) break;
        onProgress?.(roundBase + roundSpan * (0.4 + 0.6 * (pi / movables.length)), "repair");
        if (cur) pos.delete(m.comp.id);
        // Deep dig, but stop as soon as a candidate strictly reduces the
        // problem count — that is what repair is hunting for.
        const best = findBest(m, evalCap, Math.max(0, after.problems - 1));
        repairEvals += evalCap;
        if (best && (!cur || best.cost < repairCost - 1e-6)) {
          pos.set(m.comp.id, best.cand);
          repairCost = best.cost;
          improved = true;
        } else if (cur) {
          pos.set(m.comp.id, cur);
        }
      }
    }

    if (!improved) break;
  }

  for (const m of movables) {
    if (!pos.has(m.comp.id)) issues.push(`${m.comp.label}: no valid position found`);
  }

  // ── Final completion on the optimized layout ─────────
  const plan = deriveCompletion(board, virtualComponents(), componentDefs, nets, netAssignments);
  issues.push(...plan.issues);
  if (plan.unresolvedConflicts > 0) {
    issues.push(
      `${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved`
    );
  }
  const unplacedRigid = components.filter((c) => {
    if (c.boardPos || c.boardExcluded) return false;
    const def = resolveComponentDef(c, componentDefs);
    return !def?.flexible;
  }).length;
  if (unplacedRigid > 0) {
    issues.push(`${unplacedRigid} component${unplacedRigid > 1 ? "s" : ""} not placed yet`);
  }

  return {
    placements: Array.from(pos.entries()).map(([componentId, p]) => ({
      componentId,
      boardPos: p.p1,
      flexibleEndPos: p.p2,
    })),
    cuts: plan.cuts,
    wires: plan.wires,
    issues,
    starvedNets: plan.starvedNetIds,
    starvedPins: plan.starvedPinPositions,
  };
}

// ── Stage A: arrange the rigid parts (simulated annealing) ──

// Proxy cost weights: half-perimeter wirelength pulls connected parts
// together, the bounding-box term keeps the arrangement compact. Springs
// keep two nets joined by a flexible within that part's span range — the
// crush penalty must beat the combined contraction gain (W_HPWL + W_BBOX
// per unit), otherwise compactness squeezes nets closer than the part fits.
const W_HPWL = 1;
const W_BBOX = 1;
const W_SPRING = 4;
const W_SPRING_ROW_SHARE = 2; // ~ one strip cut
// Connectors belong on the board's outside: that's where they are wired up
// in practice, and buried between parts their nets starve for free holes.
// Must beat the combined inward pull of W_HPWL + W_BBOX per hole.
const W_CONNECTOR_EDGE = 4;
// Rigid-repair mode: pressure to clear the area around starved pins. Must
// beat the HPWL pull of a well-connected part (several units per hole), or
// nothing moves — the quality gate in the orchestrator rejects regressions.
const W_AVOID = 8;
const ANNEAL_T0 = 6;
const ANNEAL_T_END = 0.05;
const ANNEAL_BASE_ITERS = 8000;
const ANNEAL_ITERS_PER_PART = 4000;
const ANNEAL_MAX_ITERS = 48000;
// Repair re-anneal: seeded from the failed arrangement, low temperature so
// the layout shifts locally instead of re-scrambling
const REPAIR_ANNEAL_T0 = 1.5;
const REPAIR_ANNEAL_BASE_ITERS = 4000;
const REPAIR_ANNEAL_ITERS_PER_PART = 2000;
const REPAIR_ANNEAL_MAX_ITERS = 16000;

/** Deterministic RNG so identical inputs produce identical layouts */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RigidState {
  row: number;
  col: number;
  rot: 0 | 90 | 180 | 270;
}

const ROTATIONS: RigidState["rot"][] = [0, 90, 180, 270];

interface RectI {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

function rectsOverlap(a: RectI, b: RectI): boolean {
  return (
    a.minRow <= b.maxRow && b.minRow <= a.maxRow &&
    a.minCol <= b.maxCol && b.minCol <= a.maxCol
  );
}

function rectsTooClose(a: RectI, b: RectI, spacing: number): boolean {
  return (
    a.minRow <= b.maxRow + spacing && b.minRow <= a.maxRow + spacing &&
    a.minCol <= b.maxCol + spacing && b.minCol <= a.maxCol + spacing
  );
}

/**
 * Arrange all unlocked rigid components: seed unplaced ones greedily (most
 * connected first), then anneal translate/rotate/swap moves against the
 * smooth proxy cost. Locked components and placed flexibles are immovable
 * obstacles and HPWL anchors. Returns the final state of every movable
 * rigid that could be placed.
 */
interface FlexSpring {
  a: string; // net of pin 1
  b: string; // net of pin 2
  min: number;
  max: number;
}

/**
 * @param spacing Free holes kept between rigid footprints. Without at least
 * one, adjacent pin columns produce single-hole segments with no room for
 * jumper ends; the orchestrator retries with more when routing starves.
 * @param bboxWeight Compactness pressure; relaxed on retries so congested
 * arrangements spread over the available board instead of one dense band.
 */
/** Rigid-repair mode: re-anneal from a failed arrangement, clearing the
 * area around starved pins so stage B gets free holes to work with. */
interface RigidRepair {
  seed: Map<string, RigidState>;
  avoidPins: BoardPosition[];
}

function arrangeRigids(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  springs: FlexSpring[],
  spacing: number,
  bboxWeight: number,
  seed: number,
  issues: string[],
  onProgress?: (frac: number) => void,
  repair?: RigidRepair
): Map<string, RigidState> {
  interface MovableRigid {
    comp: Component;
    def: ComponentDef;
    // Per rotation: footprint extents and net-assigned pin offsets
    dims: Record<number, { maxRow: number; maxCol: number }>;
    pins: Record<number, { dr: number; dc: number; netId: string }[]>;
    // Rotations where some pin is flanked on both sides (same row) by
    // different-net pins of the same part: that pin's strip segment is
    // exactly one hole, so no wire can ever reach its net. This is what a
    // sideways DIP does to all its interior pins — never place it that way.
    deadRotations: Set<number>;
    isConnector: boolean;
    assignmentCount: number;
  }

  const movables: MovableRigid[] = [];
  const fixedRects: RectI[] = [];
  const fixedFlexBodies: { p1: BoardPosition; p2: BoardPosition; clr: number }[] = [];
  const fixedPinHoles: BoardPosition[] = [];
  const fixedTerminals: { row: number; col: number; netId: string }[] = [];

  for (const comp of components) {
    if (comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;

    const isMovableRigid = !def.flexible && !comp.locked;
    if (isMovableRigid) {
      const dims: MovableRigid["dims"] = {};
      const pins: MovableRigid["pins"] = {};
      const deadRotations = new Set<number>();
      for (const rot of ROTATIONS) {
        const b = getComponentBounds(def, { row: 0, col: 0 }, rot);
        dims[rot] = { maxRow: b.maxRow, maxCol: b.maxCol };
        // Unassigned pins get isolating cuts too, so they count with a
        // unique key when checking which neighbours force cuts.
        const allPins = getRotatedPinPositions(def, { row: 0, col: 0 }, rot).map((p) => {
          const a = netAssignments.find(
            (x) => x.componentId === comp.id && x.pinId === p.pinId
          );
          return { dr: p.row, dc: p.col, netId: a?.netId ?? null, key: a?.netId ?? `nc:${p.pinId}` };
        });
        pins[rot] = allPins.flatMap((p) =>
          p.netId ? [{ dr: p.dr, dc: p.dc, netId: p.netId }] : []
        );
        const keyAt = new Map(allPins.map((p) => [`${p.dr},${p.dc}`, p.key]));
        const boxedPin = allPins.some((p) => {
          const left = keyAt.get(`${p.dr},${p.dc - 1}`);
          const right = keyAt.get(`${p.dr},${p.dc + 1}`);
          return left !== undefined && right !== undefined && left !== p.key && right !== p.key;
        });
        if (boxedPin) deadRotations.add(rot);
      }
      // Pathological footprints may box pins in every rotation; then the
      // ban would make the part unplaceable, so drop it entirely.
      if (deadRotations.size === ROTATIONS.length) deadRotations.clear();
      const assignmentCount = netAssignments.filter((x) => x.componentId === comp.id).length;
      movables.push({
        comp, def, dims, pins, deadRotations,
        isConnector: def.category === "connector",
        assignmentCount,
      });
      continue;
    }

    // Everything else that sits on the board is a fixed obstacle and anchor
    if (!comp.boardPos) continue;
    const pinPositions = getComponentPinPositions(comp, def);
    for (const p of pinPositions) {
      fixedPinHoles.push({ row: p.row, col: p.col });
      const a = netAssignments.find((x) => x.componentId === comp.id && x.pinId === p.pinId);
      if (a) fixedTerminals.push({ row: p.row, col: p.col, netId: a.netId });
    }
    if (def.flexible) {
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (p1 && p2) fixedFlexBodies.push({ p1, p2, clr: clearanceOf(def) });
    } else {
      fixedRects.push(getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }

  // ── Super-nets: movable flexibles act as springs joining their two nets ──
  const superOf = new Map<string, string>();
  const findSuper = (n: string): string => {
    let root = n;
    while (superOf.has(root) && superOf.get(root) !== root) root = superOf.get(root)!;
    superOf.set(n, root);
    return root;
  };
  for (const s of springs) {
    const ra = findSuper(s.a);
    const rb = findSuper(s.b);
    if (ra !== rb) superOf.set(ra, rb);
  }
  const superIds = new Map<string, number>();
  const superKey = (netId: string): number => {
    const root = findSuper(netId);
    if (!superIds.has(root)) superIds.set(root, superIds.size);
    return superIds.get(root)!;
  };

  // Resolve pin/terminal netIds to super indices up front
  const fixedTerms = fixedTerminals.map((t) => ({
    row: t.row,
    col: t.col,
    netId: t.netId,
    s: superKey(t.netId),
  }));
  for (const m of movables) {
    for (const rot of ROTATIONS) {
      for (const p of m.pins[rot]) {
        superKey(p.netId);
      }
    }
  }
  const superCount = superIds.size;

  // ── State ────────────────────────────────────────────
  const states = new Map<string, RigidState>();
  for (const m of movables) {
    const seeded = repair?.seed.get(m.comp.id);
    if (seeded) {
      states.set(m.comp.id, { ...seeded });
    } else if (m.comp.boardPos) {
      states.set(m.comp.id, {
        row: m.comp.boardPos.row,
        col: m.comp.boardPos.col,
        rot: m.comp.rotation,
      });
    }
  }

  const rectFor = (m: MovableRigid, st: RigidState): RectI => ({
    minRow: st.row,
    minCol: st.col,
    maxRow: st.row + m.dims[st.rot].maxRow,
    maxCol: st.col + m.dims[st.rot].maxCol,
  });

  const isValidState = (m: MovableRigid, st: RigidState): boolean => {
    if (m.deadRotations.has(st.rot)) return false;
    const rect = rectFor(m, st);
    if (rect.minRow < 0 || rect.minCol < 0 || rect.maxRow >= board.rows || rect.maxCol >= board.cols) {
      return false;
    }
    for (const r of fixedRects) {
      if (rectsTooClose(rect, r, spacing)) return false;
    }
    for (const p of fixedPinHoles) {
      if (
        p.row >= rect.minRow - spacing && p.row <= rect.maxRow + spacing &&
        p.col >= rect.minCol - spacing && p.col <= rect.maxCol + spacing
      ) {
        return false;
      }
    }
    for (const f of fixedFlexBodies) {
      if (bodyIntersectsRect(f.p1, f.p2, rect, f.clr)) return false;
    }
    for (const other of movables) {
      if (other.comp.id === m.comp.id) continue;
      const ost = states.get(other.comp.id);
      if (ost && rectsTooClose(rect, rectFor(other, ost), spacing)) return false;
    }
    return true;
  };

  // Per-net terminal boxes are tracked for nets joined by a spring, so the
  // spring rest length can be enforced between the two nets' locations.
  const springNetIdx = new Map<string, number>();
  for (const s of springs) {
    if (s.a === s.b) continue; // same net at both pins: no distance to keep
    if (!springNetIdx.has(s.a)) springNetIdx.set(s.a, springNetIdx.size);
    if (!springNetIdx.has(s.b)) springNetIdx.set(s.b, springNetIdx.size);
  }
  const springNetCount = springNetIdx.size;

  // ── Proxy cost: HPWL over super-nets + bbox + flexible springs ──
  const proxyCost = (): number => {
    const minR = new Array<number>(superCount).fill(Infinity);
    const maxR = new Array<number>(superCount).fill(-Infinity);
    const minC = new Array<number>(superCount).fill(Infinity);
    const maxC = new Array<number>(superCount).fill(-Infinity);
    const nMinR = new Array<number>(springNetCount).fill(Infinity);
    const nMaxR = new Array<number>(springNetCount).fill(-Infinity);
    const nMinC = new Array<number>(springNetCount).fill(Infinity);
    const nMaxC = new Array<number>(springNetCount).fill(-Infinity);
    const touch = (s: number, netId: string, row: number, col: number) => {
      if (row < minR[s]) minR[s] = row;
      if (row > maxR[s]) maxR[s] = row;
      if (col < minC[s]) minC[s] = col;
      if (col > maxC[s]) maxC[s] = col;
      const n = springNetIdx.get(netId);
      if (n !== undefined) {
        if (row < nMinR[n]) nMinR[n] = row;
        if (row > nMaxR[n]) nMaxR[n] = row;
        if (col < nMinC[n]) nMinC[n] = col;
        if (col > nMaxC[n]) nMaxC[n] = col;
      }
    };
    for (const t of fixedTerms) touch(t.s, t.netId, t.row, t.col);

    let bMinR = Infinity, bMaxR = -Infinity, bMinC = Infinity, bMaxC = -Infinity;
    for (const r of fixedRects) {
      bMinR = Math.min(bMinR, r.minRow); bMaxR = Math.max(bMaxR, r.maxRow);
      bMinC = Math.min(bMinC, r.minCol); bMaxC = Math.max(bMaxC, r.maxCol);
    }
    for (const p of fixedPinHoles) {
      bMinR = Math.min(bMinR, p.row); bMaxR = Math.max(bMaxR, p.row);
      bMinC = Math.min(bMinC, p.col); bMaxC = Math.max(bMaxC, p.col);
    }

    let connectorEdgeCost = 0;
    for (const m of movables) {
      const st = states.get(m.comp.id);
      if (!st) continue;
      for (const p of m.pins[st.rot]) {
        touch(superKey(p.netId), p.netId, st.row + p.dr, st.col + p.dc);
      }
      const rect = rectFor(m, st);
      bMinR = Math.min(bMinR, rect.minRow); bMaxR = Math.max(bMaxR, rect.maxRow);
      bMinC = Math.min(bMinC, rect.minCol); bMaxC = Math.max(bMaxC, rect.maxCol);
      if (m.isConnector) {
        connectorEdgeCost += W_CONNECTOR_EDGE * Math.min(
          rect.minRow,
          rect.minCol,
          board.rows - 1 - rect.maxRow,
          board.cols - 1 - rect.maxCol
        );
      }
      if (repair) {
        // Starved-pin avoidance, graded by clearance so every single-hole
        // step away from the starved spot pays off: footprint on the point
        // costs 2×W_AVOID, one hole clear costs W_AVOID, two or more is free.
        for (const ap of repair.avoidPins) {
          const dr = Math.max(0, rect.minRow - ap.row, ap.row - rect.maxRow);
          const dc = Math.max(0, rect.minCol - ap.col, ap.col - rect.maxCol);
          connectorEdgeCost += W_AVOID * Math.max(0, 2 - Math.max(dr, dc));
        }
      }
    }

    let cost = connectorEdgeCost;
    for (let s = 0; s < superCount; s++) {
      if (minR[s] !== Infinity) cost += W_HPWL * (maxR[s] - minR[s] + (maxC[s] - minC[s]));
    }
    if (bMinR !== Infinity) cost += bboxWeight * (bMaxR - bMinR + (bMaxC - bMinC));

    // Springs: penalize net pairs crushed below the flexible's min span or
    // stretched beyond its max span (gap between the nets' terminal boxes).
    // Two nets sharing a row also pay one cut's worth: same-strip nets force
    // a cut and leave no room for the part to bridge along the strip.
    for (const s of springs) {
      if (s.a === s.b) continue;
      const na = springNetIdx.get(s.a)!;
      const nb = springNetIdx.get(s.b)!;
      if (nMinR[na] === Infinity || nMinR[nb] === Infinity) continue;
      const dr = Math.max(0, nMinR[na] - nMaxR[nb], nMinR[nb] - nMaxR[na]);
      const dc = Math.max(0, nMinC[na] - nMaxC[nb], nMinC[nb] - nMaxC[na]);
      const d = Math.hypot(dr, dc);
      cost += W_SPRING * (Math.max(0, s.min - d) + Math.max(0, d - s.max));
      if (dr === 0) cost += W_SPRING_ROW_SHARE;
    }
    return cost;
  };

  // ── Seed unplaced rigids: most connected first, best proxy spot ──
  const unseeded = movables
    .filter((m) => !states.has(m.comp.id))
    .sort((a, b) => b.assignmentCount - a.assignmentCount);
  for (const [si, m] of unseeded.entries()) {
    onProgress?.(0.2 * (si / unseeded.length));
    let best: { st: RigidState; cost: number } | null = null;
    for (const rot of ROTATIONS) {
      for (let r = 0; r + m.dims[rot].maxRow < board.rows; r++) {
        for (let c = 0; c + m.dims[rot].maxCol < board.cols; c++) {
          const st: RigidState = { row: r, col: c, rot };
          if (!isValidState(m, st)) continue;
          states.set(m.comp.id, st);
          const cost = proxyCost();
          states.delete(m.comp.id);
          if (!best || cost < best.cost) best = { st, cost };
        }
      }
    }
    if (best) {
      states.set(m.comp.id, best.st);
    } else {
      issues.push(`${m.comp.label}: no free spot on the board`);
    }
  }

  const active = movables.filter((m) => states.has(m.comp.id));
  if (active.length === 0) return states;

  // ── Anneal ───────────────────────────────────────────
  const rand = mulberry32(seed);
  const t0 = repair ? REPAIR_ANNEAL_T0 : ANNEAL_T0;
  const iters = repair
    ? Math.min(REPAIR_ANNEAL_MAX_ITERS, REPAIR_ANNEAL_BASE_ITERS + REPAIR_ANNEAL_ITERS_PER_PART * active.length)
    : Math.min(ANNEAL_MAX_ITERS, ANNEAL_BASE_ITERS + ANNEAL_ITERS_PER_PART * active.length);
  const cooling = Math.pow(ANNEAL_T_END / t0, 1 / iters);
  let temperature = t0;
  let cost = proxyCost();
  let bestCost = cost;
  let bestStates = new Map(Array.from(states, ([k, v]) => [k, { ...v }]));

  for (let i = 0; i < iters; i++, temperature *= cooling) {
    if (onProgress && i % 2048 === 0) onProgress(0.2 + 0.8 * (i / iters));
    const kind = rand();
    if (kind < 0.7 || active.length < 2) {
      // Translate (or rotate) one part
      const m = active[Math.floor(rand() * active.length)];
      const old = states.get(m.comp.id)!;
      const st: RigidState =
        kind < 0.45
          ? {
              row: old.row + Math.floor(rand() * 7) - 3,
              col: old.col + Math.floor(rand() * 7) - 3,
              rot: old.rot,
            }
          : { ...old, rot: ROTATIONS[Math.floor(rand() * 4)] };
      if (st.row === old.row && st.col === old.col && st.rot === old.rot) continue;
      states.set(m.comp.id, st);
      if (!isValidState(m, st)) {
        states.set(m.comp.id, old);
        continue;
      }
      const next = proxyCost();
      if (next <= cost || rand() < Math.exp((cost - next) / temperature)) {
        cost = next;
      } else {
        states.set(m.comp.id, old);
      }
    } else {
      // Swap the positions of two parts
      const a = active[Math.floor(rand() * active.length)];
      const b = active[Math.floor(rand() * active.length)];
      if (a.comp.id === b.comp.id) continue;
      const oldA = states.get(a.comp.id)!;
      const oldB = states.get(b.comp.id)!;
      states.set(a.comp.id, { ...oldB, rot: oldA.rot });
      states.set(b.comp.id, { ...oldA, rot: oldB.rot });
      if (!isValidState(a, states.get(a.comp.id)!) || !isValidState(b, states.get(b.comp.id)!)) {
        states.set(a.comp.id, oldA);
        states.set(b.comp.id, oldB);
        continue;
      }
      const next = proxyCost();
      if (next <= cost || rand() < Math.exp((cost - next) / temperature)) {
        cost = next;
      } else {
        states.set(a.comp.id, oldA);
        states.set(b.comp.id, oldB);
      }
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestStates = new Map(Array.from(states, ([k, v]) => [k, { ...v }]));
    }
  }

  return bestStates;
}

// ── Full auto-layout: stage A + stage B ────────────────

/**
 * Arrange everything unlocked and complete the board: stage A anneals the
 * rigid arrangement on a smooth proxy (wirelength + compactness), stage B
 * jointly optimizes the flexible parts, cuts and jumper wires on that
 * skeleton. Existing cuts and wires are REGENERATED, not augmented — after
 * parts move they would refer to positions that no longer exist. Locked
 * components never move.
 */
const DEFAULT_SEED = 0x5eed;

export const DEFAULT_ATTEMPTS: AttemptConfig[] = [
  { spacing: 1, bboxWeight: W_BBOX },
  { spacing: 2, bboxWeight: W_BBOX },
  { spacing: 3, bboxWeight: W_BBOX / 2 },
  { spacing: 4, bboxWeight: W_BBOX / 4 },
];

export function computeAutoLayout(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayoutOptions
): AutoLayoutResult {
  const issues: string[] = [];
  const baseBoard: Board = { ...board, cuts: [], wires: [] };

  // Scoped run: everything outside the scope is frozen exactly as it is —
  // placed parts act like locked parts, unplaced parts stay off the board.
  const scopeIds = options?.onlyIds?.length ? new Set(options.onlyIds) : null;
  const frozen = new Set<string>();
  if (scopeIds) {
    for (const comp of components) {
      if (!scopeIds.has(comp.id)) frozen.add(comp.id);
    }
    components = components.map((c) => (frozen.has(c.id) ? { ...c, locked: true } : c));
  }

  // A locked component without a board position can never be placed (lock
  // means "never move") — say so instead of silently leaving nets open.
  for (const comp of components) {
    if (frozen.has(comp.id)) continue; // out of scope by choice, not an error
    if (comp.locked && !comp.boardPos && !comp.boardExcluded) {
      issues.push(`${comp.label}: locked but not on the board, unlock or place it manually`);
    }
  }

  // Movable flexibles (re-placed from scratch in stage B); their net pairs
  // act as springs between nets during stage A.
  const movableFlexIds = new Set<string>();
  const springs: FlexSpring[] = [];
  for (const comp of components) {
    if (comp.boardExcluded || comp.locked) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def?.flexible) continue;
    const a = netAssignments.find((x) => x.componentId === comp.id && x.pinId === def.pins[0]?.id);
    const b = netAssignments.find((x) => x.componentId === comp.id && x.pinId === def.pins[1]?.id);
    if (!a || !b) continue; // unassigned: stays where it is, reported in stage B
    movableFlexIds.add(comp.id);
    springs.push({ a: a.netId, b: b.netId, ...spanLimits(def) });
  }

  // Stage A input: movable flexibles are invisible (stage B re-places them)
  const stageAComponents = components.map((c) =>
    movableFlexIds.has(c.id) ? { ...c, boardPos: null, flexibleEndPos: undefined } : c
  );

  // Stage A can't see hole-level congestion, so when stage B starves (no
  // free holes for jumpers or parts), retry with more room between rigids.
  // Attempts are judged by what the user would see: conflicts, incomplete
  // nets, and parts left off the board.
  const attemptQuality = (arranged: Component[], flex: FlexOptimizeResult): number => {
    const byId = new Map(flex.placements.map((p) => [p.componentId, p]));
    const finalComps = arranged.map((c) => {
      const p = byId.get(c.id);
      return p ? { ...c, boardPos: p.boardPos, flexibleEndPos: p.flexibleEndPos } : c;
    });
    const finalBoard: Board = {
      ...baseBoard,
      cuts: flex.cuts,
      wires: flex.wires.map((w, i) => ({ id: `q${i}`, from: w.from, to: w.to })),
    };
    const segments = computeStripSegments(finalBoard, finalComps, componentDefs, netAssignments);
    const connectivity = computeConnectivity(segments, finalBoard.wires);
    const conflicts = connectivity.filter((g) => g.hasConflict).length;
    const incomplete = checkNetCompleteness(
      nets, netAssignments, segments, connectivity, finalComps, componentDefs
    );
    // Frozen (out-of-scope) parts stay unplaced by choice, not by failure
    const unplaced = finalComps.filter((c) => !c.boardPos && !c.boardExcluded && !frozen.has(c.id)).length;
    return conflicts * 100 + incomplete.length + unplaced * 2;
  };

  let rigidStates = new Map<string, RigidState>();
  let flexResult: FlexOptimizeResult | null = null;
  let attemptIssues: string[] = [];
  let bestQuality = Infinity;
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) netOfPin.set(`${a.componentId}:${a.pinId}`, a.netId);
  const attempts = options?.attempts?.length ? options.attempts : DEFAULT_ATTEMPTS;
  const seed = options?.seed ?? DEFAULT_SEED;
  for (const [ai, { spacing, bboxWeight }] of attempts.entries()) {
    // Stage A fills the first 35% of an attempt's progress, stage B the rest
    const report = onProgress
      ? (phase: AutoLayoutProgress["phase"], frac: number) =>
          onProgress({ phase, attempt: ai + 1, maxAttempts: attempts.length, frac })
      : undefined;
    const tryIssues: string[] = [];
    const tryStates = arrangeRigids(
      baseBoard, stageAComponents, componentDefs, netAssignments, springs, spacing, bboxWeight, seed, tryIssues,
      report && ((f) => report("arrange", f * 0.35))
    );
    const arranged = stageAComponents.map((c) => {
      const st = tryStates.get(c.id);
      return st ? { ...c, boardPos: { row: st.row, col: st.col }, rotation: st.rot } : c;
    });
    const tryFlex = optimizeFlexibles(
      baseBoard, arranged, componentDefs, nets, netAssignments,
      report && ((f, phase) => report(phase, 0.35 + f * 0.65))
    );
    let chosenStates = tryStates;
    let chosenFlex = tryFlex;
    let chosenIssues = [...tryIssues, ...tryFlex.issues];
    let quality = attemptQuality(arranged, tryFlex);

    // Rigid-move repair: flexible-level repair could not clear the starved
    // nets, so re-anneal the rigids from this arrangement at low temperature
    // with pressure to give the starved pins air, then route again. Kept
    // only when the re-run is strictly better.
    if (quality > 0 && tryFlex.starvedNets.length > 0 && tryStates.size > 0) {
      // Clear the air exactly where a group starved; fall back to all pins
      // of the starved nets when no positions were reported.
      const avoidPins: BoardPosition[] = [...tryFlex.starvedPins];
      if (avoidPins.length === 0) {
        const starved = new Set(tryFlex.starvedNets);
        for (const comp of arranged) {
          if (!comp.boardPos || comp.boardExcluded) continue;
          const def = resolveComponentDef(comp, componentDefs);
          if (!def) continue;
          for (const p of getComponentPinPositions(comp, def)) {
            const nid = netOfPin.get(`${comp.id}:${p.pinId}`);
            if (nid !== undefined && starved.has(nid)) avoidPins.push({ row: p.row, col: p.col });
          }
        }
      }
      if (avoidPins.length > 0) {
        const repairIssues: string[] = [];
        const repairStates = arrangeRigids(
          baseBoard, stageAComponents, componentDefs, netAssignments, springs, spacing, bboxWeight, seed, repairIssues,
          report && ((f) => report("repair", f * 0.35)),
          { seed: tryStates, avoidPins }
        );
        const movedAny = Array.from(repairStates).some(([id, st]) => {
          const prev = tryStates.get(id);
          return !prev || prev.row !== st.row || prev.col !== st.col || prev.rot !== st.rot;
        });
        if (movedAny) {
          const arranged2 = stageAComponents.map((c) => {
            const st = repairStates.get(c.id);
            return st ? { ...c, boardPos: { row: st.row, col: st.col }, rotation: st.rot } : c;
          });
          const flex2 = optimizeFlexibles(
            baseBoard, arranged2, componentDefs, nets, netAssignments,
            report && ((f, phase) => report(phase, 0.35 + f * 0.65))
          );
          const q2 = attemptQuality(arranged2, flex2);
          if (q2 < quality) {
            chosenStates = repairStates;
            chosenFlex = flex2;
            chosenIssues = [...repairIssues, ...flex2.issues];
            quality = q2;
          }
        }
      }
    }

    if (!flexResult || quality < bestQuality) {
      rigidStates = chosenStates;
      flexResult = chosenFlex;
      attemptIssues = chosenIssues;
      bestQuality = quality;
    }
    if (quality === 0) break;
  }
  issues.push(...attemptIssues);

  const placements: LayoutPlacement[] = [];
  for (const [id, st] of rigidStates) {
    const orig = components.find((c) => c.id === id);
    if (!orig) continue;
    const moved =
      !orig.boardPos ||
      orig.boardPos.row !== st.row ||
      orig.boardPos.col !== st.col ||
      orig.rotation !== st.rot;
    if (moved) {
      placements.push({
        componentId: id,
        boardPos: { row: st.row, col: st.col },
        rotation: st.rot,
      });
    }
  }
  for (const p of flexResult!.placements) {
    placements.push({
      componentId: p.componentId,
      boardPos: p.boardPos,
      flexibleEndPos: p.flexibleEndPos,
    });
  }

  return {
    placements,
    cuts: flexResult!.cuts,
    wires: flexResult!.wires,
    issues,
    quality: bestQuality,
    starvedNetIds: flexResult!.starvedNets,
  };
}
