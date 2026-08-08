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
  hasValue?: boolean; // shows an editable value field (e.g. resistance) — passives/discretes only
  // Pin-to-pin span range for flexible parts, in hole pitches. Not part of a
  // stored def: stamped on at solve time from the project's spanOverrides.
  spanOverride?: { min: number; max: number };
  // Clearance halo around the body in hole pitches (absent = 0.5 default;
  // 0 allows adjacent placement). Not part of a stored def: stamped on at
  // solve time from the project's clearanceOverrides.
  clearance?: number;
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
  value?: string;  // freeform value, e.g. "10k", "100nF", "1N4148"

  // Position on the schematic canvas (always set)
  schematicPos: { x: number; y: number };
  schematicRotation: 0 | 90 | 180 | 270;
  schematicMirrored?: boolean; // horizontal mirror (flip X axis)
  labelOffset?: { x: number; y: number }; // draggable label position offset
  pinLabelOffsets?: Record<string, { x: number; y: number }>; // per-pin label position offsets

  // Position on the stripboard (null until placed)
  boardPos: { row: number; col: number } | null;
  rotation: 0 | 90 | 180 | 270;
  boardLabelOffset?: { x: number; y: number }; // draggable label offset on stripboard

  // For flexible 2-pin components: absolute position of pin 2 (pin 1 is at boardPos)
  flexibleEndPos?: { row: number; col: number };

  // Per-instance footprint override; when set, takes priority over the ComponentDef
  footprintOverride?: FootprintOverride;

  // Excluded from the stripboard: lives on the schematic only (e.g. off-board
  // parts connected via jumper wires). Ignored by board placement and net
  // completeness checks.
  boardExcluded?: boolean;

  // Locked on the board: auto-layout never moves this component.
  locked?: boolean;
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

// A break in the copper strip on the given row.
// kind "between" (default/absent): severs between hole col and col+1.
// kind "hole": drilled-out hole at col, isolating it from both neighbours.
export interface Cut {
  row: number;
  col: number;
  kind?: "between" | "hole";
}

export interface Wire {
  id: string;
  from: BoardPosition;
  to: BoardPosition;
}

// How the copper is laid out on the physical board. The map is a picture
// of it — see boardMap.ts for the syntax — and it is the whole truth: it
// carries the board's size along with its copper, so there is one model
// here rather than a size plus a set of rules about it.
export interface BoardLayout {
  map: string;
}

export interface Board {
  rows: number;
  cols: number;
  // A locked dimension is a hard limit for the auto-layouter: the result
  // keeps exactly this many rows/cols instead of choosing its own.
  lockedRows?: boolean;
  lockedCols?: boolean;
  cuts: Cut[];
  wires: Wire[];
  // Copper of the physical board. Absent = plain veroboard, every row one
  // strip running the full width.
  layout?: BoardLayout;
}

// ── Project (top-level, serializable to JSON) ──────────

export interface Project {
  version?: number; // schema version; absent or <CURRENT triggers migration on load
  name: string;
  componentDefs: ComponentDef[];
  components: Component[];
  nets: Net[];
  netAssignments: NetAssignment[];
  schematicWires: SchematicWire[];
  board: Board;
  showValuesOnBoard?: boolean;
  autoSave?: boolean; // per-project preference: continuously save on every change
  // Auto-layout config: per component type (def id), the allowed pin-to-pin
  // span range for flexible parts, replacing the built-in default.
  spanOverrides?: Record<string, { min: number; max: number }>;
  // Auto-layout config: per component type (def id), the body clearance
  // halo in hole pitches, replacing the 0.5 default (flexible parts only;
  // 0 allows adjacent placement).
  clearanceOverrides?: Record<string, number>;
  // Auto-layout config: tidy second pass that trades board area for
  // straighter wires, kept only when it actually is tidier. On by default;
  // false turns it off (halves solve time, may leave messier wires).
  tidyWires?: boolean;
  // Auto-layout config: permutation search budget. The solver tries as many
  // deterministic input orderings as fit the time budget (seconds) across
  // this many parallel workers, and applies the best finished board. Absent
  // means the shipped default (5 s on half the cores); an explicit 0 turns
  // the portfolio off (single solve).
  permTimeBudget?: number;
  permWorkers?: number;
  // Layout provenance, for telling human layouts from solver output when
  // benchmarking: whether the auto-layouter was ever applied to this project
  // (sticky, survives undo), and how many structural board edits (one per
  // undo step) happened after the last completed run. 0 with the flag set
  // means the board is untouched solver output.
  autoLayoutUsed?: boolean;
  boardEditsSinceAutoLayout?: number;
  // Usage metrics for evaluating solver adoption and perceived result
  // quality: how many runs were applied in total (sticky, like
  // autoLayoutUsed), when the last one was applied, its quality (0 = clean),
  // the portfolio settings it ran under (budget seconds, orderings
  // completed; 0/1 = single solve), and how many of the board edits since
  // then placed a previously unplaced part — additions to a growing
  // circuit, as opposed to corrections of what the solver built.
  autoLayoutRuns?: number;
  autoLayoutLastAt?: string;
  autoLayoutLastQuality?: number;
  autoLayoutLastBudget?: number;
  autoLayoutLastOrderings?: number;
  boardAddsSinceAutoLayout?: number;
}
