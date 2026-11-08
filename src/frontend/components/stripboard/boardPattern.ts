import type { Board, BoardPosition, Component, ComponentDef, Cut } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getComponentPinPositions } from "./boardLayout";

// ── Boards with their own copper ───────────────────────
//
// Plain stripboard has no pattern: every row is one strip across the board.
// Any other board carries its copper as a map, a line per row of holes and
// a line between every two of them:
//
//   o-o-o o-o-o     a row: "o" a hole, "." a place without one, and between
//   |     |         two places "-" where copper joins them; in the line
//   o-.-o o-o-o     below, "|" under a place whose copper runs on down
//
// Copper may run past a place that has no hole. A board of R rows and C
// columns has 2R-1 lines of 2C-1 characters.

export interface Copper {
  rows: number;
  cols: number;
  // rows*cols, indexed row*cols+col: a hole there, copper on to the hole to
  // the right, copper on to the hole below
  hole: Uint8Array;
  right: Uint8Array;
  down: Uint8Array;
}

const parsed = new WeakMap<string[], Copper>();

export function copperOf(map: string[]): Copper {
  let copper = parsed.get(map);
  if (!copper) {
    const { rows, cols } = patternSize(map);
    copper = { rows, cols, hole: new Uint8Array(rows * cols), right: new Uint8Array(rows * cols), down: new Uint8Array(rows * cols) };
    const { hole, right, down } = copper;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) hole[r * cols + c] = map[r * 2][c * 2] === "o" ? 1 : 0;
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        right[i] = c < cols - 1 && map[r * 2][c * 2 + 1] === "-" ? 1 : 0;
        down[i] = r < rows - 1 && map[r * 2 + 1][c * 2] === "|" ? 1 : 0;
      }
    }
    parsed.set(map, copper);
  }
  return copper;
}

export function patternSize(map: string[]): { rows: number; cols: number } {
  return { rows: (map.length + 1) / 2, cols: (map[0].length + 1) / 2 };
}

/** The map of a board whose holes and copper the three functions describe. */
export function buildMap(
  rows: number,
  cols: number,
  hole: (row: number, col: number) => boolean,
  right: (row: number, col: number) => boolean,
  down: (row: number, col: number) => boolean,
): string[] {
  const map: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    let under = "";
    for (let c = 0; c < cols; c++) {
      line += hole(r, c) ? "o" : ".";
      under += r < rows - 1 && down(r, c) ? "|" : " ";
      if (c < cols - 1) {
        line += right(r, c) ? "-" : " ";
        under += " ";
      }
    }
    map.push(line);
    if (r < rows - 1) map.push(under);
  }
  return map;
}

/** A copy of a map's copper that may be changed, unlike the parsed one. */
export function editableCopper(map: string[]): Copper {
  const c = copperOf(map);
  return { rows: c.rows, cols: c.cols, hole: c.hole.slice(), right: c.right.slice(), down: c.down.slice() };
}

export function mapOf(copper: Copper): string[] {
  const { cols } = copper;
  return buildMap(
    copper.rows, cols,
    (r, c) => copper.hole[r * cols + c] === 1,
    (r, c) => copper.right[r * cols + c] === 1,
    (r, c) => copper.down[r * cols + c] === 1,
  );
}

/** Plain stripboard as a map: every row one strip. */
export function stripboardMap(rows: number, cols: number): string[] {
  return buildMap(rows, cols, () => true, () => true, () => false);
}

/** What is wrong with a map, or null for one a board can use. */
export function mapError(map: unknown): string | null {
  if (!Array.isArray(map) || map.length === 0 || map.length % 2 === 0) return "A board map needs an odd number of lines";
  const width = (map[0] as unknown as string)?.length;
  if (typeof width !== "number" || width % 2 === 0) return "A board map needs lines of odd length";
  for (let i = 0; i < map.length; i++) {
    const line = map[i];
    if (typeof line !== "string" || line.length !== width) return "Every line of a board map must be equally long";
    const ok = i % 2 === 0 ? /^[o.]([- ][o.])*$/ : /^[| ]( [| ])*$/;
    if (!ok.test(line)) return "A board map holds only o . - | and spaces";
  }
  return null;
}

const inBounds = (board: Board, row: number, col: number) =>
  row >= 0 && col >= 0 && row < board.rows && col < board.cols;

export function hasHole(board: Board, row: number, col: number): boolean {
  if (!inBounds(board, row, col)) return false;
  return !board.pattern || copperOf(board.pattern.map).hole[row * board.cols + col] === 1;
}

/** Copper joins this hole to the one on its right. */
export function joinsRight(board: Board, row: number, col: number): boolean {
  if (!inBounds(board, row, col) || col >= board.cols - 1) return false;
  return !board.pattern || copperOf(board.pattern.map).right[row * board.cols + col] === 1;
}

/** Copper joins this hole to the one below it. */
export function joinsDown(board: Board, row: number, col: number): boolean {
  if (!board.pattern || !inBounds(board, row, col) || row >= board.rows - 1) return false;
  return copperOf(board.pattern.map).down[row * board.cols + col] === 1;
}

/** Whether the board has copper where the cut would go. */
export function cutFits(board: Board, cut: Cut): boolean {
  const { row, col } = cut;
  if (cut.kind === "below") return joinsDown(board, row, col);
  if (cut.kind !== "hole") return joinsRight(board, row, col);
  // A drill on a pad no copper leaves would cut nothing
  return hasHole(board, row, col) && (!board.pattern ||
    joinsRight(board, row, col) || joinsRight(board, row, col - 1) ||
    joinsDown(board, row, col) || joinsDown(board, row - 1, col));
}

/** A placed part lies on the board: its body and all its pins. */
export function partOnBoard(board: Board, comp: Component, def: ComponentDef): boolean {
  if (!comp.boardPos) return true;
  if (!def.flexible) {
    const b = getComponentBounds(def, comp.boardPos, comp.rotation);
    if (b.minRow < 0 || b.minCol < 0 || b.maxRow >= board.rows || b.maxCol >= board.cols) return false;
  }
  return getComponentPinPositions(comp, def).every((p) => inBounds(board, p.row, p.col));
}

/**
 * Pins of placed parts and ends of wires where the board has no hole: they
 * may go there while being moved about, but connect to nothing and are
 * shown as wrong.
 */
export function offHoles(board: Board, components: Component[], componentDefs: ComponentDef[]): BoardPosition[] {
  if (!board.pattern) return [];
  const out: BoardPosition[] = [];
  for (const c of components) {
    const def = c.boardPos && resolveComponentDef(c, componentDefs);
    if (!def) continue;
    for (const p of getComponentPinPositions(c, def)) if (!hasHole(board, p.row, p.col)) out.push({ row: p.row, col: p.col });
  }
  for (const w of board.wires) {
    for (const end of [w.from, w.to]) if (!hasHole(board, end.row, end.col)) out.push(end);
  }
  return out;
}

/** What cannot stay on a board: parts and wires off its edges (by id), and cuts where it has no copper. */
export function misfits(board: Board, components: Component[], componentDefs: ComponentDef[]) {
  const parts = components.filter((c) => {
    const def = c.boardPos && resolveComponentDef(c, componentDefs);
    return def && !partOnBoard(board, c, def);
  }).map((c) => c.id);
  const wires = board.wires
    .filter((w) => !inBounds(board, w.from.row, w.from.col) || !inBounds(board, w.to.row, w.to.col))
    .map((w) => w.id);
  const cuts = board.cuts.filter((c) => !cutFits(board, c));
  return { parts, wires, cuts };
}
