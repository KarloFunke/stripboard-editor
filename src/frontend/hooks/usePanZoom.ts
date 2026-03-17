import { useCallback, useRef, useState } from "react";

interface PanZoomState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const ZOOM_SENSITIVITY = 0.001;

export function usePanZoom(initialZoom = 1) {
  const [state, setState] = useState<PanZoomState>({
    panX: 0,
    panY: 0,
    zoom: initialZoom,
  });

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  /** Convert screen (client) coordinates to SVG coordinates */
  const screenToSvg = useCallback(
    (clientX: number, clientY: number, svgEl: SVGSVGElement) => {
      const rect = svgEl.getBoundingClientRect();
      const x = (clientX - rect.left) / state.zoom + state.panX;
      const y = (clientY - rect.top) / state.zoom + state.panY;
      return { x, y };
    },
    [state.zoom, state.panX, state.panY]
  );

  /** Get the viewBox string for the SVG */
  const getViewBox = useCallback(
    (width: number, height: number) => {
      const vw = width / state.zoom;
      const vh = height / state.zoom;
      return `${state.panX} ${state.panY} ${vw} ${vh}`;
    },
    [state.panX, state.panY, state.zoom]
  );

  /** Handle wheel event for zooming */
  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();

      // Mouse position in SVG space before zoom
      const mouseX = (e.clientX - rect.left) / state.zoom + state.panX;
      const mouseY = (e.clientY - rect.top) / state.zoom + state.panY;

      // Calculate new zoom
      const delta = -e.deltaY * ZOOM_SENSITIVITY;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * (1 + delta)));

      // Adjust pan so the point under cursor stays fixed
      const newPanX = mouseX - (e.clientX - rect.left) / newZoom;
      const newPanY = mouseY - (e.clientY - rect.top) / newZoom;

      setState({ panX: newPanX, panY: newPanY, zoom: newZoom });
    },
    [state.zoom, state.panX, state.panY]
  );

  /** Handle right-click drag start for panning */
  const handlePanStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        isPanning.current = true;
        panStart.current = {
          x: e.clientX,
          y: e.clientY,
          panX: state.panX,
          panY: state.panY,
        };
      }
    },
    [state.panX, state.panY]
  );

  /** Handle mouse move during panning */
  const handlePanMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning.current) return false;
      const dx = (e.clientX - panStart.current.x) / state.zoom;
      const dy = (e.clientY - panStart.current.y) / state.zoom;
      setState((prev) => ({
        ...prev,
        panX: panStart.current.panX - dx,
        panY: panStart.current.panY - dy,
      }));
      return true;
    },
    [state.zoom]
  );

  /** Handle mouse up to end panning */
  const handlePanEnd = useCallback(() => {
    isPanning.current = false;
  }, []);

  /** Prevent context menu on the SVG */
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  /** Reset pan and zoom to defaults */
  const resetView = useCallback(() => {
    setState({ panX: 0, panY: 0, zoom: initialZoom });
  }, [initialZoom]);

  return {
    ...state,
    isPanning,
    screenToSvg,
    getViewBox,
    handleWheel,
    handlePanStart,
    handlePanMove,
    handlePanEnd,
    handleContextMenu,
    resetView,
  };
}
