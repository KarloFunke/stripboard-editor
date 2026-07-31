// Canonical map/set key builders shared by the solver modules. The formats
// are load-bearing wherever a key is built in one place and probed in
// another, so build keys through these helpers instead of inline templates.

/** Key for a board hole. */
export const holeKey = (row: number, col: number): string => `${row},${col}`;

/** Key for a component pin (net lookup maps). */
export const pinKey = (componentId: string, pinId: string): string => `${componentId}:${pinId}`;
