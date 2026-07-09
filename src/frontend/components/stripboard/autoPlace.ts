import {
  Board,
  BoardPosition,
  Component,
  ComponentDef,
  NetAssignment,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  getComponentBounds,
  getComponentPinPositions,
  getFlexiblePinPositions,
  getRotatedBodyCells,
} from "./boardLayout";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import {
  DIAGONAL_PENALTY,
  FootprintRect,
  bodyIntersectsRect,
  corridorHoles,
  bodiesTooClose,
  segmentsIntersect,
  spanLimits,
} from "./flexGeometry";

export interface FlexPlacement {
  componentId: string;
  boardPos: BoardPosition;
  flexibleEndPos: BoardPosition;
}

export interface AutoPlaceResult {
  placements: FlexPlacement[];
  issues: string[];
}

// Soft cost for landing a pin on an empty strip instead of one already
// carrying the net: the connection then needs a jumper wire from auto-finish.
const EMPTY_GROUP_PENALTY = 8;

function holeKey(row: number, col: number): string {
  return `${row},${col}`;
}

interface Candidate {
  p1: BoardPosition;
  p2: BoardPosition;
  score: number;
}

// A candidate hole with an optional extra cost (e.g. expected jumper length)
type ScoredHole = BoardPosition & { bias?: number };

/**
 * Place all unplaced flexible 2-pin components onto the board: each pin goes
 * to a free hole on a strip group already carrying its net, or (with a cost
 * penalty) onto an empty strip that auto-finish can later join with a jumper.
 * Placements respect span limits, the blocked corridor of other parts, the
 * fat-body clearance, and the no-crossing rule. Rigid components are not
 * touched.
 */
