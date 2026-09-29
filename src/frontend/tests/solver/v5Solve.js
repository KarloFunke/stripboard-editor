// One v5 solve of one corpus project for one seed; prints a JSON line.
//   node tests/solver/v5Solve.js --data <dir> --id <n> --seed <k> --moves <m> [--out <compiled dir>]
//        [--movelog <dir>]   one gzipped CSV of every anneal proposal per id/seed
//                            (last column: the leaf of a stacked solve, empty for a joint one)
//        [--time <ms>]       wall-time budget per seed instead of --moves
//        [--speedprobe <n>]  only time n decodes of random genomes (prints probeMs)
//        [--progress 1]      print the anneal's progress reports with their time (stderr)
//        [--effort <x>]      moves = the pin-count formula times x (the editor's effort; --time then only guards)
//        [--drilled 1]       drilled cuts only
//        [--nostack 1]       no wire stacking
//        [--protect 1]       strip groups are never dissolved by the decoder (contradicting proposals refused)
//        [--wasm <file>]     the decoder module (default components/stripboard/v5wasm/v5decode.wasm)
//        [--routewasm <file>] the wire router module (default components/stripboard/v5wasm/v5route.wasm)
//        [--native 1]        decoder and router as native code (npm run build:native; see nativeInstance.js)
//        [--exact 1]         finish every new best of the walk exactly and keep the cheapest
//        [--dump <dir>]      store the seed's skeleton (the anneal's placement and wiring) as <dir>/<id>_s<seed>.json
//        [--stack <pins>]    the stacked solve: leaves under this pin cap, one above the other
//        [--stackfree 1]     with --stack: leaves at their own width instead of one locked width
//        [--stackmin <pins>] with --stack: stack only from this many placeable pins, as the editor does (joint below)
//        [--macro <pins>]    the macro solve: leaves under this pin cap become parts of a top-level anneal
//        [--toptime <ms>]    with --macro: the top-level anneal's own time budget
//        [--topmoves <n>]    with --macro: the top-level anneal's own move count (repeatable under load)
//        [--levels <n>]      with --macro: cluster the clusters, n times in all (default 1)
//        [--upperparts <n>]  with --levels: parts per cluster above the first level (default 3)
//        [--portcap <n>]     with --macro: cap clusters by shared nets, --macro is then the pin ceiling
//        [--mincompress <x>] with --portcap: a group with ports*x > pins stays loose (default 2)
//        [--macrogap <n>]    with --macro: free lines a cluster keeps around itself (default 1)
//        [--save <file>]     write the solved board as a project JSON (see tests/solver/saveToDev.js)
//        [--skeleton <file>] skip the anneal: run the finish alone on a stored skeleton
//        [--repair 0|1|2]    with --skeleton: router only (0), the decoder's board routed again when not clean (1)
//                            or as is (2); without the flag both finishes run and the cheaper board wins, as the editor does
//        [--mix <json>]      another move mix: {"early":[13 entries],"late":[13 entries],"lateFrom":0.5} (decode.c mixEarly;
//                            a table of 12, as before 2026-09-27, has no pull and tie; joint solves only)
//        [--hint <ms/move>]  decode speed of an earlier run: the time budget becomes a fixed count
const fs = require("fs");
const path = require("path");
const { metrics } = require("./metricsLib.js");
const { DEFAULT_COMPONENTS, checkGeometry, verify } = require("./helpers.js");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(argVal("out") ?? path.join(__dirname, "out"));
const { computeAutoLayout5, finishFromSkeleton } = require(path.join(OUT, "components/stripboard/autoLayout5.js"));
// the stacked solve only exists in builds from 2026-09-25 on
const computeAutoLayout5Macro = (() => { try { return require(path.join(OUT, "components/stripboard/autoLayout5Macro.js")).computeAutoLayout5Macro; } catch { return undefined; } })();
const computeAutoLayout5Stack = (() => { try { return require(path.join(OUT, "components/stripboard/autoLayout5Stack.js")).computeAutoLayout5Stack; } catch { return undefined; } })();
const { rateResult } = require(path.join(OUT, "components/stripboard/autoLayout2.js"));
// the shared price (layout2/boardPrice) only exists in builds from 2026-09-24 on
const priceResult = (() => { try { return require(path.join(OUT, "components/stripboard/layout2/boardPrice.js")).priceResult; } catch { return undefined; } })();
const { expandOffBoard } = require(path.join(OUT, "components/stripboard/offBoard.js"));

