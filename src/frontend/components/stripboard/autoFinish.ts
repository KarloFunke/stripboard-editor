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
  getComponentPinPositions,
  getFlexiblePinPositions,
  getRotatedBodyCells,
} from "./boardLayout";
import { computeStripSegments, StripSegment } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { corridorHoles } from "./flexGeometry";

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
}

interface BoardPin {
  row: number;
  col: number;
  // Net id for assigned pins. Unassigned pins get a unique key so they are
  // isolated with cuts: a floating pin silently tied to a net's strip would
  // change the circuit relative to the schematic.
  netKey: string;
  netId: string | null;
}

function holeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Collect every placed, on-board pin with its net key */
function collectBoardPins(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): BoardPin[] {
  const pins: BoardPin[] = [];
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      if (pin.row < 0 || pin.row >= board.rows || pin.col < 0 || pin.col >= board.cols) continue;
      const assignment = netAssignments.find(
        (a) => a.componentId === comp.id && a.pinId === pin.pinId
      );
      pins.push({
        row: pin.row,
        col: pin.col,
        netKey: assignment ? assignment.netId : `nc:${comp.id}:${pin.pinId}`,
        netId: assignment ? assignment.netId : null,
      });
    }
  }
  return pins;
}

/**
 * Holes that cannot take a jumper endpoint: component pins, body cells
 * (including everything under an IC), flexible-component body corridors,
 * existing wire endpoints, and drilled-out holes.
 */
function collectOccupiedHoles(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  pins: BoardPin[]
): Set<string> {
  const occupied = new Set<string>();

  for (const pin of pins) {
    occupied.add(holeKey(pin.row, pin.col));
  }

  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      // Block the corridor along the body line (handles diagonal placements;
      // for a vertical part this is exactly the holes between the pins).
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (!p1 || !p2) continue;
      for (const hole of corridorHoles(p1, p2)) {
        occupied.add(holeKey(hole.row, hole.col));
      }
    } else {
      for (const cell of getRotatedBodyCells(def, comp.boardPos, comp.rotation)) {
        occupied.add(holeKey(cell.row, cell.col));
      }
    }
  }

  for (const wire of board.wires) {
    occupied.add(holeKey(wire.from.row, wire.from.col));
    occupied.add(holeKey(wire.to.row, wire.to.col));
  }

  for (const cut of board.cuts) {
    if (cut.kind === "hole") occupied.add(holeKey(cut.row, cut.col));
  }

  return occupied;
}

/**
 * Pick the cut position inside the gap [colA, colB-1] that leaves both sides
 * the most usable free holes. A blind mid-gap cut can strand a pin in a
 * segment whose remaining holes all sit under an IC body — such a segment
 * can never take a jumper endpoint.
 */
function bestCutPosition(
  row: number,
  colA: number,
  colB: number,
  occupied: Set<string>
): number {
  const mid = (colA + colB - 1) / 2;
  let bestG = Math.floor(mid);
  let bestScore = -Infinity;
  for (let g = colA; g < colB; g++) {
    let left = 0;
    let right = 0;
    for (let c = colA + 1; c <= g; c++) if (!occupied.has(holeKey(row, c))) left++;
    for (let c = g + 1; c < colB; c++) if (!occupied.has(holeKey(row, c))) right++;
    const score = Math.min(left, right) * 1000 - Math.abs(g - mid);
    if (score > bestScore) {
      bestScore = score;
      bestG = g;
    }
  }
  return bestG;
}

/**
 * Derive the cuts needed so that no two different nets (or floating pins)
 * share a strip segment. Cuts between adjacent pins of different nets are
 * forced. Existing cuts are respected (augment, not regenerate).
 */
function deriveCuts(
  board: Board,
  pins: BoardPin[],
  occupied: Set<string>,
  issues: string[]
): Cut[] {
  // gap g on a row = the copper between col g and col g+1 is severed
  const severedGaps = new Set<string>();
  for (const cut of board.cuts) {
    if (cut.kind === "hole") {
      severedGaps.add(`${cut.row}:${cut.col - 1}`);
      severedGaps.add(`${cut.row}:${cut.col}`);
    } else {
      severedGaps.add(`${cut.row}:${cut.col}`);
    }
  }

  // Group pins per row and column
  const rows = new Map<number, Map<number, Set<string>>>();
  for (const pin of pins) {
    if (!rows.has(pin.row)) rows.set(pin.row, new Map());
    const cols = rows.get(pin.row)!;
    if (!cols.has(pin.col)) cols.set(pin.col, new Set());
    cols.get(pin.col)!.add(pin.netKey);
  }

  const newCuts: Cut[] = [];
  for (const [row, cols] of rows) {
    const sortedCols = Array.from(cols.keys()).sort((a, b) => a - b);

    for (const col of sortedCols) {
      if (cols.get(col)!.size > 1) {
        issues.push(`Pins of different nets overlap at row ${row + 1}, col ${col + 1}`);
      }
    }

    for (let i = 0; i + 1 < sortedCols.length; i++) {
      const colA = sortedCols[i];
      const colB = sortedCols[i + 1];
      const keysA = cols.get(colA)!;
      const keysB = cols.get(colB)!;
      const sameNet =
        keysA.size === 1 && keysB.size === 1 &&
        keysA.values().next().value === keysB.values().next().value;
      if (sameNet) continue;

      let alreadySevered = false;
      for (let g = colA; g < colB; g++) {
        if (severedGaps.has(`${row}:${g}`)) {
          alreadySevered = true;
          break;
        }
      }
      if (alreadySevered) continue;

      const cutCol = bestCutPosition(row, colA, colB, occupied);
      newCuts.push({ row, col: cutCol });
      severedGaps.add(`${row}:${cutCol}`);
    }
  }
  return newCuts;
}

