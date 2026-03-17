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
  category: "resistor" | "capacitor" | "led" | "terminal" | "ic" | "custom";
  width: number;  // columns spanned
  height: number; // rows spanned
  pins: PinDef[];
  bodyCells?: BodyCell[]; // cells occupied by body but not pins; inferred as bounding rect if absent
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
  tag: string;     // descriptive label, e.g. "Resistor", "Output Connector"

  // Position on the schematic canvas (always set)
  schematicPos: { x: number; y: number };

  // Position on the stripboard (null until placed)
  boardPos: { row: number; col: number } | null;
  rotation: 0 | 90 | 180 | 270;

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
  board: Board;
  customTags: string[];
}
