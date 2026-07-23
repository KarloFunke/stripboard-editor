import { Tile, DimLimits } from "./tilePlanning";

// Exhaustive band search is 3^T..4^T; beyond this many tiles use greedy shelves
const MAX_EXHAUSTIVE_TILES = 9;

// ── Stage 2: compose tiles in bands ────────────────────

export interface PlacedTile {
  tile: Tile;
  band: number;
  x: number;
  dy: number;
}

export interface Floorplan {
  placedTiles: PlacedTile[];
  bandHeights: number[];
  rows: number;
  cols: number;
  wiresEst: number;
  wireLen: number;
  area: number;
}

export function sharedNetCount(a: Tile, b: Tile): number {
  let n = 0;
  for (const net of a.rowsOfNet.keys()) if (b.rowsOfNet.has(net)) n++;
  return n;
}

function layoutBands(tiles: Tile[], assign: number[], bandCount: number, gap: number): Floorplan | null {
  const bands: Tile[][] = Array.from({ length: bandCount }, () => []);
  tiles.forEach((t, i) => bands[assign[i]].push(t));
  if (bands.some((b) => b.length === 0)) return null;

  const placedTiles: PlacedTile[] = [];
  const bandHeights: number[] = [];
  let rows = 0;
  let cols = 0;
  let wiresEst = 0;
  const netRowKeys = new Map<string, Set<string>>();
  // net -> placed pin-row midpoints (final coordinates), for wire length
  const netPts = new Map<string, { r: number; x: number }[]>();

  for (let bi = 0; bi < bandCount; bi++) {
    const bandTiles = bands[bi];
    const bandH = Math.max(...bandTiles.map((t) => t.height));
    bandHeights.push(bandH);
    const oy = rows + (bi > 0 ? 1 : 0);
    // Seed with the band's best-connected tile; the rest attach to either
    // end of the row, so a hub of many nets ends up central, not cornered.
    const totalShared = (t: Tile) =>
      bandTiles.reduce((s, o) => s + (o === t ? 0 : sharedNetCount(t, o)), 0);
    const chain: Tile[] = [bandTiles.reduce((a, b) => {
      const sa = totalShared(a);
      const sb = totalShared(b);
      return sb > sa || (sb === sa && b.width > a.width) ? b : a;
    })];
    const rest = bandTiles.filter((t) => t !== chain[0]);
    while (rest.length > 0) {
      let pick: { t: Tile; w: number } | null = null;
      for (const t of rest) {
        const w = Math.max(...chain.map((c) => sharedNetCount(c, t)));
        if (!pick || w > pick.w || (w === pick.w && t.width > pick.t.width)) pick = { t, w };
      }
      chain.push(pick!.t);
      rest.splice(rest.indexOf(pick!.t), 1);
    }
    let xLo = 0;
    let xHi = -1;
    const bandPlaced: PlacedTile[] = [];
    const bandPts: { r: number; x: number }[] = [];
    for (const t of chain) {
      let x: number;
      if (xHi < xLo) {
        x = 0;
      } else {
        // attach to whichever end keeps this tile's nets shortest
        const costAt = (xc: number) => {
          let cost = 0;
          for (const net of t.rowsOfNet.keys()) {
            for (const p of netPts.get(net) ?? []) cost += Math.abs(xc - p.x);
          }
          return cost;
        };
        const left = xLo - gap - t.width;
        const right = xHi + gap;
        x = costAt(left + t.width / 2) < costAt(right + t.width / 2) ? left : right;
      }
      xLo = Math.min(xLo, x);
      xHi = Math.max(xHi, x + t.width - 1);
      let pick = t;
      let bestDy = 0;
      let bestScore = -1;
      for (const v of t.flipped ? [t, t.flipped] : [t]) {
        for (let dy = 0; dy + v.height <= bandH; dy++) {
          let score = 0;
          for (const [net, netRows] of v.rowsOfNet) {
            const keys = netRowKeys.get(net);
            if (!keys) continue;
            for (const row of netRows) {
              if (keys.has(`${bi}:${row + dy}`)) score++;
            }
          }
          if (score > bestScore) {
            bestScore = score;
            bestDy = dy;
            pick = v;
          }
        }
      }
      for (const [net, netRows] of pick.rowsOfNet) {
        if (!netRowKeys.has(net)) netRowKeys.set(net, new Set());
        for (const row of netRows) {
          netRowKeys.get(net)!.add(`${bi}:${row + bestDy}`);
          const pt = { r: oy + bestDy + row, x: x + pick.width / 2 };
          if (!netPts.has(net)) netPts.set(net, []);
          netPts.get(net)!.push(pt);
          bandPts.push(pt);
        }
      }
      bandPlaced.push({ tile: pick, band: bi, x, dy: bestDy });
    }
    for (const p of bandPlaced) p.x -= xLo;
    for (const p of bandPts) p.x -= xLo;
    placedTiles.push(...bandPlaced);
    cols = Math.max(cols, xHi - xLo + 1);
    rows += bandH + (bi > 0 ? 1 : 0);
  }
  for (const [, keys] of netRowKeys) wiresEst += Math.max(0, keys.size - 1);
  let wireLen = 0;
  for (const [, pts] of netPts) {
    if (pts.length < 2) continue;
    const rs = pts.map((p) => p.r);
    const xs = pts.map((p) => p.x);
    wireLen += Math.max(...rs) - Math.min(...rs) + Math.max(...xs) - Math.min(...xs);
  }
  return { placedTiles, bandHeights, rows, cols, wiresEst, wireLen, area: rows * cols };
}

