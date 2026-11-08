// Boards other than plain stripboard that the editor knows. Each is a fixed
// board, as bought; the map is built once from how its copper runs.
import type { BoardPattern } from "@/types";
import { buildMap } from "@/components/stripboard/boardPattern";

export interface BuiltinBoard {
  id: string;
  name: string;
  // One line for the picker: what the physical board is
  summary: string;
  rows: number;
  cols: number;
  map: string[];
  // A board bought in any size: a row at a time, columns `colStep` at a time
  resizable?: { colStep: number; map: (rows: number, cols: number) => string[] };
}

// A solderable breadboard (from Adafruit's Perma-Proto design files), turned
// to stand upright: two rails down either edge, 5-hole strips along the rows,
// and a gap of three pitches between the halves for a DIP.
function breadboard(rows: number): Pick<BuiltinBoard, "rows" | "cols" | "map"> {
  const cols = 18;
  const rail = (c: number) => c <= 1 || c >= 16;
  const strip = (c: number) => (c >= 3 && c <= 7) || (c >= 10 && c <= 14);
  const map = buildMap(
    rows, cols,
    (_, c) => rail(c) || strip(c),
    (_, c) => strip(c) && c !== 7 && c !== 14,
    (_, c) => rail(c),
  );
  return { rows, cols, map };
}

// ElectroCookie's snappable board comes apart into four quarters of 19 x 14
// holes. In a quarter the strips run in threes, with a rail down the outer
// column on either side; the rows at the top and bottom are grouped
// differently to clear the mounting holes. A half is two quarters side by
// side, the whole board two halves one above the other.
function electrocookie(across: number, down: number): Pick<BuiltinBoard, "rows" | "cols" | "map"> {
  const rows = 19 * down;
  const cols = 14 * across;
  // Where a quarter has holes, and where copper joins one to the next
  const hole = (r: number, c: number) => {
    if (r === 0 || r === 18) return c >= 2 && c <= 11;
    if (r === 1 || r === 17) return c >= 1 && c <= 12;
    return true;
  };
  const right = (r: number, c: number) => {
    if (c === 0 || c >= 12) return false;
    // edge rows: 2, 3, 3, 2 holes from column 2; the others strips of three from column 1
    return r === 0 || r === 18 ? c >= 2 && c <= 10 && c !== 3 && c !== 6 && c !== 9 : c % 3 !== 0;
  };
  const down_ = (r: number, c: number) => (c === 0 || c === 13) && r >= 2 && r < 16;
  const map = buildMap(
    rows, cols,
    (r, c) => hole(r % 19, c % 14),
    (r, c) => c % 14 !== 13 && right(r % 19, c % 14),
    (r, c) => r % 19 !== 18 && down_(r % 19, c % 14),
  );
  return { rows, cols, map };
}

// Vero's TriPad: every row cut into pieces of three holes
function tripad(rows: number, cols: number): Pick<BuiltinBoard, "rows" | "cols" | "map"> {
  return { rows, cols, map: buildMap(rows, cols, () => true, (_, c) => c % 3 !== 2, () => false) };
}

export const BUILTIN_BOARDS: BuiltinBoard[] = [
  {
    id: "tripad",
    name: "TriPad",
    summary: "Stripboard with every strip cut into pieces of three holes.",
    ...tripad(25, 39),
    resizable: { colStep: 3, map: (rows, cols) => tripad(rows, cols).map },
  },
  {
    id: "breadboard-half",
    name: "Solderable breadboard, half size",
    summary: "Laid out like a half-size breadboard (Adafruit Perma-Proto and alike): 5-hole strips, rails along both edges.",
    ...breadboard(30),
  },
  {
    id: "breadboard-full",
    name: "Solderable breadboard, full size",
    summary: "Laid out like a full-size breadboard: 5-hole strips, rails along both edges.",
    ...breadboard(60),
  },
  {
    id: "electrocookie-quarter",
    name: "ElectroCookie snappable, quarter",
    summary: "One snapped-off quarter: strips of three, a rail down either side.",
    ...electrocookie(1, 1),
  },
  {
    id: "electrocookie-half",
    name: "ElectroCookie snappable, half",
    summary: "Two quarters side by side, as the board snaps in half.",
    ...electrocookie(2, 1),
  },
  {
    id: "electrocookie-whole",
    name: "ElectroCookie snappable, whole",
    summary: "The whole board, all four quarters.",
    ...electrocookie(2, 2),
  },
];

export function builtinPattern(board: BuiltinBoard): BoardPattern {
  return { name: board.name, builtin: board.id, map: board.map };
}

/** The built-in board a pattern is, if any. */
export function builtinOf(pattern: BoardPattern | undefined): BuiltinBoard | undefined {
  return pattern?.builtin ? BUILTIN_BOARDS.find((b) => b.id === pattern.builtin) : undefined;
}

/** A board bought in any size, cut to rows x cols (cols a whole number of steps). */
export function sizedPattern(board: BuiltinBoard, rows: number, cols: number): BoardPattern {
  return { ...builtinPattern(board), map: board.resizable ? board.resizable.map(rows, cols) : board.map };
}

/** The nearest number of columns such a board comes in. */
export function snapCols(board: BuiltinBoard, cols: number): number {
  const step = board.resizable?.colStep ?? 1;
  return Math.max(step, Math.min(Math.floor(100 / step) * step, Math.round(cols / step) * step));
}
