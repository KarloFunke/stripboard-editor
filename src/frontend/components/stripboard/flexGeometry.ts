import { BoardPosition, ComponentDef } from "@/types";

// Radius (in hole pitches) around a flexible component's body line whose
// holes are blocked for pins and jumper endpoints.
export const FLEXIBLE_CORRIDOR_RADIUS = 0.5;

// Fat-body clearance between two flexible components: near the pins the part
// is only a thin lead, so the body segment is shrunk at each end. Each part
// carries a clearance halo around its shrunk segment; a pair's required
// distance is the contact minimum plus both halos. The default halo
// reproduces the classic rule (one free row/col between parallel bodies:
// 1 + 0.5 + 0.5 = 2) while a type set to 0 in the project config may sit
// adjacent. End-to-end stacking stays legal either way.
export const BODY_END_SHRINK = 0.5;
export const BODY_CONTACT_SEPARATION = 1;
export const DEFAULT_CLEARANCE = 0.5;

// Pin-to-pin span limits in hole pitches (Euclidean). Axial parts with a fat
// body (resistors, inductors) can't sit closer than 4 (5 holes end to end);
// small parts (caps, LEDs, small diodes) can stand upright at any spacing
// but shouldn't stretch.
const AXIAL_SPAN = { min: 4, max: 10 };
const COMPACT_SPAN = { min: 1, max: 6 };
// Fuse: never tighter than its default 3-hole reach, up to that plus 5.
const FUSE_SPAN = { min: 3, max: 8 };
const AXIAL_DEF_IDS = new Set(["def-resistor", "def-inductor"]);

export function spanLimits(def: ComponentDef): { min: number; max: number } {
  if (def.spanOverride) return def.spanOverride;
  if (def.id === "def-fuse") return FUSE_SPAN;
  return AXIAL_DEF_IDS.has(def.id) ? AXIAL_SPAN : COMPACT_SPAN;
}

/**
 * The clearance halo (hole pitches) around this part's body, from the
 * project's per-type config, defaulting to the classic half-hole halo.
 * Rigid parts always use 0: their footprint is their true body. Halos are
 * additive per pair, so a padded part keeps its extra air from an unpadded
 * neighbour too.
 */
