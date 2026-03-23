"use client";

import { Wire } from "@/types";
import { holeCenter, STRIP_CONFLICT_COLOR } from "./boardLayout";

interface Props {
  wire: Wire;
  color: string;
  isConflict: boolean;
  onClick: () => void;
}

export default function WireLine({ wire, color, isConflict, onClick }: Props) {
  const from = holeCenter(wire.from.row, wire.from.col);
  const to = holeCenter(wire.to.row, wire.to.col);

  const strokeColor = isConflict ? STRIP_CONFLICT_COLOR : color;

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer" }}
    >
      {/* Invisible thick line for easier click target */}
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke="transparent"
        strokeWidth={10}
        strokeLinecap="round"
      />
      {/* Visible wire */}
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.8}
        pointerEvents="none"
      />
      <circle cx={from.x} cy={from.y} r={3} fill={strokeColor} pointerEvents="none" />
      <circle cx={to.x} cy={to.y} r={3} fill={strokeColor} pointerEvents="none" />
    </g>
  );
}
