// Real package outlines for the parts whose pins sit on a fixed grid: headers,
// terminals, DIPs, modules, TO packages, switches and pots.
//
// Everything is drawn in millimetres in a frame centred on the footprint's
// bounding box and aligned to the board, with pin positions supplied already
// rotated. Shapes that have a front (a connector's wire entry, a TO-220 tab)
// take it from the component rotation, so they turn with the part.

import { Piece, RigidSpec } from "./packageBodies";

export interface RigidGeom {
  /** Pin centres in millimetres, relative to the footprint centre. */
  pins: { x: number; y: number; id: string }[];
  /** Footprint bounding box in millimetres. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

const PITCH = 2.54;
const PAD = "#c9a227";
const LEG = "#b9bec2";

/** Unit vector a part with a front faces, turning with the component. */
function front(rotation: number): { x: number; y: number } {
  switch (rotation) {
    case 90: return { x: 0, y: 1 };
    case 180: return { x: -1, y: 0 };
    case 270: return { x: 0, y: -1 };
    default: return { x: 1, y: 0 };
  }
}

/** True when every pin shares a row, i.e. the part lies along the x axis. */
function horizontal(geom: RigidGeom): boolean {
  // a single pin has no line of its own: the part's rotation says which way it lies
  if (geom.pins.length === 1) return geom.rotation === 90 || geom.rotation === 270;
  const ys = new Set(geom.pins.map((p) => Math.round(p.y * 100)));
  if (ys.size === 1) return true;
  const xs = new Set(geom.pins.map((p) => Math.round(p.x * 100)));
  return xs.size > ys.size;
}

function span(geom: RigidGeom, along: "x" | "y") {
  const vs = geom.pins.map((p) => p[along]);
  return { lo: Math.min(...vs), hi: Math.max(...vs) };
}

function rect(x: number, y: number, w: number, h: number, fill: string, r = 0, outline = true): Piece {
  return { t: "rect", x, y, w, h, r, fill, outline };
}

export interface Box { x: number; y: number; w: number; h: number }

export interface RigidShape {
  /** The plastic that sits on the board, which is what neighbours must clear. */
  body: Box;
  pieces: Piece[];
  /** Drawn but not standing on the board: a pot's bushing and shaft. */
  aloft: Piece[];
  /**
   * The room the aloft pieces take. Nothing can be built under it, but unlike
   * the body it may hang out over the edge of the board, which is where a
   * shaft belongs.
   */
  reach?: Box;
}

/**
 * Frame for a part whose pins sit in one line: u runs along the pins from the
 * middle of their span, v runs across them from the pin line, positive toward
 * the front of the part. Written once here so that no shape has to repeat
 * itself per orientation, which is where the two used to drift apart.
 */
function lineFrame(geom: RigidGeom) {
  const alongX = horizontal(geom);
  const f = front(geom.rotation);
  const s = (alongX ? f.y : f.x) >= 0 ? 1 : -1;
  const a = span(geom, alongX ? "x" : "y");
  const mid = (a.lo + a.hi) / 2;
  const line = alongX ? geom.pins[0].y : geom.pins[0].x;
  const pt = (u: number, v: number) => (alongX ? { x: mid + u, y: line + s * v } : { x: line + s * v, y: mid + u });
  const box = (u0: number, v0: number, w: number, h: number): Box => {
    const p = pt(u0, s > 0 ? v0 : v0 + h);
    return alongX ? { x: p.x, y: p.y, w, h } : { x: p.x, y: p.y, w: h, h: w };
  };
  return {
    half: (a.hi - a.lo) / 2,
    // The mapping mirrors for half of the orientations, which turns an arc's
    // sweep direction around.
    mirrored: alongX ? s < 0 : s > 0,
    pt,
    box,
    u: (p: { x: number; y: number }) => (alongX ? p.x : p.y) - mid,
    rect: (u0: number, v0: number, w: number, h: number, fill: string, r = 0, outline = true): Piece => {
      const b = box(u0, v0, w, h);
      return rect(b.x, b.y, b.w, b.h, fill, r, outline);
    },
    circle: (u: number, v: number, rad: number, fill: string, outline = false): Piece => {
      const p = pt(u, v);
      return { t: "circle", cx: p.x, cy: p.y, rad, fill, outline };
    },
    line: (u1: number, v1: number, u2: number, v2: number, stroke: string, sw: number): Piece => {
      const p = pt(u1, v1);
      const q = pt(u2, v2);
      return { t: "line", x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke, sw };
    },
  };
}

/** A square solder pad with its hole, at a pin. */
function pads(geom: RigidGeom, size: number): Piece[] {
  const out: Piece[] = [];
  for (const p of geom.pins) {
    out.push({ t: "rect", x: p.x - size / 2, y: p.y - size / 2, w: size, h: size, r: size * 0.15, fill: PAD });
  }
  return out;
}

/** Straight legs from the body edge out to each pin, for a two-row package. */
function legs(geom: RigidGeom, bodyHalf: number, alongX: boolean): Piece[] {
  return geom.pins.map((p) => {
    const across = alongX ? p.y : p.x;
    const sign = across >= 0 ? 1 : -1;
    const from = sign * bodyHalf;
    return alongX
      ? { t: "rect" as const, x: p.x - 0.32, y: Math.min(from, p.y), w: 0.64, h: Math.abs(p.y - from), r: 0, fill: LEG }
      : { t: "rect" as const, x: Math.min(from, p.x), y: p.y - 0.32, w: Math.abs(p.x - from), h: 0.64, r: 0, fill: LEG };
  });
}

/** The rectangle around every pin, grown by `grow` on each side. */
function pinBox(geom: RigidGeom, grow: number): Box {
  const x = span(geom, "x");
  const y = span(geom, "y");
  return { x: x.lo - grow, y: y.lo - grow, w: x.hi - x.lo + 2 * grow, h: y.hi - y.lo + 2 * grow };
}

export function rigidShape(spec: RigidSpec, geom: RigidGeom): RigidShape {
  const alongX = horizontal(geom);

  switch (spec.shape) {
    case "header": {
      // 2.54 mm square plastic per pin, half a pitch past the end pins.
      const fr = lineFrame(geom);
      const body = fr.box(-fr.half - PITCH / 2, -PITCH / 2, fr.half * 2 + PITCH, PITCH);
      return { body, pieces: [rect(body.x, body.y, body.w, body.h, spec.fill, 0.2), ...pads(geom, 1.7)], aloft: [] };
    }

    case "wire": {
      // A wire soldered straight into the board: nothing but the joint, with
      // the insulation of the lead showing as a ring around it.
      const body = pinBox(geom, 1.1);
      const pieces: Piece[] = [];
      for (const p of geom.pins) {
        pieces.push({ t: "circle", cx: p.x, cy: p.y, rad: 1.1, fill: spec.fill, outline: true });
        pieces.push({ t: "circle", cx: p.x, cy: p.y, rad: 0.72, fill: "#c4c9cc" });
      }
      return { body, pieces, aloft: [] };
    }

    case "shroud": {
      // JST XH: the housing covers the pins and opens toward the front. The
      // pin row sits 2.35 mm in from the back wall of a 5.75 mm housing.
      const fr = lineFrame(geom);
      const len = fr.half * 2 + 4.9;
      const back = 2.35;
      const depth = 5.75;
      const body = fr.box(-len / 2, -back, len, depth);
      return {
        body,
        pieces: [
          ...pads(geom, 1.5),
          rect(body.x, body.y, body.w, body.h, spec.fill, 0.4),
          fr.rect(-len / 2 + 0.85, depth - back - 1.9, len - 1.7, 1.5, "rgba(0,0,0,0.22)", 0.2, false),
        ],
        aloft: [],
      };
    }

    case "terminal": {
      // 5.08 mm screw terminal: the pin comes straight down from the clamp,
      // so it sits under the screw in the middle of an 8 mm deep block, and
      // the wire goes in at the front face.
      const fr = lineFrame(geom);
      const len = fr.half * 2 + 5.0;
      const depth = 8.0;
      const screwR = 1.55;
      const body = fr.box(-len / 2, -depth / 2, len, depth);
      const pieces: Piece[] = [rect(body.x, body.y, body.w, body.h, spec.fill, 0.5)];
      for (const p of geom.pins) {
        const u = fr.u(p);
        pieces.push(fr.rect(u - 1.3, depth / 2 - 1.3, 2.6, 1.3, "rgba(0,0,0,0.35)", 0.2, false));
        pieces.push(fr.circle(u, 0, screwR, LEG, true));
        pieces.push(fr.line(u - screwR * 0.7, 0, u + screwR * 0.7, 0, "rgba(0,0,0,0.55)", 0.35));
      }
      return { body, pieces, aloft: [] };
    }

    case "dip": {
      // Plastic body between the two pin rows, legs bending out to the holes,
      // and the pin-1 dimple in the corner nearest pin 1.
      const rowSpan = alongX ? span(geom, "y") : span(geom, "x");
      const lenSpan = alongX ? span(geom, "x") : span(geom, "y");
      const bodyHalf = Math.max(1.6, (rowSpan.hi - rowSpan.lo) / 2 - 0.6);
      const len = lenSpan.hi - lenSpan.lo + 1.4;
      const body: Box = alongX
        ? { x: lenSpan.lo - 0.7, y: -bodyHalf, w: len, h: bodyHalf * 2 }
        : { x: -bodyHalf, y: lenSpan.lo - 0.7, w: bodyHalf * 2, h: len };
      const pieces: Piece[] = [...legs(geom, bodyHalf, alongX), rect(body.x, body.y, body.w, body.h, spec.fill, 0.3)];
      const one = geom.pins.find((p) => p.id === "1") ?? geom.pins[0];
      const dimple = alongX
        ? { cx: lenSpan.lo + 0.3, cy: one.y > 0 ? bodyHalf * 0.45 : -bodyHalf * 0.45 }
        : { cx: one.x > 0 ? bodyHalf * 0.45 : -bodyHalf * 0.45, cy: lenSpan.lo + 0.3 };
      pieces.push({ t: "circle", cx: dimple.cx, cy: dimple.cy, rad: 0.6, fill: "rgba(255,255,255,0.22)" });
      return { body, pieces, aloft: [] };
    }

    case "module": {
      // Breakout board: the PCB, a header rail down each pin column, pads.
      const w = geom.width + 1.0;
      const h = geom.height + 1.0;
      const body: Box = { x: -w / 2, y: -h / 2, w, h };
      const pieces: Piece[] = [rect(body.x, body.y, w, h, spec.fill, 0.6)];
      const rows = new Map<number, { x: number; y: number; id: string }[]>();
      const key = alongX ? "y" : "x";
      for (const p of geom.pins) {
        const k = Math.round(p[key] * 10);
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k)!.push(p);
      }
      for (const rail of rows.values()) {
        const a = span({ ...geom, pins: rail }, alongX ? "x" : "y");
        const len = a.hi - a.lo + PITCH;
        pieces.push(alongX
          ? rect(a.lo - PITCH / 2, rail[0].y - PITCH / 2, len, PITCH, "#1b1b1b", 0.15)
          : rect(rail[0].x - PITCH / 2, a.lo - PITCH / 2, PITCH, len, "#1b1b1b", 0.15));
      }
      return { body, pieces: [...pieces, ...pads(geom, 1.35)], aloft: [] };
    }

    case "to92": {
      // Seen from above: a 4.8 mm circle with the front cut flat 1.25 mm out
      // from the middle. The three legs leave the plastic 1.27 mm apart and
      // are splayed out to the holes, so the outer two show beside the body.
      const fr = lineFrame(geom);
      const rad = 2.4;
      const flat = 1.25;
      const chord = Math.sqrt(rad * rad - flat * flat);
      const p1 = fr.pt(-chord, flat);
      const p2 = fr.pt(chord, flat);
      const pieces: Piece[] = [];
      for (const p of geom.pins) {
        const u = fr.u(p);
        if (Math.abs(u) > 1.3) pieces.push(fr.line(Math.sign(u) * 1.27, 0, u, 0, LEG, 0.5));
      }
      pieces.push({
        t: "body",
        d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${rad} ${rad} 0 1 ${fr.mirrored ? 1 : 0} ${p1.x} ${p1.y} Z`,
        fill: spec.fill,
      });
      return { body: fr.box(-rad, -rad, rad * 2, rad + flat), pieces, aloft: [] };
    }

    case "to220": {
      // Standing upright, which is how it goes in unless it is bolted down, so
      // from above only the top edge of the package shows: 10.6 mm wide
      // against legs 5.08 apart, and 4.8 thick (the outline's largest), with
      // the metal tab along one face. The legs run straight down underneath
      // and are not drawn.
      const fr = lineFrame(geom);
      const half = 5.3;
      const depth = 4.8;
      const tab = 1.4;
      const body = fr.box(-half, -depth / 2, half * 2, depth);
      return {
        body,
        pieces: [rect(body.x, body.y, body.w, body.h, spec.fill, 0.3), fr.rect(-half, depth / 2 - tab, half * 2, tab, LEG, 0.15)],
        aloft: [],
      };
    }

    case "transformer": {
      // Laminated core seen from above: the steel stack with the bobbin and
      // its winding showing in the middle.
      const w = geom.width - 0.4;
      const h = geom.height - 0.4;
      const acrossX = w >= h;
      const body: Box = { x: -w / 2, y: -h / 2, w, h };
      const pieces: Piece[] = [rect(body.x, body.y, w, h, spec.fill, 0.3)];
      const bobbin = (acrossX ? w : h) * 0.42;
      pieces.push(acrossX
        ? rect(-bobbin / 2, -h / 2 + 0.5, bobbin, h - 1.0, "#2f3336", 0.2)
        : rect(-w / 2 + 0.5, -bobbin / 2, w - 1.0, bobbin, "#2f3336", 0.2));
      pieces.push(acrossX
        ? rect(-bobbin / 2 + 0.5, -h / 2 + 1.1, bobbin - 1.0, h - 2.2, "#b87333", 0.15)
        : rect(-w / 2 + 1.1, -bobbin / 2 + 0.5, w - 2.2, bobbin - 1.0, "#b87333", 0.15));
      for (const t of [-0.34, 0.34]) {
        pieces.push(acrossX
          ? { t: "line", x1: -w / 2 + 0.4, y1: h * t, x2: w / 2 - 0.4, y2: h * t, stroke: "rgba(0,0,0,0.22)", sw: 0.25 }
          : { t: "line", x1: w * t, y1: -h / 2 + 0.4, x2: w * t, y2: h / 2 - 0.4, stroke: "rgba(0,0,0,0.22)", sw: 0.25 });
      }
      return { body, pieces, aloft: [] };
    }

    case "tact": {
      // 6 mm tactile switch: square body, round actuator, four bent legs.
      const body: Box = { x: -3.0, y: -3.0, w: 6.0, h: 6.0 };
      const pieces: Piece[] = [...legs(geom, 2.6, alongX)];
      pieces.push(rect(body.x, body.y, body.w, body.h, spec.fill, 0.4));
      // The button has to read against the black body it sits in.
      pieces.push({ t: "circle", cx: 0, cy: 0, rad: 1.9, fill: "#6e7175", outline: true });
      pieces.push({ t: "circle", cx: 0, cy: 0, rad: 1.15, fill: "#8d9195" });
      return { body, pieces, aloft: [] };
    }

    case "slide": {
      // SPDT slide switch: body with the actuator sitting in its slot.
      const fr = lineFrame(geom);
      const half = fr.half + 1.3;
      const depth = 4.2;
      const body = fr.box(-half, -depth / 2, half * 2, depth);
      return {
        body,
        pieces: [
          rect(body.x, body.y, body.w, body.h, spec.fill, 0.3),
          fr.rect(-half * 0.5, -depth / 2 + 0.7, half * 0.55, depth - 1.4, "#d8dcde", 0.2),
        ],
        aloft: [],
      };
    }

    case "trimmer": {
      // 9 mm single-turn trimmer: square body with a cross-slot screw.
      const body: Box = { x: -4.75, y: -5.0, w: 9.5, h: 10.0 };
      const pieces: Piece[] = [rect(body.x, body.y, body.w, body.h, spec.fill, 0.5)];
      // The screw goes in the upper half: the label then sits below it, and
      // the two bottom pin names stay on the dark body where they read.
      pieces.push({ t: "circle", cx: 0, cy: -2.1, rad: 2.3, fill: "#e4e6e8", outline: true });
      pieces.push({ t: "line", x1: -1.55, y1: -2.1, x2: 1.55, y2: -2.1, stroke: "rgba(0,0,0,0.45)", sw: 0.4 });
      return { body, pieces, aloft: [] };
    }

    case "trimmer3296": {
      // Bourns 3296W: a 9.5 x 4.8 mm block over three legs in line, with the
      // brass adjustment screw on top at one end.
      const fr = lineFrame(geom);
      const body = fr.box(-4.75, -2.4, 9.5, 4.8);
      return {
        body,
        pieces: [
          rect(body.x, body.y, body.w, body.h, spec.fill, 0.4),
          // in the corner, clear of the end leg and its name
          fr.circle(3.65, -1.35, 0.85, "#c8a24a", true),
          fr.line(3.05, -1.35, 4.25, -1.35, "rgba(0,0,0,0.5)", 0.3),
        ],
        aloft: [],
      };
    }

    case "pot9": {
      // 9 mm PCB pot with the shaft pointing up: the legs are at the front
      // edge and the body runs back from them, so from above it is the green
      // housing with the round shaft in the middle. Nothing hangs over.
      const fr = lineFrame(geom);
      const body = fr.box(-4.9, -10.5, 9.8, 11.5);
      return {
        body,
        pieces: [
          rect(body.x, body.y, body.w, body.h, spec.fill, 0.6),
          fr.circle(0, -5.2, 3.6, "#b4babf", true),
          fr.circle(0, -5.2, 3.0, "#d3d7da", true),
          fr.line(0, -7.9, 0, -5.2, "rgba(0,0,0,0.4)", 0.5),
        ],
        aloft: [],
      };
    }

    case "pot": {
      // 16 mm panel pot soldered in by its tags, so it stands on edge with the
      // shaft lying parallel to the board. From above that is the can seen
      // edge on: the tags come out of the wafer just behind the front plate,
      // the can runs back from there, and the bushing and shaft stick out of
      // the front. They clear the board, but nothing can be fitted under them
      // and the panel they go through stands there, so they keep other parts
      // away while being free to hang over the board's edge.
      const fr = lineFrame(geom);
      const wide = 16.5;
      const frontFace = 2.5;
      const back = 7.0;
      const body = fr.box(-wide / 2, -back, wide, back + frontFace);
      const pieces: Piece[] = [
        rect(body.x, body.y, body.w, body.h, spec.fill, 0.8),
        fr.rect(-wide / 2, -0.9, wide, 1.8, "#8a5a33", 0, false),
        fr.rect(-wide / 2, 0.9, wide, frontFace - 0.9, "#a9b0b5", 0.3, false),
      ];
      const bushing = 7.0;
      const shaft = 13.0;
      const aloft: Piece[] = [
        fr.rect(-3.5, frontFace, 7.0, bushing, "#b4babf", 0.3),
        fr.rect(-3.0, frontFace + bushing, 6.0, shaft, "#c9ced2", 0.6),
      ];
      for (let i = 1; i <= 4; i++) {
        const v = frontFace + (bushing * i) / 5;
        aloft.push(fr.line(-3.5, v, 3.5, v, "rgba(0,0,0,0.25)", 0.25));
      }
      aloft.push(fr.line(0, frontFace + bushing + shaft - 5.0, 0, frontFace + bushing + shaft, "rgba(0,0,0,0.35)", 0.5));
      return { body, pieces, aloft, reach: fr.box(-3.5, frontFace, 7.0, bushing + shaft) };
    }
  }
}

export function rigidPieces(spec: RigidSpec, geom: RigidGeom): Piece[] {
  const shape = rigidShape(spec, geom);
  return [...shape.pieces, ...shape.aloft];
}
