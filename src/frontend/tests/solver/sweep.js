// Sweep the extracted benchmark corpus (see extract.js) through the v2
// solver and record per-project results for baseline tracking.
//
//   node tests/solver/sweep.js --data <dir> [--locked N] [--tag name] [--ids 1,2,3] [--jobs N] [--tidy 15|30|unlimited] [--perms K]
//                              [--lock-connectors] [--lock-width] [--only-locked] [--require-connector] [--max-parts N]
//                              [--relax adaptive|flat] [--beam] [--no-pick-crossings] [--drilled]
//
// Each project runs from a blank board. With --locked N, a second run locks
// N parts at their human positions (connectors first, then big rigids — the
// parts users actually lock) so the area price of locks is measurable.
// --lock-connectors locks every connector instead of a fixed count,
// --lock-width holds the board to the human's column count (rows stay free),
// --only-locked drops the unconstrained run, and --require-connector skips
// projects that have no connector to lock.
// Projects run across worker threads (--jobs, default: all cores); each
// solve is deterministic and independent, so results are identical at any
// thread count. Results go to <data>/results/sweep-<tag>.json; the repo
// never sees them.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { metrics, resolveDef, netlistMetrics } = require("./metricsLib.js");
const { computeAutoLayout2, DEFAULT_COMPONENTS, flexGeometry, boardLayout } = require("./helpers.js");

const aspectOf = (rows, cols) => Math.round((Math.max(rows, cols) / Math.min(rows, cols)) * 100) / 100;

let noHarvest = false;
let maxClusterOpt = 0;
// Tidy second pass: allowed area growth fraction (Infinity = unlimited), 0 = off
let tidyGrowthOpt = 0;
// Input-order jitter: number of deterministic orderings to solve (0/1 = off)
let permsOpt = 0;
// Beam search: refine every distinct stage-2 construction, keep the best
let beamOpt = false;
// Guarded final pick: fewest crossings first, then the rating. ON by
// default in the solver now; --no-pick-crossings disables it for A/B runs.
let noPickCrossings = false;
// Drilled-cuts-only mode (project option): never cut between holes
let drilledOpt = false;
// Lock every connector rather than the --locked N head of the priority list
let lockConnectors = false;
// Hold the board to the human's column count; rows stay free
let lockWidth = false;
// Skip the unconstrained run (halves a locked sweep)
let onlyLocked = false;
// Physical-rule relaxation: "flat" removes clearance halos and span minimums
// outright; "adaptive" grants, per part definition, only the liberties this
// project's human layout demonstrably took ("" = off)
let relaxMode = "";

