"use client";

import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  HOLE_SPACING,
  holeCenter,
  getComponentBounds,
  getComponentPinPositions,
  getFlexibleBounds,
} from "@/components/stripboard/boardLayout";

// Standard stripboard pitch is 0.1 in = 2.54 mm. The board SVG is authored in
// 30-unit cells; sizing the element in mm at this ratio prints it 1:1.
const MM_PER_HOLE = 2.54;
const SCALE = MM_PER_HOLE / HOLE_SPACING;
const MARGIN = 40;

interface Props {
  variant: "place" | "cut";
  showLabels: boolean;
  showWires: boolean;
  showCuts: boolean;
  showPinLabels: boolean;
}

export default function PrintBoard({ variant, showLabels, showWires, showCuts, showPinLabels }: Props) {
  const board = useProjectStore((s) => s.board);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);

  const mirror = variant === "cut";
  const lastCol = board.cols - 1;
  const colX = (col: number) => holeCenter(0, mirror ? lastCol - col : col).x;
  const rowY = (row: number) => holeCenter(row, 0).y;

  const minX = holeCenter(0, 0).x;
  const maxX = holeCenter(0, lastCol).x;
  const minY = holeCenter(0, 0).y;
  const maxY = holeCenter(board.rows - 1, 0).y;
  const vbX = minX - MARGIN;
  const vbY = minY - MARGIN;
  const vbW = maxX - minX + MARGIN * 2;
  const vbH = maxY - minY + MARGIN * 2;

  const compStroke = mirror ? "#bbbbbb" : "#000000";

  const holes: React.ReactNode[] = [];
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      holes.push(
        <circle key={`h${r}-${c}`} cx={colX(c)} cy={rowY(r)} r={4} fill="none" stroke="#000" strokeWidth={1.2} />
      );
    }
  }

  const strips = Array.from({ length: board.rows }, (_, r) => (
    <line key={`s${r}`} x1={colX(0)} y1={rowY(r)} x2={colX(lastCol)} y2={rowY(r)} stroke="#dddddd" strokeWidth={2} />
  ));

  return (
    <svg
      width={`${(vbW * SCALE).toFixed(2)}mm`}
      height={`${(vbH * SCALE).toFixed(2)}mm`}
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      className="font-sans" style={{ background: "#fff" }}
    >
      {strips}
      {holes}

      {components.map((comp) => {
        if (!comp.boardPos) return null;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) return null;
        const bounds = def.flexible
          ? getFlexibleBounds(comp, def)
          : getComponentBounds(def, comp.boardPos, comp.rotation);
        const x1 = colX(bounds.minCol);
        const x2 = colX(bounds.maxCol);
        const bx = Math.min(x1, x2) - 9;
        const bw = Math.abs(x2 - x1) + 18;
        const by = rowY(bounds.minRow) - 9;
        const bh = rowY(bounds.maxRow) - rowY(bounds.minRow) + 18;
        const pins = getComponentPinPositions(comp, def);
        const labelX = bx + bw / 2;
        const labelY = by - 6;
        return (
          <g key={comp.id}>
            <rect
              x={bx} y={by} width={bw} height={bh} rx={4}
              fill="none" stroke={compStroke} strokeWidth={mirror ? 1.5 : 3}
            />
            {pins.map((p, i) => (
              <circle key={i} cx={colX(p.col)} cy={rowY(p.row)} r={5}
                fill={mirror ? "none" : "#000"} stroke={compStroke} strokeWidth={1.5} />
            ))}
            {!mirror && showPinLabels && pins.map((p, i) => {
              const pinName = def.pins.find((pd) => pd.id === p.pinId)?.name;
              if (!pinName) return null;
              return (
                <text key={`pl${i}`} x={colX(p.col)} y={rowY(p.row) + 7}
                  textAnchor="middle" dominantBaseline="hanging" fontSize={11} fontWeight={600}
                  fill="#000" stroke="#fff" strokeWidth={3.5}
                  paintOrder="stroke" strokeLinejoin="round"
                  style={{ userSelect: "none" }}>
                  {pinName}
                </text>
              );
            })}
            {showLabels && (
              <text x={labelX} y={labelY} textAnchor="middle" fontSize={16}
                fontWeight={700} fill={mirror ? "#666" : "#000"}
                stroke="#fff" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                {comp.label}
              </text>
            )}
          </g>
        );
      })}

      {!mirror && showWires && board.wires.map((w) => {
        const a = { x: colX(w.from.col), y: rowY(w.from.row) };
        const b = { x: colX(w.to.col), y: rowY(w.to.row) };
        return (
          <g key={w.id}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#000" strokeWidth={4} strokeLinecap="round" />
            <circle cx={a.x} cy={a.y} r={5} fill="#000" />
            <circle cx={b.x} cy={b.y} r={5} fill="#000" />
          </g>
        );
      })}

      {(mirror || showCuts) && board.cuts.map((cut, i) => {
        const cx = cut.kind === "hole"
          ? colX(cut.col)
          : (colX(cut.col) + colX(cut.col + 1)) / 2;
        const cy = rowY(cut.row);
        const s = 9;
        return (
          <g key={`cut${i}`} stroke="#000" strokeWidth={mirror ? 5 : 4} strokeLinecap="round">
            <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} />
            <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} />
          </g>
        );
      })}

      {(() => {
        const ox = colX(0);
        const oy = rowY(0);
        return (
          <g>
            <path d={`M ${ox - 16} ${oy - 16} l 14 0 l -14 14 z`} fill="#000" />
            <text x={ox} y={oy - 22} textAnchor="middle" fontSize={13} fill="#000">
              {mirror ? "Copper side · R0·C0" : "Top · R0·C0"}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}
