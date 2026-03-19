"use client";

import { useRef, useState, useCallback, useEffect } from "react";
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
  nearestCutPosition,
  getComponentBounds,
  getRotatedPinPositions,
} from "./boardLayout";
import {
  getGroupForSegment,
  getGroupForWire,
} from "./connectivity";
import { StripSegment } from "./stripSegments";
import PlacedComponent from "./PlacedComponent";
import CutMark from "./CutMark";
import WireLine from "./WireLine";

export default function StripboardCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom();
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
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const placeOnBoard = useProjectStore((s) => s.placeOnBoard);
  const placeCut = useProjectStore((s) => s.placeCut);
  const removeCut = useProjectStore((s) => s.removeCut);
  const addWire = useProjectStore((s) => s.addWire);
  const removeWire = useProjectStore((s) => s.removeWire);
  const wirePlacementMode = useProjectStore((s) => s.wirePlacementMode);
  const wirePlacementFrom = useProjectStore((s) => s.wirePlacementFrom);
  const setWirePlacementFrom = useProjectStore((s) => s.setWirePlacementFrom);
  const cancelWirePlacement = useProjectStore((s) => s.cancelWirePlacement);
  const startWirePlacement = useProjectStore((s) => s.startWirePlacement);
  const trayDragComponentId = useProjectStore((s) => s.trayDragComponentId);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);
  const setFlexibleEndPos = useProjectStore((s) => s.setFlexibleEndPos);

  const nets = useProjectStore((s) => s.nets);

  const { segments, connectivity } = useStripSegments();


  const {
    selectedId, setSelectedId,
    selectedIds, setSelectedIds,
    selectionRect,
    startSelectionRect, updateSelectionRect, finalizeSelectionRect, cancelSelectionRect,
    checkDragThreshold, shouldSuppressClick, markDragComplete,
    clearSelection,
  } = useCanvasSelection();

  const [selectedWireIds, setSelectedWireIds] = useState<string[]>([]);
  const [selectedCuts, setSelectedCuts] = useState<{ row: number; col: number }[]>([]);
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
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const removeFromBoard = useProjectStore((s) => s.removeFromBoard);
  const moveComponentsOnBoard = useProjectStore((s) => s.moveComponentsOnBoard);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") {
        if (wirePlacementFrom) {
          cancelWirePlacement();
          setWireMousePos(null);
        }
        if (selectedIds.length > 0) {
          setSelectedIds([]);
          setSelectedWireIds([]);
          setSelectedCuts([]);
        }
        return;
      }

      // Arrow keys: move selected components, wires, and cuts
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      const hasSelection = moveIds.length > 0 || selectedWireIds.length > 0 || selectedCuts.length > 0;
      if (hasSelection && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        pushSnapshot();
        const delta = {
          ArrowUp: { row: -1, col: 0 },
          ArrowDown: { row: 1, col: 0 },
          ArrowLeft: { row: 0, col: -1 },
          ArrowRight: { row: 0, col: 1 },
        }[e.key]!;
        moveComponentsOnBoard(moveIds, delta.row, delta.col, selectedWireIds, selectedCuts);
        if (selectedCuts.length > 0) {
          setSelectedCuts((prev) =>
            prev.map((c) => ({ row: c.row + delta.row, col: c.col + delta.col }))
          );
        }
        return;
      }

      if (selectedId) {
        if (e.key === "r" || e.key === "R") {
          rotateComponent(selectedId);
        } else if (e.key === "Delete") {
          removeFromBoard(selectedId);
          setSelectedId(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wirePlacementFrom, cancelWirePlacement, selectedId, selectedIds, selectedWireIds, selectedCuts, rotateComponent, removeFromBoard, moveComponentsOnBoard, pushSnapshot]);


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
        const bounds = getComponentBounds(def, comp.boardPos, comp.rotation);
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
        placeOnBoard(componentId, hole);
      }
      setTrayGhost(null);
    },
    [getSVGPoint, board.rows, board.cols, isValidPlacement, placeOnBoard]
  );

  const handleDragLeave = useCallback(() => {
    setTrayGhost(null);
  }, []);

  // ── On-board component dragging ─────────────────────────

  const handleComponentMouseDown = useCallback(
    (componentId: string, e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return; // right-click is pan
      if (wirePlacementMode || wirePlacementFrom) return;
      e.stopPropagation();
      e.preventDefault();
      pushSnapshot();
      setSelectedId(componentId);

      // Compute offset: where within the component the user clicked
      const comp = components.find((c) => c.id === componentId);
      const pt = getSVGPoint(e);
      const clickHole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      const rowOffset = comp?.boardPos && clickHole ? clickHole.row - comp.boardPos.row : 0;
      const colOffset = comp?.boardPos && clickHole ? clickHole.col - comp.boardPos.col : 0;

      setDragging({
        componentId,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
        rowOffset,
        colOffset,
      });
    },
    [wirePlacementMode, wirePlacementFrom, components, board.rows, board.cols, getSVGPoint]
  );

  // Start selection rectangle on mouseDown on empty SVG area
  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (e.button === 2) return; // right-click is pan
      if (wirePlacementFrom || wirePlacementMode) return;
      // Only start selection rect if clicking directly on SVG background elements
      const target = e.target as Element;
      const isBackground = target.tagName === "svg" ||
        target.getAttribute("fill") === "url(#grid)" ||
        target.tagName === "circle" && target.getAttribute("stroke") === "#d4d4d4"; // hole
      if (!isBackground) return;

      const pt = getSVGPoint(e);
      // Don't start rect if near a hole (that's for wire drawing)
      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      if (hole) {
        const holePos = holeCenter(hole.row, hole.col);
        const dist = Math.sqrt((pt.x - holePos.x) ** 2 + (pt.y - holePos.y) ** 2);
        if (dist <= HOLE_RADIUS + 2) return;
      }

      startSelectionRect(pt);
      setSelectedWireIds([]);
      setSelectedCuts([]);
    },
    [getSVGPoint, board.rows, board.cols, wirePlacementFrom, wirePlacementMode]
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
            } else {
              setFlexibleEndPos(flexPinDrag.componentId, hole);
            }
          }
        }
        return;
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
      setDragPreviewPos(previewHole);

      // Live-update position for instant strip recoloring
      if (dragging.didDrag && previewHole) {
        const comp = components.find((c) => c.id === dragging.componentId);
        if (comp?.boardPos && (previewHole.row !== comp.boardPos.row || previewHole.col !== comp.boardPos.col)) {
          const dDef = resolveComponentDef(comp, componentDefs);
          if (dDef?.flexible && comp.flexibleEndPos) {
            const dr = previewHole.row - comp.boardPos.row;
            const dc = previewHole.col - comp.boardPos.col;
            setFlexibleEndPos(dragging.componentId, {
              row: comp.flexibleEndPos.row + dr,
              col: comp.flexibleEndPos.col + dc,
            });
          }
          placeOnBoard(dragging.componentId, previewHole);
        }
      }
    },
    [dragging, selectionRect, getSVGPoint, board.rows, board.cols, wirePlacementFrom, updateSelectionRect, checkDragThreshold, flexPinDrag, components, placeOnBoard, setFlexibleEndPos]
  );

  const handleMouseUp = useCallback(() => {
    panZoom.handlePanEnd();

    // End flexible pin drag
    if (flexPinDrag) {
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
        const bounds = getComponentBounds(def, comp.boardPos, comp.rotation);
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
      const selCuts: { row: number; col: number }[] = [];
      for (const cut of board.cuts) {
        const cutX = (holeCenter(cut.row, cut.col).x + holeCenter(cut.row, cut.col + 1).x) / 2;
        const cutY = holeCenter(cut.row, cut.col).y;
        if (cutX >= x1 && cutX <= x2 && cutY >= y1 && cutY <= y2) {
          selCuts.push({ row: cut.row, col: cut.col });
        }
      }

      setSelectedWireIds(selWires);
      setSelectedCuts(selCuts);
      return selected;
    });
    if (rectHandled) return;

    if (dragging) {
      markDragComplete();
      // Position already committed live during drag — no need to placeOnBoard here
    }
    setDragging(null);
    setDragPreviewPos(null);
  }, [dragging, dragPreviewPos, components, componentDefs, board.wires, board.cuts, isValidPlacement, placeOnBoard, finalizeSelectionRect, markDragComplete]);

  // ── Canvas click ────────────────────────────────────────
  // Priority: skip if just dragged → wire drawing → cut toggle → deselect

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (shouldSuppressClick()) return;

      const pt = getSVGPoint(e);

      // Wire drawing: if we already have a "from" hole, complete the wire
      if (wirePlacementFrom) {
        const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
        if (hole && (hole.row !== wirePlacementFrom.row || hole.col !== wirePlacementFrom.col)) {
          addWire(wirePlacementFrom, hole);
        }
        setWireMousePos(null);
        return;
      }

      // Check if click is on a hole — start wire drawing
      // But NOT if the hole is occupied by a component
      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      if (hole) {
        const holePos = holeCenter(hole.row, hole.col);
        const dist = Math.sqrt((pt.x - holePos.x) ** 2 + (pt.y - holePos.y) ** 2);
        if (dist <= HOLE_RADIUS + 2) {
          // If occupied by a component, select it instead
          const compId = findComponentAtHole(hole.row, hole.col);
          if (compId) {
            setSelectedId(compId);
            return;
          }
          startWirePlacement();
          setWirePlacementFrom(hole);
          return;
        }
      }

      // Cut toggle — only between holes (tighter hitbox)
      const cutPos = nearestCutPosition(pt.x, pt.y, board.rows, board.cols);
      if (cutPos) {
        const existing = board.cuts.find(
          (c) => c.row === cutPos.row && c.col === cutPos.col
        );
        if (existing) {
          removeCut(cutPos);
        } else {
          placeCut(cutPos);
        }
        return;
      }

      clearSelection();
      setSelectedWireIds([]);
      setSelectedCuts([]);
    },
    [
      getSVGPoint, board, placeCut, removeCut,
      wirePlacementFrom, setWirePlacementFrom, addWire, startWirePlacement,
      shouldSuppressClick, clearSelection, setSelectedId, findComponentAtHole,
    ]
  );

  const getDisplayPos = (comp: typeof components[0]) => {
    if (dragging?.componentId === comp.id && dragging.didDrag && dragPreviewPos) {
      return dragPreviewPos;
    }
    return comp.boardPos;
  };

  const cursorStyle = panZoom.isPanning.current
    ? "grabbing"
    : wirePlacementFrom
    ? "crosshair"
    : dragging?.didDrag
    ? "grabbing"
    : "default";

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="flex-1 overflow-hidden relative">
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={panZoom.getViewBox(containerSize.width, containerSize.height)}
          className="bg-white"
          style={{ cursor: cursorStyle }}
          onMouseDown={(e) => {
            panZoom.handlePanStart(e);
            handleSvgMouseDown(e);
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            panZoom.handlePanEnd();
            setDragging(null);
            setDragPreviewPos(null);
            setWireMousePos(null);
            cancelSelectionRect();
          }}
          onWheel={panZoom.handleWheel}
          onContextMenu={panZoom.handleContextMenu}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={handleDragLeave}
        >
          {/* Strip segments */}
          {segments.map((seg, i) => {
            const startCenter = holeCenter(seg.row, seg.startCol);
            const endCenter = holeCenter(seg.row, seg.endCol);
            const color = getSegmentColor(seg, i);
            const group = getGroupForSegment(connectivity, i);
            const hasNets = group ? group.netIds.length > 0 : seg.netIds.length > 0;
            const segNetIds = group ? group.netIds : seg.netIds;
            const isHighlighted = highlightedNetId !== null && segNetIds.includes(highlightedNetId);

            return (
              <g key={`seg-${i}`}>
                {(isHighlighted || group?.hasConflict) && (
                  <rect
                    x={startCenter.x - HOLE_SPACING * 0.5}
                    y={startCenter.y - STRIP_HEIGHT}
                    width={endCenter.x - startCenter.x + HOLE_SPACING}
                    height={STRIP_HEIGHT * 2}
                    fill={group?.hasConflict ? STRIP_CONFLICT_COLOR : color}
                    opacity={0.3}
                    rx={2}
                  />
                )}
                <rect
                  x={startCenter.x - HOLE_SPACING * 0.4}
                  y={startCenter.y - STRIP_HEIGHT / 2}
                  width={endCenter.x - startCenter.x + HOLE_SPACING * 0.8}
                  height={STRIP_HEIGHT}
                  fill={color}
                  opacity={isHighlighted ? 0.9 : group?.hasConflict ? 0.8 : hasNets ? 0.5 : 0.4}
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
                fill="#737373"
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
                fill="#737373"
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
                  fill="white"
                  stroke="#d4d4d4"
                  strokeWidth={0.5}
                />
              );
            })
          )}

          {/* Placed components */}
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
                  onMouseDown={(e) => handleComponentMouseDown(comp.id, e)}
                  onPinDragStart={!readOnly ? (pinId, e) => {
                    e.stopPropagation();
                    pushSnapshot();
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
                    stroke="#113768"
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
                  onClick={() => { if (!readOnly && !wirePlacementFrom) removeWire(wire.id); }}
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
              stroke="#113768"
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
              fill="#113768"
              opacity={0.6}
              pointerEvents="none"
            />
          )}

          {/* Cut marks */}
          {board.cuts.map((cut, i) => {
            const isSelected = selectedCuts.some((sc) => sc.row === cut.row && sc.col === cut.col);
            return (
              <g key={`cut-${i}`}>
                {isSelected && (
                  <circle
                    cx={(holeCenter(cut.row, cut.col).x + holeCenter(cut.row, cut.col + 1).x) / 2}
                    cy={holeCenter(cut.row, cut.col).y}
                    r={10}
                    fill="#113768"
                    opacity={0.15}
                    pointerEvents="none"
                  />
                )}
                <CutMark cut={cut} />
              </g>
            );
          })}

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
            return (
              <g pointerEvents="none" opacity={0.5}>
                <rect
                  x={ghostTopLeft.x - ghostPad}
                  y={ghostTopLeft.y - ghostPad}
                  width={(ghostBounds.maxCol - ghostBounds.minCol) * HOLE_SPACING + ghostPad * 2}
                  height={(ghostBounds.maxRow - ghostBounds.minRow) * HOLE_SPACING + ghostPad * 2}
                  rx={3}
                  fill="rgba(17, 55, 104, 0.1)"
                  stroke="#113768"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                {ghostPins.map((pin) => {
                  const center = holeCenter(pin.row, pin.col);
                  return (
                    <circle
                      key={pin.pinId}
                      cx={center.x}
                      cy={center.y}
                      r={5}
                      fill="#113768"
                      stroke="white"
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
              fill="rgba(17, 55, 104, 0.08)"
              stroke="#113768"
              strokeWidth={1}
              strokeDasharray="4 2"
              pointerEvents="none"
            />
          )}
        </svg>
        {/* Zoom controls overlay */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-white/90 border border-neutral-200 rounded-md px-1.5 py-1 shadow-sm text-xs text-neutral-600">
          <button
            onClick={() => panZoom.resetView()}
            className="px-1.5 py-0.5 hover:bg-neutral-100 rounded transition-colors"
            title="Reset view"
          >
            {Math.round(panZoom.zoom * 100)}%
          </button>
        </div>
      </div>
    </div>
  );
}
