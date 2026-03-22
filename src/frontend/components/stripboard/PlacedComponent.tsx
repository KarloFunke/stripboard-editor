"use client";

import { useRef } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  holeCenter,
  getRotatedPinPositions,
  getComponentBounds,
  getFlexiblePinPositions,
  getFlexibleBounds,
  HOLE_SPACING,
  PinPosition,
} from "./boardLayout";

const PIN_HIT_RADIUS = HOLE_SPACING * 0.35;

// Exported flag to suppress canvas click handlers after label drag
export let suppressNextCanvasClick = false;

interface Props {
  component: Component;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinDragStart?: (pinId: string, e: React.MouseEvent) => void;
  readOnly?: boolean;
}

export default function PlacedComponent({ component, isSelected, onMouseDown, onPinDragStart, readOnly = false }: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);
  const updateBoardLabelOffset = useProjectStore((s) => s.updateBoardLabelOffset);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const snapshotPushed = useRef(false);

  const handleLabelMouseDown = (e: React.MouseEvent, defaultX: number, defaultY: number) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startOff = component.boardLabelOffset ?? { x: 0, y: 0 };
    snapshotPushed.current = false;

    const svgEl = (e.target as SVGElement).ownerSVGElement;
    const ctm = svgEl?.getScreenCTM();
    const scaleFactor = ctm ? 1 / ctm.a : 1;

    const handleMove = (me: MouseEvent) => {
      if (!snapshotPushed.current) {
        pushSnapshot();
        snapshotPushed.current = true;
      }
      const dx = (me.clientX - startX) * scaleFactor;
      const dy = (me.clientY - startY) * scaleFactor;
      updateBoardLabelOffset(component.id, { x: startOff.x + dx, y: startOff.y + dy });
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (snapshotPushed.current) {
        suppressNextCanvasClick = true;
        requestAnimationFrame(() => { suppressNextCanvasClick = false; });
      }
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const def = resolveComponentDef(component, componentDefs);
  if (!def || !component.boardPos) return null;

  const isFlexible = def.flexible ?? false;

  let pins: PinPosition[];
  let bounds: { minRow: number; minCol: number; maxRow: number; maxCol: number };

  if (isFlexible) {
    pins = getFlexiblePinPositions(component, def);
    bounds = getFlexibleBounds(component, def);
  } else {
    pins = getRotatedPinPositions(def, component.boardPos, component.rotation);
    bounds = getComponentBounds(def, component.boardPos, component.rotation);
  }

  const topLeft = holeCenter(bounds.minRow, bounds.minCol);
  const pad = HOLE_SPACING * 0.4;

  const renderPin = (pin: PinPosition) => {
    const center = holeCenter(pin.row, pin.col);
    const assignment = netAssignments.find(
      (a) => a.componentId === component.id && a.pinId === pin.pinId
    );
    const net = assignment ? nets.find((n) => n.id === assignment.netId) : null;
    const hasNet = !!net;

    return (
      <g key={pin.pinId}>
        {/* Large hit area for flexible pin dragging */}
        {isFlexible && onPinDragStart && (
          <circle
            cx={center.x}
            cy={center.y}
            r={PIN_HIT_RADIUS}
            fill="transparent"
            pointerEvents="all"
            style={{ cursor: "grab" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onPinDragStart(pin.pinId, e);
            }}
          />
        )}
        {/* Pin dot */}
        <circle
          cx={center.x}
          cy={center.y}
          r={hasNet ? 5 : 4.5}
          fill={hasNet ? net!.color : "white"}
          stroke={hasNet ? "white" : "#d4d4d4"}
          strokeWidth={hasNet ? 1.5 : 0.5}
          pointerEvents="none"
        />
        {/* Pin ID label */}
        <text
          x={center.x}
          y={center.y + 10}
          textAnchor="middle"
          fontSize={6}
          fill="#525252"
          pointerEvents="none"
        >
          {def.pins.find((p) => p.id === pin.pinId)?.name ?? pin.pinId}
        </text>
      </g>
    );
  };

  // Diagonal flexible component
  if (isFlexible && pins.length === 2) {
    const p1 = holeCenter(pins[0].row, pins[0].col);
    const p2 = holeCenter(pins[1].row, pins[1].col);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    if (dx !== 0 && dy !== 0) {
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      const length = Math.sqrt(dx * dx + dy * dy);
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;

      return (
        <g>
          <rect
            x={-length / 2 - pad * 0.6}
            y={-pad}
            width={length + pad * 1.2}
            height={pad * 2}
            rx={3}
            fill={isSelected ? "rgba(17, 55, 104, 0.1)" : "rgba(255, 255, 255, 0.85)"}
            stroke={isSelected ? "#113768" : "#a3a3a3"}
            strokeWidth={isSelected ? 1.5 : 1}
            strokeDasharray="4 3"
            transform={`translate(${cx}, ${cy}) rotate(${angle})`}
            style={{ cursor: "grab" }}
            onMouseDown={onMouseDown}
          />
          <text
            x={cx + (component.boardLabelOffset?.x ?? 0)}
            y={cy - pad - 4 + (component.boardLabelOffset?.y ?? 0)}
            textAnchor="middle" fontSize={11} fontWeight={600} fill="#171717"
            style={{ cursor: "grab" }}
            onMouseDown={(e) => handleLabelMouseDown(e, cx, cy - pad - 4)}
          >
            {component.label}
          </text>
          {pins.map(renderPin)}
        </g>
      );
    }
  }

  // Standard (axis-aligned) rendering
  return (
    <g>
      <rect
        x={topLeft.x - pad}
        y={topLeft.y - pad}
        width={(bounds.maxCol - bounds.minCol) * HOLE_SPACING + pad * 2}
        height={(bounds.maxRow - bounds.minRow) * HOLE_SPACING + pad * 2}
        rx={3}
        fill={isSelected ? "rgba(17, 55, 104, 0.1)" : "rgba(255, 255, 255, 0.85)"}
        stroke={isSelected ? "#113768" : "#a3a3a3"}
        strokeWidth={isSelected ? 1.5 : 1}
        strokeDasharray="4 3"
        style={{ cursor: "grab" }}
        onMouseDown={onMouseDown}
      />
      <text
        x={topLeft.x + ((bounds.maxCol - bounds.minCol) * HOLE_SPACING) / 2 + (component.boardLabelOffset?.x ?? 0)}
        y={topLeft.y - pad - 4 + (component.boardLabelOffset?.y ?? 0)}
        textAnchor="middle" fontSize={11} fontWeight={600} fill="#171717"
        style={{ cursor: "grab" }}
        onMouseDown={(e) => handleLabelMouseDown(e,
          topLeft.x + ((bounds.maxCol - bounds.minCol) * HOLE_SPACING) / 2,
          topLeft.y - pad - 4
        )}
      >
        {component.label}
      </text>
      {pins.map(renderPin)}
    </g>
  );
}
