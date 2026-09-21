// Where a part's body really is, in hole pitches, for everything that has to
// keep parts apart: the layout engines, the footprint editor and the board.
// The shapes come from the same package data the board is drawn from, so what
// the solver clears and what the user sees cannot drift apart.

import { Component, ComponentDef } from "@/types";
import { getComponentBounds, getFlexiblePinPositions, getRotatedPinPositions } from "./boardLayout";
import { Capsule, DEFAULT_CLEARANCE, FootprintRect, WireObstacles, bodyRectsClash, capsuleClashesRect, capsulesClash, pointSegmentDistance } from "./flexGeometry";
import { MM_PER_HOLE, PackageSpec, bodyWidth, drawnReversed, liesFlat, resolvePackage } from "./packageBodies";
import { rigidShape } from "./rigidBodies";

interface Pt {
  row: number;
  col: number;
}

type Packaged = { value?: string; package?: string };

export interface FlexProfile {
  /** The package the body is taken from; absent for a part that has none. */
  spec?: PackageSpec;
  /** Free board lines the user wants next to the body, on top of its size. */
  lines: number;
}

/**
 * What a flexible part's body is made of. A part with a real package needs no
 * clearance of its own, since its true width already keeps neighbours off; a
 * part with none keeps the classic one free line around a nominal body.
 */
export function flexProfile(def: ComponentDef, part: Packaged | undefined = def.part): FlexProfile {
  const resolved = resolvePackage(def, part?.value, part?.package);
  if (resolved?.kind !== "twoPin") return { lines: def.clearance ?? DEFAULT_CLEARANCE };
  return { spec: resolved.spec, lines: def.clearance ?? 0 };
}

/** The body of a flexible part whose leads go into p1 and p2. */
export function flexBody(profile: FlexProfile, p1: Pt, p2: Pt): Capsule {
  const dr = p2.row - p1.row;
  const dc = p2.col - p1.col;
  const span = Math.hypot(dr, dc);
  const mid = { row: (p1.row + p2.row) / 2, col: (p1.col + p2.col) / 2 };
  const spec = profile.spec;

  // Core of a body `len` long and `r` wide: the capsule's round ends reach
  // exactly to the ends of the body.
  const along = (len: number, r: number): Capsule => {
    const half = Math.max(0, len / 2 - r);
    if (span === 0 || half === 0) return { a: mid, b: mid, r };
    const ur = (dr / span) * half;
    const uc = (dc / span) * half;
    return { a: { row: mid.row - ur, col: mid.col - uc }, b: { row: mid.row + ur, col: mid.col + uc }, r };
  };

  // No package: the classic nominal body, a pitch wide and clear of the leads.
  if (!spec) return along(span, 0.5);

  const r = bodyWidth(spec) / 2 / MM_PER_HOLE;
  if (!liesFlat(spec, span * MM_PER_HOLE)) {
    const foot = drawnReversed(spec, p1, p2) ? p2 : p1;
    return { a: foot, b: foot, r };
  }
  if (spec.shape === "can") return { a: mid, b: mid, r };
  // The flange is what takes up the room on an LED, not the dome.
  if (spec.shape === "led") return { a: mid, b: mid, r: r * 1.16 };
  return along(spec.len / MM_PER_HOLE, r);
}

/** Whether two flexible parts, leads in a1-a2 and b1-b2, are too close. */
export function flexBodiesClash(pa: FlexProfile, a1: Pt, a2: Pt, pb: FlexProfile, b1: Pt, b2: Pt): boolean {
  return capsulesClash(flexBody(pa, a1, a2), flexBody(pb, b1, b2), Math.max(pa.lines, pb.lines));
}

/** Whether a flexible part is too close to a rigid body (see rigidBody). */
export function flexClashesRect(profile: FlexProfile, p1: Pt, p2: Pt, rect: FootprintRect): boolean {
  return capsuleClashesRect(flexBody(profile, p1, p2), rect, profile.lines);
}

/**
 * The body of a rigid part in hole-centre terms (see capsuleClashesRect): the
 * footprint's own cells, grown to the package's plastic where that overhangs.
 * Fractional only where the package really is. `reach` is the room taken by
 * what the package holds out over the board (a pot's shaft): other parts must
 * stay out of it, but it may hang over the board's edge.
 */
