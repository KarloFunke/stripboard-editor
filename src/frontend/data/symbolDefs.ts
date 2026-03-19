// ── Schematic Symbol Definitions ─────────────────────────
//
// ARCHITECTURE: Pin-first, grid-aligned design.
//
// All pin stubEnd positions MUST be at multiples of G (the grid size = 20).
// Pins are defined first, then the body is drawn around them.
// The symbol origin (0,0) is always grid-aligned.
// Body geometry is decorative — it adapts to pin positions, not vice versa.
//
// Labels and bounding boxes are computed at render time, not stored here.

import { GRID_SIZE } from "@/utils/schematicConstants";

export interface SymbolPinStub {
  pinId: string;
  defaultName: string;
  stubStart: { x: number; y: number }; // where stub meets body
  stubEnd: { x: number; y: number };   // where wire connects (MUST be multiple of G)
  side: "top" | "bottom" | "left" | "right"; // which direction the stub exits
}

export interface SymbolDef {
  symbolId: string;
  label: string;
  category: "passive" | "semiconductor" | "ic" | "connector" | "generic";
  bodyPaths: { d: string; fill?: string; stroke?: string }[];
  extraElements?: SymbolExtraElement[];
  pins: SymbolPinStub[];
}

export interface SymbolExtraElement {
  type: "line" | "circle" | "text";
  props: Record<string, string | number>;
}

const G = GRID_SIZE; // all stubEnd coords MUST be multiples of this

// ── Passive Symbols ───────────────────────────────────
// 2-pin vertical: pins at (0, -G) and (0, G) = (0, -20) and (0, 20)

const resistor: SymbolDef = {
  symbolId: "resistor",
  label: "Resistor",
  category: "passive",
  bodyPaths: [
    { d: "M 0 -10 L 5 -8 L -5 -3 L 5 2 L -5 7 L 5 12 L 0 14", fill: "none" },
    // Stub lines from body to pin endpoints
    { d: "M 0 -10 L 0 -20", fill: "none" },
    { d: "M 0 14 L 0 20", fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "1", stubStart: { x: 0, y: -10 }, stubEnd: { x: 0, y: -G }, side: "top" },
    { pinId: "2", defaultName: "2", stubStart: { x: 0, y: 14 }, stubEnd: { x: 0, y: G }, side: "bottom" },
  ],
};

const capacitor: SymbolDef = {
  symbolId: "capacitor",
  label: "Capacitor",
  category: "passive",
  bodyPaths: [
    { d: "M -8 -3 L 8 -3", fill: "none" },  // top plate
    { d: "M -8 3 L 8 3", fill: "none" },     // bottom plate
    { d: "M 0 -3 L 0 -20", fill: "none" },   // top stub
    { d: "M 0 3 L 0 20", fill: "none" },      // bottom stub
  ],
  pins: [
    { pinId: "1", defaultName: "1", stubStart: { x: 0, y: -3 }, stubEnd: { x: 0, y: -G }, side: "top" },
    { pinId: "2", defaultName: "2", stubStart: { x: 0, y: 3 }, stubEnd: { x: 0, y: G }, side: "bottom" },
  ],
};

const capPolarized: SymbolDef = {
  symbolId: "cap-polarized",
  label: "Polarized Capacitor",
  category: "passive",
  bodyPaths: [
    { d: "M -8 -3 L 8 -3", fill: "none" },           // flat plate (+)
    { d: "M -8 3 Q 0 8 8 3", fill: "none" },          // curved plate (−)
    { d: "M 0 -3 L 0 -20", fill: "none" },
    { d: "M 0 3 L 0 20", fill: "none" },
  ],
  extraElements: [
    { type: "text", props: { x: -12, y: 0, fontSize: 10, textAnchor: "end", children: "+" } },
  ],
  pins: [
    { pinId: "1", defaultName: "+", stubStart: { x: 0, y: -3 }, stubEnd: { x: 0, y: -G }, side: "top" },
    { pinId: "2", defaultName: "−", stubStart: { x: 0, y: 3 }, stubEnd: { x: 0, y: G }, side: "bottom" },
  ],
};

