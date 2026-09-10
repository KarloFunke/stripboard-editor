// Benchmark harness for the experimental v3 annealed layouter.
//
//   node tests/solver/annealRun.js --data <dir> [--ids 615,616] [--seeds K] [--moves N]
//                                  [--ref <sweep tag>] [--no-finisher] [--geometry]
//
// Each project runs from a blank board through computeAutoLayout3 for seeds
// 0..K-1 (default 1); the best seed (quality, then rateResult) is reported.
// --ref names a sweep results file (results/sweep-<tag>.json) whose free run
// is printed beside the v3 result for comparison. --geometry runs the
// helpers.js geometric invariant check on every seed's board (decoder test).
const fs = require("fs");
const path = require("path");
const { metrics } = require("./metricsLib.js");
const { DEFAULT_COMPONENTS, checkGeometry } = require("./helpers.js");
const OUT = path.join(__dirname, "out");
const { computeAutoLayout3 } = require(path.join(OUT, "components/stripboard/autoLayout3.js"));
const { rateResult } = require(path.join(OUT, "components/stripboard/autoLayout2.js"));

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = argVal("data");
if (!dataDir) {
  console.error("usage: node annealRun.js --data <dir> [--ids 1,2] [--seeds K] [--moves N] [--ref tag]");
  process.exit(1);
}
const seedsN = Number(argVal("seeds") ?? 1);
const movesOpt = argVal("moves") ? Number(argVal("moves")) : undefined;
const noFinisher = args.includes("--no-finisher");
const wireCostOpt = argVal("wire-cost") ? Number(argVal("wire-cost")) : undefined;
const checkGeo = args.includes("--geometry");
const refTag = argVal("ref");

const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;
const entries = index.filter(
  (e) => (!onlyIds || onlyIds.has(e.id)) && e.unresolvedDefs === 0 && !(e.shortedDefs > 0)
);

let refById = new Map();
if (refTag) {
  const ref = JSON.parse(
    fs.readFileSync(path.join(dataDir, "results", `sweep-${refTag}.json`), "utf8")
  );
  refById = new Map(ref.results.map((r) => [r.id, r]));
}

const applyResult = (board, comps, res) => {
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
  return { solvedBoard, solvedComps };
};

const summary = [];
for (const entry of entries) {
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, "projects", `${entry.id}.json`), "utf8"));
  const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
  const nets = data.nets ?? [];
  const asg = data.netAssignments ?? [];
  const humanBoard = data.board;
  const blankComps = data.components.map((c) => ({
    ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined,
  }));
  const blankBoard = { ...humanBoard, cuts: [], wires: [], lockedRows: false, lockedCols: false };

  let best = null;
  for (let seed = 0; seed < seedsN; seed++) {
    const t0 = Date.now();
    let res;
    try {
      res = computeAutoLayout3(blankBoard, blankComps, defs, nets, asg, undefined, {
        seed,
        ...(movesOpt ? { moves: movesOpt } : {}),
        ...(noFinisher ? { finisher: false } : {}),
        ...(wireCostOpt !== undefined ? { wireCost: wireCostOpt } : {}),
      });
    } catch (err) {
      console.log(`id ${entry.id} seed ${seed}: ERROR ${err && err.message ? err.message : err}`);
      continue;
    }
    const ms = Date.now() - t0;
    const rate = rateResult(res, blankBoard, blankComps, defs, false);
    const { solvedBoard, solvedComps } = applyResult(blankBoard, blankComps, res);
    const m = metrics(solvedBoard, solvedComps, defs, nets, asg);
    let geoProblems = [];
    if (checkGeo) geoProblems = checkGeometry(solvedBoard, solvedComps, defs);
    const row = {
      seed, ms, rate,
      quality: res.quality,
      rows: solvedBoard.rows, cols: solvedBoard.cols,
      area: solvedBoard.rows * solvedBoard.cols,
      wires: m.wires, offAxis: m.offAxisWires, crossings: m.crossings,
      cuts: m.cuts, bands: res.tiles, geoProblems,
    };
    console.log(
      `id ${entry.id} seed ${seed}: ${row.rows}x${row.cols}=${row.area} q${row.quality}` +
        ` wires ${row.wires} offAxis ${row.offAxis} cross ${row.crossings} rate ${rate.toFixed(1)}` +
        ` ${(ms / 1000).toFixed(1)}s` +
        (geoProblems.length ? `  GEOMETRY: ${geoProblems.length} problems` : "")
    );
    if (geoProblems.length) for (const p of geoProblems.slice(0, 5)) console.log(`    ${p}`);
    if (!best || row.quality < best.quality || (row.quality === best.quality && row.rate < best.rate)) {
      best = row;
    }
  }
  if (!best) continue;

  const ref = refById.get(entry.id);
  const h = { rows: humanBoard.rows, cols: humanBoard.cols, area: humanBoard.rows * humanBoard.cols };
  let line =
    `id ${entry.id} (${entry.parts}p) BEST seed ${best.seed}: ${best.rows}x${best.cols}=${best.area}` +
    ` q${best.quality} wires ${best.wires} offAxis ${best.offAxis} cross ${best.crossings}` +
    `  | human ${h.rows}x${h.cols}=${h.area} (${(best.area / h.area).toFixed(2)}x)`;
  if (ref && ref.free && !ref.free.error) {
    line +=
      `  | v2[${refTag}] ${ref.free.rows}x${ref.free.cols}=${ref.free.area} q${ref.free.quality}` +
      ` wires ${ref.free.wires} offAxis ${ref.free.offAxisWires} cross ${ref.free.crossings}`;
  }
  console.log(line);
  summary.push({ id: entry.id, parts: entry.parts, best, human: h, ref: ref?.free });
}

if (summary.length > 1) {
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const q0 = summary.filter((s) => s.best.quality === 0);
  console.log(`\n${summary.length} projects, quality 0: ${q0.length}`);
  console.log(`median area vs human  ${median(q0.map((s) => s.best.area / s.human.area)).toFixed(2)}x`);
  const withRef = q0.filter((s) => s.ref && !s.ref.error && s.ref.quality === 0);
  if (withRef.length) {
    console.log(`median area vs v2     ${median(withRef.map((s) => s.best.area / s.ref.area)).toFixed(2)}x  (${withRef.length} projects)`);
    console.log(`offAxis total         v3 ${withRef.reduce((n, s) => n + s.best.offAxis, 0)}  v2 ${withRef.reduce((n, s) => n + s.ref.offAxisWires, 0)}`);
    console.log(`crossings total       v3 ${withRef.reduce((n, s) => n + s.best.crossings, 0)}  v2 ${withRef.reduce((n, s) => n + s.ref.crossings, 0)}`);
    console.log(`wires total           v3 ${withRef.reduce((n, s) => n + s.best.wires, 0)}  v2 ${withRef.reduce((n, s) => n + s.ref.wires, 0)}`);
  }
  console.log(`median solve ms       ${median(summary.map((s) => s.best.ms))}`);
}
