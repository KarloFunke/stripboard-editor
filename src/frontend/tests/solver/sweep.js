// Sweep the extracted benchmark corpus (see extract.js) through the v2
// solver and record per-project results for baseline tracking.
//
//   node tests/solver/sweep.js --data <dir> [--locked N] [--tag name] [--ids 1,2,3] [--jobs N] [--tidy 15|30|unlimited]
//
// Each project runs from a blank board. With --locked N, a second run locks
// N parts at their human positions (connectors first, then big rigids — the
// parts users actually lock) so the area price of locks is measurable.
// Projects run across worker threads (--jobs, default: all cores); each
// solve is deterministic and independent, so results are identical at any
// thread count. Results go to <data>/results/sweep-<tag>.json; the repo
// never sees them.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { metrics, resolveDef } = require("./metricsLib.js");
const { computeAutoLayout2, DEFAULT_COMPONENTS } = require("./helpers.js");

const aspectOf = (rows, cols) => Math.round((Math.max(rows, cols) / Math.min(rows, cols)) * 100) / 100;

let noHarvest = false;
let maxClusterOpt = 0;
// Tidy second pass: allowed area growth fraction (Infinity = unlimited), 0 = off
let tidyGrowthOpt = 0;

function solve(board, comps, defs, nets, asg) {
  const t0 = Date.now();
  let res;
  try {
    res = computeAutoLayout2(board, comps, defs, nets, asg, undefined, {
      harvest: !noHarvest,
      ...(maxClusterOpt > 0 ? { maxCluster: maxClusterOpt } : {}),
      ...(tidyGrowthOpt > 0 ? { tidyGrowth: tidyGrowthOpt } : {}),
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
    rows: solvedBoard.rows,
    cols: solvedBoard.cols,
    area: solvedBoard.rows * solvedBoard.cols,
    aspect: aspectOf(solvedBoard.rows, solvedBoard.cols),
    unplaced: m.unplaced,
    cuts: m.cuts,
    wires: m.wires,
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
  const free = solve(blankBoard, blankComps, defs, nets, asg);

  const row = {
    id: entry.id,
    parts: entry.parts,
    nets: nets.length,
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
    free,
  };

  if (lockedN > 0 && !free.error) {
    const lockIds = pickLocked(humanComps, defs, Math.min(lockedN, entry.parts));
    const lockedComps = humanComps.map((c) =>
      lockIds.has(c.id)
        ? { ...c, locked: true }
        : { ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }
    );
    row.locked = solve(blankBoard, lockedComps, defs, nets, asg);
    row.locked.n = lockIds.size;
    if (!row.locked.error) {
      row.locked.areaDelta = row.locked.area - free.area;
    }
  }
  return row;
}

if (!isMainThread) {
  noHarvest = !!workerData.noHarvest;
  maxClusterOpt = workerData.maxClusterOpt ?? 0;
  tidyGrowthOpt = workerData.tidyGrowthOpt ?? 0;
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
const tag = argVal("tag") ?? new Date().toISOString().slice(0, 10);
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;

const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const entries = index.filter((e) => !onlyIds || onlyIds.has(e.id));
const jobs = Math.min(entries.length, Math.max(1, Number(argVal("jobs") ?? os.availableParallelism())));

function finish(results) {
  const resDir = path.join(dataDir, "results");
  fs.mkdirSync(resDir, { recursive: true });
  const outFile = path.join(resDir, `sweep-${tag}${lockedN ? `-locked${lockedN}` : ""}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ tag, lockedN, date: new Date().toISOString(), results }, null, 1));

  // ── Summary ──────────────────────────────────────────
  const ok = results.filter((r) => !r.free.error);
  const q0 = ok.filter((r) => r.free.quality === 0);
  const pct = (n, d) => `${Math.round((100 * n) / d)}%`;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
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
    const worker = new Worker(__filename, { workerData: { dataDir, lockedN, noHarvest, maxClusterOpt, tidyGrowthOpt } });
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
