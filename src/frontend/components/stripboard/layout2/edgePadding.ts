import { BoardPosition, Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";

// ── Blank lines that keep connectors on the rim ──
// A connector the anneal put on a board edge must stay there. When a blank
// line goes in outside it (routing room at the rim, a wire channel), the
// connector does not move with the rest: on the left and top it keeps its
// place while everything else shifts inward, on the right and bottom it
// moves out with the edge. Its own rows or columns then have the blank hole
// just inside it, so it still reaches every strip. A connector counts as on
// the rim of a side when no part lies beyond it on that side (wires may)
// and it is one line deep there: a deeper one (a header lying across the
// strips) has outer pins only the margin can reach, so it shifts with the
// rest and gets that margin. `pin` false shifts everything, the fallback
// for a board that does not route with the connectors kept.

function boundsOf(c: Component, componentDefs: ComponentDef[], isCol: boolean): { lo: number; hi: number; conn: boolean } | null {
  if (!c.boardPos || c.boardExcluded) return null;
  const def = resolveComponentDef(c, componentDefs);
  if (!def) return null;
  const conn = def.category === "connector";
  if (def.flexible) {
    const e = c.flexibleEndPos ?? c.boardPos;
    const a = isCol ? c.boardPos.col : c.boardPos.row;
    const b = isCol ? e.col : e.row;
    return { lo: Math.min(a, b), hi: Math.max(a, b), conn };
  }
  const b = getComponentBounds(def, c.boardPos, c.rotation);
  return isCol ? { lo: b.minCol, hi: b.maxCol, conn } : { lo: b.minRow, hi: b.maxRow, conn };
}

/** Insert a blank column (row) at `at`: positions at or past it shift by one. */
export function insertLine(comps: Component[], componentDefs: ComponentDef[], isCol: boolean, at: number, pin = true): Component[] {
  const bs = comps.map((c) => boundsOf(c, componentDefs, isCol));
  const keep = new Set<number>();
  const push = new Set<number>();
  if (pin) {
    bs.forEach((b, i) => {
      if (!b || !b.conn || b.hi > b.lo) return;
      if (at <= b.lo && !bs.some((o) => o && o.lo < b.lo)) keep.add(i);
      else if (at > b.hi && !bs.some((o) => o && o.hi > b.hi)) push.add(i);
    });
  }
  return comps.map((c, i) => {
    if (!c.boardPos || keep.has(i)) return c;
    const force = push.has(i);
    const shift = (p: BoardPosition): BoardPosition =>
      isCol ? (force || p.col >= at ? { row: p.row, col: p.col + 1 } : p) : (force || p.row >= at ? { row: p.row + 1, col: p.col } : p);
    return { ...c, boardPos: shift(c.boardPos), ...(c.flexibleEndPos ? { flexibleEndPos: shift(c.flexibleEndPos) } : {}) };
  });
}

/** Routing room around a finished skeleton: `lines` blank lines outside each side. */
export function padAroundEdgeConnectors(
  comps: Component[],
  componentDefs: ComponentDef[],
  rows: number,
  cols: number,
  lines: { top: number; bottom: number; left: number; right: number },
  pin = true
): { comps: Component[]; rows: number; cols: number } {
  let cur = comps;
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const isCol = side === "left" || side === "right";
    for (let k = 0; k < lines[side]; k++) {
      const at = side === "left" || side === "top" ? 0 : isCol ? cols : rows;
      cur = insertLine(cur, componentDefs, isCol, at, pin);
      if (isCol) cols++; else rows++;
    }
  }
  return { comps: cur, rows, cols };
}
