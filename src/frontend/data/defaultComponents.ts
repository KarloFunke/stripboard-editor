import { ComponentDef, PinDef, BodyCell } from "@/types";

// ── Helpers ────────────────────────────────────────────

/** 2-pin vertical with given hole spacing */
function create2Pin(spacing: number): ComponentDef {
  const bodyCells: BodyCell[] = [];
  for (let r = 1; r < spacing - 1; r++) {
    bodyCells.push({ row: r, col: 0 });
  }
  return {
    id: `def-2pin-${spacing}h`,
    name: `2-Pin (${spacing}h)`,
    category: "resistor",
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
function create3Pin(spaced: boolean): ComponentDef {
  const step = spaced ? 2 : 1;
  const height = step * 2 + 1;
  const bodyCells: BodyCell[] = [];
  if (spaced) {
    bodyCells.push({ row: 1, col: 0 });
    bodyCells.push({ row: 3, col: 0 });
  }
  return {
    id: `def-3pin-${spaced ? "spaced" : "compact"}`,
    name: `3-Pin ${spaced ? "Spaced" : "Compact"}`,
    category: "ic",
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
function createInline(pinCount: number): ComponentDef {
  return {
    id: `def-inline-${pinCount}`,
    name: `Inline ${pinCount}-Pin`,
    category: "terminal",
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
 * Left column top-to-bottom: pins 1..N/2
 * Right column bottom-to-top: pins (N/2+1)..N
 *
 * DIP-4:       DIP-6:       DIP-8:
 * 1 - - 4     1 - - 6     1 - - 8
 * 2 - - 3     2 - - 5     2 - - 7
 *              3 - - 4     3 - - 6
 *                           4 - - 5
 */
function createDIP(pinCount: number): ComponentDef {
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
    id: `def-dip${pinCount}`,
    name: `DIP-${pinCount}`,
    category: "ic",
    width: 4,
    height: pinsPerSide,
    pins,
    bodyCells,
  };
}

// ── Library ────────────────────────────────────────────

/** Category grouping for the visual library */
export interface ComponentGroup {
  label: string;
  components: ComponentDef[];
}

export const COMPONENT_GROUPS: ComponentGroup[] = [
  {
    label: "2-Pin",
    components: [
      create2Pin(2),
      create2Pin(3),
      create2Pin(4),
      create2Pin(5),
      create2Pin(7),
    ],
  },
  {
    label: "3-Pin",
    components: [
      create3Pin(false),
      create3Pin(true),
    ],
  },
  {
    label: "Inline",
    components: Array.from({ length: 7 }, (_, i) => createInline(i + 4)),
  },
  {
    label: "DIP",
    components: [4, 6, 8, 10, 12, 14, 16, 18, 20].map(createDIP),
  },
];

/** Flat array of all default components (for store initialization) */
export const DEFAULT_COMPONENTS: ComponentDef[] =
  COMPONENT_GROUPS.flatMap((g) => g.components);
