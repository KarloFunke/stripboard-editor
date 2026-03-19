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
} from "@/types";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "@/components/stripboard/boardLayout";
import { recalculateNets } from "@/components/schematic/netInference";
import { getRotatedPinPositions } from "@/components/schematic/SymbolRenderer";
import { pointKey } from "@/utils/schematicConstants";
import { createFootprintSymbol, registerCustomSymbol } from "@/data/symbolDefs";

function generateId(): string {
  return crypto.randomUUID();
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

  // Components
  addComponent: (defId: string, schematicPos: { x: number; y: number }) => void;
  removeComponent: (id: string) => void;
  updateLabel: (id: string, label: string) => void;
  updatePinName: (componentId: string, pinId: string, newName: string) => void;
  updateComponentFootprint: (componentId: string, override: FootprintOverride) => void;
  updateSchematicPos: (id: string, pos: { x: number; y: number }) => void;
  rotateSchematicComponent: (id: string) => void;
  mirrorSchematicComponent: (id: string) => void;
  placeOnBoard: (id: string, pos: { row: number; col: number }) => void;
  moveComponentsOnBoard: (ids: string[], deltaRow: number, deltaCol: number, wireIds?: string[], cutPositions?: { row: number; col: number }[]) => void;
  removeFromBoard: (id: string) => void;
  setFlexibleEndPos: (id: string, pos: { row: number; col: number }) => void;
  rotateComponent: (id: string) => void;

  // Schematic wires
  addSchematicWire: (start: { x: number; y: number }, end: { x: number; y: number }) => void;
  removeSchematicWire: (id: string) => void;
  splitSchematicWire: (wireId: string, splitPoint: { x: number; y: number }) => void;

  // Nets (kept for rename/recolor, but auto-managed by wire system)
  updateNet: (id: string, updates: Partial<Pick<Net, "name" | "color">>) => void;
  removeNet: (id: string) => void;

  // Board
  placeCut: (cut: Cut) => void;
  removeCut: (cut: Cut) => void;
  // Board wires
  setBoardSize: (rows: number, cols: number) => void;
  addWire: (from: BoardPosition, to: BoardPosition) => void;
  removeWire: (wireId: string) => void;

  // UI state

  startWirePlacement: () => void;
  cancelWirePlacement: () => void;
  setWirePlacementFrom: (pos: BoardPosition) => void;
  setTrayDragComponentId: (id: string | null) => void;
  setHighlightedNetId: (id: string | null) => void;
  toggleSchematicWireDrawMode: () => void;
  setSchematicWireDrawing: (from: { x: number; y: number } | null) => void;
  captureSchematicDragBindings: (componentId: string) => void;
  clearSchematicDragBindings: () => void;

  // Project persistence
  setProjectName: (name: string) => void;
  exportProject: () => Project;
  loadProject: (data: Project) => void;
  resetProject: () => void;

  // Undo/redo
  pushSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface UIState {

  wirePlacementMode: boolean;
  wirePlacementFrom: BoardPosition | null;
  trayDragComponentId: string | null;
  highlightedNetId: string | null;
  schematicWireDrawMode: boolean;
  schematicWireDrawingFrom: { x: number; y: number } | null;
  schematicWireDirection: "horizontal-first" | "vertical-first" | null; // locked on first significant mouse move
  // Captured at drag start: which wire endpoints to move with the dragged component
  _dragWireBindings: { wireId: string; endpoint: "start" | "end" }[] | null;
}

interface HistoryState {
  _history: Project[];
  _redoStack: Project[];
}

type ProjectStore = Project & UIState & ProjectActions & HistoryState;

const initialProject: Project = {
  name: "Untitled Project",
  componentDefs: [...DEFAULT_COMPONENTS],
  components: [],
  nets: [],
  netAssignments: [],
  schematicWires: [],
  board: {
    rows: 20,
    cols: 20,
    cuts: [],
    jumpers: [],
    wires: [],
  },
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
    board: s.board,
  }));
}

function restoreProject(snapshot: Project): Partial<ProjectStore> {
  return {
    name: snapshot.name,
    componentDefs: snapshot.componentDefs,
    components: snapshot.components,
    nets: snapshot.nets,
    netAssignments: snapshot.netAssignments,
    schematicWires: snapshot.schematicWires,
    board: snapshot.board,
  };
}

