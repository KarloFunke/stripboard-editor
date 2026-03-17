"use client";

import { useMemo } from "react";
import type { PreviewData } from "@/lib/api";
import type { Component, ComponentDef, Net, NetAssignment, Wire, Cut } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import {
  getComponentBounds,
  getRotatedPinPositions,
} from "./stripboard/boardLayout";

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
    const components = (data.components ?? []) as Component[];
    const savedDefs = (data.componentDefs ?? []) as ComponentDef[];
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = savedDefs.filter((d) => !defaultIds.has(d.id));
    const componentDefs = [...DEFAULT_COMPONENTS, ...customDefs];
    const nets = (data.nets ?? []) as Net[];
    const netAssignments = (data.netAssignments ?? []) as NetAssignment[];
    const board = data.board as { rows?: number; cols?: number; wires?: Wire[]; cuts?: Cut[] };
    const wires = (board.wires ?? []) as Wire[];
    const cuts = (board.cuts ?? []) as Cut[];

    const placed = components.filter((c) => c.boardPos !== null);
    if (placed.length === 0) return null;

    // Find bounds across all placed components
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    for (const comp of placed) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def || !comp.boardPos) continue;
      const bounds = getComponentBounds(def, comp.boardPos, comp.rotation);
      minRow = Math.min(minRow, bounds.minRow);
      maxRow = Math.max(maxRow, bounds.maxRow);
      minCol = Math.min(minCol, bounds.minCol);
      maxCol = Math.max(maxCol, bounds.maxCol);
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

    return {
      placed, componentDefs, nets, netAssignments,
      minRow, maxRow, minCol, maxCol, rows, cols,
      svgW, svgH, hx, hy, visibleWires, visibleCuts,
    };
  }, [data]);

  if (!preview) return null;

  const {
    placed, componentDefs, nets, netAssignments,
    minRow, maxRow, minCol, maxCol, rows, cols,
    svgW, svgH, hx, hy, visibleWires, visibleCuts,
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
      className="rounded border border-neutral-200 bg-white"
    >
      {/* Strips */}
      {Array.from({ length: rows }, (_, ri) => {
        const row = minRow + ri;
        return (
          <rect
            key={`s-${ri}`}
            x={hx(minCol) - HOLE_SP * 0.3}
            y={hy(row) - STRIP_H / 2}
            width={(cols - 1) * HOLE_SP + HOLE_SP * 0.6}
            height={STRIP_H}
            fill="#D4A853"
            opacity={0.35}
            rx={0.5}
          />
        );
      })}

      {/* Holes */}
      {Array.from({ length: rows }, (_, ri) =>
        Array.from({ length: cols }, (_, ci) => (
          <circle
            key={`h-${ri}-${ci}`}
            cx={hx(minCol + ci)}
            cy={hy(minRow + ri)}
            r={HOLE_R}
            fill="white"
            stroke="#d4d4d4"
            strokeWidth={0.3}
          />
        ))
      )}

      {/* Cuts */}
      {visibleCuts.map((cut, i) => {
        const cx = (hx(cut.col) + hx(cut.col + 1)) / 2;
        const cy = hy(cut.row);
        const s = 2;
        return (
          <g key={`cut-${i}`}>
            <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} stroke="#ef4444" strokeWidth={1.2} />
            <line x1={cx + s} y1={cy - s} x2={cx - s} y2={cy + s} stroke="#ef4444" strokeWidth={1.2} />
          </g>
        );
      })}

      {/* Placed components */}
      {placed.map((comp) => {
        const def = resolveComponentDef(comp, componentDefs);
        if (!def || !comp.boardPos) return null;
        const bounds = getComponentBounds(def, comp.boardPos, comp.rotation);
        const pins = getRotatedPinPositions(def, comp.boardPos, comp.rotation);
        const padC = HOLE_SP * 0.3;

        return (
          <g key={comp.id}>
            {/* Body rect */}
            <rect
              x={hx(bounds.minCol) - padC}
              y={hy(bounds.minRow) - padC}
              width={(bounds.maxCol - bounds.minCol) * HOLE_SP + padC * 2}
              height={(bounds.maxRow - bounds.minRow) * HOLE_SP + padC * 2}
              rx={1.5}
              fill="rgba(255,255,255,0.85)"
              stroke="#a3a3a3"
              strokeWidth={0.5}
              strokeDasharray="2 1.5"
            />
            {/* Pins */}
            {pins.map((pin) => {
              const assignment = netAssignments.find(
                (a) => a.componentId === comp.id && a.pinId === pin.pinId
              );
              const net = assignment ? nets.find((n) => n.id === assignment.netId) : null;
              return (
                <circle
                  key={pin.pinId}
                  cx={hx(pin.col)}
                  cy={hy(pin.row)}
                  r={net ? 2.5 : HOLE_R}
                  fill={net ? net.color : "white"}
                  stroke={net ? "white" : "#d4d4d4"}
                  strokeWidth={net ? 0.8 : 0.3}
                />
              );
            })}
          </g>
        );
      })}

      {/* Wires */}
      {visibleWires.map((wire, i) => (
        <line
          key={`w-${i}`}
          x1={hx(wire.from.col)}
          y1={hy(wire.from.row)}
          x2={hx(wire.to.col)}
          y2={hy(wire.to.row)}
          stroke="#404040"
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