const dataDir = argVal("data");
const id = Number(argVal("id"));
const seed = Number(argVal("seed") ?? 0);
const moves = argVal("moves") ? Number(argVal("moves")) : undefined;
const moveLogDir = argVal("movelog");
const sched = argVal("sched") ? JSON.parse(argVal("sched")) : undefined;
const timeMs = argVal("time") ? Number(argVal("time")) : undefined;
const effort = argVal("effort") ? Number(argVal("effort")) : undefined;
const tProg = performance.now();
const speedProbe = argVal("speedprobe") ? Number(argVal("speedprobe")) : undefined;
const onProgress = argVal("progress") === "1" ? (p) => console.error(`progress ${p.frac.toFixed(3)} ${((performance.now() - tProg) / 1000).toFixed(2)}s`) : undefined;
const drilled = argVal("drilled") === "1";
const noStack = argVal("nostack") === "1";
const exact = argVal("exact") === "1";
const protect = argVal("protect") === "1";
// the decoder and the wire router in WebAssembly ("1" also means the default
// file, as older runs passed it); builds before 2026-09-26 route in TypeScript
const moduleOf = (arg, file) => new WebAssembly.Module(fs.readFileSync(arg && arg !== "1" ? arg : path.join(__dirname, "../../components/stripboard/v5wasm", file)));
const wasmOpts = { wasm: moduleOf(argVal("wasm"), "v5decode.wasm") };
const routeModule = moduleOf(argVal("routewasm"), "v5route.wasm");
if (argVal("native") === "1") require("./nativeInstance.js").install(wasmOpts.wasm, routeModule);
try {
  const { setRouteWasm } = require(path.join(OUT, "components/stripboard/v5wasm/routeWasm.js"));
  setRouteWasm(routeModule);
} catch (err) {
  if (err.code !== "MODULE_NOT_FOUND") throw err;
}
const dumpDir = argVal("dump");
const skeletonFile = argVal("skeleton");
const repair = argVal("repair") === "1" ? "fallback" : argVal("repair") === "2" ? "only" : argVal("repair") === "0" ? "never" : undefined;
const hint = argVal("hint") ? Number(argVal("hint")) : undefined;
const moveMix = argVal("mix") ? JSON.parse(argVal("mix")) : undefined;
let stackCap = argVal("stack") ? Number(argVal("stack")) : undefined;
const stackMin = argVal("stackmin") ? Number(argVal("stackmin")) : undefined;
const stackFree = argVal("stackfree") === "1";
const macroCap = argVal("macro") ? Number(argVal("macro")) : undefined;
const topTime = argVal("toptime") ? Number(argVal("toptime")) : undefined;
const topMoves = argVal("topmoves") ? Number(argVal("topmoves")) : undefined;
const saveFile = argVal("save");
const levels = argVal("levels") ? Number(argVal("levels")) : undefined;
const upperParts = argVal("upperparts") ? Number(argVal("upperparts")) : undefined;
const portCap = argVal("portcap") ? Number(argVal("portcap")) : undefined;
const macroGap = argVal("macrogap") !== undefined ? Number(argVal("macrogap")) : undefined;
const minCompress = argVal("mincompress") ? Number(argVal("mincompress")) : undefined;
let stackInfo;
const { getComponentBounds } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
let budget;
// The log is written as the run goes, in blocks, through one gzip stream:
// a full anneal is millions of proposals and keeping them all in memory
// cost about 2 GB per worker on a big board, which 12 workers cannot afford.
let logBuf = [];
// written synchronously, one gzip member per batch: the anneal never yields to
// the event loop, so an async stream would hold the whole log in memory
let logGz = null;
const logFlush = () => {
  if (!logGz || logBuf.length === 0) return;
  fs.writeSync(logGz, require("zlib").gzipSync(logBuf.join("\n") + "\n", { level: 1 }));
  logBuf = [];
};
const moveLog = moveLogDir
  ? (r, leaf) => {
      if (!logGz) {
        fs.mkdirSync(moveLogDir, { recursive: true });
        logGz = fs.openSync(path.join(moveLogDir, `${id}_s${seed}.csv.gz`), "w");
      }
      logBuf.push(
        r.out < 2
          ? `${id},${seed},${r.it},${r.kind},${r.out},,,,,,,,,,,,,,,,,,${leaf ?? ""}`
          : `${id},${seed},${r.it},${r.kind},${r.out},${r.best},${r.same},${r.dEcur.toFixed(2)},${r.dEfin.toFixed(2)},${r.curFin.toFixed(2)},` +
            `${r.dArea},${r.dWires},${r.dWlen},${r.dCuts},${r.dBcuts},${r.dMess},${r.dHard},${r.dStarv},${r.dOther.toFixed(2)},${r.dGeo},${r.dOverlap},${r.dStarvH},${leaf ?? ""}`
      );
      if (logBuf.length >= 8192) logFlush();
    }
  : undefined;

