// One v5 solve of one corpus project for one seed; prints a JSON line.
//   node tests/solver/v5Solve.js --data <dir> --id <n> --seed <k> --moves <m> [--out <compiled dir>]
//        [--movelog <dir>]   one gzipped CSV of every anneal proposal per id/seed
//        [--time <ms>]       wall-time budget per seed instead of --moves
//        [--drilled 1]       drilled cuts only
//        [--nostack 1]       no wire stacking
//        [--exact 1]         finish every new best of the walk exactly and keep the cheapest
//        [--dump <dir>]      store the seed's skeleton (the anneal's placement and wiring) as <dir>/<id>_s<seed>.json
//        [--skeleton <file>] skip the anneal: run the finish alone on a stored skeleton
//        [--repair 0|1|2]    with --skeleton: router only (0), the decoder's board routed again when not clean (1)
//                            or as is (2); without the flag both finishes run and the cheaper board wins, as the editor does
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
const { rateResult } = require(path.join(OUT, "components/stripboard/autoLayout2.js"));
// the shared price (layout2/boardPrice) only exists in builds from 2026-09-24 on
const priceResult = (() => { try { return require(path.join(OUT, "components/stripboard/layout2/boardPrice.js")).priceResult; } catch { return undefined; } })();
const { expandOffBoard } = require(path.join(OUT, "components/stripboard/offBoard.js"));

const dataDir = argVal("data");
const id = Number(argVal("id"));
const seed = Number(argVal("seed") ?? 0);
const moves = argVal("moves") ? Number(argVal("moves")) : undefined;
const moveLogDir = argVal("movelog");
const cutAware = argVal("cutaware") === "1";
const sched = argVal("sched") ? JSON.parse(argVal("sched")) : undefined;
const timeMs = argVal("time") ? Number(argVal("time")) : undefined;
const drilled = argVal("drilled") === "1";
const noStack = argVal("nostack") === "1";
const exact = argVal("exact") === "1";
const dumpDir = argVal("dump");
const skeletonFile = argVal("skeleton");
const repair = argVal("repair") === "1" ? "fallback" : argVal("repair") === "2" ? "only" : argVal("repair") === "0" ? "never" : undefined;
const hint = argVal("hint") ? Number(argVal("hint")) : undefined;
const { getComponentBounds } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
let budget;
// The log is written as the run goes, in blocks, through one gzip stream:
// a full anneal is millions of proposals and keeping them all in memory
// cost about 2 GB per worker on a big board, which 12 workers cannot afford.
let logBuf = [];
let logGz = null;
const logFlush = () => {
  if (!logGz || logBuf.length === 0) return;
  logGz.write(logBuf.join("\n") + "\n");
  logBuf = [];
};
const moveLog = moveLogDir
  ? (r) => {
      if (!logGz) {
        fs.mkdirSync(moveLogDir, { recursive: true });
        logGz = require("zlib").createGzip();
        logGz.pipe(fs.createWriteStream(path.join(moveLogDir, `${id}_s${seed}.csv.gz`)));
      }
      logBuf.push(
        r.out < 2
          ? `${id},${seed},${r.it},${r.kind},${r.out},,,,,,,,,,,,,,,,,`
          : `${id},${seed},${r.it},${r.kind},${r.out},${r.best},${r.same},${r.dEcur.toFixed(2)},${r.dEfin.toFixed(2)},${r.curFin.toFixed(2)},` +
            `${r.dArea},${r.dWires},${r.dWlen},${r.dCuts},${r.dBcuts},${r.dMess},${r.dHard},${r.dStarv},${r.dOther.toFixed(2)},${r.dGeo},${r.dOverlap},${r.dStarvH}`
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
  } else res = computeAutoLayout5(blankBoard, blankComps, defs, nets, asg, undefined, {
    seedIndex: seed,
    ...(moves ? { moves } : {}),
    ...(moveLog ? { moveLog } : {}),
    ...(cutAware ? { cutAwareScan: true } : {}),
    ...(sched ? { schedule: sched } : {}),
    ...(timeMs ? { timeBudgetMs: timeMs, onBudget: (b) => { budget = b; } } : {}),
    ...(drilled ? { drilledCutsOnly: true } : {}),
    ...(noStack ? { noWireStacking: true } : {}),
    ...(exact ? { exactBest: true } : {}),
    ...(hint ? { msPerMoveHint: hint } : {}),
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
  logGz.end();
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
const m = metrics(solvedBoard, solvedComps, defs, nets, asg);
// connectors: off any edge, or on an edge but reaching into the board
let connOff = 0, connIn = 0, knife = 0;
for (const c of solvedComps) {
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
const v = verify(solvedBoard, solvedComps, nets, asg, defs);
const geo = checkGeometry(solvedBoard, solvedComps, defs).length;
console.log(JSON.stringify({
  id, seed, ms, rate, ...(price !== undefined ? { price } : {}), sig,
  ...(budget ? { budget } : {}),
  ...(decoded ? { decoded } : {}),
  quality: res.quality,
  rows: solvedBoard.rows, cols: solvedBoard.cols, area: solvedBoard.rows * solvedBoard.cols,
  wires: m.wires, offAxis: m.offAxisWires, crossings: m.crossings, stacked, cuts: m.cuts, knife, connOff, connIn,
  conflicts: v.conflicts, incomplete: v.incomplete.length ?? v.incomplete, geo,
  issues: res.issues,
}));
