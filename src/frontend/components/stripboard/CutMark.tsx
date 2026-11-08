"use client";

import { Cut } from "@/types";
import { cutPoint } from "./boardLayout";

interface Props {
  cut: Cut;
  /** Bigger while the cut tool is up. */
  large?: boolean;
}

export default function CutMark({ cut, large = false }: Props) {
  // a knife cut sits halfway to the next hole, a drilled one on its hole
  const { x: midX, y: midY } = cutPoint(cut);
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