export function composeTiles(tiles: Tile[], gap: number, limits: DimLimits): Floorplan | null {
  if (tiles.length === 0) return null;
  // Area and inter-tile wire length trade off: a cell of wire is about as
  // ugly as a cell of board, and each extra wire costs a few cells' worth.
  // A floorplan beyond a locked dimension is close to useless.
  const overCap = (f: Floorplan) =>
    (limits.maxRows ? Math.max(0, f.rows - limits.maxRows) : 0) +
    (limits.maxCols ? Math.max(0, f.cols - limits.maxCols) : 0);
  // a locked dimension is paid for in full whether used or not, so staying
  // under it is free — only the unlocked dimension costs cells
  const effArea = (f: Floorplan) =>
    (limits.maxRows ? Math.max(limits.maxRows, f.rows) : f.rows) *
    (limits.maxCols ? Math.max(limits.maxCols, f.cols) : f.cols);
  const badness = (f: Floorplan) => effArea(f) + 4 * f.wiresEst + f.wireLen + 200 * overCap(f);
  const better = (a: Floorplan, b: Floorplan) =>
    badness(a) < badness(b) ||
    (badness(a) === badness(b) && Math.max(a.rows, a.cols) < Math.max(b.rows, b.cols));

  let best: Floorplan | null = null;
  const consider = (fp: Floorplan | null) => {
    if (fp && (!best || better(fp, best))) best = fp;
  };
  if (tiles.length <= MAX_EXHAUSTIVE_TILES) {
    // 4^9 assignments is seconds of work; big sets stick to three bands
    // (the shelves candidate below covers many-band splits anyway)
    const maxBands = Math.min(tiles.length <= 7 ? 4 : 3, tiles.length);
    for (let bandCount = 1; bandCount <= maxBands; bandCount++) {
      const assign = new Array<number>(tiles.length).fill(0);
      const rec = (i: number) => {
        if (i === tiles.length) {
          consider(layoutBands(tiles, assign, bandCount, gap));
          return;
        }
        for (let b = 0; b < bandCount; b++) {
          assign[i] = b;
          rec(i + 1);
        }
      };
      rec(0);
    }
  }
  // Greedy shelves: for many tiles the only strategy; for few an extra
  // candidate — unlimited bands can be the only shape under a locked width
  {
    const order = [...tiles].sort((a, b) => b.height - a.height || b.width - a.width);
    const totalArea = tiles.reduce((s, t) => s + t.height * t.width, 0);
    const widest = Math.max(...tiles.map((t) => t.width));
    const targetW = limits.maxCols
      ? Math.max(limits.maxCols, widest)
      : limits.maxRows
        ? Math.max(Math.ceil((totalArea / limits.maxRows) * 1.15), widest)
        : Math.max(Math.ceil(Math.sqrt(totalArea) * 1.15), widest);
    const assign = new Array<number>(tiles.length).fill(0);
    let band = 0;
    let x = 0;
    for (const t of order) {
      if (x > 0 && x + t.width > targetW) {
        band++;
        x = 0;
      }
      assign[tiles.indexOf(t)] = band;
      x += t.width + gap;
    }
    consider(layoutBands(tiles, assign, band + 1, gap));
  }
  return best;
}
