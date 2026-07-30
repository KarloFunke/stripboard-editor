import { Tile, DimLimits } from "./tilePlanning";
import { sharedNetCount } from "./composeTiles";
import { FootprintRect } from "../flexGeometry";

// ── Stage 2 alternative: 2D floorplan with pre-placed modules ──
//
// Bands compose the free tiles on their own and dodge the anchored content
// as one monolithic exclusion zone. This floorplanner instead places every
// free tile individually in the same absolute frame as the anchored tiles
// and locked obstacles: tiles can pack around locks, nest beside them, and
// land on y offsets where their net rows line up with fixed pins — a copper
// join instead of a link wire whose endpoint may starve. Deterministic:
// hub-first constructive placement, then rip-up-and-re-place refinement.

export interface Fixed2D {
  // Part-level blockers (anchored tiles' contents, locked parts): free
  // tiles keep one hole of clearance but may nest into gaps between them.
  rects: FootprintRect[];
  // Copper interrupters (anchored tile bboxes, locked parts): a same-net
  // row join is only free when no span sits between the two intervals.
  spans: FootprintRect[];
  // Net rows of the fixed content, absolute coordinates.
  netRows: { net: string; row: number; xLo: number; xHi: number }[];
}

export interface Placed2D {
  tile: Tile; // the placed variant (may be the tile's 180° flip)
  y: number;
  x: number;
}

export interface Floorplan2D {
  placed: Placed2D[];
  rows: number;
  cols: number;
  wiresEst: number;
  wireLen: number;
}

interface NetNode {
  net: string;
  row: number;
  xLo: number;
  xHi: number;
}

// Corpus-tuned against human layouts (matches composeTiles): an inter-tile
// wire ≈ 8 cells of board, a hole of estimated wire length ≈ 3 cells.
// Only on free boards — under a user-locked dimension the conservative
// density-first weights stay, or greedy construction drifts wide from the
// first placement and never finds a plan inside the cap.
const W_WIRE = 8;
const W_LEN = 3;
const W_WIRE_CAPPED = 4;
const W_LEN_CAPPED = 1;
// Beyond maxDim = 2·minDim a board reads as a ribbon; each extra length
// unit pays about a row of cells so squarer floorplans win at equal area.
const ASPECT_SLACK = 2;