// Build the relaxed def set for one project. Defaults are only ever
// loosened, never tightened: span limits widen to cover observed spans,
// and clearance halos drop just far enough (found by bisection) that the
// human's own placements become legal. Violations no constant can absolve
// (crossing bodies, corridors over pins, overlapping footprints) are left.
function relaxDefs(defs, comps) {
  if (relaxMode === "flat") {
    return defs.map((d) =>
      d.flexible ? { ...d, spanOverride: { min: 1, max: flexGeometry.spanLimits(d).max }, clearance: 0 } : d
    );
  }
  const placed = comps.filter((c) => c.boardPos && !c.boardExcluded);
  const spanObs = new Map();
  const flexParts = [];
  const rigidRects = [];
  for (const c of placed) {
    const def = resolveDef(c, defs);
    if (!def) continue;
    if (def.flexible) {
      const [p1, p2] = boardLayout.getFlexiblePinPositions(c, def);
      if (!p1 || !p2) continue;
      const span = Math.hypot(p1.row - p2.row, p1.col - p2.col);
      const o = spanObs.get(def.id) ?? { min: Infinity, max: 0 };
      o.min = Math.min(o.min, span);
      o.max = Math.max(o.max, span);
      spanObs.set(def.id, o);
      flexParts.push({ defId: def.id, def, p1, p2 });
    } else {
      rigidRects.push(boardLayout.getComponentBounds(def, c.boardPos, c.rotation));
    }
  }
  const halo = new Map();
  const lowerHalo = (defId, v) => halo.set(defId, Math.min(halo.get(defId) ?? Infinity, Math.max(0, v)));
  for (let i = 0; i < flexParts.length; i++) {
    const a = flexParts[i];
    for (let j = i + 1; j < flexParts.length; j++) {
      const b = flexParts[j];
      const pairClr = Math.max(flexGeometry.clearanceOf(a.def), flexGeometry.clearanceOf(b.def));
      if (!flexGeometry.bodiesTooClose(a.p1, a.p2, b.p1, b.p2, pairClr)) continue;
      // Largest pair clearance (the max of the two defs') this placement
      // still permits; both defs get lowered to it, so the pair max stays
      // legal. Bodies inside the contact minimum bisect down to 0.
      let lo = 0;
      let hi = pairClr;
      if (!flexGeometry.bodiesTooClose(a.p1, a.p2, b.p1, b.p2, 0)) {
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (flexGeometry.bodiesTooClose(a.p1, a.p2, b.p1, b.p2, mid)) hi = mid;
          else lo = mid;
        }
      }
      lowerHalo(a.defId, lo);
      lowerHalo(b.defId, lo);
    }
    for (const rect of rigidRects) {
      const clr = flexGeometry.clearanceOf(a.def);
      if (!flexGeometry.bodyIntersectsRect(a.p1, a.p2, rect, clr)) continue;
      let lo = 0;
      let hi = clr;
      if (!flexGeometry.bodyIntersectsRect(a.p1, a.p2, rect, 0)) {
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (flexGeometry.bodyIntersectsRect(a.p1, a.p2, rect, mid)) hi = mid;
          else lo = mid;
        }
      }
      lowerHalo(a.defId, lo);
    }
  }
  return defs.map((d) => {
    if (!d.flexible) return d;
    const sl = flexGeometry.spanLimits(d);
    const o = spanObs.get(d.id);
    const min = o && o.min < sl.min - 1e-9 ? Math.max(1, o.min - 1e-3) : sl.min;
    const max = o && o.max > sl.max + 1e-9 ? o.max + 1e-3 : sl.max;
    const h = halo.get(d.id);
    const clr = h !== undefined && h < flexGeometry.clearanceOf(d) ? Math.floor(h * 1000) / 1000 : undefined;
    if (min === sl.min && max === sl.max && clr === undefined) return d;
    return { ...d, spanOverride: { min, max }, ...(clr !== undefined ? { clearance: clr } : {}) };
  });
}

function solve(board, comps, defs, nets, asg) {
  const t0 = Date.now();
  let res;
  try {
    res = computeAutoLayout2(board, comps, defs, nets, asg, undefined, {
      harvest: !noHarvest,
      ...(maxClusterOpt > 0 ? { maxCluster: maxClusterOpt } : {}),
      ...(tidyGrowthOpt > 0 ? { tidyGrowth: tidyGrowthOpt } : {}),
      ...(permsOpt > 1 ? { permutations: permsOpt } : {}),
      ...(beamOpt ? { beamSearch: true } : {}),
      ...(noPickCrossings ? { crossingsPick: false } : {}),
      ...(drilledOpt ? { drilledCutsOnly: true } : {}),
    });
  } catch (err) {
    return { error: String(err && err.message ? err.message : err), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const byId = new Map(res.placements.map((p) => [p.componentId, p]));
  const solvedComps = comps.map((c) => {
    const p = byId.get(c.id);
    if (!p) return c;
    return {
      ...c,
      boardPos: p.boardPos,
      ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
      ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}),
    };
  });
  const solvedBoard = {
    ...board,
    ...(res.boardSize ?? {}),
    cuts: res.cuts,
    wires: res.wires.map((w, i) => ({ id: `w${i}`, ...w })),
  };
  const m = metrics(solvedBoard, solvedComps, defs, nets, asg);
  return {
    ms,
    quality: res.quality,
    issues: res.issues,
    tiles: res.tiles,
    rows: solvedBoard.rows,
    cols: solvedBoard.cols,
    area: solvedBoard.rows * solvedBoard.cols,
    aspect: aspectOf(solvedBoard.rows, solvedBoard.cols),
    unplaced: m.unplaced,
    // Beam runs only: how many distinct stage-2 constructions the ladder
    // offered, i.e. how many complete solves the beam paid for.
    ...(res.beamPool ? { poolSize: res.beamPool.length } : {}),
    cuts: m.cuts,
    betweenCuts: res.cuts.reduce((n, c) => n + (c.kind !== "hole" ? 1 : 0), 0),
    wires: m.wires,
    // Deepest channel stack: wires sharing one line collinearly (self included)
    maxWireStack: res.wires.reduce(
      (mx, w, i) =>
        Math.max(mx, 1 + flexGeometry.wireStackDepth(w.from, w.to, res.wires.filter((_, j) => j !== i))),
      res.wires.length > 0 ? 1 : 0
    ),
    wireLen: m.wireLen,
    offAxisWires: m.offAxisWires,
    crossings: m.crossings,
    stripCompletePct: m.stripCompletePct,
    cohesion: m.cohesion,
    bboxArea: m.bboxArea,
  };
}

