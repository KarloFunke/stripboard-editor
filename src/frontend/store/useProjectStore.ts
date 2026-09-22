import { create } from "zustand";
import {
  Project,
  Component,
  FootprintOverride,
  Net,
  NetAssignment,
  BoardPosition,
  Cut,
  ComponentDef,
  Wire,
  SchematicWire,
  NetLabel,
  NetLabelKind,
  PROJECT_SCHEMA_VERSION,
} from "@/types";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { spanLimits } from "@/components/stripboard/flexGeometry";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { GROUP_PIN, boardView, editBoardView, isLead, parseLeadId } from "@/components/stripboard/offBoard";
import { getComponentBounds, getComponentPinPositions } from "@/components/stripboard/boardLayout";
import { bodyCuts, missingBodyCuts, sameCut } from "@/components/stripboard/bodyCuts";
import { collectBoardPins } from "@/components/stripboard/boardPins";
import { computeStripSegments } from "@/components/stripboard/stripSegments";
import { computeConnectivity } from "@/components/stripboard/connectivity";
import { diffNets, netDiffIsEmpty, type NetDiff } from "@/components/schematic/netInference";
import { recalculateNets } from "@/components/schematic/netInference";
import {
  anchorPoints,
  attachWireEnds,
  axisLockFor,
  mergeWires,
  moveGeometry,
  movingAndStaticKeys,
  normalizeWires,
  transformSelection,
} from "@/components/schematic/schematicGeometry";
import { pointKey, snapToGrid } from "@/utils/schematicConstants";
import { footprintChanged, newCustomId, registerPartSymbol, withPartId } from "@/data/customParts";
import { computeAutoFinish, AutoFinishResult } from "@/components/stripboard/autoFinish";
import { footprintFor } from "@/components/stripboard/packageBodies";
import { AutoLayoutResult, LAYOUT_VERSION } from "@/components/stripboard/layoutTypes";

function generateId(): string {
  return crypto.randomUUID();
}

// Board actions edit the components as the board sees them, so a solder pad of
// an off-board part moves, locks and unplaces like any other part.
function onBoard(
  s: Pick<ProjectStore, "components" | "componentDefs" | "netAssignments">,
  edit: (view: Component[]) => Component[],
): Component[] {
  return editBoardView(s.components, s.componentDefs, s.netAssignments, edit);
}

type BoardState = Pick<ProjectStore, "board" | "components" | "componentDefs" | "netAssignments" | "drilledCutsOnly">;

// The board's cuts without the ones under these parts' bodies, which leave the
// board with them. An id is a part's own or, for its solder pads, its parent's.
function cutsWithoutParts(s: BoardState, ids: string[]): Cut[] {
  const owned: Cut[] = [];
  for (const c of boardView(s.components, s.componentDefs, s.netAssignments).components) {
    if (!ids.includes(c.id) && !(isLead(c) && ids.includes(c.leadOf.componentId))) continue;
    const def = resolveComponentDef(c, s.componentDefs);
    if (def) owned.push(...bodyCuts(s.board.cuts, c, def));
  }
  return owned.length === 0 ? s.board.cuts : s.board.cuts.filter((cut) => !owned.some((o) => sameCut(o, cut)));
}

// `cuts` plus the ones a part needs under its body where it now sits.
function cutsWithPart(s: BoardState, cuts: Cut[], comp: Component): Cut[] {
  const def = resolveComponentDef(comp, s.componentDefs);
  if (!def || def.flexible) return cuts;
  const view = boardView(s.components, s.componentDefs, s.netAssignments);
  const taken = new Set<string>();
  const others = view.components.filter((c) => c.id !== comp.id);
  for (const pin of collectBoardPins(s.board, others, s.componentDefs, view.netAssignments)) {
    taken.add(`${pin.row},${pin.col}`);
  }
  for (const w of s.board.wires) {
    taken.add(`${w.from.row},${w.from.col}`);
    taken.add(`${w.to.row},${w.to.col}`);
  }
  const missing = missingBodyCuts(
    cuts, comp, def,
    (pinId) => view.netAssignments.find((a) => a.componentId === comp.id && a.pinId === pinId)?.netId,
    s.drilledCutsOnly !== false,
    (row, col) => taken.has(`${row},${col}`)
  );
  return missing.length === 0 ? cuts : [...cuts, ...missing];
}

// Projects from before parts had packages carried per-type span and clearance
// tables. What people used them for is kept: a resistor or diode allowed
// shorter than it lies flat meant "may stand", and a clearance of two lines or
// more (or the older fractional halo above the default) meant "give me room".
function legacyAllowStanding(data: Project): boolean | undefined {
  const spans = data.spanOverrides;
  if (!spans) return undefined;
  const stood = ["def-resistor", "def-diode", "def-zener"].some((id) => {
    const def = DEFAULT_COMPONENTS.find((d) => d.id === id);
    return def && spans[id] && spans[id].min < spanLimits(def).min;
  });
  return stood || undefined;
}

function legacyPartSpacing(data: Project): number | undefined {
  const lines = Object.values(data.clearanceOverrides ?? {}).map((v) => (Number.isInteger(v) ? v : Math.round(v * 2)));
  return lines.some((v) => v >= 2) ? 1 : undefined;
}