const data = JSON.parse(fs.readFileSync(path.join(dataDir, "projects", `${id}.json`), "utf8"));
const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
const nets = data.nets ?? [];
const asg = data.netAssignments ?? [];
const blankComps = data.components.map((c) => ({
  ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined,
}));
const blankBoard = { ...data.board, cuts: [], wires: [], lockedRows: false, lockedCols: false };
if (stackCap && stackMin) {
  const placeable = new Set(blankComps.filter((c) => !c.boardExcluded).map((c) => c.id));
  if (asg.filter((a) => placeable.has(a.componentId)).length < stackMin) stackCap = undefined;
}

const t0 = Date.now();
// the anneal's own best skeleton for this seed, read off the debugSeeds line
let decoded;
const origLog = console.log;
console.log = (...a) => {
  const m = a.join(" ").match(/^\[v5 seed \d+\] E ([\d.]+) decoded (\d+)x(\d+) (\{.*\})$/);
  if (m) decoded = { E: Number(m[1]), rows: Number(m[2]), cols: Number(m[3]), ...JSON.parse(m[4]) };
  else if (!/^FP0? /.test(a[0] ?? "") && !/^\[v5 seed /.test(a[0] ?? "")) origLog(...a);
};
let res;
try {
  if (skeletonFile) {
    const sk = JSON.parse(fs.readFileSync(skeletonFile, "utf8"));
    const m = sk.metrics;
    decoded = { E: m.eBase + 400 * m.mess, rows: sk.rows, cols: sk.cols, wires: m.wires, wireLen: m.wireLen, cuts: m.cuts, bCuts: m.bCuts };
    res = finishFromSkeleton(blankBoard, blankComps, defs, nets, asg, sk, { drilledCutsOnly: drilled, noWireStacking: noStack, ...(repair ? { repair } : {}) });
  } else if (macroCap) {
    if (!computeAutoLayout5Macro) throw new Error("this build has no macro solve");
    res = computeAutoLayout5Macro(blankBoard, blankComps, defs, nets, asg, undefined, {
      pinCap: macroCap,
      seeds: 1,
      seedBase: seed,
      ...(moves ? { moves } : {}),
      ...(timeMs ? { timeBudgetMs: timeMs } : {}),
      ...(topTime ? { topTimeBudgetMs: topTime } : {}),
      ...(topMoves ? { topMoves } : {}),
      ...(levels ? { levels } : {}),
      ...(upperParts ? { upperPartCap: upperParts } : {}),
      ...(portCap ? { portCap } : {}),
      ...(macroGap !== undefined ? { clusterGap: macroGap } : {}),
      ...(minCompress ? { minCompress } : {}),
      ...(drilled ? { drilledCutsOnly: true } : {}),
      ...(noStack ? { noWireStacking: true } : {}),
      ...(exact ? { exactBest: true } : {}),
      onInfo: (info) => { stackInfo = info; },
    });
  } else if (stackCap) {
    if (!computeAutoLayout5Stack) throw new Error("this build has no stacked solve");
    res = computeAutoLayout5Stack(blankBoard, blankComps, defs, nets, asg, undefined, {
      pinCap: stackCap,
      seeds: 1,
      seedBase: seed,
      ...(moves ? { moves } : {}),
      ...(timeMs ? { timeBudgetMs: timeMs } : {}),
      ...(drilled ? { drilledCutsOnly: true } : {}),
      ...(noStack ? { noWireStacking: true } : {}),
      ...(exact ? { exactBest: true } : {}),
      ...(stackFree ? { freeWidth: true } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(protect ? { protectTies: true } : {}),
      ...wasmOpts,
      ...(moveLog ? { moveLog } : {}),
      onLeaves: (info) => { stackInfo = info; },
    });
  } else res = computeAutoLayout5(blankBoard, blankComps, defs, nets, asg, onProgress, {
    seedIndex: seed,
    ...(moves ? { moves } : {}),
    ...(moveLog ? { moveLog } : {}),
    ...(moveMix ? { moveMix } : {}),
    ...(sched ? { schedule: sched } : {}),
    ...(timeMs ? { timeBudgetMs: timeMs, onBudget: (b) => { budget = b; } } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(drilled ? { drilledCutsOnly: true } : {}),
    ...(noStack ? { noWireStacking: true } : {}),
    ...(exact ? { exactBest: true } : {}),
    ...(protect ? { protectTies: true } : {}),
    ...wasmOpts,
    ...(hint ? { msPerMoveHint: hint } : {}),
    ...(speedProbe ? { speedProbe, onSpeedProbe: (ms) => { process.stderr.write(`probeMs ${ms}\n`); } } : {}),
    debugSeeds: true,
    ...(dumpDir ? { onSkeleton: (s, sk) => { fs.mkdirSync(dumpDir, { recursive: true }); fs.writeFileSync(path.join(dumpDir, `${id}_s${s}.json`), JSON.stringify(sk)); } } : {}),
  });
} catch (err) {
  console.log(JSON.stringify({ id, seed, error: String(err && err.message ? err.message : err) }));
  process.exit(0);
}
console.log = origLog;
const ms = Date.now() - t0;
if (logGz) {
  logFlush();
  fs.closeSync(logGz);
}
const rate = rateResult(res, blankBoard, blankComps, defs, drilled);
const price = priceResult ? priceResult(res, blankBoard, expandOffBoard(blankComps, defs, asg).components, defs, drilled) : undefined;
// a fingerprint of the board itself, for bit-identical checks across refactors
const sig = require("crypto").createHash("sha1").update(JSON.stringify({
  size: res.boardSize,
  placements: [...res.placements].sort((a, b) => (a.componentId < b.componentId ? -1 : 1)),
  cuts: [...res.cuts].sort((a, b) => a.row - b.row || a.col - b.col || (a.kind < b.kind ? -1 : 1)),
  wires: [...res.wires].map((w) => [w.from.row, w.from.col, w.to.row, w.to.col]).sort(),
})).digest("hex").slice(0, 12);
const byId = new Map(res.placements.map((p) => [p.componentId, p]));
const solvedComps = blankComps.map((c) => {
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
  ...blankBoard,
  ...(res.boardSize ?? {}),
  cuts: res.cuts,
  wires: res.wires.map((w, i) => ({ id: `w${i}`, ...w })),
};
// the solved board as a project the editor can open: pads folded back onto
// their off-board parents, the board replaced, a name that says what it is
if (saveFile) {
  const { collapseLeads } = require(path.join(OUT, "components/stripboard/offBoard.js"));
  const positions = new Map(res.placements.map((p) => [p.componentId, p.boardPos]));
  const tag = stackCap ? `stack${stackCap}` : macroCap ? `macro${macroCap}` : "joint";
  const saved = {
    ...data,
    name: `${tag} of prod ${id} seed ${seed}`,
    components: collapseLeads(solvedComps, positions),
    board: { ...data.board, rows: solvedBoard.rows, cols: solvedBoard.cols, cuts: solvedBoard.cuts, wires: solvedBoard.wires, lockedRows: false, lockedCols: false },
    autoLayoutUsed: true,
  };
  fs.writeFileSync(saveFile, JSON.stringify(saved));
}
// measured as the editor sees the board: an off-board part is its pads, placed
// where the layouter put them (until 2026-09-28 the parents were measured, so
// every net through an off-board part counted as incomplete)
const view = expandOffBoard(blankComps, defs, asg);
const boardComps = view.components.map((c) => {
  const p = byId.get(c.id);
  return p ? { ...c, boardPos: p.boardPos, ...(p.rotation !== undefined ? { rotation: p.rotation } : {}), ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}) } : c;
});
const m = metrics(solvedBoard, boardComps, defs, nets, view.netAssignments);
// connectors: off any edge, or on an edge but reaching into the board
let connOff = 0, connIn = 0, knife = 0;
for (const c of boardComps) {
  const def = defs.find((x) => x.id === c.defId);
  if (!def || def.category !== "connector" || !c.boardPos || c.boardExcluded) continue;
  let minRow, maxRow, minCol, maxCol;
  if (def.flexible) { const e = c.flexibleEndPos ?? c.boardPos; minRow = Math.min(c.boardPos.row, e.row); maxRow = Math.max(c.boardPos.row, e.row); minCol = Math.min(c.boardPos.col, e.col); maxCol = Math.max(c.boardPos.col, e.col); }
  else { const b = getComponentBounds(def, c.boardPos, c.rotation ?? 0); minRow = b.minRow; maxRow = b.maxRow; minCol = b.minCol; maxCol = b.maxCol; }
  const w = maxCol - minCol + 1, h = maxRow - minRow + 1;
  const onL = minCol === 0, onR = maxCol === solvedBoard.cols - 1, onT = minRow === 0, onB = maxRow === solvedBoard.rows - 1;
  if (!(onL || onR || onT || onB)) connOff++;
  else if (!(((onL || onR) && h >= w) || ((onT || onB) && w >= h))) connIn++;
}
for (const cut of solvedBoard.cuts) if (cut.kind !== "hole") knife++;
const { wireStackDepth } = require(path.join(OUT, "components/stripboard/flexGeometry.js"));
const stacked = res.wires.filter((w, i) => wireStackDepth(w.from, w.to, res.wires.slice(0, i)) > 0).length;
const v = verify(solvedBoard, boardComps, nets, view.netAssignments, defs);
const geo = checkGeometry(solvedBoard, boardComps, defs).length;
console.log(JSON.stringify({
  id, seed, ms, rate, ...(price !== undefined ? { price } : {}), sig,
  ...(budget ? { budget } : {}),
  ...(decoded && !stackCap && !macroCap ? { decoded } : {}),
  ...(stackInfo ? { stack: stackInfo } : {}),
  quality: res.quality,
  rows: solvedBoard.rows, cols: solvedBoard.cols, area: solvedBoard.rows * solvedBoard.cols,
  wires: m.wires, offAxis: m.offAxisWires, crossings: m.crossings, stacked, cuts: m.cuts, knife, connOff, connIn,
  conflicts: v.conflicts, incomplete: v.incomplete.length ?? v.incomplete, geo,
  issues: res.issues,
}));
