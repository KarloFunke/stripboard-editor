// One v5 solve of one corpus project for one seed; prints a JSON line.
//   node tests/solver/v5Solve.js --data <dir> --id <n> --seed <k> --moves <m> [--out <compiled dir>]
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
  });
} catch (err) {
  console.log(JSON.stringify({ id, seed, error: String(err && err.message ? err.message : err) }));
  process.exit(0);
}
const ms = Date.now() - t0;
const rate = rateResult(res, blankBoard, blankComps, defs, false);
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
const v = verify(solvedBoard, solvedComps, nets, asg, defs);
const geo = checkGeometry(solvedBoard, solvedComps, defs).length;
console.log(JSON.stringify({
  id, seed, ms, rate,
  quality: res.quality,
  rows: solvedBoard.rows, cols: solvedBoard.cols, area: solvedBoard.rows * solvedBoard.cols,
  wires: m.wires, offAxis: m.offAxisWires, crossings: m.crossings, cuts: m.cuts,
  conflicts: v.conflicts, incomplete: v.incomplete.length ?? v.incomplete, geo,
  issues: res.issues,
}));
