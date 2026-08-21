import { holeKey } from "./keys";
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
import { getComponentBounds, getFlexiblePinPositions } from "./boardLayout";
import { computeStripSegments, StripSegment } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { WireObstacleIndex, WireObstacles } from "./flexGeometry";
import { collectBoardPins, collectOccupiedHoles } from "./boardPins";
import { deriveCuts, upgradeCutsToDrills } from "./cutPlanning";
import { deriveWires } from "./wireRouting";

export interface AutoFinishResult {
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
}

// The raw completion derivation, also used as the layout optimizer's cost
// evaluator: what would it take to make this placement work?
export interface CompletionPlan {
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
  unresolvedConflicts: number;
  // Nets left without a free hole for a needed or future wire — the layout
  // optimizer uses these to target its repair moves
  starvedNetIds: string[];
  // Pin positions of the exact strip groups that ran out of free holes:
  // repair moves should clear the air around these spots, not around every
  // pin the net has
  starvedPinPositions: BoardPosition[];
  // Total extra effective wire length (holes) the chosen wires pay for
  // being messy: long off-axis runs and crossings over components. The
  // layout evaluator prices this like real wire length.
  wireMess: number;
  // Link wires that had to share a component pin's hole (soldered into the
  // joint) because their segment had no free hole. Legal but last-resort:
  // the ladder keeps exploring alternatives while any remain.
  sharedJoints: number;
}

/**
 * Derive the cuts and link wires that complete the given placement: cuts so
 * no segment carries two nets (floating pins get isolated too), then jumper
 * wires so every net forms one connected group. Existing cuts and wires are
 * kept and only augmented. The result is verified with the existing checker.
 */
