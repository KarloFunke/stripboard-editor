"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { usePanZoom } from "@/hooks/usePanZoom";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";
import SchematicComponentBlock from "./SchematicComponentBlock";
import SchematicWireLine, { getWirePoints } from "./SchematicWireLine";
import { UnionFind } from "./netInference";
import { getRotatedPinPositions, getSymbolBounds } from "./SymbolRenderer";
import { GRID_SIZE, snapToGrid, pointKey } from "@/utils/schematicConstants";
import { SelectionActionBar, RotateIcon, MirrorIcon, DeleteIcon, ExcludeIcon, type CanvasAction } from "@/components/canvas/SelectionActionBar";
import { track } from "@/lib/track";

const MOVE_STEP = GRID_SIZE;
const PIN_SNAP_RADIUS = 15;



/** Find nearest pin connection point to a given SVG coordinate */
function findNearestPin(
  x: number, y: number,
  components: ReturnType<typeof useProjectStore.getState>["components"],
  componentDefs: ReturnType<typeof useProjectStore.getState>["componentDefs"],
  excludeComponentId?: string,
  excludePinId?: string,
): { componentId: string; pinId: string; x: number; y: number } | null {
  let best: { componentId: string; pinId: string; x: number; y: number; dist: number } | null = null;

  for (const comp of components) {
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;

    const rotation = comp.schematicRotation ?? 0;
    const mirrored = comp.schematicMirrored ?? false;
    const pinPositions = getRotatedPinPositions(def.symbol, rotation, mirrored);

    for (const pin of pinPositions) {
      if (comp.id === excludeComponentId && pin.pinId === excludePinId) continue;

      const px = comp.schematicPos.x + pin.x;
      const py = comp.schematicPos.y + pin.y;
      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);

      if (dist < PIN_SNAP_RADIUS && (!best || dist < best.dist)) {
        best = { componentId: comp.id, pinId: pin.pinId, x: px, y: py, dist };
      }
    }
  }

  return best ? { componentId: best.componentId, pinId: best.pinId, x: best.x, y: best.y } : null;
}

