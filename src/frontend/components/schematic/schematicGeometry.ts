import { Component, ComponentDef, NetLabel, SchematicWire } from "@/types";
import { pointKey, snapToGrid } from "@/utils/schematicConstants";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions } from "./SymbolRenderer";

// Pure schematic geometry shared by the store, the canvas and the tests.
//
// The connectivity contract: a wire is one horizontal or vertical segment
// and connects only at its two endpoints; its body never does. Everything
// that should be connected therefore has to be an endpoint, which
// normalizeWires() guarantees by splitting wires wherever a pin, a label or
// another wire's end sits on them.

export type Pt = { x: number; y: number };

export function samePt(a: Pt, b: Pt): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

/** The two points of a wire */
export function getWirePoints(wire: SchematicWire): Pt[] {
  return [wire.start, wire.end];
}

/** The wire as a segment list, for code that walks segments */
export function wireSegments(wire: SchematicWire): [Pt, Pt][] {
  return [[wire.start, wire.end]];
}

/** p lies on the axis-aligned segment ab, strictly between its ends */
export function onSegmentInterior(p: Pt, a: Pt, b: Pt): boolean {
  const px = Math.round(p.x), py = Math.round(p.y);
  const ax = Math.round(a.x), ay = Math.round(a.y);
  const bx = Math.round(b.x), by = Math.round(b.y);
  if (ax === bx) return px === ax && py > Math.min(ay, by) && py < Math.max(ay, by);
  if (ay === by) return py === ay && px > Math.min(ax, bx) && px < Math.max(ax, bx);
  return false;
}

/** p sits on the wire's body, away from its two endpoints */
export function onWireInterior(p: Pt, wire: SchematicWire): boolean {
  return onSegmentInterior(p, wire.start, wire.end);
}

/** Split a wire at a point on its body into two wires meeting there */
export function splitWireAt(wire: SchematicWire, p: Pt, newId: () => string): [SchematicWire, SchematicWire] {
  return [
    { id: newId(), start: wire.start, end: { x: p.x, y: p.y } },
    { id: newId(), start: { x: p.x, y: p.y }, end: wire.end },
  ];
}

