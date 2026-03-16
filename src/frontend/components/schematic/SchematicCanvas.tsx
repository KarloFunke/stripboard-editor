"use client";

import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import SchematicComponentBlock from "./SchematicComponentBlock";
import ComponentPopup from "./ComponentPopup";
import { getBlockSize } from "./blockLayout";
import { computeNetLines } from "./netLines";

const POPUP_WIDTH = 220;
const POPUP_HEIGHT_ESTIMATE = 250;
const POPUP_GAP = 8;
const MOVE_STEP = 20; // pixels per arrow key press

export default function SchematicCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const showNetLines = useProjectStore((s) => s.showNetLines);
  const updateSchematicPos = useProjectStore((s) => s.updateSchematicPos);
  const removeComponent = useProjectStore((s) => s.removeComponent);

  const netLines = useMemo(
    () => showNetLines ? computeNetLines(nets, netAssignments, components, componentDefs) : [],
    [showNetLines, nets, netAssignments, components, componentDefs]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionRect, setSelectionRect] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [dragging, setDragging] = useState<{
    componentId: string;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    didDrag: boolean;
  } | null>(null);

  const justDraggedRef = useRef(false);

  const selectedComponent = selectedId
    ? components.find((c) => c.id === selectedId) ?? null
    : null;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedIds.length > 0) {
        setSelectedIds([]);
        return;
      }

      // Arrow keys: move selected components
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      if (moveIds.length > 0 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const delta = {
          ArrowUp: { x: 0, y: -MOVE_STEP },
          ArrowDown: { x: 0, y: MOVE_STEP },
          ArrowLeft: { x: -MOVE_STEP, y: 0 },
          ArrowRight: { x: MOVE_STEP, y: 0 },
        }[e.key]!;
        for (const id of moveIds) {
          const comp = components.find((c) => c.id === id);
          if (comp) {
            updateSchematicPos(id, {
              x: comp.schematicPos.x + delta.x,
              y: comp.schematicPos.y + delta.y,
            });
          }
        }
        return;
      }

      // Delete selected component
      if (selectedId && (e.key === "Delete" || e.key === "Backspace")) {
        removeComponent(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, selectedIds, components, updateSchematicPos, removeComponent]);

  const getSVGPoint = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleMouseDown = useCallback(
    (componentId: string, e: React.MouseEvent) => {
      if ((e.target as Element).closest("[data-pin]")) return;
      e.preventDefault();

      const comp = components.find((c) => c.id === componentId);
      if (!comp) return;

      const pt = getSVGPoint(e);
      setDragging({
        componentId,
        offsetX: pt.x - comp.schematicPos.x,
        offsetY: pt.y - comp.schematicPos.y,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
      });
    },
    [components, getSVGPoint]
  );

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      const isBackground = target.tagName === "svg" ||
        target.getAttribute("fill") === "url(#grid)";
      if (!isBackground) return;

      const pt = getSVGPoint(e);
      setSelectionRect({ startX: pt.x, startY: pt.y, currentX: pt.x, currentY: pt.y });
      setSelectedIds([]);
    },
    [getSVGPoint]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
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
      updateSchematicPos(dragging.componentId, {
        x: pt.x - dragging.offsetX,
        y: pt.y - dragging.offsetY,
      });
    },
    [dragging, selectionRect, getSVGPoint, updateSchematicPos]
  );

  const handleMouseUp = useCallback(() => {
    // Finalize selection rectangle
    if (selectionRect) {
      const x1 = Math.min(selectionRect.startX, selectionRect.currentX);
      const y1 = Math.min(selectionRect.startY, selectionRect.currentY);
      const x2 = Math.max(selectionRect.startX, selectionRect.currentX);
      const y2 = Math.max(selectionRect.startY, selectionRect.currentY);

      if (x2 - x1 > 10 || y2 - y1 > 10) {
        const selected: string[] = [];
        for (const comp of components) {
          const def = resolveComponentDef(comp, componentDefs);
          if (!def) continue;
          const { blockWidth, blockHeight } = getBlockSize(def);
          const cx = comp.schematicPos.x;
          const cy = comp.schematicPos.y;
          if (cx + blockWidth >= x1 && cx <= x2 && cy + blockHeight >= y1 && cy <= y2) {
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
      if (!dragging.didDrag) {
        setSelectedId((prev) =>
          prev === dragging.componentId ? null : dragging.componentId
        );
      }
    }
    setDragging(null);
  }, [dragging, selectionRect, components, componentDefs]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    if (e.target === svgRef.current || (e.target as Element).tagName === "rect") {
      const isGridRect = (e.target as Element).getAttribute("fill") === "url(#grid)";
      if (e.target === svgRef.current || isGridRect) {
        setSelectedId(null);
        setSelectedIds([]);
      }
    }
  }, []);

  // Render selected component last so it's on top
  const sortedComponents = selectedId
    ? [
        ...components.filter((c) => c.id !== selectedId),
        ...components.filter((c) => c.id === selectedId),
      ]
    : components;

  // Smart popup positioning
  const getPopupPos = () => {
    if (!selectedComponent) return { x: 0, y: 0 };
    const def = resolveComponentDef(selectedComponent, componentDefs);
    if (!def) return { x: 0, y: 0 };

    const { blockWidth } = getBlockSize(def);
    const svg = svgRef.current;
    const svgWidth = svg?.clientWidth ?? 1000;
    const svgHeight = svg?.clientHeight ?? 800;

    const compX = selectedComponent.schematicPos.x;
    const compY = selectedComponent.schematicPos.y;

    let x = compX + blockWidth + POPUP_GAP;
    let y = compY - 10;

    if (x + POPUP_WIDTH > svgWidth) {
      x = compX - POPUP_WIDTH - POPUP_GAP;
    }
    if (y + POPUP_HEIGHT_ESTIMATE > svgHeight) {
      y = svgHeight - POPUP_HEIGHT_ESTIMATE;
    }
    if (y < 0) y = 0;

    return { x, y };
  };

  return (
    <svg
      ref={svgRef}
      className="h-full w-full bg-white"
      style={{ cursor: dragging ? "grabbing" : "default" }}
      onMouseDown={handleSvgMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        setDragging(null);
        setSelectionRect(null);
      }}
      onClick={handleCanvasClick}
    >
      {/* Grid dots */}
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="0.5" fill="#e5e5e5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />

      {/* Net lines (MST edges) */}
      {netLines.map((netLine) =>
        netLine.edges.map((edge, i) => (
          <line
            key={`nl-${netLine.netId}-${i}`}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke={netLine.color}
            strokeWidth={1.5}
            strokeOpacity={0.4}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        ))
      )}

      {sortedComponents.map((comp) => (
        <SchematicComponentBlock
          key={comp.id}
          component={comp}
          isSelected={comp.id === selectedId || selectedIds.includes(comp.id)}
          onMouseDown={(e) => handleMouseDown(comp.id, e)}
          onSelect={() => {}}
        />
      ))}

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

      {/* Popup rendered last = always on top */}
      {selectedComponent && (
        <foreignObject
          x={getPopupPos().x}
          y={getPopupPos().y}
          width={POPUP_WIDTH + 10}
          height={POPUP_HEIGHT_ESTIMATE + 50}
          style={{ overflow: "visible" }}
        >
          <ComponentPopup
            component={selectedComponent}
            onClose={() => setSelectedId(null)}
          />
        </foreignObject>
      )}
    </svg>
  );
}