export function rigidGeometry(
  def: ComponentDef,
  boardPos: Pt,
  rotation: Component["rotation"],
  part: Packaged | undefined = def.part,
): { body: FootprintRect; reach?: FootprintRect } {
  const bounds = getComponentBounds(def, boardPos, rotation);
  const resolved = resolvePackage(def, part?.value, part?.package);
  if (resolved?.kind !== "rigid") return { body: bounds };

  const midRow = (bounds.minRow + bounds.maxRow) / 2;
  const midCol = (bounds.minCol + bounds.maxCol) / 2;
  const pins = getRotatedPinPositions(def, boardPos, rotation);
  const shape = rigidShape(resolved.spec, {
    pins: pins.map((p) => ({ x: (p.col - midCol) * MM_PER_HOLE, y: (p.row - midRow) * MM_PER_HOLE, id: p.pinId })),
    width: (bounds.maxCol - bounds.minCol + 1) * MM_PER_HOLE,
    height: (bounds.maxRow - bounds.minRow + 1) * MM_PER_HOLE,
    rotation,
  });
  const toRect = (b: { x: number; y: number; w: number; h: number }): FootprintRect => ({
    minRow: midRow + b.y / MM_PER_HOLE + 0.5,
    maxRow: midRow + (b.y + b.h) / MM_PER_HOLE - 0.5,
    minCol: midCol + b.x / MM_PER_HOLE + 0.5,
    maxCol: midCol + (b.x + b.w) / MM_PER_HOLE - 0.5,
  });
  const plastic = toRect(shape.body);
  return {
    body: {
      minRow: Math.min(bounds.minRow, plastic.minRow),
      maxRow: Math.max(bounds.maxRow, plastic.maxRow),
      minCol: Math.min(bounds.minCol, plastic.minCol),
      maxCol: Math.max(bounds.maxCol, plastic.maxCol),
    },
    ...(shape.reach ? { reach: toRect(shape.reach) } : {}),
  };
}

export function rigidBody(
  def: ComponentDef,
  boardPos: Pt,
  rotation: Component["rotation"],
  part: Packaged | undefined = def.part,
): FootprintRect {
  return rigidGeometry(def, boardPos, rotation, part).body;
}

/**
 * The placed parts whose real bodies run into each other, for showing the
 * user a hand placement that cannot be built. Physical overlap only: the free
 * lines a user asks the layout engines for are a preference, not a collision.
 * `resolve` gives each component its definition.
 */
export function bodyClashes(
  components: Component[],
  resolve: (c: Component) => ComponentDef | undefined,
): Set<string> {
  interface Placed { id: string; cap?: Capsule; body?: FootprintRect; reach?: FootprintRect; r0: number; r1: number; c0: number; c1: number }
  const placed: Placed[] = [];
  for (const c of components) {
    if (!c.boardPos || c.boardExcluded) continue;
    const def = resolve(c);
    if (!def) continue;
    if (def.flexible) {
      const [p1, p2] = getFlexiblePinPositions(c, def);
      if (!p1 || !p2) continue;
      const cap = flexBody(flexProfile(def), p1, p2);
      placed.push({
        id: c.id, cap,
        r0: Math.min(cap.a.row, cap.b.row) - cap.r, r1: Math.max(cap.a.row, cap.b.row) + cap.r,
        c0: Math.min(cap.a.col, cap.b.col) - cap.r, c1: Math.max(cap.a.col, cap.b.col) + cap.r,
      });
    } else {
      const { body, reach } = rigidGeometry(def, c.boardPos, c.rotation);
      placed.push({
        id: c.id, body, reach,
        r0: Math.min(body.minRow, reach?.minRow ?? Infinity) - 0.5, r1: Math.max(body.maxRow, reach?.maxRow ?? -Infinity) + 0.5,
        c0: Math.min(body.minCol, reach?.minCol ?? Infinity) - 0.5, c1: Math.max(body.maxCol, reach?.maxCol ?? -Infinity) + 0.5,
      });
    }
  }
  const out = new Set<string>();
  for (let i = 0; i < placed.length; i++) {
    const A = placed[i];
    for (let j = i + 1; j < placed.length; j++) {
      const B = placed[j];
      if (A.r1 < B.r0 || B.r1 < A.r0 || A.c1 < B.c0 || B.c1 < A.c0) continue;
      let hit: boolean;
      if (A.cap && B.cap) hit = capsulesClash(A.cap, B.cap);
      else if (A.cap || B.cap) {
        const F = A.cap ? A : B, R = A.cap ? B : A;
        hit = capsuleClashesRect(F.cap!, R.body!) || (!!R.reach && capsuleClashesRect(F.cap!, R.reach));
      } else {
        hit = bodyRectsClash(A.body!, B.body!) ||
          (!!A.reach && bodyRectsClash(A.reach, B.body!)) || (!!B.reach && bodyRectsClash(B.reach, A.body!));
      }
      if (hit) {
        out.add(A.id);
        out.add(B.id);
      }
    }
  }
  return out;
}

/** The whole holes a flexible part's body lies over, its own lead holes included. */
export function flexCoveredHoles(cap: Capsule): Pt[] {
  const holes: Pt[] = [];
  const reach = cap.r - 0.05;
  for (let row = Math.ceil(Math.min(cap.a.row, cap.b.row) - reach); row <= Math.max(cap.a.row, cap.b.row) + reach; row++) {
    for (let col = Math.ceil(Math.min(cap.a.col, cap.b.col) - reach); col <= Math.max(cap.a.col, cap.b.col) + reach; col++) {
      if (pointSegmentDistance({ row, col }, cap.a, cap.b) < reach) holes.push({ row, col });
    }
  }
  return holes;
}

/** A flexible part as the wire router sees it: leads and real body. */
export function flexWireObstacle(def: ComponentDef, p1: Pt, p2: Pt): WireObstacles["bodies"][number] {
  const cap = flexBody(flexProfile(def), p1, p2);
  return { p1, p2, core: cap };
}
