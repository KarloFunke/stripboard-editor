// Stage-2 prototype for the v2 layouter: compose the cluster tiles onto one
// board.
//
// Tiles are arranged in horizontal bands. Tiles inside a band sit side by
// side and SHARE strip rows — different nets on one row are separated by
// derived cuts, and a boundary net whose rows align across neighbouring
// tiles is joined by plain copper, no wire at all. The floorplan search
// enumerates band assignments, orders tiles within a band by connectivity,
// and picks each tile's vertical offset to maximize aligned boundary nets.
// The real router then finishes the board and the shared metrics score it
// against the stored human layout.
//
// Usage: node tests/solver/compose.js --db <path> --id <project-id> [--cap N]
const { spawnSync } = require("child_process");
const { buildComponentGraph, agglomerate } = require("./clusterLib.js");
const { planCluster } = require("./stripPlanLib.js");
const { metrics } = require("./metricsLib.js");
const { computeAutoFinish, DEFAULT_COMPONENTS, checkGeometry, boardLayout } = require("./helpers.js");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argVal("db");
const projectId = argVal("id");
if (!dbPath || !projectId) {
  console.error("usage: node compose.js --db <path> --id <project-id> [--cap N]");
  process.exit(1);
}

const r = spawnSync("sqlite3", ["-json", dbPath, `SELECT id, name, data FROM projects_project WHERE id = ${Number(projectId)};`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0 || !r.stdout.trim()) {
  console.error(r.stderr || "project not found");
  process.exit(1);
}
const proj = JSON.parse(r.stdout)[0];
const data = JSON.parse(proj.data);
const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
const resolveDef = (comp) => {
  const def = defs.find((d) => d.id === comp.defId);
  return def && comp.footprintOverride ? { ...def, ...comp.footprintOverride } : def;
};

// ── Cluster and plan all tiles ─────────────────────────
const { compById, nodeIds, adj } = buildComponentGraph(data);
const { membership } = agglomerate(adj, nodeIds.length, Number(argVal("cap") ?? 12));
const byCluster = new Map();
nodeIds.forEach((id, i) => {
  if (!byCluster.has(membership[i])) byCluster.set(membership[i], []);
  byCluster.get(membership[i]).push(compById.get(id));
});
const clusters = [...byCluster.values()].sort((a, b) => b.length - a.length);

const tiles = [];
const unplanned = [];
clusters.forEach((cluster, i) => {
  const clusterIds = new Set(cluster.map((c) => c.id));
  const asg = (data.netAssignments ?? []).filter((a) => clusterIds.has(a.componentId));
  const tile = planCluster(cluster, asg, resolveDef);
  if (tile.error) {
    console.log(`cluster ${i + 1} unplanned: ${tile.error}`);
    unplanned.push(...cluster);
    return;
  }
  tiles.push({ idx: i + 1, cluster, ...tile });
});
console.log(`tiles: ${tiles.map((t) => `#${t.idx} ${t.height}x${t.width}`).join(", ")}`);

// ── Floorplan search over band assignments ─────────────
const boardR = data.board.rows;
const boardC = data.board.cols;
const T = tiles.length;
const sharedNets = (a, b) => {
  let n = 0;
  for (const net of a.rowsOfNet.keys()) if (b.rowsOfNet.has(net)) n++;
  return n;
};

function evalConfig(assign, bandCount) {
  const bands = Array.from({ length: bandCount }, () => []);
  tiles.forEach((t, i) => bands[assign[i]].push(t));
  if (bands.some((b) => b.length === 0)) return null;

  const placedTiles = []; // { tile, band, x, dy }
  let totalRows = 0;
  let maxW = 0;
  let aligned = 0;
  const netRowKeys = new Map(); // net -> Set of "band:localRow"

  for (let bi = 0; bi < bandCount; bi++) {
    const bandTiles = [...bands[bi]];
    const bandH = Math.max(...bandTiles.map((t) => t.height));
    // Order by connectivity chain: widest first, then closest-connected
    const chain = [bandTiles.reduce((a, b) => (b.width > a.width ? b : a))];
    const rest = bandTiles.filter((t) => t !== chain[0]);
    while (rest.length > 0) {
      let best = null;
      for (const t of rest) {
        const w = Math.max(...chain.map((c) => sharedNets(c, t)));
        if (!best || w > best.w || (w === best.w && (t.width > best.t.width || (t.width === best.t.width && t.idx < best.t.idx)))) {
          best = { t, w };
        }
      }
      chain.push(best.t);
      rest.splice(rest.indexOf(best.t), 1);
    }
    // Place left to right; pick dy to maximize aligned boundary-net rows
    let x = 0;
    for (const t of chain) {
      let bestDy = 0;
      let bestScore = -1;
      for (let dy = 0; dy + t.height <= bandH; dy++) {
        let score = 0;
        for (const [net, rows] of t.rowsOfNet) {
          const keys = netRowKeys.get(net);
          if (!keys) continue;
          for (const row of rows) {
            if (keys.has(`${bi}:${row + dy}`)) score++;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestDy = dy;
        }
      }
      for (const [net, rows] of t.rowsOfNet) {
        if (!netRowKeys.has(net)) netRowKeys.set(net, new Set());
        for (const row of rows) netRowKeys.get(net).add(`${bi}:${row + bestDy}`);
      }
      aligned += bestScore;
      placedTiles.push({ tile: t, band: bi, x, dy: bestDy });
      x += t.width + 1;
    }
    maxW = Math.max(maxW, x - 1);
    totalRows += bandH + (bi > 0 ? 1 : 0);
  }

  // Wires needed ≈ one per extra copper group of each multi-tile net
  let wiresEst = 0;
  for (const [, keys] of netRowKeys) {
    wiresEst += Math.max(0, keys.size - 1);
  }

  const overflow = Math.max(0, totalRows - boardR) + Math.max(0, maxW - boardC);
  return { assign: [...assign], bandCount, placedTiles, totalRows, maxW, overflow, wiresEst, area: totalRows * maxW };
}

let best = null;
const maxBands = Math.min(4, T);
for (let bandCount = 1; bandCount <= maxBands; bandCount++) {
  const assign = new Array(T).fill(0);
  const rec = (i) => {
    if (i === T) {
      const cfg = evalConfig(assign, bandCount);
      if (!cfg) return;
      const betterThan = (a, b) =>
        a.overflow < b.overflow ||
        (a.overflow === b.overflow && (a.wiresEst < b.wiresEst ||
          (a.wiresEst === b.wiresEst && a.area < b.area)));
      if (!best || betterThan(cfg, best)) best = cfg;
      return;
    }
    for (let b = 0; b < bandCount; b++) {
      assign[i] = b;
      rec(i + 1);
    }
  };
  rec(0);
}
if (!best) {
  console.error("no floorplan found");
  process.exit(1);
}
console.log(`floorplan: ${best.bandCount} band(s), ${best.totalRows} rows x ${best.maxW} cols (board ${boardR}x${boardC}, overflow ${best.overflow}), est. wires ${best.wiresEst}`);

// ── Materialize ────────────────────────────────────────
const rows = Math.max(boardR, best.totalRows);
const cols = Math.max(boardC, best.maxW);
const bandY = [];
{
  let yCur = 0;
  for (let bi = 0; bi < best.bandCount; bi++) {
    bandY.push(yCur);
    const bandH = Math.max(...best.placedTiles.filter((p) => p.band === bi).map((p) => p.tile.height));
    yCur += bandH + 1;
  }
}

const comps = [];
for (const { tile, band, x, dy } of best.placedTiles) {
  const oy = bandY[band] + dy;
  if (tile.icPart) {
    comps.push({ ...tile.icPart.comp, boardPos: { row: tile.icPart.row + oy, col: tile.icPart.col + x }, rotation: tile.icPart.rotation, flexibleEndPos: undefined });
  }
  for (const p of tile.parts) {
    comps.push({
      ...p.comp,
      boardPos: { row: p.row1 + oy, col: p.col1 + x },
      rotation: 0,
      flexibleEndPos: p.row2 !== undefined ? { row: p.row2 + oy, col: p.col2 + x } : undefined,
    });
  }
  for (const f of [...tile.unpacked, ...tile.skipped]) {
    comps.push({ ...(f.comp ?? f), boardPos: null, flexibleEndPos: undefined });
  }
}
for (const c of unplanned) comps.push({ ...c, boardPos: null, flexibleEndPos: undefined });

const board = { rows, cols, cuts: [], wires: [] };
const nets = data.nets ?? [];
const asgAll = data.netAssignments ?? [];
const fin = computeAutoFinish(board, comps, defs, nets, asgAll);
const done = { ...board, cuts: fin.cuts, wires: fin.wires.map((w, i) => ({ id: `w${i}`, ...w })) };
const geo = checkGeometry(done, comps, defs);

console.log(`router: cuts=${fin.cuts.length} wires=${fin.wires.length} issues=${JSON.stringify(fin.issues)}`);
console.log(`geometry: ${geo.length === 0 ? "clean" : geo.join("; ")}`);

// ── Score against the stored human layout ──────────────
const v2 = metrics(done, comps, defs, nets, asgAll);
const human = metrics(data.board, data.components, defs, nets, asgAll);
const rowsOut = [
  ["placed parts", "placed"], ["unplaced", "unplaced"], ["conflicts", "conflicts"],
  ["incomplete nets", "incomplete"], ["cuts", "cuts"], ["wires", "wires"],
  ["wire length", "wireLen"], ["off-axis wires", "offAxisWires"], ["wires over parts", "crossings"],
  ["strip-complete nets", "stripCompleteNets"], ["strip-complete %", "stripCompletePct"],
  ["cohesion (avg dist)", "cohesion"], ["bbox area", "bboxArea"],
];
console.log(`\nboard used: ${rows}x${cols} (human: ${data.board.rows}x${data.board.cols})`);
console.log("metric".padEnd(22) + "human".padStart(10) + "v2".padStart(10));
for (const [lbl, key] of rowsOut) {
  console.log(lbl.padEnd(22) + String(human[key]).padStart(10) + String(v2[key]).padStart(10));
}

// ── ASCII render ───────────────────────────────────────
const grid = Array.from({ length: rows }, () => Array(cols).fill("·"));
for (const c of comps) {
  if (!c.boardPos) continue;
  const def = resolveDef(c);
  if (!def) continue;
  if (def.flexible && c.flexibleEndPos) {
    const { row: r1, col: c1 } = c.boardPos;
    const { row: r2, col: c2 } = c.flexibleEndPos;
    grid[r1][c1] = "o";
    grid[r2][c2] = "o";
    const steps = Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
    for (let s = 1; s < steps; s++) {
      const rr = Math.round(r1 + (r2 - r1) * (s / steps));
      const cc = Math.round(c1 + (c2 - c1) * (s / steps));
      if (grid[rr][cc] === "·") grid[rr][cc] = "|";
    }
  } else if (def.flexible) {
    grid[c.boardPos.row][c.boardPos.col] = "o";
  } else if (def.pins.length === 1) {
    grid[c.boardPos.row][c.boardPos.col] = "T";
  } else {
    for (const cell of boardLayout.getRotatedBodyCells(def, c.boardPos, c.rotation)) {
      if (grid[cell.row]) grid[cell.row][cell.col] = "#";
    }
    for (const p of boardLayout.getRotatedPinPositions(def, c.boardPos, c.rotation)) {
      if (grid[p.row]) grid[p.row][p.col] = "O";
    }
  }
}
for (const w of fin.wires) {
  grid[w.from.row][w.from.col] = "w";
  grid[w.to.row][w.to.col] = "w";
}
grid.forEach((cells) => console.log(cells.join(" ")));
