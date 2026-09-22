import { ComponentDef, Footprint, PartSpec, PinDef, BodyCell } from "@/types";
import { IC_LIBRARY } from "./icLibrary";

// ── Footprints ────────────────────────────────────────
// These create the physical stripboard footprint (pins + body cells).

type Layout = Pick<ComponentDef, "width" | "height" | "pins" | "bodyCells">;

/** One column, pins `step` holes apart, body in the gaps between them */
function createInline(pinCount: number, step: number): Layout {
  const pins: PinDef[] = [];
  const bodyCells: BodyCell[] = [];
  for (let i = 0; i < pinCount; i++) {
    pins.push({ id: String(i + 1), name: String(i + 1), offsetRow: i * step, offsetCol: 0 });
  }
  for (let r = 1; r < (pinCount - 1) * step; r++) {
    if (r % step !== 0) bodyCells.push({ row: r, col: 0 });
  }
  return {
    width: 1,
    height: (pinCount - 1) * step + 1,
    pins,
    bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
  };
}

/**
 * Standard DIP package.
 * 4 columns wide (pin - body - body - pin), pinCount/2 rows tall.
 */
function createDIP(pinCount: number): Layout {
  const pinsPerSide = pinCount / 2;
  const pins: PinDef[] = [];
  const bodyCells: BodyCell[] = [];

  for (let i = 0; i < pinsPerSide; i++) {
    pins.push({ id: String(i + 1), name: String(i + 1), offsetRow: i, offsetCol: 0 });
  }
  for (let i = 0; i < pinsPerSide; i++) {
    pins.push({
      id: String(pinsPerSide + i + 1),
      name: String(pinsPerSide + i + 1),
      offsetRow: pinsPerSide - 1 - i,
      offsetCol: 3,
    });
  }
  for (let r = 0; r < pinsPerSide; r++) {
    bodyCells.push({ row: r, col: 1 });
    bodyCells.push({ row: r, col: 2 });
  }

  return {
    width: 4,
    height: pinsPerSide,
    pins,
    bodyCells,
  };
}

/**
 * Dev-board breakout footprint: two rows of pins spanning a wide body, like an
 * ESP32 straddling the centre of a breadboard. `leftNames`/`rightNames` are the
 * silk labels in physical top-to-bottom order for each column; `width` is the
 * hole span between the two rows (row spacing in 0.1in units, plus 1).
 *
 * Right-column ids run bottom-to-top so a generic-ic schematic symbol places
 * every pin at its physical position, and the last pin stays on the top edge so
 * the pin-1 notch renders there.
 */
function createBreakoutBoard(leftNames: string[], rightNames: string[], width: number): Layout {
  const perSide = leftNames.length;
  const pins: PinDef[] = [];
  const bodyCells: BodyCell[] = [];

  leftNames.forEach((name, i) => {
    pins.push({ id: String(i + 1), name, offsetRow: i, offsetCol: 0 });
  });
  for (let i = perSide - 1; i >= 0; i--) {
    pins.push({ id: String(2 * perSide - i), name: rightNames[i], offsetRow: i, offsetCol: width - 1 });
  }
  for (let r = 0; r < perSide; r++) {
    for (let c = 1; c < width - 1; c++) bodyCells.push({ row: r, col: c });
  }

  return { width, height: perSide, pins, bodyCells };
}

function layoutOf(f: Footprint): Layout {
  switch (f.kind) {
    case "inline": return createInline(f.pins, f.step ?? 1);
    case "dip": return createDIP(f.pins);
    case "to": return createInline(3, 1);
    case "breakout": return createBreakoutBoard(f.left, f.right, f.width);
    case "cells": return { width: f.width, height: f.height, pins: f.pins, bodyCells: f.bodyCells };
  }
}

