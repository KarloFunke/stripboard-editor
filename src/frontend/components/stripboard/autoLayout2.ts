import {
  Board,
  BoardPosition,
  Component,
  ComponentDef,
  Net,
  NetAssignment,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions, getComponentBounds, getComponentPinPositions } from "./boardLayout";
import { deriveCompletion, CompletionPlan } from "./autoFinish";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { checkNetCompleteness } from "./netCompleteness";
import {
  FootprintRect,
  WireObstacles,
  bodiesTooClose,
  segmentIntersectsRect,
  spanLimits,
  segmentsIntersect,
  bodyIntersectsRect,
  corridorHoles,
  clearanceOf,
  wireExtraLength,
} from "./flexGeometry";
import { AutoLayoutProgress, AutoLayoutResult, LayoutPlacement, computeAutoLayout } from "./autoLayout";
import { clusterCapFor, buildComponentGraph, agglomerate } from "./layout2/clustering";
import {
  Tile,
  DimLimits,
  analyzeCluster,
  planTile,
  flipTile,
  MAX_TILE_RIGIDS,
} from "./layout2/tilePlanning";
import { composeTiles } from "./layout2/composeTiles";
import { floorplan2D, Fixed2D } from "./layout2/floorplan2D";
import { compactPlacements } from "./layout2/compaction";

// ── The v2 "strip-first" layouter ──────────────────────
//
// Human stripboard layouts put same-net pins on shared copper and build in
// functional blocks. This layouter reproduces that directly:
//
//  stage 0  cluster the netlist into blocks (size-capped agglomeration over
//           a fanout-weighted component graph — high-fanout power nets
//           self-neutralize at weight 1/(k-1))
//  stage 1  plan each block strip-first: nets get strip rows, 2-pin parts
//           become short drops between their nets' rows, an IC pins its
//           nets to its pin rows; exact search over the remaining rows
//  stage 2  compose the block tiles in bands (tiles side by side share
//           strip rows; aligned same-net rows join by bare copper) and let
//           the router derive the cuts and the few remaining wires
//
// The solver chooses the board size; the caller applies it via
// AutoLayoutResult.boardSize.

// ── Orchestrator ───────────────────────────────────────

export interface AutoLayout2Options {
  // Skip the final compaction harvest after the tile polish (benchmarking
  // lever: isolates what the per-tile annealing contributes on its own)
  harvest?: boolean;
  // Cluster size cap override (cap study / future size-adaptive cap)
  maxCluster?: number;
  // Tidy second pass: when the clean result still has messy wires, re-solve
  // with the achieved width locked and accept the result if it is strictly
  // tidier and its area stays within this growth fraction (Infinity = any).
  tidyGrowth?: number;
}

// IC-like rigids (>= 4 physical pins) pin their nets to fixed footprint
// geometry; a net joining two of them cannot be absorbed by any flexible
// part. The count of such joins predicts residual wire mess (corpus knee
// at 0 -> 1, escalation with count), so it gates the IC-channel treatment.
const IC_MIN_PINS = 4;
function rigidJoinsOf(components: Component[], componentDefs: ComponentDef[], netAssignments: NetAssignment[]): number {
  const icIds = new Set(
    components
      .filter((c) => {
        if (c.boardExcluded) return false;
        const d = resolveComponentDef(c, componentDefs);
        return !!d && !d.flexible && d.pins.length >= IC_MIN_PINS;
      })
      .map((c) => c.id)
  );
  const perNet = new Map<string, Set<string>>();
  for (const a of netAssignments) {
    if (!icIds.has(a.componentId)) continue;
    if (!perNet.has(a.netId)) perNet.set(a.netId, new Set());
    perNet.get(a.netId)!.add(a.componentId);
  }
  let joins = 0;
  for (const s of perNet.values()) joins += s.size - 1;
  return joins;
}

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

// Visual wire mess of a finished result on its solved positions: off-axis
// wires plus the priced part crossings. Judges the tidy pass.
function wireMessScore(
  result: AutoLayoutResult,
  components: Component[],
  componentDefs: ComponentDef[]
): { mess: number; crossings: number } {
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  const obstacles: WireObstacles = { rects: [], bodies: [] };
  for (const c of components) {
    const p = byId.get(c.id);
    const boardPos = p?.boardPos ?? c.boardPos;
    if (!boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) obstacles.bodies.push({ p1: boardPos, p2: p?.flexibleEndPos ?? c.flexibleEndPos ?? boardPos });
    else obstacles.rects.push(getComponentBounds(def, boardPos, p?.rotation ?? c.rotation));
  }
  let mess = 0;
  let crossings = 0;
  for (const w of result.wires) {
    mess += (w.from.col !== w.to.col ? 1 : 0) + wireExtraLength(w.from, w.to, obstacles);
    for (const rect of obstacles.rects) {
      if (segmentIntersectsRect(w.from, w.to, rect)) crossings++;
    }
    for (const b of obstacles.bodies) {
      if (segmentsIntersect(w.from, w.to, b.p1, b.p2)) crossings++;
    }
  }
  return { mess, crossings };
}

// Humans line cuts up on shared columns: a straight line of drills is far
// easier to transfer onto the physical board. Each cut may slide inside its
// dead zone — the run of holes around it carrying no pin, no wire endpoint
// and no other cut — without changing which used holes end up on each side
// of the break, so moving it there has no electrical consequence. Greedy:
// repeatedly pick the column the most still-unaligned cuts can reach (one
// per row) and gather them there. Hole cuts sit on their hole, between-cuts
// half a step past theirs, so the two kinds align in separate groups.
function alignCuts(
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
    const xv = xOf(v, it.kind === "hole" ? "hole" : undefined);
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
      posX[it.i] = xOf(best.v, it.kind === "hole" ? "hole" : undefined);
    }
  }

  if (!cuts.some((c, i) => newCol[i] !== c.col)) return result;
  return { ...result, cuts: cuts.map((c, i) => (newCol[i] !== c.col ? { ...c, col: newCol[i] } : c)) };
}

