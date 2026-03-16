import { create } from "zustand";
import {
  Project,
  Component,
  FootprintOverride,
  Net,
  NetAssignment,
  BoardPosition,
  Cut,
  Jumper,
  ComponentDef,
  PinDef,
  BodyCell,
  Wire,
} from "@/types";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";

export const AUTO_NET_ID = "__auto_new__";

function generateId(): string {
  return crypto.randomUUID();
}

const TAG_PREFIXES: Record<string, string> = {
  Resistor: "R",
  Capacitor: "C",
  Diode: "D",
  LED: "D",
  Connector: "J",
  IC: "U",
  Regulator: "U",
  Relay: "K",
  Crystal: "Y",
};

function prefixForTag(tag: string): string {
  if (TAG_PREFIXES[tag]) return TAG_PREFIXES[tag];
  // For custom tags, use first letter uppercase, fallback to X
  const first = tag.charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "X";
}

function nextLabel(components: Component[], tag: string): string {
  const prefix = prefixForTag(tag);
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
  updateComponentDef: (
    defId: string,
    updates: Partial<Pick<ComponentDef, "width" | "height" | "pins" | "bodyCells">>
  ) => void;

  // Components
  addComponent: (defId: string, schematicPos: { x: number; y: number }) => void;
  removeComponent: (id: string) => void;
  updateLabel: (id: string, label: string) => void;
  updateTag: (id: string, tag: string) => void;
  updatePinName: (componentId: string, pinId: string, newName: string) => void;
  updateComponentFootprint: (componentId: string, override: FootprintOverride) => void;
  updateSchematicPos: (id: string, pos: { x: number; y: number }) => void;
  placeOnBoard: (id: string, pos: { row: number; col: number }) => void;
  moveComponentsOnBoard: (ids: string[], deltaRow: number, deltaCol: number) => void;
  removeFromBoard: (id: string) => void;
  rotateComponent: (id: string) => void;

  // Nets
  addNet: (name: string, color: string) => void;
  updateNet: (id: string, updates: Partial<Pick<Net, "name" | "color">>) => void;
  removeNet: (id: string) => void;

  // Net assignments
  assignNet: (netId: string, componentId: string, pinId: string) => void;
  unassignNet: (componentId: string, pinId: string) => void;

  // Board
  placeCut: (cut: Cut) => void;
  removeCut: (cut: Cut) => void;
  addJumper: (from: BoardPosition, to: BoardPosition, netId: string) => void;
  removeJumper: (from: BoardPosition, to: BoardPosition) => void;

  // Wires
  setBoardSize: (rows: number, cols: number) => void;
  addWire: (from: BoardPosition, to: BoardPosition) => void;
  removeWire: (wireId: string) => void;

  // UI state
  setActiveNet: (netId: string | null) => void;
  togglePinNet: (componentId: string, pinId: string) => void;
  setEditingFootprintComponent: (componentId: string | null) => void;
  startWirePlacement: () => void;
  cancelWirePlacement: () => void;
  setWirePlacementFrom: (pos: BoardPosition) => void;
  setShowNetLines: (show: boolean) => void;
  setActiveTag: (tag: string | null) => void;
  addCustomTag: (tag: string) => void;
  removeCustomTag: (tag: string) => void;

  // Project persistence
  setProjectName: (name: string) => void;
  exportProject: () => Project;
  loadProject: (data: Project) => void;
}

interface UIState {
  activeNetId: string | null;
  activeTag: string | null;
  editingFootprintComponentId: string | null;
  wirePlacementMode: boolean;
  wirePlacementFrom: BoardPosition | null;
  showNetLines: boolean;
}

type ProjectStore = Project & UIState & ProjectActions;

const AUTO_NET_COLORS = [
  "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
  "#06b6d4", "#f97316", "#eab308", "#14b8a6",
  "#f43f5e", "#6366f1", "#84cc16", "#a855f7",
];

