"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useLibraryStore } from "@/store/useLibraryStore";
import { Component, NetLabel, NetLabelKind, SchematicWire } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { usePanZoom } from "@/hooks/usePanZoom";
import SchematicComponentBlock from "./SchematicComponentBlock";
import SchematicWireLine from "./SchematicWireLine";
import SchematicNetLabel, { netLabelBounds } from "./SchematicNetLabel";
import { UnionFind } from "./netInference";
import { getSymbolBounds } from "./SymbolRenderer";
import { pointInRect, schematicPinPoints, wireInRect } from "./schematicGeometry";
import { GRID_SIZE, snapToGrid, pointKey } from "@/utils/schematicConstants";
import { SelectionActionBar, RotateIcon, MirrorIcon, DeleteIcon, ExcludeIcon, OffBoardIcon, type CanvasAction } from "@/components/canvas/SelectionActionBar";
import { TOOL_STRIP_HOME } from "@/components/canvas/ToolStrip";
import SchematicTools from "./SchematicTools";
import { track } from "@/lib/track";

const MOVE_STEP = GRID_SIZE;
const DRAG_THRESHOLD = 4; // client pixels before a mousedown becomes a drag
const MIN_RECT_SIZE = 10;

interface Selection {
  components: string[];
  wires: string[];
  labels: string[];
}
const EMPTY_SEL: Selection = { components: [], wires: [], labels: [] };
type SelKind = keyof Selection;
type SelMode = "replace" | "add" | "toggle";

function selSize(s: Selection) {
  return s.components.length + s.wires.length + s.labels.length;
}
function selHas(s: Selection, kind: SelKind, id: string) {
  return s[kind].includes(id);
}
function selWith(s: Selection, kind: SelKind, id: string, mode: SelMode): Selection {
  if (mode === "replace") return { ...EMPTY_SEL, [kind]: [id] };
  const has = s[kind].includes(id);
  if (mode === "add") return has ? s : { ...s, [kind]: [...s[kind], id] };
  return { ...s, [kind]: has ? s[kind].filter((x) => x !== id) : [...s[kind], id] };
}
function selUnion(a: Selection, b: Selection): Selection {
  return {
    components: [...new Set([...a.components, ...b.components])],
    wires: [...new Set([...a.wires, ...b.wires])],
    labels: [...new Set([...a.labels, ...b.labels])],
  };
}
function selEqual(a: Selection, b: Selection) {
  return a.components.join() === b.components.join() && a.wires.join() === b.wires.join() && a.labels.join() === b.labels.join();
}

/**
 * All segments reachable from `startId` without crossing a component pin.
 * Treating pins as nodes and segments as edges, this is the connected set of
 * segments bounded only by pin nodes: wire-to-wire junctions are crossed
 * freely, a pin an endpoint lands on is a wall. `pinNodeKeys` holds the
 * pointKey() of every component pin.
 */
function collectWholeWire(
  startId: string,
  wires: SchematicWire[],
  pinNodeKeys: Set<string>
): string[] {
  // Index segments by their two endpoints (start/end only, not bends).
  const byEndpoint = new Map<string, string[]>();
  for (const w of wires) {
    for (const p of [w.start, w.end]) {
      const k = pointKey(p.x, p.y);
      const arr = byEndpoint.get(k);
      if (arr) arr.push(w.id);
      else byEndpoint.set(k, [w.id]);
    }
  }
  const wireById = new Map(wires.map((w) => [w.id, w]));
  const found = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const w = wireById.get(queue.pop()!);
    if (!w) continue;
    for (const p of [w.start, w.end]) {
      const k = pointKey(p.x, p.y);
      if (pinNodeKeys.has(k)) continue; // pin node: a wall, don't cross it
      for (const otherId of byEndpoint.get(k) ?? []) {
        if (!found.has(otherId)) {
          found.add(otherId);
          queue.push(otherId);
        }
      }
    }
  }
  return [...found];
}

