import { Board, Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions } from "../boardLayout";
import { AutoLayoutResult } from "../layoutTypes";

// Humans line cuts up on shared columns: a straight line of drills is far
// easier to transfer onto the physical board. Each cut may slide inside its
// dead zone — the run of holes around it carrying no pin, no wire endpoint
// and no other cut — without changing which used holes end up on each side
// of the break, so moving it there has no electrical consequence. Greedy:
// repeatedly pick the column the most still-unaligned cuts can reach (one
// per row) and gather them there. Hole cuts sit on their hole, between-cuts
// half a step past theirs, so the two kinds align in separate groups.
export function alignCuts(
  result: AutoLayoutResult,
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[]
): AutoLayoutResult {
  const cuts = result.cuts;
  if (cuts.length < 2) return result;
  const cols = result.boardSize?.cols ?? board.cols;
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  const usedRows = new Map<number, number[]>();
  const mark = (r: number, c: number) => {
    if (!usedRows.has(r)) usedRows.set(r, []);
    usedRows.get(r)!.push(c);
  };
  for (const c of components) {
    const p = byId.get(c.id);
    const boardPos = p?.boardPos ?? c.boardPos;
    if (!boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      const end = p?.flexibleEndPos ?? c.flexibleEndPos ?? boardPos;
      mark(boardPos.row, boardPos.col);
      mark(end.row, end.col);
    } else {
      for (const pin of getRotatedPinPositions(def, boardPos, p?.rotation ?? c.rotation)) mark(pin.row, pin.col);
    }
  }
  for (const w of result.wires) {
    mark(w.from.row, w.from.col);
    mark(w.to.row, w.to.col);
  }

  const xOf = (col: number, kind: string | undefined) => (kind === "hole" ? col : col + 0.5);
  const origX = cuts.map((c) => xOf(c.col, c.kind));
  const posX = [...origX];
  const cutsByRow = new Map<number, number[]>();
  cuts.forEach((c, i) => {
    if (!cutsByRow.has(c.row)) cutsByRow.set(c.row, []);
    cutsByRow.get(c.row)!.push(i);
  });

  type Item = { i: number; row: number; kind: "hole" | "between"; cur: number; lo: number; hi: number };
  const items: Item[] = [];
  cuts.forEach((cut, i) => {
    const kind: "hole" | "between" = cut.kind === "hole" ? "hole" : "between";
    const x = origX[i];
    let loX = -1;
    let hiX = cols;
    for (const u of usedRows.get(cut.row) ?? []) {
      if (u < x) loX = Math.max(loX, u);
      else hiX = Math.min(hiX, u);
    }
    for (const j of cutsByRow.get(cut.row)!) {
      if (j === i) continue;
      if (origX[j] < x) loX = Math.max(loX, origX[j]);
      else hiX = Math.min(hiX, origX[j]);
    }
    let lo = kind === "hole" ? Math.floor(loX) + 1 : Math.floor(loX + 0.5);
    let hi = kind === "hole" ? Math.ceil(hiX) - 1 : Math.ceil(hiX - 0.5) - 1;
    lo = Math.max(lo, 0);
    hi = Math.min(hi, kind === "hole" ? cols - 1 : cols - 2);
    // A cut on a used hole or sharing a spot (corrupt input) stays put but
    // can still anchor a group at its own column.
    if (lo > cut.col || hi < cut.col) {
      lo = cut.col;
      hi = cut.col;
    }
    items.push({ i, row: cut.row, kind, cur: cut.col, lo, hi });
  });

  // Moving may not reorder or collide with same-row cuts (their dead zones
  // can share edge holes, so interval clamping alone is not enough once
  // neighbours have moved).
  const validAt = (it: Item, v: number): boolean => {
    const xv = xOf(v, it.kind);
    for (const j of cutsByRow.get(it.row)!) {
      if (j === it.i) continue;
      if (xv === posX[j]) return false;
      if (xv < posX[j] !== origX[it.i] < origX[j]) return false;
    }
    return true;
  };

  const assigned = new Array(cuts.length).fill(false);
  const newCol = cuts.map((c) => c.col);
  for (;;) {
    let best: { sel: Item[]; v: number; size: number; already: number; dist: number } | null = null;
    for (const kind of ["hole", "between"] as const) {
      const pool = items.filter((it) => it.kind === kind && !assigned[it.i]);
      if (pool.length === 0) continue;
      const fixedAt = new Map<number, number>();
      for (const it of items) {
        if (it.kind !== kind || !assigned[it.i]) continue;
        fixedAt.set(newCol[it.i], (fixedAt.get(newCol[it.i]) ?? 0) + 1);
      }
      for (let v = 0; v < cols; v++) {
        const perRow = new Map<number, Item>();
        for (const it of pool) {
          if (v < it.lo || v > it.hi || !validAt(it, v)) continue;
          const prev = perRow.get(it.row);
          if (!prev || Math.abs(it.cur - v) < Math.abs(prev.cur - v)) perRow.set(it.row, it);
        }
        const size = perRow.size + (fixedAt.get(v) ?? 0);
        if (perRow.size < 1 || size < 2) continue;
        const sel = [...perRow.values()];
        const already = sel.filter((it) => it.cur === v).length;
        const dist = sel.reduce((s, it) => s + Math.abs(it.cur - v), 0);
        if (!best || size > best.size ||
            (size === best.size && (already > best.already || (already === best.already && dist < best.dist)))) {
          best = { sel, v, size, already, dist };
        }
      }
    }
    if (!best) break;
    for (const it of best.sel) {
      assigned[it.i] = true;
      newCol[it.i] = best.v;
      posX[it.i] = xOf(best.v, it.kind);
    }
  }

  if (!cuts.some((c, i) => newCol[i] !== c.col)) return result;
  return { ...result, cuts: cuts.map((c, i) => (newCol[i] !== c.col ? { ...c, col: newCol[i] } : c)) };
}