function randomAutoNetColor(nets: Net[]): string {
  const usedColors = new Set(nets.map((n) => n.color));
  const available = AUTO_NET_COLORS.filter((c) => !usedColors.has(c));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Fallback: random hue
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

function nextNetName(nets: Net[]): string {
  let num = 1;
  while (nets.some((n) => n.name === `net${num}`)) num++;
  return `net${num}`;
}

const initialProject: Project = {
  id: generateId(),
  name: "Untitled Project",
  componentDefs: [...DEFAULT_COMPONENTS],
  components: [],
  nets: [
    { id: generateId(), name: "VCC", color: "#ef4444" },
    { id: generateId(), name: "GND", color: "#171717" },
  ],
  netAssignments: [],
  board: {
    rows: 20,
    cols: 20,
    cuts: [],
    jumpers: [],
    wires: [],
  },
  customTags: [],
};

export const useProjectStore = create<ProjectStore>((set, get) => ({
  ...initialProject,
  activeNetId: null,
  activeTag: null,
  editingFootprintComponentId: null,
  wirePlacementMode: false,
  wirePlacementFrom: null,
  showNetLines: true,

  addComponentDef: (def) =>
    set((s) => ({ componentDefs: [...s.componentDefs, def] })),

  updateComponentDef: (defId, updates) =>
    set((s) => {
      const newDefs = s.componentDefs.map((d) =>
        d.id === defId ? { ...d, ...updates } : d
      );

      // Clean up orphaned net assignments if pins changed
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
    }),

  addComponent: (defId, schematicPos) =>
    set((s) => {
      const tag = s.activeTag ?? "";
      return {
        components: [
          ...s.components,
          {
            id: generateId(),
            defId,
            label: nextLabel(s.components, tag || "X"),
            tag,
            schematicPos,
            boardPos: null,
            rotation: 0,
          },
        ],
      };
    }),

  updateLabel: (id, label) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, label } : c
      ),
    })),

  updateTag: (id, tag) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, tag } : c
      ),
    })),

  updatePinName: (componentId, pinId, newName) =>
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== componentId) return c;
        // If component has a footprint override, update pin name there
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
        // Otherwise, create an override from the base def with the renamed pin
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
    })),

  updateComponentFootprint: (componentId, override) =>
    set((s) => {
      const newComponents = s.components.map((c) =>
        c.id === componentId ? { ...c, footprintOverride: override } : c
      );
      // Clean up orphaned net assignments for this component
      const newPinIds = new Set(override.pins.map((p) => p.id));
      const newAssignments = s.netAssignments.filter(
        (a) => a.componentId !== componentId || newPinIds.has(a.pinId)
      );
      return { components: newComponents, netAssignments: newAssignments };
    }),

  removeComponent: (id) =>
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      netAssignments: s.netAssignments.filter((a) => a.componentId !== id),
    })),

  updateSchematicPos: (id, pos) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, schematicPos: pos } : c
      ),
    })),

  placeOnBoard: (id, pos) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, boardPos: pos } : c
      ),
    })),

  moveComponentsOnBoard: (ids, deltaRow, deltaCol) =>
    set((s) => ({
      components: s.components.map((c) => {
        if (!ids.includes(c.id) || !c.boardPos) return c;
        return {
          ...c,
          boardPos: {
            row: c.boardPos.row + deltaRow,
            col: c.boardPos.col + deltaCol,
          },
        };
      }),
    })),

  removeFromBoard: (id) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, boardPos: null } : c
      ),
    })),

  rotateComponent: (id) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? { ...c, rotation: ((c.rotation + 90) % 360) as Component["rotation"] }
          : c
      ),
    })),

  addNet: (name, color) =>
    set((s) => ({
      nets: [...s.nets, { id: generateId(), name, color }],
    })),

  updateNet: (id, updates) =>
    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),

  removeNet: (id) =>
    set((s) => ({
      nets: s.nets.filter((n) => n.id !== id),
      netAssignments: s.netAssignments.filter((a) => a.netId !== id),
    })),

  assignNet: (netId, componentId, pinId) =>
    set((s) => ({
      netAssignments: [
        ...s.netAssignments.filter(
          (a) => !(a.componentId === componentId && a.pinId === pinId)
        ),
        { netId, componentId, pinId },
      ],
    })),

  unassignNet: (componentId, pinId) =>
    set((s) => ({
      netAssignments: s.netAssignments.filter(
        (a) => !(a.componentId === componentId && a.pinId === pinId)
      ),
    })),

  setBoardSize: (rows, cols) =>
    set((s) => ({
      board: { ...s.board, rows, cols },
    })),

  placeCut: (cut) =>
    set((s) => ({
      board: { ...s.board, cuts: [...s.board.cuts, cut] },
    })),

  removeCut: (cut) =>
    set((s) => ({
      board: {
        ...s.board,
        cuts: s.board.cuts.filter(
          (c) => !(c.row === cut.row && c.col === cut.col)
        ),
      },
    })),

  addJumper: (from, to, netId) =>
    set((s) => ({
      board: {
        ...s.board,
        jumpers: [...s.board.jumpers, { from, to, netId }],
      },
    })),

  removeJumper: (from, to) =>
    set((s) => ({
      board: {
        ...s.board,
        jumpers: s.board.jumpers.filter(
          (j) =>
            !(
              j.from.row === from.row &&
              j.from.col === from.col &&
              j.to.row === to.row &&
              j.to.col === to.col
            )
        ),
      },
    })),

  addWire: (from, to) =>
    set((s) => ({
      board: {
        ...s.board,
        wires: [...s.board.wires, { id: generateId(), from, to }],
      },
      wirePlacementMode: false,
      wirePlacementFrom: null,
    })),

  removeWire: (wireId) =>
    set((s) => ({
      board: {
        ...s.board,
        wires: s.board.wires.filter((w) => w.id !== wireId),
      },
    })),

  setActiveNet: (netId) => set({ activeNetId: netId }),

  togglePinNet: (componentId, pinId) =>
    set((s) => {
      const existing = s.netAssignments.find(
        (a) => a.componentId === componentId && a.pinId === pinId
      );
      const isAutoNet = s.activeNetId === AUTO_NET_ID;

      // Auto New mode: create a new net and assign pin to it
      if (isAutoNet) {
        if (existing) {
          // Already assigned — unassign
          return {
            netAssignments: s.netAssignments.filter(
              (a) => !(a.componentId === componentId && a.pinId === pinId)
            ),
          };
        }
        const newNetId = generateId();
        const name = nextNetName(s.nets);
        const color = randomAutoNetColor(s.nets);
        return {
          nets: [...s.nets, { id: newNetId, name, color }],
          netAssignments: [
            ...s.netAssignments,
            { netId: newNetId, componentId, pinId },
          ],
          activeNetId: newNetId,
        };
      }

      // Normal paint mode: toggle assignment to active net
      if (s.activeNetId) {
        if (existing && existing.netId === s.activeNetId) {
          return {
            netAssignments: s.netAssignments.filter(
              (a) => !(a.componentId === componentId && a.pinId === pinId)
            ),
          };
        }
        return {
          netAssignments: [
            ...s.netAssignments.filter(
              (a) => !(a.componentId === componentId && a.pinId === pinId)
            ),
            { netId: s.activeNetId, componentId, pinId },
          ],
        };
      }

      return s;
    }),

  setEditingFootprintComponent: (componentId) => set({ editingFootprintComponentId: componentId }),

  startWirePlacement: () =>
    set({ wirePlacementMode: true, wirePlacementFrom: null }),

  cancelWirePlacement: () =>
    set({ wirePlacementMode: false, wirePlacementFrom: null }),

  setWirePlacementFrom: (pos) => set({ wirePlacementFrom: pos }),

  setShowNetLines: (show) => set({ showNetLines: show }),
  setActiveTag: (tag) => set({ activeTag: tag }),

  addCustomTag: (tag) =>
    set((s) => {
      if (s.customTags.includes(tag)) return s;
      return { customTags: [...s.customTags, tag].sort() };
    }),

  removeCustomTag: (tag) =>
    set((s) => ({
      customTags: s.customTags.filter((t) => t !== tag),
      activeTag: s.activeTag === tag ? null : s.activeTag,
    })),

  setProjectName: (name) => set({ name }),

  exportProject: (): Project => {
    const s = get();
    return {
      id: s.id,
      name: s.name,
      componentDefs: s.componentDefs,
      components: s.components,
      nets: s.nets,
      netAssignments: s.netAssignments,
      board: s.board,
      customTags: s.customTags,
    };
  },

  loadProject: (data) =>
    set({
      id: data.id ?? generateId(),
      name: data.name ?? "Untitled Project",
      componentDefs: data.componentDefs ?? [...DEFAULT_COMPONENTS],
      components: data.components ?? [],
      nets: data.nets ?? [],
      netAssignments: data.netAssignments ?? [],
      board: {
        rows: data.board?.rows ?? 20,
        cols: data.board?.cols ?? 20,
        cuts: data.board?.cuts ?? [],
        jumpers: data.board?.jumpers ?? [],
        wires: data.board?.wires ?? [],
      },
      customTags: data.customTags ?? [],
      activeNetId: null,
      activeTag: null,
      editingFootprintComponentId: null,
      wirePlacementMode: false,
      wirePlacementFrom: null,
    }),
}));
