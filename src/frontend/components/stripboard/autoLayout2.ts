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
  bodiesTooClose,
  segmentsIntersect,
  bodyIntersectsRect,
  corridorHoles,
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
  // Among clean candidates, a cell of board and a hole of wire mess (length
  // over parts / off axis) weigh the same — density must not buy ugly wires.
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
  const cost = (c: Candidate) =>
    (limits.maxRows ? Math.max(limits.maxRows, c.rows) : c.rows) *
    (limits.maxCols ? Math.max(limits.maxCols, c.cols) : c.cols) +
    c.plan.wireMess + aspectOver(c.rows, c.cols);
  const route = (virtual: Component[], rows: number, cols: number, movedIds: Set<string>): Candidate => {
    const tryBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
    const plan = deriveCompletion(tryBoard, virtual, componentDefs, nets, netAssignments, {
      allowSharedJoints: lockedParts.length > 0,
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
      segs: { p1: BoardPosition; p2: BoardPosition }[];
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
          g.segs.push({ p1: c.boardPos, p2 });
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
      if (lockGeo.segs.some((ls) => bodyIntersectsRect(ls.p1, ls.p2, fr))) return null;
      if (lockGeo.pins.some((p) => inRect(p, fr))) return null;
    }
    for (const fs of freeGeo.segs) {
      if (lockGeo.rects.some((lr) => bodyIntersectsRect(fs.p1, fs.p2, lr))) return null;
      if (
        lockGeo.segs.some(
          (ls) =>
            segmentsIntersect(fs.p1, fs.p2, ls.p1, ls.p2) ||
            bodiesTooClose(fs.p1, fs.p2, ls.p1, ls.p2)
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
  const runLadder = () => {
    // Both stage-2 strategies always contribute candidates and route()
    // keeps the better routed result: the 2D floorplan usually wins, but
    // bands guard against regressions on shapes it composes better.
    for (const use2D of [true, false]) {
    outer: for (const gap of [2, 3]) {
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
