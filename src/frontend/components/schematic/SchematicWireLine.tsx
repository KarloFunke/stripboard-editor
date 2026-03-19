"use client";

import React from "react";
import { SchematicWire } from "@/types";

interface Props {
  wire: SchematicWire;
  color?: string;
  isSelected?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
}

/** Compute the bend point for an L-shaped wire route */
export function getWireBendPoint(wire: SchematicWire): { x: number; y: number } {
  if (wire.routeDirection === "horizontal-first") {
    return { x: wire.end.x, y: wire.start.y };
  } else {
    return { x: wire.start.x, y: wire.end.y };
  }
}

/** Get all grid points this wire passes through (start, optional bend, end) */
export function getWirePoints(wire: SchematicWire): { x: number; y: number }[] {
  const sameX = Math.round(wire.start.x) === Math.round(wire.end.x);
  const sameY = Math.round(wire.start.y) === Math.round(wire.end.y);

  if (sameX || sameY) {
    // Straight line, no bend needed
    return [wire.start, wire.end];
  }

  const bend = getWireBendPoint(wire);
  return [wire.start, bend, wire.end];
}

export default function SchematicWireLine({ wire, color, isSelected, onMouseDown }: Props) {
  const points = getWirePoints(wire);
  const strokeWidth = isSelected ? 3 : 2;
  const strokeColor = isSelected ? "#113768" : (color ?? "#666");

  return (
    <g style={{ cursor: "pointer" }} onMouseDown={onMouseDown}>
      {/* Hit areas */}
      {points.length === 2 ? (
        <line
          x1={points[0].x} y1={points[0].y}
          x2={points[1].x} y2={points[1].y}
          stroke="transparent" strokeWidth={10}
        />
      ) : (
        <>
          <line
            x1={points[0].x} y1={points[0].y}
            x2={points[1].x} y2={points[1].y}
            stroke="transparent" strokeWidth={10}
          />
          <line
            x1={points[1].x} y1={points[1].y}
            x2={points[2].x} y2={points[2].y}
            stroke="transparent" strokeWidth={10}
          />
        </>
      )}

      {/* Visible wire */}
      {points.length === 2 ? (
        <line
          x1={points[0].x} y1={points[0].y}
          x2={points[1].x} y2={points[1].y}
          stroke={strokeColor} strokeWidth={strokeWidth} strokeLinecap="round"
        />
      ) : (
        <>
          <line
            x1={points[0].x} y1={points[0].y}
            x2={points[1].x} y2={points[1].y}
            stroke={strokeColor} strokeWidth={strokeWidth} strokeLinecap="round"
          />
          <line
            x1={points[1].x} y1={points[1].y}
            x2={points[2].x} y2={points[2].y}
            stroke={strokeColor} strokeWidth={strokeWidth} strokeLinecap="round"
          />
        </>
      )}
    </g>
  );
}
