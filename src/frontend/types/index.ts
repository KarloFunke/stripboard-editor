// ── Component Definitions (templates) ──────────────────

export interface PinDef {
  id: string;
  name: string;
  offsetRow: number; // relative to component origin (top-left)
  offsetCol: number;
}

// A cell the component body occupies (not a pin)
export interface BodyCell {
  row: number;
  col: number;
}

export interface ComponentDef {
  id: string;
  name: string;
  category: "passive" | "semiconductor" | "ic" | "connector" | "generic";
  symbol: string; // references SymbolDef.symbolId for schematic rendering
  defaultLabelPrefix: string; // e.g. "R", "C", "D", "Q", "U", "J", "X"
  width: number;  // columns spanned (stripboard footprint)
  height: number; // rows spanned (stripboard footprint)
  pins: PinDef[];
  bodyCells?: BodyCell[]; // cells occupied by body but not pins; inferred as bounding rect if absent
  footprintPresets?: string[]; // alternative footprint def IDs the user can choose from
  flexible?: boolean; // 2-pin components with draggable pin positions
}

// ── Component Instance (single object for both editors) ──

// Per-instance footprint override (when user customizes a specific component)
export interface FootprintOverride {
  width: number;
  height: number;
  pins: PinDef[];
  bodyCells?: BodyCell[];
}

export interface Component {
  id: string;
  defId: string;   // references ComponentDef.id
  label: string;   // short identifier, e.g. "R1", "U1"

  // Position on the schematic canvas (always set)
  schematicPos: { x: number; y: number };
  schematicRotation: 0 | 90 | 180 | 270;
  schematicMirrored?: boolean; // horizontal mirror (flip X axis)

  // Position on the stripboard (null until placed)
  boardPos: { row: number; col: number } | null;
  rotation: 0 | 90 | 180 | 270;

  // For flexible 2-pin components: absolute position of pin 2 (pin 1 is at boardPos)
  flexibleEndPos?: { row: number; col: number };

  // Per-instance footprint override; when set, takes priority over the ComponentDef
  footprintOverride?: FootprintOverride;
}

// ── Nets ───────────────────────────────────────────────

export interface Net {
  id: string;
  name: string;
  color: string; // hex color for visualization
}

export interface NetAssignment {
  netId: string;
  componentId: string; // references Component.id
  pinId: string;       // references PinDef.id within the ComponentDef
}

// ── Schematic Wires ───────────────────────────────────

// A wire connects two grid-aligned points with an auto-routed L-shape.
// No component references — net inference is purely spatial.
// The bend point is derived from start/end, not stored.
export interface SchematicWire {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  routeDirection: "horizontal-first" | "vertical-first";
}

// ── Board ──────────────────────────────────────────────

export interface BoardPosition {
  row: number;
  col: number;
}

export interface Jumper {
  from: BoardPosition;
  to: BoardPosition;
  netId: string;
}

// A cut between two adjacent holes on the same row.
// col means "between col and col+1" on the given row.
export interface Cut {
  row: number;
  col: number;
}

export interface Wire {
  id: string;
  from: BoardPosition;
  to: BoardPosition;
}

export interface Board {
  rows: number;
  cols: number;
  cuts: Cut[];
  jumpers: Jumper[];
  wires: Wire[];
}

// ── Project (top-level, serializable to JSON) ──────────

export interface Project {
  name: string;
  componentDefs: ComponentDef[];
  components: Component[];
  nets: Net[];
  netAssignments: NetAssignment[];
  schematicWires: SchematicWire[];
  board: Board;
}