export function deriveCompletion(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  // Pin-joint sharing is a locked-layout rescue: free layouts never need it
  // (placement avoids the situation), and offering it there lets the
  // optimizer settle for joint-y variants that compact worse.
  // repairSlants re-places derived cuts to straighten slanted wires — a
  // full re-route per candidate, so callers enable it once on the final
  // plan, not on every evaluator call.
  // evalNets turns this into a cheap ranking evaluator for the placement
  // annealer: only the given nets are routed (the caller prices the rest
  // from a cached baseline), relays are skipped (they never fix
  // starvation, only tidiness), and the cosmetic drill upgrade plus the
  // final verification recompute are dropped.
  // drilledCutsOnly makes the router sever donated relay tails by drilling
  // out a tail hole instead of cutting beside it; the knife cuts that
  // remain after the upgrade below are priced by the caller. Running the
  // upgrade BEFORE routing was measured over the corpus and rejected: the
  // drills it can take early either cost a free hole the router needed
  // (0.35 knife cuts saved per board against 26 off-axis wires and 16
  // crossings) or are ones this pass takes anyway.
  opts?: { allowSharedJoints?: boolean; repairSlants?: boolean; evalNets?: Set<string>; drilledCutsOnly?: boolean }
): CompletionPlan {
  const cutIssues: string[] = [];
  const pins = collectBoardPins(board, components, componentDefs, netAssignments);
  const occupied = collectOccupiedHoles(board, components, componentDefs, pins);

  // Nets with assignments on still-unplaced components need reserve holes
  const compById = new Map(components.map((c) => [c.id, c]));
  const reserveNets = new Set<string>();
  for (const a of netAssignments) {
    const comp = compById.get(a.componentId);
    if (comp && !comp.boardPos && !comp.boardExcluded) reserveNets.add(a.netId);
  }

  const cuts = deriveCuts(board, pins, occupied, cutIssues, reserveNets);

  // Component geometry the wires should preferably not run over
  const obstacles: WireObstacles = { rects: [], bodies: [] };
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (p1 && p2) obstacles.bodies.push({ p1, p2 });
    } else {
      obstacles.rects.push(getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }
  // Shared across every routeWith attempt: obstacles don't depend on cuts,
  // so the pair memo keeps paying through repair re-routes and retries.
  const obstacleIndex = new WireObstacleIndex(obstacles);

  interface RouteAttempt {
    cuts: Cut[];
    segments: StripSegment[];
    wires: { from: BoardPosition; to: BoardPosition }[];
    extraCuts: Cut[];
    wireMess: number;
    sharedJoints: number;
    wireIssues: string[];
    starvedNetIds: string[];
    starvedPinPositions: BoardPosition[];
  }
  const routeWith = (cutsTry: Cut[]): RouteAttempt => {
    const boardWithCuts: Board = { ...board, cuts: [...board.cuts, ...cutsTry] };
    const segments = computeStripSegments(boardWithCuts, components, componentDefs, netAssignments);
    const connectivity = computeConnectivity(segments, board.wires);
    const wireIssues: string[] = [];
    const starvedNetIds: string[] = [];
    const starvedPinPositions: BoardPosition[] = [];
    const routeNets = opts?.evalNets ? nets.filter((n) => opts.evalNets!.has(n.id)) : nets;
    const { wires, extraCuts, wireMess, sharedJoints } = deriveWires(
      segments, connectivity, routeNets, pins, occupied, board.wires, reserveNets, obstacleIndex, wireIssues, starvedNetIds, starvedPinPositions,
      opts?.allowSharedJoints ?? false,
      opts?.evalNets !== undefined,
      opts?.drilledCutsOnly ?? false
    );
    return { cuts: cutsTry, segments, wires, extraCuts, wireMess, sharedJoints, wireIssues, starvedNetIds, starvedPinPositions };
  };

  let attempt = routeWith(cuts);

  // ── Slant repair: slide a derived cut to open a shared column ──
  // A cut placed for hole balance can sever the only column two fragments
  // share, forcing the router into a slanted wire two steps later — the
  // move a human fixes by nudging the cut. For each slanted wire, try the
  // legal alternative positions of the derived cuts on its two rows (legal
  // = still between the same neighboring pins) and keep a re-route that
  // has strictly fewer slants without starving anything.
  if (opts?.repairSlants) {
    const slantsOf = (a: RouteAttempt) => a.wires.filter((w) => w.from.col !== w.to.col);
    const pinsByRow = new Map<number, number[]>();
    for (const p of pins) {
      if (!pinsByRow.has(p.row)) pinsByRow.set(p.row, []);
      pinsByRow.get(p.row)!.push(p.col);
    }
    for (const cols of pinsByRow.values()) cols.sort((a, b) => a - b);
    const legalRange = (cut: Cut): [number, number] => {
      const cols = pinsByRow.get(cut.row) ?? [];
      let lo = 0;
      let hi = board.cols - 2;
      for (const c of cols) {
        if (c <= cut.col && c > lo) lo = c;
        if (c > cut.col && c - 1 < hi) hi = c - 1;
      }
      return [lo, hi];
    };
    // Every candidate is a full re-route: keep the search on a budget —
    // nearest slide positions first, a few per cut, a hard total cap.
    // (Sized when a re-route was ~10x dearer; on crowded boards the first
    // offender cluster exhausted 24 before later wires got a turn.)
    let budget = 60;
    outer: while (budget > 0) {
      const bad = slantsOf(attempt);
      if (bad.length === 0) break;
      for (const w of bad) {
        for (const cut of attempt.cuts) {
          if (cut.row !== w.from.row && cut.row !== w.to.row) continue;
          const [gLo, gHi] = legalRange(cut);
          const gs: number[] = [];
          for (let g = gLo; g <= gHi; g++) if (g !== cut.col) gs.push(g);
          gs.sort((a, b) => Math.abs(a - cut.col) - Math.abs(b - cut.col));
          for (const g of gs.slice(0, 7)) {
            // A hole cut's col IS a hole: it may not land on a pin or on an
            // endpoint of a caller-fixed wire (derived wires re-route).
            if (cut.kind === "hole" &&
                ((pinsByRow.get(cut.row) ?? []).includes(g) ||
                  board.wires.some((w) =>
                    (w.from.row === cut.row && w.from.col === g) ||
                    (w.to.row === cut.row && w.to.col === g)))) {
              continue;
            }
            if (budget-- <= 0) break outer;
            const cutsTry = attempt.cuts.map((c) => (c === cut ? { ...c, col: g } : c));
            const t = routeWith(cutsTry);
            if (
              t.starvedNetIds.length <= attempt.starvedNetIds.length &&
              t.sharedJoints <= attempt.sharedJoints &&
              slantsOf(t).length < bad.length
            ) {
              attempt = t;
              continue outer;
            }
          }
        }
      }
      break; // no slide improved anything
    }
  }

  const { segments, wires, extraCuts, wireMess, sharedJoints, wireIssues, starvedNetIds, starvedPinPositions } = attempt;

  if (opts?.evalNets) {
    // Evaluator mode: wires never merge different-net copper, so the
    // pre-wire connectivity already carries the conflict count.
    const conflicts = computeConnectivity(segments, board.wires).filter((g) => g.hasConflict).length;
    return {
      cuts: [...attempt.cuts, ...extraCuts],
      wires,
      issues: [...cutIssues, ...wireIssues],
      unresolvedConflicts: conflicts,
      starvedNetIds,
      starvedPinPositions,
      wireMess,
      sharedJoints,
    };
  }

  const noDrill = new Set<string>();
  for (const p of pins) noDrill.add(holeKey(p.row, p.col));
  for (const c of board.cuts) if (c.kind === "hole") noDrill.add(holeKey(c.row, c.col));
  // Relay tails severed by a drill own that hole; no other cut may claim it
  for (const c of extraCuts) if (c.kind === "hole") noDrill.add(holeKey(c.row, c.col));
  for (const w of [...board.wires, ...wires]) {
    noDrill.add(holeKey(w.from.row, w.from.col));
    noDrill.add(holeKey(w.to.row, w.to.col));
  }
  // Tail-severing cuts keep the kind the router chose: a between-cut by
  // default (a drilled flank could sever the relay copper between its two
  // hop wires), a drill on the sacrificed tail hole in drilled-cuts mode.
  const finalCuts = [...upgradeCutsToDrills(attempt.cuts, segments, occupied, noDrill, reserveNets), ...extraCuts];

  const finalBoard: Board = {
    ...board,
    cuts: [...board.cuts, ...finalCuts],
    wires: [...board.wires, ...wires.map((w, i) => ({ id: `af-${i}`, ...w }))],
  };
  const finalSegments = computeStripSegments(finalBoard, components, componentDefs, netAssignments);
  const finalConnectivity = computeConnectivity(finalSegments, finalBoard.wires);
  const unresolvedConflicts = finalConnectivity.filter((g) => g.hasConflict).length;

  return {
    cuts: finalCuts,
    wires,
    issues: [...cutIssues, ...wireIssues],
    unresolvedConflicts,
    starvedNetIds,
    starvedPinPositions,
    wireMess,
    sharedJoints,
  };
}

