/** Grid size for the schematic canvas — all pin positions must be multiples of this */
export const GRID_SIZE = 20;

/** Snap a value to the nearest grid point */
export function snapToGrid(val: number): number {
  return Math.round(val / GRID_SIZE) * GRID_SIZE;
}

/** Create a grid-aligned point key for spatial matching */
export function pointKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}