export function clearanceOf(def: ComponentDef): number {
  return def.flexible ? def.clearance ?? DEFAULT_CLEARANCE : 0;
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

/**
 * Whether two segments lie on the same line and share more than a single
 * point. Used to keep wires readable: crossing at an angle and touching at
 * a shared endpoint are fine, running on top of each other is not.
 */
export function segmentsOverlapCollinear(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const dr = a2.row - a1.row;
  const dc = a2.col - a1.col;
  if (Math.abs(dr * (b2.col - b1.col) - dc * (b2.row - b1.row)) > 1e-9) return false; // not parallel
  if (Math.abs(dr * (b1.col - a1.col) - dc * (b1.row - a1.row)) > 1e-9) return false; // parallel, different line
  const along = (p: Pt) => p.row * dr + p.col * dc;
  const aMin = Math.min(along(a1), along(a2));
  const aMax = Math.max(along(a1), along(a2));
  const bMin = Math.min(along(b1), along(b2));
  const bMax = Math.max(along(b1), along(b2));
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > 1e-9;
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

/** Fat-body clearance check between two flexible parts. `clrSum` is the sum
 * of both parts' clearance halos on top of the contact minimum; the default
 * is two standard halos, i.e. the classic 2-pitch separation. */
export function bodiesTooClose(a1: Pt, a2: Pt, b1: Pt, b2: Pt, clrSum = 2 * DEFAULT_CLEARANCE): boolean {
  const [sa1, sa2] = shrinkSegment(a1, a2, BODY_END_SHRINK);
  const [sb1, sb2] = shrinkSegment(b1, b2, BODY_END_SHRINK);
  return segmentSegmentDistance(sa1, sa2, sb1, sb2) < BODY_CONTACT_SEPARATION + clrSum - 1e-6;
}

export interface FootprintRect {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

// ── Wire tidiness (soft costs, expressed as extra effective length) ──
// Humans wire strip-to-strip: vertical jumpers, copper for the horizontal
// travel. Any wire with horizontal travel pays every hole beyond
// WIRE_OFFAXIS_FREE twice over, so a vertical wire — or a pair of vertical
// hops through a relay strip — wins whenever one exists; one-hole diagonal
// hops between adjacent strips stay near-free (grid parts need them).
// Wires may still cross components (insulated), but each crossed component
// costs WIRE_CROSS_EXTRA holes so a clean detour of similar length wins.
// Crossing other wires stays free.
export const WIRE_OFFAXIS_FREE = 1;
export const WIRE_OFFAXIS_RATE = 2;
export const WIRE_CROSS_EXTRA = 8;

export interface WireObstacles {
  rects: FootprintRect[];
  bodies: { p1: Pt; p2: Pt }[];
}

/** Whether the segment p1-p2 touches the (unexpanded) rectangle */
export function segmentIntersectsRect(p1: Pt, p2: Pt, rect: FootprintRect): boolean {
  const inside = (p: Pt) =>
    p.row >= rect.minRow && p.row <= rect.maxRow && p.col >= rect.minCol && p.col <= rect.maxCol;
  if (inside(p1) || inside(p2)) return true;
  const a = { row: rect.minRow, col: rect.minCol };
  const b = { row: rect.minRow, col: rect.maxCol };
  const c = { row: rect.maxRow, col: rect.maxCol };
  const d = { row: rect.maxRow, col: rect.minCol };
  return (
    segmentsIntersect(p1, p2, a, b) ||
    segmentsIntersect(p1, p2, b, c) ||
    segmentsIntersect(p1, p2, c, d) ||
    segmentsIntersect(p1, p2, d, a)
  );
}

/** Extra effective length (holes) a wire pays for being messy */
export function wireExtraLength(from: Pt, to: Pt, obstacles: WireObstacles): number {
  const dr = Math.abs(to.row - from.row);
  const dc = Math.abs(to.col - from.col);
  let extra = 0;
  if (dc > 1e-9) {
    extra += WIRE_OFFAXIS_RATE * Math.max(0, Math.hypot(dr, dc) - WIRE_OFFAXIS_FREE);
  }
  // Bounding-box prefilter: this runs for thousands of candidate pairs per
  // routing pass, and almost every obstacle is nowhere near the wire.
  const minR = Math.min(from.row, to.row);
  const maxR = Math.max(from.row, to.row);
  const minC = Math.min(from.col, to.col);
  const maxC = Math.max(from.col, to.col);
  for (const rect of obstacles.rects) {
    if (rect.maxRow < minR || rect.minRow > maxR || rect.maxCol < minC || rect.minCol > maxC) continue;
    if (segmentIntersectsRect(from, to, rect)) extra += WIRE_CROSS_EXTRA;
  }
  for (const body of obstacles.bodies) {
    if (Math.max(body.p1.row, body.p2.row) < minR || Math.min(body.p1.row, body.p2.row) > maxR) continue;
    if (Math.max(body.p1.col, body.p2.col) < minC || Math.min(body.p1.col, body.p2.col) > maxC) continue;
    if (segmentsIntersect(from, to, body.p1, body.p2)) extra += WIRE_CROSS_EXTRA;
  }
  return extra;
}

/**
 * wireExtraLength with the obstacle scan bounded to the wire's own column
 * span, plus a pair memo. Candidate scoring calls it millions of times per
 * solve and a linear scan of every obstacle per call dominates large
 * solves; almost all evaluated pairs are short. Endpoints must be integer
 * board holes (the memo key packs them; boards stay far below 4096).
 */
export class WireObstacleIndex {
  private minRow: number[] = [];
  private maxRow: number[] = [];
  private rects: (FootprintRect | null)[] = [];
  private bodies: ({ p1: Pt; p2: Pt } | null)[] = [];
  private buckets: number[][] = [];
  private base = 0;
  private stamp: Int32Array;
  private gen = 0;
  private memo = new Map<number, number>();

  constructor(obstacles: WireObstacles) {
    let lo = Infinity;
    let hi = -Infinity;
    const spans: { minC: number; maxC: number }[] = [];
    for (const rect of obstacles.rects) {
      this.minRow.push(rect.minRow);
      this.maxRow.push(rect.maxRow);
      this.rects.push(rect);
      this.bodies.push(null);
      spans.push({ minC: rect.minCol, maxC: rect.maxCol });
    }
    for (const body of obstacles.bodies) {
      this.minRow.push(Math.min(body.p1.row, body.p2.row));
      this.maxRow.push(Math.max(body.p1.row, body.p2.row));
      this.rects.push(null);
      this.bodies.push(body);
      spans.push({ minC: Math.min(body.p1.col, body.p2.col), maxC: Math.max(body.p1.col, body.p2.col) });
    }
    for (const s of spans) {
      if (s.minC < lo) lo = Math.floor(s.minC);
      if (s.maxC > hi) hi = Math.ceil(s.maxC);
    }
    this.base = lo;
    if (spans.length > 0) {
      this.buckets = Array.from({ length: hi - lo + 1 }, () => []);
      spans.forEach((s, oi) => {
        for (let c = Math.floor(s.minC); c <= Math.ceil(s.maxC); c++) this.buckets[c - lo].push(oi);
      });
    }
    this.stamp = new Int32Array(spans.length);
  }

  extraLength(from: Pt, to: Pt): number {
    const a = from.row * 4096 + from.col;
    const b = to.row * 4096 + to.col;
    const key = a < b ? a * 16777216 + b : b * 16777216 + a;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const dr = Math.abs(to.row - from.row);
    const dc = Math.abs(to.col - from.col);
    let extra = 0;
    if (dc > 1e-9) {
      extra += WIRE_OFFAXIS_RATE * Math.max(0, Math.hypot(dr, dc) - WIRE_OFFAXIS_FREE);
    }
    const minR = Math.min(from.row, to.row);
    const maxR = Math.max(from.row, to.row);
    const cLo = Math.max(Math.min(from.col, to.col) - this.base, 0);
    const cHi = Math.min(Math.max(from.col, to.col) - this.base, this.buckets.length - 1);
    // A slanted wire's span touches several buckets; the stamp keeps each
    // obstacle counted once, matching wireExtraLength's flat scan exactly.
    const gen = ++this.gen;
    for (let c = cLo; c <= cHi; c++) {
      for (const oi of this.buckets[c]) {
        if (this.stamp[oi] === gen) continue;
        this.stamp[oi] = gen;
        if (this.maxRow[oi] < minR || this.minRow[oi] > maxR) continue;
        const rect = this.rects[oi];
        if (rect) {
          if (segmentIntersectsRect(from, to, rect)) extra += WIRE_CROSS_EXTRA;
        } else {
          const body = this.bodies[oi]!;
          if (segmentsIntersect(from, to, body.p1, body.p2)) extra += WIRE_CROSS_EXTRA;
        }
      }
    }
    this.memo.set(key, extra);
    return extra;
  }
}

/**
 * Whether a flexible part's body (pin-to-pin segment minus the thin lead
 * ends) enters a rigid component's footprint rectangle. This is a true
 * geometric test: hole-based corridor checks miss diagonals that thread
 * between grid points.
 */
export function bodyIntersectsRect(p1: Pt, p2: Pt, rect: FootprintRect, clr = DEFAULT_CLEARANCE): boolean {
  const [s1, s2] = shrinkSegment(p1, p2, BODY_END_SHRINK);
  // Anchored so the default halo gives exactly RIGID_BODY_CLEARANCE; a halo
  // of 0 lets the body touch the footprint edge (never enter it).
  const clearance = Math.max(0, RIGID_BODY_CLEARANCE + clr - DEFAULT_CLEARANCE);
  const minRow = rect.minRow - clearance;
  const maxRow = rect.maxRow + clearance;
  const minCol = rect.minCol - clearance;
  const maxCol = rect.maxCol + clearance;
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
