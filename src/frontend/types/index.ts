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
  // Pin-to-pin span range for flexible parts, in hole pitches, replacing what
  // the package gives. Never stored and not reachable from the UI: a hook
  // for the solver's own tools.
  spanOverride?: { min: number; max: number };
  // Clearance: whole free board lines the body keeps to any neighbour, on
  // top of its real size. Not part of a stored def: stamped on at solve time
  // from the project's partSpacing, on every part.
  clearance?: number;
  // Resistors and diodes may stand on one lead when that packs tighter. Not
  // part of a stored def: stamped on at solve time from the project's setting.
  allowStanding?: boolean;
  // The value and package of the one component this def was resolved for,
  // which decide the size of its real body. Never stored: set by
  // resolveComponentDef.
  part?: { value?: string; package?: string };
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

  // Which real package this part is drawn as (see packageBodies). Absent means
  // the default for its type. A package that moves pins also writes
  // footprintOverride, so the rest of the app needs to know nothing about this.
  package?: string;

  // Excluded from the stripboard: lives on the schematic only (e.g. off-board
  // parts connected via jumper wires). Ignored by board placement and net
  // completeness checks.
  boardExcluded?: boolean;

  // Mounted off the board (a panel pot, a switch on the case) and wired to
  // it. Unlike an excluded part it is still part of the build: every pin that
  // carries a net comes onto the board as its own solder pad, placed and
  // moved independently. boardPos stays null; the pads live in `leads`.
  offBoard?: boolean;
  // Off-board parts only: pin id -> where that pin's wire is soldered in.
  leads?: Record<string, { row: number; col: number }>;
  // Off-board parts only: pin id -> where the user dragged that pad's label.
  // The label of a grouped connector uses boardLabelOffset instead.
  leadLabelOffsets?: Record<string, { x: number; y: number }>;
  // Off-board parts only: what the part's wires arrive at. Absent means one
  // loose solder pad per pin (positions in `leads`). Anything else is one
  // connector holding all the pins in a row: "wire-row" for soldered wires
  // kept side by side, or a connector package (header, JST, screw terminal).
  // That connector sits at this component's own boardPos and rotation, which
  // an off-board part has no other use for.
  offBoardPackage?: string;

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

// ── Net labels (flags) ────────────────────────────────

// A named connection point on the schematic: a ground or power symbol, or a
// plain net label. Every label sharing a name is one net, and a net that
// carries a label takes the label's name. pos is the connection point and
// must be grid aligned. Not a component: never on the board or in the BOM.
export type NetLabelKind = "gnd" | "power" | "label";

export interface NetLabel {
  id: string;
  kind: NetLabelKind;
  name: string;
  pos: { x: number; y: number };
  rotation: 0 | 90 | 180 | 270;
}

// ── Schematic Wires ───────────────────────────────────

// A wire is one horizontal or vertical segment between two grid points.
// No component references — net inference is purely spatial: a wire connects
// only at its two endpoints, never along its body. Drawing an L places two
// wires. (Before schema version 3 a wire could be L-shaped with a derived
// bend; the backend splits those on migration.)
export interface SchematicWire {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
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

export interface Board {
  rows: number;
  cols: number;
  // A locked dimension is a hard limit for the auto-layouter: the result
  // keeps exactly this many rows/cols instead of choosing its own.
  lockedRows?: boolean;
  lockedCols?: boolean;
  cuts: Cut[];
  wires: Wire[];
}

// ── Project (top-level, serializable to JSON) ──────────

// Schema version written by exportProject. Anything older reaching the
// editor (an imported file, a stored draft) goes through the backend's
// /projects/migrate/ first; the frontend itself carries no migration logic.
export const PROJECT_SCHEMA_VERSION = 3;

export interface Project {
  version?: number; // schema version; below PROJECT_SCHEMA_VERSION means migrate in the backend first
  name: string;
  description?: string; // one-line summary, shown in project lists and on view links
  notes?: string; // freeform build notes; URLs render as links
  componentDefs: ComponentDef[];
  components: Component[];
  nets: Net[];
  netAssignments: NetAssignment[];
  schematicWires: SchematicWire[];
  netLabels?: NetLabel[]; // absent in projects saved before version 3
  // How the schematic decides what is connected. "classic": only at wire
  // ends (the rules every project drawn before version 3 was made under, so
  // nothing in an old drawing ever joins by surprise). "touch": whatever
  // touches is connected, the rule new projects start with. Absent means
  // classic; the user can switch a project to touch, which previews and
  // then applies the joins that follow.
  wiring?: "classic" | "touch";
  board: Board;
  showValuesOnBoard?: boolean;
  autoSave?: boolean; // per-project preference: continuously save on every change
  // Legacy per-type auto-layout config from before parts had real packages.
  // No longer used: the package now decides spans and body size. Read once
  // on load to carry their intent into allowStanding and partSpacing, and
  // otherwise kept as they are.
  spanOverrides?: Record<string, { min: number; max: number }>;
  clearanceOverrides?: Record<string, number>;
  // Auto-layout config: free board lines kept between all parts, on top of
  // their real size. 0 packs parts as tightly as they physically fit.
  partSpacing?: number;
  // Auto-layout config: tidy second pass that trades board area for
  // straighter wires, kept only when it actually is tidier. On by default;
  // false turns it off (halves solve time, may leave messier wires).
  tidyWires?: boolean;
  // Auto-layout config: only sever strips by drilling a hole, never by
  // cutting the copper between two holes (easier to build, may cost board
  // space). On unless explicitly false.
  drilledCutsOnly?: boolean;
  // Auto-layout config: portfolio size. The solver solves this many
  // deterministic input orderings (boards) across permWorkers parallel
  // workers and applies the best finished one. Absent means the shipped
  // default (10 boards on three quarters of the cores); 1 turns the
  // portfolio off (single solve).
  permBoards?: number;
  permWorkers?: number;
  // v5 beta: anneal moves per seed (undefined = size-scaled default)
  v5Moves?: number;
  // v5: wall-time budget per layout in seconds (undefined = 60)
  v5TimeS?: number;
  // v5: decode speed the last run measured on this machine, ms per move;
  // turns the time budget into a repeatable move count
  v5MsPerMove?: number;
  // v5: fresh random seeds on every run instead of the fixed series
  v5RandomSeeds?: boolean;
  // Auto-layout engine: "v5" (annealed, default when absent) or "v2"
  // (strip-first)
  layoutEngine?: "v2" | "v5";
  // v5: never run wires on top of each other in one channel (thick or bare
  // wire builds). On unless explicitly false.
  noWireStacking?: boolean;
  // v5: let a resistor or diode stand on one lead where that packs tighter
  // than lying flat. Off unless true; false is stored so that the legacy
  // span settings are not read into it again.
  allowStanding?: boolean;
  // Legacy portfolio config (seconds of solve time); read once on load and
  // mapped onto permBoards, never written back.
  permTimeBudget?: number;
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
  // which layouter version produced it, the portfolio settings it ran under
  // (layouts requested and actually solved; 1 = single solve), whether the
  // drilled-cuts-only option was on, and how many of the board edits since
  // then placed a previously unplaced part — additions to a growing
  // circuit, as opposed to corrections of what the solver built.
  autoLayoutRuns?: number;
  autoLayoutLastAt?: string;
  autoLayoutLastQuality?: number;
  autoLayoutVersion?: string;
  autoLayoutLastBoards?: number;
  autoLayoutLastOrderings?: number;
  autoLayoutLastDrilled?: boolean;
  boardAddsSinceAutoLayout?: number;
}
