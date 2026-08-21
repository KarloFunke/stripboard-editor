// Aggregate sweep results into the figures app/paper/data.ts cites.
//
//   node tests/solver/paperStats.js --results <dir> \
//     [--tidyoff TAG] [--single TAG] [--perm3 TAG] [--perm10 TAG] \
//     [--drilled TAG] [--locked-single TAG] [--locked-perm10 TAG] \
//     [--relax-adaptive TAG] [--relax-flat TAG]
//
// Tags name sweep files (sweep-<TAG>.json). Everything is computed on the
// paper's comparison subset: projects whose stored human board is complete
// and conflict-free. Prints the data.ts blocks; copy the values over by
// hand so nothing lands there unreviewed.
const path = require("path");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const resDir = argVal("results");
if (!resDir) {
  console.error("usage: node paperStats.js --results <dir> --perm10 TAG [...]");
  process.exit(1);
}
const load = (name) => {
  const tag = argVal(name);
  if (!tag) return null;
  return require(path.resolve(resDir, `sweep-${tag}.json`)).results;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (x) => Math.round(x * 100) / 100;
const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// The comparison subset, keyed off whichever run is present first
const anyRun = ["perm10", "single", "perm3", "tidyoff", "drilled"].map(load).find(Boolean);
if (!anyRun) {
  console.error("need at least one free-run tag");
  process.exit(1);
}
const subsetIds = anyRun
  .filter((r) => r.human.conflicts === 0 && r.human.incomplete === 0)
  .map((r) => r.id);
const idSet = new Set(subsetIds);
console.log(`subset n=${subsetIds.length}\n`);

const onSubset = (rows, side = "free") =>
  rows.filter((r) => idSet.has(r.id) && r[side] && !r[side].error).map((r) => ({ ...r, run: r[side] }));

const configOf = (rows) => {
  const runs = rows.map((r) => r.run);
  return {
    complete: runs.filter((f) => f.quality === 0).length,
    areaRatio: r2(median(rows.map((r) => r.run.area / r.human.area))),
    aspect: r2(median(runs.map((f) => f.aspect))),
    aspectOver3: runs.filter((f) => f.aspect > 3).length,
    offAxis: runs.reduce((s, f) => s + f.offAxisWires, 0),
    crossings: runs.reduce((s, f) => s + f.crossings, 0),
    wires: runs.reduce((s, f) => s + f.wires, 0),
    cuts: runs.reduce((s, f) => s + f.cuts, 0),
    betweenCuts: runs.reduce((s, f) => s + (f.betweenCuts ?? 0), 0),
    stack3plus: runs.filter((f) => (f.maxWireStack ?? 0) >= 3).length,
    stripCompletePct: median(runs.map((f) => f.stripCompletePct)),
    cleanBoards: runs.filter((f) => f.offAxisWires === 0 && f.crossings === 0).length,
    msMedian: Math.round(median(runs.map((f) => f.ms))),
  };
};

const named = {};
for (const name of ["tidyoff", "single", "perm3", "perm10", "drilled"]) {
  const rows = load(name);
  if (!rows) continue;
  named[name] = onSubset(rows);
  console.log(name, JSON.stringify(configOf(named[name])));
}

// HUMAN block, from any run's human side
{
  const rows = anyRun.filter((r) => idSet.has(r.id));
  const h = rows.map((r) => r.human);
  console.log(
    "\nHUMAN",
    JSON.stringify({
      aspect: r2(median(h.map((x) => x.aspect))),
      aspectOver3: h.filter((x) => x.aspect > 3).length,
      offAxis: h.reduce((s, x) => s + x.offAxisWires, 0),
      crossings: h.reduce((s, x) => s + x.crossings, 0),
      wires: h.reduce((s, x) => s + x.wires, 0),
      cuts: h.reduce((s, x) => s + x.cuts, 0),
      stripCompletePct: median(h.map((x) => x.stripCompletePct)),
      cleanBoards: h.filter((x) => x.offAxisWires === 0 && x.crossings === 0).length,
    })
  );
}

// SIZE_BANDS (current = single, portfolio = perm10)
if (named.single && named.perm10) {
  const p10ById = new Map(named.perm10.map((r) => [r.id, r]));
  console.log("\nSIZE_BANDS");
  for (const [lo, hi, label] of [[2, 5, "2-5"], [6, 10, "6-10"], [11, 15, "11-15"], [16, 25, "16-25"], [26, 60, "26-60"]]) {
    const rows = named.single.filter((r) => r.parts >= lo && r.parts <= hi);
    console.log(
      ` ${label} n=${rows.length}`,
      "current", r2(median(rows.map((r) => r.run.area / r.human.area))),
      "portfolio", r2(median(rows.map((r) => p10ById.get(r.id).run.area / r.human.area)))
    );
  }
}

// JOIN_BANDS at perm10
if (named.perm10) {
  console.log("\nJOIN_BANDS");
  for (const [lo, hi, label] of [[0, 0, "0"], [1, 4, "1-4"], [5, 10, "5-10"], [11, Infinity, "11+"]]) {
    const rows = named.perm10.filter((r) => r.netlist.rigidJoins >= lo && r.netlist.rigidJoins <= hi);
    console.log(
      ` ${label} n=${rows.length}`,
      "offAxis", rows.reduce((s, r) => s + r.run.offAxisWires, 0),
      "crossings", rows.reduce((s, r) => s + r.run.crossings, 0)
    );
  }
}

// PORTFOLIO_AB on solver area
const ab = (a, b) => {
  const bById = new Map(b.map((r) => [r.id, r]));
  let better = 0, same = 0, worse = 0;
  for (const r of a) {
    const x = bById.get(r.id);
    if (x.run.area < r.run.area) better++;
    else if (x.run.area === r.run.area) same++;
    else worse++;
  }
  return { better, same, worse };
};
if (named.single && named.perm3 && named.perm10) {
  console.log("\nPORTFOLIO_AB");
  console.log(" k3vsSingle", JSON.stringify(ab(named.single, named.perm3)));
  console.log(" k10vsK3", JSON.stringify(ab(named.perm3, named.perm10)));
  console.log(" k10vsSingle", JSON.stringify(ab(named.single, named.perm10)));
}

// LOCKED rows (locked side of locked sweeps)
for (const name of ["locked-single", "locked-perm10"]) {
  const rows = load(name);
  if (!rows) continue;
  const sub = onSubset(rows, "locked");
  console.log(`\n${name}`, JSON.stringify(configOf(sub)));
}

// RELAXED runs: config + per-project vs human + touched split
for (const name of ["relax-adaptive", "relax-flat"]) {
  const rows = load(name);
  if (!rows) continue;
  const sub = onSubset(rows);
  const ratios = sub.map((r) => r.run.area / r.human.area);
  const out = {
    areaRatio: r2(median(ratios)),
    q1: r2(quantile(ratios, 0.25)),
    q3: r2(quantile(ratios, 0.75)),
    smaller: sub.filter((r) => r.run.area < r.human.area).length,
    equal: sub.filter((r) => r.run.area === r.human.area).length,
    larger: sub.filter((r) => r.run.area > r.human.area).length,
    offAxis: sub.reduce((s, r) => s + r.run.offAxisWires, 0),
    crossings: sub.reduce((s, r) => s + r.run.crossings, 0),
    cleanBoards: sub.filter((r) => r.run.offAxisWires === 0 && r.run.crossings === 0).length,
  };
  if (name === "relax-adaptive" && named.perm10) {
    const p10ById = new Map(named.perm10.map((r) => [r.id, r]));
    const touched = sub.filter((r) => (r.relaxedDefs ?? 0) > 0);
    out.touchedN = touched.length;
    out.touchedMedian = r2(median(touched.map((r) => r.run.area / r.human.area)));
    out.touchedMedianBaseline = r2(median(touched.map((r) => p10ById.get(r.id).run.area / r.human.area)));
    out.touchedHumanSmaller = touched.filter((r) => r.run.area > r.human.area).length;
    out.touchedHumanSmallerBaseline = touched.filter((r) => p10ById.get(r.id).run.area > r.human.area).length;
  }
  console.log(`\n${name}`, JSON.stringify(out));
}

// RUNTIME from the single run
if (named.single) {
  const ms = named.single.map((r) => r.run.ms);
  console.log(
    "\nRUNTIME",
    JSON.stringify({ medianMs: Math.round(median(ms)), p90Ms: quantile(ms, 0.9), maxMs: Math.max(...ms) })
  );
}