// The parts a user would lock: connectors first (panel wiring), then the
// biggest rigid footprints (pots, ICs), rest by id. Deterministic.
function pickLocked(comps, defs, n) {
  const placeable = comps.filter((c) => c.boardPos && !c.boardExcluded);
  const sized = placeable.map((c) => {
    const def = resolveDef(c, defs);
    const cells = def ? (def.width ?? 1) * (def.height ?? 1) : 0;
    const isConn = def?.category === "connector";
    const isRigid = def ? !def.flexible : false;
    return { c, key: [isConn ? 0 : 1, isRigid ? 0 : 1, -cells, c.id] };
  });
  sized.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] < b.key[i]) return -1;
      if (a.key[i] > b.key[i]) return 1;
    }
    return 0;
  });
  return new Set(sized.slice(0, n).map((s) => s.c.id));
}

// Every placed connector: the parts that face outwards, where a user cares
// about the position because panel wiring has to reach it.
function connectorIds(comps, defs) {
  return new Set(
    comps
      .filter((c) => c.boardPos && !c.boardExcluded && resolveDef(c, defs)?.category === "connector")
      .map((c) => c.id)
  );
}

function sweepOne(entry, dataDir, lockedN) {
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, "projects", `${entry.id}.json`), "utf8"));
  const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
  const nets = data.nets ?? [];
  const asg = data.netAssignments ?? [];
  const humanBoard = data.board;
  const humanComps = data.components;
  const human = metrics(humanBoard, humanComps, defs, nets, asg);

  const blankComps = humanComps.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }));
  const blankBoard = { ...humanBoard, cuts: [], wires: [] };
  const solveDefs = relaxMode ? relaxDefs(defs, humanComps) : defs;
  const free = onlyLocked ? null : solve(blankBoard, blankComps, solveDefs, nets, asg);

  const row = {
    id: entry.id,
    parts: entry.parts,
    nets: nets.length,
    netlist: netlistMetrics(humanComps, defs, asg),
    human: {
      rows: humanBoard.rows,
      cols: humanBoard.cols,
      area: humanBoard.rows * humanBoard.cols,
      aspect: aspectOf(humanBoard.rows, humanBoard.cols),
      cuts: human.cuts,
      wires: human.wires,
      offAxisWires: human.offAxisWires,
      crossings: human.crossings,
      stripCompletePct: human.stripCompletePct,
      bboxArea: human.bboxArea,
      conflicts: human.conflicts,
      incomplete: human.incomplete,
    },
    ...(free ? { free } : {}),
    ...(relaxMode ? { relaxedDefs: solveDefs.filter((d, i) => d !== defs[i]).length } : {}),
  };

  const wantLocked = lockConnectors || lockedN > 0;
  if (wantLocked && !free?.error) {
    const lockIds = lockConnectors
      ? connectorIds(humanComps, defs)
      : pickLocked(humanComps, defs, Math.min(lockedN, entry.parts));
    const lockedComps = humanComps.map((c) =>
      lockIds.has(c.id)
        ? { ...c, locked: true }
        : { ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }
    );
    // A locked width is a hard limit the solver pays for in full; rows stay
    // free so it can reshape into the user's physical board.
    const lockedBoard = lockWidth ? { ...blankBoard, cols: humanBoard.cols, lockedCols: true } : blankBoard;
    row.locked = solve(lockedBoard, lockedComps, solveDefs, nets, asg);
    row.locked.n = lockIds.size;
    row.locked.lockedFrac = Math.round((100 * lockIds.size) / Math.max(1, entry.parts)) / 100;
    if (!row.locked.error) {
      row.locked.fitsWidth = row.locked.cols <= humanBoard.cols;
      if (free) row.locked.areaDelta = row.locked.area - free.area;
    }
  }
  return row;
}

