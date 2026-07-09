import { BoardPosition, ComponentDef } from "@/types";

// Radius (in hole pitches) around a flexible component's body line whose
// holes are blocked for pins and jumper endpoints.
export const FLEXIBLE_CORRIDOR_RADIUS = 0.5;

// Fat-body clearance between two flexible components: near the pins the part
// is only a thin lead, so the body segment is shrunk at each end; two parts'
// shrunk segments must stay MIN_BODY_SEPARATION apart (this forces one free
// row/col between parallel bodies, but allows end-to-end stacking).
export const BODY_END_SHRINK = 0.5;
export const MIN_BODY_SEPARATION = 2;

// Pin-to-pin span limits in hole pitches (Euclidean). Axial parts with a fat
// body (resistors, inductors) can't sit closer than ~5; small parts (caps,
// LEDs, small diodes) can stand upright at any spacing but shouldn't stretch.
const AXIAL_SPAN = { min: 5, max: 10 };
const COMPACT_SPAN = { min: 1, max: 6 };
const AXIAL_DEF_IDS = new Set(["def-resistor", "def-inductor"]);

export function spanLimits(def: ComponentDef): { min: number; max: number } {
  return AXIAL_DEF_IDS.has(def.id) ? AXIAL_SPAN : COMPACT_SPAN;
}

// Extra cost for placing a 2-pin part diagonally: roughly one strip cut
// dearer than straight, so diagonals only appear when they save real work.
export const DIAGONAL_PENALTY = 3;

// Clearance between a flexible part's body and a rigid component's footprint
// rectangle. Below 0.5 so a part running parallel one column beside a DIP's
// pin column stays legal, while anything over the footprint is rejected.
export const RIGID_BODY_CLEARANCE = 0.4;

interface Pt {
  row: number;
  col: number;
}

/** Distance from point p to the segment a-b, in hole pitches */
export function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dr = b.row - a.row;
  const dc = b.col - a.col;
  const lenSq = dr * dr + dc * dc;
  let t = 0;
  if (lenSq > 0) {
    t = ((p.row - a.row) * dr + (p.col - a.col) * dc) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const nr = a.row + t * dr - p.row;
  const nc = a.col + t * dc - p.col;
  return Math.sqrt(nr * nr + nc * nc);
}

/** All holes inside the blocked corridor along a flexible body (pins included) */
export function corridorHoles(p1: Pt, p2: Pt): BoardPosition[] {
  const holes: BoardPosition[] = [];
  const minRow = Math.min(p1.row, p2.row);
  const maxRow = Math.max(p1.row, p2.row);
  const minCol = Math.min(p1.col, p2.col);
  const maxCol = Math.max(p1.col, p2.col);
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (pointSegmentDistance({ row: r, col: c }, p1, p2) <= FLEXIBLE_CORRIDOR_RADIUS + 1e-6) {
        holes.push({ row: r, col: c });
      }
    }
  }
  return holes;
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.col - a.col) * (c.row - a.row) - (b.row - a.row) * (c.col - a.col);
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    Math.min(a.row, b.row) - 1e-9 <= p.row && p.row <= Math.max(a.row, b.row) + 1e-9 &&
    Math.min(a.col, b.col) - 1e-9 <= p.col && p.col <= Math.max(a.col, b.col) + 1e-9
  );
}

/** Whether segments a1-a2 and b1-b2 intersect or touch */
export function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-9 && onSegment(a1, a2, b1)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a1, a2, b2)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(b1, b2, a1)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(b1, b2, a2)) return true;
  return false;
}

/** Minimum distance between segments a1-a2 and b1-b2, 0 if they intersect */
export function segmentSegmentDistance(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2)
  );
}

/** Segment shrunk by `amount` at each end; collapses to its midpoint if too short */
export function shrinkSegment(p1: Pt, p2: Pt, amount: number): [Pt, Pt] {
  const dr = p2.row - p1.row;
  const dc = p2.col - p1.col;
  const len = Math.sqrt(dr * dr + dc * dc);
  if (len <= 2 * amount) {
    const mid = { row: (p1.row + p2.row) / 2, col: (p1.col + p2.col) / 2 };
    return [mid, mid];
  }
  const ur = dr / len;
  const uc = dc / len;
  return [
    { row: p1.row + ur * amount, col: p1.col + uc * amount },
    { row: p2.row - ur * amount, col: p2.col - uc * amount },
  ];
}

/** Fat-body clearance check between two flexible parts */
export function bodiesTooClose(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const [sa1, sa2] = shrinkSegment(a1, a2, BODY_END_SHRINK);
  const [sb1, sb2] = shrinkSegment(b1, b2, BODY_END_SHRINK);
  return segmentSegmentDistance(sa1, sa2, sb1, sb2) < MIN_BODY_SEPARATION - 1e-6;
}

export interface FootprintRect {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

/**
 * Whether a flexible part's body (pin-to-pin segment minus the thin lead
 * ends) enters a rigid component's footprint rectangle. This is a true
 * geometric test: hole-based corridor checks miss diagonals that thread
 * between grid points.
 */
export function bodyIntersectsRect(p1: Pt, p2: Pt, rect: FootprintRect): boolean {
  const [s1, s2] = shrinkSegment(p1, p2, BODY_END_SHRINK);
  const minRow = rect.minRow - RIGID_BODY_CLEARANCE;
  const maxRow = rect.maxRow + RIGID_BODY_CLEARANCE;
  const minCol = rect.minCol - RIGID_BODY_CLEARANCE;
  const maxCol = rect.maxCol + RIGID_BODY_CLEARANCE;
  const inside = (p: Pt) =>
    p.row >= minRow && p.row <= maxRow && p.col >= minCol && p.col <= maxCol;
  if (inside(s1) || inside(s2)) return true;
  const a = { row: minRow, col: minCol };
  const b = { row: minRow, col: maxCol };
  const c = { row: maxRow, col: maxCol };
  const d = { row: maxRow, col: minCol };
  return (
    segmentsIntersect(s1, s2, a, b) ||
    segmentsIntersect(s1, s2, b, c) ||
    segmentsIntersect(s1, s2, c, d) ||
    segmentsIntersect(s1, s2, d, a)
  );
}
