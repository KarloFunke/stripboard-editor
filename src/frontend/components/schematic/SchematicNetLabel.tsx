"use client";

import React from "react";
import { NetLabel } from "@/types";

interface Props {
  label: NetLabel;
  color?: string; // net color, when the label is part of a net
  isSelected: boolean;
  highlighted?: boolean;
  editing: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onPointMouseDown?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onCommitName?: (name: string) => void;
  onCancelEdit?: () => void;
}

// Glyph scale over the base drawing (a flag is about a grid step tall)
const S = 1.5;

/** Where the name text sits, in unrotated label space, so it stays upright for any rotation */
function textPlacement(kind: NetLabel["kind"], rotation: NetLabel["rotation"]) {
  // Distance from the connection point to the text anchor along the glyph axis
  const d = (kind === "gnd" ? 26 : 16) * S;
  // Glyph axis in local space: gnd points down (+y), power and label point up (-y)
  const dir = kind === "gnd" ? 1 : -1;
  // Rotate the axis end point with SVG rotate(): (x,y) -> (-y, x) per 90°
  let x = 0, y = dir * d;
  for (let i = 0; i < rotation / 90; i++) [x, y] = [-y, x];
  const anchor: "start" | "middle" | "end" = x > 1 ? "start" : x < -1 ? "end" : "middle";
  const baseline: "auto" | "hanging" | "central" = y > 1 ? "hanging" : y < -1 ? "auto" : "central";
  return { x, y, anchor, baseline };
}

/** Bounding box of the whole glyph plus text, in world space, for hit testing */
export function netLabelBounds(label: NetLabel): { minX: number; minY: number; maxX: number; maxY: number } {
  const tp = textPlacement(label.kind, label.rotation);
  const showName = label.kind !== "gnd" || label.name !== "GND";
  const textW = showName ? Math.max(24, label.name.length * 8) : 0;
  const xs = [-9 * S, 9 * S, tp.x], ys = [-9 * S, 9 * S, tp.y];
  if (showName) {
    if (tp.anchor === "start") xs.push(tp.x + textW);
    else if (tp.anchor === "end") xs.push(tp.x - textW);
    else { xs.push(tp.x - textW / 2, tp.x + textW / 2); }
    if (tp.baseline === "hanging") ys.push(tp.y + 14);
    else if (tp.baseline === "auto") ys.push(tp.y - 14);
    else ys.push(tp.y - 8, tp.y + 8);
  }
  const g = (label.kind === "gnd" ? 20 : 12) * S;
  let gx = 0, gy = label.kind === "gnd" ? g : -g;
  for (let i = 0; i < label.rotation / 90; i++) [gx, gy] = [-gy, gx];
  xs.push(gx); ys.push(gy);
  return {
    minX: label.pos.x + Math.min(...xs), maxX: label.pos.x + Math.max(...xs),
    minY: label.pos.y + Math.min(...ys), maxY: label.pos.y + Math.max(...ys),
  };
}

export default function SchematicNetLabel({
  label, color, isSelected, highlighted, editing,
  onMouseDown, onDoubleClick, onPointMouseDown, onMouseEnter, onMouseLeave, onCommitName, onCancelEdit,
}: Props) {
  const stroke = isSelected ? "var(--symbol-stroke-selected)" : "var(--symbol-stroke)";
  const strokeWidth = isSelected ? 2 : 1.5;
  const tp = textPlacement(label.kind, label.rotation);
  const showName = label.kind !== "gnd" || label.name !== "GND";
  const b = netLabelBounds(label);
  const [draft, setDraft] = React.useState(label.name);
  React.useEffect(() => { if (editing) setDraft(label.name); }, [editing, label.name]);

  return (
    <g
      transform={`translate(${label.pos.x}, ${label.pos.y})`}
      style={{ cursor: onMouseDown ? "grab" : "default" }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Hit area */}
      <rect
        x={b.minX - label.pos.x - 3} y={b.minY - label.pos.y - 3}
        width={b.maxX - b.minX + 6} height={b.maxY - b.minY + 6}
        fill="transparent"
      />

      {highlighted && !isSelected && (
        <circle r={7} fill={color ?? "var(--wire-default)"} opacity={0.3} />
      )}

      {/* Glyph, rotated as a unit */}
      <g transform={`rotate(${label.rotation}) scale(${S})`} stroke={stroke} strokeWidth={strokeWidth / S} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {label.kind === "gnd" && (
          <>
            <line x1={0} y1={0} x2={0} y2={10} />
            <line x1={-8} y1={10} x2={8} y2={10} />
            <line x1={-5} y1={14} x2={5} y2={14} />
            <line x1={-2} y1={18} x2={2} y2={18} />
          </>
        )}
        {label.kind === "power" && (
          <>
            <line x1={0} y1={0} x2={0} y2={-10} />
            <line x1={-7} y1={-10} x2={7} y2={-10} />
          </>
        )}
        {label.kind === "label" && (
          <>
            <line x1={0} y1={0} x2={0} y2={-8} />
            <path d="M -4 -8 L 4 -8 L 4 -12 L -4 -12 Z" fill={color ?? "var(--schematic-bg)"} fillOpacity={0.35} />
          </>
        )}
      </g>

      {/* Name, kept upright */}
      {showName && !editing && (
        <text
          x={tp.x} y={tp.y}
          fontSize={13}
          fontWeight={600}
          textAnchor={tp.anchor}
          dominantBaseline={tp.baseline}
          fill={isSelected ? "var(--symbol-stroke-selected)" : "var(--component-text)"}
          stroke="var(--schematic-bg)"
          strokeWidth={3}
          strokeLinejoin="round"
          style={{ userSelect: "none", paintOrder: "stroke" }}
        >
          {label.name}
        </text>
      )}

      {/* Connection point, drawn last so it sits on top of the wire end */}
      <circle
        r={2.5}
        fill={color ?? "var(--hole-fill)"}
        stroke={color ?? "var(--pin-text)"}
        strokeWidth={1.5}
        style={{ cursor: onPointMouseDown ? "pointer" : undefined }}
        onMouseDown={onPointMouseDown}
      />
      {onPointMouseDown && (
        <circle r={5} fill="transparent" style={{ cursor: "pointer" }} onMouseDown={onPointMouseDown} />
      )}

      {editing && (
        <foreignObject x={-45} y={tp.y < 0 ? tp.y - 20 : tp.y - 2} width={90} height={24}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => onCommitName?.(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitName?.(draft);
              if (e.key === "Escape") onCancelEdit?.();
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full bg-white dark:bg-neutral-800 border border-[#113768] dark:border-[#5b9bd5] rounded px-1 text-[10px] text-center text-neutral-900 dark:text-neutral-100 outline-none"
          />
        </foreignObject>
      )}
    </g>
  );
}
