"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./netCompleteness";
import {
  HOLE_SPACING,
  HOLE_RADIUS,
  BOARD_PADDING,
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
import { trayDragComponentId } from "./trayDragState";

export default function StripboardCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);

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

  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const { segments, connectivity, conflictCount } = useStripSegments();

  const incompleteNets = useMemo(
    () => checkNetCompleteness(nets, netAssignments, segments, connectivity, components, componentDefs),
    [nets, netAssignments, segments, connectivity, components, componentDefs]
  );

  const allPlaced = components.length >= 2 && components.every((c) => c.boardPos !== null);
  const allDone = allPlaced && conflictCount === 0 && incompleteNets.length === 0;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionRect, setSelectionRect] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
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
  } | null>(null);
  const [dragPreviewPos, setDragPreviewPos] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [wireMousePos, setWireMousePos] = useState<{ x: number; y: number } | null>(null);

  // Track whether a drag just completed to suppress the click event
  const justDraggedRef = useRef(false);

  const rotateComponent = useProjectStore((s) => s.rotateComponent);
  const removeFromBoard = useProjectStore((s) => s.removeFromBoard);
  const moveComponentsOnBoard = useProjectStore((s) => s.moveComponentsOnBoard);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (wirePlacementFrom) {
          cancelWirePlacement();
          setWireMousePos(null);
        }
        if (selectedIds.length > 0) {
          setSelectedIds([]);
        }
        return;
      }

      // Arrow keys: move selected components
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      if (moveIds.length > 0 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const delta = {
          ArrowUp: { row: -1, col: 0 },
          ArrowDown: { row: 1, col: 0 },
          ArrowLeft: { row: 0, col: -1 },
          ArrowRight: { row: 0, col: 1 },
        }[e.key]!;
        moveComponentsOnBoard(moveIds, delta.row, delta.col);
        return;
      }

      if (selectedId) {
        if (e.key === "r" || e.key === "R") {
          rotateComponent(selectedId);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          removeFromBoard(selectedId);
          setSelectedId(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wirePlacementFrom, cancelWirePlacement, selectedId, selectedIds, rotateComponent, removeFromBoard, moveComponentsOnBoard]);

  const svgWidth = BOARD_PADDING * 2 + (board.cols - 1) * HOLE_SPACING;
  const svgHeight = BOARD_PADDING * 2 + (board.rows - 1) * HOLE_SPACING;

  const getSVGPoint = useCallback((e: React.MouseEvent | React.DragEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

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
      if (group.hasConflict) return { color: "#ef4444", isConflict: true };
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
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const pt = getSVGPoint(e);
      const hole = nearestHole(pt.x, pt.y, board.rows, board.cols);
      if (hole) {
        setTrayGhost({ ...hole, componentId: trayDragComponentId });
      } else {
        setTrayGhost(null);
      }
    },
    [getSVGPoint, board.rows, board.cols]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
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
      if (wirePlacementMode || wirePlacementFrom) return;
      e.stopPropagation();
      e.preventDefault();
      setSelectedId(componentId);
      setDragging({
        componentId,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
      });
    },
    [wirePlacementMode, wirePlacementFrom]
  );

  // Start selection rectangle on mouseDown on empty SVG area
  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
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

      setSelectionRect({ startX: pt.x, startY: pt.y, currentX: pt.x, currentY: pt.y });
      setSelectedIds([]);
    },
    [getSVGPoint, board.rows, board.cols, wirePlacementFrom, wirePlacementMode]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Wire preview line
      if (wirePlacementFrom) {
        setWireMousePos(getSVGPoint(e));
      }

      // Selection rectangle
      if (selectionRect) {
        const pt = getSVGPoint(e);
        setSelectionRect({ ...selectionRect, currentX: pt.x, currentY: pt.y });
      }

      if (!dragging) return;
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      if (!dragging.didDrag && Math.sqrt(dx * dx + dy * dy) > 4) {
        setDragging({ ...dragging, didDrag: true });
      }
      const pt = getSVGPoint(e);
      setDragPreviewPos(nearestHole(pt.x, pt.y, board.rows, board.cols));
    },
    [dragging, selectionRect, getSVGPoint, board.rows, board.cols, wirePlacementFrom]
  );

  const handleMouseUp = useCallback(() => {
    // Finalize selection rectangle
    if (selectionRect) {
      const x1 = Math.min(selectionRect.startX, selectionRect.currentX);
      const y1 = Math.min(selectionRect.startY, selectionRect.currentY);
      const x2 = Math.max(selectionRect.startX, selectionRect.currentX);
      const y2 = Math.max(selectionRect.startY, selectionRect.currentY);

      // Only select if rect is big enough (not a click)
      if (x2 - x1 > 10 || y2 - y1 > 10) {
        const selected: string[] = [];
        for (const comp of components) {
          if (!comp.boardPos) continue;
          const def = resolveComponentDef(comp, componentDefs);
          if (!def) continue;
          const bounds = getComponentBounds(def, comp.boardPos, comp.rotation);
          const compTopLeft = holeCenter(bounds.minRow, bounds.minCol);
          const compBottomRight = holeCenter(bounds.maxRow, bounds.maxCol);
          // Check intersection
          if (compTopLeft.x <= x2 && compBottomRight.x >= x1 &&
              compTopLeft.y <= y2 && compBottomRight.y >= y1) {
            selected.push(comp.id);
          }
        }
        setSelectedIds(selected);
        setSelectedId(null);
        justDraggedRef.current = true;
      }
      setSelectionRect(null);
      return;
    }

    if (dragging) {
      justDraggedRef.current = true;
      if (dragging.didDrag && dragPreviewPos && isValidPlacement(dragging.componentId, dragPreviewPos)) {
        placeOnBoard(dragging.componentId, dragPreviewPos);
      }
    }
    setDragging(null);
    setDragPreviewPos(null);
  }, [dragging, dragPreviewPos, selectionRect, components, componentDefs, isValidPlacement, placeOnBoard]);

  // ── Canvas click ────────────────────────────────────────
  // Priority: skip if just dragged → wire drawing → cut toggle → deselect

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      // Suppress click after drag release
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }

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

      setSelectedId(null);
      setSelectedIds([]);
    },
    [
      getSVGPoint, board, placeCut, removeCut,
      wirePlacementFrom, setWirePlacementFrom, addWire, startWirePlacement,
    ]
  );

  const getDisplayPos = (comp: typeof components[0]) => {
    if (dragging?.componentId === comp.id && dragging.didDrag && dragPreviewPos) {
      return dragPreviewPos;
    }
    return comp.boardPos;
  };

  const cursorStyle = wirePlacementFrom
    ? "crosshair"
    : dragging?.didDrag
    ? "grabbing"
    : "default";

  return (
    <div className="flex flex-col h-full">
      {allDone && (
        <div className="bg-green-50 border-b border-green-200 px-4 py-1 text-xs text-green-700">
          All done — all components placed, no conflicts, all nets connected
        </div>
      )}
      {conflictCount > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-1 text-xs text-red-700">
          {conflictCount} connectivity conflict{conflictCount > 1 ? "s" : ""} — place cuts or rearrange components
        </div>
      )}
      {selectedIds.length > 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-1 text-xs text-blue-700">
          {selectedIds.length} components selected — arrow keys to move, Escape to deselect
        </div>
      )}
{null}
      <div className="flex-1 overflow-auto">
        <svg
          ref={svgRef}
          width={svgWidth}
          height={svgHeight}
          className="bg-white"
          style={{ cursor: cursorStyle }}
          onMouseDown={handleSvgMouseDown}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setDragging(null);
            setDragPreviewPos(null);
            setWireMousePos(null);
            setSelectionRect(null);
          }}
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

            return (
              <rect
                key={`seg-${i}`}
                x={startCenter.x - HOLE_SPACING * 0.4}
                y={startCenter.y - STRIP_HEIGHT / 2}
                width={endCenter.x - startCenter.x + HOLE_SPACING * 0.8}
                height={STRIP_HEIGHT}
                fill={color}
                opacity={group?.hasConflict ? 0.6 : hasNets ? 0.5 : 0.4}
                rx={1}
              />
            );
          })}

          {/* Row labels */}
          {Array.from({ length: board.rows }, (_, row) => {
            const center = holeCenter(row, 0);
            return (
              <text
                key={`rl-${row}`}
                x={center.x - 14}
                y={center.y + 3}
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
                y={center.y - 12}
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
              const renderComp =
                displayPos !== comp.boardPos
                  ? { ...comp, boardPos: displayPos }
                  : comp;
              return (
                <PlacedComponent
                  key={comp.id}
                  component={renderComp}
                  isSelected={comp.id === selectedId || selectedIds.includes(comp.id)}
                  onMouseDown={(e) => handleComponentMouseDown(comp.id, e)}
                />
              );
            })}

          {/* Wires */}
          {board.wires.map((wire) => {
            const { color, isConflict } = getWireColor(wire.id);
            return (
              <WireLine
                key={wire.id}
                wire={wire}
                color={color}
                isConflict={isConflict}
                onClick={() => removeWire(wire.id)}
              />
            );
          })}

          {/* Wire placement preview */}
          {wirePlacementFrom && wireMousePos && (
            <line
              x1={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).x}
              y1={holeCenter(wirePlacementFrom.row, wirePlacementFrom.col).y}
              x2={wireMousePos.x}
              y2={wireMousePos.y}
              stroke="#3b82f6"
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
              fill="#3b82f6"
              opacity={0.6}
              pointerEvents="none"
            />
          )}

          {/* Cut marks */}
          {board.cuts.map((cut, i) => (
            <CutMark key={`cut-${i}`} cut={cut} />
          ))}

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
                  fill="rgba(59, 130, 246, 0.1)"
                  stroke="#3b82f6"
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
                      fill="#3b82f6"
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
              fill="rgba(59, 130, 246, 0.08)"
              stroke="#3b82f6"
              strokeWidth={1}
              strokeDasharray="4 2"
              pointerEvents="none"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
