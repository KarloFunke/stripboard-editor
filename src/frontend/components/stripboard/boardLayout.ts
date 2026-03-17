import { ComponentDef, Component, Cut, BodyCell } from "@/types";

// Grid constants
export const HOLE_SPACING = 30;
export const HOLE_RADIUS = 4.5;
export const BOARD_PADDING = 60;
export const STRIP_HEIGHT = 6;
export const LABEL_FONT_SIZE = 11;

// Copper strip color
export const STRIP_COLOR = "#D4A853";
export const STRIP_CONFLICT_COLOR = "#dc2626";

/** Convert grid coordinates to SVG pixel coordinates */
export function holeCenter(row: number, col: number): { x: number; y: number } {
  return {
    x: BOARD_PADDING + col * HOLE_SPACING,
    y: BOARD_PADDING + row * HOLE_SPACING,
  };
}

/** Snap SVG pixel coordinates to nearest hole, or null if out of bounds */
export function nearestHole(
  svgX: number,
  svgY: number,
  rows: number,
  cols: number
): { row: number; col: number } | null {
  const col = Math.round((svgX - BOARD_PADDING) / HOLE_SPACING);
  const row = Math.round((svgY - BOARD_PADDING) / HOLE_SPACING);
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  return { row, col };
}

/** Snap to nearest cut position (midpoint between two adjacent holes on same row) */
export function nearestCutPosition(
  svgX: number,
  svgY: number,
  rows: number,
  cols: number
): Cut | null {
  const row = Math.round((svgY - BOARD_PADDING) / HOLE_SPACING);
  const colFloat = (svgX - BOARD_PADDING) / HOLE_SPACING - 0.5;
  const col = Math.round(colFloat);
  if (row < 0 || row >= rows || col < 0 || col >= cols - 1) return null;

  const midX = BOARD_PADDING + (col + 0.5) * HOLE_SPACING;
  const holeY = BOARD_PADDING + row * HOLE_SPACING;
  const dist = Math.sqrt((svgX - midX) ** 2 + (svgY - holeY) ** 2);
  if (dist > HOLE_SPACING * 0.25) return null;

  return { row, col };
}

/** Get the bounding box max row/col for a component def (pins + body cells) */
function getDefMaxExtents(def: ComponentDef): { maxRow: number; maxCol: number } {
  const allRows = def.pins.map((p) => p.offsetRow);
  const allCols = def.pins.map((p) => p.offsetCol);
  if (def.bodyCells) {
    allRows.push(...def.bodyCells.map((c) => c.row));
    allCols.push(...def.bodyCells.map((c) => c.col));
  }
  return {
    maxRow: Math.max(...allRows),
    maxCol: Math.max(...allCols),
  };
}

/** Apply rotation to a single (row, col) offset */
function rotateOffset(
  r: number,
  c: number,
  rotation: Component["rotation"],
  maxRow: number,
  maxCol: number
): { r: number; c: number } {
  switch (rotation) {
    case 90:
      return { r: c, c: maxRow - r };
    case 180:
      return { r: maxRow - r, c: maxCol - c };
    case 270:
      return { r: maxCol - c, c: r };
    default:
      return { r, c };
  }
}

export interface PinPosition {
  pinId: string;
  row: number;
  col: number;
}

/** Get absolute board positions of all pins after applying rotation */
export function getRotatedPinPositions(
  def: ComponentDef,
  boardPos: { row: number; col: number },
  rotation: Component["rotation"]
): PinPosition[] {
  const { maxRow, maxCol } = getDefMaxExtents(def);

  return def.pins.map((pin) => {
    const rotated = rotateOffset(pin.offsetRow, pin.offsetCol, rotation, maxRow, maxCol);
    return {
      pinId: pin.id,
      row: boardPos.row + rotated.r,
      col: boardPos.col + rotated.c,
    };
  });
}

/** Get absolute board positions of all body cells after applying rotation */
export function getRotatedBodyCells(
  def: ComponentDef,
  boardPos: { row: number; col: number },
  rotation: Component["rotation"]
): { row: number; col: number }[] {
  if (!def.bodyCells || def.bodyCells.length === 0) return [];
  const { maxRow, maxCol } = getDefMaxExtents(def);

  return def.bodyCells.map((cell) => {
    const rotated = rotateOffset(cell.row, cell.col, rotation, maxRow, maxCol);
    return {
      row: boardPos.row + rotated.r,
      col: boardPos.col + rotated.c,
    };
  });
}

/** Get the bounding box of a component on the board (pins + body cells) */
export function getComponentBounds(
  def: ComponentDef,
  boardPos: { row: number; col: number },
  rotation: Component["rotation"]
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
  const pins = getRotatedPinPositions(def, boardPos, rotation);
  const bodyCells = getRotatedBodyCells(def, boardPos, rotation);

  const allRows = [...pins.map((p) => p.row), ...bodyCells.map((c) => c.row)];
  const allCols = [...pins.map((p) => p.col), ...bodyCells.map((c) => c.col)];

  return {
    minRow: Math.min(...allRows),
    minCol: Math.min(...allCols),
    maxRow: Math.max(...allRows),
    maxCol: Math.max(...allCols),
  };
}
