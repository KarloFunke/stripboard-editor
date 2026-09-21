// One part as a board shows it: its real package at true size, or the dashed
// outline for a part that has none. Every view of a board draws its parts
// through here (the editor, the print, the project previews, the layouter's
// explainer), so they cannot drift apart.

import type { SVGProps } from "react";
import { Component, ComponentDef } from "@/types";
import { HOLE_SPACING, PinPosition, getComponentBounds, getComponentPinPositions, getFlexibleBounds } from "./boardLayout";
import { bodyStyle, bellyPath, dipNotch, usbPort, diagonalBody } from "./componentGlyphs";
import { BODY_OPACITY, MM_PER_HOLE, Piece, bodyAnchor, bodyPieces, drawnReversed, isDarkFill, resolvePackage } from "./packageBodies";
import { rigidPieces } from "./rigidBodies";

type Point = { x: number; y: number };

export interface PartDrawing {
  pins: PinPosition[];
  bounds: { minRow: number; minCol: number; maxRow: number; maxCol: number };
  // The view's size relative to the board editor's, which all fixed sizes
  // (strokes, dashes, text) are authored in
  scale: number;
  // The real package: pieces in mm, put on the board by `transform`
  pieces: Piece[] | null;
  transform: string;
  // A part with no package: a dashed box, or the belly of a three-legged
  // part, plus the notch or socket that tells its ends apart
  outline: {
    box: { x: number; y: number; width: number; height: number; transform?: string } | null;
    path: string | null;
    marker: { d: string; filled: boolean } | null;
  } | null;
  // Where the label goes. A package carries it on the body; an outline has it
  // above, on the board.
  label: { x: number; y: number; onBody: boolean; onDark: boolean };
  // Pin names earn their clutter only when they say something. A real package
  // shows polarity in its own shape, so a bare ordinal on a two-pin part says
  // nothing the shape does not. Anode, cathode, plus and minus stay: the
  // stripe alone is not obvious to someone starting out.
  pinNames: boolean;
  // Pin names printed over a body take their contrast from it
  pinOnDark: boolean;
}

/**
 * Everything needed to draw one placed part. `at` maps a hole to the view and
 * `pitch` is the view's distance between two holes.
 */
