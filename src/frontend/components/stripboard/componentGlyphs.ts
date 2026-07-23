import { ComponentDef } from "@/types";

// Orientation glyphs for the stripboard body: the pin-1 notch on ICs and the
// flat-belly (TO-92) silhouette on 3-legged parts. Pure geometry in
// absolute SVG pixel space so any renderer (editor, print, preview) can reuse it.

export interface Pt {
  x: number;
  y: number;
}

export type BodyStyle = "belly" | "dip" | "board" | "plain";

/** Classify a resolved def's stripboard silhouette. */
export function bodyStyle(def: ComponentDef): BodyStyle {
  const distinctCols = new Set(def.pins.map((p) => p.offsetCol)).size;
  const { category } = def;

  // 3 pins in a single column: transistor / MOSFET / voltage regulator (TO-92-like)
  if (def.pins.length === 3 && distinctCols === 1 && (category === "semiconductor" || category === "ic")) {
    return "belly";
  }
  // Two columns of pins on an IC: a DIP package, or a module breakout board.
  if (def.pins.length >= 4 && distinctCols >= 2 && category === "ic") {
    // A DIP is always 4 cells wide (pin-body-body-pin), so its pin columns sit
    // 3 apart; a module breakout board is far wider. Boards get a USB port and
    // no pin-1 notch, since they have neither.
    const cols = def.pins.map((p) => p.offsetCol);
    const colSpan = Math.max(...cols) - Math.min(...cols);
    return colSpan > 3 ? "board" : "dip";
  }
  return "plain";
}

/**
 * Lean rotated body for a flexible 2-pin part sitting diagonally: a thin bar
 * along the pin-to-pin line, rather than the axis-aligned bounding box (which
 * would cover the whole square the two pins span). `a`/`b` are the absolute pin
 * centers. Returns null when the part is axis-aligned, where the plain
 * bounding-box body is already lean.
 */
export function diagonalBody(
  a: Pt,
  b: Pt,
  pad: number,
): { x: number; y: number; width: number; height: number; transform: string } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 || dy === 0) return null;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  return {
    x: -length / 2 - pad * 0.6,
    y: -pad,
    width: length + pad * 1.2,
    height: pad * 2,
    transform: `translate(${(a.x + b.x) / 2}, ${(a.y + b.y) / 2}) rotate(${angle})`,
  };
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

// Physical USB connector footprint (mm), drawn at true scale so the port
// occupies the real board space users lay other components around. USB-C
// receptacle: ~9mm wide, ~6.5mm deep.
export const USB_WIDTH_MM = 9.0;
export const USB_DEPTH_MM = 6.5;

/**
 * USB-connector silhouette for a module breakout board: a rectangle at true
 * physical size, centred on the board edge opposite pin 1. `pins` (with ids)
 * and `center` locate the pin-1 edge exactly as dipNotch does — so the port
 * stays on the far edge under any rotation; `body` is the drawn body rectangle
 * and `mmToUnit` converts millimetres into the caller's coordinate units.
 */
export function usbPort(
  pins: { x: number; y: number; id: string }[],
  center: Pt,
  body: { x0: number; y0: number; x1: number; y1: number },
  mmToUnit: number,
): string {
  let first: Pt = pins[0];
  let last: Pt = pins[pins.length - 1];
  let minId = Infinity, maxId = -Infinity;
  let lo: Pt | null = null, hi: Pt | null = null;
  for (const p of pins) {
    const n = parseInt(p.id, 10);
    if (Number.isNaN(n)) continue;
    if (n < minId) { minId = n; lo = p; }
    if (n > maxId) { maxId = n; hi = p; }
  }
  if (lo && hi && lo !== hi) { first = lo; last = hi; }

  // Direction from body center toward pin 1's edge; the USB sits opposite it.
  let ox = (first.x + last.x) / 2 - center.x;
  let oy = (first.y + last.y) / 2 - center.y;
  const ol = Math.hypot(ox, oy) || 1;
  ox /= ol; oy /= ol;

  const horizontal = Math.abs(ox) >= Math.abs(oy); // pin-1 edge is left/right
  // Edge midpoint on the far side, along-edge unit vector, and outward normal.
  let ex: number, ey: number, ax: number, ay: number, nx: number, ny: number;
  if (horizontal) {
    ex = ox > 0 ? body.x0 : body.x1; // opposite pin-1 edge
    ey = (body.y0 + body.y1) / 2;
    ax = 0; ay = 1; nx = ox > 0 ? -1 : 1; ny = 0;
  } else {
    ex = (body.x0 + body.x1) / 2;
    ey = oy > 0 ? body.y0 : body.y1;
    ax = 1; ay = 0; nx = 0; ny = oy > 0 ? -1 : 1;
  }
  // True-size connector, centred on the edge (straddling it).
  const halfW = (USB_WIDTH_MM * mmToUnit) / 2;
  const halfD = (USB_DEPTH_MM * mmToUnit) / 2;
  const c1 = { x: ex - ax * halfW - nx * halfD, y: ey - ay * halfW - ny * halfD };
  const c2 = { x: ex + ax * halfW - nx * halfD, y: ey + ay * halfW - ny * halfD };
  const c3 = { x: ex + ax * halfW + nx * halfD, y: ey + ay * halfW + ny * halfD };
  const c4 = { x: ex - ax * halfW + nx * halfD, y: ey - ay * halfW + ny * halfD };
  return `M ${c1.x} ${c1.y} L ${c2.x} ${c2.y} L ${c3.x} ${c3.y} L ${c4.x} ${c4.y} Z`;
}
