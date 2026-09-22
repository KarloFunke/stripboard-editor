"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Cut } from "@/types";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { useStripSegments } from "@/hooks/useStripSegments";
import { usePanZoom } from "@/hooks/usePanZoom";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";

import {
  HOLE_SPACING,
  HOLE_RADIUS,

  STRIP_HEIGHT,
  STRIP_COLOR,
  STRIP_CONFLICT_COLOR,
  LABEL_FONT_SIZE,
  holeCenter,
  nearestHole,
  nearestCutTarget,
  boardRect,
  getComponentBounds,
  getComponentPinPositions,
  getRotatedPinPositions,
  getFlexiblePinPositions,
  getFlexibleBounds,
} from "./boardLayout";
import { bodyCuts, sameCut } from "./bodyCuts";
import { useBoardView } from "@/hooks/useBoardView";
import { GROUP_PIN, OFF_BOARD_CONNECTIONS, isLead } from "./offBoard";
import { coveredHoles } from "./flexGeometry";
import { bodyClashes, rigidBody } from "./partGeometry";
import {
  getGroupForSegment,
  getGroupForWire,
} from "./connectivity";
import { StripSegment } from "./stripSegments";
import { bodyStyle, bellyPath, dipNotch, usbPort } from "./componentGlyphs";
import { defaultPackageId, packageOptions } from "./packageBodies";
import PlacedComponent, { suppressNextCanvasClick } from "./PlacedComponent";
import CutMark from "./CutMark";
import WireLine, { WirePart } from "./WireLine";
import BoardTools from "./BoardTools";
import { TOOL_STRIP_HOME } from "@/components/canvas/ToolStrip";
import { computeWireLaneOffsets } from "./wireLanes";
import { SelectionActionBar, RotateIcon, DeleteIcon, FootprintIcon, LockIcon, UnlockIcon, OffBoardIcon, PackageIcon, WandIcon, type CanvasAction } from "@/components/canvas/SelectionActionBar";

