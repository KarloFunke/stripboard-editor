import { pinKey } from "./keys";
import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentPinPositions } from "./boardLayout";
import { boardTopology, hasHole, hasHLink, hasVLink, tagAt } from "./boardTopology";

/**
 * One electrically continuous piece of copper.
 *
 * `row`/`startCol`/`endCol`/`endRow` are its bounding box, and for the
 * common shapes — a run along a row, a bus down a column, a lone hole —
 * the box *is* the copper. `holes` is filled in only when the run bends,
 * which a hand-drawn board map can do. Always go through `segmentContains`
 * and `segmentHoles`; never read the box directly to test membership.
 */
export interface StripSegment {
  row: number;
  startCol: number;
  endCol: number; // inclusive
  netIds: string[];
  endRow?: number; // inclusive; absent = row
  holes?: { row: number; col: number }[]; // set when the box is not solid
  label?: string; // tag carried by the holes, e.g. "+"
}

/** A plain run along a single row — what most solver heuristics assume */
export function isRowRun(s: StripSegment): boolean {
  return !s.holes && (s.endRow ?? s.row) === s.row;
}

/** Whether a hole sits on this segment's copper */
export function segmentContains(s: StripSegment, row: number, col: number): boolean {
  if (row < s.row || row > (s.endRow ?? s.row) || col < s.startCol || col > s.endCol) {
    return false;
  }
  if (!s.holes) return true;
  return s.holes.some((h) => h.row === row && h.col === col);
}

/** Every hole sitting on this segment's copper, in run order */
export function segmentHoles(s: StripSegment): { row: number; col: number }[] {
  if (s.holes) return s.holes;
  const holes: { row: number; col: number }[] = [];
  const endRow = s.endRow ?? s.row;
  for (let row = s.row; row <= endRow; row++) {
    for (let col = s.startCol; col <= s.endCol; col++) holes.push({ row, col });
  }
  return holes;
}

/** Find which segment a hole belongs to, or -1 if none */
export function findSegmentIndex(
  segments: StripSegment[],
  row: number,
  col: number
): number {
  return segments.findIndex((s) => segmentContains(s, row, col));
}

/**
 * Compute all copper segments for the board, with the nets of the pins
 * sitting on them.
 *
 * The board's own topology (which holes exist, which are joined) comes from
 * boardTopology; the user's cuts are then subtracted from it. What remains
 * is grouped into connected components.
 */
