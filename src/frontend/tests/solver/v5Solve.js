// One v5 solve of one corpus project for one seed; prints a JSON line.
//   node tests/solver/v5Solve.js --data <dir> --id <n> --seed <k> --moves <m> [--out <compiled dir>]
//        [--movelog <dir>]   one gzipped CSV of every anneal proposal per id/seed
//        [--time <ms>]       wall-time budget per seed instead of --moves
//        [--drilled 1]       drilled cuts only
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
const { computeAutoLayout5 } = require(path.join(OUT, "components/stripboard/autoLayout5.js"));
const { rateResult } = require(path.join(OUT, "components/stripboard/autoLayout2.js"));

const dataDir = argVal("data");
const id = Number(argVal("id"));
const seed = Number(argVal("seed") ?? 0);
const moves = argVal("moves") ? Number(argVal("moves")) : undefined;
const moveLogDir = argVal("movelog");
const cutAware = argVal("cutaware") === "1";
const sched = argVal("sched") ? JSON.parse(argVal("sched")) : undefined;
const timeMs = argVal("time") ? Number(argVal("time")) : undefined;
const drilled = argVal("drilled") === "1";
const hint = argVal("hint") ? Number(argVal("hint")) : undefined;
const { getComponentBounds } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
let budget;
const logRows = [];
const moveLog = moveLogDir
  ? (r) => {
      logRows.push(
        r.out < 2
          ? `${id},${seed},${r.it},${r.kind},${r.out},,,,,,,,,,,,,,,,,`
          : `${id},${seed},${r.it},${r.kind},${r.out},${r.best},${r.same},${r.dEcur.toFixed(2)},${r.dEfin.toFixed(2)},${r.curFin.toFixed(2)},` +
            `${r.dArea},${r.dWires},${r.dWlen},${r.dCuts},${r.dBcuts},${r.dMess},${r.dHard},${r.dStarv},${r.dOther.toFixed(2)},${r.dGeo},${r.dOverlap},${r.dStarvH}`
      );
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
let res;
try {
  res = computeAutoLayout5(blankBoard, blankComps, defs, nets, asg, undefined, {
    seedIndex: seed,
    ...(moves ? { moves } : {}),
    ...(moveLog ? { moveLog } : {}),
    ...(cutAware ? { cutAwareScan: true } : {}),
    ...(sched ? { schedule: sched } : {}),
    ...(timeMs ? { timeBudgetMs: timeMs, onBudget: (b) => { budget = b; } } : {}),
    ...(drilled ? { drilledCutsOnly: true } : {}),
    ...(hint ? { msPerMoveHint: hint } : {}),
  });
} catch (err) {
  console.log(JSON.stringify({ id, seed, error: String(err && err.message ? err.message : err) }));
  process.exit(0);
}
const ms = Date.now() - t0;
if (moveLogDir) {
  fs.mkdirSync(moveLogDir, { recursive: true });
  fs.writeFileSync(path.join(moveLogDir, `${id}_s${seed}.csv.gz`), require("zlib").gzipSync(logRows.join("\n") + "\n"));
}
const rate = rateResult(res, blankBoard, blankComps, defs, drilled);
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
const v = verify(solvedBoard, solvedComps, nets, asg, defs);
const geo = checkGeometry(solvedBoard, solvedComps, defs).length;
console.log(JSON.stringify({
  id, seed, ms, rate,
  ...(budget ? { budget } : {}),
  quality: res.quality,
  rows: solvedBoard.rows, cols: solvedBoard.cols, area: solvedBoard.rows * solvedBoard.cols,
  wires: m.wires, offAxis: m.offAxisWires, crossings: m.crossings, cuts: m.cuts, knife, connOff, connIn,
  conflicts: v.conflicts, incomplete: v.incomplete.length ?? v.incomplete, geo,
  issues: res.issues,
}));
