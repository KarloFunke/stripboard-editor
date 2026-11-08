import { pinKey } from "./keys";
import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentPinPositions } from "./boardLayout";
import { copperOf } from "./boardPattern";

export interface StripSegment {
  row: number;
  startCol: number;
  endCol: number; // inclusive
  // Copper running down a column (a board with a pattern): it covers rows
  // row..endRow of the one column startCol === endCol
  endRow?: number;
  netIds: string[];
}

/** Find which segment a hole belongs to, or -1 if none */
export function findSegmentIndex(
  segments: StripSegment[],
  row: number,
  col: number
): number {
  return segments.findIndex(
    (s) => row >= s.row && row <= (s.endRow ?? s.row) && col >= s.startCol && col <= s.endCol
  );
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
    netOfPin.set(pinKey(a.componentId, a.pinId), a.netId);
  }
  const pinsByRow = new Map<number, { col: number; netId: string | undefined }[]>();
  for (const comp of components) {
    if (!comp.boardPos) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    const pins = getComponentPinPositions(comp, def);
    for (const pin of pins) {
      if (!pinsByRow.has(pin.row)) pinsByRow.set(pin.row, []);
      pinsByRow.get(pin.row)!.push({ col: pin.col, netId: netOfPin.get(pinKey(comp.id, pin.pinId)) });
    }
  }
  const cutsByRow = new Map<number, Board["cuts"]>();
  for (const cut of board.cuts) {
    if (!cutsByRow.has(cut.row)) cutsByRow.set(cut.row, []);
    cutsByRow.get(cut.row)!.push(cut);
  }

  if (board.pattern) return patternSegments(board, pinsByRow);

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

/**
 * The copper of a board with a pattern, as straight runs: along a row, down
 * a column, and a hole no copper leaves on its own. Where copper turns a
 * corner, the two runs share that place. A run may pass places with no hole.
 */
function patternSegments(
  board: Board,
  pinsByRow: Map<number, { col: number; netId: string | undefined }[]>
): StripSegment[] {
  const { rows, cols } = board;
  const copper = copperOf(board.pattern!.map);
  const drilled = new Set<number>();
  const cutRight = new Set<number>();
  const cutDown = new Set<number>();
  for (const cut of board.cuts) {
    const at = cut.row * cols + cut.col;
    (cut.kind === "hole" ? drilled : cut.kind === "below" ? cutDown : cutRight).add(at);
  }
  const right = (i: number) => copper.right[i] === 1 && !cutRight.has(i) && !drilled.has(i) && !drilled.has(i + 1);
  const down = (i: number) => copper.down[i] === 1 && !cutDown.has(i) && !drilled.has(i) && !drilled.has(i + cols);
  // a pin where the board has no hole touches no copper
  const netsIn = (row: number, from: number, to: number, into: Set<string>) => {
    for (const pin of pinsByRow.get(row) ?? []) {
      if (pin.col >= from && pin.col <= to && pin.netId !== undefined && copper.hole[row * cols + pin.col]) into.add(pin.netId);
    }
  };

  // Down the columns first: a hole on such a run is no lone pad
  const onRun = new Uint8Array(rows * cols);
  const columns: StripSegment[] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows - 1; row++) {
      if (!down(row * cols + col)) continue;
      let end = row + 1;
      while (end < rows - 1 && down(end * cols + col)) end++;
      const nets = new Set<string>();
      for (let r = row; r <= end; r++) {
        onRun[r * cols + col] = 1;
        netsIn(r, col, col, nets);
      }
      columns.push({ row, startCol: col, endCol: col, endRow: end, netIds: [...nets] });
      row = end;
    }
  }

  const segments: StripSegment[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!copper.hole[i] && !right(i)) continue;
      let end = col;
      while (end < cols - 1 && right(row * cols + end)) end++;
      if (end > col || !onRun[i]) {
        const nets = new Set<string>();
        netsIn(row, col, end, nets);
        segments.push({ row, startCol: col, endCol: end, netIds: [...nets] });
      }
      col = end;
    }
  }
  return [...segments, ...columns];
}
