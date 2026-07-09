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
}

interface FlexOptimizeResult {
  placements: FlexPlacement[];
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
}

// ── Cost weights (build effort, lower is better) ───────
const COST_CUT = 2;
const COST_WIRE = 4; // strip + 2 joints: pricier than a cut
const COST_WIRE_LEN = 0.3;
const COST_SPAN = 0.2; // flexible pin-to-pin manhattan length
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
}

function holeKey(row: number, col: number): string {
  return `${row},${col}`;
}

function manhattan(a: BoardPosition, b: BoardPosition): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
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
  netAssignments: NetAssignment[]
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
        fixedBodies.push({ p1: { row: p1.row, col: p1.col }, p2: { row: p2.row, col: p2.col } });
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

  // ── Current solution state ───────────────────────────
  const pos = new Map<string, Placement>();
  const seed = computeAutoPlace(board, components, componentDefs, netAssignments);
  for (const p of seed.placements) {
    pos.set(p.componentId, { p1: p.boardPos, p2: p.flexibleEndPos });
  }

  const virtualComponents = (): Component[] =>
    components.map((c) => {
      const p = pos.get(c.id);
      return p ? { ...c, boardPos: p.p1, flexibleEndPos: p.p2 } : c;
    });

  // ── Full evaluator: run the router, price the completion ──
  // `bad` marks layouts with unresolved conflicts or starved nets (a net
  // left without a free hole to attach a wire) — never settle for those.
  const fullCost = (): { cost: number; bad: boolean } => {
    const plan = deriveCompletion(board, virtualComponents(), componentDefs, nets, netAssignments);
    let cost =
      plan.cuts.length * COST_CUT +
      plan.wires.length * COST_WIRE +
      (plan.unresolvedConflicts + plan.issues.length) * COST_UNRESOLVED;
    for (const w of plan.wires) {
      cost += COST_WIRE_LEN * Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
    }
    for (const p of pos.values()) {
      cost += COST_SPAN * manhattan(p.p1, p.p2);
      if (p.p1.row !== p.p2.row && p.p1.col !== p.p2.col) cost += DIAGONAL_PENALTY;
    }
    return { cost, bad: plan.unresolvedConflicts > 0 || plan.issues.length > 0 };
  };

  // ── Geometric validity of a candidate against everything else ──
  const isValid = (selfId: string, p1: BoardPosition, p2: BoardPosition): boolean => {
    for (const rect of rigidRects) {
      if (bodyIntersectsRect(p1, p2, rect)) return false;
    }
    for (const h of corridorHoles(p1, p2)) {
      if (h.row === p1.row && h.col === p1.col) continue;
      if (h.row === p2.row && h.col === p2.col) continue;
      if (hard.has(holeKey(h.row, h.col))) return false;
    }
    const clashes = (other: Placement): boolean =>
      segmentsIntersect(p1, p2, other.p1, other.p2) ||
      bodiesTooClose(p1, p2, other.p1, other.p2) ||
      // endpoints inside the other's corridor and vice versa
      pointSegmentDistance(p1, other.p1, other.p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(p2, other.p1, other.p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(other.p1, p1, p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6 ||
      pointSegmentDistance(other.p2, p1, p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6;

    for (const body of fixedBodies) {
      if (clashes(body)) return false;
    }
    for (const [id, p] of pos) {
      if (id !== selfId && clashes(p)) return false;
    }
    return true;
  };

  const endpointFree = (row: number, col: number): boolean =>
    row >= 0 && row < board.rows && col >= 0 && col < board.cols &&
    !hard.has(holeKey(row, col)) && !blocked.has(holeKey(row, col)) &&
    ![...pos.values()].some(
      (p) =>
        pointSegmentDistance({ row, col }, p.p1, p.p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6
    );

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
        const a = netAssignments.find(
          (x) => x.componentId === comp.id && x.pinId === pin.pinId
        );
        if (a) add(a.netId, pin.row, pin.col, pin.col);
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

  // ── Re-place one part optimally (rip-up must be done by caller) ──
  const findBest = (m: Movable): { cand: Placement; cost: number } | null => {
    const strips = netStripsFor();

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

    // Rank all span-valid pairs cheaply, keep the best TOP_K
    interface Scored extends Placement {
      score: number;
    }
    const top: Scored[] = [];
    const maxSpan = Math.ceil(m.max);
    for (const p1 of pool1) {
      const dA = offNetCost(distToNet(strips, p1, m.netA));
      for (let r = p1.row - maxSpan; r <= p1.row + maxSpan; r++) {
        for (let c = p1.col - maxSpan; c <= p1.col + maxSpan; c++) {
          const d = Math.hypot(r - p1.row, c - p1.col);
          if (d < m.min - 1e-6 || d > m.max + 1e-6) continue;
          const p2 = { row: r, col: c };
          const diag = r !== p1.row && c !== p1.col ? DIAGONAL_PENALTY : 0;
          const score =
            manhattan(p1, p2) + diag + dA + offNetCost(distToNet(strips, p2, m.netB));
          if (top.length === MAX_EVALS && score >= top[top.length - 1].score) continue;
          if (!endpointFree(r, c)) continue;
          // Diversity: an attractive strip pair may fill at most a few slots,
          // so the full evaluator always sees alternatives on other strips
          const rowPair = `${p1.row}:${r}`;
          const same = top.filter((t) => `${t.p1.row}:${t.p2.row}` === rowPair);
          if (same.length >= MAX_PER_ROW_PAIR) {
            const worstSame = same[same.length - 1];
            if (score >= worstSame.score) continue;
            top.splice(top.indexOf(worstSame), 1);
          }
          top.push({ p1, p2, score });
          top.sort((a, b) => a.score - b.score);
          if (top.length > MAX_EVALS) top.pop();
        }
      }
    }

    // Full-evaluate in rank order. Stop after TOP_K once a placement exists
    // that leaves every net connectable; keep digging (up to MAX_EVALS)
    // while all evaluated candidates starve a net.
    let best: { cand: Placement; cost: number; bad: boolean } | null = null;
    let evals = 0;
    for (const cand of top) {
      if (!isValid(m.comp.id, cand.p1, cand.p2)) continue;
      pos.set(m.comp.id, { p1: cand.p1, p2: cand.p2 });
      const r = fullCost();
      pos.delete(m.comp.id);
      evals++;
      if (!best || r.cost < best.cost) {
        best = { cand: { p1: cand.p1, p2: cand.p2 }, cost: r.cost, bad: r.bad };
      }
      if (evals >= TOP_K && best && !best.bad) break;
    }
    return best;
  };

  // ── Hill-climb: rip up and re-place until no sweep improves ──
  let currentCost = fullCost().cost;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improved = false;
    for (const m of movables) {
      const had = pos.get(m.comp.id);
      if (had) pos.delete(m.comp.id);
      const best = findBest(m);
      // An unplaced part is always placed if possible, even at a cost
      // increase; a placed one only moves when it beats its old spot.
      if (best && (!had || best.cost < currentCost - 1e-6)) {
        pos.set(m.comp.id, best.cand);
        currentCost = best.cost;
        improved = true;
      } else if (had) {
        pos.set(m.comp.id, had);
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
  };
}

// ── Stage A: arrange the rigid parts (simulated annealing) ──

// Proxy cost weights: half-perimeter wirelength pulls connected parts
// together, the bounding-box term keeps the arrangement compact. Springs
// keep two nets joined by a flexible within that part's span range — the
// crush penalty must beat the combined contraction gain (W_HPWL + W_BBOX
// per unit), otherwise compactness squeezes nets closer than the part fits.
const W_HPWL = 1;
const W_BBOX = 1.5;
const W_SPRING = 4;
const W_SPRING_ROW_SHARE = 2; // ~ one strip cut
const ANNEAL_T0 = 6;
const ANNEAL_T_END = 0.05;
const ANNEAL_BASE_ITERS = 8000;
const ANNEAL_ITERS_PER_PART = 4000;
const ANNEAL_MAX_ITERS = 48000;

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
function arrangeRigids(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  springs: FlexSpring[],
  spacing: number,
  bboxWeight: number,
  issues: string[]
): Map<string, RigidState> {
  interface MovableRigid {
    comp: Component;
    def: ComponentDef;
    // Per rotation: footprint extents and net-assigned pin offsets
    dims: Record<number, { maxRow: number; maxCol: number }>;
    pins: Record<number, { dr: number; dc: number; netId: string }[]>;
    assignmentCount: number;
  }

  const movables: MovableRigid[] = [];
  const fixedRects: RectI[] = [];
  const fixedFlexBodies: { p1: BoardPosition; p2: BoardPosition }[] = [];
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
      for (const rot of ROTATIONS) {
        const b = getComponentBounds(def, { row: 0, col: 0 }, rot);
        dims[rot] = { maxRow: b.maxRow, maxCol: b.maxCol };
        pins[rot] = getRotatedPinPositions(def, { row: 0, col: 0 }, rot).flatMap((p) => {
          const a = netAssignments.find(
            (x) => x.componentId === comp.id && x.pinId === p.pinId
          );
          return a ? [{ dr: p.row, dc: p.col, netId: a.netId }] : [];
        });
      }
      const assignmentCount = netAssignments.filter((x) => x.componentId === comp.id).length;
      movables.push({ comp, def, dims, pins, assignmentCount });
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
      if (p1 && p2) fixedFlexBodies.push({ p1, p2 });
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
    if (m.comp.boardPos) {
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
      if (bodyIntersectsRect(f.p1, f.p2, rect)) return false;
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

    for (const m of movables) {
      const st = states.get(m.comp.id);
      if (!st) continue;
      for (const p of m.pins[st.rot]) {
        touch(superKey(p.netId), p.netId, st.row + p.dr, st.col + p.dc);
      }
      const rect = rectFor(m, st);
      bMinR = Math.min(bMinR, rect.minRow); bMaxR = Math.max(bMaxR, rect.maxRow);
      bMinC = Math.min(bMinC, rect.minCol); bMaxC = Math.max(bMaxC, rect.maxCol);
    }

    let cost = 0;
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
  for (const m of unseeded) {
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
  const rand = mulberry32(0x5eed);
  const iters = Math.min(
    ANNEAL_MAX_ITERS,
    ANNEAL_BASE_ITERS + ANNEAL_ITERS_PER_PART * active.length
  );
  const cooling = Math.pow(ANNEAL_T_END / ANNEAL_T0, 1 / iters);
  let temperature = ANNEAL_T0;
  let cost = proxyCost();
  let bestCost = cost;
  let bestStates = new Map(Array.from(states, ([k, v]) => [k, { ...v }]));

  for (let i = 0; i < iters; i++, temperature *= cooling) {
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
export function computeAutoLayout(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[]
): AutoLayoutResult {
  const issues: string[] = [];
  const baseBoard: Board = { ...board, cuts: [], wires: [] };

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
  const starvation = (list: string[]) =>
    list.filter((i) => i.includes("no free hole") || i.includes("no valid position") || i.includes("no free spot")).length;

  let rigidStates = new Map<string, RigidState>();
  let flexResult: FlexOptimizeResult | null = null;
  let attemptIssues: string[] = [];
  const attempts = [
    { spacing: 1, bboxWeight: W_BBOX },
    { spacing: 2, bboxWeight: W_BBOX },
    { spacing: 3, bboxWeight: W_BBOX / 2 },
    { spacing: 4, bboxWeight: W_BBOX / 4 },
  ];
  for (const { spacing, bboxWeight } of attempts) {
    const tryIssues: string[] = [];
    const tryStates = arrangeRigids(
      baseBoard, stageAComponents, componentDefs, netAssignments, springs, spacing, bboxWeight, tryIssues
    );
    const arranged = stageAComponents.map((c) => {
      const st = tryStates.get(c.id);
      return st ? { ...c, boardPos: { row: st.row, col: st.col }, rotation: st.rot } : c;
    });
    const tryFlex = optimizeFlexibles(baseBoard, arranged, componentDefs, nets, netAssignments);
    tryIssues.push(...tryFlex.issues);
    const better =
      !flexResult || starvation(tryIssues) < starvation(attemptIssues);
    if (better) {
      rigidStates = tryStates;
      flexResult = tryFlex;
      attemptIssues = tryIssues;
    }
    if (starvation(tryIssues) === 0) break;
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

  return { placements, cuts: flexResult!.cuts, wires: flexResult!.wires, issues };
}
