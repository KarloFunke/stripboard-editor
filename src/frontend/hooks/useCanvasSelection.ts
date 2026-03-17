import { useRef, useState, useCallback } from "react";

const DRAG_THRESHOLD = 4; // pixels before a mousedown becomes a drag
const MIN_RECT_SIZE = 10; // minimum selection rectangle size

export interface SelectionRect {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface DragState {
  componentId: string;
  startX: number; // client coords at drag start
  startY: number;
  didDrag: boolean;
}

/**
 * Shared canvas selection logic: single/multi select, selection rectangle,
 * drag threshold detection, and click-after-drag suppression.
 */
export function useCanvasSelection() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const justDraggedRef = useRef(false);

  /** Start drawing a selection rectangle from the given SVG point */
  const startSelectionRect = useCallback((svgPt: { x: number; y: number }) => {
    setSelectionRect({
      startX: svgPt.x,
      startY: svgPt.y,
      currentX: svgPt.x,
      currentY: svgPt.y,
    });
    setSelectedIds([]);
  }, []);

  /** Update the selection rectangle to the current SVG point */
  const updateSelectionRect = useCallback((svgPt: { x: number; y: number }) => {
    setSelectionRect((prev) =>
      prev ? { ...prev, currentX: svgPt.x, currentY: svgPt.y } : null
    );
  }, []);

  /**
   * Finalize the selection rectangle.
   * @param getSelectedIds - callback that receives the rect bounds and returns matched IDs
   * @returns true if a selection rect was active (consumed the event)
   */
  const finalizeSelectionRect = useCallback(
    (getSelectedIds: (x1: number, y1: number, x2: number, y2: number) => string[]) => {
      if (!selectionRect) return false;

      const x1 = Math.min(selectionRect.startX, selectionRect.currentX);
      const y1 = Math.min(selectionRect.startY, selectionRect.currentY);
      const x2 = Math.max(selectionRect.startX, selectionRect.currentX);
      const y2 = Math.max(selectionRect.startY, selectionRect.currentY);

      if (x2 - x1 > MIN_RECT_SIZE || y2 - y1 > MIN_RECT_SIZE) {
        const selected = getSelectedIds(x1, y1, x2, y2);
        setSelectedIds(selected);
        setSelectedId(null);
        justDraggedRef.current = true;
      }

      setSelectionRect(null);
      return true;
    },
    [selectionRect]
  );

  /**
   * Check if a mouse move exceeds the drag threshold.
   * @returns true if the threshold was just crossed
   */
  const checkDragThreshold = useCallback(
    (clientX: number, clientY: number, drag: DragState): boolean => {
      if (drag.didDrag) return false;
      const dx = clientX - drag.startX;
      const dy = clientY - drag.startY;
      return Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD;
    },
    []
  );

  /**
   * Handle click-after-drag suppression.
   * Call at the start of click handlers.
   * @returns true if the click should be suppressed
   */
  const shouldSuppressClick = useCallback(() => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return true;
    }
    return false;
  }, []);

  /** Mark that a drag just completed (for click suppression) */
  const markDragComplete = useCallback(() => {
    justDraggedRef.current = true;
  }, []);

  /** Cancel an in-progress selection rectangle */
  const cancelSelectionRect = useCallback(() => {
    setSelectionRect(null);
  }, []);

  /** Clear all selection state */
  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedIds([]);
  }, []);

  return {
    selectedId,
    setSelectedId,
    selectedIds,
    setSelectedIds,
    selectionRect,
    startSelectionRect,
    updateSelectionRect,
    finalizeSelectionRect,
    cancelSelectionRect,
    checkDragThreshold,
    shouldSuppressClick,
    markDragComplete,
    clearSelection,
  };
}
