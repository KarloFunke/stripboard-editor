"use client";

import { copperOf } from "./boardPattern";

/** A board's copper and holes in small, scaled to fit a `size` px square. */
export default function BoardThumbnail({ map, size = 64 }: { map: string[]; size?: number }) {
  const { rows, cols, hole, right, down } = copperOf(map);
  const scale = size / Math.max(rows, cols);
  const lines: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!hole[i]) continue;
      dots.push(<circle key={`h${i}`} cx={c + 0.5} cy={r + 0.5} r={0.17} fill="var(--hole-fill)" />);
      if (right[i] && !(c > 0 && right[i - 1])) {
        let end = c + 1;
        while (right[r * cols + end]) end++;
        lines.push(<line key={`r${i}`} x1={c + 0.5} y1={r + 0.5} x2={end + 0.5} y2={r + 0.5} />);
      }
      if (down[i] && !(r > 0 && down[i - cols])) {
        let end = r + 1;
        while (down[end * cols + c]) end++;
        lines.push(<line key={`d${i}`} x1={c + 0.5} y1={r + 0.5} x2={c + 0.5} y2={end + 0.5} />);
      }
    }
  }
  return (
    <svg
      width={cols * scale}
      height={rows * scale}
      viewBox={`0 0 ${cols} ${rows}`}
      className="shrink-0 rounded-sm bg-[var(--board-fill)]"
      aria-hidden="true"
    >
      <g stroke="var(--strip-color)" strokeWidth={0.6} strokeLinecap="round">{lines}</g>
      {dots}
    </svg>
  );
}
