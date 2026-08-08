import { Board, BoardLayout } from "@/types";
import { boardTopology } from "./boardTopology";
import { formatBoardMap } from "./boardMap";

// Editing a board's layout, as opposed to reading it. Only the store calls
// these; everything that just wants to know what the copper does goes to
// boardTopology instead.

/** A layout that says nothing is stored as no layout at all. */
export function normalizeLayout(layout: BoardLayout | undefined): BoardLayout | undefined {
  return layout?.map.trim() ? { map: layout.map } : undefined;
}

/**
 * Move the layout with an inserted or deleted row/column, so cuts, wires
 * and the copper all shift together. The map is rewritten literally, which
 * loses its macros — a structural edit is a change to the picture, and the
 * picture is what gets kept.
 */
export function shiftLayout(
  board: Board,
  axis: "row" | "col",
  at: number,
  delta: 1 | -1,
): BoardLayout | undefined {
  if (!board.layout) return undefined;

  const t = boardTopology(board);
  const isRow = axis === "row";
  const rows = t.rows + (isRow ? delta : 0);
  const cols = t.cols + (isRow ? 0 : delta);
  if (rows < 1 || cols < 1) return board.layout;

  // Map a position in the new grid back to the old one; -1 = brand new.
  const srcRow = (r: number) => (!isRow ? r : delta === 1 ? (r < at ? r : r === at ? -1 : r - 1) : r < at ? r : r + 1);
  const srcCol = (c: number) => (isRow ? c : delta === 1 ? (c < at ? c : c === at ? -1 : c - 1) : c < at ? c : c + 1);

  const hole = new Uint8Array(rows * cols);
  const tag: (string | null)[] = new Array(rows * cols).fill(null);
  const hLink = new Uint8Array(rows * Math.max(0, cols - 1));
  const vLink = new Uint8Array(Math.max(0, rows - 1) * cols);

  for (let r = 0; r < rows; r++) {
    const sr = srcRow(r);
    for (let c = 0; c < cols; c++) {
      const sc = srcCol(c);
      if (sr < 0 || sc < 0) {
        // A fresh line: holes, but no copper — the user joins it up.
        hole[r * cols + c] = 1;
        continue;
      }
      hole[r * cols + c] = t.hole[sr * t.cols + sc];
      tag[r * cols + c] = t.tag?.[sr * t.cols + sc] ?? null;
      // Copper survives only where both ends came from neighbours.
      if (c < cols - 1 && srcCol(c + 1) === sc + 1 && sc < t.cols - 1) {
        hLink[r * (cols - 1) + c] = t.hLink[sr * (t.cols - 1) + sc];
      }
      if (r < rows - 1 && srcRow(r + 1) === sr + 1 && sr < t.rows - 1) {
        vLink[r * cols + c] = t.vLink[sr * t.cols + sc];
      }
    }
  }

  // Snaps sit on a boundary (13.5 = between 13 and 14), so a line inserted
  // at or before one pushes it along; deleting the hole on either side of
  // one closes the boundary up and takes the snap with it.
  const shiftLine = (v: number) => (delta === 1 ? (v > at ? v + 1 : v) : v > at ? v - 1 : v);
  const keep = (v: number) => !(delta === -1 && Math.abs(v - at) < 1);
  const snapX = (isRow ? t.snapX : t.snapX.filter(keep).map(shiftLine)).filter((v) => v > 0 && v < cols - 1);
  const snapY = (isRow ? t.snapY.filter(keep).map(shiftLine) : t.snapY).filter((v) => v > 0 && v < rows - 1);

  return { map: formatBoardMap({ rows, cols, hole, tag, hLink, vLink, snapX, snapY }) };
}
