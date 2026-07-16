// Stage-1 CLI: plan ONE cluster strip-first and validate the tile with the
// real router + geometry checker. See stripPlanLib.js for the algorithm.
//
// Reads projects live from a local sqlite DB (gitignored). Usage:
//   node tests/solver/stripPlan.js --db <path> --id <project-id> --cluster <n> [--cap N]
// Cluster numbering matches clusters.js output (1 = largest).
const { spawnSync } = require("child_process");
const { buildComponentGraph, agglomerate } = require("./clusterLib.js");
const { planCluster } = require("./stripPlanLib.js");
const {
  computeAutoFinish, boardLayout, DEFAULT_COMPONENTS, checkGeometry,
  computeStripSegments, computeConnectivity, checkNetCompleteness,
} = require("./helpers.js");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argVal("db");
const projectId = argVal("id");
const clusterNo = Number(argVal("cluster") ?? 1);
if (!dbPath || !projectId) {
  console.error("usage: node stripPlan.js --db <path> --id <project-id> --cluster <n>");
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

const { compById, nodeIds, adj } = buildComponentGraph(data);
const { membership } = agglomerate(adj, nodeIds.length, Number(argVal("cap") ?? 12));
const byCluster = new Map();
nodeIds.forEach((id, i) => {
  if (!byCluster.has(membership[i])) byCluster.set(membership[i], []);
  byCluster.get(membership[i]).push(compById.get(id));
});
const ordered = [...byCluster.values()].sort((a, b) => b.length - a.length);
const cluster = ordered[clusterNo - 1];
if (!cluster) {
  console.error(`no cluster ${clusterNo} (project has ${ordered.length})`);
  process.exit(1);
}
const clusterIds = new Set(cluster.map((c) => c.id));
const asg = (data.netAssignments ?? []).filter((a) => clusterIds.has(a.componentId));
const netName = new Map((data.nets ?? []).map((n) => [n.id, n.name]));
const label = (c) => (c.value ? `${c.label}=${c.value}` : c.label);

console.log(`\n━━ #${proj.id} "${proj.name}" cluster ${clusterNo}: ${cluster.map(label).join(", ")} ━━`);

const tile = planCluster(cluster, asg, resolveDef);
if (tile.error) {
  console.error(`planner: ${tile.error}`);
  process.exit(1);
}
console.log(`tile ${tile.height}x${tile.width}  IC rotation ${tile.rot}  span sum ${tile.span}  around-the-chip rows ${tile.altRows}  unpacked ${tile.unpacked.length}`);

// ── Materialize on a small board and validate ──────────
const M = 1; // margin
const board = { rows: tile.height + 2 * M, cols: tile.width + 2 * M, cuts: [], wires: [] };
const comps = [];
if (tile.icPart) {
  comps.push({ ...tile.icPart.comp, boardPos: { row: tile.icPart.row + M, col: tile.icPart.col + M }, rotation: tile.icPart.rotation, flexibleEndPos: undefined });
}
for (const p of tile.parts) {
  comps.push({
    ...p.comp,
    boardPos: { row: p.row1 + M, col: p.col1 + M },
    rotation: 0,
    flexibleEndPos: p.row2 !== undefined ? { row: p.row2 + M, col: p.col2 + M } : undefined,
  });
}
for (const f of [...tile.unpacked, ...tile.skipped]) {
  comps.push({ ...(f.comp ?? f), boardPos: null, flexibleEndPos: undefined });
}

const clusterNets = (data.nets ?? []).filter((n) => asg.some((a) => a.netId === n.id));
const fin = computeAutoFinish(board, comps, defs, clusterNets, asg);
const done = { ...board, cuts: fin.cuts, wires: fin.wires.map((w, i) => ({ id: `w${i}`, ...w })) };
const segments = computeStripSegments(done, comps, defs, asg);
const connectivity = computeConnectivity(segments, done.wires);
const conflicts = connectivity.filter((g) => g.hasConflict).length;
const incomplete = checkNetCompleteness(clusterNets, asg, segments, connectivity, comps, defs);
const geo = checkGeometry(done, comps, defs);

console.log(`router check: cuts=${fin.cuts.length} wires=${fin.wires.length} conflicts=${conflicts} incomplete=${incomplete.length} issues=${JSON.stringify(fin.issues)}`);
console.log(`geometry: ${geo.length === 0 ? "clean" : geo.join("; ")}`);

// ── ASCII sketch ───────────────────────────────────────
const grid = Array.from({ length: board.rows }, () => Array(board.cols).fill("·"));
if (tile.icPart) {
  const pos = { row: tile.icPart.row + M, col: tile.icPart.col + M };
  for (const cell of boardLayout.getRotatedBodyCells(tile.icPart.def, pos, tile.icPart.rotation)) {
    if (grid[cell.row]) grid[cell.row][cell.col] = "#";
  }
  for (const p of boardLayout.getRotatedPinPositions(tile.icPart.def, pos, tile.icPart.rotation)) {
    if (grid[p.row]) grid[p.row][p.col] = "O";
  }
}
for (const p of tile.parts) {
  if (p.row2 === undefined) {
    grid[p.row1 + M][p.col1 + M] = "T";
  } else {
    grid[p.row1 + M][p.col1 + M] = "o";
    grid[p.row2 + M][p.col2 + M] = "o";
    const steps = Math.max(Math.abs(p.row2 - p.row1), Math.abs(p.col2 - p.col1));
    for (let s = 1; s < steps; s++) {
      const rr = Math.round(p.row1 + (p.row2 - p.row1) * (s / steps)) + M;
      const cc = Math.round(p.col1 + (p.col2 - p.col1) * (s / steps)) + M;
      if (grid[rr][cc] === "·") grid[rr][cc] = "|";
    }
  }
}
for (const w of fin.wires) grid[w.from.row][w.from.col] = grid[w.to.row][w.to.col] = "w";
const rowNet = new Map();
for (const [netId, rows] of tile.rowsOfNet) {
  for (const row of rows) {
    const prev = rowNet.get(row + M);
    const name = netName.get(netId) ?? netId;
    rowNet.set(row + M, prev ? `${prev} / ${name}` : name);
  }
}
grid.forEach((cells, rr) => {
  console.log(cells.join(" ") + (rowNet.has(rr) ? `   ${rowNet.get(rr)}` : ""));
});
