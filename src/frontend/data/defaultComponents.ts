import { ComponentDef, PinDef, BodyCell } from "@/types";

// ── Footprint Helpers ─────────────────────────────────
// These create the physical stripboard footprint (pins + body cells).

/** 2-pin vertical with given hole spacing */
function create2Pin(spacing: number): Omit<ComponentDef, "id" | "name" | "category" | "symbol" | "defaultLabelPrefix"> {
  const bodyCells: BodyCell[] = [];
  for (let r = 1; r < spacing - 1; r++) {
    bodyCells.push({ row: r, col: 0 });
  }
  return {
    width: 1,
    height: spacing,
    pins: [
      { id: "1", name: "1", offsetRow: 0, offsetCol: 0 },
      { id: "2", name: "2", offsetRow: spacing - 1, offsetCol: 0 },
    ],
    bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
  };
}

/** 3-pin vertical, compact (no gaps) or spaced (1 gap between each) */
function create3Pin(spaced: boolean): Omit<ComponentDef, "id" | "name" | "category" | "symbol" | "defaultLabelPrefix"> {
  const step = spaced ? 2 : 1;
  const height = step * 2 + 1;
  const bodyCells: BodyCell[] = [];
  if (spaced) {
    bodyCells.push({ row: 1, col: 0 });
    bodyCells.push({ row: 3, col: 0 });
  }
  return {
    width: 1,
    height,
    pins: [
      { id: "1", name: "1", offsetRow: 0, offsetCol: 0 },
      { id: "2", name: "2", offsetRow: step, offsetCol: 0 },
      { id: "3", name: "3", offsetRow: step * 2, offsetCol: 0 },
    ],
    bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
  };
}

/** Inline N-pin vertical (single column, no gaps) */
function createInline(pinCount: number): Omit<ComponentDef, "id" | "name" | "category" | "symbol" | "defaultLabelPrefix"> {
  return {
    width: 1,
    height: pinCount,
    pins: Array.from({ length: pinCount }, (_, i) => ({
      id: String(i + 1),
      name: String(i + 1),
      offsetRow: i,
      offsetCol: 0,
    })),
  };
}

/**
 * Standard DIP package.
 * 4 columns wide (pin - body - body - pin), pinCount/2 rows tall.
 */
