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
        symbol: "resistor",
        defaultLabelPrefix: "R",
        ...create2Pin(5),
        flexible: true,
      },
      {
        id: "def-capacitor",
        name: "Capacitor",
        category: "passive",
        symbol: "capacitor",
        defaultLabelPrefix: "C",
        ...create2Pin(2),
        flexible: true,
      },
      {
        id: "def-cap-polarized",
        name: "Polarized Capacitor",
        category: "passive",
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
        symbol: "inductor",
        defaultLabelPrefix: "L",
        ...create2Pin(5),
        flexible: true,
      },
      {
        id: "def-transformer",
        name: "Transformer",
        category: "passive",
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
    ],
  },
  {
    label: "Semiconductor",
    components: [
      {
        id: "def-npn",
        name: "NPN Transistor",
        category: "semiconductor",
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
        ...create3Pin(true),
        pins: [
          { id: "1", name: "IN", offsetRow: 0, offsetCol: 0 },
          { id: "2", name: "GND", offsetRow: 2, offsetCol: 0 },
          { id: "3", name: "OUT", offsetRow: 4, offsetCol: 0 },
        ],
        footprintPresets: ["def-generic-3pin-compact", "def-generic-3pin-spaced"],
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
          { id: "3", name: "C", offsetRow: 1, offsetCol: 3 },
          { id: "4", name: "E", offsetRow: 0, offsetCol: 3 },
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
