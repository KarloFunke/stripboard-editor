"use client";

import { Cut } from "@/types";
import { holeCenter, HOLE_SPACING } from "./boardLayout";

interface Props {
  cut: Cut;
  /** Bigger while the cut tool is up. */
  large?: boolean;
}

export default function CutMark({ cut, large = false }: Props) {
  // "between" cuts sit at the midpoint between col and col+1; "hole" cuts sit
  // directly on the hole at col.
  const left = holeCenter(cut.row, cut.col);
  const isHole = cut.kind === "hole";
  const midX = isHole ? left.x : left.x + HOLE_SPACING / 2;
  const midY = left.y;
  const size = large ? 6.5 : 4;

  return (
    <g>
      {/* X mark */}
      <line
        x1={midX - size}
        y1={midY - size}
        x2={midX + size}
        y2={midY + size}
        stroke="var(--cut-stroke)"
        strokeWidth={large ? 2.8 : 2}
        strokeLinecap="round"
      />
      <line
        x1={midX + size}
        y1={midY - size}
        x2={midX - size}
        y2={midY + size}
        stroke="var(--cut-stroke)"
        strokeWidth={large ? 2.8 : 2}
        strokeLinecap="round"
      />
    </g>
  );
}