export default function StripboardCanvas({
  readOnly = false,
  onEditFootprint,
  onAutoLayoutSelection,
}: {
  readOnly?: boolean;
  onEditFootprint?: (componentId: string) => void;
  onAutoLayoutSelection?: (componentIds: string[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom(1, readOnly ? undefined : TOOL_STRIP_HOME);
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

  const board = useProjectStore((s) => s.board);
  // the board's view: an off-board part is its solder pads here
  const { components } = useBoardView();
  const setOffBoard = useProjectStore((s) => s.setOffBoard);
  const setOffBoardPackage = useProjectStore((s) => s.setOffBoardPackage);
  const allComponents = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const showOverlaps = useProjectStore((s) => s.showOverlaps);
  // Hand placements are never refused, but one that cannot be built is shown
  const clashing = useMemo(
    () => (showOverlaps ? bodyClashes(components, (c) => resolveComponentDef(c, componentDefs)) : new Set<string>()),
    [showOverlaps, components, componentDefs]
  );
  const placeOnBoard = useProjectStore((s) => s.placeOnBoard);
  const placeCut = useProjectStore((s) => s.placeCut);
  const removeCut = useProjectStore((s) => s.removeCut);
  const addWire = useProjectStore((s) => s.addWire);
  const removeWire = useProjectStore((s) => s.removeWire);
  const setWireEnds = useProjectStore((s) => s.setWireEnds);
  const wirePlacementFrom = useProjectStore((s) => s.wirePlacementFrom);
  const setWirePlacementFrom = useProjectStore((s) => s.setWirePlacementFrom);
  const cancelWirePlacement = useProjectStore((s) => s.cancelWirePlacement);
  const trayDragComponentId = useProjectStore((s) => s.trayDragComponentId);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);
  const setFlexibleEndPos = useProjectStore((s) => s.setFlexibleEndPos);
  const insertBoardLine = useProjectStore((s) => s.insertBoardLine);
  const deleteBoardLine = useProjectStore((s) => s.deleteBoardLine);
  // Right-click anywhere on the board: insert or delete the row or column there
  const [lineMenu, setLineMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  // Where the right button went down: a press that does not move opens the
  // menu, one that moves pans.
  const rightDownRef = useRef<{ x: number; y: number } | null>(null);

  const nets = useProjectStore((s) => s.nets);

  const { segments, connectivity } = useStripSegments();

  // Overlapping straight wires on one column (or row) get perpendicular
  // lane offsets so parallel runs stay individually visible. Wires that
  // only touch at a shared endpoint keep the same lane.
  const wireLaneOffset = useMemo(() => computeWireLaneOffsets(board.wires, 3.5), [board.wires]);


  const {
    selectedId, setSelectedId,
    selectedIds, setSelectedIds,
    selectionRect,
    startSelectionRect, updateSelectionRect, finalizeSelectionRect, cancelSelectionRect,
    checkDragThreshold, shouldSuppressClick, markDragComplete,
    clearSelection,
  } = useCanvasSelection();

  const [selectedWireIds, setSelectedWireIds] = useState<string[]>([]);
  const [selectedCuts, setSelectedCuts] = useState<Cut[]>([]);
  const [trayGhost, setTrayGhost] = useState<{
    row: number;
    col: number;
    componentId: string;
  } | null>(null);
  const [dragging, setDragging] = useState<{
    componentId: string;
    startX: number;
    startY: number;
    didDrag: boolean;
    rowOffset: number; // click row - boardPos row
    colOffset: number; // click col - boardPos col
    multi: boolean;
  } | null>(null);
  const [dragPreviewPos, setDragPreviewPos] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [wireMousePos, setWireMousePos] = useState<{ x: number; y: number } | null>(null);
  const [flexPinDrag, setFlexPinDrag] = useState<{
    componentId: string;
    pinId: string; // "1" for pin1 (boardPos), "2" for pin2 (flexibleEndPos)
  } | null>(null);

  const rotateComponent = useProjectStore((s) => s.rotateComponent);
  const toggleBoardLock = useProjectStore((s) => s.toggleBoardLock);
  const setBoardLock = useProjectStore((s) => s.setBoardLock);
  const transact = useProjectStore((s) => s.transact);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const removeFromBoard = useProjectStore((s) => s.removeFromBoard);
  const moveComponentsOnBoard = useProjectStore((s) => s.moveComponentsOnBoard);
  const autoAlignPolarity = useProjectStore((s) => s.autoAlignPolarity);

  // A drag gesture (component body or flexible pin) arms this on mousedown and
  // commits exactly one snapshot the first time the position actually changes.
  // A plain click never moves anything, so it never snapshots — keeping the
  // redo stack intact and the history one-entry-per-drag.
  const pendingSnapshotRef = useRef(false);
  const commitSnapshotOnce = useCallback(() => {
    if (pendingSnapshotRef.current) {
      pendingSnapshotRef.current = false;
      pushSnapshot();
    }
  }, [pushSnapshot]);

  // Multi-drag: dragging a component that's part of a multi-selection moves the
  // whole selection (components + wires + cuts). Holds the move plan, the group's
  // bounds + anchor hole at drag start (to keep the group inside the board), and
  // the delta applied so far.
  const multiDragRef = useRef<{
    moveIds: string[];
    moveWireIds: string[];
    moveCuts: Cut[];
    // under the moved parts' bodies and not selected themselves
    bodyCuts: Cut[];
    anchorStartRow: number;
    anchorStartCol: number;
    startMinRow: number;
    startMinCol: number;
    startMaxRow: number;
    startMaxCol: number;
    appliedDRow: number;
    appliedDCol: number;
  } | null>(null);

  // Bounding box (in holes) of a board selection, used to clamp a group move so
  // no part of it leaves the board. Between-cuts span col..col+1.
  const computeBoardSelectionBounds = useCallback(
    (moveIds: string[], wireIds: string[], cuts: Cut[]) => {
      let minRow = Infinity, minCol = Infinity, maxRow = -Infinity, maxCol = -Infinity;
      for (const comp of components) {
        if (!moveIds.includes(comp.id) || !comp.boardPos) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        const b = def.flexible
          ? getFlexibleBounds(comp, def)
          : getComponentBounds(def, comp.boardPos, comp.rotation);
        minRow = Math.min(minRow, b.minRow); maxRow = Math.max(maxRow, b.maxRow);
        minCol = Math.min(minCol, b.minCol); maxCol = Math.max(maxCol, b.maxCol);
      }
      for (const w of board.wires) {
        if (!wireIds.includes(w.id)) continue;
        minRow = Math.min(minRow, w.from.row, w.to.row); maxRow = Math.max(maxRow, w.from.row, w.to.row);
        minCol = Math.min(minCol, w.from.col, w.to.col); maxCol = Math.max(maxCol, w.from.col, w.to.col);
      }
      for (const cut of cuts) {
        minRow = Math.min(minRow, cut.row); maxRow = Math.max(maxRow, cut.row);
        minCol = Math.min(minCol, cut.col); maxCol = Math.max(maxCol, cut.col + (cut.kind === "hole" ? 0 : 1));
      }
      return { minRow, minCol, maxRow, maxCol };
    },
    [components, componentDefs, board.wires]
  );

  const boardTool = useProjectStore((s) => s.boardTool);
  const setBoardTool = useProjectStore((s) => s.setBoardTool);
  const setComponentPackage = useProjectStore((s) => s.setComponentPackage);

  // Where the tool in hand would act, shown before the click
  const [hover, setHover] = useState<Cut | null>(null);
  useEffect(() => setHover(null), [boardTool]);

  // Holes with a component lead in them: they take no wire end and no drill
  const pinHoles = useMemo(() => {
    const holes = new Set<string>();
    for (const comp of components) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      for (const p of getComponentPinPositions(comp, def)) holes.add(`${p.row},${p.col}`);
    }
    return holes;
  }, [components, componentDefs]);

  const wireEndBlocked = useCallback(
    (hole: { row: number; col: number }) =>
      pinHoles.has(`${hole.row},${hole.col}`) ||
      board.cuts.some((c) => c.kind === "hole" && c.row === hole.row && c.col === hole.col),
    [pinHoles, board.cuts]
  );

  // A hole is cut or holds something, never both
  const cutBlocked = useCallback(
    (cut: Cut) =>
      cut.kind === "hole" && (
        pinHoles.has(`${cut.row},${cut.col}`) ||
        board.wires.some((w) =>
          (w.from.row === cut.row && w.from.col === cut.col) ||
          (w.to.row === cut.row && w.to.col === cut.col)
        )
      ),
    [pinHoles, board.wires]
  );

  // The cuts under these parts' bodies, which travel with them
  const bodyCutsOf = useCallback(
    (ids: string[], except: Cut[] = []) => {
      const out: Cut[] = [];
      for (const comp of components) {
        if (!ids.includes(comp.id)) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        for (const cut of bodyCuts(board.cuts, comp, def)) {
          if (!out.some((c) => sameCut(c, cut)) && !except.some((c) => sameCut(c, cut))) out.push(cut);
        }
      }
      return out;
    },
    [components, componentDefs, board.cuts]
  );

  // A cut being dragged: where it started and where it is now
  const cutDragRef = useRef<{
    startX: number;
    startY: number;
    didDrag: boolean;
    grabHole: { row: number; col: number } | null;
    origin: Cut;
    at: Cut;
  } | null>(null);

  const wireDragRef = useRef<{
    wireId: string;
    part: WirePart;
    startX: number;
    startY: number;
    didDrag: boolean;
    grabHole: { row: number; col: number } | null;
    from: { row: number; col: number };
    to: { row: number; col: number };
  } | null>(null);
  // Cuts under the body of the single part being dragged, at their current place
  const carriedCutsRef = useRef<Cut[]>([]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly) return;
      // Both editors are mounted at once; only the last-interacted pane owns
      // the keyboard so one keypress doesn't act on both canvases.
      if (useProjectStore.getState().activeEditor !== "stripboard") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Auto-repeat (held key): only arrow-move may repeat (it dedupes its own
      // snapshot below). Every other shortcut is discrete — holding it must not
      // spin the action or flood undo history.
      const isArrowKey = e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (e.repeat && !isArrowKey) return;

      // Escape steps out: the pending wire, then the selection, then the tool
      if (e.key === "Escape") {
        if (wirePlacementFrom) {
          cancelWirePlacement();
          setWireMousePos(null);
        } else if (selectedId || selectedIds.length > 0 || selectedWireIds.length > 0 || selectedCuts.length > 0) {
          setSelectedId(null);
          setSelectedIds([]);
          setSelectedWireIds([]);
          setSelectedCuts([]);
        } else {
          setBoardTool("select");
        }
        return;
      }

      // Arrow keys: move selected components, wires, and cuts
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      const hasSelection = moveIds.length > 0 || selectedWireIds.length > 0 || selectedCuts.length > 0;
      if (hasSelection && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const delta = {
          ArrowUp: { row: -1, col: 0 },
          ArrowDown: { row: 1, col: 0 },
          ArrowLeft: { row: 0, col: -1 },
          ArrowRight: { row: 0, col: 1 },
        }[e.key]!;
        // Clamp so the selection can't step off the board.
        const b = computeBoardSelectionBounds(moveIds, selectedWireIds, selectedCuts);
        let dRow = delta.row;
        let dCol = delta.col;
        if (b.minRow + dRow < 0 || b.maxRow + dRow > board.rows - 1) dRow = 0;
        if (b.minCol + dCol < 0 || b.maxCol + dCol > board.cols - 1) dCol = 0;
        if (dRow === 0 && dCol === 0) return; // blocked at the edge
        // One snapshot per held-key gesture: snapshot on the initial press,
        // keep moving on auto-repeat. One Ctrl+Z reverts the whole nudge.
        if (!e.repeat) pushSnapshot();
        moveComponentsOnBoard(moveIds, dRow, dCol, selectedWireIds, [...selectedCuts, ...bodyCutsOf(moveIds, selectedCuts)]);
        if (selectedCuts.length > 0) {
          setSelectedCuts((prev) =>
            prev.map((c) => ({ ...c, row: c.row + dRow, col: c.col + dCol }))
          );
        }
        return;
      }

      if (e.key === "Delete") {
        // Delete acts on the whole selection: unplace components, remove
        // selected wires and cuts — one undo step for the lot.
        const delIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
        if (delIds.length > 0 || selectedWireIds.length > 0 || selectedCuts.length > 0) {
          transact(() => {
            for (const id of delIds) removeFromBoard(id);
            for (const wireId of selectedWireIds) removeWire(wireId);
            for (const cut of selectedCuts) removeCut(cut);
          });
          setSelectedId(null);
          setSelectedIds([]);
          setSelectedWireIds([]);
          setSelectedCuts([]);
        }
        return;
      }

      if (selectedId && (e.key === "r" || e.key === "R")) {
        rotateComponent(selectedId);
      }

      // W and C take up the wire and the cut tool, or put them down again.
      if (!e.ctrlKey && !e.metaKey) {
        const tool = e.key === "w" || e.key === "W" ? "wire" : e.key === "c" || e.key === "C" ? "cut" : null;
        if (tool) {
          setWireMousePos(null);
          setBoardTool(boardTool === tool ? "select" : tool);
        }
      }

      // L locks/unlocks the whole selection (single or multi). Locks when any
      // selected part is still unlocked, otherwise unlocks the lot.
      if (e.key === "l" || e.key === "L") {
        const ids = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
        const lockable = ids.filter((id) => components.find((c) => c.id === id)?.boardPos);
        if (lockable.length > 0) {
          const anyUnlocked = lockable.some((id) => !components.find((c) => c.id === id)?.locked);
          setBoardLock(lockable, anyUnlocked);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wirePlacementFrom, cancelWirePlacement, selectedId, selectedIds, selectedWireIds, selectedCuts, rotateComponent, removeFromBoard, removeWire, removeCut, transact, moveComponentsOnBoard, pushSnapshot, computeBoardSelectionBounds, board.rows, board.cols, setSelectedId, setSelectedIds, components, setBoardLock, boardTool, setBoardTool, bodyCutsOf]);


  const getSVGPoint = useCallback((e: React.MouseEvent | React.DragEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    return panZoom.screenToSvg(e.clientX, e.clientY, svg);
  }, [panZoom.screenToSvg]);

  const getSegmentColor = useCallback(
    (segment: StripSegment, segIndex: number): string => {
      const group = getGroupForSegment(connectivity, segIndex);
      if (group?.hasConflict) return STRIP_CONFLICT_COLOR;
      if (group && group.netIds.length === 1) {
        const net = nets.find((n) => n.id === group.netIds[0]);
        return net?.color ?? STRIP_COLOR;
      }
      if (segment.netIds.length >= 2) return STRIP_CONFLICT_COLOR;
      if (segment.netIds.length === 1) {
        const net = nets.find((n) => n.id === segment.netIds[0]);
        return net?.color ?? STRIP_COLOR;
      }
      return STRIP_COLOR;
    },
    [connectivity, nets]
  );

  const getWireColor = useCallback(
    (wireId: string): { color: string; isConflict: boolean } => {
      const group = getGroupForWire(connectivity, wireId);
      if (!group) return { color: "#a3a3a3", isConflict: false };
      if (group.hasConflict) return { color: STRIP_CONFLICT_COLOR, isConflict: true };
      if (group.netIds.length === 1) {
        const net = nets.find((n) => n.id === group.netIds[0]);
        return { color: net?.color ?? "#a3a3a3", isConflict: false };
      }
      return { color: "#a3a3a3", isConflict: false };
    },
    [connectivity, nets]
  );

  // Check if a hole is occupied by any placed component (pin or body cell)
  const findComponentAtHole = useCallback(
    (row: number, col: number): string | null => {
      for (const comp of components) {
        if (!comp.boardPos) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        // Flexible components only occupy their two pin holes (the leg floats
        // above the board); their nominal bounds would falsely cover holes the
        // dragged legs never touch.
        if (def.flexible) {
          const pins = getFlexiblePinPositions(comp, def);
          if (pins.some((p) => p.row === row && p.col === col)) return comp.id;
          continue;
        }
        // Every hole the package lies over, which for an overhanging body is
        // more than the footprint's own cells.
        const bounds = coveredHoles(rigidBody(def, comp.boardPos, comp.rotation, comp));
        if (row >= bounds.minRow && row <= bounds.maxRow && col >= bounds.minCol && col <= bounds.maxCol) {
          return comp.id;
        }
      }
      return null;
    },
    [components, componentDefs]
  );

  const isValidPlacement = useCallback(
    (componentId: string, pos: { row: number; col: number }) => {
      const comp = components.find((c) => c.id === componentId);
      if (!comp) return false;
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) return false;
      const bounds = getComponentBounds(def, pos, comp.rotation);
      return (
        bounds.minRow >= 0 &&
        bounds.minCol >= 0 &&
        bounds.maxRow < board.rows &&
        bounds.maxCol < board.cols
      );
    },
    [components, componentDefs, board.rows, board.cols]
  );

  // ── Tray drag-and-drop ──────────────────────────────────

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const pt = getSVGPoint(e);
      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      if (hole) {
        setTrayGhost({ ...hole, componentId: trayDragComponentId ?? "" });
      } else {
        setTrayGhost(null);
      }
    },
    [getSVGPoint, board.rows, board.cols, trayDragComponentId]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return;
      e.preventDefault();
      const componentId = e.dataTransfer.getData("text/plain");
      if (!componentId) return;
      const pt = getSVGPoint(e);
      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      if (hole && isValidPlacement(componentId, hole)) {
        pushSnapshot(); // discrete action — placeOnBoard no longer snapshots itself
        placeOnBoard(componentId, hole);
        autoAlignPolarity([componentId]);
      }
      setTrayGhost(null);
    },
    [getSVGPoint, board.rows, board.cols, isValidPlacement, placeOnBoard, pushSnapshot, autoAlignPolarity]
  );

  const handleDragLeave = useCallback(() => {
    setTrayGhost(null);
  }, []);

  // ── On-board component dragging ─────────────────────────

  const handleComponentMouseDown = useCallback(
    (componentId: string, e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return; // right-click is pan
      e.stopPropagation();
      e.preventDefault();
      // Defer the snapshot until the drag actually moves the component (see
      // commitSnapshotOnce). A plain select-click must not touch history.
      pendingSnapshotRef.current = true;

      // Dragging a component that's part of a multi-selection moves the whole
      // selection together; otherwise it's a single-component drag (and selects it).
      const selIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      const isMulti = selIds.length > 1 && selIds.includes(componentId);
      // With a tool up a press on a part can still drag it, but a plain click
      // is the tool's, so nothing gets selected.
      if (!isMulti && boardTool === "select") {
        setSelectedId(componentId);
        setSelectedWireIds([]);
        setSelectedCuts([]);
      }
      carriedCutsRef.current = isMulti ? [] : bodyCutsOf([componentId]);

      // Compute offset: where within the component the user clicked
      const comp = components.find((c) => c.id === componentId);
      const pt = getSVGPoint(e);
      const clickHole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      const rowOffset = comp?.boardPos && clickHole ? clickHole.row - comp.boardPos.row : 0;
      const colOffset = comp?.boardPos && clickHole ? clickHole.col - comp.boardPos.col : 0;

      if (isMulti && comp?.boardPos) {
        const b = computeBoardSelectionBounds(selIds, selectedWireIds, selectedCuts);
        multiDragRef.current = {
          moveIds: selIds,
          moveWireIds: selectedWireIds,
          moveCuts: selectedCuts,
          bodyCuts: bodyCutsOf(selIds, selectedCuts),
          anchorStartRow: comp.boardPos.row,
          anchorStartCol: comp.boardPos.col,
          startMinRow: b.minRow,
          startMinCol: b.minCol,
          startMaxRow: b.maxRow,
          startMaxCol: b.maxCol,
          appliedDRow: 0,
          appliedDCol: 0,
        };
      }

      setDragging({
        componentId,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
        rowOffset,
        colOffset,
        multi: isMulti,
      });
    },
    [boardTool, bodyCutsOf, components, board.rows, board.cols, getSVGPoint, selectedId, selectedIds, selectedWireIds, selectedCuts, setSelectedId, computeBoardSelectionBounds]
  );

  // Pressed on a wire: the run between its ends moves the wire, an end moves
  // alone. Selecting is for the select tool; with the cut tool up a plain
  // click goes on to the strip underneath.
  const handleWireGrab = useCallback(
    (wireId: string, part: WirePart, e: React.MouseEvent) => {
      if (readOnly || e.button !== 0) return;
      const wire = board.wires.find((w) => w.id === wireId);
      if (!wire) return;
      e.stopPropagation();
      e.preventDefault();
      pendingSnapshotRef.current = true;
      if (boardTool === "select") {
        clearSelection();
        setSelectedCuts([]);
        setSelectedWireIds([wireId]);
      }
      const pt = getSVGPoint(e);
      wireDragRef.current = {
        wireId, part,
        startX: e.clientX, startY: e.clientY, didDrag: false,
        grabHole: nearestHole(pt.x, pt.y, board.rows, board.cols),
        from: wire.from, to: wire.to,
      };
    },
    [readOnly, board.wires, board.rows, board.cols, boardTool, clearSelection, getSVGPoint]
  );

  // Pressed on a cut with the select tool: selects it, and a drag moves it
  const handleCutGrab = useCallback(
    (cut: Cut, e: React.MouseEvent) => {
      if (readOnly || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      pendingSnapshotRef.current = true;
      clearSelection();
      setSelectedWireIds([]);
      setSelectedCuts([cut]);
      const pt = getSVGPoint(e);
      cutDragRef.current = {
        startX: e.clientX, startY: e.clientY, didDrag: false,
        grabHole: nearestHole(pt.x, pt.y, board.rows, board.cols),
        origin: cut, at: cut,
      };
    },
    [readOnly, board.rows, board.cols, clearSelection, getSVGPoint]
  );

  // Start selection rectangle on mouseDown on empty SVG area
  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return; // right-click is pan
      if (wirePlacementFrom) return;
      // Only start selection rect if clicking directly on SVG background elements
      const target = e.target as Element;
      const isBackground = target.tagName === "svg" ||
        target.getAttribute("fill") === "url(#grid)" ||
        target.tagName === "circle" && target.getAttribute("stroke") === "var(--hole-stroke)"; // hole
      if (!isBackground) return;

      startSelectionRect(getSVGPoint(e));
      setSelectedWireIds([]);
      setSelectedCuts([]);
    },
    [getSVGPoint, wirePlacementFrom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panZoom.handlePanMove(e)) return;

      // Flexible pin drag
      if (flexPinDrag) {
        const pt = getSVGPoint(e);
        const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
        if (hole) {
          const comp = components.find((c) => c.id === flexPinDrag.componentId);
          if (comp && comp.boardPos) {
            if (flexPinDrag.pinId === "1") {
              // Only mutate (and snapshot) when pin 1 actually moves to a new hole
              if (hole.row !== comp.boardPos.row || hole.col !== comp.boardPos.col) {
                commitSnapshotOnce();
                // Lock pin 2 absolute position before moving pin 1
                if (!comp.flexibleEndPos) {
                  const def = resolveComponentDef(comp, componentDefs);
                  if (def) {
                    const pin2Offset = def.pins[1];
                    if (pin2Offset) {
                      setFlexibleEndPos(flexPinDrag.componentId, {
                        row: comp.boardPos.row + pin2Offset.offsetRow,
                        col: comp.boardPos.col + pin2Offset.offsetCol,
                      });
                    }
                  }
                }
                placeOnBoard(flexPinDrag.componentId, hole);
              }
            } else {
              const end = comp.flexibleEndPos;
              if (!end || hole.row !== end.row || hole.col !== end.col) {
                commitSnapshotOnce();
                setFlexibleEndPos(flexPinDrag.componentId, hole);
              }
            }
          }
        }
        return;
      }

      const wireDrag = wireDragRef.current;
      if (wireDrag) {
        if (!wireDrag.didDrag) {
          if (!checkDragThreshold(e.clientX, e.clientY, { ...wireDrag, componentId: wireDrag.wireId })) return;
          wireDrag.didDrag = true;
        }
        const pt = getSVGPoint(e);
        const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
        const wire = board.wires.find((w) => w.id === wireDrag.wireId);
        if (!hole || !wire) return;
        let { from, to } = wire;
        if (wireDrag.part === "whole") {
          if (!wireDrag.grabHole) return;
          const { from: f, to: t } = wireDrag;
          const clamp = (d: number, a: number, b: number, size: number) =>
            Math.max(-Math.min(a, b), Math.min(size - 1 - Math.max(a, b), d));
          const dRow = clamp(hole.row - wireDrag.grabHole.row, f.row, t.row, board.rows);
          const dCol = clamp(hole.col - wireDrag.grabHole.col, f.col, t.col, board.cols);
          from = { row: f.row + dRow, col: f.col + dCol };
          to = { row: t.row + dRow, col: t.col + dCol };
        } else {
          const other = wireDrag.part === "from" ? wire.to : wire.from;
          if (wireEndBlocked(hole) || (hole.row === other.row && hole.col === other.col)) return;
          if (wireDrag.part === "from") from = hole; else to = hole;
        }
        if (from.row !== wire.from.row || from.col !== wire.from.col || to.row !== wire.to.row || to.col !== wire.to.col) {
          commitSnapshotOnce();
          setWireEnds(wire.id, from, to);
        }
        return;
      }

      const cutDrag = cutDragRef.current;
      if (cutDrag) {
        if (!cutDrag.didDrag) {
          if (!checkDragThreshold(e.clientX, e.clientY, { ...cutDrag, componentId: "" })) return;
          cutDrag.didDrag = true;
        }
        const pt = getSVGPoint(e);
        const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
        if (!hole || !cutDrag.grabHole) return;
        const { origin, at } = cutDrag;
        const lastCol = board.cols - (origin.kind === "hole" ? 1 : 2);
        const target: Cut = {
          ...origin,
          row: Math.max(0, Math.min(board.rows - 1, origin.row + hole.row - cutDrag.grabHole.row)),
          col: Math.max(0, Math.min(lastCol, origin.col + hole.col - cutDrag.grabHole.col)),
        };
        // never onto another cut, nor a drill onto a hole that holds something
        if (sameCut(target, at) || board.cuts.some((c) => sameCut(c, target)) || cutBlocked(target)) return;
        commitSnapshotOnce();
        moveComponentsOnBoard([], target.row - at.row, target.col - at.col, [], [at]);
        cutDrag.at = target;
        setSelectedCuts([target]);
        return;
      }

      if (boardTool !== "select" && !readOnly) {
        const pt = getSVGPoint(e);
        const at = nearestHole(pt.x, pt.y, board.rows, board.cols);
        const next: Cut | null = boardTool === "cut"
          ? nearestCutTarget(pt.x, pt.y, board.rows, board.cols)
          : at && { ...at, kind: "hole" };
        setHover((prev) => (prev && next && sameCut(prev, next) ? prev : next));
      }

      // Wire preview line
      if (wirePlacementFrom) {
        setWireMousePos(getSVGPoint(e));
      }

      // Selection rectangle
      if (selectionRect) {
        const pt = getSVGPoint(e);
        updateSelectionRect(pt);
      }

      if (!dragging) return;
      if (!dragging.didDrag && checkDragThreshold(e.clientX, e.clientY, dragging)) {
        setDragging({ ...dragging, didDrag: true });
      }
      const pt = getSVGPoint(e);
      const mouseHole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      // Apply offset so the component doesn't snap to top-left corner
      const previewHole = mouseHole ? {
        row: mouseHole.row - dragging.rowOffset,
        col: mouseHole.col - dragging.colOffset,
      } : null;

      // Multi-drag: move the whole selection (components + wires + cuts) by the
      // incremental delta, reusing the same store action as arrow-key nudging.
      if (dragging.multi) {
        const plan = multiDragRef.current;
        if (dragging.didDrag && previewHole && plan) {
          // Desired total delta from drag start, clamped so the group's bounding
          // box stays fully on the board (no trailing item slides off the edge).
          const desiredDRow = previewHole.row - plan.anchorStartRow;
          const desiredDCol = previewHole.col - plan.anchorStartCol;
          const clampedDRow = Math.max(-plan.startMinRow, Math.min(board.rows - 1 - plan.startMaxRow, desiredDRow));
          const clampedDCol = Math.max(-plan.startMinCol, Math.min(board.cols - 1 - plan.startMaxCol, desiredDCol));
          const dRow = clampedDRow - plan.appliedDRow;
          const dCol = clampedDCol - plan.appliedDCol;
          if (dRow !== 0 || dCol !== 0) {
            commitSnapshotOnce();
            moveComponentsOnBoard(plan.moveIds, dRow, dCol, plan.moveWireIds, [...plan.moveCuts, ...plan.bodyCuts]);
            plan.bodyCuts = plan.bodyCuts.map((c) => ({ ...c, row: c.row + dRow, col: c.col + dCol }));
            if (plan.moveCuts.length > 0) {
              const shifted = plan.moveCuts.map((c) => ({ ...c, row: c.row + dRow, col: c.col + dCol }));
              plan.moveCuts = shifted;
              setSelectedCuts(shifted);
            }
            plan.appliedDRow = clampedDRow;
            plan.appliedDCol = clampedDCol;
          }
        }
        return;
      }

      setDragPreviewPos(previewHole);

      // Live-update position for instant strip recoloring
      if (dragging.didDrag && previewHole) {
        const comp = components.find((c) => c.id === dragging.componentId);
        if (comp?.boardPos && (previewHole.row !== comp.boardPos.row || previewHole.col !== comp.boardPos.col)) {
          commitSnapshotOnce();
          const dr = previewHole.row - comp.boardPos.row;
          const dc = previewHole.col - comp.boardPos.col;
          moveComponentsOnBoard([dragging.componentId], dr, dc, [], carriedCutsRef.current);
          carriedCutsRef.current = carriedCutsRef.current.map((c) => ({ ...c, row: c.row + dr, col: c.col + dc }));
        }
      }
    },
    [dragging, selectionRect, getSVGPoint, board.rows, board.cols, wirePlacementFrom, updateSelectionRect, checkDragThreshold, flexPinDrag, components, componentDefs, placeOnBoard, setFlexibleEndPos, commitSnapshotOnce, moveComponentsOnBoard, boardTool, readOnly, board.wires, board.cuts, wireEndBlocked, cutBlocked, setWireEnds]
  );

  const handleMouseUp = useCallback(() => {
    panZoom.handlePanEnd();
    // Gesture over: disarm a pending snapshot that was never triggered
    // (e.g. a click that selected without moving anything).
    const moved = !pendingSnapshotRef.current;
    pendingSnapshotRef.current = false;

    if (wireDragRef.current) {
      if (wireDragRef.current.didDrag) markDragComplete();
      wireDragRef.current = null;
      return;
    }
    if (cutDragRef.current) {
      if (cutDragRef.current.didDrag) markDragComplete();
      cutDragRef.current = null;
      return;
    }

    // End flexible pin drag
    if (flexPinDrag) {
      // with a tool up the click that follows would otherwise act where the leg landed
      if (moved && boardTool !== "select") markDragComplete();
      setFlexPinDrag(null);
      return;
    }

    // Finalize selection rectangle
    const rectHandled = finalizeSelectionRect((x1, y1, x2, y2) => {
      const selected: string[] = [];
      for (const comp of components) {
        if (!comp.boardPos) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        // Flexible parts span their two actual pin positions; their nominal
        // bounds ignore the dragged leg and would mis-select (see findComponentAtHole).
        const bounds = def.flexible
          ? getFlexibleBounds(comp, def)
          : getComponentBounds(def, comp.boardPos, comp.rotation);
        const compTopLeft = holeCenter(bounds.minRow, bounds.minCol);
        const compBottomRight = holeCenter(bounds.maxRow, bounds.maxCol);
        if (compTopLeft.x <= x2 && compBottomRight.x >= x1 &&
            compTopLeft.y <= y2 && compBottomRight.y >= y1) {
          selected.push(comp.id);
        }
      }

      // Select wires within rect
      const selWires: string[] = [];
      for (const wire of board.wires) {
        const fromPt = holeCenter(wire.from.row, wire.from.col);
        const toPt = holeCenter(wire.to.row, wire.to.col);
        if (fromPt.x >= x1 && fromPt.x <= x2 && fromPt.y >= y1 && fromPt.y <= y2 &&
            toPt.x >= x1 && toPt.x <= x2 && toPt.y >= y1 && toPt.y <= y2) {
          selWires.push(wire.id);
        }
      }

      // Select cuts within rect
      const selCuts: Cut[] = [];
      for (const cut of board.cuts) {
        const cutX = cut.kind === "hole"
          ? holeCenter(cut.row, cut.col).x
          : (holeCenter(cut.row, cut.col).x + holeCenter(cut.row, cut.col + 1).x) / 2;
        const cutY = holeCenter(cut.row, cut.col).y;
        if (cutX >= x1 && cutX <= x2 && cutY >= y1 && cutY <= y2) {
          selCuts.push({ ...cut });
        }
      }

      setSelectedWireIds(selWires);
      setSelectedCuts(selCuts);
      return selected;
    });
    if (rectHandled) return;

    if (dragging) {
      // A press on a part that went nowhere: with a tool up, the click is the tool's
      if (dragging.didDrag || boardTool === "select") markDragComplete();
      // Position already committed live during drag — no need to placeOnBoard here.
      // A real move can land a 2-pin part on the right nets but swapped: fix it.
      if (dragging.didDrag) {
        const movedIds = dragging.multi
          ? multiDragRef.current?.moveIds ?? []
          : [dragging.componentId];
        if (movedIds.length > 0) autoAlignPolarity(movedIds);
      }
    }
    setDragging(null);
    setDragPreviewPos(null);
    multiDragRef.current = null;
  }, [dragging, dragPreviewPos, components, componentDefs, board.wires, board.cuts, isValidPlacement, placeOnBoard, finalizeSelectionRect, markDragComplete, autoAlignPolarity, flexPinDrag, boardTool]);

  // ── Canvas click ────────────────────────────────────────
  // A click means what the tool in hand says: a cut, a wire end, or a selection.

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (shouldSuppressClick()) return;
      if (suppressNextCanvasClick) return;

      const pt = getSVGPoint(e);

      // Cut tool: the click lands on the nearest cut position, hole or gap,
      // with no dead zone between the two, and through whatever lies on top.
      if (boardTool === "cut") {
        const target = nearestCutTarget(pt.x, pt.y, board.rows, board.cols);
        if (!target) return;
        const existing = board.cuts.find((c) => sameCut(c, target));
        if (existing) removeCut(existing);
        else if (!cutBlocked(target)) placeCut(target);
        return;
      }

      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);

      // Wire tool: every click is a wire end. Wires already in the hole do
      // not matter, so a chain can hop on from where the last wire ended.
      if (boardTool === "wire") {
        if (!hole || wireEndBlocked(hole)) return;
        if (!wirePlacementFrom) {
          setWirePlacementFrom(hole);
        } else if (hole.row === wirePlacementFrom.row && hole.col === wirePlacementFrom.col) {
          cancelWirePlacement();
        } else {
          addWire(wirePlacementFrom, hole);
        }
        setWireMousePos(null);
        return;
      }

      // Select tool: a hole under a part picks the part, anything else lets go.
      if (hole) {
        const holePos = holeCenter(hole.row, hole.col);
        const compId = Math.sqrt((pt.x - holePos.x) ** 2 + (pt.y - holePos.y) ** 2) <= HOLE_RADIUS + 2
          ? findComponentAtHole(hole.row, hole.col)
          : null;
        if (compId) {
          setSelectedId(compId);
          return;
        }
      }

      clearSelection();
      setSelectedWireIds([]);
      setSelectedCuts([]);
    },
    [
      getSVGPoint, board, placeCut, removeCut, boardTool, cutBlocked, wireEndBlocked,
      wirePlacementFrom, setWirePlacementFrom, cancelWirePlacement, addWire,
      shouldSuppressClick, clearSelection, setSelectedId, findComponentAtHole,
    ]
  );

  // A right-click that did not pan: offer the row and column under the pointer.
  const openLineMenu = useCallback(
    (e: React.MouseEvent) => {
      const down = rightDownRef.current;
      rightDownRef.current = null;
      if (readOnly || !down || Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) return;
      const pt = getSVGPoint(e);
      const r = boardRect(board.rows, board.cols);
      const reach = HOLE_SPACING * 1.4; // takes in the row and column numbers
      if (pt.x < r.x - reach || pt.x > r.x + r.width + reach || pt.y < r.y - reach || pt.y > r.y + r.height + reach) return;
      const origin = holeCenter(0, 0);
      const snap = (v: number, size: number) => Math.max(0, Math.min(size - 1, Math.round(v / HOLE_SPACING)));
      setLineMenu({
        row: snap(pt.y - origin.y, board.rows),
        col: snap(pt.x - origin.x, board.cols),
        x: e.clientX,
        y: e.clientY,
      });
    },
    [readOnly, getSVGPoint, board.rows, board.cols]
  );

  const getDisplayPos = (comp: typeof components[0]) => {
    if (dragging?.componentId === comp.id && dragging.didDrag && dragPreviewPos) {
      return dragPreviewPos;
    }
    return comp.boardPos;
  };

  const hoverBlocked = !!hover && (boardTool === "cut"
    ? cutBlocked(hover) && !board.cuts.some((c) => sameCut(c, hover))
    : wireEndBlocked(hover));
  const cursorStyle = panZoom.isPanning.current
    ? "grabbing"
    : dragging?.didDrag
    ? "grabbing"
    : boardTool === "select"
    ? "default"
    : hoverBlocked
    ? "not-allowed"
    : "crosshair";

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="flex-1 overflow-hidden relative">
        <svg
          data-testid="stripboard-canvas"
          ref={(el) => {
            svgRef.current = el;
            panZoom.setTouchTarget(el);
          }}
          width="100%"
          height="100%"
          viewBox={panZoom.getViewBox(containerSize.width, containerSize.height)}
          className="font-sans bg-white dark:bg-[#1e1e1e]"
          style={{ cursor: cursorStyle }}
          onMouseDown={(e) => {
            if (e.button === 2) rightDownRef.current = { x: e.clientX, y: e.clientY };
            panZoom.handlePanStart(e);
            handleSvgMouseDown(e);
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseUp={(e) => {
            if (e.button === 2) openLineMenu(e);
            handleMouseUp();
          }}
          onMouseLeave={() => {
            panZoom.handlePanEnd();
            pendingSnapshotRef.current = false;
            wireDragRef.current = null;
            cutDragRef.current = null;
            rightDownRef.current = null;
            setHover(null);
            setDragging(null);
            setDragPreviewPos(null);
            multiDragRef.current = null;
            setWireMousePos(null);
            cancelSelectionRect();
          }}
          onWheel={panZoom.handleWheel}
          onContextMenu={panZoom.handleContextMenu}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={handleDragLeave}
        >
          {/* The laminate under the copper */}
          {(() => {
            const r = boardRect(board.rows, board.cols);
            return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={4}
              fill="var(--board-fill)" stroke="var(--board-edge)" strokeWidth={1} pointerEvents="none" />;
          })()}

          {/* Strip segments */}
          {segments.map((seg, i) => {
            const startCenter = holeCenter(seg.row, seg.startCol);
            const endCenter = holeCenter(seg.row, seg.endCol);
            const color = getSegmentColor(seg, i);
            const group = getGroupForSegment(connectivity, i);
            const hasNets = group ? group.netIds.length > 0 : seg.netIds.length > 0;
            const segNetIds = group ? group.netIds : seg.netIds;
            const isHighlighted = highlightedNetId !== null && segNetIds.includes(highlightedNetId);

            // A hole-cut drills out the hole: its isolated single-hole segment
            // draws no copper, and the neighbouring strips run up to the hole so
            // the break lands on it (not in the middle of the strip).
            const hasHoleCut = (col: number) =>
              board.cuts.some((c) => c.kind === "hole" && c.row === seg.row && c.col === col);
            const hasBetweenCut = (col: number) =>
              board.cuts.some((c) => c.kind !== "hole" && c.row === seg.row && c.col === col);
            if (seg.startCol === seg.endCol && hasHoleCut(seg.startCol)) return null;
            const HOLE_CUT_GAP = HOLE_RADIUS + 1.5;
            // Only run the strip up to a neighbouring hole-cut when no between-cut
            // sits in that gap — otherwise the extension would paint over the
            // between-cut's break.
            const extendLeft = hasHoleCut(seg.startCol - 1) && !hasBetweenCut(seg.startCol - 1);
            const extendRight = hasHoleCut(seg.endCol + 1) && !hasBetweenCut(seg.endCol);
            const leftX = extendLeft
              ? holeCenter(seg.row, seg.startCol - 1).x + HOLE_CUT_GAP
              : startCenter.x - HOLE_SPACING * 0.4;
            const rightX = extendRight
              ? holeCenter(seg.row, seg.endCol + 1).x - HOLE_CUT_GAP
              : endCenter.x + HOLE_SPACING * 0.4;
            const hlLeftX = extendLeft ? leftX : startCenter.x - HOLE_SPACING * 0.5;
            const hlRightX = extendRight ? rightX : endCenter.x + HOLE_SPACING * 0.5;

            return (
              <g key={`seg-${i}`}>
                {(isHighlighted || group?.hasConflict) && (
                  <rect
                    x={hlLeftX}
                    y={startCenter.y - STRIP_HEIGHT}
                    width={hlRightX - hlLeftX}
                    height={STRIP_HEIGHT * 2}
                    fill={group?.hasConflict ? STRIP_CONFLICT_COLOR : color}
                    opacity={0.3}
                    rx={2}
                  />
                )}
                <rect
                  x={leftX}
                  y={startCenter.y - STRIP_HEIGHT / 2}
                  width={rightX - leftX}
                  height={STRIP_HEIGHT}
                  fill={color}
                  opacity={isHighlighted ? 0.9 : group?.hasConflict ? 0.8 : hasNets ? 0.62 : 0.55}
                  rx={1}
                />
              </g>
            );
          })}

          {/* Row labels */}
          {Array.from({ length: board.rows }, (_, row) => {
            const center = holeCenter(row, 0);
            return (
              <text
                key={`rl-${row}`}
                x={center.x - 30}
                y={center.y + 4}
                textAnchor="end"
                fontSize={LABEL_FONT_SIZE}
                fill="var(--label-text)"
              >
                {row + 1}
              </text>
            );
          })}

          {/* Column labels */}
          {Array.from({ length: board.cols }, (_, col) => {
            const center = holeCenter(0, col);
            return (
              <text
                key={`cl-${col}`}
                x={center.x}
                y={center.y - 28}
                textAnchor="middle"
                fontSize={LABEL_FONT_SIZE}
                fill="var(--label-text)"
              >
                {col + 1}
              </text>
            );
          })}

          {/* Holes */}
          {Array.from({ length: board.rows }, (_, row) =>
            Array.from({ length: board.cols }, (_, col) => {
              const center = holeCenter(row, col);
              return (
                <circle
                  key={`h-${row}-${col}`}
                  cx={center.x}
                  cy={center.y}
                  r={HOLE_RADIUS}
                  fill="var(--hole-fill)"
                  stroke="var(--hole-stroke)"
                  strokeWidth={0.5}
                />
              );
            })
          )}

          <g>
          {components
            .filter((c) => c.boardPos !== null)
            .map((comp) => {
              const displayPos = getDisplayPos(comp);
              if (!displayPos) return null;
              let renderComp = comp;
              if (displayPos !== comp.boardPos && comp.boardPos) {
                const deltaRow = displayPos.row - comp.boardPos.row;
                const deltaCol = displayPos.col - comp.boardPos.col;
                renderComp = {
                  ...comp,
                  boardPos: displayPos,
                  flexibleEndPos: comp.flexibleEndPos ? {
                    row: comp.flexibleEndPos.row + deltaRow,
                    col: comp.flexibleEndPos.col + deltaCol,
                  } : comp.flexibleEndPos,
                };
              }
              return (
                <PlacedComponent
                  key={comp.id}
                  component={renderComp}
                  isSelected={comp.id === selectedId || selectedIds.includes(comp.id)}
                  clashing={clashing.has(comp.id)}
                  onMouseDown={(e) => handleComponentMouseDown(comp.id, e)}
                  readOnly={readOnly}
                  onPinDragStart={!readOnly ? (pinId, e) => {
                    e.stopPropagation();
                    // Defer snapshot until the leg actually moves (a click on a
                    // pin without a drag must not touch history/redo).
                    pendingSnapshotRef.current = true;
                    setFlexPinDrag({ componentId: comp.id, pinId });
                  } : undefined}
                />
              );
            })}

          {/* Wires */}
          {board.wires.map((wire) => {
            const { color, isConflict } = getWireColor(wire.id);
            const isSelected = selectedWireIds.includes(wire.id);
            return (
              <g key={wire.id}>
                {isSelected && (
                  <line
                    x1={holeCenter(wire.from.row, wire.from.col).x}
                    y1={holeCenter(wire.from.row, wire.from.col).y}
                    x2={holeCenter(wire.to.row, wire.to.col).x}
                    y2={holeCenter(wire.to.row, wire.to.col).y}
                    stroke="var(--selection-stroke)"
                    strokeWidth={6}
                    strokeOpacity={0.25}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                )}
                <WireLine
                  wire={wire}
                  color={color}
                  isConflict={isConflict}
                  offset={wireLaneOffset.get(wire.id)}
                  // the wire tool looks past wires, to the holes they sit in
                  onGrab={readOnly || boardTool === "wire" ? undefined : (part, e) => handleWireGrab(wire.id, part, e)}
                  // selecting is settled on the press; with the cut tool up the click goes on to the strip
                  onClick={boardTool === "select" ? (e) => e.stopPropagation() : undefined}
                  quiet={boardTool !== "select"}
                />
              </g>
            );
          })}

          {/* Wire placement preview */}
          {wirePlacementFrom && wireMousePos && (
            <line
              x1={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).x}
              y1={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).y}
              x2={wireMousePos.x}
              y2={wireMousePos.y}
              stroke="var(--selection-stroke)"
              strokeWidth={2}
              strokeDasharray="4 3"
              strokeLinecap="round"
              pointerEvents="none"
              opacity={0.6}
            />
          )}
          {wirePlacementFrom && (
            <circle
              cx={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).x}
              cy={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).y}
              r={5}
              fill="var(--selection-stroke)"
              opacity={0.6}
              pointerEvents="none"
            />
          )}

          </g>

          {/* Cut marks */}
          {board.cuts.map((cut, i) => {
            const isSelected = selectedCuts.some(
              (sc) => sc.row === cut.row && sc.col === cut.col && (sc.kind === "hole") === (cut.kind === "hole")
            );
            const cutCx = cut.kind === "hole"
              ? holeCenter(cut.row, cut.col).x
              : (holeCenter(cut.row, cut.col).x + holeCenter(cut.row, cut.col + 1).x) / 2;
            return (
              <g key={`cut-${i}`}>
                {isSelected && (
                  <circle
                    cx={cutCx}
                    cy={holeCenter(cut.row, cut.col).y}
                    r={10}
                    fill="var(--selection-stroke)"
                    opacity={0.15}
                    pointerEvents="none"
                  />
                )}
                <CutMark cut={cut} large={boardTool === "cut"} />
                {/* the select tool picks a cut up; the cut tool clicks through to take it away */}
                {!readOnly && boardTool === "select" && (
                  <circle
                    cx={cutCx}
                    cy={holeCenter(cut.row, cut.col).y}
                    r={8}
                    fill="transparent"
                    style={{ cursor: "move" }}
                    onMouseDown={(e) => handleCutGrab(cut, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </g>
            );
          })}

          {/* What a click would do with the tool in hand */}
          {hover && !hoverBlocked && boardTool === "cut" && (
            board.cuts.some((c) => sameCut(c, hover)) ? (
              <circle
                cx={holeCenter(hover.row, hover.col).x + (hover.kind === "hole" ? 0 : HOLE_SPACING / 2)}
                cy={holeCenter(hover.row, hover.col).y}
                r={11}
                fill="none"
                stroke="var(--cut-stroke)"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                pointerEvents="none"
              />
            ) : (
              <g opacity={0.4} pointerEvents="none">
                <CutMark cut={hover} large />
              </g>
            )
          )}
          {hover && !hoverBlocked && boardTool === "wire" && (
            <circle
              cx={holeCenter(hover.row, hover.col).x}
              cy={holeCenter(hover.row, hover.col).y}
              r={5}
              fill="var(--selection-stroke)"
              opacity={0.4}
              pointerEvents="none"
            />
          )}

          {/* Ghost preview for tray drag — render as component outline */}
          {trayGhost && (() => {
            const comp = components.find((c) => c.id === trayGhost.componentId);
            if (!comp) return null;
            const ghostDef = resolveComponentDef(comp, componentDefs);
            if (!ghostDef) return null;
            const ghostPos = { row: trayGhost.row, col: trayGhost.col };
            const ghostBounds = getComponentBounds(ghostDef, ghostPos, comp.rotation);
            const ghostTopLeft = holeCenter(ghostBounds.minRow, ghostBounds.minCol);
            const ghostPad = HOLE_SPACING * 0.4;
            const ghostPins = getRotatedPinPositions(ghostDef, ghostPos, comp.rotation);
            const ghostStyle = bodyStyle(ghostDef);
            const ghostPt = (i: number) => holeCenter(ghostPins[i].row, ghostPins[i].col);
            const rectGhost = (
              <rect
                x={ghostTopLeft.x - ghostPad}
                y={ghostTopLeft.y - ghostPad}
                width={(ghostBounds.maxCol - ghostBounds.minCol) * HOLE_SPACING + ghostPad * 2}
                height={(ghostBounds.maxRow - ghostBounds.minRow) * HOLE_SPACING + ghostPad * 2}
                rx={3}
                fill="var(--selection-fill)"
                stroke="var(--selection-stroke)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            );
            let ghostBody = rectGhost;
            let ghostNotch: React.ReactNode = null;
            if (ghostStyle === "belly" && ghostPins.length === 3) {
              ghostBody = (
                <path d={bellyPath(ghostPt(0), ghostPt(2), ghostPad)} fill="var(--selection-fill)" stroke="var(--selection-stroke)" strokeWidth={1.5} />
              );
            } else if (ghostStyle === "dip" && ghostPins.length >= 4) {
              const ghostCenter = holeCenter((ghostBounds.minRow + ghostBounds.maxRow) / 2, (ghostBounds.minCol + ghostBounds.maxCol) / 2);
              ghostNotch = (
                <path d={dipNotch(ghostPins.map((p) => ({ ...holeCenter(p.row, p.col), id: p.pinId })), ghostCenter, ghostPad)} fill="none" stroke="var(--selection-stroke)" strokeWidth={1.5} />
              );
            } else if (ghostStyle === "board" && ghostPins.length >= 4) {
              const ghostCenter = holeCenter((ghostBounds.minRow + ghostBounds.maxRow) / 2, (ghostBounds.minCol + ghostBounds.maxCol) / 2);
              const ghostRect = {
                x0: ghostTopLeft.x - ghostPad,
                y0: ghostTopLeft.y - ghostPad,
                x1: ghostTopLeft.x + (ghostBounds.maxCol - ghostBounds.minCol) * HOLE_SPACING + ghostPad,
                y1: ghostTopLeft.y + (ghostBounds.maxRow - ghostBounds.minRow) * HOLE_SPACING + ghostPad,
              };
              ghostNotch = (
                <path d={usbPort(ghostPins.map((p) => ({ ...holeCenter(p.row, p.col), id: p.pinId })), ghostCenter, ghostRect, HOLE_SPACING / 2.54)} fill="var(--selection-fill)" stroke="var(--selection-stroke)" strokeWidth={1.5} />
              );
            }
            return (
              <g pointerEvents="none" opacity={0.5}>
                {ghostBody}
                {ghostNotch}
                {ghostPins.map((pin) => {
                  const center = holeCenter(pin.row, pin.col);
                  return (
                    <circle
                      key={`${pin.pinId}-${pin.row}-${pin.col}`}
                      cx={center.x}
                      cy={center.y}
                      r={5}
                      fill="var(--selection-stroke)"
                      stroke="var(--hole-fill)"
                      strokeWidth={1.5}
                    />
                  );
                })}
              </g>
            );
          })()}

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

        {/* Selection actions — shown when a placed component is selected.
            No mirror: a stripboard is physical hardware, so a mirrored
            footprint can't be built with a real through-hole part. */}
        {!readOnly && selectedId && (() => {
          const comp = components.find((c) => c.id === selectedId);
          if (!comp || !comp.boardPos) return null;
          const def = resolveComponentDef(comp, componentDefs);
          const isFlexible = def?.flexible ?? false;
          const actions: CanvasAction[] = [];
          // A solder pad stands for one pin of an off-board part: it has no
          // package, footprint or rotation of its own, only a way back.
          const pad = isLead(comp) ? comp : null;
          const baseDef = componentDefs.find((d) => d.id === comp.defId);
          const options = baseDef && !pad ? packageOptions(baseDef) : [];
          if (pad) {
            // what this part's wires arrive at: loose pads, or one connector
            const parent = allComponents.find((c) => c.id === pad.leadOf.componentId);
            const current = parent?.offBoardPackage ?? "wire";
            const offBoardCount = allComponents.filter((c) => c.offBoard && !c.boardExcluded).length;
            actions.push({
              key: "connection",
              label: "Connector",
              title: `What this off-board part's wires arrive at (now: ${OFF_BOARD_CONNECTIONS.find((o) => o.id === current)?.name ?? ""})`,
              icon: PackageIcon,
              onClick: () => {},
              menu: [
                ...OFF_BOARD_CONNECTIONS.map((o) => ({
                  key: o.id,
                  label: o.name,
                  checked: o.id === current,
                  title: "Changes the shape, so it goes back to the unplaced list",
                  onClick: () => {
                    setOffBoardPackage(pad.leadOf.componentId, o.id, "one");
                    clearSelection();
                  },
                })),
                ...(offBoardCount > 1 ? [{
                  key: "all",
                  label: `Apply to all ${offBoardCount} off-board parts`,
                  separated: true,
                  onClick: () => {
                    setOffBoardPackage(pad.leadOf.componentId, current, "all");
                    clearSelection();
                  },
                }] : []),
              ],
            });
          }
          if (baseDef && options.length > 1) {
            const current = (comp.package && options.some((o) => o.id === comp.package))
              ? comp.package
              : defaultPackageId(baseDef, comp.value);
            const sameType = components.filter((c) => c.defId === comp.defId).length;
            const currentName = options.find((o) => o.id === current)?.name ?? "";
            actions.push({
              key: "package",
              label: "Package",
              title: `Which real part this is drawn as (now: ${currentName})`,
              icon: PackageIcon,
              onClick: () => {},
              menu: [
                ...options.map((o) => ({
                  key: o.id,
                  label: o.movesPins ? `${o.name} (moves pins)` : o.name,
                  checked: o.id === current,
                  title: o.movesPins
                    ? "Changes the footprint: the part stays with its first pin where it is, or goes back to the unplaced list if it no longer fits"
                    : undefined,
                  onClick: () => setComponentPackage(selectedId, o.id, "one"),
                })),
                ...(sameType > 1 && current ? [{
                  key: "all",
                  label: `Apply to all ${sameType} of this part`,
                  separated: true,
                  onClick: () => setComponentPackage(selectedId, current, "type"),
                }] : []),
              ],
            });
          }
          if (!isFlexible && onEditFootprint && !pad) {
            actions.push({
              key: "footprint",
              label: "Edit Footprint",
              title: "Edit this component's footprint",
              icon: FootprintIcon,
              onClick: () => onEditFootprint(selectedId),
            });
          }
          if (!pad || pad.leadOf.pinId === GROUP_PIN) {
            actions.push({
              key: "rotate",
              label: "Rotate",
              title: "Rotate selected component 90°",
              shortcut: "R",
              icon: RotateIcon,
              onClick: () => rotateComponent(selectedId),
            });
          }
          actions.push(pad
            ? {
                key: "onboard",
                label: "Mount on board",
                title: "Put the part itself back on the board; its solder pads go away",
                icon: OffBoardIcon,
                onClick: () => {
                  setOffBoard(pad.leadOf.componentId, false);
                  clearSelection();
                },
              }
            : {
                key: "offboard",
                label: "Mount off board",
                title: "The part is mounted off the board and wired to it: each wired pin becomes a solder pad you place",
                icon: OffBoardIcon,
                onClick: () => {
                  setOffBoard(selectedId, true);
                  clearSelection();
                },
              });
          actions.push({
            key: "lock",
            label: comp.locked ? "Unlock" : "Lock",
            title: comp.locked
              ? "Unlock: auto-layout may move this component again"
              : "Lock in place: auto-layout will never move this component",
            shortcut: "L",
            icon: comp.locked ? UnlockIcon : LockIcon,
            onClick: () => toggleBoardLock(selectedId),
          });
          actions.push({
            key: "delete",
            label: "Delete",
            title: "Remove selected component from board",
            shortcut: "Del",
            icon: DeleteIcon,
            variant: "danger",
            onClick: () => {
              removeFromBoard(selectedId);
              clearSelection();
            },
          });
          return <SelectionActionBar actions={actions} />;
        })()}

        {/* Multi-selection actions */}
        {!readOnly && !selectedId && selectedIds.length > 1 && (() => {
          const actions: CanvasAction[] = [];
          if (onAutoLayoutSelection) {
            actions.push({
              key: "relayout",
              label: `Re-layout ${selectedIds.length}`,
              title: "Re-place only the selected components; everything else stays put (cuts and wires are regenerated)",
              icon: WandIcon,
              onClick: () => onAutoLayoutSelection(selectedIds),
            });
          }
          const allLocked = selectedIds.every((id) => components.find((c) => c.id === id)?.locked);
          actions.push({
            key: "lock",
            label: allLocked ? `Unlock ${selectedIds.length}` : `Lock ${selectedIds.length}`,
            title: allLocked
              ? "Unlock these components: auto-layout may move them again"
              : "Lock these components in place: auto-layout will never move them",
            shortcut: "L",
            icon: allLocked ? UnlockIcon : LockIcon,
            onClick: () => setBoardLock(selectedIds, !allLocked),
          });
          {
            // pads go back to their parts, anything else goes off the board
            const picked = components.filter((c) => selectedIds.includes(c.id));
            const parents = [...new Set(picked.filter(isLead).map((c) => c.leadOf.componentId))];
            const real = picked.filter((c) => !isLead(c));
            const back = real.length === 0 && parents.length > 0;
            if (back || real.length > 0) {
              actions.push({
                key: "offboard",
                label: back ? `Mount ${parents.length} on board` : `Mount ${real.length} off board`,
                title: back
                  ? "Put these parts themselves back on the board; their solder pads go away"
                  : "These parts are mounted off the board and wired to it: each wired pin becomes a solder pad you place",
                icon: OffBoardIcon,
                onClick: () => {
                  transact(() => (back ? parents.forEach((id) => setOffBoard(id, false)) : real.forEach((c) => setOffBoard(c.id, true))));
                  clearSelection();
                },
              });
            }
          }
          actions.push({
            key: "delete",
            label: `Delete ${selectedIds.length}`,
            title: "Remove the selected components from the board",
            shortcut: "Del",
            icon: DeleteIcon,
            variant: "danger",
            onClick: () => {
              transact(() => {
                for (const id of selectedIds) removeFromBoard(id);
              });
              clearSelection();
            },
          });
          return <SelectionActionBar actions={actions} />;
        })()}

        {/* Selected link wires and cuts */}
        {!readOnly && !selectedId && selectedIds.length === 0 && selectedWireIds.length + selectedCuts.length > 0 && (() => {
          const w = selectedWireIds.length;
          const c = selectedCuts.length;
          const label = w && c ? `Delete ${w + c} items`
            : w ? (w > 1 ? `Delete ${w} wires` : "Delete wire")
            : c > 1 ? `Delete ${c} cuts` : "Delete cut";
          return (
            <SelectionActionBar
              actions={[{
                key: "delete",
                label,
                title: "Remove the selected link wires and cuts",
                shortcut: "Del",
                icon: DeleteIcon,
                variant: "danger",
                onClick: () => {
                  transact(() => {
                    selectedWireIds.forEach((id) => removeWire(id));
                    selectedCuts.forEach((cut) => removeCut(cut));
                  });
                  setSelectedWireIds([]);
                  setSelectedCuts([]);
                },
              }]}
            />
          );
        })()}

        {!readOnly && <BoardTools tool={boardTool} onChange={setBoardTool} />}

        {/* Row and column menu (right-click on the board) */}
        {lineMenu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setLineMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setLineMenu(null);
              }}
            />
            <div
              className="fixed z-50 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg dark:shadow-neutral-900/50 py-1"
              style={{
                left: Math.min(lineMenu.x, window.innerWidth - 240),
                top: Math.min(lineMenu.y, window.innerHeight - 230),
              }}
            >
              {([
                { axis: "row", label: `Insert row above ${lineMenu.row + 1}`, at: lineMenu.row },
                { axis: "row", label: `Insert row below ${lineMenu.row + 1}`, at: lineMenu.row + 1 },
                { axis: "col", label: `Insert column left of ${lineMenu.col + 1}`, at: lineMenu.col, divided: true },
                { axis: "col", label: `Insert column right of ${lineMenu.col + 1}`, at: lineMenu.col + 1 },
                { axis: "row", label: `Delete row ${lineMenu.row + 1}`, at: lineMenu.row, remove: true, divided: true },
                { axis: "col", label: `Delete column ${lineMenu.col + 1}`, at: lineMenu.col, remove: true },
              ] as { axis: "row" | "col"; label: string; at: number; remove?: boolean; divided?: boolean }[]).map(({ axis, label, at, remove, divided }) => (
                <button
                  key={label}
                  className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
                    remove ? "text-red-600 dark:text-red-400" : "text-neutral-700 dark:text-neutral-200"
                  } ${divided ? "border-t border-neutral-200 dark:border-neutral-700" : ""}`}
                  title={remove ? "Parts on this line are unplaced; parts and wires spanning it shrink to close the gap" : undefined}
                  onClick={() => {
                    if (remove) deleteBoardLine(axis, at);
                    else insertBoardLine(axis, at);
                    setLineMenu(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Zoom controls overlay */}
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
    </div>
  );
}
