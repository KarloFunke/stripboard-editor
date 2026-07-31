"use client";

import { Wire } from "@/types";
import { holeCenter, STRIP_CONFLICT_COLOR } from "./boardLayout";

interface Props {
  wire: Wire;
  color: string;
  isConflict: boolean;
  onClick: () => void;
  // Perpendicular lane shift so overlapping parallel wires stay visible
  offset?: { dx: number; dy: number };
  // Alt held: let clicks fall through to the holes underneath
  clickThrough?: boolean;
}

export default function WireLine({ wire, color, isConflict, onClick, offset, clickThrough }: Props) {
  const from = holeCenter(wire.from.row, wire.from.col);
  const to = holeCenter(wire.to.row, wire.to.col);
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;

  const strokeColor = isConflict ? STRIP_CONFLICT_COLOR : color;

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer" }}
      pointerEvents={clickThrough ? "none" : undefined}
    >
      {/* Invisible thick line for easier click target */}
      <line
        x1={from.x + dx}
        y1={from.y + dy}
        x2={to.x + dx}
        y2={to.y + dy}
        stroke="transparent"
        strokeWidth={10}
        strokeLinecap="round"
      />
      {/* Visible wire */}
      <line
        x1={from.x + dx}
        y1={from.y + dy}
        x2={to.x + dx}
        y2={to.y + dy}
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.8}
        pointerEvents="none"
      />
      <circle cx={from.x + dx} cy={from.y + dy} r={4.5} fill={strokeColor} pointerEvents="none" />
      <circle cx={to.x + dx} cy={to.y + dy} r={4.5} fill={strokeColor} pointerEvents="none" />
    </g>
  );
}