export function computeAutoPlace(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): AutoPlaceResult {
  const issues: string[] = [];

  // Segments and groups are static during placement: we add pins, but no
  // cuts or wires, so the copper topology never changes.
  const segments = computeStripSegments(board, components, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, board.wires);
  const segToGroup = new Map<number, number>();
  connectivity.forEach((g, gi) => {
    for (const si of g.segmentIndices) segToGroup.set(si, gi);
  });
  // Nets present on each group; grows as virtual pins land
  const groupNets = connectivity.map((g) => new Set(g.netIds));

  // ── Occupancy ────────────────────────────────────────
  // hard: pins, rigid body cells, wire endpoints — a new corridor may not
  //       cover these and no endpoint may land on them.
  // blocked: additionally drilled holes and existing corridors — no endpoint
  //          may land there, but a new corridor may pass over.
  const hard = new Set<string>();
  const blocked = new Set<string>();
  const flexBodies: { p1: BoardPosition; p2: BoardPosition }[] = [];
  const rigidRects: FootprintRect[] = [];

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
        flexBodies.push({ p1: { row: p1.row, col: p1.col }, p2: { row: p2.row, col: p2.col } });
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

  const isFree = (row: number, col: number) =>
    !hard.has(holeKey(row, col)) && !blocked.has(holeKey(row, col));

  // ── Candidate holes per net ──────────────────────────

  const freeHolesOfGroups = (groupIdxs: number[]): BoardPosition[] => {
    const holes: BoardPosition[] = [];
    for (const gi of groupIdxs) {
      for (const si of connectivity[gi].segmentIndices) {
        const seg = segments[si];
        for (let c = seg.startCol; c <= seg.endCol; c++) {
          if (isFree(seg.row, c)) holes.push({ row: seg.row, col: c });
        }
      }
    }
    return holes;
  };

  // Only groups carrying the net alone: a contested group will be cut up,
  // so it is no safe landing area for the greedy (the optimizer prices it).
  const holesCarryingNet = (netId: string) =>
    freeHolesOfGroups(
      groupNets.flatMap((nets, gi) => (nets.size === 1 && nets.has(netId) ? [gi] : []))
    );

  const emptyGroupHoles = () =>
    freeHolesOfGroups(groupNets.flatMap((nets, gi) => (nets.size === 0 ? [gi] : [])));

  // ── Validation of a concrete placement ───────────────

  const isValidPlacement = (p1: BoardPosition, p2: BoardPosition): boolean => {
    for (const rect of rigidRects) {
      if (bodyIntersectsRect(p1, p2, rect)) return false;
    }
    for (const h of corridorHoles(p1, p2)) {
      if (h.row === p1.row && h.col === p1.col) continue;
      if (h.row === p2.row && h.col === p2.col) continue;
      // The corridor may cross drilled holes and free strip, but nothing solid
      if (hard.has(holeKey(h.row, h.col))) return false;
    }
    for (const body of flexBodies) {
      if (segmentsIntersect(p1, p2, body.p1, body.p2)) return false;
      if (bodiesTooClose(p1, p2, body.p1, body.p2)) return false;
    }
    return true;
  };

  // ── Candidate generation ─────────────────────────────

  const dist = (a: BoardPosition, b: BoardPosition) =>
    Math.sqrt((a.row - b.row) ** 2 + (a.col - b.col) ** 2);

  const nearestDist = (holes: BoardPosition[], h: BoardPosition) =>
    holes.reduce((best, x) => Math.min(best, dist(x, h)), Infinity);

  /** Score pairs (lower is better) and return the best valid one */
  const bestCandidate = (
    def: ComponentDef,
    holesA: ScoredHole[],
    holesB: ScoredHole[],
    penalty: number
  ): Candidate | null => {
    const { min, max } = spanLimits(def);
    const pairs: Candidate[] = [];
    for (const p1 of holesA) {
      for (const p2 of holesB) {
        if (p1.row === p2.row && p1.col === p2.col) continue;
        const d = dist(p1, p2);
        if (d < min - 1e-6 || d > max + 1e-6) continue;
        // Manhattan length prefers short, straight placements over diagonals
        const manhattan = Math.abs(p1.row - p2.row) + Math.abs(p1.col - p2.col);
        const diag = p1.row !== p2.row && p1.col !== p2.col ? DIAGONAL_PENALTY : 0;
        pairs.push({
          p1: { row: p1.row, col: p1.col },
          p2: { row: p2.row, col: p2.col },
          score: manhattan + diag + penalty + (p1.bias ?? 0) + (p2.bias ?? 0),
        });
      }
    }
    pairs.sort((a, b) => a.score - b.score);
    for (const pair of pairs) {
      if (isValidPlacement(pair.p1, pair.p2)) return pair;
    }
    return null;
  };

  const findPlacement = (def: ComponentDef, netA: string, netB: string): Candidate | null => {
    const presentA = holesCarryingNet(netA);
    const presentB = netB === netA ? presentA : holesCarryingNet(netB);
    if (presentA.length === 0 && presentB.length === 0) return null;

    let best = bestCandidate(def, presentA, presentB, 0);
    if (best) return best;

    // Fall back to one pin on an empty strip; auto-finish will jumper it.
    // Prefer empty holes close to where the stranded net lives (if anywhere).
    const empty = emptyGroupHoles();
    const tryEmpty = (present: BoardPosition[], other: BoardPosition[], swap: boolean) => {
      if (present.length === 0) return null;
      const scored: ScoredHole[] = empty.map((h) => ({
        ...h,
        bias: other.length > 0 ? 0.5 * nearestDist(other, h) : 0,
      }));
      const cand = bestCandidate(def, present, scored, EMPTY_GROUP_PENALTY);
      if (!cand) return null;
      return swap ? { p1: cand.p2, p2: cand.p1, score: cand.score } : cand;
    };
    const viaEmptyB = tryEmpty(presentA, presentB, false);
    const viaEmptyA = tryEmpty(presentB, presentA, true);
    best = [viaEmptyB, viaEmptyA]
      .filter((c): c is Candidate => c !== null)
      .sort((a, b) => a.score - b.score)[0] ?? null;
    return best;
  };

  // ── Greedy placement rounds ──────────────────────────

  interface Pending {
    comp: Component;
    def: ComponentDef;
    netA: string;
    netB: string;
  }

  const pending: Pending[] = [];
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
    pending.push({ comp, def, netA: a.netId, netB: b.netId });
  }

  const placements: FlexPlacement[] = [];

  const applyPlacement = (item: Pending, cand: Candidate) => {
    placements.push({ componentId: item.comp.id, boardPos: cand.p1, flexibleEndPos: cand.p2 });
    hard.add(holeKey(cand.p1.row, cand.p1.col));
    hard.add(holeKey(cand.p2.row, cand.p2.col));
    for (const h of corridorHoles(cand.p1, cand.p2)) blocked.add(holeKey(h.row, h.col));
    flexBodies.push({ p1: cand.p1, p2: cand.p2 });
    const claim = (pos: BoardPosition, netId: string) => {
      const si = segments.findIndex(
        (s) => s.row === pos.row && pos.col >= s.startCol && pos.col <= s.endCol
      );
      if (si >= 0 && segToGroup.has(si)) groupNets[segToGroup.get(si)!].add(netId);
    };
    claim(cand.p1, item.netA);
    claim(cand.p2, item.netB);
  };

  // Parts whose nets are already on the board anchor best, and each placement
  // can make another part's net present, so retry in rounds until stuck.
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    const presence = (n: string) => (groupNets.some((nets) => nets.has(n)) ? 1 : 0);
    pending.sort(
      (x, y) => presence(y.netA) + presence(y.netB) - (presence(x.netA) + presence(x.netB))
    );
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      const cand = findPlacement(item.def, item.netA, item.netB);
      if (cand) {
        applyPlacement(item, cand);
        pending.splice(i, 1);
        progress = true;
        break; // re-sort: this placement may anchor other parts better
      }
    }
  }

  for (const item of pending) {
    issues.push(`${item.comp.label}: no valid position found`);
  }

  return { placements, issues };
}