export function computeAutoLayout2(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout2Options
): AutoLayoutResult {
  const growCap = options?.tidyGrowth;
  // A fully locked board has no direction left to grow in; otherwise the
  // tidy pass runs. With a user-locked width the width itself is untouchable
  // (physical board) but rows are still free: IC-heavy projects get a
  // re-solve whose channel pass can insert relay rows.
  const bothLocked = !!board.lockedRows && !!board.lockedCols;
  const joins = growCap !== undefined && !bothLocked ? rigidJoinsOf(components, componentDefs, netAssignments) : 0;
  const nVariants = growCap === undefined || bothLocked ? 0 : joins > 0 ? (!board.lockedCols ? 3 : 2) : 1;
  const baseSpan = nVariants === 0 ? 1 : nVariants === 1 ? 0.6 : 0.5;
  const spans: [number, number][] = [[0, baseSpan]];
  for (let i = 0; i < nVariants; i++) spans.push([baseSpan + (i * (1 - baseSpan)) / nVariants, (1 - baseSpan) / nVariants]);
  const scaled = nVariants > 0 && onProgress
    ? (f0: number, span: number) => (p: AutoLayoutProgress) => onProgress({ ...p, frac: f0 + p.frac * span })
    : null;
  const aligned = (result: AutoLayoutResult): AutoLayoutResult =>
    result.quality === 0 ? alignCuts(result, board, components, componentDefs) : result;
  const base = layoutOnce(board, components, componentDefs, nets, netAssignments, scaled ? scaled(...spans[0]) : onProgress, options);
  if (nVariants === 0 || growCap === undefined || base.quality !== 0 || !base.boardSize) return aligned(base);

  // Unused lines around the content are real board the user would buy:
  // trailing ones are trimmed off the size, leading ones removed by
  // shifting the content to the edge (the channel pass runs after the
  // harvest, so an inserted-then-abandoned line has no other cleaner). A
  // user-locked dimension keeps its exact size (physical board), and
  // locked parts pin everything in place.
  const hasLockedParts = components.some((c) => c.locked && c.boardPos && !c.boardExcluded);
  const finish = (result: AutoLayoutResult): AutoLayoutResult => {
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
  };

  const finishedBase = finish(base);
  const baseScore = wireMessScore(base, components, componentDefs);
  if (baseScore.mess <= 0) return aligned(finishedBase);
  const baseArea = finishedBase.boardSize!.rows * finishedBase.boardSize!.cols;

  // Locking the found width changes the economics, not the budget: unused
  // columns are pre-paid (effArea covers the cap either way) and the aspect
  // penalty is lifted, so a re-solve can spend space on wire channels and
  // relay strips that the free objective taxes away as area. IC-heavy
  // projects try a second variant with width headroom — pre-paid channel
  // columns the channel pass can insert at IC footprint edges. Acceptance:
  // quality 0, within the growth cap, and strictly tidier — crossings
  // (wires over parts, the ugliest mess) may never trade up. Among
  // survivors, fewest crossings wins, then mess.
  let best: { result: AutoLayoutResult; score: { mess: number; crossings: number } } | null = null;
  const headroom = joins > 0 ? Math.min(6, 2 + (joins >> 3)) : 0;
  // With a free width the pass locks the achieved width (plus channel
  // headroom for IC-heavy projects). With a user-locked width the mirror
  // applies: a synthetic row lock pre-pays the achieved height so relay
  // rows come free, with row headroom for the IC channel pass.
  const variants: { rowCap?: number; colCap: number; icChannels: boolean }[] = !board.lockedCols
    ? [
        { colCap: base.boardSize.cols, icChannels: false },
        // Two IC variants: rows free (may grow tall past any headroom) and
        // rows pre-paid (a relay row that fixes a single crossing never
        // pays for itself in real area, but inside the row headroom it is
        // free). Each wins on different boards; the guard picks.
        ...(joins > 0
          ? [
              { colCap: base.boardSize.cols + headroom, icChannels: true },
              { rowCap: base.boardSize.rows + headroom, colCap: base.boardSize.cols + headroom, icChannels: true },
            ]
          : []),
      ]
    : [
        { rowCap: base.boardSize.rows, colCap: board.cols, icChannels: false },
        ...(joins > 0 ? [{ rowCap: base.boardSize.rows + headroom, colCap: board.cols, icChannels: true }] : []),
      ];
  variants.forEach(({ rowCap, colCap, icChannels }, vi) => {
    const capped = layoutOnce(
      { ...board, cols: colCap, lockedCols: true, ...(rowCap !== undefined ? { rows: rowCap, lockedRows: true } : {}) },
      components, componentDefs, nets, netAssignments,
      scaled ? scaled(...spans[vi + 1]) : undefined, options, icChannels
    );
    if (capped.quality !== 0 || !capped.boardSize || capped.boardSize.cols > colCap) return;
    if (rowCap !== undefined && capped.boardSize.rows > rowCap) return;
    const finished = finish(capped);
    if (finished.boardSize!.rows * finished.boardSize!.cols > baseArea * (1 + growCap)) return;
    const score = wireMessScore(capped, components, componentDefs);
    if (score.crossings > baseScore.crossings || score.mess >= baseScore.mess) return;
    if (best && (best.score.crossings < score.crossings ||
        (best.score.crossings === score.crossings && best.score.mess <= score.mess))) return;
    best = { result: finished, score };
  });
  return aligned(best ? (best as { result: AutoLayoutResult }).result : finishedBase);
}