export function floorplan2D(
  tiles: Tile[],
  fixed: Fixed2D,
  gap: number,
  limits: DimLimits
): Floorplan2D | null {
  if (tiles.length === 0) return null;
  const capped = limits.maxRows !== undefined || limits.maxCols !== undefined;
  const wWire = capped ? W_WIRE_CAPPED : W_WIRE;
  const wLen = capped ? W_LEN_CAPPED : W_LEN;
  // Anchored content pins the coordinate frame to the board origin; with
  // nothing fixed the frame floats and is normalized at the end.
  const hasFixed = fixed.rects.length > 0;
  const placed: Placed2D[] = [];

  const bboxOf = (p: Placed2D): FootprintRect => ({
    minRow: p.y,
    minCol: p.x,
    maxRow: p.y + p.tile.height - 1,
    maxCol: p.x + p.tile.width - 1,
  });

  const overlapsExp = (a: FootprintRect, b: FootprintRect, dr: number, dc: number) =>
    a.minRow - dr <= b.maxRow && a.maxRow + dr >= b.minRow &&
    a.minCol - dc <= b.maxCol && a.maxCol + dc >= b.minCol;

  // Clearance around fixed parts follows the ladder's gap: the tight rung
  // packs flush for density, the wide rung leaves an extra column so a
  // locked part's cut-bounded pin segments keep holes for link wires —
  // starved boards reach the wide rung automatically.
  const fixedDc = Math.max(1, gap - 1);
  const isValid = (r: FootprintRect): boolean => {
    // With locked content the frame is pinned and materialize cannot shift
    // everything off the left edge afterwards — so free tiles keep column 0
    // clear themselves, or an edge pin's segment ends up with no free hole.
    if (hasFixed && (r.minRow < 0 || r.minCol < 1)) return false;
    for (const f of fixed.rects) {
      if (overlapsExp(r, f, 1, fixedDc)) return false;
    }
    for (const p of placed) {
      if (overlapsExp(r, bboxOf(p), 1, Math.max(1, gap - 1))) return false;
    }
    return true;
  };

  const currentNodes = (): NetNode[] => {
    const nodes: NetNode[] = [...fixed.netRows];
    for (const p of placed) {
      for (const [net, rows] of p.tile.rowsOfNet) {
        for (const r of rows) {
          nodes.push({ net, row: p.y + r, xLo: p.x, xHi: p.x + p.tile.width - 1 });
        }
      }
    }
    return nodes;
  };

  interface Score {
    score: number;
    rows: number;
    cols: number;
    wiresEst: number;
    wireLen: number;
    minR: number;
    minC: number;
  }
  const evalState = (): Score => {
    let minR = hasFixed ? 0 : Infinity;
    let minC = hasFixed ? 0 : Infinity;
    let maxR = -Infinity;
    let maxC = -Infinity;
    const ext = (r: FootprintRect) => {
      if (r.minRow < minR) minR = r.minRow;
      if (r.minCol < minC) minC = r.minCol;
      if (r.maxRow > maxR) maxR = r.maxRow;
      if (r.maxCol > maxC) maxC = r.maxCol;
    };
    for (const f of fixed.rects) ext(f);
    for (const p of placed) ext(bboxOf(p));
    const rows = maxR - minR + 1;
    const cols = maxC - minC + 1;

    const spans: FootprintRect[] = [...fixed.spans, ...placed.map(bboxOf)];
    const blocked = (row: number, lo: number, hi: number): boolean => {
      if (hi < lo) return false; // touching or overlapping intervals join freely
      return spans.some(
        (s) => s.minRow <= row && row <= s.maxRow && s.minCol <= hi && s.maxCol >= lo
      );
    };
    const byNet = new Map<string, NetNode[]>();
    for (const n of currentNodes()) {
      const arr = byNet.get(n.net);
      if (arr) arr.push(n);
      else byNet.set(n.net, [n]);
    }
    let wiresEst = 0;
    let wireLen = 0;
    for (const [, nodes] of byNet) {
      const parent = nodes.map((_, i) => i);
      const find = (i: number): number => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          if (a.row !== b.row) continue;
          const lo = Math.min(a.xHi, b.xHi) + 1;
          const hi = Math.max(a.xLo, b.xLo) - 1;
          if (!blocked(a.row, lo, hi)) parent[find(i)] = find(j);
        }
      }
      const roots = new Set<number>();
      for (let i = 0; i < nodes.length; i++) roots.add(find(i));
      wiresEst += roots.size - 1;
      // Wire length as the MST over the copper fragments, each edge the
      // closest node pair (row distance + x-interval gap). A net bounding
      // box would leave interior fragments gradient-free: moving a tile
      // strictly inside the box changes nothing, so refinement stalls on
      // exactly the many-fragment nets that need it most.
      if (capped) {
        // Locked dimension: the classic bounding-box estimate, whose
        // area-first gradient is what keeps greedy construction inside the
        // cap (the MST gradient drifts wide from the first placement).
        if (nodes.length > 1) {
          let rLo = Infinity, rHi = -Infinity, xLo = Infinity, xHi = -Infinity;
          for (const n of nodes) {
            const x = (n.xLo + n.xHi) / 2;
            rLo = Math.min(rLo, n.row);
            rHi = Math.max(rHi, n.row);
            xLo = Math.min(xLo, x);
            xHi = Math.max(xHi, x);
          }
          wireLen += rHi - rLo + xHi - xLo;
        }
      } else if (roots.size > 1) {
        const rootList = [...roots];
        const rootIdx = new Map<number, number>();
        rootList.forEach((r, i) => rootIdx.set(r, i));
        const k = rootList.length;
        const dist: number[][] = Array.from({ length: k }, () => new Array(k).fill(Infinity));
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const ri = rootIdx.get(find(i))!;
            const rj = rootIdx.get(find(j))!;
            if (ri === rj) continue;
            const a = nodes[i];
            const b = nodes[j];
            const d =
              Math.abs(a.row - b.row) +
              Math.max(0, Math.max(a.xLo, b.xLo) - Math.min(a.xHi, b.xHi));
            if (d < dist[ri][rj]) {
              dist[ri][rj] = d;
              dist[rj][ri] = d;
            }
          }
        }
        const inTree = new Array<boolean>(k).fill(false);
        const best = new Array<number>(k).fill(Infinity);
        inTree[0] = true;
        for (let i = 1; i < k; i++) best[i] = dist[0][i];
        for (let step = 1; step < k; step++) {
          let pick = -1;
          for (let i = 0; i < k; i++) {
            if (!inTree[i] && (pick < 0 || best[i] < best[pick])) pick = i;
          }
          wireLen += best[pick];
          inTree[pick] = true;
          for (let i = 0; i < k; i++) {
            if (!inTree[i] && dist[pick][i] < best[i]) best[i] = dist[pick][i];
          }
        }
      }
    }

    const effRows = limits.maxRows ? Math.max(limits.maxRows, rows) : rows;
    const effCols = limits.maxCols ? Math.max(limits.maxCols, cols) : cols;
    const overCap =
      (limits.maxRows ? Math.max(0, rows - limits.maxRows) : 0) +
      (limits.maxCols ? Math.max(0, cols - limits.maxCols) : 0);
    let aspPen = 0;
    if (limits.maxRows === undefined && limits.maxCols === undefined) {
      const mx = Math.max(rows, cols);
      const mn = Math.min(rows, cols);
      aspPen = Math.max(0, mx - ASPECT_SLACK * mn) * mn;
    }
    return {
      score: effRows * effCols + wWire * wiresEst + wLen * wireLen + 200 * overCap + aspPen,
      rows, cols, wiresEst, wireLen, minR, minC,
    };
  };

  const candidatesFor = (v: Tile): { y: number; x: number }[] => {
    const w = v.width;
    const h = v.height;
    const out = new Map<string, { y: number; x: number }>();
    const push = (y: number, x: number) => {
      if (Math.abs(y) > 500 || Math.abs(x) > 500) return;
      out.set(`${y}:${x}`, { y, x });
    };
    const bases: FootprintRect[] = [...fixed.rects, ...placed.map(bboxOf)];
    if (bases.length === 0) return [{ y: 0, x: 0 }];
    for (const R of bases) {
      const xr = R.maxCol + gap;
      const xl = R.minCol - gap - w + 1;
      for (const y of [R.minRow, R.maxRow - h + 1]) {
        push(y, xr);
        push(y, xl);
      }
      const yb = R.maxRow + 2;
      const yt = R.minRow - h - 1;
      for (const x of [R.minCol, R.maxCol - w + 1]) {
        push(yb, x);
        push(yt, x);
      }
    }
    // Alignment: land a net row of this tile exactly on an existing node's
    // row, directly beside it — the positions where copper joins happen.
    const nodes = currentNodes();
    for (const [net, rows] of v.rowsOfNet) {
      for (const n of nodes) {
        if (n.net !== net) continue;
        for (const r of rows) {
          const y = n.row - r;
          push(y, n.xHi + gap);
          push(y, n.xLo - gap - w + 1);
        }
      }
    }
    return [...out.values()];
  };

  const placeBest = (t: Tile): { p: Placed2D; score: number } | null => {
    let best: { p: Placed2D; score: number } | null = null;
    const variants = t.flipped ? [t, t.flipped] : [t];
    for (const v of variants) {
      for (const { y, x } of candidatesFor(v)) {
        const rect: FootprintRect = {
          minRow: y, minCol: x, maxRow: y + v.height - 1, maxCol: x + v.width - 1,
        };
        if (!isValid(rect)) continue;
        const p: Placed2D = { tile: v, y, x };
        placed.push(p);
        const s = evalState().score;
        placed.pop();
        if (!best || s < best.score - 1e-9) best = { p, score: s };
      }
    }
    if (!best) {
      // fallback: first valid spot scanning below everything
      const bottom = Math.max(-1, ...fixed.rects.map((r) => r.maxRow), ...placed.map((p) => bboxOf(p).maxRow));
      for (let x = 0; x <= 500; x++) {
        const rect: FootprintRect = {
          minRow: bottom + 2, minCol: x, maxRow: bottom + 1 + t.height, maxCol: x + t.width - 1,
        };
        if (isValid(rect)) {
          const p: Placed2D = { tile: t, y: bottom + 2, x };
          placed.push(p);
          const s = evalState().score;
          placed.pop();
          best = { p, score: s };
          break;
        }
      }
    }
    return best;
  };

  // ── Hub-first order: most-connected tile seeds, the rest attach where
  // they share the most nets with what already stands (fixed nets count).
  const fixedNets = new Set(fixed.netRows.map((n) => n.net));
  const conn = (t: Tile): number => {
    let n = 0;
    for (const net of t.rowsOfNet.keys()) if (fixedNets.has(net)) n++;
    return n;
  };
  const order: Tile[] = [];
  {
    const rest = [...tiles];
    let seed = rest[0];
    let sb = -1;
    for (const t of rest) {
      const s = rest.reduce((acc, o) => acc + (o === t ? 0 : sharedNetCount(t, o)), 0) + conn(t);
      if (s > sb || (s === sb && t.width * t.height > seed.width * seed.height)) {
        sb = s;
        seed = t;
      }
    }
    order.push(seed);
    rest.splice(rest.indexOf(seed), 1);
    while (rest.length > 0) {
      let pick = rest[0];
      let pw = -1;
      for (const t of rest) {
        const w = Math.max(conn(t), ...order.map((o) => sharedNetCount(o, t)));
        if (w > pw || (w === pw && t.width * t.height > pick.width * pick.height)) {
          pw = w;
          pick = t;
        }
      }
      order.push(pick);
      rest.splice(rest.indexOf(pick), 1);
    }
  }

  for (const t of order) {
    const best = placeBest(t);
    if (!best) return null; // nowhere on a sane board — bands can still try
    placed.push(best.p);
  }

  // ── Refinement: rip up one tile at a time, re-place it wherever the
  // whole floorplan scores best; stop when a sweep improves nothing.
  for (let sweep = 0; sweep < 2; sweep++) {
    let improved = false;
    for (const t of order) {
      const idx = placed.findIndex((p) => p.tile === t || p.tile === t.flipped);
      if (idx < 0) continue;
      const old = placed[idx];
      const before = evalState().score;
      placed.splice(idx, 1);
      const best = placeBest(t);
      if (best && best.score < before - 1e-9) {
        placed.push(best.p);
        improved = true;
      } else {
        placed.splice(idx, 0, old);
      }
    }
    if (!improved) break;
  }

  const st = evalState();
  const dy = hasFixed ? 0 : -st.minR;
  const dx = hasFixed ? 0 : -st.minC;
  return {
    placed: placed.map((p) => ({ tile: p.tile, y: p.y + dy, x: p.x + dx })),
    rows: st.rows,
    cols: st.cols,
    wiresEst: st.wiresEst,
    wireLen: st.wireLen,
  };
}
