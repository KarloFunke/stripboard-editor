import { Component, ComponentDef, Net, NetAssignment } from "@/types";

// Export the current design as a KiCad legacy S-expression netlist (.net).
// A netlist is purely logical: reference designators, their pins, and the nets
// joining those pins. All geometry (schematic layout, stripboard placement) is
// dropped. See netlist-import-export plan.

interface NetlistInput {
  name: string;
  components: Component[];
  componentDefs: ComponentDef[];
  nets: Net[];
  netAssignments: NetAssignment[];
  date?: string; // ISO string; injected by caller so this stays pure/deterministic
}

// Maps a component def to a KiCad symbol identity + a best-effort THT footprint.
// footprint is left blank where the real package genuinely varies (passives),
// and filled only where a single THT package is the safe default.
interface KicadPart {
  lib: string;
  part: string;
  footprint: string;
}

const PART_MAP: Record<string, KicadPart> = {
  "def-resistor": { lib: "Device", part: "R", footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal" },
  "def-capacitor": { lib: "Device", part: "C", footprint: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm" },
  "def-cap-polarized": { lib: "Device", part: "C_Polarized", footprint: "Capacitor_THT:CP_Radial_D5.0mm_P2.50mm" },
  "def-diode": { lib: "Device", part: "D", footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal" },
  "def-led": { lib: "Device", part: "LED", footprint: "LED_THT:LED_D5.0mm" },
  "def-zener": { lib: "Device", part: "D_Zener", footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal" },
  "def-inductor": { lib: "Device", part: "L", footprint: "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P7.62mm_Horizontal_Vishay_IM-1" },
  "def-transformer": { lib: "Device", part: "Transformer_1P_1S", footprint: "Transformer_THT:Transformer_CHK_EI30-2VA_2xSec" },
  "def-switch": { lib: "Switch", part: "SW_SPST", footprint: "Button_Switch_THT:SW_PUSH_6mm" },
  "def-potentiometer": { lib: "Device", part: "R_Potentiometer", footprint: "Potentiometer_THT:Potentiometer_Alps_RK163_Single_Horizontal" },
  "def-trimpot": { lib: "Device", part: "R_Potentiometer_Trim", footprint: "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical" },
  "def-pushbutton": { lib: "Switch", part: "SW_Push", footprint: "Button_Switch_THT:SW_PUSH_6mm" },
  "def-npn": { lib: "Device", part: "Q_NPN_BCE", footprint: "Package_TO_SOT_THT:TO-92_Inline" },
  "def-pnp": { lib: "Device", part: "Q_PNP_BCE", footprint: "Package_TO_SOT_THT:TO-92_Inline" },
  "def-nmos": { lib: "Device", part: "Q_NMOS_GDS", footprint: "Package_TO_SOT_THT:TO-92_Inline" },
  "def-pmos": { lib: "Device", part: "Q_PMOS_GDS", footprint: "Package_TO_SOT_THT:TO-92_Inline" },
  "def-vreg": { lib: "Regulator_Linear", part: "L7805", footprint: "Package_TO_SOT_THT:TO-220-3_Vertical" },
  "def-555": { lib: "Timer", part: "NE555P", footprint: "Package_DIP:DIP-8_W7.62mm" },
  "def-optocoupler": { lib: "Isolator", part: "PC817", footprint: "Package_DIP:DIP-4_W7.62mm" },
  "def-opamp": { lib: "Amplifier_Operational", part: "LM741", footprint: "Package_DIP:DIP-8_W7.62mm" },
  // Arduino Nano has a real KiCad module footprint (pads 1..30 match our def).
  // The ESP32 DevKit boards do NOT ship a dev-board footprint (only bare WROOM
  // SMD modules), so they fall through to the generic pin-header footprint.
  "def-arduino-nano": { lib: "MCU_Module", part: "Arduino_Nano_v3.x", footprint: "Module:Arduino_Nano" },
};

function sanitizePart(name: string): string {
  return name.replace(/[()"\s]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "UNKNOWN";
}

// Standard DIP body sizes actually present in KiCad's Package_DIP library.
const DIP_SIZES = new Set([3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32]);

// Nickname of the generated footprint library the user registers in KiCad. Any
// part without a geometrically faithful stock footprint (custom parts, module
// breakouts, non-standard-size ICs) gets a generated footprint whose pads sit at
// the exact stripboard positions — a stock pin header's fixed row spacing does
// not match a part spread across the board. See collectGeneratedFootprints.
export const FOOTPRINT_LIB_NICKNAME = "StripboardEditor";

const generatedRef = (def: ComponentDef) => `${FOOTPRINT_LIB_NICKNAME}:${sanitizePart(def.name)}`;

/** Resolve a def to its KiCad symbol identity + footprint. */
function kicadPart(def: ComponentDef): KicadPart {
  const mapped = PART_MAP[def.id];
  if (mapped) return mapped;

  // Generic IC by pin count: a real DIP footprint for standard sizes (its 7.62mm
  // row span matches our DIP layout), otherwise a generated footprint.
  const icMatch = def.symbol.match(/^generic-ic-(\d+)$/);
  if (icMatch && def.category === "ic") {
    const n = parseInt(icMatch[1], 10);
    const footprint = DIP_SIZES.has(n) ? `Package_DIP:DIP-${n}_W7.62mm` : generatedRef(def);
    return { lib: "", part: sanitizePart(def.name), footprint };
  }
  // Pin-header connector (connector-N): single column of consecutive pins, so a
  // 1xN pin header lands exactly on it.
  const connMatch = def.symbol.match(/^connector-(\d+)$/);
  if (connMatch) {
    const n = connMatch[1];
    return {
      lib: "Connector_Generic",
      part: `Conn_01x${n.padStart(2, "0")}`,
      footprint: `Connector_PinHeader_2.54mm:PinHeader_1x${n.padStart(2, "0")}_P2.54mm_Vertical`,
    };
  }
  // Unknown / custom part: generate a footprint from the exact stripboard layout.
  // Pins are carried in libparts below regardless.
  return { lib: "", part: sanitizePart(def.name), footprint: generatedRef(def) };
}

// Distinct pins (first position wins for multi-hole ids), in id order.
function distinctPinsWithPos(def: ComponentDef): { id: string; name: string; row: number; col: number }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string; row: number; col: number }[] = [];
  for (const p of def.pins) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name, row: p.offsetRow, col: p.offsetCol });
  }
  return out;
}

const MM = 2.54; // stripboard pitch
const f2 = (n: number) => n.toFixed(2);

/**
 * A THT .kicad_mod placing one pad per pin at its exact stripboard position,
 * with a silkscreen body outline, courtyard, pin-1 marker, and pin-name labels
 * (on silk inside multi-column bodies, on the fab layer for single-column parts).
 */
// Physical board outline (mm beyond the pad bounding box) and USB-connector edge
// for module breakouts, so their generated footprint matches the real board size
// including the dead space past the pin rows. Dimensions are best-fit to common
// boards; manufacturer variants differ (see netlist-import-export memory).
interface BoardSpec {
  overhang: { top: number; bottom: number; left: number; right: number };
  usb?: "top" | "bottom";
}
const BOARD_SPECS: Record<string, BoardSpec> = {
  // 30-pin DOIT DevKit V1: ~23.4 x 51.5mm, antenna past pin 1, micro-USB opposite.
  "def-esp32-devkit-v1": { overhang: { top: 9.5, bottom: 7, left: 0.5, right: 0.5 }, usb: "bottom" },
  // 36-pin variant: common wide (1.0in) 36-pad board; overhang still estimated.
  "def-esp32-devkit-v1-36": { overhang: { top: 9.5, bottom: 7, left: 1.25, right: 1.25 }, usb: "bottom" },
  // 38-pin DevKitC: matched to Espressif's official footprint (antenna 7.0mm,
  // USB 1.1mm past the pins; ~28 x 54mm, 1.0in row spacing).
  "def-esp32-devkitc-38": { overhang: { top: 7.0, bottom: 1.1, left: 1.5, right: 1.5 }, usb: "bottom" },
};

// Deterministic UUID (no RNG/clock, so exports stay reproducible) for KiCad items.
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
function detUuid(seed: string): string {
  const hx = (salt: string) => fnv(seed + salt).toString(16).padStart(8, "0");
  const a = hx("a"), b = hx("b"), c = hx("c"), d = hx("d");
  const variant = ((parseInt(c[0], 16) & 0x3) | 0x8).toString(16);
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-${variant}${c.slice(1, 4)}-${c.slice(4, 8)}${d}`;
}

function footprintKicadMod(def: ComponentDef): string {
  const name = sanitizePart(def.name);
  // Normalize to the pad bounding box so a def's reserved dead-space rows don't
  // leave the footprint origin floating above the first pad.
  const raw = distinctPinsWithPos(def);
  const r0 = Math.min(...raw.map((p) => p.row));
  const c0 = Math.min(...raw.map((p) => p.col));
  const pins = raw.map((p) => ({ id: p.id, name: p.name, x: (p.col - c0) * MM, y: (p.row - r0) * MM }));
  const xs = pins.map((p) => p.x);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...pins.map((p) => p.y)), maxY = Math.max(...pins.map((p) => p.y));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const multiCol = new Set(xs).size >= 2;

  // Body outline: real board rect when we know the board, else a snug pin margin.
  const spec = BOARD_SPECS[def.id];
  const SILK = 1.5;
  const oT = spec ? spec.overhang.top : SILK;
  const oB = spec ? spec.overhang.bottom : SILK;
  const oL = spec ? spec.overhang.left : SILK;
  const oR = spec ? spec.overhang.right : SILK;
  const bx1 = minX - oL, by1 = minY - oT, bx2 = maxX + oR, by2 = maxY + oB;

  let n = 0;
  const uid = () => detUuid(`${name}:${n++}`);
  const line = (x1: number, y1: number, x2: number, y2: number, layer: string, w: number) =>
    `  (fp_line (start ${f2(x1)} ${f2(y1)}) (end ${f2(x2)} ${f2(y2)}) (stroke (width ${w}) (type solid)) (layer "${layer}") (uuid "${uid()}"))`;
  const box = (x1: number, y1: number, x2: number, y2: number, layer: string, w: number) =>
    [line(x1, y1, x2, y1, layer, w), line(x2, y1, x2, y2, layer, w), line(x2, y2, x1, y2, layer, w), line(x1, y2, x1, y1, layer, w)];
  const text = (kind: string, s: string, x: number, y: number, layer: string, size: number, justify: string, angle = 0) =>
    `  (fp_text ${kind} "${s}" (at ${f2(x)} ${f2(y)} ${angle}) (unlocked yes) (layer "${layer}") (uuid "${uid()}") (effects (font (size ${size} ${size}) (thickness 0.15))${justify ? ` (justify ${justify})` : ""}))`;

  const L: string[] = [];
  L.push(`(footprint "${name}" (version 20221018) (generator "stripboard-editor")`);
  L.push(`  (layer "F.Cu")`);
  L.push(`  (attr through_hole)`);
  L.push(text("reference", "REF**", cx, by1 - 1.2, "F.SilkS", 1, ""));
  // Value centered on the body, running along the long axis so it clears the
  // pin columns on tall boards (rotated 90 degrees when the body is portrait).
  const valAngle = maxY - minY > maxX - minX ? 90 : 0;
  L.push(text("value", name, cx, cy, "F.Fab", 1, "", valAngle));
  L.push(...box(bx1 - 0.25, by1 - 0.25, bx2 + 0.25, by2 + 0.25, "F.CrtYd", 0.05));
  L.push(...box(bx1, by1, bx2, by2, "F.SilkS", 0.12));

  // USB connector: a small silk outline + label on the connector edge.
  if (spec?.usb) {
    const ey = spec.usb === "bottom" ? by2 : by1;
    const dir = spec.usb === "bottom" ? -1 : 1; // toward the body interior
    const w2 = 4.5, depth = 3;
    L.push(...box(cx - w2, ey, cx + w2, ey + dir * depth, "F.SilkS", 0.12));
    L.push(text("user", "USB", cx, ey + dir * (depth + 1.2), "F.SilkS", 0.8, ""));
  }

  // Pin-1 marker: a filled silk dot just outside pin 1.
  const p1 = pins.find((p) => p.id === "1") ?? pins[0];
  let dx = p1.x - cx, dy = p1.y - cy;
  const dl = Math.hypot(dx, dy) || 1;
  dx = dx / dl || -0.7;
  dy = dy / dl || -0.7;
  const mkx = p1.x + dx * (SILK + 0.9), mky = p1.y + dy * (SILK + 0.9);
  L.push(`  (fp_circle (center ${f2(mkx)} ${f2(mky)}) (end ${f2(mkx + 0.3)} ${f2(mky)}) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.SilkS") (uuid "${uid()}"))`);

  for (const p of pins) {
    // Pin 1 (or the first pin) is rectangular, the KiCad convention.
    const shape = p.id === "1" || p === pins[0] ? "rect" : "circle";
    L.push(`  (pad "${p.id}" thru_hole ${shape} (at ${f2(p.x)} ${f2(p.y)}) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask") (uuid "${uid()}"))`);
  }

  // Pin names: on silk beside each pad inside multi-column bodies, else on fab.
  for (const p of pins) {
    if (multiCol) {
      const left = p.x < cx;
      L.push(text("user", p.name, p.x + (left ? 1.6 : -1.6), p.y, "F.SilkS", 0.7, left ? "left" : "right"));
    } else {
      L.push(text("user", p.name, p.x, p.y, "F.Fab", 0.6, ""));
    }
  }

  L.push(`)`);
  return L.join("\n") + "\n";
}

/**
 * The generated footprints this design needs, as `{ name, content }` (name is
 * the `.kicad_mod` filename). Only parts whose footprint resolved to the
 * generated library appear; deduped by part name.
 */
export function collectGeneratedFootprints(
  components: Component[],
  componentDefs: ComponentDef[],
): { name: string; content: string }[] {
  const defById = new Map(componentDefs.map((d) => [d.id, d]));
  const out = new Map<string, string>();
  for (const comp of components) {
    const def = defById.get(comp.defId);
    if (!def) continue;
    const kp = kicadPart(def);
    if (!kp.footprint.startsWith(`${FOOTPRINT_LIB_NICKNAME}:`)) continue;
    const partName = kp.footprint.slice(FOOTPRINT_LIB_NICKNAME.length + 1);
    if (!out.has(partName)) out.set(partName, footprintKicadMod(def));
  }
  return [...out].map(([partName, content]) => ({ name: `${partName}.kicad_mod`, content }));
}

// Distinct pins of a def, in id order, deduped (multi-hole pins share one id).
function defPins(def: ComponentDef): { num: string; name: string }[] {
  const seen = new Set<string>();
  const out: { num: string; name: string }[] = [];
  for (const p of def.pins) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ num: p.id, name: p.name });
  }
  return out.sort((a, b) => {
    const na = parseInt(a.num, 10);
    const nb = parseInt(b.num, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.num.localeCompare(b.num);
  });
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function toKicadNetlist(input: NetlistInput): string {
  const { name, components, componentDefs, nets, netAssignments } = input;
  const date = input.date ?? "";
  const defById = new Map(componentDefs.map((d) => [d.id, d]));

  const lines: string[] = [];
  lines.push(`(export (version "E")`);

  // ── design ──
  lines.push(`  (design`);
  lines.push(`    (source ${q(name)})`);
  lines.push(`    (date ${q(date)})`);
  lines.push(`    (tool ${q("Stripboard Editor")}))`);

  // ── components ──
  lines.push(`  (components`);
  const usedParts = new Map<string, ComponentDef>(); // lib:part -> def (for libparts)
  for (const comp of components) {
    const def = defById.get(comp.defId);
    if (!def) continue;
    const kp = kicadPart(def);
    usedParts.set(`${kp.lib}:${kp.part}`, def);
    const value = comp.value && comp.value.trim() ? comp.value : def.name;
    lines.push(`    (comp (ref ${q(comp.label)})`);
    lines.push(`      (value ${q(value)})`);
    if (kp.footprint) lines.push(`      (footprint ${q(kp.footprint)})`);
    lines.push(`      (libsource (lib ${q(kp.lib)}) (part ${q(kp.part)}) (description ${q(def.name)}))`);
    lines.push(`      (sheetpath (names "/") (tstamps "/"))`);
    lines.push(`      (tstamps ${q(comp.id)}))`);
  }
  lines.push(`  )`);

  // ── libparts ──
  lines.push(`  (libparts`);
  for (const [key, def] of usedParts) {
    const [lib, part] = key.split(/:(.*)/s);
    lines.push(`    (libpart (lib ${q(lib)}) (part ${q(part)})`);
    lines.push(`      (description ${q(def.name)})`);
    lines.push(`      (pins`);
    for (const pin of defPins(def)) {
      lines.push(`        (pin (num ${q(pin.num)}) (name ${q(pin.name)}) (type "passive"))`);
    }
    lines.push(`      ))`);
  }
  lines.push(`  )`);

  // ── nets ──
  const compById = new Map(components.map((c) => [c.id, c]));
  lines.push(`  (nets`);
  let code = 0;
  for (const net of nets) {
    const assigns = netAssignments.filter((a) => a.netId === net.id);
    // Dedupe by (componentId, pinId): multi-hole pins collapse to one node.
    const nodeSeen = new Set<string>();
    const nodes: string[] = [];
    for (const a of assigns) {
      const comp = compById.get(a.componentId);
      if (!comp) continue;
      const def = defById.get(comp.defId);
      if (!def) continue;
      const nodeKey = `${a.componentId}:${a.pinId}`;
      if (nodeSeen.has(nodeKey)) continue;
      nodeSeen.add(nodeKey);
      const pinName = def.pins.find((p) => p.id === a.pinId)?.name ?? a.pinId;
      nodes.push(
        `      (node (ref ${q(comp.label)}) (pin ${q(a.pinId)}) (pinfunction ${q(pinName)}) (pintype "passive"))`
      );
    }
    if (nodes.length === 0) continue;
    code += 1;
    lines.push(`    (net (code ${q(String(code))}) (name ${q(net.name)})`);
    lines.push(...nodes);
    lines.push(`    )`);
  }
  lines.push(`  )`);

  lines.push(`)`);
  return lines.join("\n") + "\n";
}
