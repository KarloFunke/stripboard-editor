import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentPinPositions } from "./boardLayout";

export interface StripSegment {
  row: number;
  startCol: number;
  endCol: number; // inclusive
  netIds: string[];
}

/** Compute all strip segments for the board, split by cuts, with net assignments */
export function computeStripSegments(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): StripSegment[] {
  // Pre-compute pin positions (with resolved nets) per row, and cuts per row,
  // so the per-segment work below stays linear.
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) {
    netOfPin.set(`${a.componentId}:${a.pinId}`, a.netId);
  }
  const pinsByRow = new Map<number, { col: number; netId: string | undefined }[]>();
  for (const comp of components) {
    if (!comp.boardPos) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    const pins = getComponentPinPositions(comp, def);
    for (const pin of pins) {
      if (!pinsByRow.has(pin.row)) pinsByRow.set(pin.row, []);
      pinsByRow.get(pin.row)!.push({ col: pin.col, netId: netOfPin.get(`${comp.id}:${pin.pinId}`) });
    }
  }
  const cutsByRow = new Map<number, Board["cuts"]>();
  for (const cut of board.cuts) {
    if (!cutsByRow.has(cut.row)) cutsByRow.set(cut.row, []);
    cutsByRow.get(cut.row)!.push(cut);
  }

  const segments: StripSegment[] = [];

  for (let row = 0; row < board.rows; row++) {
    const rowCuts = cutsByRow.get(row) ?? [];

    // Build segment boundaries. A boundary value B starts a new segment at col B.
    // - between-cut at col X: severs X | X+1, so a boundary at X+1.
    // - hole-cut at col X: isolates the hole, so boundaries at X and X+1.
    const boundarySet = new Set<number>([0]);
    for (const cut of rowCuts) {
      if (cut.kind === "hole") {
        boundarySet.add(cut.col);
        boundarySet.add(cut.col + 1);
      } else {
        boundarySet.add(cut.col + 1);
      }
    }
    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

    // Each boundary starts a segment that ends at the next boundary - 1 (or board.cols - 1)
    for (let i = 0; i < boundaries.length; i++) {
      const startCol = boundaries[i];
      const endCol = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : board.cols - 1;
      if (startCol > endCol) continue;

      // Nets of the pins on this segment
      const netIdSet = new Set<string>();
      for (const pin of pinsByRow.get(row) ?? []) {
        if (pin.col >= startCol && pin.col <= endCol && pin.netId !== undefined) {
          netIdSet.add(pin.netId);
        }
      }

      segments.push({
        row,
        startCol,
        endCol,
        netIds: Array.from(netIdSet),
      });
    }
  }

  return segments;
}
