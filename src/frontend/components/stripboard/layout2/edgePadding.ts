import { BoardPosition, Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";

// ── Routing room around a finished skeleton ──
// The finish pads the skeleton with blank lines so the router has channels
// and relay strips at the rim. A connector the anneal put on the board edge
// must stay there, and a blank line outside it would not: the strict router
// fills it with wires and the trim cannot take it back. So on an edge with
// a flush connector the line goes just inside the connector instead, at the
// first position past it that splits no other part; where no such position
// exists that side stays unpadded. `outside` forces the line outside on a
// side whose margin the skeleton's wiring already attached to (a two-row
// header flush on the edge can only reach its outer pins from there).
export function padAroundEdgeConnectors(
  comps: Component[],
  componentDefs: ComponentDef[],
  rows: number,
  cols: number,
  lines: { top: number; bottom: number; left: number; right: number },
  outside?: { top: boolean; bottom: boolean; left: boolean; right: boolean }
): { comps: Component[]; rows: number; cols: number } {
  const boundsOf = (c: Component): { lo: [number, number]; hi: [number, number]; conn: boolean } | null => {
    if (!c.boardPos || c.boardExcluded) return null;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) return null;
    if (def.flexible) {
      const e = c.flexibleEndPos ?? c.boardPos;
      return {
        lo: [Math.min(c.boardPos.row, e.row), Math.min(c.boardPos.col, e.col)],
        hi: [Math.max(c.boardPos.row, e.row), Math.max(c.boardPos.col, e.col)],
        conn: def.category === "connector",
      };
    }
    const b = getComponentBounds(def, c.boardPos, c.rotation);
    return { lo: [b.minRow, b.minCol], hi: [b.maxRow, b.maxCol], conn: def.category === "connector" };
  };
  const insertLine = (cs: Component[], isCol: boolean, at: number): Component[] =>
    cs.map((c) => {
      if (!c.boardPos) return c;
      const shift = (p: BoardPosition): BoardPosition =>
        isCol ? (p.col >= at ? { row: p.row, col: p.col + 1 } : p) : (p.row >= at ? { row: p.row + 1, col: p.col } : p);
      return { ...c, boardPos: shift(c.boardPos), ...(c.flexibleEndPos ? { flexibleEndPos: shift(c.flexibleEndPos) } : {}) };
    });
  let cur = comps;
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const isCol = side === "left" || side === "right";
    const axis = isCol ? 1 : 0;
    for (let k = 0; k < lines[side]; k++) {
      const n = isCol ? cols : rows;
      const bs = cur.map(boundsOf).filter((b): b is NonNullable<typeof b> => b !== null);
      const flush = bs.filter((b) => b.conn && (side === "left" || side === "top" ? b.lo[axis] === 0 : b.hi[axis] === n - 1));
      const straddled = (at: number) => bs.some((b) => b.lo[axis] < at && at <= b.hi[axis]);
      let at = -1;
      if (flush.length === 0 || outside?.[side]) {
        at = side === "left" || side === "top" ? 0 : n;
      } else if (side === "left" || side === "top") {
        const from = Math.max(...flush.map((b) => b.hi[axis])) + 1;
        for (let a = from; a <= n; a++) if (!straddled(a)) { at = a; break; }
      } else {
        const from = Math.min(...flush.map((b) => b.lo[axis]));
        for (let a = from; a >= 0; a--) if (!straddled(a)) { at = a; break; }
      }
      if (at < 0) break;
      cur = insertLine(cur, isCol, at);
      if (isCol) cols++; else rows++;
    }
  }
  return { comps: cur, rows, cols };
}