function createDIP(pinCount: number): Omit<ComponentDef, "id" | "name" | "category" | "symbol" | "defaultLabelPrefix"> {
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
function createBreakoutBoard(
  leftNames: string[],
  rightNames: string[],
  width: number,
): Omit<ComponentDef, "id" | "name" | "category" | "symbol" | "defaultLabelPrefix"> {
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

/** Category grouping for the visual library */
export interface ComponentGroup {
  label: string;
  components: ComponentDef[];
}

export const COMPONENT_GROUPS: ComponentGroup[] = [
  {
    label: "Passive",
    components: [
      {
        id: "def-resistor",
        name: "Resistor",
        category: "passive",
        hasValue: true,
        symbol: "resistor",
        defaultLabelPrefix: "R",
        ...create2Pin(5),
        flexible: true,
      },
      {
        id: "def-capacitor",
        name: "Capacitor",
        category: "passive",
        hasValue: true,
        symbol: "capacitor",
        defaultLabelPrefix: "C",
        ...create2Pin(2),
        flexible: true,
      },
      {
        id: "def-cap-polarized",
        name: "Polarized Capacitor",
        category: "passive",
        hasValue: true,
        symbol: "cap-polarized",
        defaultLabelPrefix: "C",
        ...create2Pin(2),
        pins: [
          { id: "1", name: "+", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "−", offsetRow: 1, offsetCol: 0 },
        ],
        flexible: true,
      },
      {
        id: "def-diode",
        name: "Diode",
        category: "passive",
        hasValue: true,
        symbol: "diode",
        defaultLabelPrefix: "D",
        ...create2Pin(4),
        pins: [
          { id: "1", name: "A", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "K", offsetRow: 3, offsetCol: 0 },
        ],
        flexible: true,
      },
      {
        id: "def-led",
        name: "LED",
        category: "passive",
        symbol: "led",
        defaultLabelPrefix: "D",
        ...create2Pin(2),
        pins: [
          { id: "1", name: "A", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "K", offsetRow: 1, offsetCol: 0 },
        ],
        flexible: true,
      },
      {
        id: "def-zener",
        name: "Zener Diode",
        category: "passive",
        hasValue: true,
        symbol: "zener",
        defaultLabelPrefix: "D",
        ...create2Pin(4),
        pins: [
          { id: "1", name: "A", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "K", offsetRow: 3, offsetCol: 0 },
        ],
        flexible: true,
      },
      {
        id: "def-inductor",
        name: "Inductor",
        category: "passive",
        hasValue: true,
        symbol: "inductor",
        defaultLabelPrefix: "L",
        ...create2Pin(5),
        flexible: true,
      },
      {
        id: "def-transformer",
        name: "Transformer",
        category: "passive",
        hasValue: true,
        symbol: "transformer",
        defaultLabelPrefix: "T",
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
      {
        id: "def-switch",
        name: "Switch",
        category: "passive",
        symbol: "switch",
        defaultLabelPrefix: "S",
        ...create2Pin(4),
      },
      {
        id: "def-potentiometer",
        name: "Potentiometer",
        category: "passive",
        hasValue: true,
        symbol: "potentiometer",
        defaultLabelPrefix: "RV",
        width: 1,
        height: 3,
        pins: [
          { id: "1", name: "VCC", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "OUT", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "GND", offsetRow: 2, offsetCol: 0 },
        ],
      },
      {
        id: "def-trimpot",
        name: "Trimmer",
        category: "passive",
        hasValue: true,
        symbol: "potentiometer",
        defaultLabelPrefix: "RV",
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
      {
        id: "def-pushbutton",
        name: "Push Button",
        category: "passive",
        symbol: "pushbutton",
        defaultLabelPrefix: "SW",
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
    ],
  },
  {
    label: "Semiconductor",
    components: [
      {
        id: "def-npn",
        name: "NPN Transistor",
        category: "semiconductor",
        hasValue: true,
        symbol: "npn",
        defaultLabelPrefix: "Q",
        ...create3Pin(false),
        pins: [
          { id: "1", name: "B", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "C", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "E", offsetRow: 2, offsetCol: 0 },
        ],
        footprintPresets: ["def-generic-3pin-compact", "def-generic-3pin-spaced"],
      },
      {
        id: "def-pnp",
        name: "PNP Transistor",
        category: "semiconductor",
        hasValue: true,
        symbol: "pnp",
        defaultLabelPrefix: "Q",
        ...create3Pin(false),
        pins: [
          { id: "1", name: "B", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "C", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "E", offsetRow: 2, offsetCol: 0 },
        ],
        footprintPresets: ["def-generic-3pin-compact", "def-generic-3pin-spaced"],
      },
      {
        id: "def-nmos",
        name: "N-Channel MOSFET",
        category: "semiconductor",
        hasValue: true,
        symbol: "nmos",
        defaultLabelPrefix: "Q",
        ...create3Pin(false),
        pins: [
          { id: "1", name: "G", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "D", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "S", offsetRow: 2, offsetCol: 0 },
        ],
        footprintPresets: ["def-generic-3pin-compact", "def-generic-3pin-spaced"],
      },
      {
        id: "def-pmos",
        name: "P-Channel MOSFET",
        category: "semiconductor",
        hasValue: true,
        symbol: "pmos",
        defaultLabelPrefix: "Q",
        ...create3Pin(false),
        pins: [
          { id: "1", name: "G", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "D", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "S", offsetRow: 2, offsetCol: 0 },
        ],
        footprintPresets: ["def-generic-3pin-compact", "def-generic-3pin-spaced"],
      },
    ],
  },
  {
    label: "IC",
    components: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40].map((pinCount) => ({
      id: `def-ic-dip${pinCount}`,
      name: `Generic IC (${pinCount}-pin)`,
      category: "ic" as const,
      symbol: `generic-ic-${pinCount}`,
      defaultLabelPrefix: "U",
      ...createDIP(pinCount),
    })),
  },
  {
    label: "Connector",
    components: Array.from({ length: 20 }, (_, i) => {
      const pinCount = i + 1;
      return {
        id: `def-connector-${pinCount}`,
        name: `Connector (${pinCount}-pin)`,
        category: "connector" as const,
        symbol: `connector-${pinCount}`,
        defaultLabelPrefix: "J",
        ...createInline(pinCount),
      };
    }),
  },
  {
    label: "Common",
    components: [
      {
        id: "def-vreg",
        name: "Voltage Regulator",
        category: "ic" as const,
        symbol: "vreg",
        defaultLabelPrefix: "U",
        ...create3Pin(false),
        pins: [
          { id: "1", name: "IN", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "GND", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "OUT", offsetRow: 2, offsetCol: 0 },
        ],
      },
      {
        id: "def-555",
        name: "555 Timer",
        category: "ic" as const,
        symbol: "timer-555",
        defaultLabelPrefix: "U",
        ...createDIP(8),
        pins: [
          { id: "1", name: "GND", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "TRIG", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "OUT", offsetRow: 2, offsetCol: 0 },
          { id: "4", name: "RESET", offsetRow: 3, offsetCol: 0 },
          { id: "5", name: "CTRL", offsetRow: 3, offsetCol: 3 },
          { id: "6", name: "THRESH", offsetRow: 2, offsetCol: 3 },
          { id: "7", name: "DISCH", offsetRow: 1, offsetCol: 3 },
          { id: "8", name: "VCC", offsetRow: 0, offsetCol: 3 },
        ],
      },
      {
        id: "def-optocoupler",
        name: "Optocoupler",
        category: "ic" as const,
        symbol: "optocoupler",
        defaultLabelPrefix: "U",
        ...createDIP(4),
        pins: [
          { id: "1", name: "A", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "K", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "E", offsetRow: 1, offsetCol: 3 },
          { id: "4", name: "C", offsetRow: 0, offsetCol: 3 },
        ],
      },
      {
        id: "def-opamp",
        name: "Op-Amp",
        category: "ic" as const,
        symbol: "opamp",
        defaultLabelPrefix: "U",
        ...createDIP(8),
        pins: [
          { id: "1", name: "OS1", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "−", offsetRow: 1, offsetCol: 0 },
          { id: "3", name: "+", offsetRow: 2, offsetCol: 0 },
          { id: "4", name: "V−", offsetRow: 3, offsetCol: 0 },
          { id: "5", name: "OS2", offsetRow: 3, offsetCol: 3 },
          { id: "6", name: "OUT", offsetRow: 2, offsetCol: 3 },
          { id: "7", name: "V+", offsetRow: 1, offsetCol: 3 },
          { id: "8", name: "NC", offsetRow: 0, offsetCol: 3 },
        ],
      },
      {
        id: "def-esp32-devkit-v1",
        name: "ESP32 DevKit V1 (30-pin)",
        category: "ic" as const,
        symbol: "generic-ic-30",
        defaultLabelPrefix: "U",
        ...createBreakoutBoard(ESP32_V1_LEFT, ESP32_V1_RIGHT, 10),
      },
      {
        id: "def-esp32-devkit-v1-36",
        name: "ESP32 DevKit V1 (36-pin)",
        category: "ic" as const,
        symbol: "generic-ic-36",
        defaultLabelPrefix: "U",
        ...createBreakoutBoard(ESP32_36_LEFT, ESP32_36_RIGHT, 10),
      },
      {
        id: "def-esp32-devkitc-38",
        name: "ESP32 DevKitC (38-pin)",
        category: "ic" as const,
        symbol: "generic-ic-38",
        defaultLabelPrefix: "U",
        ...createBreakoutBoard(ESP32_C_LEFT, ESP32_C_RIGHT, 11),
      },
      {
        id: "def-arduino-nano",
        name: "Arduino Nano (30-pin)",
        category: "ic" as const,
        symbol: "generic-ic-30",
        defaultLabelPrefix: "U",
        ...createBreakoutBoard(NANO_LEFT, NANO_RIGHT, 7),
      },
    ],
  },
];

/** Hidden footprint preset defs — not shown in the library but referenced by footprintPresets */
const FOOTPRINT_PRESETS: ComponentDef[] = [
  ...[2, 3, 4, 5, 7].map((spacing) => ({
    id: `def-generic-2pin-${spacing}h`,
    name: `2-Pin (${spacing}h)`,
    category: "generic" as const,
    symbol: "generic-2pin",
    defaultLabelPrefix: "X",
    ...create2Pin(spacing),
  })),
  {
    id: "def-generic-3pin-compact",
    name: "3-Pin Compact",
    category: "generic" as const,
    symbol: "generic-3pin",
    defaultLabelPrefix: "X",
    ...create3Pin(false),
  },
  {
    id: "def-generic-3pin-spaced",
    name: "3-Pin Spaced",
    category: "generic" as const,
    symbol: "generic-3pin",
    defaultLabelPrefix: "X",
    ...create3Pin(true),
  },
];

/** Flat array of all default components (visible + hidden presets, for store initialization) */
export const DEFAULT_COMPONENTS: ComponentDef[] = [
  ...COMPONENT_GROUPS.flatMap((g) => g.components),
  ...FOOTPRINT_PRESETS,
];
