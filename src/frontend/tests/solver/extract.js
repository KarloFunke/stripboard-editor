// Extract the benchmark corpus from a prod DB copy into a gitignored folder.
//
// Selects projects with at least one component, one net, and a finished
// human layout (every non-excluded part placed), deduplicates identical
// layouts (unchanged forks of the demo projects), and writes one JSON per
// project plus an index. Output contains NO usernames, project names or
// uuids — numeric project ids only.
//
//   node tests/solver/extract.js --db <path-to-db.sqlite3> --out <dir>
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  computeStripSegments, computeConnectivity, checkNetCompleteness, DEFAULT_COMPONENTS, boardLayout,
} = require("./helpers.js");
const { resolveDef } = require("./metricsLib.js");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argVal("db");
const outDir = argVal("out");
if (!dbPath || !outDir) {
  console.error("usage: node extract.js --db <path> --out <dir>");
  process.exit(1);
}

function sql(query) {
  const r = spawnSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

// Canonical JSON (sorted keys) so hashes ignore key order
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

function resolveDefs(data) {
  const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
  const custom = (data.componentDefs ?? []).filter((d) => !defaultIds.has(d.id));
  return [...DEFAULT_COMPONENTS, ...custom];
}

// Layout-relevant content only: label renames or schematic moves in a fork
// must not defeat the dedup, a changed placement must.
function layoutHashOf(data, board) {
  const comps = (data.components ?? []).map((c) => ({
    id: c.id, defId: c.defId, footprintOverride: c.footprintOverride,
    boardPos: c.boardPos, flexibleEndPos: c.flexibleEndPos,
    rotation: c.rotation, boardExcluded: c.boardExcluded, locked: c.locked,
  }));
  return hash(canon({
    comps, assignments: data.netAssignments ?? [],
    rows: board.rows, cols: board.cols, wires: board.wires ?? [], cuts: board.cuts ?? [],
  }));
}

// Circuit identity without labels or geometry, to group same-netlist variants
function netlistHashOf(data) {
  const defOf = new Map((data.components ?? []).map((c) => [c.id, c.defId]));
  const nets = new Map();
  for (const a of data.netAssignments ?? []) {
    if (!nets.has(a.netId)) nets.set(a.netId, []);
    nets.get(a.netId).push(`${defOf.get(a.componentId)}:${a.pinId}`);
  }
  const sig = [...nets.values()].map((m) => m.sort().join("|")).sort();
  return hash(canon(sig));
}

// Users oversize boards as scratch space and never shrink them afterwards;
// the layout's real footprint is what we benchmark against. Cut off empty
// border rows/cols (a locked dimension is a deliberate physical constraint
// and stays) and shift all coordinates so the content keeps its geometry.
function trimBoard(data, defs) {
  const board = data.board;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  const touch = (r, c) => {
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  };
  for (const comp of data.components) {
    if (!comp.boardPos) continue;
    const def = resolveDef(comp, defs);
    if (def) {
      const b = def.flexible
        ? boardLayout.getFlexibleBounds(comp, def)
        : boardLayout.getComponentBounds(def, comp.boardPos, comp.rotation);
      touch(b.minRow, b.minCol);
      touch(b.maxRow, b.maxCol);
    } else {
      touch(comp.boardPos.row, comp.boardPos.col);
      if (comp.flexibleEndPos) touch(comp.flexibleEndPos.row, comp.flexibleEndPos.col);
    }
  }
  for (const w of board.wires ?? []) {
    touch(w.from.row, w.from.col);
    touch(w.to.row, w.to.col);
  }
  for (const cut of board.cuts ?? []) {
    touch(cut.row, cut.col);
    if (cut.kind !== "hole") touch(cut.row, cut.col + 1); // gap cut spans two holes
  }
  if (minR === Infinity) return;
  const r0 = board.lockedRows ? 0 : Math.max(0, minR);
  const r1 = board.lockedRows ? board.rows - 1 : Math.min(board.rows - 1, maxR);
  const c0 = board.lockedCols ? 0 : Math.max(0, minC);
  const c1 = board.lockedCols ? board.cols - 1 : Math.min(board.cols - 1, maxC);
  if (r0 === 0 && c0 === 0 && r1 === board.rows - 1 && c1 === board.cols - 1) return;
  board.rows = r1 - r0 + 1;
  board.cols = c1 - c0 + 1;
  const shiftPos = (p) => {
    if (!p) return;
    p.row -= r0;
    p.col -= c0;
  };
  for (const comp of data.components) {
    shiftPos(comp.boardPos);
    shiftPos(comp.flexibleEndPos);
  }
  for (const w of board.wires ?? []) {
    shiftPos(w.from);
    shiftPos(w.to);
  }
  for (const cut of board.cuts ?? []) shiftPos(cut);
}

const rows = sql(
  "SELECT id, fork_of_id AS forkOf, updated_at AS updatedAt, data FROM projects_project ORDER BY id;"
);
fs.rmSync(path.join(outDir, "projects"), { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "projects"), { recursive: true });

const index = [];
const byLayoutHash = new Map();
let noData = 0, empty = 0, unfinished = 0, dupes = 0;

for (const row of rows) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    noData++;
    continue;
  }
  const nets = data.nets ?? [];
  const assignments = data.netAssignments ?? [];
  const board = data.board ?? {};
  if ((data.components ?? []).length === 0 || nets.length === 0 || !board.rows) {
    empty++;
    continue;
  }
  const defs = resolveDefs(data);
  // Parts wired to no net are dead weight the solver can neither place nor
  // verify — drop them so the rest of the project stays usable.
  const withNets = new Set(assignments.map((a) => a.componentId));
  const removedParts = data.components.filter((c) => !withNets.has(c.id)).length;
  data.components = data.components.filter((c) => withNets.has(c.id));
  const comps = data.components;
  if (comps.length === 0) {
    empty++;
    continue;
  }
  const placeable = comps.filter((c) => !c.boardExcluded);
  const placed = placeable.filter((c) => c.boardPos);
  if (placeable.length === 0 || placed.length !== placeable.length) {
    unfinished++;
    continue;
  }
  trimBoard(data, defs);

  const layoutHash = layoutHashOf(data, board);
  const prior = byLayoutHash.get(layoutHash);
  if (prior !== undefined) {
    dupes++;
    prior.dupIds.push(row.id);
    continue;
  }

  // Stored-layout health, so analysis can filter without re-parsing
  let conflicts = -1, incomplete = -1;
  try {
    const segments = computeStripSegments(board, comps, defs, assignments);
    const connectivity = computeConnectivity(segments, board.wires ?? []);
    conflicts = connectivity.filter((g) => g.hasConflict).length;
    incomplete = checkNetCompleteness(nets, assignments, segments, connectivity, comps, defs).length;
  } catch {
    // legacy data the solver modules reject — recorded as -1, kept
  }
  const unresolvedDefs = comps.filter((c) => !defs.find((d) => d.id === c.defId)).length;

  const entry = {
    id: row.id,
    forkOf: row.forkOf ?? null,
    updatedAt: row.updatedAt,
    parts: placeable.length,
    nets: nets.length,
    assignments: assignments.length,
    rows: board.rows,
    cols: board.cols,
    wires: (board.wires ?? []).length,
    cuts: (board.cuts ?? []).length,
    conflicts,
    incomplete,
    unresolvedDefs,
    removedParts,
    netlistHash: netlistHashOf(data),
    layoutHash,
    dupIds: [],
  };
  byLayoutHash.set(layoutHash, entry);
  index.push(entry);
  fs.writeFileSync(path.join(outDir, "projects", `${row.id}.json`), JSON.stringify(data));
}

fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 1));

const netlistGroups = new Map();
for (const e of index) netlistGroups.set(e.netlistHash, (netlistGroups.get(e.netlistHash) ?? 0) + 1);
const variantGroups = [...netlistGroups.values()].filter((n) => n > 1).length;

console.log(`total rows        ${rows.length}`);
console.log(`unparseable       ${noData}`);
console.log(`empty (no comp/net/board) ${empty}`);
console.log(`unfinished layout ${unfinished}`);
console.log(`identical dupes   ${dupes}`);
console.log(`extracted         ${index.length}`);
console.log(`  clean (0 conflicts, 0 incomplete) ${index.filter((e) => e.conflicts === 0 && e.incomplete === 0).length}`);
console.log(`  with unresolved defs             ${index.filter((e) => e.unresolvedDefs > 0).length}`);
console.log(`  with no-net parts removed        ${index.filter((e) => e.removedParts > 0).length}`);
console.log(`  same-netlist variant groups      ${variantGroups}`);
