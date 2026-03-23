"use client";

import { useState } from "react";
import { PinDef, BodyCell, ComponentDef } from "@/types";
import { createFootprintSymbol, registerCustomSymbol } from "@/data/symbolDefs";

type CellState = "body" | { pinId: string; pinName: string };

const CELL_SIZE = 36;
const CELL_GAP = 2;
const GRID_PADDING = 20;

interface Props {
  onSave: (def: ComponentDef) => void;
  onClose: () => void;
}

export default function CustomComponentEditor({ onSave, onClose }: Props) {
  const [name, setName] = useState("Custom Component");
  const [prefix, setPrefix] = useState("U");
  const [grid, setGrid] = useState<CellState[][]>([
    ["body", "body"],
    ["body", "body"],
  ]);
  const [editingPin, setEditingPin] = useState<{ row: number; col: number } | null>(null);
  const [pinId, setPinId] = useState("");
  const [pinName, setPinName] = useState("");
  const [draggingPin, setDraggingPin] = useState<{ pinId: string; pinName: string; fromRow: number; fromCol: number } | null>(null);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  const rows = grid.length;
  const cols = grid[0]?.length ?? 1;

  // Count pins
  let pinCount = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (typeof cell === "object") pinCount++;
    }
  }

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

  const handleCellClick = (row: number, col: number) => {
    if (draggingPin) return;
    const cell = grid[row][col];

    if (typeof cell === "object") {
      // Pin clicked — remove it back to body
      const newGrid = grid.map((r) => [...r]);
      newGrid[row][col] = "body";
      setGrid(newGrid);
    } else {
      // Body clicked — start creating a pin
      const nextNum = getNextPinNumber();
      setPinId(String(nextNum));
      setPinName(String(nextNum));
      setEditingPin({ row, col });
    }
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

  const handleCellMouseDown = (row: number, col: number) => {
    const cell = grid[row][col];
    if (typeof cell === "object" && !editingPin) {
      setDraggingPin({ ...cell, fromRow: row, fromCol: col });
    }
  };

  const handleCellMouseUp = (row: number, col: number) => {
    if (!draggingPin) return;
    const targetCell = grid[row][col];
    const newGrid = grid.map((r) => [...r]);

    if (row === draggingPin.fromRow && col === draggingPin.fromCol) {
      // Same cell — no-op
    } else if (targetCell === "body") {
      newGrid[draggingPin.fromRow][draggingPin.fromCol] = "body";
      newGrid[row][col] = { pinId: draggingPin.pinId, pinName: draggingPin.pinName };
      setGrid(newGrid);
    } else if (typeof targetCell === "object") {
      // Swap
      newGrid[draggingPin.fromRow][draggingPin.fromCol] = targetCell;
      newGrid[row][col] = { pinId: draggingPin.pinId, pinName: draggingPin.pinName };
      setGrid(newGrid);
    }
    setDraggingPin(null);
    setHoverCell(null);
  };

  const addRow = () => setGrid([...grid, Array.from({ length: cols }, () => "body" as CellState)]);
  const removeRow = () => {
    if (rows <= 1) return;
    if (grid[rows - 1].some((c) => typeof c === "object")) return;
    setGrid(grid.slice(0, -1));
  };
  const addCol = () => setGrid(grid.map((row) => [...row, "body" as CellState]));
  const removeCol = () => {
    if (cols <= 1) return;
    if (grid.some((row) => typeof row[cols - 1] === "object")) return;
    setGrid(grid.map((row) => row.slice(0, -1)));
  };

  const handleSave = () => {
    if (pinCount < 1 || !name.trim()) return;

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

    const defId = `custom-${crypto.randomUUID()}`;
    const symbolId = `custom-footprint-${defId}`;

    // Create and register the footprint symbol
    const symbol = createFootprintSymbol(pins, cols, rows);
    registerCustomSymbol(defId, { ...symbol, symbolId });

    const def: ComponentDef = {
      id: defId,
      name: name.trim(),
      category: "generic",
      symbol: symbolId,
      defaultLabelPrefix: prefix.trim() || "U",
      width: cols,
      height: rows,
      pins,
      bodyCells: bodyCells.length > 0 ? bodyCells : undefined,
    };

    onSave(def);
  };

  const svgWidth = cols * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;
  const svgHeight = grid.length * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
      onMouseUp={() => { setDraggingPin(null); setHoverCell(null); }}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-5 max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Create Custom Component
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Name and prefix */}
        <div className="flex gap-2 mb-3">
          <div className="flex-1">
            <label className="block text-xs text-neutral-700 dark:text-neutral-300 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400"
            />
          </div>
          <div className="w-16">
            <label className="block text-xs text-neutral-700 dark:text-neutral-300 mb-1">Prefix</label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              maxLength={3}
              className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400 text-center"
            />
          </div>
        </div>

        {/* Grid size controls */}
        <div className="flex items-center gap-4 mb-3 text-sm text-neutral-700 dark:text-neutral-300">
          <div className="flex items-center gap-1">
            <span>Rows: {rows}</span>
            <button onClick={addRow} className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">+</button>
            <button onClick={removeRow} className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">−</button>
          </div>
          <div className="flex items-center gap-1">
            <span>Cols: {cols}</span>
            <button onClick={addCol} className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">+</button>
            <button onClick={removeCol} className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">−</button>
          </div>
        </div>

        <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
          Click a cell to add a pin. Drag pins to reposition. Click a pin to remove it.
        </div>

        {/* Grid */}
        <svg
          width={svgWidth}
          height={svgHeight}
          className="border border-neutral-200 dark:border-neutral-700 rounded mb-3 bg-neutral-50 dark:bg-neutral-800 select-none"
          onMouseUp={() => { setDraggingPin(null); setHoverCell(null); }}
          onMouseLeave={() => { setDraggingPin(null); setHoverCell(null); }}
        >
          {grid.map((row, r) =>
            row.map((cell, c) => {
              const x = GRID_PADDING + c * (CELL_SIZE + CELL_GAP);
              const y = GRID_PADDING + r * (CELL_SIZE + CELL_GAP);
              const isPin = typeof cell === "object";
              const isDragSource = draggingPin?.fromRow === r && draggingPin?.fromCol === c;
              const hasMovedAway = isDragSource && hoverCell && (hoverCell.row !== r || hoverCell.col !== c);
              const isDropTarget = draggingPin && hoverCell?.row === r && hoverCell?.col === c && !isDragSource;
              const isEditingThis = editingPin?.row === r && editingPin?.col === c;

              return (
                <g
                  key={`${r}-${c}`}
                  style={{ cursor: isPin ? "grab" : "pointer" }}
                  onClick={() => !draggingPin && handleCellClick(r, c)}
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
                    stroke={isEditingThis ? "#3b82f6" : isDropTarget ? "#3b82f6" : "#a3a3a3"}
                    strokeWidth={isEditingThis || isDropTarget ? 2 : 1}
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

          {/* Drag ghost */}
          {draggingPin && hoverCell && (() => {
            const x = GRID_PADDING + hoverCell.col * (CELL_SIZE + CELL_GAP);
            const y = GRID_PADDING + hoverCell.row * (CELL_SIZE + CELL_GAP);
            return (
              <g pointerEvents="none" opacity={0.7}>
                <rect x={x} y={y} width={CELL_SIZE} height={CELL_SIZE} rx={4} fill="#404040" stroke="#3b82f6" strokeWidth={2} />
                <circle cx={x + CELL_SIZE / 2} cy={y + CELL_SIZE / 2 - 4} r={6} fill="white" />
                <text x={x + CELL_SIZE / 2} y={y + CELL_SIZE / 2 + 12} textAnchor="middle" fontSize={8} fill="white">
                  {draggingPin.pinName}
                </text>
              </g>
            );
          })()}
        </svg>

        {/* Pin editing form */}
        {editingPin && (
          <div className="flex gap-2 mb-3 items-end">
            <div>
              <label className="block text-xs text-neutral-700 dark:text-neutral-300 mb-1">Pin ID</label>
              <input
                autoFocus
                value={pinId}
                onChange={(e) => setPinId(e.target.value)}
                className="w-16 border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400"
                onKeyDown={(e) => e.key === "Enter" && commitPin()}
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-700 dark:text-neutral-300 mb-1">Pin Name</label>
              <input
                value={pinName}
                onChange={(e) => setPinName(e.target.value)}
                className="w-24 border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400"
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

        {/* Validation */}
        {pinCount === 0 && (
          <div className="text-xs text-amber-600 mb-2">
            Add at least one pin to create a component
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={pinCount < 1 || !name.trim()}
            className="flex-1 bg-[#113768] text-white text-sm py-2 rounded hover:bg-[#0d2a50] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create Component
          </button>
          <button
            onClick={onClose}
            className="flex-1 bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 text-sm py-2 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