export function partDrawing(
  def: ComponentDef,
  component: Component,
  at: (row: number, col: number) => Point,
  pitch: number,
): PartDrawing | null {
  if (!component.boardPos) return null;
  const pins = getComponentPinPositions(component, def);
  const bounds = def.flexible
    ? getFlexibleBounds(component, def)
    : getComponentBounds(def, component.boardPos, component.rotation);
  const scale = pitch / HOLE_SPACING;
  const unit = pitch / MM_PER_HOLE;
  const pad = pitch * 0.4;
  const midRow = (bounds.minRow + bounds.maxRow) / 2;
  const midCol = (bounds.minCol + bounds.maxCol) / 2;
  const centre = at(midRow, midCol);

  const resolved = resolvePackage(def, component.value, component.package);
  const base = { pins, bounds, scale, pieces: null, transform: "", outline: null, pinNames: true, pinOnDark: false };

  // A 2-pin part uses the frame from pin 1 to pin 2, which covers every
  // rotation and the diagonal case at once
  if (resolved?.kind === "twoPin" && pins.length === 2) {
    const pkg = resolved.spec;
    const flip = drawnReversed(pkg, pins[0], pins[1]);
    const p1 = at(pins[flip ? 1 : 0].row, pins[flip ? 1 : 0].col);
    const p2 = at(pins[flip ? 0 : 1].row, pins[flip ? 0 : 1].col);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    // sqrt and a rounded angle, not hypot and raw atan2: those differ in the
    // last digit between engines, and a server-rendered view must hydrate
    const len = Math.sqrt(dx * dx + dy * dy);
    const spanMm = len / unit;
    const angle = Math.round((Math.atan2(dy, dx) * 180 * 1e4) / Math.PI) / 1e4;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    const alongBody = bodyAnchor(pkg, spanMm) * unit;
    return {
      ...base,
      pieces: bodyPieces(pkg, spanMm),
      transform: `translate(${cx} ${cy}) rotate(${angle}) scale(${unit})`,
      label: {
        x: cx + (len === 0 ? 0 : dx / len) * alongBody,
        y: cy + (len === 0 ? 0 : dy / len) * alongBody,
        onBody: true,
        onDark: isDarkFill(pkg.fill),
      },
      pinNames: !def.pins.every((p) => /^\d+$/.test(p.name)),
    };
  }

  // A fixed-footprint part is drawn around its already-rotated pins
  if (resolved?.kind === "rigid") {
    // Centre of the footprint is the natural home for the label, but on a
    // narrow part a pin sits exactly there. Then it goes above the body
    // instead, in the gap between two strips rather than on one.
    const crowded = pins.some((p) => Math.hypot(p.col - midCol, p.row - midRow) < 0.6);
    return {
      ...base,
      pieces: rigidPieces(resolved.spec, {
        pins: pins.map((p) => ({ x: (p.col - midCol) * MM_PER_HOLE, y: (p.row - midRow) * MM_PER_HOLE, id: p.pinId })),
        width: (bounds.maxCol - bounds.minCol + 1) * MM_PER_HOLE,
        height: (bounds.maxRow - bounds.minRow + 1) * MM_PER_HOLE,
        rotation: component.rotation,
      }),
      transform: `translate(${centre.x} ${centre.y}) scale(${unit})`,
      label: {
        x: centre.x,
        y: crowded ? at(bounds.minRow - 0.5, midCol).y : centre.y,
        onBody: true,
        onDark: !crowded && isDarkFill(resolved.spec.fill),
      },
      pinOnDark: !!resolved.spec.coversPins && isDarkFill(resolved.spec.fill),
    };
  }

  const pt = (p: PinPosition) => ({ ...at(p.row, p.col), id: p.pinId });
  const diag = def.flexible && pins.length === 2 ? diagonalBody(pt(pins[0]), pt(pins[1]), pad) : null;
  if (diag) {
    const a = pt(pins[0]), b = pt(pins[1]);
    return {
      ...base,
      outline: { box: diag, path: null, marker: null },
      label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - pad - 4 * scale, onBody: false, onDark: false },
    };
  }

  const c1 = at(bounds.minRow, bounds.minCol), c2 = at(bounds.maxRow, bounds.maxCol);
  const x0 = Math.min(c1.x, c2.x) - pad, x1 = Math.max(c1.x, c2.x) + pad;
  const y0 = Math.min(c1.y, c2.y) - pad, y1 = Math.max(c1.y, c2.y) + pad;
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const style = bodyStyle(def);
  let outline: PartDrawing["outline"] = { box, path: null, marker: null };
  if (style === "belly" && pins.length === 3) {
    outline = { box: null, path: bellyPath(pt(pins[0]), pt(pins[2]), pad), marker: null };
  } else if (style === "dip" && pins.length >= 4) {
    outline = { box, path: null, marker: { d: dipNotch(pins.map(pt), centre, pad), filled: false } };
  } else if (style === "board" && pins.length >= 4) {
    outline = { box, path: null, marker: { d: usbPort(pins.map(pt), centre, { x0, y0, x1, y1 }, unit), filled: true } };
  }
  return {
    ...base,
    outline,
    label: { x: (x0 + x1) / 2, y: y0 - 4 * scale, onBody: false, onDark: false },
  };
}

interface BodyProps {
  drawing: PartDrawing;
  // A package as a line drawing, for a black-and-white print
  mono?: boolean;
  outline?: string;
  // Outline of a package, in mm
  outlineWidth?: number;
  // A part with no package: the fill, line width and dashing of its outline
  fill?: string;
  strokeWidth?: number;
  dashed?: boolean;
}