/**
 * Shared helper: transform a schematic component (rotate, mirror, etc.)
 * and move connected wire endpoints to follow the pin position changes.
 */
function transformSchematicComponent(
  s: ProjectStore,
  id: string,
  getUpdates: (comp: Component) => Partial<Component>,
): Partial<ProjectStore> {
  const comp = s.components.find((c) => c.id === id);
  if (!comp) return s;
  const def = resolveComponentDef(comp, s.componentDefs);
  if (!def) return s;

  const oldRotation = comp.schematicRotation ?? 0;
  const oldMirrored = comp.schematicMirrored ?? false;
  const updates = getUpdates(comp);
  const newRotation = (updates.schematicRotation ?? oldRotation) as 0 | 90 | 180 | 270;
  const newMirrored = updates.schematicMirrored ?? oldMirrored;

  // Compute pin position deltas
  const oldPins = getRotatedPinPositions(def.symbol, oldRotation, oldMirrored);
  const newPins = getRotatedPinPositions(def.symbol, newRotation, newMirrored);
  const pinMoves = new Map<string, { dx: number; dy: number }>();
  for (const oldPin of oldPins) {
    const newPin = newPins.find((p) => p.pinId === oldPin.pinId);
    if (newPin) {
      pinMoves.set(
        pointKey(comp.schematicPos.x + oldPin.x, comp.schematicPos.y + oldPin.y),
        { dx: newPin.x - oldPin.x, dy: newPin.y - oldPin.y },
      );
    }
  }

  const newComponents = s.components.map((c) =>
    c.id === id ? { ...c, ...updates } : c
  );

  const newWires = s.schematicWires.map((w) => {
    const startMove = pinMoves.get(pointKey(w.start.x, w.start.y));
    const endMove = pinMoves.get(pointKey(w.end.x, w.end.y));
    if (!startMove && !endMove) return w;
    return {
      ...w,
      start: startMove ? { x: w.start.x + startMove.dx, y: w.start.y + startMove.dy } : w.start,
      end: endMove ? { x: w.end.x + endMove.dx, y: w.end.y + endMove.dy } : w.end,
    };
  });

  return { components: newComponents, schematicWires: newWires };
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  ...initialProject,

  wirePlacementMode: false,
  wirePlacementFrom: null,
  trayDragComponentId: null,
  highlightedNetId: null,
  schematicWireDrawMode: false,
  schematicWireDrawingFrom: null,
  schematicWireDirection: null,
  _dragWireBindings: null,
  _history: [],
  _redoStack: [],
  canUndo: false,
  canRedo: false,

  addComponentDef: (def) => {
    get().pushSnapshot();
    set((s) => ({ componentDefs: [...s.componentDefs, def] }));
  },

  removeComponentDef: (defId) => {
    get().pushSnapshot();
    set((s) => ({
      componentDefs: s.componentDefs.filter((d) => d.id !== defId),
      // Remove all instances of this component and their net assignments/wires
      components: s.components.filter((c) => c.defId !== defId),
      netAssignments: s.netAssignments.filter((a) =>
        s.components.some((c) => c.defId !== defId && c.id === a.componentId) ||
        !s.components.some((c) => c.id === a.componentId)
      ),
    }));
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
    set((s) => {
      const def = s.componentDefs.find((d) => d.id === defId);
      const prefix = def?.defaultLabelPrefix ?? "X";
      return {
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
      };
    });
  },

  updateLabel: (id, label) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, label } : c
      ),
    }));
  },

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
    }));
    // Recalculate nets — wires are positional so they stay, but pin assignments change
    const s = get();
    const result = recalculateNets(s.schematicWires, s.nets, s.netAssignments, s.components, s.componentDefs);
    set({ nets: result.nets, netAssignments: result.netAssignments });
  },

  // No auto-snapshot: called per-pixel during drag.
  // Moves wire endpoints that were captured at drag start via captureSchematicDragBindings.
  updateSchematicPos: (id, pos) =>
    set((s) => {
      const comp = s.components.find((c) => c.id === id);
      if (!comp) return s;

      const dx = pos.x - comp.schematicPos.x;
      const dy = pos.y - comp.schematicPos.y;

      const newComponents = s.components.map((c) =>
        c.id === id ? { ...c, schematicPos: pos } : c
      );

      // Move wire endpoints using pre-captured bindings
      let newWires = s.schematicWires;
      if (s._dragWireBindings && s._dragWireBindings.length > 0 && (dx !== 0 || dy !== 0)) {
        const bindingSet = new Set(s._dragWireBindings.map((b) => `${b.wireId}:${b.endpoint}`));
        newWires = s.schematicWires.map((w) => {
          const moveStart = bindingSet.has(`${w.id}:start`);
          const moveEnd = bindingSet.has(`${w.id}:end`);
          if (!moveStart && !moveEnd) return w;
          return {
            ...w,
            start: moveStart ? { x: w.start.x + dx, y: w.start.y + dy } : w.start,
            end: moveEnd ? { x: w.end.x + dx, y: w.end.y + dy } : w.end,
          };
        });
      }

      return { components: newComponents, schematicWires: newWires };
    }),

  rotateSchematicComponent: (id) => {
    get().pushSnapshot();
    set((s) => transformSchematicComponent(s, id, (comp) => {
      const newRotation = (((comp.schematicRotation ?? 0) + 90) % 360) as Component["schematicRotation"];
      return { schematicRotation: newRotation };
    }));
  },

  mirrorSchematicComponent: (id) => {
    get().pushSnapshot();
    set((s) => transformSchematicComponent(s, id, (comp) => {
      return { schematicMirrored: !(comp.schematicMirrored ?? false) };
    }));
  },

  placeOnBoard: (id, pos) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) => {
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
      }),
    }));
  },

  moveComponentsOnBoard: (ids, deltaRow, deltaCol, wireIds, cutPositions) =>
    set((s) => {
      const newComponents = s.components.map((c) => {
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
      });

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
          const match = cutPositions.find((cp) => cp.row === c.row && cp.col === c.col);
          if (!match) return c;
          return { row: c.row + deltaRow, col: c.col + deltaCol };
        });
      }

      return {
        components: newComponents,
        board: { ...s.board, wires: newWires, cuts: newCuts },
      };
    }),

  removeFromBoard: (id) => {
    get().pushSnapshot();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, boardPos: null, flexibleEndPos: undefined } : c
      ),
    }));
  },

  // Set pin 2 position for flexible components (no snapshot — called per-pixel during drag)
  setFlexibleEndPos: (id, pos) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, flexibleEndPos: pos } : c
      ),
    })),

  rotateComponent: (id) => {
    const s = get();
    const comp = s.components.find((c) => c.id === id);
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
      // Midpoint
      const midRow = (pin1.row + pin2.row) / 2;
      const midCol = (pin1.col + pin2.col) / 2;
      // Rotate 90° CW around midpoint: (r,c) → (midR + (c-midC), midC - (r-midR))
      const new1Row = Math.round(midRow + (pin1.col - midCol));
      const new1Col = Math.round(midCol - (pin1.row - midRow));
      const new2Row = Math.round(midRow + (pin2.col - midCol));
      const new2Col = Math.round(midCol - (pin2.row - midRow));
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
      components: s2.components.map((c) =>
        c.id === id ? { ...c, rotation: newRotation } : c
      ),
    }));
  },

  // ── Schematic wires ──────────────────────────────────

  addSchematicWire: (start, end) => {
    // Prevent zero-length wires
    if (Math.round(start.x) === Math.round(end.x) && Math.round(start.y) === Math.round(end.y)) return;
    get().pushSnapshot();
    const s = get();
    // Use direction from mouse movement if available, otherwise fallback to distance-based
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const routeDirection = s.schematicWireDirection ?? (dx >= dy ? "horizontal-first" as const : "vertical-first" as const);
    const newWire: SchematicWire = { id: generateId(), start, end, routeDirection };
    const newWires = [...s.schematicWires, newWire];
    const result = recalculateNets(newWires, s.nets, s.netAssignments, s.components, s.componentDefs);
    set({
      schematicWires: newWires,
      nets: result.nets,
      netAssignments: result.netAssignments,
    });
  },

  removeSchematicWire: (id) => {
    get().pushSnapshot();
    const s = get();
    const newWires = s.schematicWires.filter((w) => w.id !== id);
    const result = recalculateNets(newWires, s.nets, s.netAssignments, s.components, s.componentDefs);
    set({
      schematicWires: newWires,
      nets: result.nets,
      netAssignments: result.netAssignments,
    });
  },

  // Split a wire at a grid point into two wires meeting at that point
  splitSchematicWire: (wireId, splitPoint) => {
    get().pushSnapshot();
    const s = get();
    const wire = s.schematicWires.find((w) => w.id === wireId);
    if (!wire) return;

    // Don't split if the split point is at the start or end (would create zero-length wire)
    const atStart = Math.round(wire.start.x) === Math.round(splitPoint.x) && Math.round(wire.start.y) === Math.round(splitPoint.y);
    const atEnd = Math.round(wire.end.x) === Math.round(splitPoint.x) && Math.round(wire.end.y) === Math.round(splitPoint.y);
    if (atStart || atEnd) return; // no split needed

    // Create two new wires: start→splitPoint and splitPoint→end
    const wire1: SchematicWire = {
      id: generateId(),
      start: wire.start,
      end: splitPoint,
      routeDirection: wire.routeDirection,
    };
    const wire2: SchematicWire = {
      id: generateId(),
      start: splitPoint,
      end: wire.end,
      routeDirection: wire.routeDirection,
    };

    const newWires = [
      ...s.schematicWires.filter((w) => w.id !== wireId),
      wire1,
      wire2,
    ];
    const result = recalculateNets(newWires, s.nets, s.netAssignments, s.components, s.componentDefs);
    set({
      schematicWires: newWires,
      nets: result.nets,
      netAssignments: result.netAssignments,
    });
  },

  // ── Nets ─────────────────────────────────────────────

  updateNet: (id, updates) => {
    get().pushSnapshot();
    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    }));
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
    }));
  },

  placeCut: (cut) => {
    get().pushSnapshot();
    set((s) => ({
      board: { ...s.board, cuts: [...s.board.cuts, cut] },
    }));
  },

  removeCut: (cut) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        cuts: s.board.cuts.filter(
          (c) => !(c.row === cut.row && c.col === cut.col)
        ),
      },
    }));
  },


  addWire: (from, to) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        wires: [...s.board.wires, { id: generateId(), from, to }],
      },
      wirePlacementMode: false,
      wirePlacementFrom: null,
    }));
  },

  removeWire: (wireId) => {
    get().pushSnapshot();
    set((s) => ({
      board: {
        ...s.board,
        wires: s.board.wires.filter((w) => w.id !== wireId),
      },
    }));
  },

  // ── UI State ─────────────────────────────────────────



  startWirePlacement: () =>
    set({ wirePlacementMode: true, wirePlacementFrom: null }),

  cancelWirePlacement: () =>
    set({ wirePlacementMode: false, wirePlacementFrom: null }),

  setWirePlacementFrom: (pos) => set({ wirePlacementFrom: pos }),

  setTrayDragComponentId: (id) => set({ trayDragComponentId: id }),
  setHighlightedNetId: (id) => set({ highlightedNetId: id }),
  toggleSchematicWireDrawMode: () => set((s) => ({
    schematicWireDrawMode: !s.schematicWireDrawMode,
    schematicWireDrawingFrom: null,
    schematicWireDirection: null,
  })),
  setSchematicWireDrawing: (from) => set({ schematicWireDrawingFrom: from, schematicWireDirection: null }),

  // Capture which wire endpoints should move with a component during drag.
  // Called once at drag start. Only captures endpoints at this component's pin positions
  // that are NOT also at another component's pin position.
  captureSchematicDragBindings: (componentId) => {
    const s = get();
    const comp = s.components.find((c) => c.id === componentId);
    if (!comp) { set({ _dragWireBindings: null }); return; }

    const def = resolveComponentDef(comp, s.componentDefs);
    if (!def) { set({ _dragWireBindings: null }); return; }

    // This component's pin positions
    const rotation = comp.schematicRotation ?? 0;
    const mirrored = comp.schematicMirrored ?? false;
    const pins = getRotatedPinPositions(def.symbol, rotation, mirrored);
    const myPinKeys = new Set<string>();
    for (const pin of pins) {
      myPinKeys.add(pointKey(comp.schematicPos.x + pin.x, comp.schematicPos.y + pin.y));
    }

    // Other components' pin positions (exclude from moving)
    const otherPinKeys = new Set<string>();
    for (const other of s.components) {
      if (other.id === componentId) continue;
      const otherDef = resolveComponentDef(other, s.componentDefs);
      if (!otherDef) continue;
      const otherRot = other.schematicRotation ?? 0;
      const otherMir = other.schematicMirrored ?? false;
      const otherPins = getRotatedPinPositions(otherDef.symbol, otherRot, otherMir);
      for (const pin of otherPins) {
        otherPinKeys.add(pointKey(other.schematicPos.x + pin.x, other.schematicPos.y + pin.y));
      }
    }

    // Find wire endpoints at this component's pins but not other components' pins
    const bindings: { wireId: string; endpoint: "start" | "end" }[] = [];
    for (const w of s.schematicWires) {
      const startKey = pointKey(w.start.x, w.start.y);
      const endKey = pointKey(w.end.x, w.end.y);
      if (myPinKeys.has(startKey) && !otherPinKeys.has(startKey)) {
        bindings.push({ wireId: w.id, endpoint: "start" });
      }
      if (myPinKeys.has(endKey) && !otherPinKeys.has(endKey)) {
        bindings.push({ wireId: w.id, endpoint: "end" });
      }
    }

    set({ _dragWireBindings: bindings });
  },

  clearSchematicDragBindings: () => set({ _dragWireBindings: null }),

  // ── Project persistence ──────────────────────────────

  setProjectName: (name) => set({ name }),

  exportProject: (): Project => {
    const s = get();
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = s.componentDefs.filter((d) => !defaultIds.has(d.id));
    return {
      name: s.name,
      componentDefs: customDefs,
      components: s.components,
      nets: s.nets,
      netAssignments: s.netAssignments,
      schematicWires: s.schematicWires,
      board: s.board,
    };
  },

  loadProject: (data) => {
    const savedDefs = data.componentDefs ?? [];
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = savedDefs.filter((d) => !defaultIds.has(d.id));
    const mergedDefs = [...DEFAULT_COMPONENTS, ...customDefs];

    // Register custom footprint symbols for custom components
    for (const def of customDefs) {
      if (def.symbol.startsWith("custom-footprint-")) {
        const symbol = createFootprintSymbol(def.pins, def.width, def.height);
        registerCustomSymbol(def.id, { ...symbol, symbolId: def.symbol });
      }
    }

    set({
      name: data.name ?? "Untitled Project",
      componentDefs: mergedDefs,
      components: (data.components ?? []).map((c) => ({
        ...c,
        schematicRotation: c.schematicRotation ?? 0,
      })),
      nets: data.nets ?? [],
      netAssignments: data.netAssignments ?? [],
      schematicWires: data.schematicWires ?? [],
      board: {
        rows: data.board?.rows ?? 20,
        cols: data.board?.cols ?? 20,
        cuts: data.board?.cuts ?? [],
        jumpers: data.board?.jumpers ?? [],
        wires: data.board?.wires ?? [],
      },
      wirePlacementMode: false,
      wirePlacementFrom: null,
      schematicWireDrawMode: false,
      schematicWireDrawingFrom: null,
      schematicWireDirection: null,
    });
  },

  resetProject: () => set({
    name: "Untitled Project",
    componentDefs: [...DEFAULT_COMPONENTS],
    components: [],
    nets: [],
    netAssignments: [],
    schematicWires: [],
    board: { rows: 20, cols: 20, cuts: [], jumpers: [], wires: [] },
    wirePlacementMode: false,
    wirePlacementFrom: null,
    schematicWireDrawMode: false,
    schematicWireDrawingFrom: null,
    schematicWireDirection: null,
    _history: [],
    _redoStack: [],
    canUndo: false,
    canRedo: false,
  }),

  // ── Undo/Redo ────────────────────────────────────────

  pushSnapshot: () => {
    const s = get();
    const snapshot = snapshotProject(s);
    const history = [...s._history, snapshot];
    if (history.length > MAX_HISTORY) history.shift();
    set({ _history: history, _redoStack: [], canUndo: true, canRedo: false });
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
    });
  },
}));
