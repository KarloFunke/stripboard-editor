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
  // Pre-compute all pin positions for placed components
  const allPins: { componentId: string; pinId: string; row: number; col: number }[] = [];
  for (const comp of components) {
    if (!comp.boardPos) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    const pins = getComponentPinPositions(comp, def);
    for (const pin of pins) {
      allPins.push({ componentId: comp.id, pinId: pin.pinId, row: pin.row, col: pin.col });
    }
  }

  const segments: StripSegment[] = [];

  for (let row = 0; row < board.rows; row++) {
    // Get sorted cut columns for this row
    const cutCols = board.cuts
      .filter((c) => c.row === row)
      .map((c) => c.col)
      .sort((a, b) => a - b);

    // Build segment boundaries
    // A cut at col X means "between col X and col X+1"
    // So segment goes from startCol to cutCol (inclusive), then next starts at cutCol+1
    const boundaries: number[] = [0];
    for (const cutCol of cutCols) {
      boundaries.push(cutCol + 1);
    }

    // Each boundary starts a segment that ends at the next boundary - 1 (or board.cols - 1)
    for (let i = 0; i < boundaries.length; i++) {
      const startCol = boundaries[i];
      const endCol = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : board.cols - 1;
      if (startCol > endCol) continue;

      // Find pins on this segment
      const pinsOnSegment = allPins.filter(
        (p) => p.row === row && p.col >= startCol && p.col <= endCol
      );

      // Look up nets for these pins
      const netIdSet = new Set<string>();
      for (const pin of pinsOnSegment) {
        const assignment = netAssignments.find(
          (a) => a.componentId === pin.componentId && a.pinId === pin.pinId
        );
        if (assignment) {
          netIdSet.add(assignment.netId);
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