/**
 * Connect each net's disconnected strip groups with jumper wires (Prim-style
 * MST: always join the nearest pair of free holes).
 */
function deriveWires(
  segments: StripSegment[],
  groups: { segmentIndices: number[] }[],
  nets: Net[],
  pins: BoardPin[],
  occupied: Set<string>,
  issues: string[]
): { from: BoardPosition; to: BoardPosition }[] {
  const segIndexAt = (row: number, col: number) =>
    segments.findIndex((s) => s.row === row && col >= s.startCol && col <= s.endCol);

  const segToGroup = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const si of g.segmentIndices) segToGroup.set(si, gi);
  });

  const freeHolesOfGroup = (gi: number): BoardPosition[] => {
    const holes: BoardPosition[] = [];
    for (const si of groups[gi].segmentIndices) {
      const seg = segments[si];
      for (let c = seg.startCol; c <= seg.endCol; c++) {
        if (!occupied.has(holeKey(seg.row, c))) holes.push({ row: seg.row, col: c });
      }
    }
    return holes;
  };

  const newWires: { from: BoardPosition; to: BoardPosition }[] = [];

  for (const net of nets) {
    const groupIdxs = new Set<number>();
    for (const pin of pins) {
      if (pin.netId !== net.id) continue;
      const si = segIndexAt(pin.row, pin.col);
      if (si >= 0 && segToGroup.has(si)) groupIdxs.add(segToGroup.get(si)!);
    }
    if (groupIdxs.size <= 1) continue;

    const [first, ...rest] = Array.from(groupIdxs);
    let connectedHoles = freeHolesOfGroup(first);
    const remaining = new Set(rest);

    while (remaining.size > 0) {
      let best: { from: BoardPosition; to: BoardPosition; group: number; dist: number } | null = null;
      for (const gi of remaining) {
        for (const hb of freeHolesOfGroup(gi)) {
          for (const ha of connectedHoles) {
            const dr = ha.row - hb.row;
            const dc = ha.col - hb.col;
            const dist = Math.sqrt(dr * dr + dc * dc);
            // Tiebreak: prefer straight vertical jumpers
            const better =
              !best ||
              dist < best.dist - 1e-9 ||
              (dist < best.dist + 1e-9 &&
                Math.abs(dc) < Math.abs(best.from.col - best.to.col));
            if (better) best = { from: ha, to: hb, group: gi, dist };
          }
        }
      }

      if (!best) {
        issues.push(`Net "${net.name}": no free hole to attach a link wire`);
        break;
      }

      newWires.push({ from: best.from, to: best.to });
      occupied.add(holeKey(best.from.row, best.from.col));
      occupied.add(holeKey(best.to.row, best.to.col));
      remaining.delete(best.group);
      connectedHoles = connectedHoles.filter(
        (h) => !(h.row === best!.from.row && h.col === best!.from.col)
      );
      connectedHoles.push(...freeHolesOfGroup(best.group));
    }
  }

  return newWires;
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
  netAssignments: NetAssignment[]
): CompletionPlan {
  const issues: string[] = [];
  const pins = collectBoardPins(board, components, componentDefs, netAssignments);
  const occupied = collectOccupiedHoles(board, components, componentDefs, pins);

  const cuts = deriveCuts(board, pins, occupied, issues);

  const boardWithCuts: Board = { ...board, cuts: [...board.cuts, ...cuts] };
  const segments = computeStripSegments(boardWithCuts, components, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, board.wires);

  const wires = deriveWires(segments, connectivity, nets, pins, occupied, issues);

  const finalBoard: Board = {
    ...boardWithCuts,
    wires: [...board.wires, ...wires.map((w, i) => ({ id: `af-${i}`, ...w }))],
  };
  const finalSegments = computeStripSegments(finalBoard, components, componentDefs, netAssignments);
  const finalConnectivity = computeConnectivity(finalSegments, finalBoard.wires);
  const unresolvedConflicts = finalConnectivity.filter((g) => g.hasConflict).length;

  return { cuts, wires, issues, unresolvedConflicts };
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
  netAssignments: NetAssignment[]
): AutoFinishResult {
  const plan = deriveCompletion(board, components, componentDefs, nets, netAssignments);
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