function nextLabel(components: Component[], prefix: string): string {
  const existing = components
    .filter((c) => c.label.startsWith(prefix))
    .map((c) => {
      const num = parseInt(c.label.slice(prefix.length), 10);
      return isNaN(num) ? 0 : num;
    });
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${prefix}${next}`;
}

interface ProjectActions {
  // Component definitions
  addComponentDef: (def: ComponentDef) => void;
  removeComponentDef: (defId: string) => void;
  updateComponentDef: (
    defId: string,
    updates: Partial<Pick<ComponentDef, "width" | "height" | "pins" | "bodyCells">>
  ) => void;
  // A new version of one custom part in this project
  replaceComponentDef: (def: ComponentDef) => void;
  // Places a library part, copying it into the project unless a linked copy is already here
  addLibraryComponent: (libDef: ComponentDef, schematicPos: { x: number; y: number }) => void;
  // Carries a saved library part into this project's linked copies
  applyLibraryUpdate: (libDef: ComponentDef) => void;

  // Components
  addComponent: (defId: string, schematicPos: { x: number; y: number }) => void;
  // Add a fully specified instance (used by copy/paste); returns the new id.
  addComponentInstance: (init: {
    defId: string;
    value?: string;
    schematicRotation?: 0 | 90 | 180 | 270;
    schematicMirrored?: boolean;
    labelOffset?: { x: number; y: number };
    pinLabelOffsets?: Record<string, { x: number; y: number }>;
    footprintOverride?: FootprintOverride;
    package?: string;
    schematicPos: { x: number; y: number };
  }) => string;
  removeComponent: (id: string) => void;
  updateLabelOffset: (id: string, offset: { x: number; y: number }) => void;
  updatePinLabelOffset: (id: string, pinId: string, offset: { x: number; y: number }) => void;
  updateBoardLabelOffset: (id: string, offset: { x: number; y: number }) => void;
  updateLabel: (id: string, label: string) => void;
  updateComponentValue: (id: string, value: string) => void;
  setShowValuesOnBoard: (show: boolean) => void;
  setAutoSave: (autoSave: boolean) => void;
  updatePinName: (componentId: string, pinId: string, newName: string) => void;
  updateComponentFootprint: (componentId: string, override: FootprintOverride) => void;
  // Choose the package a part is drawn as. `scope` "type" applies it to every
  // part sharing the definition. A package that moves pins rewrites the
  // footprint too, and unplaces anything that no longer fits.
  setComponentPackage: (componentId: string, packageId: string, scope: "one" | "type") => void;
  rotateSchematicComponent: (id: string) => void;
  mirrorSchematicComponent: (id: string) => void;
  // A move gesture: beginSchematicMove fixes what moves and the geometry it
  // starts from; every moveSchematicItems step re-derives the wires from
  // that start with the accumulated delta; finishSchematicGesture settles
  // connectivity when the gesture is over, cancelSchematicGesture forgets a
  // gesture that never moved.
  beginSchematicMove: (compIds: string[], wireIds: string[], labelIds: string[]) => void;
  moveSchematicItems: (delta: { x: number; y: number }) => void;
  finishSchematicGesture: () => void;
  cancelSchematicGesture: () => void;
  // Rotate or mirror a selection around its centre (one undo step)
  transformSchematicSelection: (compIds: string[], wireIds: string[], labelIds: string[], op: "rotate" | "mirror", center?: { x: number; y: number }) => void;
  // Insert copied items with fresh ids (one undo step); returns the new ids
  pasteSchematicItems: (items: {
    components: Omit<Component, "id" | "label" | "boardPos" | "rotation" | "flexibleEndPos" | "locked">[];
    wires: Omit<SchematicWire, "id">[];
    labels: Omit<NetLabel, "id">[];
  }) => { componentIds: string[]; wireIds: string[]; labelIds: string[] };
  placeOnBoard: (id: string, pos: { row: number; col: number }) => void;
  moveComponentsOnBoard: (ids: string[], deltaRow: number, deltaCol: number, wireIds?: string[], cutPositions?: Cut[]) => void;
  removeFromBoard: (id: string) => void;
  setBoardExcluded: (id: string, excluded: boolean) => void;
  setOffBoard: (id: string, offBoard: boolean) => void;
  setOffBoardPackage: (id: string, connection: string, scope: "one" | "all") => void;
  toggleBoardLock: (id: string) => void;
  setBoardLock: (ids: string[], locked: boolean) => void;
  setFlexibleEndPos: (id: string, pos: { row: number; col: number }) => void;
  rotateComponent: (id: string) => void;
  autoAlignPolarity: (ids: string[]) => void;

  // Schematic wires. An L between the points places two wires (the order
  // follows schematicWireDirection); returns the ids placed, first leg first.
  addSchematicWire: (start: { x: number; y: number }, end: { x: number; y: number }) => string[];
  removeSchematicWire: (id: string) => void;

  // Schematic net labels (ground / power flags and plain net labels)
  addNetLabel: (kind: NetLabelKind, pos: { x: number; y: number }, name?: string, rotation?: NetLabel["rotation"]) => string;
  updateNetLabel: (id: string, updates: Partial<Pick<NetLabel, "name" | "rotation" | "kind">>) => void;
  removeNetLabels: (ids: string[]) => void;

  // Nets (kept for rename/recolor, but auto-managed by wire system)
  updateNet: (id: string, updates: Partial<Pick<Net, "name" | "color">>) => void;
  // Rename a net; labels carrying the old name follow, so the name sticks
  renameNet: (id: string, name: string) => void;

  // Wiring rule set. Switching a classic project to touch wiring applies
  // every contact at once (one undo step); the preview says what changes.
  previewWiringSwitch: () => NetDiff;
  switchWiringToTouch: () => void;
  removeNet: (id: string) => void;

  // Board
  placeCut: (cut: Cut) => void;
  removeCut: (cut: Cut) => void;
  // Board wires
  setBoardSize: (rows: number, cols: number) => void;
  setBoardDimLock: (dim: "rows" | "cols", locked: boolean) => void;
  // Free board lines kept between all parts in auto-layout (0 or 1)
  setPartSpacing: (lines: number) => void;
  // Toggle the tidy-wires second pass (on by default)
  setTidyWires: (value: boolean) => void;
  // Toggle drilled-cuts-only mode (off by default)
  setDrilledCutsOnly: (value: boolean) => void;
  setPermBoards: (n: number) => void;
  setPermWorkers: (n: number) => void;
  // v5 beta anneal budget per seed (0 = back to the size-scaled default)
  setV5Moves: (n: number) => void;
  setV5TimeS: (n: number) => void;
  setV5MsPerMove: (n: number) => void;
  setV5RandomSeeds: (value: boolean) => void;
  setLayoutEngine: (engine: "v2" | "v5") => void;
  setNoWireStacking: (value: boolean) => void;
  setAllowStanding: (value: boolean) => void;
  // Insert a blank row/column at `at` (0-based): everything at or beyond it
  // shifts by one line. A rigid part whose footprint straddles the line
  // cannot be split and stays put — may break its nets; a manual-cleanup
  // tool, the user fixes fallout.
  insertBoardLine: (axis: "row" | "col", at: number) => void;
  deleteBoardLine: (axis: "row" | "col", at: number) => void;
  addWire: (from: BoardPosition, to: BoardPosition) => void;
  setWireEnds: (wireId: string, from: BoardPosition, to: BoardPosition) => void;
  removeWire: (wireId: string) => void;
  // Derive and apply the cuts/wires needed to complete the current placement
  autoFinishBoard: () => AutoFinishResult;
  // Apply an auto-layout result computed in the worker (placements + regenerated cuts/wires)
  applyAutoLayout: (result: AutoLayoutResult, meta?: { boards: number; orderings: number; drilled: boolean }) => void;

  // UI state

  cancelWirePlacement: () => void;
  setWirePlacementFrom: (pos: BoardPosition) => void;
  setTrayDragComponentId: (id: string | null) => void;
  setHighlightedNetId: (id: string | null) => void;
  setActiveEditor: (editor: "schematic" | "stripboard") => void;
  toggleSchematicWireDrawMode: () => void;
  setSchematicWireDrawing: (from: { x: number; y: number } | null) => void;

  // Project persistence
  setProjectName: (name: string) => void;
  setProjectDescription: (description: string) => void;
  setProjectNotes: (notes: string) => void;
  exportProject: () => Project;
  loadProject: (data: Project) => void;
  importProject: (data: Project) => void;
  resetProject: () => void;

  // Undo/redo
  pushSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export type BoardTool = "select" | "wire" | "cut";

interface UIState {

  wirePlacementFrom: BoardPosition | null;
  trayDragComponentId: string | null;
  highlightedNetId: string | null;
  // What a click on the board means: "wire" starts and ends link wires,
  // "cut" places and removes cuts, "select" touches neither. Not saved: it is
  // a working mode, not a property of the project.
  boardTool: BoardTool;
  setBoardTool: (tool: BoardTool) => void;
  // Outline parts whose real bodies collide. A display choice, not saved.
  showOverlaps: boolean;
  setShowOverlaps: (value: boolean) => void;
  schematicWireDrawMode: boolean;
  schematicWireDrawingFrom: { x: number; y: number } | null;
  schematicWireDirection: "horizontal-first" | "vertical-first" | null; // locked on first significant mouse move
  // The move gesture in progress: what moves, the geometry it started from,
  // the delta so far, and the body contacts that existed before (never made
  // by it)
  _gesture: {
    compIds: string[];
    labelIds: string[];
    wireIds: string[];
    base: { components: Component[]; netLabels: NetLabel[]; schematicWires: SchematicWire[] };
    total: { x: number; y: number };
    axisLock: "h" | "v" | null;
    nonce: string;
  } | null;
  // Which editor pane last received interaction — keyboard shortcuts target it
  // so the schematic and stripboard canvases don't both react to one keypress.
  activeEditor: "schematic" | "stripboard";
  // The last settle that folded nets together, for a passing notice
  netMergeNotice: { merges: { into: string; joined: string[] }[]; at: number } | null;
}

interface HistoryState {
  _history: Project[];
  _redoStack: Project[];
  // While true, nested pushSnapshot() calls are skipped so a multi-mutation
  // operation (e.g. bulk delete) produces a single undo entry.
  _suppressSnapshot: boolean;
  _editSeq: number;
  // The _editSeq that last counted toward boardEditsSinceAutoLayout — caps
  // the provenance counter at one bump per undo step (drag gestures and
  // transact() batches push a single snapshot).
  _lastBoardEditSeq: number;
  isDirty: boolean;
  markClean: () => void;
  /** Saves the open project to the server, when the page can (a project already stored there). */
  saveNow: (() => Promise<boolean>) | null;
  setSaveNow: (save: (() => Promise<boolean>) | null) => void;
  /** Run fn as one undoable step: one snapshot up front, none in between. */
  transact: (fn: () => void) => void;
}

type ProjectStore = Omit<Project, "netLabels"> & { netLabels: NetLabel[] } & UIState & ProjectActions & HistoryState;

const initialProject: Project = {
  name: "Untitled Project",
  description: "",
  notes: "",
  componentDefs: [...DEFAULT_COMPONENTS],
  components: [],
  nets: [],
  netAssignments: [],
  schematicWires: [],
  netLabels: [],
  wiring: "touch",
  board: {
    rows: 20,
    cols: 20,
    cuts: [],
    wires: [],
  },
  showValuesOnBoard: false,
  autoSave: false,
};

const MAX_HISTORY = 80;

function snapshotProject(s: Project): Project {
  return JSON.parse(JSON.stringify({
    name: s.name,
    componentDefs: s.componentDefs,
    components: s.components,
    nets: s.nets,
    netAssignments: s.netAssignments,
    schematicWires: s.schematicWires,
    netLabels: s.netLabels,
    wiring: s.wiring,
    board: s.board,
  }));
}

function restoreProject(snapshot: Project): Partial<ProjectStore> {
  // A grid part's drawing is registered under its id, so an undone edit needs the old one back
  snapshot.componentDefs.forEach(registerPartSymbol);
  return {
    name: snapshot.name,
    componentDefs: snapshot.componentDefs,
    components: snapshot.components,
    nets: snapshot.nets,
    netAssignments: snapshot.netAssignments,
    schematicWires: snapshot.schematicWires,
    netLabels: snapshot.netLabels ?? [],
    wiring: snapshot.wiring,
    board: snapshot.board,
  };
}

/**
 * Puts new versions of custom parts in place. A placed part whose footprint
 * changed goes back to the unplaced list, as after a package change that no
 * longer fits, and net assignments drop pins the part no longer has.
 */
function replaceDefs(
  s: Pick<ProjectStore, "componentDefs" | "components" | "netAssignments">,
  next: ComponentDef[],
): Pick<ProjectStore, "componentDefs" | "components" | "netAssignments"> {
  const byId = new Map(next.map((d) => [d.id, d]));
  const moved = new Set(s.componentDefs.filter((d) => byId.has(d.id) && footprintChanged(d, byId.get(d.id)!)).map((d) => d.id));
  next.forEach(registerPartSymbol);
  const components = s.components.map((c) =>
    moved.has(c.defId) && c.boardPos
      ? { ...c, boardPos: null, flexibleEndPos: undefined, footprintOverride: undefined, package: undefined }
      : c,
  );
  const pinIds = new Map(next.map((d) => [d.id, new Set(d.pins.map((p) => p.id))]));
  const defOf = new Map(s.components.map((c) => [c.id, c.defId]));
  const netAssignments = s.netAssignments.filter((a) => {
    const ids = pinIds.get(defOf.get(a.componentId) ?? "");
    return !ids || ids.has(a.pinId);
  });
  return { componentDefs: s.componentDefs.map((d) => byId.get(d.id) ?? d), components, netAssignments };
}

/**
 * Settle schematic connectivity after any geometry change: under touch
 * wiring make every contact an endpoint (what touches is connected), under
 * classic wiring only clean up; then recompute the nets.
 */
function settleSchematic(
  s: Pick<ProjectStore, "schematicWires" | "components" | "componentDefs" | "netLabels" | "nets" | "netAssignments" | "schematicWireDrawingFrom" | "wiring">,
) {
  const anchors = anchorPoints(s.components, s.componentDefs, s.netLabels);
  const split = normalizeWires(s.schematicWires, anchors, generateId, s.wiring === "touch");
  // Joining segments back together would swallow the run being drawn (and with
  // it Backspace's step-back), so it waits until the wire is finished.
  const wires = s.schematicWireDrawingFrom ? split : mergeWires(split, anchors);
  const r = recalculateNets(wires, s.nets, s.netAssignments, s.components, s.componentDefs, s.netLabels);
  return { schematicWires: wires, nets: r.nets, netAssignments: r.netAssignments, netMergeNotice: mergeNotice(s, r) };
}

/**
 * Nets that just got absorbed into another net (all their pins now share
 * one other net), grouped by where they went. Shown to the user, so a join
 * is never silent. (The wiring-switch preview uses diffNets(), which also
 * reports pins joining a net and nets forming; during ordinary editing a
 * merge is the surprising part, the rest is the rule doing its job.)
 */
function netMerges(
  before: Pick<ProjectStore, "nets" | "netAssignments">,
  after: { nets: Net[]; netAssignments: NetAssignment[] },
): { into: string; joined: string[] }[] {
  const afterById = new Map(after.nets.map((n) => [n.id, n]));
  const pinToAfter = new Map(after.netAssignments.map((a) => [`${a.componentId}:${a.pinId}`, a.netId]));
  const byTarget = new Map<string, string[]>();
  for (const net of before.nets) {
    if (afterById.has(net.id)) continue;
    const pins = before.netAssignments.filter((a) => a.netId === net.id);
    if (pins.length < 2) continue;
    const targets = new Set(pins.map((a) => pinToAfter.get(`${a.componentId}:${a.pinId}`)).filter((x): x is string => !!x));
    if (targets.size !== 1) continue;
    const into = afterById.get([...targets][0])?.name;
    if (!into) continue;
    const arr = byTarget.get(into);
    if (arr) arr.push(net.name);
    else byTarget.set(into, [net.name]);
  }
  return [...byTarget.entries()].map(([into, joined]) => ({ into, joined }));
}

function mergeNotice(
  before: Pick<ProjectStore, "nets" | "netAssignments">,
  after: { nets: Net[]; netAssignments: NetAssignment[] },
): { merges: { into: string; joined: string[] }[]; at: number } | null {
  const merges = netMerges(before, after);
  return merges.length > 0 ? { merges, at: Date.now() } : null;
}

// One structural board edit for the layout-provenance counter. Guarded by
// _editSeq so per-pixel drag updates and batched mutations count once per
// undo step; undo/redo advance _editSeq, so edits after them count fresh.
function bumpBoardEdits(s: Pick<ProjectStore, "boardEditsSinceAutoLayout" | "_editSeq" | "_lastBoardEditSeq">) {
  if (s._lastBoardEditSeq === s._editSeq) return {};
  return { boardEditsSinceAutoLayout: (s.boardEditsSinceAutoLayout ?? 0) + 1, _lastBoardEditSeq: s._editSeq };
}

function prepareProjectState(data: Project) {
  const savedDefs = data.componentDefs ?? [];
  const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
  const customDefs = savedDefs.filter((d) => !defaultIds.has(d.id));
  const mergedDefs = [...DEFAULT_COMPONENTS, ...customDefs];

  customDefs.forEach(registerPartSymbol);

  const components = (data.components ?? []).map((c) => ({
    ...c,
    schematicRotation: c.schematicRotation ?? 0,
  }));
  const netLabels = data.netLabels ?? [];
  const schematicWires = data.schematicWires ?? [];
  // Everything drawn before touch wiring existed stays on classic wiring
  const wiring = data.wiring ?? "classic";
  // Nets are derived state; refreshing them on load picks up assignments an
  // older editor left stale after a move.
  const netResult = recalculateNets(schematicWires, data.nets ?? [], data.netAssignments ?? [], components, mergedDefs, netLabels);

  return {
    name: data.name ?? "Untitled Project",
    description: data.description ?? "",
    notes: data.notes ?? "",
    componentDefs: mergedDefs,
    components,
    nets: netResult.nets,
    netAssignments: netResult.netAssignments,
    schematicWires,
    netLabels,
    wiring,
    board: {
      rows: data.board?.rows ?? 20,
      cols: data.board?.cols ?? 20,
      cuts: data.board?.cuts ?? [],
      wires: data.board?.wires ?? [],
      lockedRows: data.board?.lockedRows,
      lockedCols: data.board?.lockedCols,
    },
    showValuesOnBoard: data.showValuesOnBoard ?? false,
    autoSave: data.autoSave ?? false,
    spanOverrides: data.spanOverrides,
    clearanceOverrides: data.clearanceOverrides,
    partSpacing: data.partSpacing ?? legacyPartSpacing(data),
    tidyWires: data.tidyWires,
    drilledCutsOnly: data.drilledCutsOnly,
    // Legacy time budgets map onto the board count once: an explicit 0 was
    // "portfolio off" and stays off (1 board); any other stored time falls
    // to the shipped default count.
    permBoards: data.permBoards ?? (data.permTimeBudget === 0 ? 1 : undefined),
    permWorkers: data.permWorkers,
    v5Moves: data.v5Moves,
    v5TimeS: data.v5TimeS,
    v5MsPerMove: data.v5MsPerMove,
    v5RandomSeeds: data.v5RandomSeeds,
    layoutEngine: data.layoutEngine,
    noWireStacking: data.noWireStacking,
    allowStanding: data.allowStanding ?? legacyAllowStanding(data),
    autoLayoutUsed: data.autoLayoutUsed,
    boardEditsSinceAutoLayout: data.boardEditsSinceAutoLayout,
    autoLayoutRuns: data.autoLayoutRuns,
    autoLayoutLastAt: data.autoLayoutLastAt,
    autoLayoutLastQuality: data.autoLayoutLastQuality,
    autoLayoutVersion: data.autoLayoutVersion,
    autoLayoutLastBoards: data.autoLayoutLastBoards,
    autoLayoutLastDrilled: data.autoLayoutLastDrilled,
    autoLayoutLastOrderings: data.autoLayoutLastOrderings,
    boardAddsSinceAutoLayout: data.boardAddsSinceAutoLayout,
    _lastBoardEditSeq: -1,
    wirePlacementFrom: null,
    schematicWireDrawMode: false,
    schematicWireDrawingFrom: null,
    schematicWireDirection: null,
  };
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  ...initialProject,
  netLabels: [],

  wirePlacementFrom: null,
  trayDragComponentId: null,
  highlightedNetId: null,
  boardTool: "select",
  showOverlaps: true,
  schematicWireDrawMode: false,
  schematicWireDrawingFrom: null,
  schematicWireDirection: null,
  activeEditor: "schematic",
  _gesture: null,
  netMergeNotice: null,
  _history: [],
  _redoStack: [],
  _suppressSnapshot: false,
  _editSeq: 0,
  _lastBoardEditSeq: -1,
  canUndo: false,
  canRedo: false,
  isDirty: false,
  markClean: () => set({ isDirty: false }),
  saveNow: null,
  setSaveNow: (saveNow) => set({ saveNow }),

  addComponentDef: (def) => {
    get().pushSnapshot();
    registerPartSymbol(def);
    set((s) => ({ componentDefs: [...s.componentDefs, def] }));
  },

  replaceComponentDef: (def) => {
    get().pushSnapshot();
    set((s) => replaceDefs(s, [def]));
    set(settleSchematic(get()));
  },

  applyLibraryUpdate: (libDef) => {
    const copies = get().componentDefs.filter((d) => d.library && d.library.id === libDef.library?.id);
    if (copies.length === 0) return;
    get().pushSnapshot();
    set((s) => replaceDefs(s, copies.map((c) => withPartId(libDef, c.id))));
    set(settleSchematic(get()));
  },

  addLibraryComponent: (libDef, schematicPos) => {
    get().pushSnapshot();
    let def = get().componentDefs.find((d) => d.library && d.library.id === libDef.library?.id);
    if (!def) {
      def = withPartId(libDef, newCustomId());
      registerPartSymbol(def);
      const added = def;
      set((s) => ({ componentDefs: [...s.componentDefs, added] }));
    }
    const defId = def.id;
    const prefix = def.defaultLabelPrefix;
    set((s) => ({
      components: [
        ...s.components,
        {
          id: generateId(),
          defId,
          label: nextLabel(s.components, prefix),
          schematicPos,
          schematicRotation: 0,
          boardPos: null,
          rotation: 0,
        },
      ],
    }));
    set(settleSchematic(get()));
  },

  removeComponentDef: (defId) => {
    get().pushSnapshot();
    set((s) => ({
      componentDefs: s.componentDefs.filter((d) => d.id !== defId),
      // Remove all instances of this component; nets follow from what is left
      components: s.components.filter((c) => c.defId !== defId),
    }));
    set(settleSchematic(get()));
  },

  updateComponentDef: (defId, updates) => {
    get().pushSnapshot();
    set((s) => {
      const newDefs = s.componentDefs.map((d) =>
        d.id === defId ? { ...d, ...updates } : d
      );
      let newAssignments = s.netAssignments;
      if (updates.pins) {
        const newPinIds = new Set(updates.pins.map((p) => p.id));
        const affectedComponentIds = s.components
          .filter((c) => c.defId === defId)
          .map((c) => c.id);
        newAssignments = s.netAssignments.filter(
          (a) =>
            !affectedComponentIds.includes(a.componentId) ||
            newPinIds.has(a.pinId)
        );
      }
      return { componentDefs: newDefs, netAssignments: newAssignments };
    });
  },

  addComponent: (defId, schematicPos) => {
    get().pushSnapshot();
    const id = generateId();
    set((s) => {
      const def = s.componentDefs.find((d) => d.id === defId);
      const prefix = def?.defaultLabelPrefix ?? "X";
      return {
        components: [
          ...s.components,
          {
            id,
            defId,
            label: nextLabel(s.components, prefix),
            schematicPos,
            schematicRotation: 0,
            boardPos: null,
            rotation: 0,
          },
        ],
      };
    });
    set(settleSchematic(get()));
  },

  addComponentInstance: (init) => {
    const id = generateId();
    get().pushSnapshot();
    set((s) => {
      const def = s.componentDefs.find((d) => d.id === init.defId);
      const prefix = def?.defaultLabelPrefix ?? "X";
      return {
        components: [
          ...s.components,
          {
            id,
            defId: init.defId,
            label: nextLabel(s.components, prefix),
            value: init.value,
            schematicPos: init.schematicPos,
            schematicRotation: init.schematicRotation ?? 0,
            schematicMirrored: init.schematicMirrored,
            labelOffset: init.labelOffset,
            pinLabelOffsets: init.pinLabelOffsets,
            footprintOverride: init.footprintOverride,
            package: init.package,
            boardPos: null,
            rotation: 0,
          },
        ],
      };
    });
    set(settleSchematic(get()));
    return id;
  },

  updateLabel: (id, label) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, label } : c
      ),
    }));
  },

  updateComponentValue: (id, value) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, value } : c
      ),
    }));
  },

  setShowValuesOnBoard: (show) => {
    get().pushSnapshot();
    set({ showValuesOnBoard: show });
  },

  // Persisted project preference; marks dirty so the toggle itself gets saved.
  setAutoSave: (autoSave) => set({ autoSave, isDirty: true }),


  // No snapshot — called per-pixel during drag
  updateLabelOffset: (id, offset) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, labelOffset: offset } : c
      ),
    })),

  // No snapshot — called per-pixel during drag
  updatePinLabelOffset: (id, pinId, offset) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? { ...c, pinLabelOffsets: { ...c.pinLabelOffsets, [pinId]: offset } }
          : c
      ),
    })),

  // No snapshot — called per-pixel during drag
  updateBoardLabelOffset: (id, offset) =>
    set((s) => {
      // A pad or connector of an off-board part is not stored itself: its
      // label's place is kept on the part.
      const lead = parseLeadId(id);
      return {
        components: s.components.map((c) => {
          if (lead && c.id === lead.componentId) {
            return lead.pinId === GROUP_PIN
              ? { ...c, boardLabelOffset: offset }
              : { ...c, leadLabelOffsets: { ...c.leadLabelOffsets, [lead.pinId]: offset } };
          }
          return c.id === id ? { ...c, boardLabelOffset: offset } : c;
        }),
      };
    }),

  updatePinName: (componentId, pinId, newName) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== componentId) return c;
        if (c.footprintOverride) {
          return {
            ...c,
            footprintOverride: {
              ...c.footprintOverride,
              pins: c.footprintOverride.pins.map((p) =>
                p.id === pinId ? { ...p, name: newName } : p
              ),
            },
          };
        }
        const baseDef = s.componentDefs.find((d) => d.id === c.defId);
        if (!baseDef) return c;
        return {
          ...c,
          footprintOverride: {
            width: baseDef.width,
            height: baseDef.height,
            pins: baseDef.pins.map((p) =>
              p.id === pinId ? { ...p, name: newName } : p
            ),
            bodyCells: baseDef.bodyCells,
          },
        };
      }),
    }));
  },

  setComponentPackage: (componentId, packageId, scope) => {
    const s0 = get();
    const target = s0.components.find((c) => c.id === componentId);
    if (!target) return;
    const baseDef = s0.componentDefs.find((d) => d.id === target.defId);
    if (!baseDef) return;
    const footprint = footprintFor(baseDef, packageId);
    get().pushSnapshot();
    set((s) => {
      const ids = new Set(
        scope === "type" ? s.components.filter((c) => c.defId === target.defId).map((c) => c.id) : [componentId]
      );
      const reshaped: string[] = [];
      const components = s.components.map((c) => {
        if (!ids.has(c.id)) return c;
        const next: Component = { ...c, package: packageId };
        if (footprint) {
          next.footprintOverride = {
            width: footprint.width, height: footprint.height,
            pins: footprint.pins, bodyCells: footprint.bodyCells,
          };
        } else if (c.footprintOverride && c.package && c.package !== packageId) {
          // Leaving a pin-moving package: back to the definition's footprint.
          next.footprintOverride = undefined;
        } else {
          return next;
        }
        if (!c.boardPos) return next;
        reshaped.push(c.id);
        // The pins moved: it stays where it was with its first pin in the same
        // hole, or goes back to the unplaced list when it no longer fits.
        const oldDef = resolveComponentDef(c, s.componentDefs);
        const newDef = resolveComponentDef(next, s.componentDefs);
        const before = oldDef && getComponentPinPositions(c, oldDef)[0];
        const after = newDef && getComponentPinPositions(next, newDef)[0];
        if (!newDef || !before || !after) return { ...next, boardPos: null, flexibleEndPos: undefined };
        const boardPos = { row: c.boardPos.row + before.row - after.row, col: c.boardPos.col + before.col - after.col };
        const b = getComponentBounds(newDef, boardPos, c.rotation);
        return b.minRow < 0 || b.minCol < 0 || b.maxRow >= s.board.rows || b.maxCol >= s.board.cols
          ? { ...next, boardPos: null, flexibleEndPos: undefined }
          : { ...next, boardPos };
      });
      // the cuts under the old body go, the new body brings its own
      let cuts = cutsWithoutParts(s, reshaped);
      for (const c of components) {
        if (reshaped.includes(c.id) && c.boardPos) cuts = cutsWithPart({ ...s, components }, cuts, c);
      }
      return { components, board: { ...s.board, cuts }, isDirty: true, ...bumpBoardEdits(s) };
    });
  },

  updateComponentFootprint: (componentId, override) => {
    get().pushSnapshot();
    set((s) => {
      const newComponents = s.components.map((c) =>
        c.id === componentId ? { ...c, footprintOverride: override } : c
      );
      const newPinIds = new Set(override.pins.map((p) => p.id));
      const newAssignments = s.netAssignments.filter(
        (a) => a.componentId !== componentId || newPinIds.has(a.pinId)
      );
      return { components: newComponents, netAssignments: newAssignments };
    });
  },

  removeComponent: (id) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      netAssignments: s.netAssignments.filter((a) => a.componentId !== id),
      board: { ...s.board, cuts: cutsWithoutParts(s, [id]) },
      // Deleting a part that sat on the board changes the board
      ...(s.components.find((c) => c.id === id)?.boardPos ? bumpBoardEdits(s) : {}),
    }));
    // Wires are positional so they stay; the nets follow from what is left
    set(settleSchematic(get()));
  },

  beginSchematicMove: (compIds, wireIds, labelIds) => {
    const s = get();
    set({
      _gesture: {
        compIds: [...compIds],
        labelIds: [...labelIds],
        wireIds: [...wireIds],
        base: { components: s.components, netLabels: s.netLabels, schematicWires: s.schematicWires },
        total: { x: 0, y: 0 },
        axisLock: axisLockFor(s.schematicWires, new Set(wireIds), compIds.length + labelIds.length > 0),
        nonce: generateId(),
      },
    });
  },

  // No auto-snapshot: called per grid step during a drag or per arrow press.
  // Re-derived from the gesture's starting geometry every time.
  moveSchematicItems: (delta) =>
    set((s) => {
      const g = s._gesture;
      if (!g) return s;
      const total = {
        x: g.axisLock === "h" ? 0 : g.total.x + delta.x,
        y: g.axisLock === "v" ? 0 : g.total.y + delta.y,
      };
      const compIds = new Set(g.compIds), labelIds = new Set(g.labelIds);
      const f = (p: { x: number; y: number }) => ({ x: p.x + total.x, y: p.y + total.y });
      const { stat, movingPoints } = movingAndStaticKeys(g.base.components, s.componentDefs, g.base.netLabels, compIds, labelIds);
      return {
        components: g.base.components.map((c) => (compIds.has(c.id) ? { ...c, schematicPos: f(c.schematicPos) } : c)),
        netLabels: g.base.netLabels.map((l) => (labelIds.has(l.id) ? { ...l, pos: f(l.pos) } : l)),
        schematicWires: moveGeometry(g.base.schematicWires, stat, movingPoints, new Set(g.wireIds), f, g.nonce),
        _gesture: { ...g, total },
      };
    }),

  finishSchematicGesture: () => {
    set({ ...settleSchematic(get()), _gesture: null });
  },

  cancelSchematicGesture: () => set({ _gesture: null }),

  transformSchematicSelection: (compIds, wireIds, labelIds, op, center) => {
    get().pushSnapshot();
    set((s) => transformSelection(s.components, s.componentDefs, s.netLabels, s.schematicWires, new Set(compIds), new Set(wireIds), new Set(labelIds), op, generateId(), center));
    set(settleSchematic(get()));
  },

  pasteSchematicItems: (items) => {
    get().pushSnapshot();
    const componentIds: string[] = [];
    const wireIds: string[] = [];
    const labelIds: string[] = [];
    set((s) => {
      const components = [...s.components];
      for (const c of items.components) {
        const def = s.componentDefs.find((d) => d.id === c.defId);
        const prefix = def?.defaultLabelPrefix ?? "X";
        const id = generateId();
        componentIds.push(id);
        components.push({ ...c, id, label: nextLabel(components, prefix), boardPos: null, rotation: 0 });
      }
      const schematicWires = [...s.schematicWires];
      for (const w of items.wires) {
        const id = generateId();
        wireIds.push(id);
        schematicWires.push({ ...w, id });
      }
      const netLabels = [...s.netLabels];
      for (const l of items.labels) {
        const id = generateId();
        labelIds.push(id);
        netLabels.push({ ...l, id });
      }
      return { components, schematicWires, netLabels };
    });
    set(settleSchematic(get()));
    return { componentIds, wireIds, labelIds };
  },

  // A single part turns in place, around its own origin
  rotateSchematicComponent: (id) => {
    const comp = get().components.find((c) => c.id === id);
    if (comp) get().transformSchematicSelection([id], [], [], "rotate", comp.schematicPos);
  },

  mirrorSchematicComponent: (id) => {
    const comp = get().components.find((c) => c.id === id);
    if (comp) get().transformSchematicSelection([id], [], [], "mirror", comp.schematicPos);
  },

  // No auto-snapshot: called per-pixel during board dragging. Discrete callers
  // (e.g. tray→board drop) must call pushSnapshot() once themselves; drag
  // gestures push a single snapshot at the start of the gesture.
  placeOnBoard: (id, pos) => {
    set((s) => {
      const before = boardView(s.components, s.componentDefs, s.netAssignments).components.find((c) => c.id === id);
      return {
      // A part new to the board brings the cuts it needs under its body
      ...(before && !before.boardPos
        ? { board: { ...s.board, cuts: cutsWithPart(s, s.board.cuts, { ...before, boardPos: pos }) } }
        : {}),
      components: onBoard(s, (view) => view.map((c) => {
        if (c.id !== id) return c;
        const def = resolveComponentDef(c, s.componentDefs);
        // For flexible components, initialize flexibleEndPos on first placement
        let flexEnd = c.flexibleEndPos;
        if (def?.flexible && !flexEnd && def.pins.length >= 2) {
          flexEnd = {
            row: pos.row + def.pins[1].offsetRow,
            col: pos.col + def.pins[1].offsetCol,
          };
        }
        return { ...c, boardPos: pos, flexibleEndPos: flexEnd };
      })),
      ...bumpBoardEdits(s),
      // First placement of a part = the circuit growing, not a correction
      ...(before?.boardPos
        ? {}
        : { boardAddsSinceAutoLayout: (s.boardAddsSinceAutoLayout ?? 0) + 1 }),
    };
    });
  },

  moveComponentsOnBoard: (ids, deltaRow, deltaCol, wireIds, cutPositions) =>
    set((s) => {
      const newComponents = onBoard(s, (view) => view.map((c) => {
        if (!ids.includes(c.id) || !c.boardPos) return c;
        return {
          ...c,
          boardPos: {
            row: c.boardPos.row + deltaRow,
            col: c.boardPos.col + deltaCol,
          },
          flexibleEndPos: c.flexibleEndPos ? {
            row: c.flexibleEndPos.row + deltaRow,
            col: c.flexibleEndPos.col + deltaCol,
          } : undefined,
        };
      }));

      let newWires = s.board.wires;
      if (wireIds && wireIds.length > 0) {
        newWires = newWires.map((w) => {
          if (!wireIds.includes(w.id)) return w;
          return {
            ...w,
            from: { row: w.from.row + deltaRow, col: w.from.col + deltaCol },
            to: { row: w.to.row + deltaRow, col: w.to.col + deltaCol },
          };
        });
      }

      let newCuts = s.board.cuts;
      if (cutPositions && cutPositions.length > 0) {
        newCuts = newCuts.map((c) => {
          const match = cutPositions.find(
            (cp) => cp.row === c.row && cp.col === c.col && (cp.kind === "hole") === (c.kind === "hole")
          );
          if (!match) return c;
          return { ...c, row: c.row + deltaRow, col: c.col + deltaCol };
        });
      }

      return {
        components: newComponents,
        board: { ...s.board, wires: newWires, cuts: newCuts },
        ...bumpBoardEdits(s),
      };
    }),

  removeFromBoard: (id) => {
    get().pushSnapshot();
    set((s) => ({
      components: onBoard(s, (view) => view.map((c) =>
        // Unplacing clears the lock: it refers to a board position. A pad's
        // lock is its part's, shared with its siblings, so that one stays.
        c.id !== id ? c : isLead(c) ? { ...c, boardPos: null } : { ...c, boardPos: null, flexibleEndPos: undefined, locked: undefined }
      )),
      board: { ...s.board, cuts: cutsWithoutParts(s, [id]) },
      ...bumpBoardEdits(s),
    }));
  },

  // Toggle whether a component is excluded from the stripboard. Excluding also
  // unplaces it (clears boardPos) so it lives on the schematic only.
  setBoardExcluded: (id, excluded) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? {
              ...c,
              boardExcluded: excluded,
              // Unplacing clears the lock: it refers to a board position
              ...(excluded ? { boardPos: null, flexibleEndPos: undefined, locked: undefined, offBoard: undefined, offBoardPackage: undefined, leads: undefined, leadLabelOffsets: undefined, boardLabelOffset: c.offBoard ? undefined : c.boardLabelOffset, rotation: c.offBoard ? 0 : c.rotation } : {}),
            }
          : c
      ),
      ...(excluded ? { board: { ...s.board, cuts: cutsWithoutParts(s, [id]) } } : {}),
      // Only counts as a board change when it takes a placed part off the board
      ...(excluded && s.components.find((c) => c.id === id)?.boardPos ? bumpBoardEdits(s) : {}),
    }));
  },

  // Mounted off the board and wired to it: the part leaves the board and each
  // wired pin gets a solder pad to place instead. Not the same as excluded,
  // which drops the part from the build altogether.
  setOffBoard: (id, offBoard) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id !== id
          ? c
          : offBoard
            ? { ...c, offBoard: true, boardExcluded: undefined, boardPos: null, flexibleEndPos: undefined, boardLabelOffset: undefined }
            // its board position was its connector's while it was off the board
            : { ...c, offBoard: undefined, offBoardPackage: undefined, leads: undefined, leadLabelOffsets: undefined, boardLabelOffset: undefined, locked: undefined, boardPos: null, rotation: 0 }
      ),
      board: { ...s.board, cuts: cutsWithoutParts(s, [id]) },
      ...bumpBoardEdits(s),
    }));
  },

  // What an off-board part's wires arrive at: loose pads ("wire") or one
  // connector. The shape changes, so whatever was placed comes off the board.
  setOffBoardPackage: (id, connection, scope) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.offBoard && !c.boardExcluded && (scope === "all" || c.id === id)
          ? { ...c, offBoardPackage: connection === "wire" ? undefined : connection, leads: undefined, leadLabelOffsets: undefined, boardLabelOffset: undefined, boardPos: null, rotation: 0, locked: undefined }
          : c
      ),
      board: {
        ...s.board,
        cuts: cutsWithoutParts(s, s.components.filter((c) => c.offBoard && !c.boardExcluded && (scope === "all" || c.id === id)).map((c) => c.id)),
      },
      ...bumpBoardEdits(s),
    }));
  },

  toggleBoardLock: (id) => {
    get().pushSnapshot();
    set((s) => ({
      components: onBoard(s, (view) => view.map((c) =>
        c.id === id ? { ...c, locked: !c.locked } : c
      )),
    }));
  },

  // Set the lock flag on many components at once (bulk lock/unlock) as one
  // undo step.
  setBoardLock: (ids, locked) => {
    get().pushSnapshot();
    const idSet = new Set(ids);
    set((s) => ({
      components: onBoard(s, (view) => view.map((c) =>
        idSet.has(c.id) ? { ...c, locked } : c
      )),
    }));
  },

  // Set pin 2 position for flexible components (no snapshot — called per-pixel during drag)
  setFlexibleEndPos: (id, pos) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, flexibleEndPos: pos } : c
      ),
      ...bumpBoardEdits(s),
    })),

  rotateComponent: (id) => {
    const s = get();
    // the board's view, so that an off-board part's connector turns as well
    const comp = boardView(s.components, s.componentDefs, s.netAssignments).components.find((c) => c.id === id);
    if (!comp || !comp.boardPos) return;
    const def = resolveComponentDef(comp, s.componentDefs);
    if (!def) return;

    // Flexible component: rotate pin positions 90° around midpoint
    if (def.flexible && comp.boardPos) {
      const pin1 = comp.boardPos;
      const pin2 = comp.flexibleEndPos ?? {
        row: pin1.row + (def.pins[1]?.offsetRow ?? 1),
        col: pin1.col + (def.pins[1]?.offsetCol ?? 0),
      };
      // Rotate the pin1→pin2 offset 90° CW (dr,dc) → (dc,-dr), keeping both pins
      // on the grid. The anchor is shifted by a closed-form g so the rotation is
      // an exact period-4 cycle: 2 rotations land in place, 4 return to start.
      // (Rounding each pin about a half-hole midpoint made even-length parts walk.)
      const p = pin2.row - pin1.row;
      const q = pin2.col - pin1.col;
      const gRow = Math.floor(p / 2) - Math.floor(q / 2);
      const gCol = Math.floor(p / 2) + Math.ceil(q / 2);
      const new1Row = pin1.row + gRow;
      const new1Col = pin1.col + gCol;
      const new2Row = new1Row + q;
      const new2Col = new1Col - p;
      // Bounds check
      if (new1Row < 0 || new1Col < 0 || new2Row < 0 || new2Col < 0 ||
          new1Row >= s.board.rows || new1Col >= s.board.cols ||
          new2Row >= s.board.rows || new2Col >= s.board.cols) {
        return;
      }
      get().pushSnapshot();
      set((s2) => ({
        components: s2.components.map((c) =>
          c.id === id ? { ...c, boardPos: { row: new1Row, col: new1Col }, flexibleEndPos: { row: new2Row, col: new2Col } } : c
        ),
        ...bumpBoardEdits(s2),
      }));
      return;
    }

    // Fixed component: standard rotation
    const newRotation = ((comp.rotation + 90) % 360) as Component["rotation"];
    const bounds = getComponentBounds(def, comp.boardPos, newRotation);
    if (bounds.minRow < 0 || bounds.minCol < 0 ||
        bounds.maxRow >= s.board.rows || bounds.maxCol >= s.board.cols) {
      return;
    }
    get().pushSnapshot();
    set((s2) => ({
      components: onBoard(s2, (view) => view.map((c) =>
        c.id === id ? { ...c, rotation: newRotation } : c
      )),
      // the cuts under the body follow its pins to where they now are
      board: { ...s2.board, cuts: cutsWithPart(s2, cutsWithoutParts(s2, [id]), { ...comp, rotation: newRotation }) },
      ...bumpBoardEdits(s2),
    }));
  },

  // Auto-fix swapped polarity: after a 2-pin part is placed or moved, if its two
  // legs sit on each other's target net (right nets, wrong way round), flip it
  // 180° so each pin lands on its correct net. Folds into the caller's snapshot.
  autoAlignPolarity: (ids) => {
    const s = get();
    const updates = new Map<string, Partial<Component>>();

    for (const id of ids) {
      const comp = s.components.find((c) => c.id === id);
      if (!comp || !comp.boardPos) continue;
      const def = resolveComponentDef(comp, s.componentDefs);
      if (!def || def.pins.length !== 2) continue;

      const pins = getComponentPinPositions(comp, def);
      if (pins.length !== 2) continue;
      const [p1, p2] = pins;

      // Each pin's correct net, from the schematic.
      const netOf = (pinId: string) =>
        s.netAssignments.find((a) => a.componentId === id && a.pinId === pinId)?.netId;
      const exp1 = netOf(p1.pinId);
      const exp2 = netOf(p2.pinId);
      if (!exp1 || !exp2 || exp1 === exp2) continue;

      // Nets already present at each hole, computed WITHOUT this part's own pins.
      const others = s.components.filter((c) => c.id !== id);
      const segs = computeStripSegments(s.board, others, s.componentDefs, s.netAssignments);
      const groups = computeConnectivity(segs, s.board.wires);
      const ambientAt = (row: number, col: number): Set<string> => {
        const idx = segs.findIndex(
          (seg) => seg.row === row && col >= seg.startCol && col <= seg.endCol
        );
        if (idx < 0) return new Set();
        const g = groups.find((gr) => gr.segmentIndices.includes(idx));
        return new Set(g ? g.netIds : segs[idx].netIds);
      };
      const amb1 = ambientAt(p1.row, p1.col);
      const amb2 = ambientAt(p2.row, p2.col);

      // Clean swap only: each leg sits alone on the OTHER leg's target net.
      const swapped =
        amb1.size === 1 && amb1.has(exp2) &&
        amb2.size === 1 && amb2.has(exp1);
      if (!swapped) continue;

      if (def.flexible) {
        // 180° for a flexible part = swap its two endpoints (stays in place).
        updates.set(id, {
          boardPos: { row: p2.row, col: p2.col },
          flexibleEndPos: { row: p1.row, col: p1.col },
        });
      } else {
        updates.set(id, { rotation: ((comp.rotation + 180) % 360) as Component["rotation"] });
      }
    }

    if (updates.size === 0) return;
    set((s2) => ({
      components: s2.components.map((c) =>
        updates.has(c.id) ? { ...c, ...updates.get(c.id)! } : c
      ),
      ...bumpBoardEdits(s2),
    }));
  },

  // ── Schematic wires ──────────────────────────────────

  addSchematicWire: (start, end) => {
    if (Math.round(start.x) === Math.round(end.x) && Math.round(start.y) === Math.round(end.y)) return [];
    get().pushSnapshot();
    const s = get();
    const legs: SchematicWire[] = [];
    if (Math.round(start.x) === Math.round(end.x) || Math.round(start.y) === Math.round(end.y)) {
      legs.push({ id: generateId(), start, end });
    } else {
      // An L: the mouse's initial direction picks the corner, else the longer axis first
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      const horizontalFirst = s.schematicWireDirection ? s.schematicWireDirection === "horizontal-first" : dx >= dy;
      const corner = horizontalFirst ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
      legs.push({ id: generateId(), start, end: corner }, { id: generateId(), start: corner, end });
    }
    set({ schematicWires: attachWireEnds([...s.schematicWires, ...legs], new Set(legs.map((l) => l.id)), generateId) });
    set(settleSchematic(get()));
    // Settling may have split a leg; report whichever piece starts where the leg did
    const now = get().schematicWires;
    return legs
      .map((leg) => now.find((w) => w.id === leg.id) ?? now.find((w) => Math.round(w.start.x) === Math.round(leg.start.x) && Math.round(w.start.y) === Math.round(leg.start.y)))
      .filter((w): w is SchematicWire => !!w)
      .map((w) => w.id);
  },

  removeSchematicWire: (id) => {
    get().pushSnapshot();
    const s = get();
    set({ schematicWires: s.schematicWires.filter((w) => w.id !== id) });
    set(settleSchematic(get()));
  },

  // ── Net labels ──────────────────────────────────────

  addNetLabel: (kind, pos, name, rotation) => {
    get().pushSnapshot();
    const id = generateId();
    const label: NetLabel = {
      id,
      kind,
      name: name ?? (kind === "gnd" ? "GND" : kind === "power" ? "VCC" : "NET"),
      pos: { x: snapToGrid(pos.x), y: snapToGrid(pos.y) },
      rotation: rotation ?? 0,
    };
    set((s) => ({ netLabels: [...s.netLabels, label] }));
    set(settleSchematic(get()));
    return id;
  },

  updateNetLabel: (id, updates) => {
    get().pushSnapshot();
    set((s) => ({
      netLabels: s.netLabels.map((l) => (l.id === id ? { ...l, ...updates, name: (updates.name ?? l.name).trim() || l.name } : l)),
    }));
    set(settleSchematic(get()));
  },

  removeNetLabels: (ids) => {
    get().pushSnapshot();
    const drop = new Set(ids);
    set((s) => ({ netLabels: s.netLabels.filter((l) => !drop.has(l.id)) }));
    set(settleSchematic(get()));
  },

  // ── Nets ─────────────────────────────────────────────

  updateNet: (id, updates) => {
    get().pushSnapshot();
    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    }));
  },

  renameNet: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().pushSnapshot();
    set((s) => {
      const net = s.nets.find((n) => n.id === id);
      if (!net) return s;
      return {
        nets: s.nets.map((n) => (n.id === id ? { ...n, name: trimmed } : n)),
        netLabels: s.netLabels.map((l) => (l.name === net.name ? { ...l, name: trimmed } : l)),
      };
    });
    set(settleSchematic(get()));
  },

  previewWiringSwitch: () => {
    const s = get();
    const empty: NetDiff = { merges: [], joins: [], newNets: [], renames: [] };
    if (s.wiring === "touch") return empty;
    return diffNets(s, settleSchematic({ ...s, wiring: "touch" }), (componentId, pinId) => {
      const comp = s.components.find((c) => c.id === componentId);
      const def = comp && resolveComponentDef(comp, s.componentDefs);
      const pin = def?.pins.find((p) => p.id === pinId);
      return `${comp?.label ?? "?"} pin ${pin?.name ?? pinId}`;
    });
  },

  switchWiringToTouch: () => {
    if (get().wiring === "touch") return;
    get().pushSnapshot();
    set({ wiring: "touch" });
    set(settleSchematic(get()));
  },

  removeNet: (id) => {
    get().pushSnapshot();
    set((s) => {
      // Remove the net and all its assignments
      const newAssignments = s.netAssignments.filter((a) => a.netId !== id);
      // Also remove schematic wires that connected pins of this net
      // (We need to recalculate after removing assignments)
      return {
        nets: s.nets.filter((n) => n.id !== id),
        netAssignments: newAssignments,
      };
    });
  },

  // ── Board ────────────────────────────────────────────

  setBoardSize: (rows, cols) => {
    get().pushSnapshot();
    set((s) => ({
      board: { ...s.board, rows, cols },
      ...bumpBoardEdits(s),
    }));
  },

  setBoardDimLock: (dim, locked) => {
    set((s) => ({
      board: { ...s.board, ...(dim === "rows" ? { lockedRows: locked } : { lockedCols: locked }) },
      isDirty: true,
    }));
  },

  setTidyWires: (value) => {
    set({ tidyWires: value, isDirty: true });
  },

  setDrilledCutsOnly: (value) => {
    set({ drilledCutsOnly: value ? undefined : false, isDirty: true });
  },

  setPermBoards: (n) => {
    // 1 is stored explicitly: absent means the shipped default, not off
    set({ permBoards: Math.max(1, Math.round(n)), isDirty: true });
  },

  setPermWorkers: (n) => {
    set({ permWorkers: Math.max(1, Math.round(n)), isDirty: true });
  },

  setV5Moves: (n) => {
    set({ v5Moves: n > 0 ? Math.round(n) : undefined, isDirty: true });
  },

  setV5TimeS: (n) => {
    set({ v5TimeS: n > 0 ? Math.round(n) : undefined, isDirty: true });
  },

  // the stored speed only moves when a run measures something clearly
  // different, so a run's move count stays on the same rung under ordinary
  // load noise; it is a machine property, so it does not dirty the project
  setV5MsPerMove: (n) => {
    if (!(n > 0)) return;
    const old = get().v5MsPerMove;
    if (old !== undefined && Math.abs(n / old - 1) < 0.15) return;
    set({ v5MsPerMove: n });
  },

  setV5RandomSeeds: (value) => {
    set({ v5RandomSeeds: value ? true : undefined, isDirty: true });
  },

  setLayoutEngine: (engine) => {
    set({ layoutEngine: engine === "v5" ? undefined : engine, isDirty: true });
  },

  setNoWireStacking: (value) => {
    set({ noWireStacking: value ? undefined : false, isDirty: true });
  },

  // Both store an explicit off, so that a project's legacy per-type settings
  // are read into them only until the user has chosen for himself.
  setAllowStanding: (value) => {
    set({ allowStanding: value, isDirty: true });
  },

  setPartSpacing: (lines) => {
    set({ partSpacing: Math.max(0, Math.min(1, Math.round(lines))), isDirty: true });
  },

  insertBoardLine: (axis, at) => {
    get().pushSnapshot();
    set((s) => {
      const isRow = axis === "row";
      const shiftPos = <T extends { row: number; col: number }>(p: T): T =>
        isRow
          ? p.row >= at ? { ...p, row: p.row + 1 } : p
          : p.col >= at ? { ...p, col: p.col + 1 } : p;
      const components = onBoard(s, (view) => view.map((c) => {
        if (!c.boardPos) return c;
        const def = resolveComponentDef(c, s.componentDefs);
        if (!def) return c;
        if (def.flexible) {
          return {
            ...c,
            boardPos: shiftPos(c.boardPos),
            ...(c.flexibleEndPos ? { flexibleEndPos: shiftPos(c.flexibleEndPos) } : {}),
          };
        }
        // A rigid moves only when its whole footprint sits at/beyond the
        // line; a straddler cannot be split and stays put.
        const bounds = getComponentBounds(def, c.boardPos, c.rotation);
        const wholly = isRow ? bounds.minRow >= at : bounds.minCol >= at;
        if (!wholly) return c;
        return {
          ...c,
          boardPos: isRow
            ? { row: c.boardPos.row + 1, col: c.boardPos.col }
            : { row: c.boardPos.row, col: c.boardPos.col + 1 },
        };
      }));
      const board = {
        ...s.board,
        rows: s.board.rows + (isRow ? 1 : 0),
        cols: s.board.cols + (isRow ? 0 : 1),
        cuts: s.board.cuts.map((cut) => shiftPos(cut)),
        wires: s.board.wires.map((w) => ({ ...w, from: shiftPos(w.from), to: shiftPos(w.to) })),
      };
      return { components, board, isDirty: true, ...bumpBoardEdits(s) };
    });
  },

  deleteBoardLine: (axis, at) => {
    const isRow = axis === "row";
    const { board } = get();
    if ((isRow ? board.rows : board.cols) <= 1) return;
    get().pushSnapshot();
    set((s) => {
      const coord = (p: { row: number; col: number }) => (isRow ? p.row : p.col);
      const shiftPos = <T extends { row: number; col: number }>(p: T): T =>
        isRow
          ? p.row > at ? { ...p, row: p.row - 1 } : p
          : p.col > at ? { ...p, col: p.col - 1 } : p;
      const unplace = (c: Component): Component => ({ ...c, boardPos: null, flexibleEndPos: undefined, locked: undefined });
      const components = onBoard(s, (view) => view.map((c) => {
        if (!c.boardPos) return c;
        const def = resolveComponentDef(c, s.componentDefs);
        if (!def) return c;
        if (def.flexible) {
          // An endpoint on the line loses its hole; a part merely spanning
          // the line shortens with the board (no minimum-span check here).
          const end = c.flexibleEndPos ?? c.boardPos;
          if (coord(c.boardPos) === at || coord(end) === at) return unplace(c);
          return {
            ...c,
            boardPos: shiftPos(c.boardPos),
            ...(c.flexibleEndPos ? { flexibleEndPos: shiftPos(c.flexibleEndPos) } : {}),
          };
        }
        // A rigid footprint cannot shrink: touching the line unplaces it,
        // wholly beyond shifts, wholly before stays.
        const bounds = getComponentBounds(def, c.boardPos, c.rotation);
        const lo = isRow ? bounds.minRow : bounds.minCol;
        const hi = isRow ? bounds.maxRow : bounds.maxCol;
        if (lo <= at && at <= hi) return unplace(c);
        if (lo < at) return c;
        return {
          ...c,
          boardPos: isRow
            ? { row: c.boardPos.row - 1, col: c.boardPos.col }
            : { row: c.boardPos.row, col: c.boardPos.col - 1 },
        };
      }));
      // A between-cut severs col|col+1, so on the column axis it touches the
      // deleted hole column from either side.
      const cutGone = (cut: Cut) =>
        isRow
          ? cut.row === at
          : cut.kind === "hole"
            ? cut.col === at
            : cut.col === at || cut.col === at - 1;
      const wireGone = (w: Wire) => coord(w.from) === at || coord(w.to) === at;
      const newBoard = {
        ...s.board,
        rows: s.board.rows - (isRow ? 1 : 0),
        cols: s.board.cols - (isRow ? 0 : 1),
        cuts: s.board.cuts.filter((c) => !cutGone(c)).map((cut) => shiftPos(cut)),
        wires: s.board.wires.filter((w) => !wireGone(w)).map((w) => ({ ...w, from: shiftPos(w.from), to: shiftPos(w.to) })),
      };
      return { components, board: newBoard, isDirty: true, ...bumpBoardEdits(s) };
    });
  },

  placeCut: (cut) => {
    get().pushSnapshot();
    set((s) => ({
      board: { ...s.board, cuts: [...s.board.cuts, cut] },
      ...bumpBoardEdits(s),
    }));
  },

  removeCut: (cut) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        cuts: s.board.cuts.filter(
          (c) => !(c.row === cut.row && c.col === cut.col && (c.kind === "hole") === (cut.kind === "hole"))
        ),
      },
      ...bumpBoardEdits(s),
    }));
  },


  addWire: (from, to) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        wires: [...s.board.wires, { id: generateId(), from, to }],
      },
      wirePlacementFrom: null,
      ...bumpBoardEdits(s),
    }));
  },

  // No snapshot: called per hole while a wire is dragged
  setWireEnds: (wireId, from, to) =>
    set((s) => ({
      board: { ...s.board, wires: s.board.wires.map((w) => (w.id === wireId ? { ...w, from, to } : w)) },
      ...bumpBoardEdits(s),
    })),

  removeWire: (wireId) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        wires: s.board.wires.filter((w) => w.id !== wireId),
      },
      ...bumpBoardEdits(s),
    }));
  },

  applyAutoLayout: (result, meta) => {
    const s = get();
    // Auto-layout regenerates cuts and wires; only apply (and snapshot) when
    // something actually changes.
    const cutKey = (c: Cut) => `${c.row}:${c.col}:${c.kind === "hole"}`;
    const wireKey = (w: { from: BoardPosition; to: BoardPosition }) =>
      [`${w.from.row},${w.from.col}`, `${w.to.row},${w.to.col}`].sort().join("-");
    const sameCuts =
      result.cuts.length === s.board.cuts.length &&
      result.cuts.map(cutKey).sort().join("|") === s.board.cuts.map(cutKey).sort().join("|");
    const sameWires =
      result.wires.length === s.board.wires.length &&
      result.wires.map(wireKey).sort().join("|") === s.board.wires.map(wireKey).sort().join("|");
    const sameSize =
      !result.boardSize ||
      (result.boardSize.rows === s.board.rows && result.boardSize.cols === s.board.cols);
    const unplace = new Set(result.unplaceIds ?? []);
    if (result.placements.length === 0 && sameCuts && sameWires && sameSize && unplace.size === 0) return;

    get().pushSnapshot();
    const byId = new Map(result.placements.map((p) => [p.componentId, p]));
    set((st) => ({
      components: onBoard(st, (view) => view.map((c) => {
        if (unplace.has(c.id)) {
          return { ...c, boardPos: null, flexibleEndPos: undefined, locked: undefined };
        }
        const p = byId.get(c.id);
        if (!p) return c;
        return {
          ...c,
          boardPos: p.boardPos,
          ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
          ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}),
        };
      })),
      board: {
        ...st.board,
        ...(result.boardSize ?? {}),
        cuts: result.cuts,
        wires: result.wires.map((w) => ({ id: generateId(), from: w.from, to: w.to })),
      },
      autoLayoutUsed: true,
      autoLayoutRuns: (st.autoLayoutRuns ?? 0) + 1,
      autoLayoutLastAt: new Date().toISOString(),
      autoLayoutLastQuality: result.quality,
      autoLayoutVersion: LAYOUT_VERSION,
      autoLayoutLastBoards: meta?.boards ?? 1,
      autoLayoutLastOrderings: meta?.orderings ?? 1,
      autoLayoutLastDrilled: meta?.drilled ?? false,
      boardEditsSinceAutoLayout: 0,
      boardAddsSinceAutoLayout: 0,
      _lastBoardEditSeq: -1,
    }));
  },

  autoFinishBoard: () => {
    const s = get();
    const view = boardView(s.components, s.componentDefs, s.netAssignments);
    const result = computeAutoFinish(
      s.board, view.components, s.componentDefs, s.nets, view.netAssignments, s.drilledCutsOnly !== false
    );
    if (result.cuts.length > 0 || result.wires.length > 0) {
      get().pushSnapshot();
      set((st) => ({
        board: {
          ...st.board,
          cuts: [...st.board.cuts, ...result.cuts],
          wires: [
            ...st.board.wires,
            ...result.wires.map((w) => ({ id: generateId(), from: w.from, to: w.to })),
          ],
        },
      }));
    }
    return result;
  },

  // ── UI State ─────────────────────────────────────────



  cancelWirePlacement: () => set({ wirePlacementFrom: null }),

  setWirePlacementFrom: (pos) => set({ wirePlacementFrom: pos }),

  setTrayDragComponentId: (id) => set({ trayDragComponentId: id }),
  setHighlightedNetId: (id) => set({ highlightedNetId: id }),

  setBoardTool: (tool) => set({ boardTool: tool, wirePlacementFrom: null }),
  setShowOverlaps: (value) => set({ showOverlaps: value }),
  setActiveEditor: (editor) => set({ activeEditor: editor }),
  toggleSchematicWireDrawMode: () => set((s) => ({
    schematicWireDrawMode: !s.schematicWireDrawMode,
    schematicWireDrawingFrom: null,
    schematicWireDirection: null,
  })),
  setSchematicWireDrawing: (from) => set({ schematicWireDrawingFrom: from, schematicWireDirection: null }),

  // Capture which wire endpoints should move with a component during drag.
  // Called once at drag start. Only captures endpoints at this component's pin positions
  // that are NOT also at another component's pin position.
  // ── Project persistence ──────────────────────────────

  setProjectName: (name) => set({ name }),

  setProjectDescription: (description) => set({ description, isDirty: true }),

  setProjectNotes: (notes) => set({ notes, isDirty: true }),

  exportProject: (): Project => {
    const s = get();
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = s.componentDefs.filter((d) => !defaultIds.has(d.id));
    return {
      version: PROJECT_SCHEMA_VERSION,
      name: s.name,
      description: s.description,
      notes: s.notes,
      componentDefs: customDefs,
      components: s.components,
      nets: s.nets,
      netAssignments: s.netAssignments,
      schematicWires: s.schematicWires,
      netLabels: s.netLabels,
      wiring: s.wiring,
      board: s.board,
      showValuesOnBoard: s.showValuesOnBoard,
      autoSave: s.autoSave,
      spanOverrides: s.spanOverrides,
      clearanceOverrides: s.clearanceOverrides,
      tidyWires: s.tidyWires,
      drilledCutsOnly: s.drilledCutsOnly,
      permBoards: s.permBoards,
      permWorkers: s.permWorkers,
      v5Moves: s.v5Moves,
      v5TimeS: s.v5TimeS,
      v5MsPerMove: s.v5MsPerMove,
      v5RandomSeeds: s.v5RandomSeeds,
      layoutEngine: s.layoutEngine,
      noWireStacking: s.noWireStacking,
      allowStanding: s.allowStanding,
      partSpacing: s.partSpacing,
      autoLayoutUsed: s.autoLayoutUsed,
      boardEditsSinceAutoLayout: s.boardEditsSinceAutoLayout,
      autoLayoutRuns: s.autoLayoutRuns,
      autoLayoutLastAt: s.autoLayoutLastAt,
      autoLayoutLastQuality: s.autoLayoutLastQuality,
      autoLayoutVersion: s.autoLayoutVersion,
      autoLayoutLastBoards: s.autoLayoutLastBoards,
      autoLayoutLastDrilled: s.autoLayoutLastDrilled,
      autoLayoutLastOrderings: s.autoLayoutLastOrderings,
      boardAddsSinceAutoLayout: s.boardAddsSinceAutoLayout,
    };
  },

  loadProject: (data) => {
    set({
      ...prepareProjectState(data),
      isDirty: false,
      _history: [],
      _redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },

  importProject: (data) => {
    get().pushSnapshot();
    set({ ...prepareProjectState(data), isDirty: true });
  },

  resetProject: () => set({
    name: "Untitled Project",
    description: "",
    notes: "",
    componentDefs: [...DEFAULT_COMPONENTS],
    components: [],
    nets: [],
    netAssignments: [],
    schematicWires: [],
    netLabels: [],
    wiring: "touch",
    board: { rows: 20, cols: 20, cuts: [], wires: [] },
    showValuesOnBoard: false,
      autoSave: false,
    spanOverrides: undefined,
    clearanceOverrides: undefined,
    tidyWires: undefined,
    drilledCutsOnly: undefined,
    permBoards: undefined,
    permWorkers: undefined,
    v5Moves: undefined,
    v5TimeS: undefined,
    v5MsPerMove: undefined,
    v5RandomSeeds: undefined,
    layoutEngine: undefined,
    noWireStacking: undefined,
    allowStanding: undefined,
    partSpacing: undefined,
    autoLayoutUsed: undefined,
    boardEditsSinceAutoLayout: undefined,
    autoLayoutRuns: undefined,
    autoLayoutLastAt: undefined,
    autoLayoutLastQuality: undefined,
    autoLayoutVersion: undefined,
    autoLayoutLastBoards: undefined,
    autoLayoutLastDrilled: undefined,
    autoLayoutLastOrderings: undefined,
    boardAddsSinceAutoLayout: undefined,
    _lastBoardEditSeq: -1,
    wirePlacementFrom: null,
    schematicWireDrawMode: false,
    schematicWireDrawingFrom: null,
    schematicWireDirection: null,
    isDirty: false,
    _history: [],
    _redoStack: [],
    canUndo: false,
    canRedo: false,
  }),

  // ── Undo/Redo ────────────────────────────────────────

  pushSnapshot: () => {
    const s = get();
    // Inside a transact(): the single up-front snapshot already covers the
    // whole operation, so skip nested ones (bulk delete = one undo step).
    if (s._suppressSnapshot) return;
    const snapshot = snapshotProject(s);
    const history = [...s._history, snapshot];
    if (history.length > MAX_HISTORY) history.shift();
    set({ _history: history, _redoStack: [], canUndo: true, canRedo: false, isDirty: true, _editSeq: s._editSeq + 1 });
  },

  transact: (fn) => {
    if (get()._suppressSnapshot) { fn(); return; } // already batching — just run
    get().pushSnapshot();              // one snapshot for the whole batch
    set({ _suppressSnapshot: true });
    try {
      fn();
    } finally {
      set({ _suppressSnapshot: false });
    }
  },

  undo: () => {
    const s = get();
    if (s._history.length === 0) return;
    const history = [...s._history];
    const snapshot = history.pop()!;
    const redoStack = [...s._redoStack, snapshotProject(s)];
    set({
      ...restoreProject(snapshot),
      _history: history,
      _redoStack: redoStack,
      canUndo: history.length > 0,
      canRedo: true,
      isDirty: true,
      _editSeq: s._editSeq + 1,
    });
  },

  redo: () => {
    const s = get();
    if (s._redoStack.length === 0) return;
    const redoStack = [...s._redoStack];
    const snapshot = redoStack.pop()!;
    const history = [...s._history, snapshotProject(s)];
    set({
      ...restoreProject(snapshot),
      _history: history,
      _redoStack: redoStack,
      canUndo: true,
      canRedo: redoStack.length > 0,
      isDirty: true,
      _editSeq: s._editSeq + 1,
    });
  },
}));
