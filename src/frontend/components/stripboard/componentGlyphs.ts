import { ComponentDef } from "@/types";

// Orientation glyphs for the stripboard body: the pin-1 notch on ICs and the
// flat-belly (TO-92) silhouette on 3-legged parts. Pure geometry in
// absolute SVG pixel space so any renderer (editor, print, preview) can reuse it.

export interface Pt {
  x: number;
  y: number;
}

export type BodyStyle = "belly" | "dip" | "plain";

/** Classify a resolved def's stripboard silhouette. */
export function bodyStyle(def: ComponentDef): BodyStyle {
  const distinctCols = new Set(def.pins.map((p) => p.offsetCol)).size;
  const { category } = def;

  // 3 pins in a single column: transistor / MOSFET / voltage regulator (TO-92-like)
  if (def.pins.length === 3 && distinctCols === 1 && (category === "semiconductor" || category === "ic")) {
    return "belly";
  }
  // Two columns of pins on an IC: a DIP package
  if (def.pins.length >= 4 && distinctCols >= 2 && category === "ic") {
    return "dip";
  }
  return "plain";
}

/**
 * Flat-belly "D" silhouette for a 3-legged part. `a` and `b` are the absolute
 * centers of the two end pins. A straight flat edge sits clear on one side of
 * the holes; the opposite side is a cubic-Bézier belly that leaves both corners
 * at ~90° to the flat edge and rounds out into the bulge. Holes sit between.
 */
export function bellyPath(a: Pt, b: Pt, pad: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len; // along the pin axis
  const bx = uy;
  const by = -ux; // belly direction (perpendicular, one consistent side)

  const cx = ((a.x + b.x) / 2) + 3;
  const cy = (a.y + b.y) / 2;
  const half = len / 2 + pad * 1.1; // corners sit a little past the end pins
  const gap = pad; // flat edge offset clear of the holes
  const ctrl = pad * 3.5; // belly control reach → bulge depth ≈ 0.75·ctrl − gap

  // Flat edge corners on the -belly side of the holes
  const top = { x: cx - ux * half - bx * gap, y: cy - uy * half - by * gap };
  const bot = { x: cx + ux * half - bx * gap, y: cy + uy * half - by * gap };
  // Controls pushed straight out along +belly, so the curve departs each corner
  // perpendicular to the flat edge, then rounds out
  const c1 = { x: bot.x + bx * ctrl, y: bot.y + by * ctrl };
  const c2 = { x: top.x + bx * ctrl, y: top.y + by * ctrl };

  return `M ${top.x} ${top.y} L ${bot.x} ${bot.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${top.x} ${top.y} Z`;
}

/**
 * Semicircular pin-1 notch for a DIP, cut into the edge next to pin 1. `pins`
 * are all pin centres with their ids; `center` is the body centre. Standard DIP
 * numbering puts pin 1 and the highest-numbered pin together at the notch end,
 * so the notch edge joins them — selecting by id (not array order or geometry)
 * keeps it correct under a reordered footprint and under rotation.
 */
export function dipNotch(pins: { x: number; y: number; id: string }[], center: Pt, pad: number): string {
  let first: Pt = pins[0];
  let last: Pt = pins[pins.length - 1];
  let minId = Infinity;
  let maxId = -Infinity;
  let lo: Pt | null = null;
  let hi: Pt | null = null;
  for (const p of pins) {
    const n = parseInt(p.id, 10);
    if (Number.isNaN(n)) continue;
    if (n < minId) { minId = n; lo = p; }
    if (n > maxId) { maxId = n; hi = p; }
  }
  if (lo && hi && lo !== hi) { first = lo; last = hi; }

  const edgeMid = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
  let ox = edgeMid.x - center.x;
  let oy = edgeMid.y - center.y;
  const ol = Math.hypot(ox, oy) || 1;
  ox /= ol;
  oy /= ol; // outward, toward the pin-1 edge

  const notchC = { x: edgeMid.x + ox * pad, y: edgeMid.y + oy * pad }; // on the edge
  let tx = last.x - first.x;
  let ty = last.y - first.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl; // along the edge

  const r = Math.min(pad * 0.7, tl * 0.4);
  const pa = { x: notchC.x - tx * r, y: notchC.y - ty * r };
  const pb = { x: notchC.x + tx * r, y: notchC.y + ty * r };
  // Semicircle (chord 2r) dipping inward; pick sweep so it bulges toward -outward
  const sweep = tx * -oy - ty * -ox > 0 ? 0 : 1;
  return `M ${pa.x} ${pa.y} A ${r} ${r} 0 0 ${sweep} ${pb.x} ${pb.y}`;
}