/**
 * Drilled-cuts-only final pass. Cut alignment slides cuts inside their dead
 * zones; a between-cut that was boxed in by wire endpoints at its original
 * position may have an open, sacrificable flank at its slid one. Rebuild
 * segments and occupancy for the finished board and try the drill upgrade
 * once more — wires stay exactly as routed, and drilling a flank hole never
 * changes which used holes share copper.
 */
export function drillRemainingCuts(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  cuts: Cut[],
  wires: { from: BoardPosition; to: BoardPosition }[]
): Cut[] {
  if (!cuts.some((c) => c.kind !== "hole")) return cuts;
  const pins = collectBoardPins(board, components, componentDefs, netAssignments);
  const occupied = collectOccupiedHoles(board, components, componentDefs, pins);
  const fullBoard: Board = { ...board, cuts: [...board.cuts, ...cuts] };
  const segments = computeStripSegments(fullBoard, components, componentDefs, netAssignments);
  const noDrill = new Set<string>();
  for (const p of pins) noDrill.add(holeKey(p.row, p.col));
  for (const c of fullBoard.cuts) if (c.kind === "hole") noDrill.add(holeKey(c.row, c.col));
  for (const w of [...board.wires, ...wires]) {
    noDrill.add(holeKey(w.from.row, w.from.col));
    noDrill.add(holeKey(w.to.row, w.to.col));
  }
  return upgradeCutsToDrills(cuts, segments, occupied, noDrill, new Set());
}

/**
 * User-facing wrapper around deriveCompletion: nothing is placed for
 * unplaced components; leftovers are reported as readable issues.
 */
export function computeAutoFinish(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  drilledCutsOnly = false
): AutoFinishResult {
  const plan = deriveCompletion(board, components, componentDefs, nets, netAssignments, { repairSlants: true, drilledCutsOnly });
  const issues = [...plan.issues];

  if (plan.unresolvedConflicts > 0) {
    issues.push(
      `${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved by adding cuts and wires`
    );
  }

  const unplaced = components.filter((c) => !c.boardPos && !c.boardExcluded).length;
  if (unplaced > 0) {
    issues.push(`${unplaced} component${unplaced > 1 ? "s" : ""} not placed yet`);
  }

  return { cuts: plan.cuts, wires: plan.wires, issues };
}
