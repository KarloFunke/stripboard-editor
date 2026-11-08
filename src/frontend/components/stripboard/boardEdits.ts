// What the board editor does to a board's copper. Each edit works on an
// editable copy (see edit), so a map itself is never changed.
import { copperOf, editableCopper, mapOf, type Copper } from "./boardPattern";

// A place on the board; along a brush stroke, fractions of a hole
export interface Cell { row: number; col: number }
// Inclusive, top left to bottom right
export interface Area { r0: number; c0: number; r1: number; c1: number }

export function edit(map: string[], change: (c: Copper) => void): string[] {
  const copper = editableCopper(map);
  change(copper);
  return mapOf(copper);
}

// How near a brush must pass the middle between two places to act on the
// copper there, in holes
const BRUSH = 0.3;

/** The places along a stroke from a to b (in holes, fractions allowed), close enough to miss none. */
function along(a: Cell, b: Cell, step: number): Cell[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.row - a.row, b.col - a.col) / step));
  return Array.from({ length: n + 1 }, (_, k) => ({ row: a.row + ((b.row - a.row) * k) / n, col: a.col + ((b.col - a.col) * k) / n }));
}

/**
 * Copper set (or cleared) wherever a brush stroke from a to b passes between
 * two neighbouring places; with `only`, just between places along a row
 * ("across") or down a column ("down").
 */
export function brushCopper(c: Copper, a: Cell, b: Cell, on: boolean, only?: "across" | "down", reach = BRUSH) {
  const v = on ? 1 : 0;
  for (const p of along(a, b, 0.15)) {
    const r = Math.round(p.row);
    const col = Math.round(p.col);
    // between this row's places to the left and right of the point
    const left = Math.floor(p.col);
    if (only !== "down" && Math.hypot(p.row - r, p.col - (left + 0.5)) < reach && r >= 0 && r < c.rows && left >= 0 && left < c.cols - 1) {
      c.right[r * c.cols + left] = v;
    }
    // between this column's places above and below it
    const above = Math.floor(p.row);
    if (only !== "across" && Math.hypot(p.row - (above + 0.5), p.col - col) < reach && col >= 0 && col < c.cols && above >= 0 && above < c.rows - 1) {
      c.down[above * c.cols + col] = v;
    }
  }
}

/**
 * Copper taken away wherever a stroke from a to b passes between two places,
 * either way: along a strip it clears that strip, between two columns (or
 * rows) it cuts every strip it crosses. Its reach is small enough that the
 * two never meet.
 */
export function eraseCopper(c: Copper, a: Cell, b: Cell) {
  brushCopper(c, a, b, false, undefined, 0.25);
}

/** Holes made (or taken away) at every place a brush stroke from a to b goes over. */
export function brushHoles(c: Copper, a: Cell, b: Cell, on: boolean) {
  for (const p of along(a, b, 0.3)) {
    const row = Math.round(p.row);
    const col = Math.round(p.col);
    if (row >= 0 && col >= 0 && row < c.rows && col < c.cols) setHole(c, { row, col }, on);
  }
}

/** A hole made or taken away; the copper there stays, as it may run past a place without one. */
export function setHole(c: Copper, { row, col }: Cell, on: boolean) {
  c.hole[row * c.cols + col] = on ? 1 : 0;
}

/** Takes away all copper in the area and leading out of it. */
export function clearArea(c: Copper, a: Area) {
  for (let r = a.r0; r <= a.r1; r++) {
    for (let col = Math.max(0, a.c0 - 1); col <= a.c1; col++) c.right[r * c.cols + col] = 0;
  }
  for (let r = Math.max(0, a.r0 - 1); r <= a.r1; r++) {
    for (let col = a.c0; col <= a.c1; col++) c.down[r * c.cols + col] = 0;
  }
}

/** The area as strips along its rows (or down its columns), cut every `length` holes (0: unbroken). */
export function fillStrips(c: Copper, a: Area, down: boolean, length: number) {
  clearArea(c, a);
  for (let r = a.r0; r <= a.r1; r++) {
    for (let col = a.c0; col <= a.c1; col++) {
      const along = down ? r - a.r0 : col - a.c0;
      const last = down ? r === a.r1 : col === a.c1;
      if (last || (length > 0 && (along + 1) % length === 0)) continue;
      (down ? c.down : c.right)[r * c.cols + col] = 1;
    }
  }
}

/** An area's holes and the copper inside it, copied to be put down elsewhere. */
export function copyArea(map: string[], a: Area): Copper {
  return pieceOf(copperOf(map), a);
}

