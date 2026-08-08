import { Board } from "@/types";
import { parseBoardMap } from "./boardMap";

// ── What the copper actually is ────────────────────────
//
// One representation everything downstream reads: which holes exist, and
// which neighbouring pairs of them are joined by copper. A plain veroboard
// and a board drawn as a map both compile to this, so there is exactly one
// model to reason about and no board "kinds" anywhere else.

export interface BoardTopology {
  rows: number;
  cols: number;
  /** rows*cols — 1 where the board has a hole */
  hole: Uint8Array;
  /** rows*(cols-1) — 1 where copper joins (r,c) to (r,c+1) */
  hLink: Uint8Array;
  /** (rows-1)*cols — 1 where copper joins (r,c) to (r+1,c) */
  vLink: Uint8Array;
  /** Per-hole label, for the run it belongs to (e.g. "+"), or null */
  tag: (string | null)[] | null;
  /** Snap lines: the index of a hole-free column, or row, the board breaks along */
  snapX: number[];
  snapY: number[];
  /** True for a plain veroboard, so callers can take the cheap path */
  plain: boolean;
}

export function hasHole(t: BoardTopology, row: number, col: number): boolean {
  if (row < 0 || row >= t.rows || col < 0 || col >= t.cols) return false;
  return t.hole[row * t.cols + col] === 1;
}

export function hasHLink(t: BoardTopology, row: number, col: number): boolean {
  if (row < 0 || row >= t.rows || col < 0 || col >= t.cols - 1) return false;
  return t.hLink[row * (t.cols - 1) + col] === 1;
}

export function hasVLink(t: BoardTopology, row: number, col: number): boolean {
  if (row < 0 || row >= t.rows - 1 || col < 0 || col >= t.cols) return false;
  return t.vLink[row * t.cols + col] === 1;
}

export function tagAt(t: BoardTopology, row: number, col: number): string | null {
  if (!t.tag || row < 0 || row >= t.rows || col < 0 || col >= t.cols) return null;
  return t.tag[row * t.cols + col];
}

/**
 * Holes that must never be drilled out: those carrying copper down a
 * column. Drilling one severs a bus somewhere nobody asked to break it.
 */
export function carriesVerticalCopper(t: BoardTopology, row: number, col: number): boolean {
  return hasVLink(t, row, col) || hasVLink(t, row - 1, col);
}

// ── Builders ───────────────────────────────────────────

/** Plain veroboard: every row one strip running the full width. */
function plainTopology(rows: number, cols: number): BoardTopology {
  const hLink = new Uint8Array(rows * Math.max(0, cols - 1));
  hLink.fill(1);
  return {
    rows,
    cols,
    hole: new Uint8Array(rows * cols).fill(1),
    hLink,
    vLink: new Uint8Array(Math.max(0, rows - 1) * cols),
    tag: null,
    snapX: [],
    snapY: [],
    plain: true,
  };
}

// Parsing a map is the expensive step, and the solver asks for the same
// board's topology thousands of times per solve, so it is keyed on the map
// text itself — the one thing the answer actually depends on.
const byMap = new Map<string, BoardTopology | null>();

function fromMap(source: string): BoardTopology | null {
  const hit = byMap.get(source);
  if (hit !== undefined) return hit;
  const { issues: _issues, ...grid } = parseBoardMap(source);
  const built: BoardTopology | null =
    grid.rows === 0 || grid.cols === 0
      ? null
      : { ...grid, tag: grid.tag.some((x) => x !== null) ? grid.tag : null, plain: false };
  if (byMap.size > 32) byMap.clear();
  byMap.set(source, built);
  return built;
}

// A board with no map is described entirely by its size.
const bySize = new Map<string, BoardTopology>();

export function boardTopology(board: Board): BoardTopology {
  // A map carries its own size, so rows/cols are not part of the answer —
  // which is what lets the solver vary them per candidate for free.
  if (board.layout?.map) {
    const t = fromMap(board.layout.map);
    if (t) return t;
  }
  const key = `${board.rows}x${board.cols}`;
  let t = bySize.get(key);
  if (!t) {
    t = plainTopology(board.rows, board.cols);
    if (bySize.size > 64) bySize.clear();
    bySize.set(key, t);
  }
  return t;
}

/** The size a map implies, for keeping board.rows/cols in step with it. */
export function mapSize(source: string): { rows: number; cols: number } | null {
  const t = fromMap(source);
  return t ? { rows: t.rows, cols: t.cols } : null;
}

// ── Board-level predicates ─────────────────────────────
//
// The same questions asked against a Board rather than its topology, for
// callers that hold one and should not have to know this module's shape.

/** True when the board is anything other than a plain veroboard. */
export function hasCustomLayout(board: Board): boolean {
  return !boardTopology(board).plain;
}

/** Whether the board has a hole at this position at all. */
export function boardHasHole(board: Board, row: number, col: number): boolean {
  return hasHole(boardTopology(board), row, col);
}

/**
 * Whether a user cut between (row, col) and (row, col + 1) would do
 * anything. It would not where the board carries no copper across that gap
 * — a break it came with, the flank of a bus, or a missing hole.
 */
export function cutWouldBeRedundant(board: Board, row: number, col: number): boolean {
  return !hasHLink(boardTopology(board), row, col);
}
