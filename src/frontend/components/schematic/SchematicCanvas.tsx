"use client";

import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { usePanZoom } from "@/hooks/usePanZoom";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";
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
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom();
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const showNetLines = useProjectStore((s) => s.showNetLines);
  const updateSchematicPos = useProjectStore((s) => s.updateSchematicPos);
  const removeComponent = useProjectStore((s) => s.removeComponent);
  const addComponent = useProjectStore((s) => s.addComponent);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);

  const netLines = useMemo(
    () => showNetLines ? computeNetLines(nets, netAssignments, components, componentDefs) : [],
    [showNetLines, nets, netAssignments, components, componentDefs]
  );

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
  } | null>(null);

  const selectedComponent = selectedId
    ? components.find((c) => c.id === selectedId) ?? null
    : null;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore shortcuts when typing in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Escape" && selectedIds.length > 0) {
        setSelectedIds([]);
        return;
      }

      // Arrow keys: move selected components
      const moveIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
      if (moveIds.length > 0 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        pushSnapshot();
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
      if (selectedId && e.key === "Delete") {
        removeComponent(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, selectedIds, components, updateSchematicPos, removeComponent, pushSnapshot]);

  const getSVGPoint = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    return panZoom.screenToSvg(e.clientX, e.clientY, svg);
  }, [panZoom.screenToSvg]);

  const handleMouseDown = useCallback(
    (componentId: string, e: React.MouseEvent) => {
      if (e.button === 2) return; // right-click is pan
      if ((e.target as Element).closest("[data-pin]")) return;
      e.preventDefault();

      const comp = components.find((c) => c.id === componentId);
      if (!comp) return;

      pushSnapshot();
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
    [components, getSVGPoint, pushSnapshot]
  );

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) return; // right-click is pan
      const target = e.target as Element;
      const isBackground = target.tagName === "svg" ||
        target.getAttribute("fill") === "url(#grid)";
      if (!isBackground) return;

      startSelectionRect(getSVGPoint(e));
    },
    [getSVGPoint, startSelectionRect]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panZoom.handlePanMove(e)) return;

      if (selectionRect) {
        updateSelectionRect(getSVGPoint(e));
      }

      if (!dragging) return;
      if (!dragging.didDrag && checkDragThreshold(e.clientX, e.clientY, dragging)) {
        setDragging({ ...dragging, didDrag: true });
      }
      const pt = getSVGPoint(e);
      updateSchematicPos(dragging.componentId, {
        x: pt.x - dragging.offsetX,
        y: pt.y - dragging.offsetY,
      });
    },
    [dragging, selectionRect, getSVGPoint, updateSchematicPos, panZoom.handlePanMove, updateSelectionRect, checkDragThreshold]
  );

  const handleMouseUp = useCallback(() => {
    panZoom.handlePanEnd();

    // Finalize selection rectangle
    const rectHandled = finalizeSelectionRect((x1, y1, x2, y2) => {
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
      return selected;
    });
    if (rectHandled) return;

    if (dragging) {
      markDragComplete();
      if (!dragging.didDrag) {
        setSelectedId((prev) =>
          prev === dragging.componentId ? null : dragging.componentId
        );
      }
    }
    setDragging(null);
  }, [dragging, components, componentDefs, finalizeSelectionRect, markDragComplete, setSelectedId]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (shouldSuppressClick()) return;
    if (e.target === svgRef.current || (e.target as Element).tagName === "rect") {
      const isGridRect = (e.target as Element).getAttribute("fill") === "url(#grid)";
      if (e.target === svgRef.current || isGridRect) {
        clearSelection();
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
    const defId = e.dataTransfer.getData("application/schematic-component");
    if (!defId || !svgRef.current) return;
    e.preventDefault();
    const pos = panZoom.screenToSvg(e.clientX, e.clientY, svgRef.current);
    addComponent(defId, { x: pos.x, y: pos.y });
  }, [addComponent, panZoom.screenToSvg]);

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

  // Get container size for viewBox calculation
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
    : dragging
    ? "grabbing"
    : "default";

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden relative">
    <svg
      ref={svgRef}
      className="h-full w-full bg-white"
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
        setDragging(null);
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
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="0.5" fill="#e5e5e5" />
        </pattern>
      </defs>
      <rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#grid)" />

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
  );
}
