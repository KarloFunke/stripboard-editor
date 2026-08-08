"use client";

import { useMemo } from "react";
import type { PreviewData } from "@/lib/api";
import type { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import {
  getComponentBounds,
  getRotatedPinPositions,
  getFlexiblePinPositions,
  getFlexibleBounds,
} from "./stripboard/boardLayout";
import { bodyStyle, bellyPath, dipNotch, usbPort, diagonalBody } from "./stripboard/componentGlyphs";
import { computeWireLaneOffsets } from "./stripboard/wireLanes";
import { computeStripSegments } from "./stripboard/stripSegments";
import { barRect, segmentBars, severedGaps } from "./stripboard/copperBars";
import { boardTopology, hasHole } from "./stripboard/boardTopology";

const HOLE_SP = 12; // compact spacing for preview
const HOLE_R = 2;
const PAD = 8;
// A bus is drawn a shade heavier than a strip, as it is on the board.
const COPPER_WIDTH = { strip: 3, bus: 4 };

interface Props {
  data: PreviewData;
  maxWidth?: number;
  maxHeight?: number;
}

export default function StripboardPreview({ data, maxWidth = 280, maxHeight = 160 }: Props) {
  const preview = useMemo(() => {
    const components = (data.components ?? []) as unknown as Component[];
    const savedDefs = (data.componentDefs ?? []) as unknown as ComponentDef[];
    const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
    const customDefs = savedDefs.filter((d) => !defaultIds.has(d.id));
    const componentDefs = [...DEFAULT_COMPONENTS, ...customDefs];
    const nets = (data.nets ?? []) as unknown as Net[];
    const netAssignments = (data.netAssignments ?? []) as unknown as NetAssignment[];
    const saved = data.board as unknown as Partial<Board>;
    const board: Board = {
      rows: saved.rows ?? 25,
      cols: saved.cols ?? 25,
      wires: saved.wires ?? [],
      cuts: saved.cuts ?? [],
      ...(saved.layout ? { layout: saved.layout } : {}),
    };
    const wires = board.wires;
    const cuts = board.cuts;

    const placed = components.filter((c) => c.boardPos !== null);
    if (placed.length === 0) return null;

    // Find bounds across all placed components
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    for (const comp of placed) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def || !comp.boardPos) continue;
      const isFlexible = def.flexible ?? false;
      const bounds = isFlexible
        ? getFlexibleBounds(comp, def)
        : getComponentBounds(def, comp.boardPos, comp.rotation);
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

    // Lane shifts for parallel wires, scaled to the compact hole pitch
    const laneOffsets = computeWireLaneOffsets(wires, 1.5);

    // The copper the board actually has, rather than one strip per row: a
    // thumbnail of a custom board should show the board it was built on.
    //
    // A thumbnail crops to the components, but segments span the whole
    // board, so each bar is trimmed to that window — a strip running off
    // the edge should stop at it, not trail past the last hole shown.
    const OVERSHOOT = 0.3;
    const copper = computeStripSegments(board, placed, componentDefs, netAssignments)
      .flatMap((seg) => segmentBars(seg, board, severedGaps(board)))
      .map((b) => ({
        ...b,
        row1: Math.max(b.row1, minRow - OVERSHOOT),
        row2: Math.min(b.row2, maxRow + OVERSHOOT),
        col1: Math.max(b.col1, minCol - OVERSHOOT),
        col2: Math.min(b.col2, maxCol + OVERSHOOT),
      }))
      .filter((b) => b.row1 <= b.row2 && b.col1 <= b.col2);

    return {
      placed, componentDefs, nets, netAssignments,
      topo: boardTopology(board), copper,
      minRow, maxRow, minCol, maxCol, rows, cols,
      svgW, svgH, hx, hy, visibleWires, visibleCuts, laneOffsets,
    };
  }, [data]);

  if (!preview) return null;

  const {
    placed, componentDefs, nets, netAssignments, topo, copper,
    minRow, minCol, rows, cols,
    svgW, svgH, hx, hy, visibleWires, visibleCuts, laneOffsets,
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
      className="font-sans rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900"
    >
      {/* Copper, from the geometry the board editor and the printout use */}
      {copper.map((b, i) => (
        <rect
          key={`s-${i}`}
          {...barRect(b, hx, hy, COPPER_WIDTH)}
          fill="#D4A853" opacity={0.35} rx={0.5}
        />
      ))}

      {/* Holes */}
      {Array.from({ length: rows }, (_, ri) =>
        Array.from({ length: cols }, (_, ci) => {
          // A board map can leave a position with no hole in it.
          if (!hasHole(topo, minRow + ri, minCol + ci)) return null;
          return (
            <circle
              key={`h-${ri}-${ci}`}
              cx={hx(minCol + ci)}
              cy={hy(minRow + ri)}
              r={HOLE_R}
              fill="var(--hole-fill)"
              stroke="var(--hole-stroke)"
              strokeWidth={0.3}
            />
          );
        })
      )}

      {/* Cuts */}
      {visibleCuts.map((cut, i) => {
        const cx = cut.kind === "hole"
          ? hx(cut.col)
          : (hx(cut.col) + hx(cut.col + 1)) / 2;
        const cy = hy(cut.row);
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
        if (!def || !comp.boardPos) return null;
        const isFlexible = def.flexible ?? false;
        const bounds = isFlexible
          ? getFlexibleBounds(comp, def)
          : getComponentBounds(def, comp.boardPos, comp.rotation);
        const pins = isFlexible
          ? getFlexiblePinPositions(comp, def)
          : getRotatedPinPositions(def, comp.boardPos, comp.rotation);
        const padC = HOLE_SP * 0.3;
        const style = bodyStyle(def);
        const pinPt = (i: number) => ({ x: hx(pins[i].col), y: hy(pins[i].row) });
        const rectBody = (
          <rect
            x={hx(bounds.minCol) - padC}
            y={hy(bounds.minRow) - padC}
            width={(bounds.maxCol - bounds.minCol) * HOLE_SP + padC * 2}
            height={(bounds.maxRow - bounds.minRow) * HOLE_SP + padC * 2}
            rx={1.5}
            fill="var(--component-fill)"
            stroke="var(--component-stroke)"
            strokeWidth={0.5}
            strokeDasharray="2 1.5"
          />
        );
        const diag = isFlexible && pins.length === 2 ? diagonalBody(pinPt(0), pinPt(1), padC) : null;
        let body = diag ? (
          <rect
            x={diag.x}
            y={diag.y}
            width={diag.width}
            height={diag.height}
            rx={1.5}
            fill="var(--component-fill)"
            stroke="var(--component-stroke)"
            strokeWidth={0.5}
            strokeDasharray="2 1.5"
            transform={diag.transform}
          />
        ) : rectBody;
        let notch: React.ReactNode = null;
        if (style === "belly" && pins.length === 3) {
          body = (
            <path d={bellyPath(pinPt(0), pinPt(2), padC)} fill="var(--component-fill)" stroke="var(--component-stroke)" strokeWidth={0.5} />
          );
        } else if (style === "dip" && pins.length >= 4) {
          const center = {
            x: (hx(bounds.minCol) + hx(bounds.maxCol)) / 2,
            y: (hy(bounds.minRow) + hy(bounds.maxRow)) / 2,
          };
          notch = (
            <path d={dipNotch(pins.map((p) => ({ x: hx(p.col), y: hy(p.row), id: p.pinId })), center, padC)} fill="none" stroke="var(--component-stroke)" strokeWidth={0.5} />
          );
        } else if (style === "board" && pins.length >= 4) {
          const center = {
            x: (hx(bounds.minCol) + hx(bounds.maxCol)) / 2,
            y: (hy(bounds.minRow) + hy(bounds.maxRow)) / 2,
          };
          const bodyRect = {
            x0: hx(bounds.minCol) - padC, y0: hy(bounds.minRow) - padC,
            x1: hx(bounds.maxCol) + padC, y1: hy(bounds.maxRow) + padC,
          };
          notch = (
            <path d={usbPort(pins.map((p) => ({ x: hx(p.col), y: hy(p.row), id: p.pinId })), center, bodyRect, HOLE_SP / 2.54)} fill="var(--component-fill)" stroke="var(--component-stroke)" strokeWidth={0.5} />
          );
        }

        return (
          <g key={comp.id}>
            {body}
            {notch}
            {/* Pins */}
            {pins.map((pin) => {
              const assignment = netAssignments.find(
                (a) => a.componentId === comp.id && a.pinId === pin.pinId
              );
              const net = assignment ? nets.find((n) => n.id === assignment.netId) : null;
              return (
                <circle
                  key={`${pin.pinId}-${pin.row}-${pin.col}`}
                  cx={hx(pin.col)}
                  cy={hy(pin.row)}
                  r={net ? 2.5 : HOLE_R}
                  fill={net ? net.color : "var(--hole-fill)"}
                  stroke={net ? "var(--hole-fill)" : "var(--hole-stroke)"}
                  strokeWidth={net ? 0.8 : 0.3}
                />
              );
            })}
          </g>
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