function layoutOnce(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout2Options,
  icChannels = false
): AutoLayoutResult {
  const report = (phase: AutoLayoutProgress["phase"], frac: number) =>
    onProgress?.({ phase, attempt: 1, maxAttempts: 1, frac });
  const issues: string[] = [];

  // Locked parts stay exactly where they are. Locked rigids join their
  // block as fixed members (the block is designed around them and anchors
  // the tile to the board); locked flexes stay as plain obstacles. A locked
  // part without a board position is planned like an unlocked one.
  const lockedParts = components.filter((c) => c.locked && c.boardPos && !c.boardExcluded);
  const lockedIds = new Set(lockedParts.map((c) => c.id));
  const rectOfComp = (c: Component): FootprintRect => {
    const def = resolveComponentDef(c, componentDefs);
    if (def && !def.flexible) return getComponentBounds(def, c.boardPos!, c.rotation);
    const p2 = c.flexibleEndPos ?? c.boardPos!;
    return {
      minRow: Math.min(c.boardPos!.row, p2.row),
      minCol: Math.min(c.boardPos!.col, p2.col),
      maxRow: Math.max(c.boardPos!.row, p2.row),
      maxCol: Math.max(c.boardPos!.col, p2.col),
    };
  };

  // ── Stage 0 ──────────────────────────────────────────
  report("arrange", 0);
  const graph = buildComponentGraph(components, netAssignments);
  const membership = agglomerate(graph.adj, graph.nodes.length, options?.maxCluster ?? clusterCapFor(graph.nodes.length));
  const byCluster = new Map<number, Component[]>();
  graph.nodes.forEach((c, i) => {
    if (!byCluster.has(membership[i])) byCluster.set(membership[i], []);
    byCluster.get(membership[i])!.push(c);
  });
  const clusters = [...byCluster.values()].sort((a, b) => b.length - a.length);

  // ── Stage 1 ──────────────────────────────────────────
  const limits: DimLimits = {
    ...(board.lockedRows ? { maxRows: board.rows } : {}),
    ...(board.lockedCols ? { maxCols: board.cols } : {}),
  };
  // Under a locked width, plan one column narrower: the spare column at the
  // edge becomes a wire channel (routed via the +1 variant below), which a
  // tightly packed board needs for its link wires.
  const planLimits: DimLimits = {
    ...limits,
    ...(limits.maxCols !== undefined && limits.maxCols >= 12 ? { maxCols: limits.maxCols - 1 } : {}),
  };
  const tiles: Tile[] = [];
  const unplaced: Component[] = [];
  let planned = 0;
  // Chain the components by shared nets (seeded at `seed` if given) and cut
  // at the weakest link near the middle. Lets an oversized flex-heavy block
  // shed half its parts into a second tile that stacks below.
  const splitByNets = (cluster: Component[], clusterAsg: NetAssignment[], seed?: Component): [Component[], Component[]] | null => {
    if (cluster.length < 2) return null;
    const netsOf = new Map<string, Set<string>>();
    for (const a of clusterAsg) {
      if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
      netsOf.get(a.componentId)!.add(a.netId);
    }
    const shared = (a: Component, b: Component) => {
      let n = 0;
      for (const x of netsOf.get(a.id) ?? []) if (netsOf.get(b.id)?.has(x)) n++;
      return n;
    };
    const chain: Component[] = [seed ?? cluster.reduce((a, b) => {
      const sa = cluster.reduce((s, o) => s + (o === a ? 0 : shared(a, o)), 0);
      const sb = cluster.reduce((s, o) => s + (o === b ? 0 : shared(b, o)), 0);
      return sb > sa ? b : a;
    })];
    const rest = cluster.filter((c) => c !== chain[0]);
    while (rest.length > 0) {
      let best = 0;
      let bestW = -1;
      rest.forEach((c, i) => {
        const w = Math.max(...chain.map((o) => shared(o, c)));
        if (w > bestW) {
          bestW = w;
          best = i;
        }
      });
      chain.push(rest[best]);
      rest.splice(best, 1);
    }
    let cut = 1;
    let cutScore = Infinity;
    for (let i = 1; i < chain.length; i++) {
      const s = 10 * shared(chain[i - 1], chain[i]) + Math.abs(i - chain.length / 2);
      if (s < cutScore) {
        cutScore = s;
        cut = i;
      }
    }
    return [chain.slice(0, cut), chain.slice(cut)];
  };

  const planWithFallbacks = (cluster: Component[]) => {
    const ids = new Set(cluster.map((c) => c.id));
    const clusterAsg = netAssignments.filter((a) => ids.has(a.componentId));
    const analysis = analyzeCluster(cluster, clusterAsg, componentDefs);
    const k = analysis.rigids.length;
    if (k <= MAX_TILE_RIGIDS) {
      // blocks around locked members plan against the real caps — their
      // frozen span is what it is, no wire-channel reservation applies
      const tile = planTile(analysis, analysis.rigids.some((r) => r.fixed) ? limits : planLimits);
      // an anchored tile is judged by its absolute extent against the real caps
      const tooBig = tile !== null && (tile.anchor
        ? ((limits.maxCols !== undefined && tile.anchor.col + tile.width > limits.maxCols) ||
          (limits.maxRows !== undefined && tile.anchor.row + tile.height > limits.maxRows))
        : ((planLimits.maxCols !== undefined && tile.width > planLimits.maxCols) ||
          (planLimits.maxRows !== undefined && tile.height > planLimits.maxRows)));
      if (tile && !tooBig) {
        tiles.push(tile);
        unplaced.push(...tile.unplaced);
        return;
      }
      if (k <= 1) {
        if (tooBig && cluster.length >= 2) {
          // shed parts into a second tile until the block can fit
          const subs = splitByNets(cluster, clusterAsg, analysis.rigids[0]?.comp);
          if (subs && subs[0].length > 0 && subs[1].length > 0) {
            planWithFallbacks(subs[0]);
            planWithFallbacks(subs[1]);
            return;
          }
        }
        if (tile) {
          // a lone part's tile is as small as it gets — keep it and let
          // the floorplan report any overflow
          tiles.push(tile);
          unplaced.push(...tile.unplaced);
          return;
        }
        if (cluster.some((c) => lockedIds.has(c.id))) {
          // locked members stay put as plain obstacles; plan the rest
          const rest = cluster.filter((c) => !lockedIds.has(c.id));
          if (rest.length > 0) planWithFallbacks(rest);
          return;
        }
        issues.push(`block with ${cluster.map((c) => c.label).join(", ")}: no strip plan found`);
        unplaced.push(...cluster);
        return;
      }
      if (tooBig) {
        // the tile exceeds a locked dimension: split the rigid chain at its
        // weakest link and plan the halves — smaller tiles wrap into bands
        const netsOf = new Map<string, Set<string>>();
        for (const a of clusterAsg) {
          if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
          netsOf.get(a.componentId)!.add(a.netId);
        }
        const sharedPair = (x: number, z: number) => {
          let n = 0;
          for (const nid of netsOf.get(analysis.rigids[x].comp.id) ?? []) {
            if (netsOf.get(analysis.rigids[z].comp.id)?.has(nid)) n++;
          }
          return n;
        };
        let cut = 1;
        let cutScore = Infinity;
        for (let i = 1; i < k; i++) {
          const s = 10 * sharedPair(i - 1, i) + Math.abs(i - k / 2);
          if (s < cutScore) {
            cutScore = s;
            cut = i;
          }
        }
        const subs: Component[][] = [[], []];
        for (const comp of cluster) {
          subs[(analysis.groupOf.get(comp.id) ?? 0) < cut ? 0 : 1].push(comp);
        }
        if (subs[0].length > 0 && subs[1].length > 0) {
          planWithFallbacks(subs[0]);
          planWithFallbacks(subs[1]);
          return;
        }
      }
      // joint plan failed: retry one group per rigid
      const groups = new Map<number, Component[]>();
      for (const comp of cluster) {
        const gi = analysis.groupOf.get(comp.id) ?? 0;
        if (!groups.has(gi)) groups.set(gi, []);
        groups.get(gi)!.push(comp);
      }
      for (const sub of groups.values()) {
        if (sub.length === cluster.length) {
          if (sub.some((c) => lockedIds.has(c.id))) {
            const rest = sub.filter((c) => !lockedIds.has(c.id));
            if (rest.length > 0) planWithFallbacks(rest);
            return;
          }
          issues.push(`block with ${sub.map((c) => c.label).join(", ")}: no strip plan found`);
          unplaced.push(...sub);
          return;
        }
        planWithFallbacks(sub);
      }
      return;
    }
    // Too many rigids for one tile: cut the affinity chain at its weakest
    // links into runs that fit, so strongly connected rigids still share
    // strips and only the weakest nets become inter-tile wires.
    const netsOfRigid = analysis.rigids.map((r) =>
      new Set(clusterAsg.filter((a) => a.componentId === r.comp.id).map((a) => a.netId)));
    const sharedR = (a: number, b: number) => {
      let n = 0;
      for (const x of netsOfRigid[a]) if (netsOfRigid[b].has(x)) n++;
      return n;
    };
    const chunks: number[][] = [Array.from({ length: k }, (_, i) => i)];
    while (chunks.some((ch) => ch.length > MAX_TILE_RIGIDS)) {
      const idx = chunks.findIndex((ch) => ch.length > MAX_TILE_RIGIDS);
      const ch = chunks[idx];
      let best = 1;
      let bestScore = Infinity;
      for (let i = 1; i < ch.length; i++) {
        const oversize = Math.max(i, ch.length - i) > MAX_TILE_RIGIDS ? 1000 : 0;
        const score = oversize + 10 * sharedR(ch[i - 1], ch[i]) + Math.abs(i - ch.length / 2);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      chunks.splice(idx, 1, ch.slice(0, best), ch.slice(best));
    }
    const chunkOfRigid = new Map<number, number>();
    chunks.forEach((ch, ci) => ch.forEach((ri) => chunkOfRigid.set(ri, ci)));
    const subs: Component[][] = chunks.map(() => []);
    for (const comp of cluster) {
      const gi = analysis.groupOf.get(comp.id) ?? 0;
      subs[chunkOfRigid.get(gi) ?? 0].push(comp);
    }
    for (const sub of subs) {
      if (sub.length > 0) planWithFallbacks(sub);
    }
  };
  for (const cluster of clusters) {
    planWithFallbacks(cluster);
    planned++;
    report("arrange", planned / clusters.length);
  }
  // Parts that fell out of a tightly packed tile get one retry as a small
  // block of their own before they count as unplaced.
  if (unplaced.length > 0) {
    const retry = unplaced.filter((c) => !lockedIds.has(c.id));
    unplaced.length = 0;
    if (retry.length > 0) planWithFallbacks(retry);
  }

  // Locked parts the planner could not take as tile members stay put as
  // plain obstacles; anchored tiles that collide with each other (or with
  // those obstacles) are demoted the same way, biggest first.
  const obstacleRects: FootprintRect[] = [];
  const obstacleParts: Component[] = [];
  {
    const inTile = new Set<string>();
    for (const t of tiles) for (const rp of t.rigidParts) if (lockedIds.has(rp.comp.id)) inTile.add(rp.comp.id);
    for (const c of lockedParts) {
      if (inTile.has(c.id)) continue;
      obstacleRects.push(rectOfComp(c));
      obstacleParts.push(c);
    }
  }
  const tileRect = (t: Tile): FootprintRect => ({
    minRow: t.anchor!.row,
    minCol: t.anchor!.col,
    maxRow: t.anchor!.row + t.height - 1,
    maxCol: t.anchor!.col + t.width - 1,
  });
  const rectsTouch = (a: FootprintRect, b: FootprintRect) =>
    a.minCol <= b.maxCol + 1 && a.maxCol >= b.minCol - 1 &&
    a.minRow <= b.maxRow + 1 && a.maxRow >= b.minRow - 1;
  const demoteTile = (t: Tile) => {
    tiles.splice(tiles.indexOf(t), 1);
    const wasUnplaced = new Set(t.unplaced.map((c) => c.id));
    for (let i = unplaced.length - 1; i >= 0; i--) {
      if (wasUnplaced.has(unplaced[i].id)) unplaced.splice(i, 1);
    }
    const members = [...t.rigidParts.map((rp) => rp.comp), ...t.parts.map((p) => p.comp), ...t.unplaced];
    for (const c of members) {
      if (!lockedIds.has(c.id)) continue;
      obstacleRects.push(rectOfComp(c));
      obstacleParts.push(c);
    }
    const rest = members.filter((c) => !lockedIds.has(c.id));
    if (rest.length > 0) planWithFallbacks(rest);
  };
  {
    const anchoredSorted = tiles.filter((t) => t.anchor)
      .sort((a, b) => b.height * b.width - a.height * a.width);
    const kept: FootprintRect[] = [];
    for (const t of anchoredSorted) {
      const r = tileRect(t);
      if ([...kept, ...obstacleRects].some((o) => rectsTouch(r, o))) demoteTile(t);
      else kept.push(r);
    }
  }
  let fixedRects: FootprintRect[] = [];
  let fixedMaxRow = -1;
  let fixedMaxCol = -1;
  let fixedContentRects: FootprintRect[] = [];
  const computeFixed = () => {
    fixedRects = [...tiles.filter((t) => t.anchor).map(tileRect), ...obstacleRects];
    fixedMaxRow = Math.max(-1, ...fixedRects.map((r) => r.maxRow));
    fixedMaxCol = Math.max(-1, ...fixedRects.map((r) => r.maxCol));
    // Part-level footprints of everything that stands still: free blocks may
    // nest into an anchored tile's unused interior, not just avoid its bbox.
    fixedContentRects = [...obstacleRects];
    for (const t of tiles) {
      if (!t.anchor) continue;
      const ar = t.anchor.row;
      const ac = t.anchor.col;
      for (const rp of t.rigidParts) {
        const def = resolveComponentDef(rp.comp, componentDefs);
        if (def) {
          fixedContentRects.push(getComponentBounds(def, { row: rp.row + ar, col: rp.col + ac }, rp.rotation));
        }
      }
      for (const p of t.parts) {
        fixedContentRects.push({
          minRow: Math.min(p.row1, p.row2 ?? p.row1) + ar,
          minCol: Math.min(p.col1, p.col2 ?? p.col1) + ac,
          maxRow: Math.max(p.row1, p.row2 ?? p.row1) + ar,
          maxCol: Math.max(p.col1, p.col2 ?? p.col1) + ac,
        });
      }
    }
    for (const t of tiles) t.flipped = flipTile(t, componentDefs);
  };
  computeFixed();

  // ── Stage 2 ──────────────────────────────────────────
  report("place", 0.1);
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) netOfPin.set(`${a.componentId}:${a.pinId}`, a.netId);

  // The fixed frame as the 2D floorplanner sees it: anchored tiles' net
  // rows AND locked obstacle pins, so free tiles can align rows with both.
  const fixed2DNow = (): Fixed2D => {
    const netRows: Fixed2D["netRows"] = [];
    for (const t of tiles) {
      if (!t.anchor) continue;
      for (const [net, rows] of t.rowsOfNet) {
        for (const r of rows) {
          netRows.push({ net, row: t.anchor.row + r, xLo: t.anchor.col, xHi: t.anchor.col + t.width - 1 });
        }
      }
    }
    for (const c of obstacleParts) {
      const def = resolveComponentDef(c, componentDefs);
      if (!def) continue;
      for (const p of getComponentPinPositions(c, def)) {
        const net = netOfPin.get(`${c.id}:${p.pinId}`);
        if (net !== undefined) netRows.push({ net, row: p.row, xLo: p.col, xHi: p.col });
      }
    }
    return { rects: fixedContentRects, spans: fixedRects, netRows };
  };

  const materialize = (gap: number, use2D: boolean) => {
    const freeTiles = tiles.filter((t) => !t.anchor);
    const anchoredTiles = tiles.filter((t) => t.anchor);
    const fp2 = use2D && freeTiles.length > 0 ? floorplan2D(freeTiles, fixed2DNow(), gap, planLimits) : null;
    const floorplan = !fp2 && freeTiles.length > 0 ? composeTiles(freeTiles, gap, planLimits) : null;
    const fpRows = Math.max(1, floorplan?.rows ?? 0);
    const fpCols = Math.max(1, floorplan?.cols ?? 0);
    // Place the free block clear of anchored tiles and locked obstacles:
    // as-is if nothing collides, else right of or below all of them.
    let ox = 0;
    let oy0 = 0;
    if (fixedContentRects.length > 0 && floorplan) {
      const collides = (dy: number, dx: number) =>
        fixedContentRects.some((r) =>
          dx <= r.maxCol + 1 && dx + fpCols - 1 >= r.minCol - 1 &&
          dy <= r.maxRow + 1 && dy + fpRows - 1 >= r.minRow - 1);
      let bestArea = Infinity;
      for (let dy = 0; dy <= fixedMaxRow + 2; dy++) {
        for (let dx = 0; dx <= fixedMaxCol + 2; dx++) {
          if (collides(dy, dx)) continue;
          const rowsC = Math.max(dy + fpRows, fixedMaxRow + 1);
          const colsC = Math.max(dx + fpCols, fixedMaxCol + 1);
          const over =
            (limits.maxRows ? Math.max(0, rowsC - limits.maxRows) : 0) +
            (limits.maxCols ? Math.max(0, colsC - limits.maxCols) : 0);
          const area =
            (limits.maxRows ? Math.max(limits.maxRows, rowsC) : rowsC) *
            (limits.maxCols ? Math.max(limits.maxCols, colsC) : colsC) + 200 * over;
          if (area < bestArea) {
            bestArea = area;
            oy0 = dy;
            ox = dx;
          }
        }
      }
      if (bestArea === Infinity) {
        oy0 = fixedMaxRow + 2;
        ox = 0;
      }
    }
    const rows = Math.max(
      5,
      fp2 ? fp2.rows : floorplan ? oy0 + fpRows : (fixedRects.length > 0 ? 0 : board.rows),
      fixedMaxRow + 1
    );
    let cols = Math.max(
      5,
      fp2 ? fp2.cols : floorplan ? ox + fpCols : (fixedRects.length > 0 ? 0 : board.cols),
      fixedMaxCol + 1
    );
    const moved = new Map<string, Component>();
    for (const t of anchoredTiles) {
      const ar = t.anchor!.row;
      const ac = t.anchor!.col;
      for (const rp of t.rigidParts) {
        if (lockedIds.has(rp.comp.id)) continue; // it is already exactly there
        moved.set(rp.comp.id, {
          ...rp.comp,
          boardPos: { row: rp.row + ar, col: rp.col + ac },
          rotation: rp.rotation,
          flexibleEndPos: undefined,
        });
      }
      for (const p of t.parts) {
        const pos = { row: p.row1 + ar, col: p.col1 + ac };
        const end = p.row2 !== undefined ? { row: p.row2 + ar, col: p.col2! + ac } : undefined;
        moved.set(p.comp.id, { ...p.comp, boardPos: pos, rotation: 0, flexibleEndPos: end });
      }
    }
    if (fp2) {
      for (const { tile, y, x } of fp2.placed) {
        for (const rp of tile.rigidParts) {
          moved.set(rp.comp.id, {
            ...rp.comp,
            boardPos: { row: rp.row + y, col: rp.col + x },
            rotation: rp.rotation,
            flexibleEndPos: undefined,
          });
        }
        for (const p of tile.parts) {
          const pos = { row: p.row1 + y, col: p.col1 + x };
          const end = p.row2 !== undefined ? { row: p.row2 + y, col: p.col2! + x } : undefined;
          moved.set(p.comp.id, { ...p.comp, boardPos: pos, rotation: 0, flexibleEndPos: end });
        }
      }
    } else if (floorplan) {
      const bandY: number[] = [];
      let yCur = oy0;
      floorplan.bandHeights.forEach((h) => {
        bandY.push(yCur);
        yCur += h + 1;
      });
      for (const { tile, band, x, dy } of floorplan.placedTiles) {
        const oy = bandY[band] + dy;
        for (const rp of tile.rigidParts) {
          moved.set(rp.comp.id, {
            ...rp.comp,
            boardPos: { row: rp.row + oy, col: rp.col + x + ox },
            rotation: rp.rotation,
            flexibleEndPos: undefined,
          });
        }
        for (const p of tile.parts) {
          const pos = { row: p.row1 + oy, col: p.col1 + x + ox };
          const end = p.row2 !== undefined ? { row: p.row2 + oy, col: p.col2! + x + ox } : undefined;
          moved.set(p.comp.id, { ...p.comp, boardPos: pos, rotation: 0, flexibleEndPos: end });
        }
      }
    }
    // One empty column on each board edge: an edge pin column whose net
    // needs a link wire has no flank otherwise, and no cut position can
    // conjure one. Flank-aware compaction strips whichever margin no needy
    // run actually uses, so unneeded margins cost nothing. Skipped when
    // parts are locked (content must not shift relative to them).
    if (lockedParts.length === 0) {
      for (const [id, m] of moved) {
        moved.set(id, {
          ...m,
          boardPos: m.boardPos ? { row: m.boardPos.row, col: m.boardPos.col + 1 } : m.boardPos,
          ...(m.flexibleEndPos
            ? { flexibleEndPos: { row: m.flexibleEndPos.row, col: m.flexibleEndPos.col + 1 } }
            : {}),
        });
      }
      cols += 2;
    }
    const virtual = components.map((c) => {
      const m = moved.get(c.id);
      if (m) return m;
      if (unplaced.some((u) => u.id === c.id)) return { ...c, boardPos: null, flexibleEndPos: undefined };
      return c;
    });
    return { virtual, rows, cols, movedIds: new Set(moved.keys()) };
  };

  // ── Finish: derive cuts and the remaining wires ──────
  // Try the densest layout first. If routing starves (no free hole for a
  // link wire), find the largest prefix of the removal sequence that still
  // routes cleanly; a wider-gap floorplan is the last resort.
  interface Candidate {
    virtual: Component[];
    rows: number;
    cols: number;
    movedIds: Set<string>;
    plan: CompletionPlan;
    bad: number;
  }
  let chosen: Candidate | null = null;
  // Among clean candidates, a cell of board, a hole of wire, and a hole of
  // wire mess (length over parts / off axis) weigh the same — density must
  // not buy ugly OR long wires. Humans spend board area freely to keep link
  // wires short; without the length term the densest candidate always won
  // and tidier floorplans were discarded.
  // Locked dimensions are paid in full either way.
  // Ribbon boards read badly even at equal area: beyond maxDim = 2·minDim,
  // each extra length unit is priced like a row of cells. A user-locked
  // dimension is the user's own shape choice and exempts the board.
  const aspectOver = (rows: number, cols: number): number => {
    if (limits.maxRows !== undefined || limits.maxCols !== undefined) return 0;
    const mx = Math.max(rows, cols);
    const mn = Math.min(rows, cols);
    return Math.max(0, mx - 2 * mn) * mn;
  };
  const wireLenOf = (p: CompletionPlan): number =>
    p.wires.reduce((s, w) => s + Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col), 0);
  // A non-vertical wire is worth a whole board line: that is the exchange
  // rate users reveal when they hand-fix layouts (one inserted blank column
  // to straighten a single wire), and it is what lets a channel insertion
  // or repair move pay for itself in this cost.
  const slantsOf = (p: CompletionPlan): number =>
    p.wires.reduce((n, w) => n + (w.from.col !== w.to.col ? 1 : 0), 0);
  const cost = (c: Candidate) =>
    (limits.maxRows ? Math.max(limits.maxRows, c.rows) : c.rows) *
    (limits.maxCols ? Math.max(limits.maxCols, c.cols) : c.cols) +
    c.plan.wireMess + wireLenOf(c.plan) + aspectOver(c.rows, c.cols) +
    Math.max(c.rows, c.cols) * slantsOf(c.plan);
  const route = (virtual: Component[], rows: number, cols: number, movedIds: Set<string>, repair = false): Candidate => {
    const tryBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
    const plan = deriveCompletion(tryBoard, virtual, componentDefs, nets, netAssignments, {
      allowSharedJoints: lockedParts.length > 0,
      ...(repair ? { repairSlants: true } : {}),
    });
    const overCap =
      (limits.maxRows ? Math.max(0, rows - limits.maxRows) : 0) +
      (limits.maxCols ? Math.max(0, cols - limits.maxCols) : 0);
    const bad = plan.unresolvedConflicts * 100 + 40 * overCap + plan.starvedNetIds.length;
    const cand: Candidate = { virtual, rows, cols, movedIds, plan, bad };
    if (!chosen || bad < chosen.bad || (bad === chosen.bad && cost(cand) < cost(chosen))) {
      chosen = cand;
    }
    return cand;
  };
  // Slide only the FREE content sideways by dc columns, locked parts staying
  // put. A uniform shift leaves free-vs-free geometry unchanged, so only the
  // new relations against locked parts need checking here; whether the result
  // routes better is judged by route() as usual. Returns null when a shifted
  // part would leave the board or violate geometry against a locked part.
  const shiftFreeSideways = (
    virtual: Component[],
    dc: number,
    cols: number
  ): Component[] | null => {
    interface Geo {
      rects: FootprintRect[];
      segs: { p1: BoardPosition; p2: BoardPosition; clr: number }[];
      pins: BoardPosition[];
    }
    const geoOf = (comps: Component[]): Geo => {
      const g: Geo = { rects: [], segs: [], pins: [] };
      for (const c of comps) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const p2 = c.flexibleEndPos ?? c.boardPos;
          g.segs.push({ p1: c.boardPos, p2, clr: clearanceOf(def) });
          g.pins.push(c.boardPos, p2);
        } else {
          g.rects.push(getComponentBounds(def, c.boardPos, c.rotation));
          for (const p of getRotatedPinPositions(def, c.boardPos, c.rotation)) {
            g.pins.push({ row: p.row, col: p.col });
          }
        }
      }
      return g;
    };
    const shifted: Component[] = [];
    const free: Component[] = [];
    for (const c of virtual) {
      if (!c.boardPos || lockedIds.has(c.id)) {
        shifted.push(c);
        continue;
      }
      const s: Component = {
        ...c,
        boardPos: { row: c.boardPos.row, col: c.boardPos.col + dc },
        ...(c.flexibleEndPos
          ? { flexibleEndPos: { row: c.flexibleEndPos.row, col: c.flexibleEndPos.col + dc } }
          : {}),
      };
      shifted.push(s);
      free.push(s);
    }
    const freeGeo = geoOf(free);
    const lockGeo = geoOf(lockedParts);
    for (const r of freeGeo.rects) if (r.minCol < 0 || r.maxCol >= cols) return null;
    for (const p of freeGeo.pins) if (p.col < 0 || p.col >= cols) return null;
    const overlap = (a: FootprintRect, b: FootprintRect) =>
      a.minRow <= b.maxRow && b.minRow <= a.maxRow && a.minCol <= b.maxCol && b.minCol <= a.maxCol;
    const inRect = (p: BoardPosition, r: FootprintRect) =>
      p.row >= r.minRow && p.row <= r.maxRow && p.col >= r.minCol && p.col <= r.maxCol;
    for (const fr of freeGeo.rects) {
      if (lockGeo.rects.some((lr) => overlap(fr, lr))) return null;
      if (lockGeo.segs.some((ls) => bodyIntersectsRect(ls.p1, ls.p2, fr, ls.clr))) return null;
      if (lockGeo.pins.some((p) => inRect(p, fr))) return null;
    }
    for (const fs of freeGeo.segs) {
      if (lockGeo.rects.some((lr) => bodyIntersectsRect(fs.p1, fs.p2, lr, fs.clr))) return null;
      if (
        lockGeo.segs.some(
          (ls) =>
            segmentsIntersect(fs.p1, fs.p2, ls.p1, ls.p2) ||
            bodiesTooClose(fs.p1, fs.p2, ls.p1, ls.p2, fs.clr + ls.clr)
        )
      )
        return null;
    }
    const lockedHoles = new Set(lockGeo.pins.map((p) => `${p.row},${p.col}`));
    for (const s of lockGeo.segs)
      for (const h of corridorHoles(s.p1, s.p2)) lockedHoles.add(`${h.row},${h.col}`);
    for (const p of freeGeo.pins) if (lockedHoles.has(`${p.row},${p.col}`)) return null;
    const freeCorridor = new Set<string>();
    for (const s of freeGeo.segs)
      for (const h of corridorHoles(s.p1, s.p2)) freeCorridor.add(`${h.row},${h.col}`);
    for (const p of lockGeo.pins) if (freeCorridor.has(`${p.row},${p.col}`)) return null;
    return shifted;
  };

  // gap 2 leaves one empty column between tiles so edge parts keep body
  // clearance; compaction closes the seam wherever that stays legal.
  // Clearances above the default widen the seams: two padded parts may face
  // each other across a tile boundary the planner never checks pairwise
  // (gap 2 covers exactly two default halos).
  const maxClr = Math.max(
    0,
    ...components
      .filter((c) => !c.boardExcluded)
      .map((c) => {
        const def = resolveComponentDef(c, componentDefs);
        return def ? clearanceOf(def) : 0;
      })
  );
  const seamExtra = Math.max(0, Math.ceil(1 + 2 * maxClr - 1e-6) - 2);
  const runLadder = () => {
    // Both stage-2 strategies always contribute candidates and route()
    // keeps the better routed result: the 2D floorplan usually wins, but
    // bands guard against regressions on shapes it composes better.
    for (const use2D of [true, false]) {
    outer: for (const gap of [2 + seamExtra, 3 + seamExtra]) {
      const m = materialize(gap, use2D);
      report("place", (use2D ? 0.2 : 0.5) + (gap === 2 ? 0.05 : 0.15));
      if (m.rows * m.cols <= 300) {
        // small board: routing is cheap enough to verify every removal, so
        // compaction stops exactly where wires would starve or get messy
        const loose = route(m.virtual, m.rows, m.cols, m.movedIds);
        if (loose.bad === 0) {
          const messCap = loose.plan.wireMess + 2;
          const validate = (comps: Component[], rows: number, cols: number) => {
            const p = deriveCompletion({ ...board, rows, cols, cuts: [], wires: [] }, comps, componentDefs, nets, netAssignments, {
              allowSharedJoints: lockedParts.length > 0,
            });
            return p.unresolvedConflicts === 0 && p.starvedNetIds.length === 0 && p.wireMess <= messCap;
          };
          const full = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols, Infinity, validate);
          route(full.comps, full.rows, full.cols, m.movedIds);
          // a result that needed pin-joint sharing is legal but last-resort:
          // keep exploring the remaining ladder rungs for a joint-free one
          if (chosen!.plan.sharedJoints === 0) break outer;
          continue;
        }
        // loose is unusable (often a locked dimension): the generic path below
        // gets a chance, since full compaction may pull the board under its cap
      }
      const full = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols);
      const compacted = route(full.comps, full.rows, full.cols, m.movedIds);
      if (compacted.bad === 0 && compacted.plan.sharedJoints === 0) break;
      const loose = route(m.virtual, m.rows, m.cols, m.movedIds);
      if (loose.bad === 0) {
        let lo = 0;
        let hi = full.removals;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const part = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols, mid);
          if (route(part.comps, part.rows, part.cols, m.movedIds).bad === 0) lo = mid;
          else hi = mid;
        }
        if (chosen!.plan.sharedJoints === 0) break outer;
      }
    }
    }
    // An empty column at a board edge is a wire channel: every outermost
    // strip segment gains a crossing-free vertical path — and on a tightly
    // capped board it is often the only place link wires can still attach.
    // Keep one (or both) when what it fixes or saves outweighs its cost.
    if (chosen!.bad < 100) {
      const c0: Candidate = chosen!;
      route(c0.virtual, c0.rows, c0.cols + 1, c0.movedIds);
      if (lockedParts.length === 0) {
        // shifting the content right is only possible when nothing is locked
        const shifted = c0.virtual.map((c) => {
          if (!c.boardPos) return c;
          return {
            ...c,
            boardPos: { row: c.boardPos.row, col: c.boardPos.col + 1 },
            ...(c.flexibleEndPos
              ? { flexibleEndPos: { row: c.flexibleEndPos.row, col: c.flexibleEndPos.col + 1 } }
              : {}),
          };
        });
        route(shifted, c0.rows, c0.cols + 1, c0.movedIds); // left channel only
        route(shifted, c0.rows, c0.cols + 2, c0.movedIds); // both edges
      } else if (chosen!.bad > 0) {
        // With locked parts that shift would move them off their positions.
        // But a starved segment flush against a board edge (e.g. a horizontal
        // part's cut-off pin at col 0, unwireable: pin + body corridor fill
        // the segment) can still be rescued by sliding only the free content
        // sideways within the same board.
        for (const dc of [1, -1, 2, -2]) {
          if (chosen!.bad === 0) break;
          const slid = shiftFreeSideways(c0.virtual, dc, c0.cols);
          if (slid) route(slid, c0.rows, c0.cols, c0.movedIds);
        }
      }
    }
  };
  runLadder();
  // Designing blocks around the locked parts is a bet; when it routes badly
  // (adversarial lock positions), fall back to the conservative model:
  // every locked part a plain obstacle, everything else arranged freely.
  if (chosen!.bad >= 3 && tiles.some((t) => t.anchor)) {
    for (const t of [...tiles].filter((x) => x.anchor)) demoteTile(t);
    computeFixed();
    chosen = null;
    runLadder();
  }
  // ── V1 polish: re-anneal each tile in place ──────────
  // A tile is a small local problem — the regime where the v1 optimizer
  // produces human-density results (its weakness, global structure, is
  // already fixed here; humans buy density with cuts, and v1 prices cuts
  // cheap). Each tile's members are re-optimized with the rest of the
  // board frozen; route() adopts a result only when it beats the current
  // candidate on (bad, cost), so a polish that gets messy is discarded.
  report("place", 0.8);
  {
    const polishAttempts = [{ spacing: 1, bboxWeight: 1 }];
    for (const t of tiles) {
      const memberIds = [
        ...t.rigidParts.map((rp) => rp.comp.id),
        ...t.parts.map((p) => p.comp.id),
      ].filter((id) => !lockedIds.has(id));
      if (memberIds.length < 2) continue;
      const cur: Candidate = chosen!;
      const vBoard: Board = { ...board, rows: cur.rows, cols: cur.cols, cuts: [], wires: [] };
      const r1 = computeAutoLayout(vBoard, cur.virtual, componentDefs, nets, netAssignments, undefined, {
        attempts: polishAttempts,
        onlyIds: memberIds,
      });
      const byId = new Map(r1.placements.map((p) => [p.componentId, p]));
      const cand = cur.virtual.map((c) => {
        const p = byId.get(c.id);
        if (!p) return c;
        return {
          ...c,
          boardPos: p.boardPos,
          ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
          flexibleEndPos: p.flexibleEndPos,
        };
      });
      route(cand, cur.rows, cur.cols, new Set([...cur.movedIds, ...memberIds]));
    }
    // harvest what the polish freed: tighter tiles leave empty lines behind
    const cur: Candidate = chosen!;
    if (options?.harvest !== false && cur.bad === 0) {
      const full = compactPlacements(cur.virtual, componentDefs, netOfPin, cur.rows, cur.cols);
      if (full.removals > 0) route(full.comps, full.rows, full.cols, cur.movedIds);
    }
  }
  // ── Wire channels: buy straightness with a blank line ──
  // When the plan still has slanted wires or wires running over parts,
  // offer boards with one inserted blank line. A blank column is a
  // vertical wire channel: every strip crossing it gains a free,
  // crossing-free hole, so any two of those strips connect vertically
  // there. A blank row is a relay strip: horizontal travel on copper with
  // two vertical hops. route() adopts an insertion only when it beats the
  // current candidate on (bad, cost) — the line's area must pay for the
  // mess it removes. Runs last so no later compaction can harvest the
  // channel away; skipped with locked parts (content must not shift).
  if (lockedParts.length === 0 && chosen!.bad === 0) {
    const lineStraddled = (comps: Component[], isCol: boolean, at: number): boolean =>
      comps.some((c) => {
        if (!c.boardPos || c.boardExcluded) return false;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) return false;
        if (def.flexible) {
          // A straddled flexible part stretches by one hole (insertLine
          // shifts its far endpoint); it only blocks the line when its
          // span cannot legally absorb the growth. Dense boards tile
          // every line position with resistor spans otherwise.
          const p2 = c.flexibleEndPos ?? c.boardPos!;
          const lo = isCol ? Math.min(c.boardPos!.col, p2.col) : Math.min(c.boardPos!.row, p2.row);
          const hi = isCol ? Math.max(c.boardPos!.col, p2.col) : Math.max(c.boardPos!.row, p2.row);
          if (!(lo < at && at <= hi)) return false;
          const dr = Math.abs(c.boardPos!.row - p2.row) + (isCol ? 0 : 1);
          const dc = Math.abs(c.boardPos!.col - p2.col) + (isCol ? 1 : 0);
          return Math.hypot(dr, dc) > spanLimits(def).max + 1e-6;
        }
        const r = getComponentBounds(def, c.boardPos, c.rotation);
        return isCol ? r.minCol < at && at <= r.maxCol : r.minRow < at && at <= r.maxRow;
      });
    const insertLine = (comps: Component[], isCol: boolean, at: number): Component[] =>
      comps.map((c) => {
        if (!c.boardPos) return c;
        const shift = (p: BoardPosition): BoardPosition =>
          isCol
            ? p.col >= at ? { row: p.row, col: p.col + 1 } : p
            : p.row >= at ? { row: p.row + 1, col: p.col } : p;
        return {
          ...c,
          boardPos: shift(c.boardPos),
          ...(c.flexibleEndPos ? { flexibleEndPos: shift(c.flexibleEndPos) } : {}),
        };
      });
    for (let round = 0; round < (icChannels ? 12 : 3); round++) {
      const cur: Candidate = chosen!;
      const obstacles: WireObstacles = { rects: [], bodies: [] };
      const icRects: FootprintRect[] = [];
      for (const c of cur.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) obstacles.bodies.push({ p1: c.boardPos, p2: c.flexibleEndPos ?? c.boardPos });
        else {
          const r = getComponentBounds(def, c.boardPos, c.rotation);
          obstacles.rects.push(r);
          if (icChannels && def.pins.length >= IC_MIN_PINS) icRects.push(r);
        }
      }
      const offenders = cur.plan.wires.filter(
        (w) => w.from.col !== w.to.col || wireExtraLength(w.from, w.to, obstacles) > 0
      );
      if (offenders.length === 0) break;
      const colCands = new Set<number>();
      const rowCands = new Set<number>();
      // IC-channel treatment: a line at an IC's footprint edge widens the
      // routing gap beside its pin field (a column doubles as a crossing-
      // free channel, a row as a relay strip). Only ICs a messy wire
      // actually touches, so candidate volume tracks the mess, not the size.
      for (const r of icRects) {
        const near = offenders.some(
          (w) =>
            Math.min(w.from.col, w.to.col) <= r.maxCol + 1 &&
            Math.max(w.from.col, w.to.col) >= r.minCol - 1 &&
            Math.min(w.from.row, w.to.row) <= r.maxRow + 1 &&
            Math.max(w.from.row, w.to.row) >= r.minRow - 1
        );
        if (!near) continue;
        colCands.add(r.minCol);
        colCands.add(r.maxCol + 1);
        rowCands.add(r.minRow);
        rowCands.add(r.maxRow + 1);
      }
      for (const w of offenders) {
        const loC = Math.min(w.from.col, w.to.col);
        const hiC = Math.max(w.from.col, w.to.col);
        if (loC !== hiC) {
          // a channel column anywhere between the endpoints gives both
          // strips a shared free column; a relay row between them lets two
          // vertical hops replace the slant
          colCands.add(loC + 1);
          colCands.add(hiC);
          colCands.add((loC + hiC + 1) >> 1);
          const loR = Math.min(w.from.row, w.to.row);
          const hiR = Math.max(w.from.row, w.to.row);
          if (hiR > loR) {
            rowCands.add((loR + hiR + 1) >> 1);
          } else {
            // A pure-horizontal run spans no rows, so the midpoint rule
            // above never offers the one insertion that fixes it: a relay
            // row directly beside it.
            rowCands.add(loR);
            rowCands.add(loR + 1);
          }
        } else {
          // vertical wire over parts: a channel right beside it clears the
          // path, and a relay row at any gap inside its span lets two hops
          // detour around the crossed body (bus row over cross-part wire)
          colCands.add(loC);
          colCands.add(loC + 1);
          const loR = Math.min(w.from.row, w.to.row);
          const hiR = Math.max(w.from.row, w.to.row);
          for (let r = loR + 1; r <= hiR; r++) rowCands.add(r);
        }
      }
      if (limits.maxCols !== undefined && cur.cols + 1 > limits.maxCols) colCands.clear();
      if (limits.maxRows !== undefined && cur.rows + 1 > limits.maxRows) rowCands.clear();
      for (const at of colCands) {
        if (at < 1 || at > cur.cols - 1) continue; // edge channels are tried above
        if (lineStraddled(cur.virtual, true, at)) continue;
        route(insertLine(cur.virtual, true, at), cur.rows, cur.cols + 1, cur.movedIds);
      }
      for (const at of rowCands) {
        if (at < 1 || at > cur.rows - 1) continue;
        if (lineStraddled(cur.virtual, false, at)) continue;
        route(insertLine(cur.virtual, false, at), cur.rows + 1, cur.cols, cur.movedIds);
      }
      if (chosen === cur) break; // no insertion paid for itself
    }
    // ── Bus lanes: compound insertion for stacked horizontal runs ──
    // Several wide horizontal runs may each fail to pay for a private
    // relay row while jointly they would (each freed run funds the next
    // lane). One attempt inserts a lane beside every remaining wide run
    // at once; route() adopts only if the whole bundle pays.
    if (icChannels && chosen!.bad === 0) {
      const cur: Candidate = chosen!;
      const laneRows = [
        ...new Set(
          cur.plan.wires
            .filter((w) => w.from.row === w.to.row && Math.abs(w.from.col - w.to.col) > 3)
            .map((w) => w.from.row + 1)
        ),
      ].sort((a, b) => b - a);
      if (laneRows.length >= 2 &&
          !(limits.maxRows !== undefined && cur.rows + laneRows.length > limits.maxRows)) {
        // Descending order: an insertion never shifts the targets below it
        let comps = cur.virtual;
        let rows = cur.rows;
        for (const at of laneRows) {
          if (at < 1 || at > rows - 1 || lineStraddled(comps, false, at)) continue;
          comps = insertLine(comps, false, at);
          rows++;
        }
        if (rows > cur.rows) route(comps, rows, cur.cols, cur.movedIds);
      }
    }
  }
  // ── Slant repairs on the final candidate ──
  // First the free move: let deriveCompletion slide its own cuts to open
  // shared columns (repairSlants). Then tap slides: a one-hole part can
  // move along its row for free — cuts and wires are re-derived from the
  // pin positions, so any spot that routes is legal — and route() only
  // adopts a move that routes strictly better.
  if (chosen!.bad === 0) {
    route(chosen!.virtual, chosen!.rows, chosen!.cols, chosen!.movedIds, true);
    const afterEntryRepair: Candidate = chosen!;
    const hk = (r: number, c: number) => `${r}:${c}`;
    for (let round = 0; round < 3; round++) {
      const cur: Candidate = chosen!;
      // route() swaps `chosen` on adoption; an opaque check keeps TS from
      // narrowing the comparison away
      const stillCur = () => (chosen as Candidate) === cur;
      const offenders = cur.plan.wires.filter((w) => w.from.col !== w.to.col);
      if (offenders.length === 0) break;
      const segBoard: Board = { ...board, rows: cur.rows, cols: cur.cols, cuts: cur.plan.cuts, wires: [] };
      const segments = computeStripSegments(segBoard, cur.virtual, componentDefs, netAssignments);
      const segAt = (r: number, c: number) =>
        segments.find((s) => s.row === r && c >= s.startCol && c <= s.endCol);
      // Physical blockers only (pins, bodies, corridors): everything else
      // — cuts, wire endpoints — is re-derived per candidate anyway
      const phys = new Set<string>();
      const tapAt = new Map<string, Component>();
      for (const c of cur.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const p2 = c.flexibleEndPos ?? c.boardPos;
          for (const h of corridorHoles(c.boardPos, p2)) phys.add(hk(h.row, h.col));
          phys.add(hk(c.boardPos.row, c.boardPos.col));
          phys.add(hk(p2.row, p2.col));
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          for (let r = b.minRow; r <= b.maxRow; r++) {
            for (let cc = b.minCol; cc <= b.maxCol; cc++) phys.add(hk(r, cc));
          }
          if (def.pins.length === 1 && def.width === 1 && def.height === 1 && !lockedIds.has(c.id)) {
            tapAt.set(hk(c.boardPos.row, c.boardPos.col), c);
          }
        }
      }
      let attempts = 0;
      for (const w of offenders) {
        if (!stillCur() || attempts >= 8) break;
        const sA = segAt(w.from.row, w.from.col);
        const sB = segAt(w.to.row, w.to.col);
        if (!sA || !sB) continue;
        const lo = Math.max(sA.startCol, sB.startCol);
        const hi = Math.min(sA.endCol, sB.endCol);
        if (hi < lo) {
          // Disjoint spans: pins between the spans keep the copper from
          // reaching a shared column. Clear the approach: pick a target
          // column free on the far row, move every tap between it and this
          // segment out of the way, and let the re-derived cuts plus the
          // cut-slide repair extend the copper to it.
          for (const [seg, other] of [
            [sA, sB],
            [sB, sA],
          ] as const) {
            if (!stillCur() || attempts >= 8) break;
            const left = other.endCol < seg.startCol;
            const cands: number[] = [];
            for (let c2 = other.startCol; c2 <= other.endCol; c2++) {
              if (!phys.has(hk(other.row, c2))) cands.push(c2);
            }
            if (left) cands.reverse(); // nearest to this segment first
            for (const c2 of cands.slice(0, 3)) {
              if (!stillCur() || attempts >= 8) break;
              const zone: [number, number] = left ? [c2, seg.startCol - 1] : [seg.endCol + 1, c2];
              const movers: Component[] = [];
              let clear = true;
              for (let z = zone[0]; z <= zone[1]; z++) {
                const k = hk(seg.row, z);
                const tap = tapAt.get(k);
                if (tap) movers.push(tap);
                else if (phys.has(k)) {
                  clear = false;
                  break;
                }
              }
              if (!clear || movers.length === 0) continue;
              // park the movers beyond the target, away from this segment
              const spots: number[] = [];
              if (left) {
                for (let z = c2 - 1; z >= 0 && spots.length < movers.length; z--) {
                  if (!phys.has(hk(seg.row, z))) spots.push(z);
                }
              } else {
                for (let z = c2 + 1; z < cur.cols && spots.length < movers.length; z++) {
                  if (!phys.has(hk(seg.row, z))) spots.push(z);
                }
              }
              if (spots.length < movers.length) continue;
              attempts++;
              const byTap = new Map(movers.map((tap, i) => [tap.id, spots[i]]));
              const moved = cur.virtual.map((c) =>
                byTap.has(c.id) ? { ...c, boardPos: { row: seg.row, col: byTap.get(c.id)! } } : c
              );
              route(moved, cur.rows, cur.cols, cur.movedIds, true);
            }
          }
          continue;
        }
        for (let col = lo; col <= hi && stillCur(); col++) {
          for (const [seg, other] of [
            [sA, sB],
            [sB, sA],
          ] as const) {
            const tap = tapAt.get(hk(seg.row, col));
            if (!tap) continue;
            if (phys.has(hk(other.row, col))) continue;
            // any free hole on the tap's row works; ones outside the shared
            // window first, since they cannot re-block it
            const targets: number[] = [];
            for (let t = 0; t < cur.cols; t++) {
              if (t === col || phys.has(hk(seg.row, t))) continue;
              targets.push(t);
            }
            targets.sort(
              (a, b) =>
                Number(a >= lo && a <= hi) - Number(b >= lo && b <= hi) ||
                Math.abs(a - col) - Math.abs(b - col)
            );
            for (const t of targets) {
              if (attempts >= 8) break;
              attempts++;
              // no repair here: freeing the column enables a direct
              // vertical on its own, and nesting the cut-slide search into
              // every candidate would multiply full re-routes
              const moved = cur.virtual.map((c) =>
                c.id === tap.id ? { ...c, boardPos: { row: seg.row, col: t } } : c
              );
              route(moved, cur.rows, cur.cols, cur.movedIds);
              if (!stillCur()) break;
            }
          }
        }
      }
      if (stillCur()) break; // nothing adopted this round
    }
    // tap slides route without the cut-slide search; one repair pass on
    // whatever they produced picks up the compound cases
    if (chosen !== afterEntryRepair) {
      route(chosen!.virtual, chosen!.rows, chosen!.cols, chosen!.movedIds, true);
    }
  }
  report("place", 0.9);
  const { virtual, movedIds, plan } = chosen!;
  // A locked dimension stays exactly at the user's value: the physical
  // board doesn't shrink, and overflowing it is reported, not hidden.
  if (board.lockedRows && chosen!.rows > board.rows) {
    issues.push(`does not fit the locked ${board.rows} rows (needs ${chosen!.rows})`);
  }
  if (board.lockedCols && chosen!.cols > board.cols) {
    issues.push(`does not fit the locked ${board.cols} columns (needs ${chosen!.cols})`);
  }
  const rows = board.lockedRows ? Math.max(board.rows, chosen!.rows) : chosen!.rows;
  const cols = board.lockedCols ? Math.max(board.cols, chosen!.cols) : chosen!.cols;

  const placements: LayoutPlacement[] = [];
  for (const c of virtual) {
    if (!movedIds.has(c.id) || !c.boardPos) continue;
    const def = resolveComponentDef(c, componentDefs);
    placements.push(
      def?.flexible
        ? { componentId: c.id, boardPos: c.boardPos, flexibleEndPos: c.flexibleEndPos }
        : { componentId: c.id, boardPos: c.boardPos, rotation: c.rotation }
    );
  }
  const sizedBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
  issues.push(...plan.issues);
  if (plan.unresolvedConflicts > 0) {
    issues.push(`${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved`);
  }
  const stillUnplaced = virtual.filter((c) => !c.boardPos && !c.boardExcluded);
  if (stillUnplaced.length > 0) {
    issues.push(`${stillUnplaced.length} component${stillUnplaced.length > 1 ? "s" : ""} could not be placed`);
  }

  // ── Quality (same scale as v1, for messages and tooling) ──
  const finalBoard: Board = {
    ...sizedBoard,
    cuts: plan.cuts,
    wires: plan.wires.map((w, i) => ({ id: `v2-${i}`, from: w.from, to: w.to })),
  };
  const segments = computeStripSegments(finalBoard, virtual, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, finalBoard.wires);
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(nets, netAssignments, segments, connectivity, virtual, componentDefs);
  const quality = conflicts * 100 + incomplete.length + stillUnplaced.length * 2;
  report("place", 1);

  return {
    placements,
    cuts: plan.cuts,
    wires: plan.wires,
    issues,
    quality,
    starvedNetIds: plan.starvedNetIds,
    boardSize: { rows, cols },
    unplaceIds: stillUnplaced.map((c) => c.id),
  };
}
