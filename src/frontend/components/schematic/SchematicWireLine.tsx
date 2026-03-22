"use client";

import React from "react";
import { SchematicWire } from "@/types";

interface Props {
  wire: SchematicWire;
  color?: string;
  isSelected?: boolean;
  highlighted?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
}

/** Compute the bend point for an L-shaped wire route */
function getWireBendPoint(wire: SchematicWire): { x: number; y: number } {
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

export default function SchematicWireLine({ wire, color, isSelected, highlighted, onMouseDown }: Props) {
  const points = getWirePoints(wire);
  const strokeWidth = isSelected ? 2.5 : highlighted ? 2 : 1.5;
  const strokeColor = isSelected ? "#113768" : (color ?? "#666");
  const filterId = `wire-glow-${wire.id}`;

  return (
    <g style={{ cursor: "pointer" }} onMouseDown={onMouseDown}>
      {highlighted && !isSelected && (
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
          </filter>
        </defs>
      )}
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

      {/* Glow effect for highlighted wires */}
      {highlighted && !isSelected && (
        points.length === 2 ? (
          <line
            x1={points[0].x} y1={points[0].y}
            x2={points[1].x} y2={points[1].y}
            stroke={strokeColor} strokeWidth={6} strokeLinecap="round"
            filter={`url(#${filterId})`} opacity={0.7}
          />
        ) : (
          <>
            <line
              x1={points[0].x} y1={points[0].y}
              x2={points[1].x} y2={points[1].y}
              stroke={strokeColor} strokeWidth={4} strokeLinecap="round"
              filter={`url(#${filterId})`} opacity={0.5}
            />
            <line
              x1={points[1].x} y1={points[1].y}
              x2={points[2].x} y2={points[2].y}
              stroke={strokeColor} strokeWidth={4} strokeLinecap="round"
              filter={`url(#${filterId})`} opacity={0.5}
            />
          </>
        )
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
