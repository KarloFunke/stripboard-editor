// Real package outlines for the 2-pin parts, in millimetres.
//
// Everything is built in a local frame shared by every shape: pin 1 sits at
// (-span/2, 0), pin 2 at (+span/2, 0), so +x always points at the marked end
// (cathode, minus) whatever the rotation is on the board. The caller supplies
// the one transform that puts that frame on the board.
//
// Sizes are the real ones, so an axial part that cannot bend into its own
// hole span is drawn standing on one lead, which is how it would be built.

import { BodyCell, ComponentDef, PinDef } from "@/types";
import { darken, parseCapacitance, parseLedColor, parseResistance, resistorBands } from "./componentValues";

export const MM_PER_HOLE = 2.54;

// Lead needed at each shoulder to bend an axial part down into the board.
export const BEND = 0.5;
const LEAD_COLOR = "#8d9499";
// Bodies are see-through so the copper, cuts and net colours stay readable.
export const BODY_OPACITY = 0.82;
const LEAD_W = 0.55;

export interface PackageSpec {
  id: string;
  shape: "axial" | "disc" | "box" | "can" | "led";
  name: string;
  len: number; // mm along the lead axis
  wid: number; // mm across it (diameter for the round shapes)
  fill: string;
  square?: boolean; // sharp-cornered ceramic block rather than a cylinder
  // Carbon film parts are waisted: wider end caps than the middle. Both must
  // be set together, and endLen is how far the cap runs in from each end.
  endWid?: number;
  endLen?: number;
  bands?: string[];
  mark?: string; // colour of the polarity band at the pin-2 end
  // Wound on a bobbin: the turns show rather than a smooth sleeve.
  coil?: boolean;
  // A glass cartridge: see-through body, metal end caps, the wire inside.
  glass?: boolean;
  // Second colour, for the shaded part of a body drawn in the LED's own colour.
  shade?: string;
}

export interface RigidSpec {
  id: string;
  name: string;
  shape: "header" | "wire" | "shroud" | "terminal" | "dip" | "module" | "to92" | "to220" | "tact" | "slide" | "trimmer" | "trimmer3296" | "pot" | "pot9" | "transformer";
  fill: string;
  /** The body sits over its own holes, so pin names are read against it. */
  coversPins?: boolean;
  /**
   * The wires go in at the front face (the side the drawing turns with the
   * part), so on a board edge that face has to look outward.
   */
  sideEntry?: boolean;
}

export interface PackageOption {
  id: string;
  name: string;
  /** Changes where the pins sit, so choosing it rewrites the footprint. */
  movesPins?: boolean;
}

export type Piece =
  // `band` is a colour code, which a line drawing leaves out; `mark` tells the
  // part's ends apart, which a line drawing inks in solid
  | { t: "rect"; x: number; y: number; w: number; h: number; r: number; fill: string; outline?: boolean; band?: boolean; mark?: boolean }
  | { t: "circle"; cx: number; cy: number; rad: number; fill: string; outline?: boolean }
  | { t: "arc"; d: string; stroke: string; sw: number }
  | { t: "body"; d: string; fill: string }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number };

const RESISTOR_BODY = "#d7c3a1";
// Metal film parts come in a light blue lacquer, and are marked 1% with five bands
const METAL_FILM_BODY = "#62aee0";

