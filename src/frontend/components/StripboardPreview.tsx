"use client";

import { useMemo } from "react";
import type { PreviewData } from "@/lib/api";
import type { Board, BoardPattern, Component, ComponentDef, Net, NetAssignment, Wire, Cut } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { getComponentBounds, getFlexibleBounds } from "./stripboard/boardLayout";
import { computeWireLaneOffsets } from "./stripboard/wireLanes";
import { expandOffBoard } from "./stripboard/offBoard";
import { rigidBody } from "./stripboard/partGeometry";
import { StaticPart } from "./stripboard/partDrawing";
import { hasHole, joinsDown, joinsRight } from "./stripboard/boardPattern";

const HOLE_SP = 12; // compact spacing for preview
const HOLE_R = 2;
const PAD = 8;
const STRIP_H = 3;

interface Props {
  data: PreviewData;
  maxWidth?: number;
  maxHeight?: number;
}

export default function StripboardPreview({ data, maxWidth = 280, maxHeight = 160 }: Props) {
  const preview = useMemo(() => {
    const stored = (data.components ?? []) as unknown as Component[];
    const savedDefs = (data.componentDefs ?? []) as unknown as ComponentDef[];
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = savedDefs.filter((d) => !defaultIds.has(d.id));
    const componentDefs = [...DEFAULT_COMPONENTS, ...customDefs];
    const nets = (data.nets ?? []) as unknown as Net[];
    // Off-board parts show up as the pads or connector their wires arrive at
    const { components, netAssignments } = expandOffBoard(stored, componentDefs, (data.netAssignments ?? []) as unknown as NetAssignment[]);
    const board = data.board as unknown as { rows?: number; cols?: number; wires?: Wire[]; cuts?: Cut[]; pattern?: BoardPattern };
    const wires = (board.wires ?? []) as unknown as Wire[];
    const cuts = (board.cuts ?? []) as unknown as Cut[];

    const placed = components.filter((c) => c.boardPos !== null);
    if (placed.length === 0) return null;

    // Find bounds across all placed components
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    for (const comp of placed) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def || !comp.boardPos) continue;
      // A package may be bigger than its footprint (a standing pot)
      const bounds = def.flexible ? getFlexibleBounds(comp, def) : getComponentBounds(def, comp.boardPos, comp.rotation);
      const body = def.flexible ? bounds : rigidBody(def, comp.boardPos, comp.rotation);
      minRow = Math.min(minRow, bounds.minRow, Math.floor(body.minRow));
      maxRow = Math.max(maxRow, bounds.maxRow, Math.ceil(body.maxRow));
      minCol = Math.min(minCol, bounds.minCol, Math.floor(body.minCol));
      maxCol = Math.max(maxCol, bounds.maxCol, Math.ceil(body.maxCol));
    }

    // If no valid bounds were found, bail out
    if (!isFinite(minRow) || !isFinite(maxRow)) return null;

    // Add padding of 1 hole around bounds
    minRow = Math.max(0, minRow - 1);
    maxRow = Math.min((board.rows ?? 30) - 1, maxRow + 1);
    minCol = Math.max(0, minCol - 1);
    maxCol = Math.min((board.cols ?? 25) - 1, maxCol + 1);

    const rows = maxRow - minRow + 1;
    const cols = maxCol - minCol + 1;
    const svgW = cols * HOLE_SP + PAD * 2;
    const svgH = rows * HOLE_SP + PAD * 2;

    // Helper to convert grid to local SVG coords
    const hx = (col: number) => PAD + (col - minCol) * HOLE_SP;
    const hy = (row: number) => PAD + (row - minRow) * HOLE_SP;

    // Filter wires and cuts within bounds
    const visibleWires = wires.filter(
      (w) =>
        w.from.row >= minRow && w.from.row <= maxRow &&
        w.to.row >= minRow && w.to.row <= maxRow &&
        w.from.col >= minCol && w.from.col <= maxCol &&
        w.to.col >= minCol && w.to.col <= maxCol
    );
    const visibleCuts = cuts.filter(
      (c) => c.row >= minRow && c.row <= maxRow && c.col >= minCol && c.col <= maxCol
    );

    // Lane shifts for parallel wires, scaled to the compact hole pitch
    const laneOffsets = computeWireLaneOffsets(wires, 1.5);

    // The copper in view: whole rows on plain stripboard, the straight runs
    // of a board with a pattern, and only the holes the board has
    const shape: Board = { rows: board.rows ?? 30, cols: board.cols ?? 25, cuts: [], wires: [], pattern: board.pattern };
    const copper: { from: [number, number]; to: [number, number] }[] = [];
    const holes: [number, number][] = [];
    for (let r = minRow; r <= maxRow; r++) {
      if (!board.pattern) copper.push({ from: [r, minCol], to: [r, maxCol] });
      for (let c = minCol; c <= maxCol; c++) {
        if (hasHole(shape, r, c)) holes.push([r, c]);
        if (!board.pattern) continue;
        if (c < maxCol && joinsRight(shape, r, c) && (c === minCol || !joinsRight(shape, r, c - 1))) {
          let end = c + 1;
          while (end < maxCol && joinsRight(shape, r, end)) end++;
          copper.push({ from: [r, c], to: [r, end] });
        }
        if (r < maxRow && joinsDown(shape, r, c) && (r === minRow || !joinsDown(shape, r - 1, c))) {
          let end = r + 1;
          while (end < maxRow && joinsDown(shape, end, c)) end++;
          copper.push({ from: [r, c], to: [end, c] });
        }
      }
    }

    return {
      placed, componentDefs, nets, netAssignments,
      minRow, maxRow, minCol, maxCol, rows, cols,
      svgW, svgH, hx, hy, visibleWires, visibleCuts, laneOffsets, copper, holes,
    };
  }, [data]);

  if (!preview) return null;

  const {
    placed, componentDefs, nets, netAssignments,
    svgW, svgH, hx, hy, visibleWires, visibleCuts, laneOffsets, copper, holes,
  } = preview;

  // Scale to fit within maxWidth/maxHeight
  const scale = Math.min(1, maxWidth / svgW, maxHeight / svgH);
  const displayW = svgW * scale;
  const displayH = svgH * scale;

  return (
    <svg
      width={displayW}
      height={displayH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      className="font-sans rounded border border-neutral-200 dark:border-neutral-700 bg-[var(--board-fill)]"
    >
      {/* Strips */}
      {copper.map(({ from, to }, i) => {
        const x1 = Math.min(hx(from[1]), hx(to[1]));
        const y1 = Math.min(hy(from[0]), hy(to[0]));
        const along = from[0] === to[0];
        return (
          <rect
            key={`s-${i}`}
            x={along ? x1 - HOLE_SP * 0.3 : x1 - STRIP_H / 2}
            y={along ? y1 - STRIP_H / 2 : y1 - HOLE_SP * 0.3}
            width={along ? hx(to[1]) - hx(from[1]) + HOLE_SP * 0.6 : STRIP_H}
            height={along ? STRIP_H : hy(to[0]) - hy(from[0]) + HOLE_SP * 0.6}
            fill="var(--strip-color)"
            opacity={0.55}
            rx={0.5}
          />
        );
      })}

      {/* Holes */}
      {holes.map(([row, col]) => (
        <circle
          key={`h-${row}-${col}`}
          cx={hx(col)}
          cy={hy(row)}
          r={HOLE_R}
          fill="var(--hole-fill)"
          stroke="var(--hole-stroke)"
          strokeWidth={0.3}
        />
      ))}

      {/* Cuts */}
      {visibleCuts.map((cut, i) => {
        const cx = cut.kind === "hole" || cut.kind === "below"
          ? hx(cut.col)
          : (hx(cut.col) + hx(cut.col + 1)) / 2;
        const cy = cut.kind === "below" ? (hy(cut.row) + hy(cut.row + 1)) / 2 : hy(cut.row);
        const s = 2;
        return (
          <g key={`cut-${i}`}>
            <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} stroke="var(--cut-stroke)" strokeWidth={1.2} />
            <line x1={cx + s} y1={cy - s} x2={cx - s} y2={cy + s} stroke="var(--cut-stroke)" strokeWidth={1.2} />
          </g>
        );
      })}

      {/* Placed components */}
      {placed.map((comp) => {
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) return null;
        return (
          <StaticPart
            key={comp.id}
            def={def}
            component={comp}
            at={(row, col) => ({ x: hx(col), y: hy(row) })}
            pitch={HOLE_SP}
            pinNames="none"
            pinStyle={(pin) => {
              const netId = netAssignments.find((a) => a.componentId === comp.id && a.pinId === pin.pinId)?.netId;
              return { color: nets.find((n) => n.id === netId)?.color ?? null };
            }}
          />
        );
      })}

      {/* Wires */}
      {visibleWires.map((wire, i) => {
        const off = laneOffsets.get(wire.id);
        const dx = off?.dx ?? 0;
        const dy = off?.dy ?? 0;
        return (
          <line
            key={`w-${i}`}
            x1={hx(wire.from.col) + dx}
            y1={hy(wire.from.row) + dy}
            x2={hx(wire.to.col) + dx}
            y2={hy(wire.to.row) + dy}
            stroke="var(--wire-default)"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
