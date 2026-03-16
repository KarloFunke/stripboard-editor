"use client";

import { Cut } from "@/types";
import { holeCenter, HOLE_SPACING } from "./boardLayout";

interface Props {
  cut: Cut;
}

export default function CutMark({ cut }: Props) {
  // Cut is between col and col+1 on the given row
  const left = holeCenter(cut.row, cut.col);
  const midX = left.x + HOLE_SPACING / 2;
  const midY = left.y;
  const size = 4;

  return (
    <g>
      {/* X mark */}
      <line
        x1={midX - size}
        y1={midY - size}
        x2={midX + size}
        y2={midY + size}
        stroke="#dc2626"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <line
        x1={midX + size}
        y1={midY - size}
        x2={midX - size}
        y2={midY + size}
        stroke="#dc2626"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </g>
  );
}