export function computeStripSegments(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): StripSegment[] {
  const topo = boardTopology(board);
  const rows = Math.min(board.rows, topo.rows);
  const cols = Math.min(board.cols, topo.cols);
  if (rows <= 0 || cols <= 0) return [];

  // A plain veroboard has no copper to discover: every row is one strip,
  // and the cuts on it are the only thing that breaks it up. That is the
  // scan below, and it is what runs for every board that is not drawn as a
  // map — which is most of them, thousands of times per solve.
  if (topo.plain) return rowStripSegments(board, components, componentDefs, netAssignments);

  // ── Pin nets, indexed by hole ──
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) {
    netOfPin.set(pinKey(a.componentId, a.pinId), a.netId);
  }
  const netsAtHole = new Map<number, Set<string>>();
  for (const comp of components) {
    if (!comp.boardPos) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      const netId = netOfPin.get(pinKey(comp.id, pin.pinId));
      if (netId === undefined) continue;
      const k = pin.row * board.cols + pin.col;
      let set = netsAtHole.get(k);
      if (!set) netsAtHole.set(k, (set = new Set()));
      set.add(netId);
    }
  }

  // ── The user's cuts, on top of the board's own copper ──
  // A between-cut severs one row link; a drilled hole removes the hole
  // altogether, and with it every link that reached it.
  const severed = new Set<number>(); // row*(cols-1)+col
  const drilled = new Set<number>(); // row*cols+col
  for (const cut of board.cuts) {
    if (cut.row < 0 || cut.row >= rows) continue;
    if (cut.kind === "hole") {
      if (cut.col >= 0 && cut.col < cols) drilled.add(cut.row * cols + cut.col);
    } else if (cut.col >= 0 && cut.col < cols - 1) {
      severed.add(cut.row * (cols - 1) + cut.col);
    }
  }

  const present = (r: number, c: number) =>
    hasHole(topo, r, c) && !drilled.has(r * cols + c);

  // ── Connected components over the link graph ──
  // Union-find with path halving; roots only key a map, so the smaller
  // index wins and there is no rank to carry.
  const parent = new Int32Array(rows * cols);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!present(r, c)) continue;
      if (
        c + 1 < cols && present(r, c + 1) &&
        hasHLink(topo, r, c) && !severed.has(r * (cols - 1) + c)
      ) {
        union(r * cols + c, r * cols + c + 1);
      }
      // A vertical link is the board's own copper; a row cut does not reach
      // it, but drilling either hole out does (handled by `present`).
      if (r + 1 < rows && present(r + 1, c) && hasVLink(topo, r, c)) {
        union(r * cols + c, (r + 1) * cols + c);
      }
    }
  }

  const membersOf = new Map<number, { row: number; col: number }[]>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!present(r, c)) continue;
      const root = find(r * cols + c);
      let list = membersOf.get(root);
      if (!list) membersOf.set(root, (list = []));
      list.push({ row: r, col: c });
    }
  }

  // ── Turn each component into a segment ──
  const segments: StripSegment[] = [];
  for (const holes of membersOf.values()) {
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    const netIdSet = new Set<string>();
    let label: string | null = null;
    for (const h of holes) {
      if (h.row < minRow) minRow = h.row;
      if (h.row > maxRow) maxRow = h.row;
      if (h.col < minCol) minCol = h.col;
      if (h.col > maxCol) maxCol = h.col;
      const nets = netsAtHole.get(h.row * cols + h.col);
      if (nets) for (const n of nets) netIdSet.add(n);
      if (label === null) label = tagAt(topo, h.row, h.col);
    }
    // The bounding box stands in for the hole list whenever it is solid,
    // which covers every row run, column bus and lone hole.
    const boxed = (maxRow - minRow + 1) * (maxCol - minCol + 1) === holes.length;
    const seg: StripSegment = {
      row: minRow,
      startCol: minCol,
      endCol: maxCol,
      netIds: Array.from(netIdSet),
    };
    if (maxRow !== minRow) seg.endRow = maxRow;
    if (!boxed) seg.holes = holes;
    if (label) seg.label = label;
    segments.push(seg);
  }

  // Stable order (top-to-bottom, left-to-right) so results are comparable
  // run to run — the solver's tie-breaks lean on array order.
  segments.sort((a, b) => a.row - b.row || a.startCol - b.startCol);
  return segments;
}

/**
 * Segments of a plain veroboard: one strip per row, split by the user's
 * cuts. The general path would find the same answer by walking the link
 * graph, but this is the shape the board has always had and it costs a
 * fraction of the work.
 */
function rowStripSegments(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): StripSegment[] {
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) {
    netOfPin.set(pinKey(a.componentId, a.pinId), a.netId);
  }
  const pinsByRow = new Map<number, { col: number; netId: string | undefined }[]>();
  for (const comp of components) {
    if (!comp.boardPos) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      if (!pinsByRow.has(pin.row)) pinsByRow.set(pin.row, []);
      pinsByRow.get(pin.row)!.push({ col: pin.col, netId: netOfPin.get(pinKey(comp.id, pin.pinId)) });
    }
  }
  const cutsByRow = new Map<number, Board["cuts"]>();
  for (const cut of board.cuts) {
    if (!cutsByRow.has(cut.row)) cutsByRow.set(cut.row, []);
    cutsByRow.get(cut.row)!.push(cut);
  }

  const segments: StripSegment[] = [];
  for (let row = 0; row < board.rows; row++) {
    // A boundary value B starts a new segment at column B: a between-cut at
    // X severs X | X+1, and a drilled hole at X isolates the hole itself.
    const boundarySet = new Set<number>([0]);
    for (const cut of cutsByRow.get(row) ?? []) {
      if (cut.kind === "hole") {
        boundarySet.add(cut.col);
        boundarySet.add(cut.col + 1);
      } else {
        boundarySet.add(cut.col + 1);
      }
    }
    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);
    const drilled = new Set(
      (cutsByRow.get(row) ?? []).filter((c) => c.kind === "hole").map((c) => c.col)
    );

    for (let i = 0; i < boundaries.length; i++) {
      const startCol = boundaries[i];
      const endCol = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : board.cols - 1;
      if (startCol > endCol) continue;
      // A drilled hole is gone, so it carries nothing.
      if (startCol === endCol && drilled.has(startCol)) continue;

      const netIdSet = new Set<string>();
      for (const pin of pinsByRow.get(row) ?? []) {
        if (pin.col >= startCol && pin.col <= endCol && pin.netId !== undefined) {
          netIdSet.add(pin.netId);
        }
      }
      segments.push({ row, startCol, endCol, netIds: Array.from(netIdSet) });
    }
  }
  return segments;
}