function defaultSymbol(spec: PartSpec): string {
  const f = spec.footprint;
  if (f.kind === "dip") return `generic-ic-${f.pins}`;
  if (f.kind === "to") return "generic-ic-3";
  if (f.kind === "breakout") return `generic-ic-${f.left.length + f.right.length}`;
  if (f.kind === "inline" && spec.category === "connector") return `connector-${f.pins}`;
  throw new Error(`${spec.id} needs a symbol`);
}

/** The ComponentDef a part spec describes: its footprint with the spec's pin names on it. */
export function partDef(spec: PartSpec): ComponentDef {
  const layout = layoutOf(spec.footprint);
  const names = spec.pins;
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category ?? "ic",
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    footprint: spec.footprint,
    symbol: spec.symbol ?? defaultSymbol(spec),
    defaultLabelPrefix: spec.labelPrefix ?? "U",
    ...layout,
    pins: names ? layout.pins.map((p) => ({ ...p, name: names[Number(p.id) - 1] ?? p.name })) : layout.pins,
    ...(spec.hasValue ? { hasValue: true } : {}),
    ...(spec.flexible ? { flexible: true } : {}),
    ...(spec.footprintPresets ? { footprintPresets: spec.footprintPresets } : {}),
  };
}

// ESP32 dev-board pinouts, physical top-to-bottom per column (antenna at top).
const ESP32_V1_LEFT = ["EN", "IO36", "IO39", "IO34", "IO35", "IO32", "IO33", "IO25", "IO26", "IO27", "IO14", "IO12", "IO13", "GND", "VIN"];
const ESP32_V1_RIGHT = ["IO23", "IO22", "IO1", "IO3", "IO21", "IO19", "IO18", "IO5", "IO17", "IO16", "IO4", "IO2", "IO15", "GND", "3V3"];
// 36-pin DOIT V1 additionally breaks out the flash pins (IO9/10/11 left, IO0/8/7/6 right).
const ESP32_36_LEFT = ["EN", "IO36", "IO39", "IO34", "IO35", "IO32", "IO33", "IO25", "IO26", "IO27", "IO14", "IO12", "IO13", "IO9", "IO10", "IO11", "GND", "VIN"];
const ESP32_36_RIGHT = ["IO23", "IO22", "IO1", "IO3", "IO21", "IO19", "IO18", "IO5", "IO17", "IO16", "IO4", "IO2", "IO15", "IO0", "IO8", "IO7", "IO6", "3V3"];
const ESP32_C_LEFT = ["3V3", "EN", "IO36", "IO39", "IO34", "IO35", "IO32", "IO33", "IO25", "IO26", "IO27", "IO14", "IO12", "GND", "IO13", "IO9", "IO10", "IO11", "VIN"];
const ESP32_C_RIGHT = ["GND", "IO23", "IO22", "IO1", "IO3", "IO21", "GND", "IO19", "IO18", "IO5", "IO17", "IO16", "IO4", "IO0", "IO2", "IO15", "IO8", "IO7", "IO6"];
const NANO_LEFT = ["TX", "RX", "RST", "GND", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12"];
const NANO_RIGHT = ["VIN", "GND", "RST", "5V", "A7", "A6", "A5", "A4", "A3", "A2", "A1", "A0", "AREF", "3V3", "D13"];

// ── Component Library ─────────────────────────────────

const PASSIVE = "Passive";
const SEMICONDUCTOR = "Semiconductor";
const OPAMPS = "Op amps & comparators";
const TIMERS = "Timers";
const MCU = "Microcontrollers & modules";
const CONNECTOR = "Connector";

/** Panel groups in the order they are listed */
export const COMPONENT_GROUP_LABELS = [
  PASSIVE, SEMICONDUCTOR, CONNECTOR, "Regulators & references", TIMERS, OPAMPS, "Optocouplers", MCU, "Logic", "Audio", "Drivers & sensors",
];

const TRANSISTOR_PRESETS = ["def-generic-3pin-compact", "def-generic-3pin-spaced"];

const BUILT_IN_PARTS: PartSpec[] = [
  {
    id: "def-resistor",
    name: "Resistor",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "resistor",
    labelPrefix: "R",
    footprint: { kind: "inline", pins: 2, step: 4 },
    flexible: true,
  },
  {
    id: "def-capacitor",
    name: "Capacitor",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "capacitor",
    labelPrefix: "C",
    footprint: { kind: "inline", pins: 2 },
    flexible: true,
  },
  {
    id: "def-cap-polarized",
    name: "Polarized Capacitor",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "cap-polarized",
    labelPrefix: "C",
    footprint: { kind: "inline", pins: 2 },
    pins: ["+", "−"],
    flexible: true,
  },
  {
    id: "def-led",
    name: "LED",
    group: PASSIVE,
    category: "passive",
    // The value carries the colour ("red", "grün", "#ff8800"), which is
    // what tells one LED from another.
    hasValue: true,
    symbol: "led",
    labelPrefix: "D",
    footprint: { kind: "inline", pins: 2 },
    pins: ["A", "K"],
    flexible: true,
  },
  {
    id: "def-diode",
    name: "Diode",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "diode",
    labelPrefix: "D",
    footprint: { kind: "inline", pins: 2, step: 3 },
    pins: ["A", "K"],
    flexible: true,
  },
  {
    id: "def-potentiometer",
    name: "Potentiometer",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "potentiometer",
    labelPrefix: "RV",
    footprint: { kind: "inline", pins: 3 },
    pins: ["VCC", "OUT", "GND"],
  },
  {
    id: "def-switch",
    name: "Switch (toggle/slide)",
    group: PASSIVE,
    category: "passive",
    symbol: "switch",
    labelPrefix: "S",
    footprint: { kind: "inline", pins: 2, step: 3 },
  },
  {
    id: "def-zener",
    name: "Zener Diode",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "zener",
    labelPrefix: "D",
    footprint: { kind: "inline", pins: 2, step: 3 },
    pins: ["A", "K"],
    flexible: true,
  },
  {
    id: "def-pushbutton",
    name: "Push button (momentary)",
    group: PASSIVE,
    category: "passive",
    symbol: "pushbutton",
    labelPrefix: "SW",
    footprint: {
      kind: "cells",
      width: 4,
      height: 3,
      // 4 legs, 2 electrical nodes: same-id legs share a net (and a strip).
      pins: [
        { id: "1", name: "1", offsetRow: 0, offsetCol: 0 },
        { id: "1", name: "1", offsetRow: 0, offsetCol: 3 },
        { id: "2", name: "2", offsetRow: 2, offsetCol: 0 },
        { id: "2", name: "2", offsetRow: 2, offsetCol: 3 },
      ],
      bodyCells: [
        { row: 0, col: 1 }, { row: 0, col: 2 },
        { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
        { row: 2, col: 1 }, { row: 2, col: 2 },
      ],
    },
  },
  {
    id: "def-inductor",
    name: "Inductor",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "inductor",
    labelPrefix: "L",
    footprint: { kind: "inline", pins: 2, step: 4 },
    flexible: true,
  },
  {
    id: "def-fuse",
    name: "Fuse",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "fuse",
    labelPrefix: "F",
    // a 3.6 x 10 mm cartridge lies flat over six holes, leads in the end ones
    footprint: { kind: "inline", pins: 2, step: 5 },
    flexible: true,
  },
  {
    id: "def-transformer",
    name: "Transformer",
    group: PASSIVE,
    category: "passive",
    hasValue: true,
    symbol: "transformer",
    labelPrefix: "T",
    footprint: {
      kind: "cells",
      width: 4,
      height: 2,
      pins: [
        { id: "1", name: "P1", offsetRow: 0, offsetCol: 0 },
        { id: "2", name: "P2", offsetRow: 1, offsetCol: 0 },
        { id: "3", name: "S1", offsetRow: 0, offsetCol: 3 },
        { id: "4", name: "S2", offsetRow: 1, offsetCol: 3 },
      ],
      bodyCells: [
        { row: 0, col: 1 }, { row: 0, col: 2 },
        { row: 1, col: 1 }, { row: 1, col: 2 },
      ],
    },
  },
  {
    id: "def-npn",
    name: "NPN Transistor",
    group: SEMICONDUCTOR,
    category: "semiconductor",
    hasValue: true,
    symbol: "npn",
    labelPrefix: "Q",
    footprint: { kind: "to" },
    pins: ["B", "C", "E"],
    footprintPresets: TRANSISTOR_PRESETS,
  },
  {
    id: "def-pnp",
    name: "PNP Transistor",
    group: SEMICONDUCTOR,
    category: "semiconductor",
    hasValue: true,
    symbol: "pnp",
    labelPrefix: "Q",
    footprint: { kind: "to" },
    pins: ["B", "C", "E"],
    footprintPresets: TRANSISTOR_PRESETS,
  },
  {
    id: "def-nmos",
    name: "N-Channel MOSFET",
    group: SEMICONDUCTOR,
    category: "semiconductor",
    hasValue: true,
    symbol: "nmos",
    labelPrefix: "Q",
    footprint: { kind: "to" },
    pins: ["G", "D", "S"],
    footprintPresets: TRANSISTOR_PRESETS,
  },
  {
    id: "def-pmos",
    name: "P-Channel MOSFET",
    group: SEMICONDUCTOR,
    category: "semiconductor",
    hasValue: true,
    symbol: "pmos",
    labelPrefix: "Q",
    footprint: { kind: "to" },
    pins: ["G", "D", "S"],
    footprintPresets: TRANSISTOR_PRESETS,
  },
  {
    id: "def-555",
    name: "555 Timer",
    group: TIMERS,
    aliases: ["ne555", "lm555"],
    footprint: { kind: "dip", pins: 8 },
    pins: ["GND", "TRIG", "OUT", "RESET", "CTRL", "THRESH", "DISCH", "VCC"],
  },
  {
    id: "def-esp32-devkit-v1",
    name: "ESP32 DevKit V1 (30-pin)",
    group: MCU,
    footprint: { kind: "breakout", width: 10, left: ESP32_V1_LEFT, right: ESP32_V1_RIGHT },
  },
  {
    id: "def-esp32-devkit-v1-36",
    name: "ESP32 DevKit V1 (36-pin)",
    group: MCU,
    footprint: { kind: "breakout", width: 10, left: ESP32_36_LEFT, right: ESP32_36_RIGHT },
  },
  {
    id: "def-esp32-devkitc-38",
    name: "ESP32 DevKitC (38-pin)",
    group: MCU,
    footprint: { kind: "breakout", width: 11, left: ESP32_C_LEFT, right: ESP32_C_RIGHT },
  },
  {
    id: "def-arduino-nano",
    name: "Arduino Nano (30-pin)",
    group: MCU,
    footprint: { kind: "breakout", width: 7, left: NANO_LEFT, right: NANO_RIGHT },
  },
  ...Array.from({ length: 20 }, (_, i): PartSpec => ({
    id: `def-connector-${i + 1}`,
    name: `Connector (${i + 1}-pin)`,
    group: CONNECTOR,
    category: "connector",
    labelPrefix: "J",
    footprint: { kind: "inline", pins: i + 1 },
  })),
];

/** Every part the panel lists: the parts above, then the IC list from KiCad */
export const PART_SPECS: PartSpec[] = [...BUILT_IN_PARTS, ...IC_LIBRARY];

/** Category grouping for the visual library */
export interface ComponentGroup {
  label: string;
  components: ComponentDef[];
  // Named parts are listed as rows (name, package, what it is); the others
  // as symbol tiles, where the symbol is what tells them apart
  rows: boolean;
}

const TILE_GROUPS = new Set([PASSIVE, SEMICONDUCTOR, CONNECTOR]);

// Tile groups keep the order they are written in above (most used first);
// named parts are listed by name, numbers compared as numbers (LM324 before LM3914)
export const COMPONENT_GROUPS: ComponentGroup[] = COMPONENT_GROUP_LABELS.map((label) => {
  const rows = !TILE_GROUPS.has(label);
  const components = PART_SPECS.filter((s) => s.group === label).map(partDef);
  if (rows) components.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return { label, components, rows };
});

// No longer offered, kept so projects that use them still open: the first
// generic stand-ins, replaced by specific parts from the IC list; the generic
// ICs, replaced by those parts or a custom part; the trimmer, now a package of
// the potentiometer
const RETIRED_PARTS: PartSpec[] = [
  ...[4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40].map((pinCount): PartSpec => ({
    id: `def-ic-dip${pinCount}`,
    name: `Generic IC (${pinCount}-pin)`,
    group: "",
    footprint: { kind: "dip", pins: pinCount },
  })),
  {
    id: "def-trimpot",
    name: "Trimmer",
    group: "",
    category: "passive",
    hasValue: true,
    symbol: "potentiometer",
    labelPrefix: "RV",
    footprint: {
      kind: "cells",
      width: 3,
      height: 3,
      pins: [
        { id: "1", name: "VCC", offsetRow: 2, offsetCol: 0 },
        { id: "2", name: "OUT", offsetRow: 0, offsetCol: 1 },
        { id: "3", name: "GND", offsetRow: 2, offsetCol: 2 },
      ],
      bodyCells: [
        { row: 0, col: 0 }, { row: 0, col: 2 },
        { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 },
        { row: 2, col: 1 },
      ],
    },
  },
  {
    id: "def-opamp",
    name: "Op-Amp",
    group: "",
    symbol: "opamp",
    footprint: { kind: "dip", pins: 8 },
    pins: ["OS1", "−", "+", "V−", "OS2", "OUT", "V+", "NC"],
  },
  {
    id: "def-vreg",
    name: "Voltage Regulator",
    group: "",
    symbol: "vreg",
    footprint: { kind: "to" },
    pins: ["IN", "GND", "OUT"],
  },
  {
    id: "def-optocoupler",
    name: "Optocoupler",
    group: "",
    footprint: { kind: "dip", pins: 4 },
    pins: ["A", "K", "E", "C"],
  },
];

/** Hidden footprint preset defs — not shown in the library but referenced by footprintPresets */
const FOOTPRINT_PRESETS: ComponentDef[] = ([
  ...[2, 3, 4, 5, 7].map((spacing): PartSpec => ({
    id: `def-generic-2pin-${spacing}h`,
    name: `2-Pin (${spacing}h)`,
    group: "",
    category: "generic",
    symbol: "generic-2pin",
    labelPrefix: "X",
    footprint: { kind: "inline", pins: 2, step: spacing - 1 },
  })),
  {
    id: "def-generic-3pin-compact",
    name: "3-Pin Compact",
    group: "",
    category: "generic",
    symbol: "generic-3pin",
    labelPrefix: "X",
    footprint: { kind: "inline", pins: 3 },
  },
  {
    id: "def-generic-3pin-spaced",
    name: "3-Pin Spaced",
    group: "",
    category: "generic",
    symbol: "generic-3pin",
    labelPrefix: "X",
    footprint: { kind: "inline", pins: 3, step: 2 },
  },
] satisfies PartSpec[]).map(partDef);

/** Flat array of all default components (visible + hidden presets, for store initialization) */
export const DEFAULT_COMPONENTS: ComponentDef[] = [
  ...COMPONENT_GROUPS.flatMap((g) => g.components),
  ...RETIRED_PARTS.map(partDef),
  ...FOOTPRINT_PRESETS,
];