/** Absolute schematic positions of every pin of every component */
export function schematicPinPoints(
  components: Component[],
  componentDefs: ComponentDef[],
): { componentId: string; pinId: string; x: number; y: number; key: string }[] {
  const out: { componentId: string; pinId: string; x: number; y: number; key: string }[] = [];
  for (const comp of components) {
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    const pins = getRotatedPinPositions(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
    for (const pin of pins) {
      const x = comp.schematicPos.x + pin.x;
      const y = comp.schematicPos.y + pin.y;
      out.push({ componentId: comp.id, pinId: pin.pinId, x, y, key: pointKey(x, y) });
    }
  }
  return out;
}

/** Every pin and every label point: the things wires connect to */
export function anchorPoints(components: Component[], componentDefs: ComponentDef[], netLabels: NetLabel[]): Pt[] {
  const pts: Pt[] = schematicPinPoints(components, componentDefs).map((p) => ({ x: p.x, y: p.y }));
  for (const l of netLabels) pts.push({ x: l.pos.x, y: l.pos.y });
  return pts;
}

/**
 * Make contacts endpoints. With `contacts` (touch wiring) a wire is split
 * wherever a pin, a label or another wire's end sits on its body, so what
 * touches on screen is connected. Without it (classic wiring) bodies never
 * connect and only cleanup happens. Always drops zero-length wires and
 * exact duplicates.
 */
export function normalizeWires(wires: SchematicWire[], anchors: Pt[], newId: () => string, contacts: boolean): SchematicWire[] {
  const ws = wires.filter((w) => !samePt(w.start, w.end));
  const cands: Pt[] = contacts ? [...anchors, ...ws.flatMap((w) => [w.start, w.end])] : [];
  const out = splitAll(ws, cands, newId);

  return dedupe(out);
}

/** Split every wire at each of the points that lie on its body */
function splitAll(wires: SchematicWire[], points: Pt[], newId: () => string): SchematicWire[] {
  const out: SchematicWire[] = [];
  for (const w of wires) {
    const seen = new Set<string>();
    const splits: Pt[] = [];
    for (const p of points) {
      if (!onWireInterior(p, w)) continue;
      const k = pointKey(p.x, p.y);
      if (seen.has(k)) continue;
      seen.add(k);
      splits.push(p);
    }
    if (splits.length === 0) {
      out.push(w);
      continue;
    }
    const dist = (p: Pt) => Math.abs(p.x - w.start.x) + Math.abs(p.y - w.start.y);
    splits.sort((a, b) => dist(a) - dist(b));
    let cur = w;
    for (const p of splits) {
      const [a, b] = splitWireAt(cur, p, newId);
      out.push(a);
      cur = b;
    }
    out.push(cur);
  }
  return out;
}

/**
 * A drawn wire's ends connect to what they land on, under either rule set:
 * ending a wire on another wire's body makes a T there.
 */
export function attachWireEnds(wires: SchematicWire[], drawnIds: Set<string>, newId: () => string): SchematicWire[] {
  const ends: Pt[] = [];
  for (const w of wires) if (drawnIds.has(w.id)) ends.push(w.start, w.end);
  return splitAll(wires, ends, newId);
}

/** Exact duplicates: the same two endpoints */
function dedupe(out: SchematicWire[]): SchematicWire[] {
  const seen = new Set<string>();
  return out.filter((w) => {
    const a = pointKey(w.start.x, w.start.y);
    const b = pointKey(w.end.x, w.end.y);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Join wires that were split for no reason: two wires in one straight line
 * meeting at a point that holds nothing else become one. The drawing and the
 * connectivity are unchanged; only the number of segments drops.
 */
export function mergeWires(wires: SchematicWire[], anchors: Pt[]): SchematicWire[] {
  const anchorKeys = new Set(anchors.map((p) => pointKey(p.x, p.y)));
  let ws = [...wires];

  for (let guard = 0; guard < wires.length + 5; guard++) {
    const endsAt = new Map<string, SchematicWire[]>();
    for (const w of ws) {
      for (const p of [w.start, w.end]) {
        const k = pointKey(p.x, p.y);
        const arr = endsAt.get(k);
        if (arr) arr.push(w);
        else endsAt.set(k, [w]);
      }
    }

    let next: SchematicWire[] | null = null;
    for (const [k, pair] of endsAt) {
      if (pair.length !== 2 || pair[0].id === pair[1].id || anchorKeys.has(k)) continue;
      const [w1, w2] = pair;
      const P = pointKey(w1.start.x, w1.start.y) === k ? w1.start : w1.end;
      const A = samePt(w1.start, P) ? w1.end : w1.start;
      const B = samePt(w2.start, P) ? w2.end : w2.start;
      // One straight line through A, P, B with P strictly between them
      const alongX = Math.round(A.y) === Math.round(P.y) && Math.round(B.y) === Math.round(P.y);
      const alongY = Math.round(A.x) === Math.round(P.x) && Math.round(B.x) === Math.round(P.x);
      if (!alongX && !alongY) continue;
      const between = alongX
        ? P.x > Math.min(A.x, B.x) && P.x < Math.max(A.x, B.x)
        : P.y > Math.min(A.y, B.y) && P.y < Math.max(A.y, B.y);
      if (!between) continue;
      next = [...ws.filter((w) => w.id !== w1.id && w.id !== w2.id), { id: w1.id, start: A, end: B }];
      break;
    }
    if (!next) break;
    ws = next;
  }
  return ws;
}

// ── Moving and transforming a selection ──────────────────

const axisOf = (w: SchematicWire): "h" | "v" => (Math.round(w.start.y) === Math.round(w.end.y) ? "h" : "v");

/** Split all anchor keys into the ones that move with the selection and the ones that stay */
export function movingAndStaticKeys(
  components: Component[],
  componentDefs: ComponentDef[],
  netLabels: NetLabel[],
  compIds: Set<string>,
  labelIds: Set<string>,
): { moving: Set<string>; stat: Set<string>; movingPoints: Pt[] } {
  const moving = new Set<string>();
  const stat = new Set<string>();
  const movingPoints: Pt[] = [];
  for (const p of schematicPinPoints(components, componentDefs)) {
    if (compIds.has(p.componentId)) {
      moving.add(p.key);
      movingPoints.push({ x: p.x, y: p.y });
    } else {
      stat.add(p.key);
    }
  }
  for (const l of netLabels) {
    if (labelIds.has(l.id)) {
      moving.add(pointKey(l.pos.x, l.pos.y));
      movingPoints.push(l.pos);
    } else {
      stat.add(pointKey(l.pos.x, l.pos.y));
    }
  }
  return { moving, stat, movingPoints };
}

/**
 * A selection of wires that all share one axis may only move across it: a
 * horizontal segment slides up and down, never sideways. Anything else
 * (parts, labels, wires of both axes) moves freely.
 */
export function axisLockFor(wires: SchematicWire[], selectedWireIds: Set<string>, hasOtherItems: boolean): "h" | "v" | null {
  if (hasOtherItems) return null;
  const sel = wires.filter((w) => selectedWireIds.has(w.id));
  if (sel.length === 0) return null;
  const axis = axisOf(sel[0]);
  return sel.every((w) => axisOf(w) === axis) ? axis : null;
}

/**
 * Move the geometry: every moving point (a pin or label of a moved part, or
 * an end of a selected wire) goes to f(point), and the wires follow the way
 * a schematic editor's drag does.
 *
 *  - A wire with both ends moving moves as it is.
 *  - A wire end pushed along the wire's axis lengthens or shortens it.
 *  - A wire end pushed across its axis slides the whole wire sideways when
 *    its far end can give: a loose end, or a clean corner whose one other
 *    wire is perpendicular and simply lengthens. Otherwise (a pin, a label,
 *    a junction, a collinear wire) the wire keeps its far end and a new
 *    corner leg joins it to the moved point.
 *  - A selected wire torn off a pin or label it was attached to gets a leg
 *    back to it.
 *
 * Nothing ever slants. Computed from the geometry at gesture start each
 * time, so the same input always gives the same wires; `nonce` keeps the
 * ids of the new legs stable within one gesture.
 */
export function moveGeometry(
  wires: SchematicWire[],
  staticKeys: Set<string>,
  movingPoints: Pt[],
  selectedWireIds: Set<string>,
  f: (p: Pt) => Pt,
  nonce: string,
): SchematicWire[] {
  const key = (p: Pt) => pointKey(p.x, p.y);
  const targets = new Map<string, Pt>();
  for (const p of movingPoints) targets.set(key(p), f(p));
  // Selected wires move as a whole; an end sitting on a pin or label that
  // stays behind is torn off and reconnected with a leg afterwards
  const detached: { w: SchematicWire; end: "start" | "end" }[] = [];
  for (const w of wires) {
    if (!selectedWireIds.has(w.id)) continue;
    for (const end of ["start", "end"] as const) {
      const k = key(w[end]);
      if (staticKeys.has(k)) detached.push({ w, end });
      else if (!targets.has(k)) targets.set(k, f(w[end]));
    }
  }

  const byPoint = new Map<string, { w: SchematicWire; end: "start" | "end" }[]>();
  for (const w of wires) {
    for (const end of ["start", "end"] as const) {
      const k = key(w[end]);
      const arr = byPoint.get(k);
      if (arr) arr.push({ w, end });
      else byPoint.set(k, [{ w, end }]);
    }
  }

  // Displacement per wire end; a slide adds to the far end, so contributions sum
  const disp = new Map<string, Pt>();
  const add = (id: string, end: "start" | "end", d: Pt) => {
    const k = `${id}:${end}`;
    const c = disp.get(k) ?? { x: 0, y: 0 };
    disp.set(k, { x: c.x + d.x, y: c.y + d.y });
  };
  const extra: SchematicWire[] = [];

  for (const w of wires) {
    if (selectedWireIds.has(w.id)) {
      for (const end of ["start", "end"] as const) {
        const t = f(w[end]);
        add(w.id, end, { x: t.x - w[end].x, y: t.y - w[end].y });
      }
      continue;
    }
    const sT = targets.get(key(w.start)), eT = targets.get(key(w.end));
    if (sT && eT) {
      add(w.id, "start", { x: sT.x - w.start.x, y: sT.y - w.start.y });
      add(w.id, "end", { x: eT.x - w.end.x, y: eT.y - w.end.y });
      continue;
    }
    if (!sT && !eT) continue;

    const end: "start" | "end" = sT ? "start" : "end";
    const other: "start" | "end" = sT ? "end" : "start";
    const P = w[end], O = w[other];
    const t = (sT ?? eT)!;
    const d = { x: t.x - P.x, y: t.y - P.y };
    const axis = axisOf(w);
    const along = axis === "h" ? { x: d.x, y: 0 } : { x: 0, y: d.y };
    const across = axis === "h" ? { x: 0, y: d.y } : { x: d.x, y: 0 };
    if (across.x === 0 && across.y === 0) {
      add(w.id, end, d);
      continue;
    }
    const oKey = key(O);
    const others = (byPoint.get(oKey) ?? []).filter((e) => e.w.id !== w.id);
    const canSlide =
      !staticKeys.has(oKey) && !targets.has(oKey) &&
      others.length <= 1 &&
      others.every((e) => axisOf(e.w) !== axis && !selectedWireIds.has(e.w.id));
    if (canSlide) {
      add(w.id, end, d);
      add(w.id, other, across);
      for (const e of others) add(e.w.id, e.end, across);
    } else {
      add(w.id, end, along);
      const corner = { x: P.x + along.x, y: P.y + along.y };
      if (!samePt(corner, t)) extra.push({ id: `${nonce}:${w.id}:${end}`, start: corner, end: t });
    }
  }

  for (const { w, end } of detached) {
    const A = w[end];
    const E = f(A);
    if (samePt(A, E)) continue;
    if (Math.round(A.x) === Math.round(E.x) || Math.round(A.y) === Math.round(E.y)) {
      extra.push({ id: `${nonce}:${w.id}:${end}:d`, start: A, end: E });
    } else {
      // Perpendicular to the wire first, then alongside its new position
      const corner = axisOf(w) === "h" ? { x: A.x, y: E.y } : { x: E.x, y: A.y };
      extra.push({ id: `${nonce}:${w.id}:${end}:d1`, start: A, end: corner });
      extra.push({ id: `${nonce}:${w.id}:${end}:d2`, start: corner, end: E });
    }
  }

  const moved = wires.map((w) => {
    const ds = disp.get(`${w.id}:start`), de = disp.get(`${w.id}:end`);
    if (!ds && !de) return w;
    return {
      ...w,
      start: ds ? { x: w.start.x + ds.x, y: w.start.y + ds.y } : w.start,
      end: de ? { x: w.end.x + de.x, y: w.end.y + de.y } : w.end,
    };
  });
  return [...moved, ...extra];
}

type Rot = 0 | 90 | 180 | 270;

/**
 * Rotate (90° clockwise) or mirror (about a vertical axis) a selection
 * around `center` (default: the middle of what moves, snapped to grid).
 * Component origins, label points and selected wire ends map through the
 * same rigid transform; attached wires follow per moveGeometry().
 */
export function transformSelection(
  components: Component[],
  componentDefs: ComponentDef[],
  netLabels: NetLabel[],
  wires: SchematicWire[],
  compIds: Set<string>,
  wireIds: Set<string>,
  labelIds: Set<string>,
  op: "rotate" | "mirror",
  nonce: string,
  center?: Pt,
): { components: Component[]; netLabels: NetLabel[]; schematicWires: SchematicWire[] } {
  const { stat, movingPoints } = movingAndStaticKeys(components, componentDefs, netLabels, compIds, labelIds);
  const pts: Pt[] = [...movingPoints];
  for (const w of wires) {
    if (!wireIds.has(w.id)) continue;
    for (const p of [w.start, w.end]) if (!stat.has(pointKey(p.x, p.y))) pts.push(p);
  }
  if (pts.length === 0) return { components, netLabels, schematicWires: wires };

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const c = center ?? {
    x: snapToGrid((Math.min(...xs) + Math.max(...xs)) / 2),
    y: snapToGrid((Math.min(...ys) + Math.max(...ys)) / 2),
  };
  const f = (p: Pt): Pt =>
    op === "rotate"
      ? { x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) }
      : { x: 2 * c.x - p.x, y: p.y };
  // Mirroring flips the sense of rotation: FlipX ∘ Rot(θ) = Rot(-θ) ∘ FlipX.
  const rot = (r: Rot): Rot => (op === "rotate" ? ((r + 90) % 360) as Rot : ((360 - r) % 360) as Rot);

  return {
    components: components.map((comp) => {
      if (!compIds.has(comp.id)) return comp;
      return {
        ...comp,
        schematicPos: f(comp.schematicPos),
        schematicRotation: rot(comp.schematicRotation ?? 0),
        schematicMirrored: op === "mirror" ? !(comp.schematicMirrored ?? false) : comp.schematicMirrored,
      };
    }),
    netLabels: netLabels.map((l) => (labelIds.has(l.id) ? { ...l, pos: f(l.pos), rotation: rot(l.rotation) } : l)),
    schematicWires: moveGeometry(wires, stat, movingPoints, wireIds, f, nonce),
  };
}

// ── Rectangle selection ──────────────────────────────────

export function pointInRect(p: Pt, x1: number, y1: number, x2: number, y2: number): boolean {
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}

/** Axis-aligned segment ab touches the rectangle */
export function segmentIntersectsRect(a: Pt, b: Pt, x1: number, y1: number, x2: number, y2: number): boolean {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return maxX >= x1 && minX <= x2 && maxY >= y1 && minY <= y2;
}

export function wireInRect(wire: SchematicWire, x1: number, y1: number, x2: number, y2: number, enclosed: boolean): boolean {
  if (enclosed) return pointInRect(wire.start, x1, y1, x2, y2) && pointInRect(wire.end, x1, y1, x2, y2);
  return segmentIntersectsRect(wire.start, wire.end, x1, y1, x2, y2);
}
