"use client";

import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { HOLE_SPACING, holeCenter } from "@/components/stripboard/boardLayout";
import { computeWireLaneOffsets } from "@/components/stripboard/wireLanes";
import { PartBody, partDrawing } from "@/components/stripboard/partDrawing";
import { getGroupForSegment, getGroupForWire } from "@/components/stripboard/connectivity";
import { findSegmentIndex } from "@/components/stripboard/stripSegments";
import { useStripSegments } from "@/hooks/useStripSegments";
import { useBoardView } from "@/hooks/useBoardView";

// Standard stripboard pitch is 0.1 in = 2.54 mm. The board SVG is authored in
// 30-unit cells; sizing the element in mm at this ratio prints it 1:1.
const MM_PER_HOLE = 2.54;
const SCALE = MM_PER_HOLE / HOLE_SPACING;
const MARGIN = 40;

interface Props {
  variant: "place" | "cut";
  showLabels: boolean;
  showPinLabels: boolean;
  // Colour: copper strips, nets and parts in their colours. Off is the same
  // drawing in black outlines, which photocopies well.
  color: boolean;
}

const COPPER = "#d9b368";
const CONFLICT = "#dc2626";

export default function PrintBoard({ variant, showLabels, showPinLabels, color }: Props) {
  const board = useProjectStore((s) => s.board);
  const { components } = useBoardView();
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const { segments, connectivity } = useStripSegments();

  const groupColor = (group: ReturnType<typeof getGroupForWire>): string | null => {
    if (!group || group.netIds.length === 0) return null;
    if (group.hasConflict) return CONFLICT;
    return nets.find((n) => n.id === group.netIds[0])?.color ?? null;
  };
  const holeColor = (row: number, col: number): string | null => {
    const si = findSegmentIndex(segments, row, col);
    return si < 0 ? null : groupColor(getGroupForSegment(connectivity, si));
  };

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
        <circle key={`h${r}-${c}`} cx={colX(c)} cy={rowY(r)} r={4} fill={color ? "#fff" : "none"} stroke={color ? "#8a6d2f" : "#000"} strokeWidth={color ? 0.8 : 1.2} />
      );
    }
  }

  const strips = Array.from({ length: board.rows }, (_, r) => (
    <line key={`s${r}`} x1={colX(0)} y1={rowY(r)} x2={colX(lastCol)} y2={rowY(r)}
      stroke={color ? COPPER : "#dddddd"} strokeWidth={color ? 12 : 2} strokeLinecap={color ? "round" : undefined} />
  ));
  // Copper that carries a net, in the net's colour, as the board editor shows it
  const netStrips = color && !mirror
    ? segments.map((seg, i) => {
        const c = groupColor(getGroupForSegment(connectivity, i));
        if (!c) return null;
        return <line key={`n${i}`} x1={colX(seg.startCol)} y1={rowY(seg.row)} x2={colX(seg.endCol)} y2={rowY(seg.row)}
          stroke={c} strokeWidth={5} strokeLinecap="round" />;
      })
    : null;

  return (
    <svg
      width={`${(vbW * SCALE).toFixed(2)}mm`}
      height={`${(vbH * SCALE).toFixed(2)}mm`}
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      className="font-sans" style={{ background: "#fff" }}
    >
      {strips}
      {netStrips}
      {holes}

      {components.map((comp) => {
        const def = resolveComponentDef(comp, componentDefs);
        // Drawn the way the top side has it. The cut sheet looks at the same
        // parts from underneath, so there the whole body is flipped instead.
        const drawing = def && partDrawing(def, comp, (row, col) => holeCenter(row, col), HOLE_SPACING);
        if (!def || !drawing || !comp.boardPos) return null;
        const { pins } = drawing;
        // Label where the board editor has it, offset the user dragged
        // included. The cut sheet is mirrored, so the horizontal part of that
        // offset flips with it.
        const labelOff = comp.boardLabelOffset ?? { x: 0, y: 0 };
        const labelX = mirror ? minX + maxX - drawing.label.x - labelOff.x : drawing.label.x + labelOff.x;
        const labelY = drawing.label.y + labelOff.y;
        return (
          <g key={comp.id}>
            <g transform={mirror ? `translate(${minX + maxX} 0) scale(-1 1)` : undefined} opacity={mirror ? 0.45 : undefined}>
              <PartBody drawing={drawing} mono={!color || mirror} outline={drawing.pieces && color && !mirror ? "#333" : "#000"} outlineWidth={0.14}
                fill="none" strokeWidth={mirror ? 1.5 : 3} dashed={false} />
            </g>
            {pins.map((p, i) => (
              <circle key={i} cx={colX(p.col)} cy={rowY(p.row)} r={5}
                fill={mirror ? "none" : (color && holeColor(p.row, p.col)) || "#000"}
                stroke={color && !mirror ? "#fff" : compStroke} strokeWidth={1.5} />
            ))}
            {!mirror && showPinLabels && drawing.pinNames && pins.map((p, i) => {
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
              <text x={labelX} y={labelY} textAnchor="middle" dominantBaseline={drawing.label.onBody ? "central" : undefined} fontSize={16}
                fontWeight={700} fill={mirror ? "#666" : "#000"}
                stroke="#fff" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                {comp.label}
              </text>
            )}
          </g>
        );
      })}

      {!mirror && (() => {
        // Parallel wires sharing a column/row are shifted into lanes like on
        // the canvas. Print wires are thick and all black, so laned wires
        // additionally get a white casing that keeps touching runs readable.
        const laneOffsets = computeWireLaneOffsets(board.wires, 5);
        return board.wires.map((w) => {
          const off = laneOffsets.get(w.id);
          const dx = off?.dx ?? 0;
          const dy = off?.dy ?? 0;
          const a = { x: colX(w.from.col) + dx, y: rowY(w.from.row) + dy };
          const b = { x: colX(w.to.col) + dx, y: rowY(w.to.row) + dy };
          const ink = (color && groupColor(getGroupForWire(connectivity, w.id))) || "#000";
          return (
            <g key={w.id}>
              {(off || color) && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color ? "#222" : "#fff"} strokeWidth={color ? 5.5 : 7} strokeLinecap="round" />}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ink} strokeWidth={4} strokeLinecap="round" />
              <circle cx={a.x} cy={a.y} r={5} fill={ink} />
              <circle cx={b.x} cy={b.y} r={5} fill={ink} />
            </g>
          );
        });
      })()}

      {mirror && board.cuts.map((cut, i) => {
        const cx = cut.kind === "hole"
          ? colX(cut.col)
          : (colX(cut.col) + colX(cut.col + 1)) / 2;
        const cy = rowY(cut.row);
        const s = 9;
        return (
          <g key={`cut${i}`} stroke={color ? CONFLICT : "#000"} strokeWidth={mirror ? 5 : 4} strokeLinecap="round">
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
