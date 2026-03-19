"use client";

import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  holeCenter,
  getRotatedPinPositions,
  getComponentBounds,
  HOLE_SPACING,
} from "./boardLayout";

interface Props {
  component: Component;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

export default function PlacedComponent({ component, isSelected, onMouseDown }: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);

  const def = resolveComponentDef(component, componentDefs);
  if (!def || !component.boardPos) return null;

  const pins = getRotatedPinPositions(def, component.boardPos, component.rotation);
  const bounds = getComponentBounds(def, component.boardPos, component.rotation);

  const topLeft = holeCenter(bounds.minRow, bounds.minCol);
  const pad = HOLE_SPACING * 0.4;

  return (
    <g onMouseDown={onMouseDown} style={{ cursor: "grab" }}>
      {/* Solid rect with dotted edges — always */}
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
      />

      {/* Component label above */}
      <text
        x={topLeft.x + ((bounds.maxCol - bounds.minCol) * HOLE_SPACING) / 2}
        y={topLeft.y - pad - 4}
        textAnchor="middle"
        fontSize={11}
        fontWeight={600}
        fill="#171717"
      >
        {component.label}
      </text>

      {/* Component name below */}
      {def && (
        <text
          x={topLeft.x + ((bounds.maxCol - bounds.minCol) * HOLE_SPACING) / 2}
          y={topLeft.y + (bounds.maxRow - bounds.minRow) * HOLE_SPACING + pad + 12}
          textAnchor="middle"
          fontSize={9}
          fill="#737373"
          pointerEvents="none"
        >
          {def.name}
        </text>
      )}

      {/* Pin dots */}
      {pins.map((pin) => {
        const center = holeCenter(pin.row, pin.col);
        const assignment = netAssignments.find(
          (a) => a.componentId === component.id && a.pinId === pin.pinId
        );
        const net = assignment ? nets.find((n) => n.id === assignment.netId) : null;
        const hasNet = !!net;

        return (
          <g key={pin.pinId} pointerEvents="none">
            <circle
              cx={center.x}
              cy={center.y}
              r={hasNet ? 5 : 4.5}
              fill={hasNet ? net.color : "white"}
              stroke={hasNet ? "white" : "#d4d4d4"}
              strokeWidth={hasNet ? 1.5 : 0.5}
            />
            <text
              x={center.x}
              y={center.y + 10}
              textAnchor="middle"
              fontSize={6}
              fill="#525252"
            >
              {pin.pinId}
            </text>
          </g>
        );
      })}
    </g>
  );
}