if (!isMainThread) {
  noHarvest = !!workerData.noHarvest;
  maxClusterOpt = workerData.maxClusterOpt ?? 0;
  tidyGrowthOpt = workerData.tidyGrowthOpt ?? 0;
  permsOpt = workerData.permsOpt ?? 0;
  beamOpt = !!workerData.beamOpt;
  noPickCrossings = !!workerData.noPickCrossings;
  drilledOpt = !!workerData.drilledOpt;
  lockConnectors = !!workerData.lockConnectors;
  lockWidth = !!workerData.lockWidth;
  onlyLocked = !!workerData.onlyLocked;
  relaxMode = workerData.relaxMode ?? "";
  parentPort.on("message", (msg) => {
    parentPort.postMessage({ i: msg.i, row: sweepOne(msg.entry, workerData.dataDir, workerData.lockedN) });
  });
  return;
}

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = argVal("data");
if (!dataDir) {
  console.error("usage: node sweep.js --data <dir> [--locked N] [--tag name] [--ids 1,2,3] [--jobs N]");
  process.exit(1);
}
const lockedN = Number(argVal("locked") ?? 0);
noHarvest = args.includes("--no-harvest");
maxClusterOpt = Number(argVal("max-cluster") ?? 0);
// --tidy 15|30|unlimited enables the tidy second pass at that growth cap
const tidyArg = argVal("tidy");
tidyGrowthOpt = tidyArg === "unlimited" ? Infinity : tidyArg ? Number(tidyArg) / 100 : 0;
permsOpt = Number(argVal("perms") ?? 0);
beamOpt = args.includes("--beam");
noPickCrossings = args.includes("--no-pick-crossings");
drilledOpt = args.includes("--drilled");
lockConnectors = args.includes("--lock-connectors");
lockWidth = args.includes("--lock-width");
onlyLocked = args.includes("--only-locked");
const requireConnector = args.includes("--require-connector");
relaxMode = argVal("relax") ?? "";
if (relaxMode && relaxMode !== "adaptive" && relaxMode !== "flat") {
  console.error("--relax takes 'adaptive' or 'flat'");
  process.exit(1);
}
if (onlyLocked && !lockConnectors && lockedN <= 0) {
  console.error("--only-locked needs a locking mode (--lock-connectors or --locked N)");
  process.exit(1);
}
const tag = argVal("tag") ?? new Date().toISOString().slice(0, 10);
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;

const maxParts = Number(argVal("max-parts") ?? 0);
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
// Projects whose parts name component definitions that no longer exist are
// invisible to the solver AND to the editor: not hard, just unsolvable data.
// They are out of the corpus, not a failure to report. --keep-legacy overrides.
const legacy = index.filter((e) => e.unresolvedDefs > 0);
if (legacy.length && !args.includes("--keep-legacy")) {
  console.log(`excluding ${legacy.length} projects with unresolved component defs (ids ${legacy.map((e) => e.id).join(", ")})`);
}
let entries = index.filter(
  (e) =>
    (!onlyIds || onlyIds.has(e.id)) &&
    (!maxParts || e.parts <= maxParts) &&
    (args.includes("--keep-legacy") || e.unresolvedDefs === 0)
);
if (requireConnector) {
  const before = entries.length;
  entries = entries.filter((e) => {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, "projects", `${e.id}.json`), "utf8"));
    return connectorIds(data.components, [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])]).size > 0;
  });
  console.log(`connector filter: ${entries.length}/${before} projects have a connector to lock`);
}
const jobs = Math.min(entries.length, Math.max(1, Number(argVal("jobs") ?? os.availableParallelism())));