/** The body of one part. Anything else given lands on its group, which is how the editor hangs its handlers on it. */
export function PartBody({
  drawing, mono = false, outline = "var(--component-stroke)", outlineWidth = 0.12,
  fill = "var(--component-fill)", strokeWidth = 1, dashed = true, ...rest
}: BodyProps & Omit<SVGProps<SVGGElement>, "fill" | "strokeWidth">) {
  if (drawing.pieces) {
    // The line drawing: every shape as its outline over paper that lets the
    // holes underneath show faintly, no colour code, polarity marks inked in
    const paper = (mark?: boolean) => (mono
      ? { fill: mark ? "#000" : "#fff", fillOpacity: mark ? 1 : 0.8, stroke: outline, strokeWidth: outlineWidth }
      : null);
    return (
      <g transform={drawing.transform} {...rest}>
        {drawing.pieces.map((piece, i) => {
          if (piece.t === "line") {
            return <line key={i} x1={piece.x1} y1={piece.y1} x2={piece.x2} y2={piece.y2} stroke={mono ? outline : piece.stroke} strokeWidth={piece.sw} strokeLinecap="round" />;
          }
          if (piece.t === "arc") return <path key={i} d={piece.d} fill="none" stroke={mono ? outline : piece.stroke} strokeWidth={piece.sw} />;
          if (piece.t === "body") {
            return <path key={i} d={piece.d} fill={piece.fill} fillOpacity={BODY_OPACITY} stroke={outline} strokeWidth={outlineWidth} strokeLinejoin="round" {...paper()} />;
          }
          if (piece.t === "circle") {
            return <circle key={i} cx={piece.cx} cy={piece.cy} r={piece.rad} fill={piece.fill} fillOpacity={BODY_OPACITY}
              stroke={piece.outline ? outline : "none"} strokeWidth={piece.outline ? outlineWidth : 0} {...paper()} />;
          }
          if (mono && piece.band) return null;
          return <rect key={i} x={piece.x} y={piece.y} width={piece.w} height={piece.h} rx={piece.r} fill={piece.fill} fillOpacity={BODY_OPACITY}
            stroke={piece.outline ? outline : "none"} strokeWidth={piece.outline ? outlineWidth : 0} {...paper(piece.mark)} />;
        })}
      </g>
    );
  }
  if (!drawing.outline) return null;
  const { box, path, marker } = drawing.outline;
  const s = drawing.scale;
  const sw = strokeWidth * s;
  return (
    <g {...rest}>
      {box && (
        <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={3 * s} transform={box.transform}
          fill={fill} stroke={outline} strokeWidth={sw} strokeDasharray={dashed ? `${4 * s} ${3 * s}` : undefined} />
      )}
      {path && <path d={path} fill={fill} stroke={outline} strokeWidth={sw} />}
      {marker && (
        <path d={marker.d} fill={marker.filled ? fill : "none"} stroke={outline} strokeWidth={marker.filled ? sw : Math.max(s, sw * 0.67)} pointerEvents="none" />
      )}
    </g>
  );
}

interface StaticPartProps {
  def: ComponentDef;
  component: Component;
  at: (row: number, col: number) => Point;
  pitch: number;
  // The net colour a pin is filled with, and how strongly
  pinStyle: (pin: PinPosition) => { color: string | null; opacity?: number };
  // "auto" names pins the way the board editor does
  pinNames?: "auto" | "all" | "none";
  label?: string;
  outline?: string;
  outlineWidth?: number;
  strokeWidth?: number;
}

/** A whole part as the board editor shows it, without any of its handles: body, pins, pin names and label. */
export function StaticPart({ def, component, at, pitch, pinStyle, pinNames = "auto", label, outline, outlineWidth, strokeWidth }: StaticPartProps) {
  const drawing = partDrawing(def, component, at, pitch);
  if (!drawing) return null;
  const s = drawing.scale;
  const named = pinNames === "all" || (pinNames === "auto" && drawing.pinNames);
  return (
    <g>
      <PartBody drawing={drawing} outline={outline} outlineWidth={outlineWidth} strokeWidth={strokeWidth} />
      {drawing.pins.map((pin) => {
        const c = at(pin.row, pin.col);
        const { color, opacity } = pinStyle(pin);
        return (
          <g key={`${pin.pinId}-${pin.row}-${pin.col}`}>
            <circle cx={c.x} cy={c.y} r={(color ? 5 : 4.5) * s} fill={color ?? "var(--hole-fill)"}
              stroke={color ? "var(--hole-fill)" : "var(--hole-stroke)"} strokeWidth={(color ? 1.5 : 0.5) * s} opacity={opacity} />
            {named && (
              <text x={c.x} y={c.y + 10 * s} textAnchor="middle" fontSize={6 * s}
                fill={drawing.pinOnDark ? "#e8e8e8" : "var(--component-subtext)"}
                stroke={drawing.pinOnDark ? "rgba(0,0,0,0.6)" : "var(--board-fill)"} strokeWidth={1.6 * s}
                paintOrder="stroke" strokeLinejoin="round">
                {def.pins.find((p) => p.id === pin.pinId)?.name ?? pin.pinId}
              </text>
            )}
          </g>
        );
      })}
      {label !== undefined && (drawing.label.onBody ? (
        <text x={drawing.label.x} y={drawing.label.y} textAnchor="middle" dominantBaseline="central"
          fontSize={11 * s} fontWeight={600} fill={drawing.label.onDark ? "#f7f7f7" : "#1a1a1a"}
          stroke={drawing.label.onDark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.8)"} strokeWidth={3 * s}
          paintOrder="stroke" strokeLinejoin="round">
          {label}
        </text>
      ) : (
        <text x={drawing.label.x} y={drawing.label.y} textAnchor="middle" fontSize={11 * s} fontWeight={600} fill="var(--component-text)">
          {label}
        </text>
      ))}
    </g>
  );
}