/** Whether a label drawn on this body needs light text rather than dark. */
export function isDarkFill(fill: string): boolean {
  const hex = fill.replace("#", "");
  if (hex.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

function discDiameter(farads: number): number {
  if (farads >= 100e-9) return 5.0;
  if (farads >= 10e-9) return 4.0;
  if (farads >= 1e-9) return 3.5;
  return 3.0;
}

function canDiameter(farads: number): number {
  const uf = farads * 1e6;
  if (uf <= 4.7) return 4.0;
  if (uf <= 47) return 5.0;
  if (uf <= 100) return 6.3;
  if (uf <= 330) return 8.0;
  if (uf <= 1000) return 10.0;
  if (uf <= 2200) return 12.5;
  return 16.0;
}

const TO92: PackageOption = { id: "to92", name: "TO-92" };
const TO220: PackageOption = { id: "to220", name: "TO-220 with tab", movesPins: true };

function connectorPins(def: ComponentDef): number | null {
  const m = /^def-connector-(\d+)$/.exec(def.id);
  return m ? Number(m[1]) : null;
}

/**
 * The packages a part may be drawn as, most typical first. An empty list means
 * the part keeps the plain outline and the picker stays hidden for it.
 */
export function packageOptions(def: ComponentDef): PackageOption[] {
  const conn = connectorPins(def);
  if (conn !== null) {
    return [
      { id: "header", name: "Pin header" },
      { id: "wire", name: "Soldered wire" },
      { id: "jst-xh", name: "JST XH socket" },
      { id: "term-508", name: "Screw terminal, 5.08 mm", movesPins: true },
    ];
  }
  switch (def.footprint?.kind) {
    case "dip": return [{ id: "dip", name: "DIP" }];
    case "breakout": return [{ id: "module", name: "Breakout board" }];
    case "to": return [TO92, TO220];
  }
  switch (def.id) {
    case "def-resistor":
      return [
        { id: "r-quarter", name: "Carbon film, 1/4 W" },
        { id: "r-half", name: "Carbon film, 1/2 W" },
        { id: "r-1w", name: "Carbon film, 1 W" },
        { id: "r-mf-quarter", name: "Metal film, 1/4 W" },
        { id: "r-mf-half", name: "Metal film, 1/2 W" },
        { id: "r-mf-1w", name: "Metal film, 1 W" },
        { id: "r-5w", name: "5 W ceramic" },
      ];
    case "def-capacitor":
      return [{ id: "cap-ceramic", name: "Ceramic disc" }, { id: "cap-film", name: "Film box" }, { id: "cap-elko", name: "Radial electrolytic" }];
    case "def-cap-polarized":
      return [{ id: "cap-elko", name: "Radial electrolytic" }, { id: "cap-ceramic", name: "Ceramic disc" }, { id: "cap-film", name: "Film box" }];
    case "def-led":
      return [{ id: "led-5", name: "LED, 5 mm" }, { id: "led-3", name: "LED, 3 mm" }];
    case "def-diode":
      return [{ id: "do41", name: "DO-41" }, { id: "do35", name: "DO-35 glass" }];
    case "def-zener":
      return [{ id: "do35", name: "DO-35 glass" }, { id: "do41", name: "DO-41" }];
    case "def-inductor":
      return [{ id: "ind-axial", name: "Axial inductor" }];
    case "def-fuse":
      return [{ id: "fuse-glass", name: "Glass cartridge, 3.6 x 10 mm" }, { id: "fuse-tr5", name: "Radial micro fuse (TR5)" }, { id: "fuse-pico", name: "Axial pico fuse" }];
    case "def-transformer":
      return [{ id: "transformer", name: "Laminated transformer" }];
    case "def-switch":
      return [{ id: "slide", name: "Slide switch" }];
    case "def-pushbutton":
      return [{ id: "tact", name: "Tactile, 6 mm" }];
    case "def-trimpot":
      return [{ id: "trimmer", name: "Trimmer, 9 mm" }, { id: "trim-3296", name: "Multi-turn trimmer, 3296W", movesPins: true }];
    case "def-potentiometer":
      return [{ id: "pot", name: "Panel pot, 16 mm" }, { id: "pot-9mm", name: "PCB pot, 9 mm" }];
    default:
      return [];
  }
}

/** The package a part is drawn as when nothing has been chosen for it. */
export function defaultPackageId(def: ComponentDef, value?: string): string | null {
  if (def.id === "def-capacitor") {
    const farads = parseCapacitance(value);
    return farads !== null && farads >= 470e-9 ? "cap-film" : "cap-ceramic";
  }
  return packageOptions(def)[0]?.id ?? null;
}

const RIGID: Record<string, RigidSpec> = {
  header: { id: "header", name: "Pin header", shape: "header", fill: "#1e1e1e" },
  wire: { id: "wire", name: "Soldered wire", shape: "wire", fill: "#c0392b" },
  "jst-xh": { id: "jst-xh", name: "JST XH socket", shape: "shroud", fill: "#e6e1d2" },
  "term-508": { id: "term-508", name: "Screw terminal, 5.08 mm", shape: "terminal", fill: "#2f6fb5", coversPins: true, sideEntry: true },
  dip: { id: "dip", name: "DIP", shape: "dip", fill: "#2b2b2b" },
  module: { id: "module", name: "Breakout board", shape: "module", fill: "#1f6b4a" },
  to92: { id: "to92", name: "TO-92", shape: "to92", fill: "#1c1c1c", coversPins: true },
  to220: { id: "to220", name: "TO-220 with tab", shape: "to220", fill: "#1c1c1c", coversPins: true },
  tact: { id: "tact", name: "Tactile, 6 mm", shape: "tact", fill: "#1f1f1f" },
  slide: { id: "slide", name: "Slide switch", shape: "slide", fill: "#1c1c1c", coversPins: true },
  transformer: { id: "transformer", name: "Laminated transformer", shape: "transformer", fill: "#70767b" },
  trimmer: { id: "trimmer", name: "Trimmer, 9 mm", shape: "trimmer", fill: "#1d4f8f", coversPins: true },
  pot: { id: "pot", name: "Panel pot, 16 mm", shape: "pot", fill: "#868d92", coversPins: true },
  "pot-9mm": { id: "pot-9mm", name: "PCB pot, 9 mm", shape: "pot9", fill: "#2f7d4f", coversPins: true },
  "trim-3296": { id: "trim-3296", name: "Multi-turn trimmer, 3296W", shape: "trimmer3296", fill: "#1d4f8f", coversPins: true },
};

function twoPin(id: string, def: ComponentDef, value?: string): PackageSpec | null {
  switch (id) {
    case "r-half":
    case "r-quarter":
    case "r-mf-half":
    case "r-mf-quarter":
    case "r-1w":
    case "r-mf-1w":
    case "r-5w": {
      const metal = id.startsWith("r-mf-");
      const ohms = parseResistance(value);
      const bands = ohms === null ? null : resistorBands(ohms, metal);
      if (id === "r-5w") {
        // Wirewound in a white ceramic block: no colour code, it is printed.
        return { id, shape: "axial", name: "Resistor, 5 W", len: 22.0, wid: 9.0, square: true, fill: "#ece9e1" };
      }
      const size = {
        "r-quarter": { name: "Carbon film resistor, 1/4 W", len: 6.3, wid: 2.0, endWid: 2.4, endLen: 1.4 },
        "r-half": { name: "Carbon film resistor, 1/2 W", len: 9.0, wid: 2.5, endWid: 3.0, endLen: 2.0 },
        "r-mf-quarter": { name: "Metal film resistor, 1/4 W", len: 6.3, wid: 2.0, endWid: 2.4, endLen: 1.4 },
        "r-mf-half": { name: "Metal film resistor, 1/2 W", len: 9.0, wid: 2.5, endWid: 3.0, endLen: 2.0 },
        "r-1w": { name: "Carbon film resistor, 1 W", len: 11.0, wid: 3.8, endWid: 4.5, endLen: 2.4 },
        "r-mf-1w": { name: "Metal film resistor, 1 W", len: 11.0, wid: 3.8, endWid: 4.5, endLen: 2.4 },
      }[id]!;
      return { id, shape: "axial", ...size, fill: metal ? METAL_FILM_BODY : RESISTOR_BODY, ...(bands ? { bands } : {}) };
    }
    case "ind-axial":
      return { id, shape: "axial", name: "Axial inductor", len: 9.0, wid: 4.2, fill: "#5a5f63", coil: true };
    case "fuse-glass":
      return { id, shape: "axial", name: "Glass cartridge, 3.6 x 10 mm", len: 10.0, wid: 3.6, fill: "rgba(222,232,238,0.78)", glass: true };
    case "fuse-pico":
      // Looks like a small resistor: a moulded body with no colour bands.
      return { id, shape: "axial", name: "Axial pico fuse", len: 7.1, wid: 2.5, fill: "#5f8a5a" };
    case "fuse-tr5":
      // The small plastic can on two legs 5.08 mm apart, seen from above.
      return { id, shape: "can", name: "Radial micro fuse (TR5)", len: 8.5, wid: 8.5, fill: "#3a2f2a" };
    case "do41":
      return { id, shape: "axial", name: "DO-41", len: 5.0, wid: 2.6, fill: "#262626", mark: "#d9d9d9" };
    case "do35":
      return { id, shape: "axial", name: "DO-35 glass", len: 4.0, wid: 1.9, fill: "#cdd7dd", mark: "#1a1a1a" };
    case "led-5":
    case "led-3": {
      const tint = parseLedColor(value);
      const dia = id === "led-3" ? 3.0 : 5.0;
      return {
        id, shape: "led", name: id === "led-3" ? "LED, 3 mm" : "LED, 5 mm",
        len: dia, wid: dia,
        fill: tint ?? "#d7e3ec",
        shade: tint ? darken(tint, 0.3) : "#b9c6d1",
      };
    }
    case "cap-elko": {
      const dia = canDiameter(parseCapacitance(value) ?? 100e-6);
      return { id, shape: "can", name: "Radial electrolytic", len: dia, wid: dia, fill: "#20395c", mark: "#c3d0dd" };
    }
    case "cap-film":
      return { id, shape: "box", name: "Film box", len: 7.2, wid: 2.5, fill: "#3565a8" };
    case "cap-ceramic": {
      const farads = parseCapacitance(value);
      const dia = farads === null ? 5.0 : discDiameter(farads);
      // A disc stands on edge, so from above it is a thin lens as long as the
      // disc is wide, not the round face.
      return { id, shape: "disc", name: "Ceramic disc", len: dia, wid: Math.min(2.4, dia * 0.6), fill: "#c89b4a" };
    }
    default:
      return null;
  }
}

export interface PackageFootprint {
  width: number;
  height: number;
  pins: PinDef[];
  bodyCells?: BodyCell[];
}

/**
 * The footprint a package forces, for the ones that move pins or claim board
 * space the plain footprint never reserved. Null leaves the definition's own
 * footprint standing. Offsets are in the unrotated frame, where the part faces
 * +col, which is the direction the drawing puts a connector's wire entry and a
 * TO-220's tab.
 */
export function footprintFor(def: ComponentDef, packageId: string): PackageFootprint | null {
  if (packageId === "term-508") {
    // The block is 8 mm deep with the pins under the screws in the middle, so
    // it covers the hole either side of every pin and the pins between them.
    const n = def.pins.length;
    const height = n * 2 - 1;
    const pins = def.pins.map((pin, i) => ({ ...pin, offsetRow: i * 2, offsetCol: 1 }));
    const bodyCells: BodyCell[] = [];
    for (let row = 0; row < height; row++) {
      for (let col = 0; col <= 2; col++) {
        if (col === 1 && row % 2 === 0) continue; // a pin, not body
        bodyCells.push({ row, col });
      }
    }
    return { width: 3, height, pins, bodyCells };
  }
  if (packageId === "trim-3296") {
    // Three legs in one line, 2.54 mm apart, under a body 9.5 mm long.
    const pins = def.pins.map((pin, i) => ({ ...pin, offsetRow: i, offsetCol: 0 }));
    return { width: 1, height: pins.length, pins };
  }
  if (packageId === "to220") {
    // Upright it is 10.2 mm wide against legs 5.08 apart, so it overhangs one
    // hole past each end leg, and only 4.6 mm thick, which claims no
    // neighbouring column.
    const pins = def.pins.map((pin) => ({ ...pin, offsetRow: pin.offsetRow + 1, offsetCol: 0 }));
    const height = Math.max(...pins.map((p) => p.offsetRow)) + 2;
    return { width: 1, height, pins, bodyCells: [{ row: 0, col: 0 }, { row: height - 1, col: 0 }] };
  }

  return null;
}

export type ResolvedPackage =
  | { kind: "twoPin"; spec: PackageSpec }
  | { kind: "rigid"; spec: RigidSpec };

/**
 * The package to draw for one part: the stored choice when it is still a valid
 * option for this definition, otherwise the default. Null keeps the plain body.
 */
export function resolvePackage(def: ComponentDef, value?: string, chosen?: string): ResolvedPackage | null {
  const options = packageOptions(def);
  if (options.length === 0) return null;
  const id = (chosen && options.some((o) => o.id === chosen) ? chosen : defaultPackageId(def, value)) ?? null;
  if (!id) return null;
  const rigid = RIGID[id];
  if (rigid) return { kind: "rigid", spec: rigid };
  const spec = twoPin(id, def, value);
  return spec ? { kind: "twoPin", spec } : null;
}

/**
 * A part with no marked end sits the same way round whichever lead went
 * where, so it is drawn in one canonical direction: left to right, or top to
 * bottom standing up. Colour bands then always read the same way, and a part
 * standing on one lead always stands on the same one. True when pin 2 takes
 * the place of pin 1.
 */
export function drawnReversed(spec: PackageSpec, pin1: { row: number; col: number }, pin2: { row: number; col: number }): boolean {
  return !spec.mark && (pin2.col < pin1.col || (pin2.col === pin1.col && pin2.row < pin1.row));
}

/** Whether an axial part at this span has room to lie flat between its holes. */
export function liesFlat(spec: PackageSpec, spanMm: number): boolean {
  return spec.shape !== "axial" || spanMm >= spec.len + 2 * BEND;
}

/** Widest point of a body, for callers placing labels clear of it. */
export function bodyWidth(spec: PackageSpec): number {
  return Math.max(spec.wid, spec.endWid ?? 0);
}

/**
 * Where the body actually sits in the pin-1 to pin-2 frame, in millimetres.
 * An axial part too tight to lie flat stands on one lead, so its body is over
 * that hole rather than halfway between the two.
 */
export function bodyAnchor(spec: PackageSpec, spanMm: number): number {
  return liesFlat(spec, spanMm) ? 0 : -spanMm / 2;
}

/**
 * Waisted axial outline: flat wider caps at both ends, a narrower middle, and
 * a smooth shoulder between them, which is the shape of a carbon film part.
 */
function waistedPath(len: number, wid: number, endWid: number, endLen: number): string {
  const hx = len / 2;
  const r = wid / 2;
  const cap = endWid / 2;
  const corner = Math.min(0.45, cap * 0.6);
  const shoulder = Math.min(0.6, endLen * 0.35, (len - 2 * endLen) * 0.25);
  const x1 = -hx + endLen;
  const x2 = hx - endLen;
  return [
    `M ${-hx + corner} ${-cap}`,
    `L ${x1} ${-cap}`,
    `C ${x1 + shoulder * 0.5} ${-cap} ${x1 + shoulder * 0.5} ${-r} ${x1 + shoulder} ${-r}`,
    `L ${x2 - shoulder} ${-r}`,
    `C ${x2 - shoulder * 0.5} ${-r} ${x2 - shoulder * 0.5} ${-cap} ${x2} ${-cap}`,
    `L ${hx - corner} ${-cap}`,
    `Q ${hx} ${-cap} ${hx} ${-cap + corner}`,
    `L ${hx} ${cap - corner}`,
    `Q ${hx} ${cap} ${hx - corner} ${cap}`,
    `L ${x2} ${cap}`,
    `C ${x2 - shoulder * 0.5} ${cap} ${x2 - shoulder * 0.5} ${r} ${x2 - shoulder} ${r}`,
    `L ${x1 + shoulder} ${r}`,
    `C ${x1 + shoulder * 0.5} ${r} ${x1 + shoulder * 0.5} ${cap} ${x1} ${cap}`,
    `L ${-hx + corner} ${cap}`,
    `Q ${-hx} ${cap} ${-hx} ${cap - corner}`,
    `L ${-hx} ${-cap + corner}`,
    `Q ${-hx} ${-cap} ${-hx + corner} ${-cap}`,
    "Z",
  ].join(" ");
}

/** Half height of the body at x, so a band fills the profile it sits on. */
function halfAt(spec: PackageSpec, x: number): number {
  const endLen = spec.endLen ?? 0;
  if (endLen > 0 && Math.abs(x) >= spec.len / 2 - endLen) return (spec.endWid ?? spec.wid) / 2;
  return spec.wid / 2;
}

function lead(x1: number, x2: number): Piece {
  return { t: "line", x1, y1: 0, x2, y2: 0, stroke: LEAD_COLOR, sw: LEAD_W };
}

/** Leads from each hole to the edge of a body of this length, where visible. */
function radialLeads(half: number, bodyHalf: number): Piece[] {
  if (half <= bodyHalf) return [];
  return [lead(-half, -bodyHalf), lead(bodyHalf, half)];
}

function axialPieces(spec: PackageSpec, spanMm: number): Piece[] {
  const half = spanMm / 2;
  const r = spec.wid / 2;

  const standingR = bodyWidth(spec) / 2;
  if (!liesFlat(spec, spanMm)) {
    // Too tight to lie flat: stands on the pin-1 lead with the other folded
    // over the top, so from above it is the body end plus one lead.
    const pieces: Piece[] = [lead(-half, half), { t: "circle", cx: -half, cy: 0, rad: standingR, fill: spec.fill, outline: true }];
    if (spec.mark) {
      // A band near the top of a standing part reads as a ring from above.
      const ring = standingR * 0.7;
      pieces.push({ t: "arc", d: `M ${-half - ring} 0 A ${ring} ${ring} 0 1 1 ${-half + ring} 0 A ${ring} ${ring} 0 1 1 ${-half - ring} 0`, stroke: spec.mark, sw: standingR * 0.3 });
    }
    return pieces;
  }

  const bodyHalf = spec.len / 2;
  const pieces: Piece[] = [lead(-half, -bodyHalf), lead(bodyHalf, half)];
  if (spec.coil) {
    // A drum core wound full of enamelled wire, seen from above: a ferrite
    // flange at each end and between them the winding, turn beside turn.
    const flange = Math.min(1.1, spec.len * 0.13);
    const windHalf = bodyHalf - flange;
    const windR = r * 0.86;
    pieces.push({ t: "rect", x: -windHalf, y: -windR, w: windHalf * 2, h: windR * 2, r: windR * 0.35, fill: "#b87333", outline: true });
    const turns = Math.max(6, Math.round((windHalf * 2) / 0.55));
    const pitch = (windHalf * 2) / turns;
    for (let i = 1; i < turns; i++) {
      const x = -windHalf + i * pitch;
      pieces.push({ t: "line", x1: x - pitch * 0.3, y1: -windR * 0.88, x2: x + pitch * 0.3, y2: windR * 0.88, stroke: "#7a4519", sw: 0.13 });
    }
    // the wire is round, so the winding catches the light along its crown
    pieces.push({ t: "line", x1: -windHalf + pitch, y1: -windR * 0.4, x2: windHalf - pitch, y2: -windR * 0.4, stroke: "#e2a873", sw: 0.3 });
    for (const x of [-bodyHalf, bodyHalf - flange]) {
      pieces.push({ t: "rect", x, y: -r, w: flange, h: spec.wid, r: flange * 0.25, fill: spec.fill, outline: true });
    }
  } else if (spec.glass) {
    // Cartridge fuse: the wire inside is visible through the glass, held by a
    // metal cap at each end that takes up a third of the length.
    const cap = spec.len * 0.33;
    pieces.push({ t: "rect", x: -bodyHalf, y: -r, w: spec.len, h: spec.wid, r: r * 0.25, fill: spec.fill, outline: true });
    pieces.push({ t: "line", x1: -bodyHalf + cap, y1: 0, x2: bodyHalf - cap, y2: 0, stroke: "#d98f55", sw: 0.4 });
    pieces.push({ t: "rect", x: -bodyHalf, y: -r, w: cap, h: spec.wid, r: r * 0.25, fill: "#b9bec2", outline: true });
    pieces.push({ t: "rect", x: bodyHalf - cap, y: -r, w: cap, h: spec.wid, r: r * 0.25, fill: "#b9bec2", outline: true });
  } else if (spec.endWid && spec.endLen) {
    pieces.push({ t: "body", d: waistedPath(spec.len, spec.wid, spec.endWid, spec.endLen), fill: spec.fill });
  } else {
    pieces.push({
      t: "rect",
      x: -bodyHalf, y: -r, w: spec.len, h: spec.wid,
      r: spec.square ? spec.wid * 0.06 : spec.wid * 0.28,
      fill: spec.fill,
      outline: true,
    });
  }

  if (spec.bands) {
    const margin = spec.len * 0.13;
    const bw = spec.len * 0.068;
    const step = bw + spec.len * 0.05;
    const digits = spec.bands.slice(0, -1);
    const band = (x: number, color: string): Piece => {
      const h = halfAt(spec, x + bw / 2);
      return { t: "rect", x, y: -h, w: bw, h: h * 2, r: 0, fill: color, band: true };
    };
    digits.forEach((color, i) => pieces.push(band(-bodyHalf + margin + i * step, color)));
    pieces.push(band(bodyHalf - margin - bw, spec.bands[spec.bands.length - 1]));
  }

  if (spec.mark) {
    const mw = spec.len * 0.16;
    pieces.push({ t: "rect", x: bodyHalf - spec.len * 0.1 - mw, y: -r, w: mw, h: spec.wid, r: 0, fill: spec.mark, mark: true });
  }

  return pieces;
}

/** The drawn parts of a package, in millimetres, in the pin-1 to pin-2 frame. */
export function bodyPieces(spec: PackageSpec, spanMm: number): Piece[] {
  const half = spanMm / 2;
  const r = spec.wid / 2;

  switch (spec.shape) {
    case "axial":
      return axialPieces(spec, spanMm);

    case "box": {
      const bodyHalf = spec.len / 2;
      return [
        ...radialLeads(half, bodyHalf),
        { t: "rect", x: -bodyHalf, y: -r, w: spec.len, h: spec.wid, r: spec.wid * 0.25, fill: spec.fill, outline: true },
      ];
    }

    case "disc": {
      const bodyHalf = spec.len / 2;
      return [
        ...radialLeads(half, bodyHalf),
        { t: "rect", x: -bodyHalf, y: -r, w: spec.len, h: spec.wid, r, fill: spec.fill, outline: true },
      ];
    }

    case "can": {
      const stripeR = r * 0.8;
      const a = (50 * Math.PI) / 180;
      const pieces: Piece[] = [
        ...radialLeads(half, r),
        { t: "circle", cx: 0, cy: 0, rad: r, fill: spec.fill, outline: true },
      ];
      if (spec.mark) {
        // Vent score on the top of an electrolytic.
        pieces.push({ t: "line", x1: -r * 0.4, y1: -r * 0.4, x2: r * 0.4, y2: r * 0.4, stroke: "rgba(255,255,255,0.13)", sw: r * 0.05 });
        pieces.push({ t: "line", x1: -r * 0.4, y1: r * 0.4, x2: r * 0.4, y2: -r * 0.4, stroke: "rgba(255,255,255,0.13)", sw: r * 0.05 });
        pieces.push({
          t: "arc",
          d: `M ${stripeR * Math.cos(-a)} ${stripeR * Math.sin(-a)} A ${stripeR} ${stripeR} 0 0 1 ${stripeR * Math.cos(a)} ${stripeR * Math.sin(a)}`,
          stroke: spec.mark,
          sw: r * 0.2,
        });
      }
      return pieces;
    }

    case "led": {
      const flange = r * 1.16;
      const flat = r * 0.84; // the cathode flat, on the pin-2 side
      const cut = (rad: number): string => {
        const x = Math.min(flat, rad * 0.98);
        const y = Math.sqrt(Math.max(0, rad * rad - x * x));
        return `M ${x} ${-y} A ${rad} ${rad} 0 1 0 ${x} ${y} Z`;
      };
      return [
        ...radialLeads(half, flange),
        { t: "body", d: cut(flange), fill: spec.shade ?? spec.fill },
        { t: "body", d: cut(r * 0.78), fill: spec.fill },
      ];
    }
  }
}