// 2-pin horizontal: pins at (-2G, 0) and (2G, 0) = (-40, 0) and (40, 0)
const diode: SymbolDef = {
  symbolId: "diode",
  label: "Diode",
  category: "passive",
  bodyPaths: [
    { d: "M -8 -8 L 8 0 L -8 8 Z", fill: "none" },   // triangle
    { d: "M 8 -8 L 8 8", fill: "none" },                // bar
    { d: "M -8 0 L -2G 0".replace("2G", String(2 * G)), fill: "none" },
    { d: `M 8 0 L ${2 * G} 0`, fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "A", stubStart: { x: -8, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "K", stubStart: { x: 8, y: 0 }, stubEnd: { x: 2 * G, y: 0 }, side: "right" },
  ],
};

const led: SymbolDef = {
  symbolId: "led",
  label: "LED",
  category: "passive",
  bodyPaths: [
    { d: "M -8 -8 L 8 0 L -8 8 Z", fill: "none" },
    { d: "M 8 -8 L 8 8", fill: "none" },
    { d: `M -8 0 L ${-2 * G} 0`, fill: "none" },
    { d: `M 8 0 L ${2 * G} 0`, fill: "none" },
  ],
  extraElements: [
    { type: "line", props: { x1: 2, y1: -12, x2: 8, y2: -18 } },
    { type: "line", props: { x1: 8, y1: -18, x2: 5, y2: -15 } },
    { type: "line", props: { x1: 8, y1: -18, x2: 8, y2: -14 } },
    { type: "line", props: { x1: 6, y1: -10, x2: 12, y2: -16 } },
    { type: "line", props: { x1: 12, y1: -16, x2: 9, y2: -13 } },
    { type: "line", props: { x1: 12, y1: -16, x2: 12, y2: -12 } },
  ],
  pins: [
    { pinId: "1", defaultName: "A", stubStart: { x: -8, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "K", stubStart: { x: 8, y: 0 }, stubEnd: { x: 2 * G, y: 0 }, side: "right" },
  ],
};

const zener: SymbolDef = {
  symbolId: "zener",
  label: "Zener Diode",
  category: "passive",
  bodyPaths: [
    { d: "M -8 -8 L 8 0 L -8 8 Z", fill: "none" },
    { d: "M 6 -10 L 8 -8 L 8 8 L 10 10", fill: "none" },
    { d: `M -8 0 L ${-2 * G} 0`, fill: "none" },
    { d: `M 8 0 L ${2 * G} 0`, fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "A", stubStart: { x: -8, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "K", stubStart: { x: 8, y: 0 }, stubEnd: { x: 2 * G, y: 0 }, side: "right" },
  ],
};

// ── Semiconductor Symbols ─────────────────────────────
// 3-pin: B at (-2G, 0), C at (G, -2G), E at (G, 2G)

const npn: SymbolDef = {
  symbolId: "npn",
  label: "NPN Transistor",
  category: "semiconductor",
  bodyPaths: [
    { d: "M -6 -14 L -6 14", fill: "none" },           // base bar
    { d: "M -6 -7 L 12 -18", fill: "none" },            // collector
    { d: "M -6 7 L 12 18", fill: "none" },               // emitter
    { d: "M 6 13 L 12 18 L 5 17", fill: "none" },        // arrow
    // Stubs to grid-aligned endpoints
    { d: `M -6 0 L ${-2 * G} 0`, fill: "none" },         // B stub
    { d: `M 12 -18 L ${G} ${-2 * G}`, fill: "none" },    // C stub
    { d: `M 12 18 L ${G} ${2 * G}`, fill: "none" },      // E stub
  ],
  extraElements: [
    { type: "circle", props: { cx: 3, cy: 0, r: 20, fill: "none", strokeWidth: 1.5 } },
  ],
  pins: [
    { pinId: "1", defaultName: "B", stubStart: { x: -6, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "C", stubStart: { x: 12, y: -18 }, stubEnd: { x: G, y: -2 * G }, side: "top" },
    { pinId: "3", defaultName: "E", stubStart: { x: 12, y: 18 }, stubEnd: { x: G, y: 2 * G }, side: "bottom" },
  ],
};

const pnp: SymbolDef = {
  symbolId: "pnp",
  label: "PNP Transistor",
  category: "semiconductor",
  bodyPaths: [
    { d: "M -6 -14 L -6 14", fill: "none" },
    { d: "M -6 -7 L 12 -18", fill: "none" },
    { d: "M -6 7 L 12 18", fill: "none" },
    { d: "M -2 4 L -6 7 L 0 10", fill: "none" },  // arrow inward
    { d: `M -6 0 L ${-2 * G} 0`, fill: "none" },
    { d: `M 12 -18 L ${G} ${-2 * G}`, fill: "none" },
    { d: `M 12 18 L ${G} ${2 * G}`, fill: "none" },
  ],
  extraElements: [
    { type: "circle", props: { cx: 3, cy: 0, r: 20, fill: "none", strokeWidth: 1.5 } },
  ],
  pins: [
    { pinId: "1", defaultName: "B", stubStart: { x: -6, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "C", stubStart: { x: 12, y: -18 }, stubEnd: { x: G, y: -2 * G }, side: "top" },
    { pinId: "3", defaultName: "E", stubStart: { x: 12, y: 18 }, stubEnd: { x: G, y: 2 * G }, side: "bottom" },
  ],
};

const nmos: SymbolDef = {
  symbolId: "nmos",
  label: "N-Channel MOSFET",
  category: "semiconductor",
  bodyPaths: [
    { d: "M -8 -12 L -8 12", fill: "none" },     // gate line
    { d: "M -4 -12 L -4 -5", fill: "none" },      // channel
    { d: "M -4 -3 L -4 3", fill: "none" },
    { d: "M -4 5 L -4 12", fill: "none" },
    { d: "M -4 -8 L 12 -8 L 12 -16", fill: "none" }, // drain
    { d: "M -4 8 L 12 8 L 12 16", fill: "none" },     // source
    { d: "M -4 0 L 12 0 L 12 8", fill: "none" },       // body
    { d: "M 4 0 L -1 -3 L -1 3 Z", fill: "currentColor" }, // arrow
    // Stubs
    { d: `M -8 0 L ${-2 * G} 0`, fill: "none" },
    { d: `M 12 -16 L ${G} ${-2 * G}`, fill: "none" },
    { d: `M 12 16 L ${G} ${2 * G}`, fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "G", stubStart: { x: -8, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "D", stubStart: { x: 12, y: -16 }, stubEnd: { x: G, y: -2 * G }, side: "top" },
    { pinId: "3", defaultName: "S", stubStart: { x: 12, y: 16 }, stubEnd: { x: G, y: 2 * G }, side: "bottom" },
  ],
};

const pmos: SymbolDef = {
  symbolId: "pmos",
  label: "P-Channel MOSFET",
  category: "semiconductor",
  bodyPaths: [
    { d: "M -8 -12 L -8 12", fill: "none" },
    { d: "M -4 -12 L -4 -5", fill: "none" },
    { d: "M -4 -3 L -4 3", fill: "none" },
    { d: "M -4 5 L -4 12", fill: "none" },
    { d: "M -4 -8 L 12 -8 L 12 -16", fill: "none" },
    { d: "M -4 8 L 12 8 L 12 16", fill: "none" },
    { d: "M -4 0 L 12 0 L 12 -8", fill: "none" },
    { d: "M 4 0 L 9 -3 L 9 3 Z", fill: "currentColor" }, // arrow outward
    { d: `M -8 0 L ${-2 * G} 0`, fill: "none" },
    { d: `M 12 -16 L ${G} ${-2 * G}`, fill: "none" },
    { d: `M 12 16 L ${G} ${2 * G}`, fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "G", stubStart: { x: -8, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "D", stubStart: { x: 12, y: -16 }, stubEnd: { x: G, y: -2 * G }, side: "top" },
    { pinId: "3", defaultName: "S", stubStart: { x: 12, y: 16 }, stubEnd: { x: G, y: 2 * G }, side: "bottom" },
  ],
};

// Voltage regulator: box with pins at (-2G, 0), (2G, 0), (0, 2G)
const vreg: SymbolDef = {
  symbolId: "vreg",
  label: "Voltage Regulator",
  category: "semiconductor",
  bodyPaths: [
    { d: "M -18 -16 L 18 -16 L 18 16 L -18 16 Z", fill: "none" },
    { d: `M -18 0 L ${-2 * G} 0`, fill: "none" },  // IN stub
    { d: `M 18 0 L ${2 * G} 0`, fill: "none" },     // OUT stub
    { d: `M 0 16 L 0 ${2 * G}`, fill: "none" },     // GND stub
  ],
  extraElements: [
    { type: "text", props: { x: -9, y: 4, fontSize: 8, textAnchor: "middle", children: "IN" } },
    { type: "text", props: { x: 9, y: 4, fontSize: 8, textAnchor: "middle", children: "OUT" } },
    { type: "text", props: { x: 0, y: 13, fontSize: 8, textAnchor: "middle", children: "GND" } },
  ],
  pins: [
    { pinId: "1", defaultName: "IN", stubStart: { x: -18, y: 0 }, stubEnd: { x: -2 * G, y: 0 }, side: "left" },
    { pinId: "2", defaultName: "OUT", stubStart: { x: 18, y: 0 }, stubEnd: { x: 2 * G, y: 0 }, side: "right" },
    { pinId: "3", defaultName: "GND", stubStart: { x: 0, y: 16 }, stubEnd: { x: 0, y: 2 * G }, side: "bottom" },
  ],
};

// ── Generic Box Symbols ───────────────────────────────

const generic2pin: SymbolDef = {
  symbolId: "generic-2pin",
  label: "Generic 2-Pin",
  category: "generic",
  bodyPaths: [
    { d: "M -8 -8 L 8 -8 L 8 8 L -8 8 Z", fill: "none" },
    { d: "M 0 -8 L 0 -20", fill: "none" },
    { d: "M 0 8 L 0 20", fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "1", stubStart: { x: 0, y: -8 }, stubEnd: { x: 0, y: -G }, side: "top" },
    { pinId: "2", defaultName: "2", stubStart: { x: 0, y: 8 }, stubEnd: { x: 0, y: G }, side: "bottom" },
  ],
};

const generic3pin: SymbolDef = {
  symbolId: "generic-3pin",
  label: "Generic 3-Pin",
  category: "generic",
  bodyPaths: [
    { d: "M -8 -G L 8 -G L 8 G L -8 G Z".replaceAll("G", String(G)), fill: "none" },
    { d: `M 0 ${-G} L 0 ${-2 * G}`, fill: "none" },
    { d: `M -8 0 L ${-G} 0`, fill: "none" },
    { d: `M 0 ${G} L 0 ${2 * G}`, fill: "none" },
  ],
  pins: [
    { pinId: "1", defaultName: "1", stubStart: { x: 0, y: -G }, stubEnd: { x: 0, y: -2 * G }, side: "top" },
    { pinId: "2", defaultName: "2", stubStart: { x: -8, y: 0 }, stubEnd: { x: -G, y: 0 }, side: "left" },
    { pinId: "3", defaultName: "3", stubStart: { x: 0, y: G }, stubEnd: { x: 0, y: 2 * G }, side: "bottom" },
  ],
};

// ── Static symbol registry ────────────────────────────

const STATIC_SYMBOLS: SymbolDef[] = [
  resistor, capacitor, capPolarized, diode, led, zener,
  npn, pnp, nmos, pmos, vreg,
  generic2pin, generic3pin,
];

// ── Dynamic symbol generators ─────────────────────────

/** Create a generic IC symbol. Pins at grid-aligned positions. */
export function createGenericIcSymbol(pinCount: number): SymbolDef {
  const pinsPerSide = Math.ceil(pinCount / 2);
  const rightCount = pinCount - pinsPerSide;
  const bodyWidth = 60;
  const halfW = bodyWidth / 2;

  // Pins spaced G apart, starting at y=0
  // Center vertically: offset so the group is centered around 0
  const extent = (pinsPerSide - 1) * G;
  const yStart = -Math.floor(extent / 2 / G) * G; // round DOWN to grid

  const pins: SymbolPinStub[] = [];
  const bodyTop = yStart - 10;
  const bodyBottom = yStart + extent + 10;

  // Left side: top to bottom
  for (let i = 0; i < pinsPerSide; i++) {
    const y = yStart + i * G;
    pins.push({
      pinId: String(i + 1),
      defaultName: String(i + 1),
      stubStart: { x: -halfW, y },
      stubEnd: { x: -halfW - G, y },
      side: "left",
    });
  }

  // Right side: bottom to top
  for (let i = 0; i < rightCount; i++) {
    const y = yStart + extent - i * G;
    pins.push({
      pinId: String(pinsPerSide + i + 1),
      defaultName: String(pinsPerSide + i + 1),
      stubStart: { x: halfW, y },
      stubEnd: { x: halfW + G, y },
      side: "right",
    });
  }

  // Build body paths including stubs
  const bodyPaths: SymbolDef["bodyPaths"] = [
    { d: `M ${-halfW} ${bodyTop} L ${halfW} ${bodyTop} L ${halfW} ${bodyBottom} L ${-halfW} ${bodyBottom} Z`, fill: "none" },
    { d: `M -6 ${bodyTop} A 6 6 0 0 1 6 ${bodyTop}`, fill: "none" }, // notch
  ];
  // Add stub lines
  for (const pin of pins) {
    bodyPaths.push({ d: `M ${pin.stubStart.x} ${pin.stubStart.y} L ${pin.stubEnd.x} ${pin.stubEnd.y}`, fill: "none" });
  }

  return {
    symbolId: `generic-ic-${pinCount}`,
    label: `Generic IC (${pinCount}-pin)`,
    category: "ic",
    bodyPaths,
    pins,
  };
}

/** Create a connector symbol. Pins at grid-aligned positions. */
export function createConnectorSymbol(pinCount: number): SymbolDef {
  const bodyWidth = 20;
  const halfW = bodyWidth / 2;
  // Ensure stub endpoints land on grid multiples
  const stubEndX = -Math.ceil((halfW + G) / G) * G; // round outward to grid

  const extent = (pinCount - 1) * G;
  const yStart = -Math.floor(extent / 2 / G) * G;

  const pins: SymbolPinStub[] = [];
  const bodyTop = yStart - 10;
  const bodyBottom = yStart + extent + 10;

  for (let i = 0; i < pinCount; i++) {
    const y = yStart + i * G;
    pins.push({
      pinId: String(i + 1),
      defaultName: String(i + 1),
      stubStart: { x: -halfW, y },
      stubEnd: { x: stubEndX, y },
      side: "left",
    });
  }

  const bodyPaths: SymbolDef["bodyPaths"] = [
    { d: `M ${-halfW} ${bodyTop} L ${halfW} ${bodyTop} L ${halfW} ${bodyBottom} L ${-halfW} ${bodyBottom} Z`, fill: "none" },
  ];
  for (const pin of pins) {
    bodyPaths.push({ d: `M ${pin.stubStart.x} ${pin.stubStart.y} L ${pin.stubEnd.x} ${pin.stubEnd.y}`, fill: "none" });
  }

  return {
    symbolId: `connector-${pinCount}`,
    label: `Connector (${pinCount}-pin)`,
    category: "connector",
    bodyPaths,
    pins,
  };
}

// ── Public API ────────────────────────────────────────

export function getSymbolDef(symbolId: string): SymbolDef | undefined {
  const staticMatch = STATIC_SYMBOLS.find((s) => s.symbolId === symbolId);
  if (staticMatch) return staticMatch;

  const icMatch = symbolId.match(/^generic-ic-(\d+)$/);
  if (icMatch) return createGenericIcSymbol(parseInt(icMatch[1], 10));

  const connMatch = symbolId.match(/^connector-(\d+)$/);
  if (connMatch) return createConnectorSymbol(parseInt(connMatch[1], 10));

  return undefined;
}

export const ALL_STATIC_SYMBOLS = STATIC_SYMBOLS;