function pieceOf(from: Copper, a: Area): Copper {
  const rows = a.r1 - a.r0 + 1;
  const cols = a.c1 - a.c0 + 1;
  const piece: Copper = { rows, cols, hole: new Uint8Array(rows * cols), right: new Uint8Array(rows * cols), down: new Uint8Array(rows * cols) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const j = (a.r0 + r) * from.cols + a.c0 + c;
      piece.hole[i] = from.hole[j];
      // only copper that stays inside the area
      piece.right[i] = c < cols - 1 ? from.right[j] : 0;
      piece.down[i] = r < rows - 1 ? from.down[j] : 0;
    }
  }
  return piece;
}

/**
 * A copied piece put down with its top left at `at`, as far as the board
 * reaches: what was there goes, and copper leading into it is cut, so the
 * piece is just as it was copied. Returns the area it now covers.
 */
export function pasteArea(c: Copper, piece: Copper, at: Cell): Area {
  const area = { r0: at.row, c0: at.col, r1: Math.min(c.rows, at.row + piece.rows) - 1, c1: Math.min(c.cols, at.col + piece.cols) - 1 };
  clearArea(c, area);
  for (let r = area.r0; r <= area.r1; r++) {
    for (let col = area.c0; col <= area.c1; col++) {
      const i = r * c.cols + col;
      const j = (r - at.row) * piece.cols + (col - at.col);
      c.hole[i] = piece.hole[j];
      if (col < area.c1) c.right[i] = piece.right[j];
      if (r < area.r1) c.down[i] = piece.down[j];
    }
  }
  return area;
}

export function resized(map: string[], rows: number, cols: number): string[] {
  const old = copperOf(map);
  const next: Copper = { rows, cols, hole: new Uint8Array(rows * cols).fill(1), right: new Uint8Array(rows * cols), down: new Uint8Array(rows * cols) };
  for (let r = 0; r < Math.min(rows, old.rows); r++) {
    for (let c = 0; c < Math.min(cols, old.cols); c++) {
      const i = r * cols + c;
      const j = r * old.cols + c;
      next.hole[i] = old.hole[j];
      next.right[i] = old.right[j];
      next.down[i] = old.down[j];
    }
  }
  return mapOf(next);
}

const blank = (rows: number, cols: number): Copper =>
  ({ rows, cols, hole: new Uint8Array(rows * cols), right: new Uint8Array(rows * cols), down: new Uint8Array(rows * cols) });

/** A piece turned a quarter clockwise: hole (r, c) goes to (c, rows-1-r). */
export function turned(old: Copper): Copper {
  const next = blank(old.cols, old.rows);
  const cols = next.cols;
  for (let r = 0; r < old.rows; r++) {
    for (let c = 0; c < old.cols; c++) {
      const j = r * old.cols + c;
      next.hole[c * cols + (old.rows - 1 - r)] = old.hole[j];
      // copper to the right runs down now, copper down runs to the left
      if (old.right[j]) next.down[c * cols + (old.rows - 1 - r)] = 1;
      if (old.down[j]) next.right[c * cols + (old.rows - 2 - r)] = 1;
    }
  }
  return next;
}

/** A piece mirrored left to right ("across") or top to bottom ("down"). */
export function mirrored(old: Copper, way: "across" | "down"): Copper {
  const { rows, cols } = old;
  const next = blank(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const j = r * cols + c;
      const to = way === "across" ? r * cols + (cols - 1 - c) : (rows - 1 - r) * cols + c;
      next.hole[to] = old.hole[j];
      // the copper between two places stays between the same two places
      if (old.right[j]) next.right[way === "across" ? r * cols + (cols - 2 - c) : to] = 1;
      if (old.down[j]) next.down[way === "down" ? (rows - 2 - r) * cols + c : to] = 1;
    }
  }
  return next;
}

/** The whole board turned a quarter clockwise. */
export function rotated(map: string[]): string[] {
  return mapOf(turned(copperOf(map)));
}

/**
 * The area's piece changed by `change` (turned, mirrored) and put back about
 * the area's middle, as far as the board reaches. Where the area no longer
 * reaches, its holes stay without copper. Returns the area it now covers.
 */
export function changeArea(c: Copper, a: Area, change: (piece: Copper) => Copper): Area {
  const piece = change(pieceOf(c, a));
  clearArea(c, a);
  const place = (from: number, size: number, newSize: number, limit: number) =>
    Math.max(0, Math.min(limit - newSize, from + Math.floor((size - newSize) / 2)));
  const at = {
    row: place(a.r0, a.r1 - a.r0 + 1, piece.rows, c.rows),
    col: place(a.c0, a.c1 - a.c0 + 1, piece.cols, c.cols),
  };
  return pasteArea(c, piece, at);
}
