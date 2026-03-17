"use client";

import { useState, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { PinDef, BodyCell } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";

type CellState = "empty" | "body" | { pinId: string; pinName: string };

const CELL_SIZE = 36;
const CELL_GAP = 2;
const GRID_PADDING = 20;

export default function FootprintEditor() {
  const editingComponentId = useProjectStore((s) => s.editingFootprintComponentId);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const updateComponentFootprint = useProjectStore((s) => s.updateComponentFootprint);
  const setEditingFootprintComponent = useProjectStore((s) => s.setEditingFootprintComponent);

  const component = components.find((c) => c.id === editingComponentId);
  const def = component ? resolveComponentDef(component, componentDefs) : undefined;

  // Initialize grid from the effective def (base or override)
  const initialGrid = useMemo(() => {
    if (!def) return [["body" as CellState]];
    const maxRow = Math.max(
      ...def.pins.map((p) => p.offsetRow),
      ...(def.bodyCells?.map((c) => c.row) ?? []),
      0
    );
    const maxCol = Math.max(
      ...def.pins.map((p) => p.offsetCol),
      ...(def.bodyCells?.map((c) => c.col) ?? []),
      0
    );

    const grid: CellState[][] = Array.from({ length: maxRow + 1 }, () =>
      Array.from({ length: maxCol + 1 }, () => "body" as CellState)
    );

    if (def.bodyCells) {
      for (const cell of def.bodyCells) {
        grid[cell.row][cell.col] = "body";
      }
    }

    for (const pin of def.pins) {
      grid[pin.offsetRow][pin.offsetCol] = {
        pinId: pin.id,
        pinName: pin.name,
      };
    }

    return grid;
  }, [def]);

  const [grid, setGrid] = useState<CellState[][]>(initialGrid);
  const [editingPin, setEditingPin] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [pinName, setPinName] = useState("");
  const [pinId, setPinId] = useState("");

  if (!def || !component || !editingComponentId) return null;

  const rows = grid.length;
  const cols = grid[0]?.length ?? 1;

  const handleCellClick = (row: number, col: number) => {
    const cell = grid[row][col];
    const newGrid = grid.map((r) => [...r]);

    if (cell === "empty") {
      newGrid[row][col] = "body";
    } else if (cell === "body") {
      const nextNum = getNextPinNumber();
      setPinId(String(nextNum));
      setPinName(String(nextNum));
      setEditingPin({ row, col });
      return;
    } else {
      // Pin → body (not empty)
      newGrid[row][col] = "body";
    }
    setGrid(newGrid);
  };

  const getNextPinNumber = (): number => {
    let max = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (typeof cell === "object") {
          const num = parseInt(cell.pinId, 10);
          if (!isNaN(num) && num > max) max = num;
        }
      }
    }
    return max + 1;
  };

  const commitPin = () => {
    if (!editingPin || !pinId.trim()) {
      setEditingPin(null);
      return;
    }
    const newGrid = grid.map((r) => [...r]);
    newGrid[editingPin.row][editingPin.col] = {
      pinId: pinId.trim(),
      pinName: pinName.trim() || pinId.trim(),
    };
    setGrid(newGrid);
    setEditingPin(null);
  };

  const addRow = () => {
    setGrid([...grid, Array.from({ length: cols }, () => "body" as CellState)]);
  };

  const removeRow = () => {
    if (rows <= 1) return;
    setGrid(grid.slice(0, -1));
  };

  const addCol = () => {
    setGrid(grid.map((row) => [...row, "body" as CellState]));
  };

  const removeCol = () => {
    if (cols <= 1) return;
    setGrid(grid.map((row) => row.slice(0, -1)));
  };

  const handleSave = () => {
    const pins: PinDef[] = [];
    const bodyCells: BodyCell[] = [];

    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cell = grid[r][c];
        if (typeof cell === "object") {
          pins.push({
            id: cell.pinId,
            name: cell.pinName,
            offsetRow: r,
            offsetCol: c,
          });
        } else if (cell === "body") {
          bodyCells.push({ row: r, col: c });
        }
      }
    }

    updateComponentFootprint(editingComponentId, {
      width: cols,
      height: grid.length,
      pins,
      bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
    });
    setEditingFootprintComponent(null);
  };

  const close = () => setEditingFootprintComponent(null);

  const svgWidth = cols * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;
  const svgHeight = grid.length * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={close}
    >
      <div
        className="bg-white rounded-lg shadow-xl p-5 max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-900">
            Edit Footprint — {component.label}
          </h2>
          <button
            onClick={close}
            className="text-neutral-400 hover:text-neutral-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Grid size controls */}
        <div className="flex items-center gap-4 mb-3 text-sm text-neutral-700">
          <div className="flex items-center gap-1">
            <span>Rows: {grid.length}</span>
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
        <svg width={svgWidth} height={svgHeight} className="border border-neutral-200 rounded mb-3 bg-neutral-50">
          {grid.map((row, r) =>
            row.map((cell, c) => {
              const x = GRID_PADDING + c * (CELL_SIZE + CELL_GAP);
              const y = GRID_PADDING + r * (CELL_SIZE + CELL_GAP);
              const isPin = typeof cell === "object";
              const isBody = cell === "body";
              const isEditingThisCell =
                editingPin?.row === r && editingPin?.col === c;

              return (
                <g key={`${r}-${c}`} onClick={() => handleCellClick(r, c)} style={{ cursor: "pointer" }}>
                  <rect
                    x={x}
                    y={y}
                    width={CELL_SIZE}
                    height={CELL_SIZE}
                    rx={4}
                    fill={isPin ? "#404040" : isBody ? "#d4d4d4" : "white"}
                    stroke={isEditingThisCell ? "#3b82f6" : "#a3a3a3"}
                    strokeWidth={isEditingThisCell ? 2 : 1}
                  />
                  {isPin && (
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
                  {isBody && (
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
        </svg>

        {/* Pin editing form */}
        {editingPin && (
          <div className="flex gap-2 mb-3 items-end">
            <div>
              <label className="block text-xs text-neutral-700 mb-1">Pin ID</label>
              <input
                autoFocus
                value={pinId}
                onChange={(e) => setPinId(e.target.value)}
                className="w-16 border border-neutral-300 rounded px-2 py-1 text-sm text-neutral-900 outline-none focus:border-blue-400"
                onKeyDown={(e) => e.key === "Enter" && commitPin()}
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-700 mb-1">Pin Name</label>
              <input
                value={pinName}
                onChange={(e) => setPinName(e.target.value)}
                className="w-24 border border-neutral-300 rounded px-2 py-1 text-sm text-neutral-900 outline-none focus:border-blue-400"
                onKeyDown={(e) => e.key === "Enter" && commitPin()}
              />
            </div>
            <button
              onClick={commitPin}
              className="bg-[#113768] text-white text-sm px-3 py-1 rounded hover:bg-[#0d2a50]"
            >
              Set
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex-1 bg-[#113768] text-white text-sm py-2 rounded hover:bg-[#0d2a50] transition-colors"
          >
            Save Footprint
          </button>
          <button
            onClick={close}
            className="flex-1 bg-neutral-100 text-neutral-700 text-sm py-2 rounded hover:bg-neutral-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
