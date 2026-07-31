import { Board, BoardPosition, Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import { AutoLayoutResult } from "../layoutTypes";

// Rows/columns a result actually needs: the extent of footprints, wires
// and cuts. The tidy pass's synthetic dimension locks pad the result to
// the full cap, and unused trailing lines are real board the user would
// buy. A user-locked dimension is never trimmed.
function usedDimsOf(
  result: AutoLayoutResult,
  components: Component[],
  componentDefs: ComponentDef[]
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  let loR = Infinity;
  let loC = Infinity;
  let hiR = -1;
  let hiC = -1;
  const take = (r1: number, c1: number, r2 = r1, c2 = c1) => {
    loR = Math.min(loR, r1, r2);
    loC = Math.min(loC, c1, c2);
    hiR = Math.max(hiR, r1, r2);
    hiC = Math.max(hiC, c1, c2);
  };
  for (const c of components) {
    const p = byId.get(c.id);
    const boardPos = p?.boardPos ?? c.boardPos;
    if (!boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      const end = p?.flexibleEndPos ?? c.flexibleEndPos ?? boardPos;
      take(boardPos.row, boardPos.col, end.row, end.col);
    } else {
      const b = getComponentBounds(def, boardPos, p?.rotation ?? c.rotation);
      take(b.minRow, b.minCol, b.maxRow, b.maxCol);
    }
  }
  for (const w of result.wires) take(w.from.row, w.from.col, w.to.row, w.to.col);
  for (const cut of result.cuts) {
    take(cut.row, cut.col);
    if (cut.kind !== "hole") take(cut.row, cut.col + 1);
  }
  return { minRow: Math.min(loR, hiR < 0 ? 0 : loR), minCol: Math.min(loC, hiC < 0 ? 0 : loC), maxRow: hiR, maxCol: hiC };
}

// Unused lines around the content are real board the user would buy:
// trailing ones are trimmed off the size, leading ones removed by
// shifting the content to the edge (the channel pass runs after the
// harvest, so an inserted-then-abandoned line has no other cleaner). A
// user-locked dimension keeps its exact size (physical board), and
// locked parts pin everything in place.
export function trimResult(
  result: AutoLayoutResult,
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  hasLockedParts: boolean
): AutoLayoutResult {
  if (!result.boardSize) return result;
  const used = usedDimsOf(result, components, componentDefs);
  if (used.maxRow < 0) return result;
  const shiftR = board.lockedRows || hasLockedParts ? 0 : Math.max(0, used.minRow);
  const shiftC = board.lockedCols || hasLockedParts ? 0 : Math.max(0, used.minCol);
  const finalRows = board.lockedRows ? result.boardSize.rows : Math.min(result.boardSize.rows, used.maxRow + 1) - shiftR;
  const finalCols = board.lockedCols ? result.boardSize.cols : Math.min(result.boardSize.cols, used.maxCol + 1) - shiftC;
  if (shiftR === 0 && shiftC === 0 && finalRows === result.boardSize.rows && finalCols === result.boardSize.cols) {
    return result;
  }
  const sh = (p: BoardPosition): BoardPosition => ({ row: p.row - shiftR, col: p.col - shiftC });
  return {
    ...result,
    placements: result.placements.map((p) => ({
      ...p,
      boardPos: sh(p.boardPos),
      ...(p.flexibleEndPos ? { flexibleEndPos: sh(p.flexibleEndPos) } : {}),
    })),
    wires: result.wires.map((w) => ({ from: sh(w.from), to: sh(w.to) })),
    cuts: result.cuts.map((c) => ({ ...c, row: c.row - shiftR, col: c.col - shiftC })),
    boardSize: { rows: finalRows, cols: finalCols },
  };
}