export default function SchematicCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom();
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const schematicWires = useProjectStore((s) => s.schematicWires);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const updateSchematicPos = useProjectStore((s) => s.updateSchematicPos);
  const removeComponent = useProjectStore((s) => s.removeComponent);
  const addComponent = useProjectStore((s) => s.addComponent);
  const addComponentInstance = useProjectStore((s) => s.addComponentInstance);
  const addSchematicWire = useProjectStore((s) => s.addSchematicWire);
  const removeSchematicWire = useProjectStore((s) => s.removeSchematicWire);
  const splitSchematicWire = useProjectStore((s) => s.splitSchematicWire);
  const rotateSchematicComponent = useProjectStore((s) => s.rotateSchematicComponent);
  const mirrorSchematicComponent = useProjectStore((s) => s.mirrorSchematicComponent);
  const setBoardExcluded = useProjectStore((s) => s.setBoardExcluded);
  const wireDrawMode = useProjectStore((s) => s.schematicWireDrawMode);
  const wireDrawingFrom = useProjectStore((s) => s.schematicWireDrawingFrom);
  const wireDirection = useProjectStore((s) => s.schematicWireDirection);
  const setSchematicWireDrawing = useProjectStore((s) => s.setSchematicWireDrawing);
  const toggleWireDrawMode = useProjectStore((s) => s.toggleSchematicWireDrawMode);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const transact = useProjectStore((s) => s.transact);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);
  const captureSchematicDragBindings = useProjectStore((s) => s.captureSchematicDragBindings);
  const clearSchematicDragBindings = useProjectStore((s) => s.clearSchematicDragBindings);

  // A component drag arms this on mousedown and commits exactly one snapshot
  // the first time the position actually changes. A plain select-click never
  // moves anything, so it never snapshots — keeping the redo stack intact and
  // history at one entry per drag. (updateSchematicPos is snapshot-free.)
  const pendingSnapshotRef = useRef(false);
  const commitSnapshotOnce = useCallback(() => {
    if (pendingSnapshotRef.current) {
      pendingSnapshotRef.current = false;
      pushSnapshot();
    }
  }, [pushSnapshot]);

  const [wirePreview, setWirePreview] = useState<{ x: number; y: number } | null>(null);
  // Set to the ids about to be excluded when any of them is still placed on the
  // board — the confirm dialog asks before unplacing them.
  const [excludeConfirmIds, setExcludeConfirmIds] = useState<string[] | null>(null);
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [selectedWireIds, setSelectedWireIds] = useState<string[]>([]);

  // Copy/paste clipboard for a single component. Holds a snapshot of the copied
  // instance (not its id), so paste still works after the source is deleted. The
  // stored position cascades on each paste so repeated pastes don't stack.
  const clipboardRef = useRef<{
    defId: string;
    value?: string;
    schematicRotation: 0 | 90 | 180 | 270;
    schematicMirrored?: boolean;
    labelOffset?: Component["labelOffset"];
    pinLabelOffsets?: Component["pinLabelOffsets"];
    footprintOverride?: Component["footprintOverride"];
    pos: { x: number; y: number };
  } | null>(null);

  // Compute wire colors and net IDs: propagate through connected wire groups
  const { wireColorMap, wireNetIdMap } = useMemo(() => {
    const colorMap = new Map<string, string>(); // wireId → color
    const netIdMap = new Map<string, string>(); // wireId → netId

    // Build point → net info lookup from pin positions
    const pointNetInfo = new Map<string, { color: string; netId: string }>();
    for (const comp of components) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      const rotation = comp.schematicRotation ?? 0;
      const pins = getRotatedPinPositions(def.symbol, rotation, comp.schematicMirrored ?? false);
      for (const pin of pins) {
        const assignment = netAssignments.find(
          (a) => a.componentId === comp.id && a.pinId === pin.pinId
        );
        if (assignment) {
          const net = nets.find((n) => n.id === assignment.netId);
          if (net) {
            const key = pointKey(comp.schematicPos.x + pin.x, comp.schematicPos.y + pin.y);
            pointNetInfo.set(key, { color: net.color, netId: net.id });
          }
        }
      }
    }

    // Union-Find to group connected wire points
    const uf = new UnionFind();
    for (const wire of schematicWires) {
      const pts = getWirePoints(wire);
      const keys = pts.map((p) => pointKey(p.x, p.y));
      for (const k of keys) uf.makeSet(k);
      for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);
    }

    // Find color and netId for each group root
    const rootInfo = new Map<string, { color: string; netId: string }>();
    for (const [pk, info] of pointNetInfo) {
      const root = uf.find(pk);
      if (!rootInfo.has(root)) rootInfo.set(root, info);
    }

    // Assign colors and netIds to wires
    for (const wire of schematicWires) {
      const sk = pointKey(wire.start.x, wire.start.y);
      const root = uf.find(sk);
      const info = rootInfo.get(root);
      if (info) {
        colorMap.set(wire.id, info.color);
        netIdMap.set(wire.id, info.netId);
      }
    }

    return { wireColorMap: colorMap, wireNetIdMap: netIdMap };
  }, [schematicWires, components, componentDefs, nets, netAssignments]);

  // Compute junction points: grid points where 3+ wire endpoints/bends meet
  const junctionPoints = useMemo(() => {
    const pointCount = new Map<string, { x: number; y: number; count: number }>();
    for (const wire of schematicWires) {
      const pts = getWirePoints(wire);
      for (const p of pts) {
        const key = pointKey(p.x, p.y);
        const existing = pointCount.get(key);
        if (existing) {
          existing.count++;
        } else {
          pointCount.set(key, { x: p.x, y: p.y, count: 1 });
        }
      }
    }
    // Only show dots where 3+ wire segments meet (T-junctions, crosses)
    return Array.from(pointCount.values()).filter((p) => p.count >= 3);
  }, [schematicWires]);

  const {
    selectedId, setSelectedId,
    selectedIds, setSelectedIds,
    selectionRect,
    startSelectionRect, updateSelectionRect, finalizeSelectionRect, cancelSelectionRect,
    checkDragThreshold, shouldSuppressClick, markDragComplete,
    clearSelection,
  } = useCanvasSelection();

  const [dragging, setDragging] = useState<{
    componentId: string;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    didDrag: boolean;
    multi: boolean;
  } | null>(null);

  // Multi-drag: dragging a component that's part of a multi-selection moves the
  // whole selection. Holds the move plan + last applied (snapped) anchor position
  // so each mousemove applies only the incremental delta.
  const multiDragRef = useRef<{
    moveIds: string[];
    moveWireIds: string[];
    lastX: number;
    lastY: number;
  } | null>(null);

  // Move a set of components (and any explicitly selected wires) by a delta,
  // dragging connected wire chains along but keeping endpoints anchored to
  // non-moved components fixed. Shared by arrow-key nudging and multi-drag.
  const nudgeSelection = useCallback(
    (moveIds: string[], moveWireIds: string[], delta: { x: number; y: number }) => {
      const moveIdSet = new Set(moveIds);
      const moveWireIdSet = new Set(moveWireIds);
      const s = useProjectStore.getState();

      // Pin positions of moved components (seed the move set)...
      const movedPinPositions = new Set<string>();
      for (const comp of s.components) {
        if (!moveIdSet.has(comp.id)) continue;
        const def = resolveComponentDef(comp, s.componentDefs);
        if (!def) continue;
        const pins = getRotatedPinPositions(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
        for (const pin of pins) {
          movedPinPositions.add(pointKey(comp.schematicPos.x + pin.x, comp.schematicPos.y + pin.y));
        }
      }

      // ...and of non-moved components (anchors that stay put).
      const staticPinPositions = new Set<string>();
      for (const comp of s.components) {
        if (moveIdSet.has(comp.id)) continue;
        const def = resolveComponentDef(comp, s.componentDefs);
        if (!def) continue;
        const pins = getRotatedPinPositions(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
        for (const pin of pins) {
          staticPinPositions.add(pointKey(comp.schematicPos.x + pin.x, comp.schematicPos.y + pin.y));
        }
      }

      // Flood-fill through wire chains from the moved pins + selected wires.
      const pointsToMove = new Set<string>(movedPinPositions);
      for (const w of s.schematicWires) {
        if (moveWireIdSet.has(w.id)) {
          const sk = pointKey(w.start.x, w.start.y);
          const ek = pointKey(w.end.x, w.end.y);
          if (!staticPinPositions.has(sk)) pointsToMove.add(sk);
          if (!staticPinPositions.has(ek)) pointsToMove.add(ek);
        }
      }

      const pointToEndpoints = new Map<string, string[]>();
      for (const w of s.schematicWires) {
        const sk = pointKey(w.start.x, w.start.y);
        const ek = pointKey(w.end.x, w.end.y);
        if (!pointToEndpoints.has(sk)) pointToEndpoints.set(sk, []);
        pointToEndpoints.get(sk)!.push(ek);
        if (!pointToEndpoints.has(ek)) pointToEndpoints.set(ek, []);
        pointToEndpoints.get(ek)!.push(sk);
      }

      let changed = true;
      while (changed) {
        changed = false;
        for (const pt of Array.from(pointsToMove)) {
          const others = pointToEndpoints.get(pt);
          if (!others) continue;
          for (const otherKey of others) {
            if (!pointsToMove.has(otherKey) && !staticPinPositions.has(otherKey)) {
              pointsToMove.add(otherKey);
              changed = true;
            }
          }
        }
      }

      const newComponents = s.components.map((c) =>
        moveIdSet.has(c.id)
          ? { ...c, schematicPos: { x: snapToGrid(c.schematicPos.x + delta.x), y: snapToGrid(c.schematicPos.y + delta.y) } }
          : c
      );

      const newWires = s.schematicWires.map((w) => {
        const moveStart = pointsToMove.has(pointKey(w.start.x, w.start.y));
        const moveEnd = pointsToMove.has(pointKey(w.end.x, w.end.y));
        if (!moveStart && !moveEnd) return w;
        return {
          ...w,
          start: moveStart ? { x: w.start.x + delta.x, y: w.start.y + delta.y } : w.start,
          end: moveEnd ? { x: w.end.x + delta.x, y: w.end.y + delta.y } : w.end,
        };
      });

      useProjectStore.setState({ components: newComponents, schematicWires: newWires });
    },
    []
  );

  // Toggle board-exclusion for a set of components as one undo step. Include
  // when all are already excluded; otherwise exclude the remaining ones (asking
  // first if any of those are still placed on the board).
  const toggleExcludeSelection = useCallback((ids: string[]) => {
    const comps = ids
      .map((id) => useProjectStore.getState().components.find((c) => c.id === id))
      .filter((c): c is Component => !!c);
    if (comps.length === 0) return;

    if (comps.every((c) => c.boardExcluded)) {
      transact(() => comps.forEach((c) => setBoardExcluded(c.id, false)));
      track("component-include", { count: comps.length });
      return;
    }

    const toExclude = comps.filter((c) => !c.boardExcluded);
    if (toExclude.some((c) => c.boardPos)) {
      setExcludeConfirmIds(toExclude.map((c) => c.id));
    } else {
      transact(() => toExclude.forEach((c) => setBoardExcluded(c.id, true)));
      track("component-exclude", { count: toExclude.length });
    }
  }, [transact, setBoardExcluded]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly) return;
      // Both editors are mounted at once; only the last-interacted pane owns
      // the keyboard so one keypress doesn't act on both canvases.
      if (useProjectStore.getState().activeEditor !== "schematic") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Auto-repeat (held key): only arrow-move may repeat (it dedupes its own
      // snapshot below). Every other shortcut is discrete — holding it must not
      // spin the action or flood undo history.
      const isArrowKey = e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (e.repeat && !isArrowKey) return;

      // Ctrl/Cmd+C: copy the selected component
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (selectedId) {
          const comp = components.find((c) => c.id === selectedId);
          if (comp) {
            clipboardRef.current = {
              defId: comp.defId,
              value: comp.value,
              schematicRotation: comp.schematicRotation,
              schematicMirrored: comp.schematicMirrored,
              labelOffset: comp.labelOffset,
              pinLabelOffsets: comp.pinLabelOffsets,
              footprintOverride: comp.footprintOverride,
              pos: comp.schematicPos,
            };
          }
        }
        return;
      }

      // Ctrl/Cmd+V: paste a new instance of the copied component, offset so it
      // doesn't land on top of the source (and cascades on repeated pastes).
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
        const clip = clipboardRef.current;
        if (clip) {
          e.preventDefault();
          const pos = { x: clip.pos.x + MOVE_STEP * 2, y: clip.pos.y + MOVE_STEP * 2 };
          const newId = addComponentInstance({
            defId: clip.defId,
            value: clip.value,
            schematicRotation: clip.schematicRotation,
            schematicMirrored: clip.schematicMirrored,
            labelOffset: clip.labelOffset,
            pinLabelOffsets: clip.pinLabelOffsets,
            footprintOverride: clip.footprintOverride,
            schematicPos: pos,
          });
          clipboardRef.current = { ...clip, pos };
          setSelectedId(newId);
          setSelectedIds([]);
          setSelectedWireId(null);
          setSelectedWireIds([]);
        }
        return;
      }

      // W: toggle wire draw mode
      if (e.key === "w" || e.key === "W") {
        toggleWireDrawMode();
        return;
      }

      // Escape: cancel active wire drawing, clear selection, or exit wire mode (never toggles on)
      if (e.key === "Escape") {
        if (wireDrawingFrom) {
          setSchematicWireDrawing(null);
          setWirePreview(null);
          return;
        }
        if (selectedIds.length > 0 || selectedWireIds.length > 0) {
          setSelectedIds([]);
          setSelectedWireIds([]);
          return;
        }
        if (selectedWireId) {
          setSelectedWireId(null);
          return;
        }
        if (wireDrawMode) {
          toggleWireDrawMode();
          return;
        }
      }

      // R: rotate selected component on schematic
      if (e.key === "r" || e.key === "R") {
        if (selectedId) {
          rotateSchematicComponent(selectedId);
          return;
        }
      }

      // M: mirror selected component on schematic
      if (e.key === "m" || e.key === "M") {
        if (selectedId) {
          mirrorSchematicComponent(selectedId);
          return;
        }
      }

      // E: toggle whether the selected component(s) are excluded from the stripboard
      if (e.key === "e" || e.key === "E") {
        const ids = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
        if (ids.length > 0) {
          toggleExcludeSelection(ids);
          return;
        }
      }

      // Delete: remove all selected components and wires
      if (e.key === "Delete") {
        const hasSelection = selectedId || selectedWireId || selectedIds.length > 0 || selectedWireIds.length > 0;
        if (!hasSelection) return;

        const wireIdsToDelete = [...selectedWireIds];
        if (selectedWireId && !wireIdsToDelete.includes(selectedWireId)) {
          wireIdsToDelete.push(selectedWireId);
        }
        const compIdsToDelete = [...selectedIds];
        if (selectedId && !compIdsToDelete.includes(selectedId)) {
          compIdsToDelete.push(selectedId);
        }

        // One undo step for the whole delete: transact() takes a single
        // snapshot; removeSchematicWire/removeComponent skip their own.
        transact(() => {
          for (const wid of wireIdsToDelete) removeSchematicWire(wid);
          for (const cid of compIdsToDelete) removeComponent(cid);
        });

        setSelectedId(null);
        setSelectedWireId(null);
        setSelectedIds([]);
        setSelectedWireIds([]);
        return;
      }

      // Arrow keys: move selected components and wires atomically
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      const moveWireIds = selectedWireIds;
      if ((moveIds.length > 0 || moveWireIds.length > 0) && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        // One snapshot per held-key gesture: snapshot on the initial press,
        // keep moving on auto-repeat. One Ctrl+Z reverts the whole nudge.
        if (!e.repeat) pushSnapshot();
        const delta = {
          ArrowUp: { x: 0, y: -MOVE_STEP },
          ArrowDown: { x: 0, y: MOVE_STEP },
          ArrowLeft: { x: -MOVE_STEP, y: 0 },
          ArrowRight: { x: MOVE_STEP, y: 0 },
        }[e.key]!;
        nudgeSelection(moveIds, moveWireIds, delta);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, selectedIds, selectedWireId, selectedWireIds, wireDrawingFrom, wireDrawMode, components, schematicWires, updateSchematicPos, removeComponent, removeSchematicWire, rotateSchematicComponent, toggleExcludeSelection, pushSnapshot, transact, setSchematicWireDrawing, toggleWireDrawMode, addComponentInstance, nudgeSelection]);

  const getSVGPoint = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    return panZoom.screenToSvg(e.clientX, e.clientY, svg);
  }, [panZoom.screenToSvg]);

  // Get absolute grid position of a component's pin
  const getPinGridPos = useCallback((componentId: string, pinId: string): { x: number; y: number } | null => {
    const comp = components.find((c) => c.id === componentId);
    if (!comp) return null;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) return null;
    const rotation = comp.schematicRotation ?? 0;
    const pins = getRotatedPinPositions(def.symbol, rotation, comp.schematicMirrored ?? false);
    const pin = pins.find((p) => p.pinId === pinId);
    if (!pin) return null;
    return { x: comp.schematicPos.x + pin.x, y: comp.schematicPos.y + pin.y };
  }, [components, componentDefs]);

  // Pin click handler for wire drawing (only active in wire draw mode)
  const handlePinMouseDown = useCallback((componentId: string, pinId: string, e: React.MouseEvent) => {
    if (readOnly || !wireDrawMode) return;
    e.stopPropagation();
    e.preventDefault();

    const pinPos = getPinGridPos(componentId, pinId);
    if (!pinPos) return;

    if (wireDrawingFrom) {
      // Don't create zero-length wires
      if (Math.round(wireDrawingFrom.x) === Math.round(pinPos.x) &&
          Math.round(wireDrawingFrom.y) === Math.round(pinPos.y)) return;
      // Complete wire — L-shape is auto-routed
      addSchematicWire(wireDrawingFrom, pinPos);
      setSchematicWireDrawing(null);
      setWirePreview(null);
    } else {
      // Start wire drawing from this pin's position
      setSchematicWireDrawing(pinPos);
      setSelectedId(null);
      setSelectedWireId(null);
    }
  }, [wireDrawMode, wireDrawingFrom, getPinGridPos, addSchematicWire, setSchematicWireDrawing, setSelectedId]);

  const handleMouseDown = useCallback(
    (componentId: string, e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return;

      // If wire drawing mode, don't start drag
      if (wireDrawMode) return;

      e.preventDefault();

      const comp = components.find((c) => c.id === componentId);
      if (!comp) return;

      // Dragging a component that's part of a multi-selection moves the whole
      // selection together; otherwise it's a single-component drag.
      const selIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      const isMulti = selIds.length > 1 && selIds.includes(componentId);

      // Defer the snapshot until the drag actually moves something (see
      // commitSnapshotOnce). A plain select-click must not touch history/redo.
      pendingSnapshotRef.current = true;
      if (isMulti) {
        multiDragRef.current = {
          moveIds: selIds,
          moveWireIds: selectedWireIds,
          lastX: comp.schematicPos.x,
          lastY: comp.schematicPos.y,
        };
      } else {
        captureSchematicDragBindings(componentId);
      }
      const pt = getSVGPoint(e);
      setDragging({
        componentId,
        offsetX: pt.x - comp.schematicPos.x,
        offsetY: pt.y - comp.schematicPos.y,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
        multi: isMulti,
      });
      setSelectedWireId(null);
    },
    [components, selectedIds, selectedId, selectedWireIds, getSVGPoint, pushSnapshot, wireDrawMode, wireDrawingFrom, captureSchematicDragBindings]
  );

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return;
      const target = e.target as Element;
      const isBackground = target.tagName === "svg" ||
        target.getAttribute("fill") === "url(#grid)";
      if (!isBackground) return;

      if (wireDrawMode && wireDrawingFrom) {
        // Click on grid = complete wire to this grid point, continue drawing
        const pt = getSVGPoint(e);
        const snapped = { x: snapToGrid(pt.x), y: snapToGrid(pt.y) };
        if (Math.round(wireDrawingFrom.x) !== Math.round(snapped.x) ||
            Math.round(wireDrawingFrom.y) !== Math.round(snapped.y)) {
          addSchematicWire(wireDrawingFrom, snapped);
          setSchematicWireDrawing(snapped);
        }
        return;
      }

      startSelectionRect(getSVGPoint(e));
    },
    [getSVGPoint, startSelectionRect, wireDrawingFrom, addSchematicWire, setSchematicWireDrawing]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panZoom.handlePanMove(e)) return;

      // Wire drawing preview + detect initial direction
      if (wireDrawMode && wireDrawingFrom) {
        const pt = getSVGPoint(e);
        setWirePreview({ x: snapToGrid(pt.x), y: snapToGrid(pt.y) });

        const mdx = Math.abs(pt.x - wireDrawingFrom.x);
        const mdy = Math.abs(pt.y - wireDrawingFrom.y);
        const threshold = GRID_SIZE / 2;

        if (mdx < threshold && mdy < threshold) {
          // Back near start — reset direction so user can re-choose
          if (wireDirection) {
            useProjectStore.setState({ schematicWireDirection: null });
          }
        } else if (!wireDirection) {
          // Lock direction on first significant movement
          useProjectStore.setState({
            schematicWireDirection: mdx >= mdy ? "horizontal-first" : "vertical-first",
          });
        }
        return;
      }

      if (selectionRect) {
        updateSelectionRect(getSVGPoint(e));
      }

      if (!dragging) return;
      if (!dragging.didDrag && checkDragThreshold(e.clientX, e.clientY, dragging)) {
        setDragging({ ...dragging, didDrag: true });
      }
      const pt = getSVGPoint(e);
      const newX = snapToGrid(pt.x - dragging.offsetX);
      const newY = snapToGrid(pt.y - dragging.offsetY);

      // Multi-drag: move the whole selection by the incremental delta since the
      // last grid step, using the same wire-following logic as arrow nudging.
      if (dragging.multi) {
        const plan = multiDragRef.current;
        if (plan && (newX !== plan.lastX || newY !== plan.lastY)) {
          commitSnapshotOnce();
          nudgeSelection(plan.moveIds, plan.moveWireIds, { x: newX - plan.lastX, y: newY - plan.lastY });
          plan.lastX = newX;
          plan.lastY = newY;
        }
        return;
      }

      // Single drag: only mutate (and snapshot) when the snapped position actually
      // changes, so sub-grid jitter from a click never touches history.
      const comp = components.find((c) => c.id === dragging.componentId);
      if (comp && (comp.schematicPos.x !== newX || comp.schematicPos.y !== newY)) {
        commitSnapshotOnce();
        updateSchematicPos(dragging.componentId, { x: newX, y: newY });
      }
    },
    [dragging, selectionRect, getSVGPoint, updateSchematicPos, panZoom.handlePanMove, updateSelectionRect, checkDragThreshold, wireDrawMode, wireDrawingFrom, wireDirection, components, commitSnapshotOnce, nudgeSelection]
  );

  const handleMouseUp = useCallback(() => {
    panZoom.handlePanEnd();
    // Gesture over: disarm a pending snapshot that was never triggered
    // (e.g. a click that selected without moving the component).
    pendingSnapshotRef.current = false;

    const rectHandled = finalizeSelectionRect((x1, y1, x2, y2) => {
      const selected: string[] = [];
      for (const comp of components) {
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        const bounds = getSymbolBounds(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
        const cx = comp.schematicPos.x + bounds.minX;
        const cy = comp.schematicPos.y + bounds.minY;
        if (cx + bounds.width >= x1 && cx <= x2 && cy + bounds.height >= y1 && cy <= y2) {
          selected.push(comp.id);
        }
      }
      // Also select wires with any endpoint inside the rect
      const selWires: string[] = [];
      for (const wire of schematicWires) {
        const startIn = wire.start.x >= x1 && wire.start.x <= x2 && wire.start.y >= y1 && wire.start.y <= y2;
        const endIn = wire.end.x >= x1 && wire.end.x <= x2 && wire.end.y >= y1 && wire.end.y <= y2;
        if (startIn || endIn) selWires.push(wire.id);
      }
      setSelectedWireIds(selWires);
      return selected;
    });
    if (rectHandled) return;

    if (dragging) {
      markDragComplete();
      // A plain click (no drag) toggles single selection. In multi mode we leave
      // the selection intact so a stray click doesn't collapse it.
      if (!dragging.multi && !dragging.didDrag) {
        setSelectedId((prev) =>
          prev === dragging.componentId ? null : dragging.componentId
        );
      }
    }
    setDragging(null);
    multiDragRef.current = null;
    clearSchematicDragBindings();
  }, [dragging, components, componentDefs, finalizeSelectionRect, markDragComplete, setSelectedId, clearSchematicDragBindings]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (shouldSuppressClick()) return;
    if (e.target === svgRef.current || (e.target as Element).tagName === "rect") {
      const isGridRect = (e.target as Element).getAttribute("fill") === "url(#grid)";
      if (e.target === svgRef.current || isGridRect) {
        clearSelection();
        setSelectedWireId(null);
        setSelectedWireIds([]);
      }
    }
  }, [shouldSuppressClick, clearSelection]);

  // Drag-and-drop from component library
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/schematic-component")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (readOnly) return;
    const defId = e.dataTransfer.getData("application/schematic-component");
    if (!defId || !svgRef.current) return;
    e.preventDefault();
    const pos = panZoom.screenToSvg(e.clientX, e.clientY, svgRef.current);
    addComponent(defId, { x: snapToGrid(pos.x), y: snapToGrid(pos.y) });
  }, [addComponent, panZoom.screenToSvg]);

  // Render selected component last
  const sortedComponents = selectedId
    ? [
        ...components.filter((c) => c.id !== selectedId),
        ...components.filter((c) => c.id === selectedId),
      ]
    : components;


  // Wire drawing start position is just the stored grid point
  const wireStartPos = wireDrawingFrom;

  // Container size for viewBox
  const [containerSize, setContainerSize] = useState({ width: 1000, height: 800 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const cursorStyle = panZoom.isPanning.current
    ? "grabbing"
    : wireDrawMode
    ? "crosshair"
    : dragging
    ? "grabbing"
    : "default";

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden relative">
      <svg
        ref={(el) => {
          svgRef.current = el;
          panZoom.setTouchTarget(el);
        }}
        className="font-sans h-full w-full bg-white dark:bg-[#1e1e1e]"
        viewBox={panZoom.getViewBox(containerSize.width, containerSize.height)}
        style={{ cursor: cursorStyle }}
        onMouseDown={(e) => {
          panZoom.handlePanStart(e);
          handleSvgMouseDown(e);
        }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          panZoom.handlePanEnd();
          pendingSnapshotRef.current = false;
          setDragging(null);
          multiDragRef.current = null;
          clearSchematicDragBindings();
          cancelSelectionRect();
        }}
        onWheel={panZoom.handleWheel}
        onContextMenu={panZoom.handleContextMenu}
        onClick={handleCanvasClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Grid dots */}
        <defs>
          <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse" x={-GRID_SIZE / 2} y={-GRID_SIZE / 2}>
            <circle cx={GRID_SIZE / 2} cy={GRID_SIZE / 2} r="1" fill="var(--grid-dot)" />
          </pattern>
        </defs>
        <rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#grid)" />

        {/* Schematic wires */}
        {schematicWires.map((wire) => (
          <SchematicWireLine
            key={wire.id}
            wire={wire}
            color={wireColorMap.get(wire.id)}
            isSelected={selectedWireId === wire.id || selectedWireIds.includes(wire.id)}
            highlighted={!!highlightedNetId && wireNetIdMap.get(wire.id) === highlightedNetId}
            onMouseDown={(e) => {
              if (readOnly) return;
              e.stopPropagation();

              if (!wireDrawMode) {
                // Not in wire mode — just select the wire
                setSelectedWireId(wire.id);
                setSelectedId(null);
                return;
              }

              if (wireDrawingFrom) {
                // Complete current wire drawing at the nearest grid point on this wire
                const pt = getSVGPoint(e);
                const snapped = { x: snapToGrid(pt.x), y: snapToGrid(pt.y) };
                // Split the target wire at this point
                splitSchematicWire(wire.id, snapped);
                // Complete the wire being drawn
                if (Math.round(wireDrawingFrom.x) !== Math.round(snapped.x) ||
                    Math.round(wireDrawingFrom.y) !== Math.round(snapped.y)) {
                  addSchematicWire(wireDrawingFrom, snapped);
                }
                setSchematicWireDrawing(null);
                setWirePreview(null);
                return;
              }

              // In wire mode, not drawing — split wire and start new wire from split point
              const pt = getSVGPoint(e);
              const snapped = { x: snapToGrid(pt.x), y: snapToGrid(pt.y) };
              const atStart = Math.round(wire.start.x) === Math.round(snapped.x) && Math.round(wire.start.y) === Math.round(snapped.y);
              const atEnd = Math.round(wire.end.x) === Math.round(snapped.x) && Math.round(wire.end.y) === Math.round(snapped.y);
              if (atStart || atEnd) {
                setSchematicWireDrawing(snapped);
                setSelectedId(null);
                setSelectedWireId(null);
              } else {
                splitSchematicWire(wire.id, snapped);
                setSchematicWireDrawing(snapped);
                setSelectedId(null);
                setSelectedWireId(null);
              }
            }}
          />
        ))}

        {/* Junction dots — where 3+ wire segments meet */}
        {junctionPoints.map((jp) => {
          const key = pointKey(jp.x, jp.y);
          const wire = schematicWires.find((w) =>
            pointKey(w.start.x, w.start.y) === key || pointKey(w.end.x, w.end.y) === key
          );
          const color = wire ? (wireColorMap.get(wire.id) ?? "var(--junction-dot)") : "var(--junction-dot)";
          return (
            <circle
              key={key}
              cx={jp.x} cy={jp.y} r={2.5}
              fill={color}
              pointerEvents="none"
            />
          );
        })}

        {/* Wire drawing preview — L-shape following mouse direction */}
        {wireStartPos && wirePreview && (() => {
          const sameX = Math.abs(wirePreview.x - wireStartPos.x) < 1;
          const sameY = Math.abs(wirePreview.y - wireStartPos.y) < 1;

          if (sameX || sameY) {
            return (
              <line
                x1={wireStartPos.x} y1={wireStartPos.y}
                x2={wirePreview.x} y2={wirePreview.y}
                stroke="var(--selection-stroke)" strokeWidth={2}
                strokeOpacity={0.4} strokeDasharray="4 3"
                pointerEvents="none"
              />
            );
          }

          // Use locked direction, fallback to distance-based
          const dx = Math.abs(wirePreview.x - wireStartPos.x);
          const dy = Math.abs(wirePreview.y - wireStartPos.y);
          const hFirst = wireDirection === "horizontal-first" || (!wireDirection && dx >= dy);
          const bend = hFirst
            ? { x: wirePreview.x, y: wireStartPos.y }
            : { x: wireStartPos.x, y: wirePreview.y };
          return (
            <>
              <line
                x1={wireStartPos.x} y1={wireStartPos.y}
                x2={bend.x} y2={bend.y}
                stroke="var(--selection-stroke)" strokeWidth={2}
                strokeOpacity={0.4} strokeDasharray="4 3"
                pointerEvents="none"
              />
              <line
                x1={bend.x} y1={bend.y}
                x2={wirePreview.x} y2={wirePreview.y}
                stroke="var(--selection-stroke)" strokeWidth={2}
                strokeOpacity={0.4} strokeDasharray="4 3"
                pointerEvents="none"
              />
            </>
          );
        })()}

        {/* Components */}
        {sortedComponents.map((comp) => (
          <SchematicComponentBlock
            key={comp.id}
            component={comp}
            isSelected={comp.id === selectedId || selectedIds.includes(comp.id)}
            onMouseDown={(e) => handleMouseDown(comp.id, e)}
            onPinMouseDown={handlePinMouseDown}
            getSVGPoint={getSVGPoint}
            readOnly={readOnly}
          />
        ))}

        {/* Selection rectangle */}
        {selectionRect && (
          <rect
            x={Math.min(selectionRect.startX, selectionRect.currentX)}
            y={Math.min(selectionRect.startY, selectionRect.currentY)}
            width={Math.abs(selectionRect.currentX - selectionRect.startX)}
            height={Math.abs(selectionRect.currentY - selectionRect.startY)}
            fill="var(--selection-fill)"
            stroke="var(--selection-stroke)"
            strokeWidth={1}
            strokeDasharray="4 2"
            pointerEvents="none"
          />
        )}

      </svg>

      {/* Selection actions — shown when a single component is selected */}
      {!readOnly && selectedId && (
        <SelectionActionBar
          actions={[
            {
              key: "rotate",
              label: "Rotate",
              title: "Rotate selected component 90°",
              shortcut: "R",
              icon: RotateIcon,
              onClick: () => rotateSchematicComponent(selectedId),
            },
            {
              key: "mirror",
              label: "Mirror",
              title: "Mirror selected component",
              shortcut: "M",
              icon: MirrorIcon,
              onClick: () => mirrorSchematicComponent(selectedId),
            },
            (() => {
              const comp = components.find((c) => c.id === selectedId);
              const excluded = !!comp?.boardExcluded;
              return {
                key: "exclude",
                label: excluded ? "Include" : "Exclude",
                title: excluded
                  ? "Include this component on the stripboard again"
                  : "Exclude this component from the stripboard (off-board part)",
                shortcut: "E",
                icon: ExcludeIcon,
                onClick: () => toggleExcludeSelection([selectedId]),
              };
            })(),
            {
              key: "delete",
              label: "Delete",
              title: "Delete selected component",
              shortcut: "Del",
              icon: DeleteIcon,
              variant: "danger",
              onClick: () => {
                removeComponent(selectedId); // pushes its own undo snapshot
                clearSelection();
              },
            },
          ] satisfies CanvasAction[]}
        />
      )}

      {/* Confirm excluding component(s) currently placed on the board */}
      {excludeConfirmIds && (() => {
        const placed = components.filter((c) => excludeConfirmIds.includes(c.id) && c.boardPos);
        const single = placed.length === 1;
        return (
          <div
            className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
            onClick={() => setExcludeConfirmIds(null)}
          >
            <div
              className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Exclude from Stripboard</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
                {single ? (
                  <>
                    <span className="font-medium">{placed[0].label}</span> is already placed on the stripboard. Excluding it will remove it from the board. Continue?
                  </>
                ) : (
                  <>
                    <span className="font-medium">{placed.length} selected components</span> are already placed on the stripboard. Excluding them will remove them from the board. Continue?
                  </>
                )}
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setExcludeConfirmIds(null)}
                  className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    transact(() => excludeConfirmIds.forEach((id) => setBoardExcluded(id, true)));
                    track("component-exclude", { count: excludeConfirmIds.length });
                    setExcludeConfirmIds(null);
                  }}
                  className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
                >
                  Remove &amp; Exclude
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-white/90 dark:bg-neutral-800/90 border border-neutral-200 dark:border-neutral-700 rounded-md px-1.5 py-1 shadow-sm dark:shadow-neutral-900/30 text-xs text-neutral-600 dark:text-neutral-400">
        <button
          onClick={() => panZoom.resetView()}
          className="px-1.5 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors"
          title="Reset view"
        >
          {Math.round(panZoom.zoom * 100)}%
        </button>
      </div>
    </div>
  );
}