function finish(results) {
  const resDir = path.join(dataDir, "results");
  fs.mkdirSync(resDir, { recursive: true });
  const outFile = path.join(resDir, `sweep-${tag}${lockedN ? `-locked${lockedN}` : ""}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { tag, lockedN, lockConnectors, lockWidth, onlyLocked, perms: permsOpt, beam: beamOpt, pickCrossings: !noPickCrossings, drilled: drilledOpt, maxCluster: maxClusterOpt, relax: relaxMode, date: new Date().toISOString(), results },
      null,
      1
    )
  );

  // ── Summary ──────────────────────────────────────────
  const pct = (n, d) => `${Math.round((100 * n) / d)}%`;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  if (onlyLocked) {
    const lok = results.filter((r) => r.locked && !r.locked.error);
    const lq0 = lok.filter((r) => r.locked.quality === 0);
    console.log(`\nswept ${results.length} projects → ${outFile}`);
    console.log(`locked errors     ${results.length - lok.length}`);
    console.log(`locked quality 0  ${lq0.length}/${lok.length} (${pct(lq0.length, lok.length)})`);
    if (lockWidth) console.log(`within human width ${lq0.filter((r) => r.locked.fitsWidth).length}/${lq0.length} (${pct(lq0.filter((r) => r.locked.fitsWidth).length, lq0.length)})`);
    console.log(`median area vs human    ${median(lq0.map((r) => r.locked.area / r.human.area)).toFixed(2)}x`);
    console.log(`median locked parts     ${median(lq0.map((r) => r.locked.n))} (${Math.round(100 * median(lq0.map((r) => r.locked.lockedFrac)))}% of parts)`);
    console.log(`total wires             ${lq0.reduce((s, r) => s + r.locked.wires, 0)}  (human ${lq0.reduce((s, r) => s + r.human.wires, 0)})`);
    console.log(`total off-axis          ${lq0.reduce((s, r) => s + r.locked.offAxisWires, 0)}  (human ${lq0.reduce((s, r) => s + r.human.offAxisWires, 0)})`);
    console.log(`total crossings         ${lq0.reduce((s, r) => s + r.locked.crossings, 0)}  (human ${lq0.reduce((s, r) => s + r.human.crossings, 0)})`);
    console.log(`median solve ms         ${median(lok.map((r) => r.locked.ms))}`);
    return;
  }

  const ok = results.filter((r) => !r.free.error);
  const q0 = ok.filter((r) => r.free.quality === 0);
  const ratioTo = (sel) => median(q0.map((r) => sel(r)).filter((x) => isFinite(x)));

  console.log(`\nswept ${results.length} projects → ${outFile}`);
  console.log(`errors            ${results.length - ok.length}`);
  console.log(`quality 0         ${q0.length}/${ok.length} (${pct(q0.length, ok.length)})`);
  console.log(`median area vs human    ${ratioTo((r) => r.free.area / r.human.area).toFixed(2)}x`);
  console.log(`median aspect (solver)  ${median(q0.map((r) => r.free.aspect)).toFixed(2)}  (human ${median(q0.map((r) => r.human.aspect)).toFixed(2)})`);
  console.log(`aspect > 3              ${q0.filter((r) => r.free.aspect > 3).length}  (human ${q0.filter((r) => r.human.aspect > 3).length})`);
  console.log(`median strip-complete   ${median(q0.map((r) => r.free.stripCompletePct))}%  (human ${median(q0.map((r) => r.human.stripCompletePct))}%)`);
  console.log(`median solve ms         ${median(ok.map((r) => r.free.ms))}`);
  if (lockedN > 0) {
    const lok = ok.filter((r) => r.locked && !r.locked.error);
    const lq0 = lok.filter((r) => r.locked.quality === 0);
    console.log(`--- locked ${lockedN} ---`);
    console.log(`locked errors     ${ok.length - lok.length}`);
    console.log(`locked quality 0  ${lq0.length}/${lok.length} (${pct(lq0.length, lok.length)})`);
    console.log(`median area delta       ${median(lq0.map((r) => r.locked.areaDelta))} cells (${median(lq0.map((r) => r.locked.area / r.free.area)).toFixed(2)}x free run)`);
    console.log(`median aspect (locked)  ${median(lq0.map((r) => r.locked.aspect)).toFixed(2)}`);
    console.log(`aspect > 3 (locked)     ${lq0.filter((r) => r.locked.aspect > 3).length}`);
  }
}

if (jobs <= 1) {
  const results = [];
  let done = 0;
  for (const entry of entries) {
    results.push(sweepOne(entry, dataDir, lockedN));
    done++;
    if (done % 25 === 0) console.log(`${done}/${entries.length}...`);
  }
  finish(results);
} else {
  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  for (let w = 0; w < jobs; w++) {
    const worker = new Worker(__filename, {
      workerData: { dataDir, lockedN, noHarvest, maxClusterOpt, tidyGrowthOpt, permsOpt, beamOpt, noPickCrossings, drilledOpt, lockConnectors, lockWidth, onlyLocked, relaxMode },
    });
    worker.on("message", ({ i, row }) => {
      results[i] = row;
      done++;
      if (done % 25 === 0) console.log(`${done}/${entries.length}...`);
      if (next < entries.length) {
        worker.postMessage({ i: next, entry: entries[next] });
        next++;
      } else {
        worker.terminate();
        if (done === entries.length) finish(results);
      }
    });
    worker.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    worker.postMessage({ i: next, entry: entries[next] });
    next++;
  }
}
