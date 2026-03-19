"use client";

import React from "react";
import { getSymbolDef, type SymbolDef } from "@/data/symbolDefs";

interface SymbolRendererProps {
  symbolId: string;
  rotation?: 0 | 90 | 180 | 270;
  selected?: boolean;
  pinColors?: Record<string, string>; // pinId → net color
  onPinMouseDown?: (pinId: string, e: React.MouseEvent) => void;
  showPinLabels?: boolean;
  scale?: number;
}

/** Rotate a point, matching SVG rotate() transform.
 * SVG rotate(θ): x' = x·cos(θ) - y·sin(θ), y' = x·sin(θ) + y·cos(θ)
 */
function rotatePoint(x: number, y: number, rotation: 0 | 90 | 180 | 270): { x: number; y: number } {
  switch (rotation) {
    case 90:  return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default:  return { x, y };
  }
}

/** Get rotated pin connection points (positions relative to component origin) */
export function getRotatedPinPositions(
  symbolId: string,
  rotation: 0 | 90 | 180 | 270
): { pinId: string; x: number; y: number }[] {
  const def = getSymbolDef(symbolId);
  if (!def) return [];
  return def.pins.map((pin) => {
    const rotated = rotatePoint(pin.stubEnd.x, pin.stubEnd.y, rotation);
    return { pinId: pin.pinId, x: rotated.x, y: rotated.y };
  });
}

/** Compute bounding box of all points (stubs + body key points) after rotation */
export function getSymbolBounds(symbolId: string, rotation: 0 | 90 | 180 | 270 = 0): {
  width: number; height: number; minX: number; minY: number; maxX: number; maxY: number;
} {
  const def = getSymbolDef(symbolId);
  if (!def) return { width: 40, height: 40, minX: -20, minY: -20, maxX: 20, maxY: 20 };

  const points: { x: number; y: number }[] = [];

  // Collect all pin endpoints and stub starts
  for (const pin of def.pins) {
    points.push(rotatePoint(pin.stubEnd.x, pin.stubEnd.y, rotation));
    points.push(rotatePoint(pin.stubStart.x, pin.stubStart.y, rotation));
  }

  // If no points, use a default
  if (points.length === 0) return { width: 40, height: 40, minX: -20, minY: -20, maxX: 20, maxY: 20 };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return { width: maxX - minX, height: maxY - minY, minX, minY, maxX, maxY };
}

/** Compute pin label position and anchor dynamically based on stub direction and rotation */
function getPinLabelProps(
  stubEnd: { x: number; y: number },
  side: "top" | "bottom" | "left" | "right",
  rotation: 0 | 90 | 180 | 270,
): { x: number; y: number; anchor: "start" | "middle" | "end"; baseline: "auto" | "hanging" | "central" } {
  // Determine the effective side after rotation
  const sideOrder: ("top" | "right" | "bottom" | "left")[] = ["top", "right", "bottom", "left"];
  const rotSteps = rotation / 90;
  const effectiveSide = sideOrder[(sideOrder.indexOf(side) + rotSteps) % 4];

  // Rotate the stub endpoint
  const rp = rotatePoint(stubEnd.x, stubEnd.y, rotation);
  const offset = 8;

  switch (effectiveSide) {
    case "top":
      return { x: rp.x + offset, y: rp.y + 2, anchor: "start", baseline: "central" };
    case "bottom":
      return { x: rp.x + offset, y: rp.y - 2, anchor: "start", baseline: "central" };
    case "left":
      return { x: rp.x - offset, y: rp.y, anchor: "end", baseline: "central" };
    case "right":
      return { x: rp.x + offset, y: rp.y, anchor: "start", baseline: "central" };
  }
}

export default function SymbolRenderer({
  symbolId,
  rotation = 0,
  selected = false,
  pinColors = {},
  onPinMouseDown,
  showPinLabels = true,
  scale = 1,
}: SymbolRendererProps) {
  const def = getSymbolDef(symbolId);
  if (!def) return null;

  const strokeColor = selected ? "#113768" : "#333";
  const strokeWidth = selected ? 2 : 1.5;

  return (
    <g transform={`scale(${scale})`}>
      {/* Body and stubs (rotated as a group) */}
      <g transform={`rotate(${rotation})`}>
        {def.bodyPaths.map((path, i) => (
          <path
            key={`body-${i}`}
            d={path.d}
            fill={path.fill === "currentColor" ? strokeColor : (path.fill ?? "none")}
            stroke={path.stroke ?? strokeColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* Extra elements (arrows, body labels) — NOT counter-rotated, they're part of the symbol */}
        {def.extraElements?.map((el, i) => {
          if (el.type === "line") {
            return (
              <line
                key={`extra-${i}`}
                x1={el.props.x1 as number} y1={el.props.y1 as number}
                x2={el.props.x2 as number} y2={el.props.y2 as number}
                stroke={strokeColor} strokeWidth={1.2} strokeLinecap="round"
              />
            );
          }
          if (el.type === "circle") {
            return (
              <circle
                key={`extra-${i}`}
                cx={el.props.cx as number} cy={el.props.cy as number}
                r={el.props.r as number}
                fill={el.props.fill as string ?? "none"}
                stroke={strokeColor} strokeWidth={el.props.strokeWidth as number ?? 1.5}
              />
            );
          }
          if (el.type === "text") {
            return (
              <text
                key={`extra-${i}`}
                x={el.props.x as number} y={el.props.y as number}
                fontSize={el.props.fontSize as number}
                textAnchor={el.props.textAnchor as "start" | "middle" | "end"}
                fill={strokeColor} style={{ userSelect: "none" }}
              >
                {el.props.children as string}
              </text>
            );
          }
          return null;
        })}
      </g>

      {/* Pin connection points and labels (NOT inside the rotation group — positioned in world space) */}
      {def.pins.map((pin) => {
        const color = pinColors[pin.pinId];
        const hasNet = !!color;
        // Compute rotated pin position in world space
        const rEnd = rotatePoint(pin.stubEnd.x, pin.stubEnd.y, rotation);

        return (
          <g key={`pin-${pin.pinId}`}>
            {/* Connection point */}
            <circle
              cx={rEnd.x} cy={rEnd.y}
              r={hasNet ? 4 : 3}
              fill={hasNet ? color : "white"}
              stroke={hasNet ? color : "#999"}
              strokeWidth={1.5}
              style={{ cursor: onPinMouseDown ? "pointer" : "default" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                onPinMouseDown?.(pin.pinId, e);
              }}
            />
            {/* Larger hit area */}
            <circle
              cx={rEnd.x} cy={rEnd.y}
              r={10} fill="transparent"
              style={{ cursor: onPinMouseDown ? "pointer" : "default" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                onPinMouseDown?.(pin.pinId, e);
              }}
            />
            {/* Pin label — dynamically positioned based on stub direction */}
            {showPinLabels && (() => {
              const lp = getPinLabelProps(pin.stubEnd, pin.side, rotation);
              return (
                <text
                  x={lp.x} y={lp.y}
                  fontSize={9}
                  textAnchor={lp.anchor}
                  dominantBaseline={lp.baseline}
                  fill="#666"
                  style={{ userSelect: "none" }}
                >
                  {pin.defaultName}
                </text>
              );
            })()}
          </g>
        );
      })}
    </g>
  );
}