function selModeFromEvent(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelMode {
  if (e.ctrlKey || e.metaKey) return "toggle";
  if (e.shiftKey) return "add";
  return "replace";
}

interface Clipboard {
  components: Omit<Component, "id" | "label" | "boardPos" | "rotation" | "flexibleEndPos" | "locked">[];
  wires: Omit<SchematicWire, "id">[];
  labels: Omit<NetLabel, "id">[];
  origin: { x: number; y: number }; // reference point the copy is positioned by
  lastPaste: { x: number; y: number } | null; // cascades keyboard pastes off-canvas
}

export default function SchematicCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom(1, readOnly ? undefined : TOOL_STRIP_HOME);
  const { screenToSvg, handlePanMove, handlePanEnd } = panZoom;
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const schematicWires = useProjectStore((s) => s.schematicWires);
  const netLabels = useProjectStore((s) => s.netLabels);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const removeComponent = useProjectStore((s) => s.removeComponent);
  const addComponent = useProjectStore((s) => s.addComponent);
  const addLibraryComponent = useProjectStore((s) => s.addLibraryComponent);
  const addSchematicWire = useProjectStore((s) => s.addSchematicWire);
  const removeSchematicWire = useProjectStore((s) => s.removeSchematicWire);
  const rotateSchematicComponent = useProjectStore((s) => s.rotateSchematicComponent);
  const mirrorSchematicComponent = useProjectStore((s) => s.mirrorSchematicComponent);
  const setBoardExcluded = useProjectStore((s) => s.setBoardExcluded);
  const setOffBoard = useProjectStore((s) => s.setOffBoard);
  const addNetLabel = useProjectStore((s) => s.addNetLabel);
  const updateNetLabel = useProjectStore((s) => s.updateNetLabel);
  const removeNetLabels = useProjectStore((s) => s.removeNetLabels);
  const beginSchematicMove = useProjectStore((s) => s.beginSchematicMove);
  const moveSchematicItems = useProjectStore((s) => s.moveSchematicItems);
  const finishSchematicGesture = useProjectStore((s) => s.finishSchematicGesture);
  const cancelSchematicGesture = useProjectStore((s) => s.cancelSchematicGesture);
  const transformSchematicSelection = useProjectStore((s) => s.transformSchematicSelection);
  const pasteSchematicItems = useProjectStore((s) => s.pasteSchematicItems);
  const wireDrawMode = useProjectStore((s) => s.schematicWireDrawMode);
  const wireDrawingFrom = useProjectStore((s) => s.schematicWireDrawingFrom);
  const wireDirection = useProjectStore((s) => s.schematicWireDirection);
  const setSchematicWireDrawing = useProjectStore((s) => s.setSchematicWireDrawing);
  const toggleWireDrawMode = useProjectStore((s) => s.toggleSchematicWireDrawMode);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const transact = useProjectStore((s) => s.transact);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);

  // The wire tool is active either in wire mode or while a wire started from
  // a pin in select mode is being drawn.
  const drawing = !!wireDrawingFrom;
  const wireTool = wireDrawMode || drawing;

  const [selection, setSelection] = useState<Selection>(EMPTY_SEL);
  const [wirePreview, setWirePreview] = useState<{ x: number; y: number } | null>(null);
  const wirePreviewRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { wirePreviewRef.current = wirePreview; }, [wirePreview]);
  const [hoverNetId, setHoverNetId] = useState<string | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  // Set to the ids about to be excluded when any of them is still placed on the
  // board — the confirm dialog asks before unplacing them.
  const [excludeConfirmIds, setExcludeConfirmIds] = useState<string[] | null>(null);

  const [selectionRect, setSelectionRect] = useState<{
    startX: number; startY: number; currentX: number; currentY: number; mode: SelMode;
  } | null>(null);

  // A drag of the selection: armed on mousedown, moves the selection by grid
  // steps once the threshold is crossed, settles connectivity on mouseup.
  const dragRef = useRef<{
    startClientX: number; startClientY: number;
    offsetX: number; offsetY: number; // svg offset from the grabbed point to the grid anchor
    lastX: number; lastY: number;
    didMove: boolean;
    sel: Selection;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Arrow-key nudging: one gesture per run of presses. Bindings and the undo
  // snapshot are taken on the first press; the run ends (and connectivity
  // settles) on any other key, a mouse press, a selection change or blur.
  const arrowSessionRef = useRef(false);
  const endArrowSession = useCallback(() => {
    if (!arrowSessionRef.current) return;
    arrowSessionRef.current = false;
    finishSchematicGesture();
  }, [finishSchematicGesture]);

  // The wire run being drawn: ids of the segments placed so far (Backspace
  // steps back through them) and whether the run started from select mode
  // (then finishing returns to select mode).
  const wireRunRef = useRef<{ ids: string[]; fromSelectMode: boolean }>({ ids: [], fromSelectMode: false });

  const clipboardRef = useRef<Clipboard | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  const mouseInsideRef = useRef(false);

  const applySelection = useCallback((next: Selection) => {
    setSelection((prev) => (selEqual(prev, next) ? prev : next));
  }, []);

  // Selection changes end an arrow run; ids that vanished (deleted, or wires
  // split while settling) drop out.
  useEffect(() => { endArrowSession(); }, [selection, endArrowSession]);
  useEffect(() => {
    const comps = new Set(components.map((c) => c.id));
    const wires = new Set(schematicWires.map((w) => w.id));
    const labels = new Set(netLabels.map((l) => l.id));
    setSelection((prev) => {
      const next = {
        components: prev.components.filter((id) => comps.has(id)),
        wires: prev.wires.filter((id) => wires.has(id)),
        labels: prev.labels.filter((id) => labels.has(id)),
      };
      return selEqual(prev, next) ? prev : next;
    });
  }, [components, schematicWires, netLabels]);
  useEffect(() => {
    const onBlur = () => endArrowSession();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [endArrowSession]);

  const singleComponentId = selSize(selection) === 1 && selection.components.length === 1 ? selection.components[0] : null;
  const singleWireId = selSize(selection) === 1 && selection.wires.length === 1 ? selection.wires[0] : null;
  const singleLabelId = selSize(selection) === 1 && selection.labels.length === 1 ? selection.labels[0] : null;

  // ── Derived connectivity for rendering ─────────────────

  const pinPoints = useMemo(() => schematicPinPoints(components, componentDefs), [components, componentDefs]);

  // pointKey() of every component pin — the walls that bound a "whole wire".
  const pinNodeKeys = useMemo(() => new Set(pinPoints.map((p) => p.key)), [pinPoints]);

  // Net of every wire and label, by joining wire endpoints and reading the
  // net off any pin in the group.
  const { wireColorMap, wireNetIdMap, labelNetMap } = useMemo(() => {
    const colorMap = new Map<string, string>();
    const netIdMap = new Map<string, string>();
    const labelMap = new Map<string, { color: string; netId: string }>();

    const netById = new Map(nets.map((n) => [n.id, n]));
    const assignmentByPin = new Map(netAssignments.map((a) => [`${a.componentId}:${a.pinId}`, a.netId]));
    const pointNetInfo = new Map<string, { color: string; netId: string }>();
    for (const p of pinPoints) {
      const netId = assignmentByPin.get(`${p.componentId}:${p.pinId}`);
      const net = netId ? netById.get(netId) : undefined;
      if (net) pointNetInfo.set(p.key, { color: net.color, netId: net.id });
    }

    const uf = new UnionFind();
    for (const wire of schematicWires) {
      const a = pointKey(wire.start.x, wire.start.y);
      const b = pointKey(wire.end.x, wire.end.y);
      uf.makeSet(a); uf.makeSet(b); uf.union(a, b);
    }
    const byName = new Map<string, string[]>();
    for (const l of netLabels) {
      const k = pointKey(l.pos.x, l.pos.y);
      uf.makeSet(k);
      const arr = byName.get(l.name);
      if (arr) arr.push(k); else byName.set(l.name, [k]);
    }
    for (const keys of byName.values()) for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);

    const rootInfo = new Map<string, { color: string; netId: string }>();
    for (const [pk, info] of pointNetInfo) {
      const root = uf.find(pk);
      if (!rootInfo.has(root)) rootInfo.set(root, info);
    }

    for (const wire of schematicWires) {
      const info = rootInfo.get(uf.find(pointKey(wire.start.x, wire.start.y)));
      if (info) {
        colorMap.set(wire.id, info.color);
        netIdMap.set(wire.id, info.netId);
      }
    }
    for (const l of netLabels) {
      const info = rootInfo.get(uf.find(pointKey(l.pos.x, l.pos.y)));
      if (info) labelMap.set(l.id, info);
    }
    return { wireColorMap: colorMap, wireNetIdMap: netIdMap, labelNetMap: labelMap };
  }, [schematicWires, netLabels, pinPoints, nets, netAssignments]);

  // Junction dots where three or more things meet at a point; hollow
  // squares on wire ends that touch nothing.
  const { junctionPoints, danglingEnds } = useMemo(() => {
    const count = new Map<string, { x: number; y: number; n: number; wireId: string | null }>();
    const bump = (x: number, y: number, wireId: string | null) => {
      const k = pointKey(x, y);
      const e = count.get(k);
      if (e) { e.n++; if (!e.wireId) e.wireId = wireId; }
      else count.set(k, { x, y, n: 1, wireId });
    };
    for (const w of schematicWires) { bump(w.start.x, w.start.y, w.id); bump(w.end.x, w.end.y, w.id); }
    for (const p of pinPoints) bump(p.x, p.y, null);
    for (const l of netLabels) bump(l.pos.x, l.pos.y, null);
    const junctions: { x: number; y: number; wireId: string | null }[] = [];
    const dangling: { x: number; y: number; wireId: string }[] = [];
    for (const e of count.values()) {
      if (e.n >= 3) junctions.push(e);
      else if (e.n === 1 && e.wireId) dangling.push({ x: e.x, y: e.y, wireId: e.wireId });
    }
    return { junctionPoints: junctions, danglingEnds: dangling };
  }, [schematicWires, pinPoints, netLabels]);

  const activeNetId = highlightedNetId ?? hoverNetId;

  // ── Coordinates ───────────────────────────────────────

  const getSVGPoint = useCallback((e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    return screenToSvg(e.clientX, e.clientY, svg);
  }, [screenToSvg]);

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

  /** Where keyboard-placed things land: under the cursor, else mid-view */
  const cursorOrCenter = useCallback(() => {
    const p = mouseInsideRef.current && lastMouseRef.current
      ? lastMouseRef.current
      : { x: panZoom.panX + containerSize.width / 2 / panZoom.zoom, y: panZoom.panY + containerSize.height / 2 / panZoom.zoom };
    return { x: snapToGrid(p.x), y: snapToGrid(p.y) };
  }, [panZoom.panX, panZoom.panY, panZoom.zoom, containerSize]);

  const getPinGridPos = useCallback((componentId: string, pinId: string): { x: number; y: number } | null => {
    const p = pinPoints.find((pp) => pp.componentId === componentId && pp.pinId === pinId);
    return p ? { x: p.x, y: p.y } : null;
  }, [pinPoints]);

  // ── Wire drawing ──────────────────────────────────────

  const startDrawing = useCallback((pt: { x: number; y: number }, fromSelectMode: boolean) => {
    wireRunRef.current = { ids: [], fromSelectMode };
    setSchematicWireDrawing(pt);
    applySelection(EMPTY_SEL);
  }, [setSchematicWireDrawing, applySelection]);

  // Ending the run settles the schematic, which is where the segments just
  // drawn get joined back together (no merging happens mid-run, so Backspace
  // still steps back one segment at a time).
  const endDrawing = useCallback(() => {
    wireRunRef.current = { ids: [], fromSelectMode: false };
    setSchematicWireDrawing(null);
    setWirePreview(null);
    finishSchematicGesture();
  }, [setSchematicWireDrawing, finishSchematicGesture]);

  const placeSegment = useCallback((to: { x: number; y: number }) => {
    const from = useProjectStore.getState().schematicWireDrawingFrom;
    if (!from) return false;
    if (Math.round(from.x) === Math.round(to.x) && Math.round(from.y) === Math.round(to.y)) return false;
    wireRunRef.current.ids.push(...addSchematicWire(from, to));
    setSchematicWireDrawing(to);
    return true;
  }, [addSchematicWire, setSchematicWireDrawing]);

  const finishAt = useCallback((to: { x: number; y: number }) => {
    placeSegment(to);
    endDrawing();
  }, [placeSegment, endDrawing]);

  const stepBack = useCallback(() => {
    const run = wireRunRef.current;
    const lastId = run.ids.pop();
    if (!lastId) { endDrawing(); return; }
    const w = useProjectStore.getState().schematicWires.find((x) => x.id === lastId);
    if (w) {
      removeSchematicWire(lastId);
      setSchematicWireDrawing(w.start);
    } else {
      endDrawing();
    }
  }, [removeSchematicWire, setSchematicWireDrawing, endDrawing]);

  // ── Copy / paste ──────────────────────────────────────

  const copySelection = useCallback(() => {
    const s = useProjectStore.getState();
    const compSet = new Set(selection.components);
    const labelSet = new Set(selection.labels);
    const comps = s.components.filter((c) => compSet.has(c.id));
    const labels = s.netLabels.filter((l) => labelSet.has(l.id));
    if (comps.length === 0 && labels.length === 0 && selection.wires.length === 0) return;

    // Wires between copied parts come along even when not selected themselves
    const ownKeys = new Set<string>();
    for (const p of pinPoints) if (compSet.has(p.componentId)) ownKeys.add(p.key);
    for (const l of labels) ownKeys.add(pointKey(l.pos.x, l.pos.y));
    const wireSet = new Set(selection.wires);
    const wires = s.schematicWires.filter((w) =>
      wireSet.has(w.id) || (ownKeys.has(pointKey(w.start.x, w.start.y)) && ownKeys.has(pointKey(w.end.x, w.end.y)))
    );

    const pts = [
      ...comps.map((c) => c.schematicPos),
      ...labels.map((l) => l.pos),
      ...wires.flatMap((w) => [w.start, w.end]),
    ];
    const origin = {
      x: snapToGrid(Math.min(...pts.map((p) => p.x))),
      y: snapToGrid(Math.min(...pts.map((p) => p.y))),
    };
    clipboardRef.current = {
      components: comps.map((c) => ({
        defId: c.defId, value: c.value,
        schematicPos: c.schematicPos, schematicRotation: c.schematicRotation, schematicMirrored: c.schematicMirrored,
        labelOffset: c.labelOffset, pinLabelOffsets: c.pinLabelOffsets, footprintOverride: c.footprintOverride, package: c.package,
        boardLabelOffset: c.boardLabelOffset, boardExcluded: c.boardExcluded,
      })),
      wires: wires.map((w) => ({ start: w.start, end: w.end })),
      labels: labels.map((l) => ({ kind: l.kind, name: l.name, pos: l.pos, rotation: l.rotation })),
      origin,
      lastPaste: null,
    };
  }, [selection, pinPoints]);

  const pasteClipboard = useCallback((delta: { x: number; y: number }) => {
    const clip = clipboardRef.current;
    if (!clip) return;
    const sh = (p: { x: number; y: number }) => ({ x: p.x + delta.x, y: p.y + delta.y });
    const ids = pasteSchematicItems({
      components: clip.components.map((c) => ({ ...c, schematicPos: sh(c.schematicPos) })),
      wires: clip.wires.map((w) => ({ ...w, start: sh(w.start), end: sh(w.end) })),
      labels: clip.labels.map((l) => ({ ...l, pos: sh(l.pos) })),
    });
    applySelection({ components: ids.componentIds, wires: ids.wireIds, labels: ids.labelIds });
  }, [pasteSchematicItems, applySelection]);

  // ── Selection actions ─────────────────────────────────

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

  const rotateSelection = useCallback((op: "rotate" | "mirror") => {
    if (selSize(selection) === 0) return;
    if (singleComponentId) {
      if (op === "rotate") rotateSchematicComponent(singleComponentId);
      else mirrorSchematicComponent(singleComponentId);
      return;
    }
    if (singleLabelId && op === "rotate") {
      const l = netLabels.find((x) => x.id === singleLabelId);
      if (l) updateNetLabel(l.id, { rotation: ((l.rotation + 90) % 360) as NetLabel["rotation"] });
      return;
    }
    transformSchematicSelection(selection.components, selection.wires, selection.labels, op);
  }, [selection, singleComponentId, singleLabelId, netLabels, rotateSchematicComponent, mirrorSchematicComponent, updateNetLabel, transformSchematicSelection]);

  const deleteSelection = useCallback((wholeWires: boolean) => {
    if (selSize(selection) === 0) return;
    let wireIds = [...selection.wires];
    if (wholeWires && wireIds.length > 0) {
      const expanded = new Set<string>();
      for (const wid of wireIds) for (const id of collectWholeWire(wid, schematicWires, pinNodeKeys)) expanded.add(id);
      wireIds = [...expanded];
    }
    // One undo step for the whole delete: transact() takes a single
    // snapshot; the individual removals skip their own.
    transact(() => {
      for (const wid of wireIds) removeSchematicWire(wid);
      for (const cid of selection.components) removeComponent(cid);
      if (selection.labels.length > 0) removeNetLabels(selection.labels);
    });
    applySelection(EMPTY_SEL);
  }, [selection, schematicWires, pinNodeKeys, transact, removeSchematicWire, removeComponent, removeNetLabels, applySelection]);

  const placeLabel = useCallback((kind: NetLabelKind, pos: { x: number; y: number }, name?: string) => {
    const id = addNetLabel(kind, pos, name);
    applySelection({ ...EMPTY_SEL, labels: [id] });
    if (kind !== "gnd" && !name) setEditingLabelId(id);
  }, [addNetLabel, applySelection]);

  // ── Keyboard ──────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly) return;
      // Both editors are mounted at once; only the last-interacted pane owns
      // the keyboard so one keypress doesn't act on both canvases.
      if (useProjectStore.getState().activeEditor !== "schematic") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const isArrowKey = e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (!isArrowKey) endArrowSession();
      // Auto-repeat (held key): only arrow-move may repeat. Every other
      // shortcut is discrete — holding it must not spin the action or flood
      // undo history.
      if (e.repeat && !isArrowKey) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && key === "a") {
        e.preventDefault();
        applySelection({
          components: components.map((c) => c.id),
          wires: schematicWires.map((w) => w.id),
          labels: netLabels.map((l) => l.id),
        });
        return;
      }
      if (mod && key === "c") {
        copySelection();
        return;
      }
      if (mod && key === "v") {
        const clip = clipboardRef.current;
        if (!clip) return;
        e.preventDefault();
        let target: { x: number; y: number };
        if (mouseInsideRef.current && lastMouseRef.current) {
          target = { x: snapToGrid(lastMouseRef.current.x), y: snapToGrid(lastMouseRef.current.y) };
        } else {
          const last = clip.lastPaste ?? clip.origin;
          target = { x: last.x + MOVE_STEP * 2, y: last.y + MOVE_STEP * 2 };
        }
        clip.lastPaste = target;
        pasteClipboard({ x: target.x - clip.origin.x, y: target.y - clip.origin.y });
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        copySelection();
        pasteClipboard({ x: MOVE_STEP * 2, y: MOVE_STEP * 2 });
        return;
      }
      if (mod) return; // leave Ctrl+Z / Ctrl+S and friends to their owners

      // W: toggle wire draw mode
      if (key === "w") {
        if (drawing) endDrawing();
        toggleWireDrawMode();
        return;
      }

      // Escape: cancel the pending segment, then clear selection, then leave wire mode
      if (key === "Escape") {
        if (drawing) { endDrawing(); return; }
        if (selSize(selection) > 0) { applySelection(EMPTY_SEL); return; }
        if (wireDrawMode) { toggleWireDrawMode(); return; }
        return;
      }

      if (drawing) {
        if (key === "Enter") {
          e.preventDefault();
          if (wirePreviewRef.current) placeSegment(wirePreviewRef.current);
          endDrawing();
          return;
        }
        if (key === "Backspace") {
          e.preventDefault();
          stepBack();
          return;
        }
        return;
      }

      if (key === "r") { rotateSelection("rotate"); return; }
      if (key === "m") { rotateSelection("mirror"); return; }

      // E: toggle whether the selected component(s) are excluded from the stripboard
      if (key === "e") {
        if (selection.components.length > 0) toggleExcludeSelection(selection.components);
        return;
      }

      // G / P / L: drop a ground, power or net label at the cursor
      if (key === "g" || key === "p" || key === "l") {
        placeLabel(key === "g" ? "gnd" : key === "p" ? "power" : "label", cursorOrCenter());
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        if (selSize(selection) === 0) return;
        e.preventDefault();
        deleteSelection(e.altKey);
        return;
      }

      // Arrow keys: nudge the selection one grid step (Shift: five)
      if (isArrowKey && selSize(selection) > 0) {
        e.preventDefault();
        if (!arrowSessionRef.current) {
          arrowSessionRef.current = true;
          pushSnapshot();
          beginSchematicMove(selection.components, selection.wires, selection.labels);
        }
        const step = e.shiftKey ? MOVE_STEP * 5 : MOVE_STEP;
        const delta = {
          ArrowUp: { x: 0, y: -step },
          ArrowDown: { x: 0, y: step },
          ArrowLeft: { x: -step, y: 0 },
          ArrowRight: { x: step, y: 0 },
        }[e.key]!;
        moveSchematicItems(delta);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [readOnly, selection, components, schematicWires, netLabels, drawing, wireDrawMode, endArrowSession, applySelection, copySelection, pasteClipboard, endDrawing, toggleWireDrawMode, placeSegment, stepBack, rotateSelection, toggleExcludeSelection, placeLabel, cursorOrCenter, deleteSelection, pushSnapshot, beginSchematicMove, moveSchematicItems]);

  // ── Mouse ─────────────────────────────────────────────

  /** Mousedown on a component body, a wire or a label in select mode */
  const handleItemMouseDown = useCallback((kind: SelKind, id: string, e: React.MouseEvent) => {
    if (readOnly || e.button === 2) return;
    if (wireTool) return;
    e.preventDefault();
    e.stopPropagation();
    endArrowSession();
    setEditingLabelId(null);

    const mode = selModeFromEvent(e);
    if (mode === "toggle") {
      applySelection(selWith(selection, kind, id, "toggle"));
      return;
    }
    const next = mode === "add" || selHas(selection, kind, id) ? selWith(selection, kind, id, "add") : selWith(selection, kind, id, "replace");
    applySelection(next);

    beginSchematicMove(next.components, next.wires, next.labels);
    const pt = getSVGPoint(e);
    const ax = snapToGrid(pt.x), ay = snapToGrid(pt.y);
    dragRef.current = {
      startClientX: e.clientX, startClientY: e.clientY,
      offsetX: pt.x - ax, offsetY: pt.y - ay,
      lastX: ax, lastY: ay,
      didMove: false,
      sel: next,
    };
    setIsDragging(true);
  }, [readOnly, wireTool, endArrowSession, selection, applySelection, beginSchematicMove, getSVGPoint]);

  /** Mousedown on a pin end: start or finish a wire (any mode) */
  const handlePinMouseDown = useCallback((componentId: string, pinId: string, e: React.MouseEvent) => {
    if (readOnly || e.button === 2) return;
    if (!wireTool && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      handleItemMouseDown("components", componentId, e);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const pinPos = getPinGridPos(componentId, pinId);
    if (!pinPos) return;
    if (drawing) finishAt(pinPos);
    else startDrawing(pinPos, !wireDrawMode);
  }, [readOnly, wireTool, drawing, wireDrawMode, handleItemMouseDown, getPinGridPos, finishAt, startDrawing]);

  /** Mousedown on a flag's connection point: start or finish a wire, like a pin */
  const handleLabelPointMouseDown = useCallback((label: NetLabel, e: React.MouseEvent) => {
    if (readOnly || e.button === 2) return;
    if (!wireTool && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      handleItemMouseDown("labels", label.id, e);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    if (drawing) finishAt(label.pos);
    else startDrawing(label.pos, !wireDrawMode);
  }, [readOnly, wireTool, drawing, wireDrawMode, handleItemMouseDown, finishAt, startDrawing]);

  const handleWireMouseDown = useCallback((wire: SchematicWire, e: React.MouseEvent) => {
    if (readOnly || e.button === 2) return;
    if (!wireTool) {
      handleItemMouseDown("wires", wire.id, e);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const pt = getSVGPoint(e);
    const snapped = { x: snapToGrid(pt.x), y: snapToGrid(pt.y) };
    // Settling splits the wire under the new endpoint, so the join is a real junction
    if (drawing) finishAt(snapped);
    else startDrawing(snapped, false);
  }, [readOnly, wireTool, drawing, handleItemMouseDown, getSVGPoint, finishAt, startDrawing]);

  const handleSvgMouseDown = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    endArrowSession();
    if (e.button === 2) return;
    const target = e.target as Element;
    const isBackground = target.tagName === "svg" || target.getAttribute("fill") === "url(#grid)";
    if (!isBackground) return;
    setEditingLabelId(null);

    const pt = getSVGPoint(e);
    if (drawing) {
      // Click on grid = complete the segment here and keep drawing
      placeSegment({ x: snapToGrid(pt.x), y: snapToGrid(pt.y) });
      return;
    }
    if (wireDrawMode) {
      startDrawing({ x: snapToGrid(pt.x), y: snapToGrid(pt.y) }, false);
      return;
    }
    const mode = selModeFromEvent(e);
    setSelectionRect({ startX: pt.x, startY: pt.y, currentX: pt.x, currentY: pt.y, mode: mode === "replace" ? "replace" : "add" });
  }, [readOnly, endArrowSession, getSVGPoint, drawing, wireDrawMode, placeSegment, startDrawing]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pt = getSVGPoint(e);
    lastMouseRef.current = pt;
    if (handlePanMove(e)) return;

    // Wire drawing preview + detect initial direction
    if (drawing && wireDrawingFrom) {
      setWirePreview({ x: snapToGrid(pt.x), y: snapToGrid(pt.y) });
      const mdx = Math.abs(pt.x - wireDrawingFrom.x);
      const mdy = Math.abs(pt.y - wireDrawingFrom.y);
      const threshold = GRID_SIZE / 2;
      if (mdx < threshold && mdy < threshold) {
        // Back near start — reset direction so user can re-choose
        if (wireDirection) useProjectStore.setState({ schematicWireDirection: null });
      } else if (!wireDirection) {
        // Lock direction on first significant movement
        useProjectStore.setState({ schematicWireDirection: mdx >= mdy ? "horizontal-first" : "vertical-first" });
      }
      return;
    }

    if (selectionRect) {
      setSelectionRect((prev) => (prev ? { ...prev, currentX: pt.x, currentY: pt.y } : null));
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.didMove) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) return;
    }
    const nx = snapToGrid(pt.x - drag.offsetX);
    const ny = snapToGrid(pt.y - drag.offsetY);
    if (nx === drag.lastX && ny === drag.lastY) return;
    // One snapshot per drag, taken the first time the selection actually
    // moves, so a plain select-click never touches history.
    if (!drag.didMove) {
      drag.didMove = true;
      pushSnapshot();
    }
    moveSchematicItems({ x: nx - drag.lastX, y: ny - drag.lastY });
    drag.lastX = nx;
    drag.lastY = ny;
  }, [getSVGPoint, handlePanMove, drawing, wireDrawingFrom, wireDirection, selectionRect, pushSnapshot, moveSchematicItems]);

  const finishRect = useCallback(() => {
    const rect = selectionRect;
    setSelectionRect(null);
    if (!rect) return false;
    const x1 = Math.min(rect.startX, rect.currentX), x2 = Math.max(rect.startX, rect.currentX);
    const y1 = Math.min(rect.startY, rect.currentY), y2 = Math.max(rect.startY, rect.currentY);
    if (x2 - x1 <= MIN_RECT_SIZE && y2 - y1 <= MIN_RECT_SIZE) {
      if (rect.mode === "replace") applySelection(EMPTY_SEL);
      return true;
    }
    // Dragged left to right: only what the box fully encloses. Right to
    // left: everything the box touches.
    const enclosed = rect.currentX >= rect.startX;
    const picked: Selection = { components: [], wires: [], labels: [] };
    for (const comp of components) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      const b = getSymbolBounds(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
      const cx1 = comp.schematicPos.x + b.minX, cx2 = comp.schematicPos.x + b.maxX;
      const cy1 = comp.schematicPos.y + b.minY, cy2 = comp.schematicPos.y + b.maxY;
      const hit = enclosed
        ? cx1 >= x1 && cx2 <= x2 && cy1 >= y1 && cy2 <= y2
        : cx2 >= x1 && cx1 <= x2 && cy2 >= y1 && cy1 <= y2;
      if (hit) picked.components.push(comp.id);
    }
    for (const w of schematicWires) if (wireInRect(w, x1, y1, x2, y2, enclosed)) picked.wires.push(w.id);
    for (const l of netLabels) {
      const b = netLabelBounds(l);
      const hit = enclosed
        ? b.minX >= x1 && b.maxX <= x2 && b.minY >= y1 && b.maxY <= y2
        : pointInRect(l.pos, x1, y1, x2, y2) || (b.maxX >= x1 && b.minX <= x2 && b.maxY >= y1 && b.minY <= y2);
      if (hit) picked.labels.push(l.id);
    }
    applySelection(rect.mode === "replace" ? picked : selUnion(selection, picked));
    return true;
  }, [selectionRect, components, componentDefs, schematicWires, netLabels, selection, applySelection]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    if (!drag) return;
    if (drag.didMove) finishSchematicGesture();
    else cancelSchematicGesture();
  }, [finishSchematicGesture, cancelSchematicGesture]);

  const handleMouseUp = useCallback(() => {
    handlePanEnd();
    if (finishRect()) return;
    endDrag();
  }, [handlePanEnd, finishRect, endDrag]);

  const handleMouseLeave = useCallback(() => {
    mouseInsideRef.current = false;
    handlePanEnd();
    setSelectionRect(null);
    endDrag();
  }, [handlePanEnd, endDrag]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    const target = e.target as Element;
    const isBackground = target.tagName === "svg" || target.getAttribute("fill") === "url(#grid)";
    // The first click of the pair already placed the segment; the second ends the run
    if (isBackground && drawing) endDrawing();
  }, [readOnly, drawing, endDrawing]);

  // Drag-and-drop from the component library
  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes("application/schematic-component") || types.includes("application/schematic-netlabel")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (readOnly || !svgRef.current) return;
    const pos = screenToSvg(e.clientX, e.clientY, svgRef.current);
    const snapped = { x: snapToGrid(pos.x), y: snapToGrid(pos.y) };
    const defId = e.dataTransfer.getData("application/schematic-component");
    if (defId) {
      e.preventDefault();
      // A part from the user's library is copied into the project first
      const libDef = useLibraryStore.getState().defs.find((d) => d.id === defId);
      if (libDef) addLibraryComponent(libDef, snapped);
      else addComponent(defId, snapped);
      return;
    }
    const raw = e.dataTransfer.getData("application/schematic-netlabel");
    if (raw) {
      let tile: { kind?: string; name?: string } = {};
      try { tile = JSON.parse(raw); } catch { tile = {}; }
      const kind = tile.kind;
      if (kind === "gnd" || kind === "power" || kind === "label") {
        e.preventDefault();
        placeLabel(kind, snapped, tile.name);
      }
    }
  }, [readOnly, screenToSvg, addComponent, addLibraryComponent, placeLabel]);

  // ── Render ────────────────────────────────────────────

  // Selected components render last so they sit on top
  const selectedCompSet = new Set(selection.components);
  const sortedComponents = selection.components.length > 0
    ? [...components.filter((c) => !selectedCompSet.has(c.id)), ...components.filter((c) => selectedCompSet.has(c.id))]
    : components;

  const cursorStyle = panZoom.panning
    ? "grabbing"
    : wireTool
    ? "crosshair"
    : isDragging
    ? "grabbing"
    : "default";

  const wireStartPos = wireDrawingFrom;
  const selCount = selSize(selection);

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden relative">
      <svg
        ref={(el) => {
          svgRef.current = el;
          panZoom.setTouchTarget(el);
        }}
        className="font-sans h-full w-full bg-[var(--schematic-bg)]"
        viewBox={panZoom.getViewBox(containerSize.width, containerSize.height)}
        style={{ cursor: cursorStyle }}
        onMouseDown={(e) => {
          panZoom.handlePanStart(e);
          handleSvgMouseDown(e);
        }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseEnter={() => { mouseInsideRef.current = true; }}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
        onWheel={panZoom.handleWheel}
        onContextMenu={panZoom.handleContextMenu}
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

        {/* Component drag targets, painted below the wires so a wire crossing a
            symbol or running between its pin stubs stays selectable. The visible
            symbols, their pins and labels render above and keep their handlers. */}
        {!readOnly && components.map((comp) => {
          const def = resolveComponentDef(comp, componentDefs);
          if (!def) return null;
          const b = getSymbolBounds(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false);
          return (
            <rect
              key={`hit-${comp.id}`}
              x={comp.schematicPos.x + b.minX - 5}
              y={comp.schematicPos.y + b.minY - 5}
              width={b.width + 10}
              height={b.height + 10}
              fill="transparent"
              style={{ cursor: "grab" }}
              onMouseDown={(e) => handleItemMouseDown("components", comp.id, e)}
            />
          );
        })}

        {/* Schematic wires */}
        {schematicWires.map((wire) => (
          <SchematicWireLine
            key={wire.id}
            wire={wire}
            color={wireColorMap.get(wire.id)}
            isSelected={selection.wires.includes(wire.id)}
            highlighted={!!activeNetId && wireNetIdMap.get(wire.id) === activeNetId}
            onMouseDown={(e) => handleWireMouseDown(wire, e)}
            onMouseEnter={readOnly || isDragging || drawing ? undefined : () => setHoverNetId(wireNetIdMap.get(wire.id) ?? null)}
            onMouseLeave={() => setHoverNetId(null)}
          />
        ))}

        {/* Junction dots where three or more wire ends, pins or labels meet */}
        {junctionPoints.map((jp) => {
          const color = jp.wireId ? (wireColorMap.get(jp.wireId) ?? "var(--junction-dot)") : "var(--junction-dot)";
          return (
            <circle
              key={pointKey(jp.x, jp.y)}
              cx={jp.x} cy={jp.y} r={2.5}
              fill={color}
              pointerEvents="none"
            />
          );
        })}

        {/* Wire ends that touch nothing */}
        {danglingEnds.map((d) => (
          <rect
            key={`d-${pointKey(d.x, d.y)}`}
            x={d.x - 2.5} y={d.y - 2.5} width={5} height={5}
            fill="var(--schematic-bg)"
            stroke={wireColorMap.get(d.wireId) ?? "var(--wire-default)"}
            strokeWidth={1.2}
            pointerEvents="none"
          />
        ))}

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
            isSelected={selectedCompSet.has(comp.id)}
            onMouseDown={(e) => handleItemMouseDown("components", comp.id, e)}
            onPinMouseDown={handlePinMouseDown}
            getSVGPoint={getSVGPoint}
            readOnly={readOnly}
          />
        ))}

        {/* Net labels */}
        {netLabels.map((label) => {
          const info = labelNetMap.get(label.id);
          return (
            <SchematicNetLabel
              key={label.id}
              label={label}
              color={info?.color}
              isSelected={selection.labels.includes(label.id)}
              highlighted={!!activeNetId && info?.netId === activeNetId}
              editing={editingLabelId === label.id}
              onMouseDown={readOnly ? undefined : (e) => handleItemMouseDown("labels", label.id, e)}
              onDoubleClick={readOnly ? undefined : (e) => { e.stopPropagation(); setEditingLabelId(label.id); }}
              onPointMouseDown={readOnly ? undefined : (e) => handleLabelPointMouseDown(label, e)}
              onMouseEnter={readOnly || isDragging || drawing ? undefined : () => setHoverNetId(info?.netId ?? null)}
              onMouseLeave={() => setHoverNetId(null)}
              onCommitName={(name) => {
                setEditingLabelId(null);
                if (name.trim() && name.trim() !== label.name) updateNetLabel(label.id, { name });
              }}
              onCancelEdit={() => setEditingLabelId(null)}
            />
          );
        })}

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
            strokeDasharray={selectionRect.currentX >= selectionRect.startX ? "4 2" : "1 3"}
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Selection actions — a single component */}
      {!readOnly && singleComponentId && (
        <SelectionActionBar
          actions={[
            {
              key: "rotate",
              label: "Rotate",
              title: "Rotate selected component 90°",
              shortcut: "R",
              icon: RotateIcon,
              onClick: () => rotateSchematicComponent(singleComponentId),
            },
            {
              key: "mirror",
              label: "Mirror",
              title: "Mirror selected component",
              shortcut: "M",
              icon: MirrorIcon,
              onClick: () => mirrorSchematicComponent(singleComponentId),
            },
            (() => {
              const comp = components.find((c) => c.id === singleComponentId);
              const excluded = !!comp?.boardExcluded;
              return {
                key: "exclude",
                label: excluded ? "Include" : "Exclude",
                title: excluded
                  ? "Include this component on the stripboard again"
                  : "Exclude this component from the stripboard (off-board part)",
                shortcut: "E",
                icon: ExcludeIcon,
                onClick: () => toggleExcludeSelection([singleComponentId]),
              };
            })(),
            (() => {
              const comp = components.find((c) => c.id === singleComponentId);
              const off = !!comp?.offBoard && !comp.boardExcluded;
              return {
                key: "offboard",
                label: off ? "Mount on board" : "Mount off board",
                title: off
                  ? "Put this part back on the stripboard itself"
                  : "Mounted off the board and wired to it: each wired pin gets a solder pad on the stripboard",
                icon: OffBoardIcon,
                onClick: () => setOffBoard(singleComponentId, !off),
              };
            })(),
            {
              key: "delete",
              label: "Delete",
              title: "Delete selected component",
              shortcut: "Del",
              icon: DeleteIcon,
              variant: "danger",
              onClick: () => deleteSelection(false),
            },
          ] satisfies CanvasAction[]}
        />
      )}

      {/* Selection actions — a single wire */}
      {!readOnly && singleWireId && (() => {
        const wholeWireIds = collectWholeWire(singleWireId, schematicWires, pinNodeKeys);
        const deleteSegment: CanvasAction = {
          key: "delete-segment",
          label: "Delete Segment",
          title: "Delete this wire segment",
          shortcut: "Del",
          icon: DeleteIcon,
          variant: "danger",
          onClick: () => deleteSelection(false),
        };
        const deleteWhole: CanvasAction = {
          key: "delete-wire",
          label: "Delete Wire",
          title: "Delete the whole wire, including all its segments",
          shortcut: "Alt+Del",
          icon: DeleteIcon,
          variant: "danger",
          onClick: () => deleteSelection(true),
        };
        return (
          <SelectionActionBar
            actions={wholeWireIds.length > 1 ? [deleteSegment, deleteWhole] : [deleteSegment]}
          />
        );
      })()}

      {/* Selection actions — a single net label */}
      {!readOnly && singleLabelId && (
        <SelectionActionBar
          actions={[
            {
              key: "rotate",
              label: "Rotate",
              title: "Rotate label 90°",
              shortcut: "R",
              icon: RotateIcon,
              onClick: () => rotateSelection("rotate"),
            },
            {
              key: "rename",
              label: "Rename",
              title: "Change the net name (double-click also works)",
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              ),
              onClick: () => setEditingLabelId(singleLabelId),
            },
            {
              key: "delete",
              label: "Delete",
              title: "Delete this label",
              shortcut: "Del",
              icon: DeleteIcon,
              variant: "danger",
              onClick: () => deleteSelection(false),
            },
          ] satisfies CanvasAction[]}
        />
      )}

      {/* Selection actions — several things */}
      {!readOnly && selCount > 1 && (
        <SelectionActionBar
          actions={[
            ...(selection.components.length + selection.labels.length > 0 ? [
              {
                key: "rotate",
                label: `Rotate ${selCount}`,
                title: "Rotate the selection 90° around its centre",
                shortcut: "R",
                icon: RotateIcon,
                onClick: () => rotateSelection("rotate"),
              },
              {
                key: "mirror",
                label: `Mirror ${selCount}`,
                title: "Mirror the selection around its centre",
                shortcut: "M",
                icon: MirrorIcon,
                onClick: () => rotateSelection("mirror"),
              },
            ] : []),
            ...(selection.components.length > 0 ? [{
              key: "exclude",
              label: `Exclude ${selection.components.length}`,
              title: "Exclude or include the selected components on the stripboard",
              shortcut: "E",
              icon: ExcludeIcon,
              onClick: () => toggleExcludeSelection(selection.components),
            }] : []),
            ...(selection.components.length > 0 ? [(() => {
              const picked = components.filter((c) => selection.components.includes(c.id) && !c.boardExcluded);
              const allOff = picked.length > 0 && picked.every((c) => c.offBoard);
              return {
                key: "offboard",
                label: allOff ? `Mount ${picked.length} on board` : `Mount ${picked.length} off board`,
                title: allOff
                  ? "Put these parts back on the stripboard themselves"
                  : "Mounted off the board and wired to it: each wired pin gets a solder pad on the stripboard",
                icon: OffBoardIcon,
                onClick: () => transact(() => picked.forEach((c) => setOffBoard(c.id, !allOff))),
              };
            })()] : []),
            {
              key: "delete",
              label: `Delete ${selCount}`,
              title: "Delete everything selected",
              shortcut: "Del",
              icon: DeleteIcon,
              variant: "danger" as const,
              onClick: () => deleteSelection(false),
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

      {!readOnly && (
        <SchematicTools
          tool={wireTool ? "wire" : "select"}
          onChange={(tool) => {
            if (drawing) endDrawing();
            if ((tool === "wire") !== wireDrawMode) toggleWireDrawMode();
          }}
        />
      )}

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
