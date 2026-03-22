"use client";

import { useState, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { PinDef, BodyCell } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";

type CellState = "body" | { pinId: string; pinName: string };

const CELL_SIZE = 36;
const CELL_GAP = 2;
const GRID_PADDING = 20;

interface Props {
  componentId: string;
  onClose: () => void;
}

export default function StripboardFootprintEditor({ componentId, onClose }: Props) {
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const updateComponentFootprint = useProjectStore((s) => s.updateComponentFootprint);

  const component = components.find((c) => c.id === componentId);
  const baseDef = component ? componentDefs.find((d) => d.id === component.defId) : undefined;
  const def = component ? resolveComponentDef(component, componentDefs) : undefined;

  const requiredPinCount = baseDef?.pins.length ?? 0;

  const initialGrid = useMemo(() => {
    if (!def) return [["body" as CellState]];
    const maxRow = Math.max(...def.pins.map((p) => p.offsetRow), ...(def.bodyCells?.map((c) => c.row) ?? []), 0);
    const maxCol = Math.max(...def.pins.map((p) => p.offsetCol), ...(def.bodyCells?.map((c) => c.col) ?? []), 0);

    const grid: CellState[][] = Array.from({ length: maxRow + 1 }, () =>
      Array.from({ length: maxCol + 1 }, () => "body" as CellState)
    );

    for (const pin of def.pins) {
      grid[pin.offsetRow][pin.offsetCol] = { pinId: pin.id, pinName: pin.name };
    }

    return grid;
  }, [def]);

  const [grid, setGrid] = useState<CellState[][]>(initialGrid);
  const [draggingPin, setDraggingPin] = useState<{ pinId: string; pinName: string; fromRow: number; fromCol: number } | null>(null);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  if (!def || !component || !baseDef) return null;

  const rows = grid.length;
  const cols = grid[0]?.length ?? 1;

  // Count placed pins
  let placedCount = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (typeof cell === "object") placedCount++;
    }
  }
  const allPinsPlaced = placedCount >= requiredPinCount;

  const handleCellMouseDown = (row: number, col: number) => {
    const cell = grid[row][col];
    if (typeof cell === "object") {
      // Start dragging this pin
      setDraggingPin({ ...cell, fromRow: row, fromCol: col });
    }
  };

  const handleCellMouseUp = (row: number, col: number) => {
    if (!draggingPin) return;

    const targetCell = grid[row][col];
    const newGrid = grid.map((r) => [...r]);

    if (row === draggingPin.fromRow && col === draggingPin.fromCol) {
      // Dropped on same cell — no-op
    } else if (targetCell === "body") {
      // Move pin to this body cell
      newGrid[draggingPin.fromRow][draggingPin.fromCol] = "body";
      newGrid[row][col] = { pinId: draggingPin.pinId, pinName: draggingPin.pinName };
      setGrid(newGrid);
    } else if (typeof targetCell === "object") {
      // Swap pins
      newGrid[draggingPin.fromRow][draggingPin.fromCol] = targetCell;
      newGrid[row][col] = { pinId: draggingPin.pinId, pinName: draggingPin.pinName };
      setGrid(newGrid);
    }

    setDraggingPin(null);
    setHoverCell(null);
  };

  const handleMouseUp = () => {
    setDraggingPin(null);
    setHoverCell(null);
  };

  const addRow = () => {
    setGrid([...grid, Array.from({ length: cols }, () => "body" as CellState)]);
  };

  const removeRow = () => {
    if (rows <= 1) return;
    // Don't remove if last row has pins
    const lastRow = grid[rows - 1];
    if (lastRow.some((c) => typeof c === "object")) return;
    setGrid(grid.slice(0, -1));
  };

  const addCol = () => {
    setGrid(grid.map((row) => [...row, "body" as CellState]));
  };

  const removeCol = () => {
    if (cols <= 1) return;
    // Don't remove if last col has pins
    if (grid.some((row) => typeof row[cols - 1] === "object")) return;
    setGrid(grid.map((row) => row.slice(0, -1)));
  };

  const handleSave = () => {
    if (!allPinsPlaced) return;

    const pins: PinDef[] = [];
    const bodyCells: BodyCell[] = [];

    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cell = grid[r][c];
        if (typeof cell === "object") {
          pins.push({ id: cell.pinId, name: cell.pinName, offsetRow: r, offsetCol: c });
        } else {
          bodyCells.push({ row: r, col: c });
        }
      }
    }

    updateComponentFootprint(componentId, {
      width: cols,
      height: grid.length,
      pins,
      bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
    });
    onClose();
  };

  const svgWidth = cols * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;
  const svgHeight = grid.length * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
      onMouseUp={handleMouseUp}
    >
      <div
        className="bg-white rounded-lg shadow-xl p-5 max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-900">
            Edit Footprint - {component.label}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Grid size controls */}
        <div className="flex items-center gap-4 mb-3 text-sm text-neutral-700">
          <div className="flex items-center gap-1">
            <span>Rows: {rows}</span>
            <button onClick={addRow} className="px-1.5 py-0.5 bg-neutral-100 rounded hover:bg-neutral-200">+</button>
            <button onClick={removeRow} className="px-1.5 py-0.5 bg-neutral-100 rounded hover:bg-neutral-200">−</button>
          </div>
          <div className="flex items-center gap-1">
            <span>Cols: {cols}</span>
            <button onClick={addCol} className="px-1.5 py-0.5 bg-neutral-100 rounded hover:bg-neutral-200">+</button>
            <button onClick={removeCol} className="px-1.5 py-0.5 bg-neutral-100 rounded hover:bg-neutral-200">−</button>
          </div>
        </div>

        {/* Grid */}
        <svg
          width={svgWidth}
          height={svgHeight}
          className="border border-neutral-200 rounded mb-3 bg-neutral-50 select-none"
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {grid.map((row, r) =>
            row.map((cell, c) => {
              const x = GRID_PADDING + c * (CELL_SIZE + CELL_GAP);
              const y = GRID_PADDING + r * (CELL_SIZE + CELL_GAP);
              const isPin = typeof cell === "object";
              const isDragSource = draggingPin?.fromRow === r && draggingPin?.fromCol === c;
              const hasMovedAway = isDragSource && hoverCell && (hoverCell.row !== r || hoverCell.col !== c);
              const isDropTarget = draggingPin && hoverCell?.row === r && hoverCell?.col === c && !isDragSource;

              return (
                <g
                  key={`${r}-${c}`}
                  style={{ cursor: isPin ? "grab" : draggingPin ? "pointer" : "default" }}
                  onMouseDown={() => handleCellMouseDown(r, c)}
                  onMouseUp={() => handleCellMouseUp(r, c)}
                  onMouseEnter={() => draggingPin && setHoverCell({ row: r, col: c })}
                >
                  <rect
                    x={x} y={y}
                    width={CELL_SIZE} height={CELL_SIZE}
                    rx={4}
                    fill={
                      hasMovedAway ? "#e5e5e5" :
                      isDropTarget ? "#dbeafe" :
                      isPin ? "#404040" :
                      "#d4d4d4"
                    }
                    stroke={isDropTarget ? "#3b82f6" : "#a3a3a3"}
                    strokeWidth={isDropTarget ? 2 : 1}
                  />
                  {isPin && !hasMovedAway && (
                    <>
                      <circle
                        cx={x + CELL_SIZE / 2}
                        cy={y + CELL_SIZE / 2 - 4}
                        r={6}
                        fill="white"
                        pointerEvents="none"
                      />
                      <text
                        x={x + CELL_SIZE / 2}
                        y={y + CELL_SIZE / 2 + 12}
                        textAnchor="middle"
                        fontSize={8}
                        fill="white"
                        pointerEvents="none"
                      >
                        {cell.pinName}
                      </text>
                    </>
                  )}
                  {!isPin && (
                    <circle
                      cx={x + CELL_SIZE / 2}
                      cy={y + CELL_SIZE / 2}
                      r={3}
                      fill="#a3a3a3"
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })
          )}

          {/* Drag ghost following cursor */}
          {draggingPin && hoverCell && (
            (() => {
              const x = GRID_PADDING + hoverCell.col * (CELL_SIZE + CELL_GAP);
              const y = GRID_PADDING + hoverCell.row * (CELL_SIZE + CELL_GAP);
              return (
                <g pointerEvents="none" opacity={0.7}>
                  <rect
                    x={x} y={y}
                    width={CELL_SIZE} height={CELL_SIZE}
                    rx={4}
                    fill="#404040"
                    stroke="#3b82f6"
                    strokeWidth={2}
                  />
                  <circle cx={x + CELL_SIZE / 2} cy={y + CELL_SIZE / 2 - 4} r={6} fill="white" />
                  <text
                    x={x + CELL_SIZE / 2} y={y + CELL_SIZE / 2 + 12}
                    textAnchor="middle" fontSize={8} fill="white"
                  >
                    {draggingPin.pinName}
                  </text>
                </g>
              );
            })()
          )}
        </svg>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={!allPinsPlaced}
            className="flex-1 bg-[#113768] text-white text-sm py-2 rounded hover:bg-[#0d2a50] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save Footprint
          </button>
          <button
            onClick={onClose}
            className="flex-1 bg-neutral-100 text-neutral-700 text-sm py-2 rounded hover:bg-neutral-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
