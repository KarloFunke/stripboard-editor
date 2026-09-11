"use client";

import React from "react";
import { SchematicWire } from "@/types";
import { getWirePoints } from "./schematicGeometry";

export { getWirePoints };

interface Props {
  wire: SchematicWire;
  color?: string;
  isSelected?: boolean;
  highlighted?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export default function SchematicWireLine({ wire, color, isSelected, highlighted, onMouseDown, onMouseEnter, onMouseLeave }: Props) {
  const strokeWidth = isSelected ? 2.5 : highlighted ? 2 : 1.5;
  const strokeColor = isSelected ? "var(--selection-stroke)" : (color ?? "var(--wire-default)");
  const { start, end } = wire;

  return (
    <g style={{ cursor: "pointer" }} onMouseDown={onMouseDown} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {/* Hit area */}
      <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="transparent" strokeWidth={10} />

      {/* Glow effect for highlighted wires — thick semi-transparent line behind */}
      {highlighted && !isSelected && (
        <line
          x1={start.x} y1={start.y} x2={end.x} y2={end.y}
          stroke={strokeColor} strokeWidth={8} strokeLinecap="round"
          opacity={0.3}
        />
      )}

      {/* Visible wire */}
      <line
        x1={start.x} y1={start.y} x2={end.x} y2={end.y}
        stroke={strokeColor} strokeWidth={strokeWidth} strokeLinecap="round"
      />
    </g>
  );
}
