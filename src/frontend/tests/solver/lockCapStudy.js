// Cluster-cap study for LOCKED layouts: do small projects with pinned parts
// come out better on fewer tiles, or even a single one?
//
//   node tests/solver/lockCapStudy.js --data <dir> [--max-parts 20] [--caps 2-20]
//                                     [--perms 10] [--arms both|width|nowidth]
//                                     [--pilot 20] [--jobs N] [--cap-timeout 45]
//                                     [--no-default] [--report-only]
//
// Each cap runs one sweep, locking every connector at its human position.
// Two arms: "width" also holds the board to the human's column count (the
// realistic case), "nowidth" leaves both dimensions free. The arms matter
// because the cluster cap only BOUNDS the tile count — clusterPlanning
// splits a tile again whenever it does not fit the dimension limits, so a
// locked width forces splits the cap cannot undo. Every row therefore
// records the tile count actually produced, and the report analyses against
// that rather than against the cap.
//
// Permutations are seeded by index alone, independently of the cap, so every
// cap sees the same orderings and the comparison is paired per project.
//
// Caps run in an information-first order (6, 5, 8, 4, 10, 3, ...), so an
// interrupted study still leaves a coarse curve. A cap whose results file
// exists is skipped: rerun the same command to resume. The report is written
// after every cap and can be read while the study is still running.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = argVal("data");
if (!dataDir) {
  console.error("usage: node lockCapStudy.js --data <dir> [--max-parts 20] [--caps 2-20] [--perms 10] [--arms both|width|nowidth] [--report-only]");
  process.exit(1);
}
const perms = Number(argVal("perms") ?? 10);
const maxParts = Number(argVal("max-parts") ?? 0);
const jobs = argVal("jobs");
const capTimeoutMin = Number(argVal("cap-timeout") ?? 45);
const pilotN = Number(argVal("pilot") ?? 0);
const armsArg = argVal("arms") ?? "both";
const ARMS = armsArg === "both" ? ["width", "nowidth"] : [armsArg];
const resDir = path.join(dataDir, "results");

// --caps takes a range ("2-20") or an explicit list ("2,4,6,8,12,20")
const capsArg = argVal("caps") ?? "2-20";
const wanted = capsArg.includes("-")
  ? (() => {
      const [lo, hi] = capsArg.split("-").map(Number);
      return new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    })()
  : new Set(capsArg.split(",").map(Number));

// Coarse-to-fine: a half-finished study still spans the range.
const CAP_ORDER = [6, 5, 8, 4, 10, 3, 12, 7, 2, 14, 9, 16, 11, 18, 13, 20, 15, 17, 19];
const caps = [...CAP_ORDER.filter((c) => wanted.has(c)), ...[...wanted].filter((c) => !CAP_ORDER.includes(c)).sort((a, b) => a - b)];

// Settings that change the numbers all live in the tag, so a rerun with
// different options starts a fresh set instead of silently mixing them.
const tagOf = (arm, cap) =>
  `connlock-p${perms}${maxParts ? `-le${maxParts}` : ""}-${arm === "width" ? "w" : "f"}-c${cap === "def" ? "def" : String(cap).padStart(2, "0")}`;
const fileOf = (arm, cap) => path.join(resDir, `sweep-${tagOf(arm, cap)}.json`);

const sweepArgs = (arm, cap, extra = []) => [
  path.join(__dirname, "sweep.js"),
  "--data", dataDir,
  "--tag", tagOf(arm, cap),
  "--lock-connectors",
  "--only-locked",
  "--require-connector",
  "--tidy", "unlimited",
  "--perms", String(perms),
  ...(arm === "width" ? ["--lock-width"] : []),
  ...(maxParts ? ["--max-parts", String(maxParts)] : []),
  ...(cap === "def" ? [] : ["--max-cluster", String(cap)]),
  ...(jobs ? ["--jobs", jobs] : []),
  ...extra,
];

const hhmm = (ms) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// One number per finished board, in the solver's own currency: a cell of
// board, a hole of wire, a whole board line per slanted wire, and the
// crossing price the router itself pays.
const scoreOf = (l) => l.area + l.wireLen + Math.max(l.rows, l.cols) * l.offAxisWires + 8 * l.crossings;

// ── Pilot: time a sample, extrapolate the matrix ─────────────
if (pilotN > 0) {
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8")).filter((e) => !maxParts || e.parts <= maxParts);
  // Sample evenly across the size distribution: solve time is dominated by
  // the big projects, so a head-of-index sample underestimates badly.
  const bySize = [...index].sort((a, b) => a.parts - b.parts);
  const step = bySize.length / pilotN;
  const sample = Array.from({ length: pilotN }, (_, i) => bySize[Math.min(bySize.length - 1, Math.round(i * step))]);
  console.log(`pilot: ${pilotN} projects at cap 6, perms ${perms}, spread over ${sample[0].parts}-${sample[sample.length - 1].parts} parts\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, sweepArgs(ARMS[0], "pilot", ["--ids", sample.map((e) => e.id).join(",")]), { stdio: "inherit" });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    console.error(`pilot FAILED (exit ${r.status})`);
    process.exit(1);
  }
  const swept = JSON.parse(fs.readFileSync(fileOf(ARMS[0], "pilot"), "utf8")).results.length;
  const perProject = ms / Math.max(1, swept);
  // ~74% of the small-project set has a connector to lock
  const full = perProject * index.length * 0.74;
  const weight = caps.reduce((s, c) => s + Math.max(1, c / 6), 0) + (args.includes("--no-default") ? 0 : 1);
  console.log(`\n── pilot result ──`);
  console.log(`sample            ${swept} projects in ${(ms / 1000).toFixed(0)}s (${(perProject / 1000).toFixed(1)}s/project)`);
  console.log(`one cap, full set ~${hhmm(full)}`);
  console.log(`${caps.length} caps x ${ARMS.length} arm(s)${args.includes("--no-default") ? "" : " + default"}  ~${hhmm(full * weight * ARMS.length)}`);
  fs.unlinkSync(fileOf(ARMS[0], "pilot"));
  process.exit(0);
}

// ── Report ──────────────────────────────────────────────────
function reportArm(arm) {
  const loaded = [];
  for (const cap of [...caps, ...(args.includes("--no-default") ? [] : ["def"])]) {
    if (!fs.existsSync(fileOf(arm, cap))) continue;
    const j = JSON.parse(fs.readFileSync(fileOf(arm, cap), "utf8"));
    loaded.push({ cap, rows: j.results });
  }
  if (!loaded.length) return null;
  loaded.sort((a, b) => (a.cap === "def" ? 1 : b.cap === "def" ? -1 : a.cap - b.cap));

  console.log(`\n━━ ${arm === "width" ? "connectors + width locked" : "connectors locked, board free"} — ${loaded.length} caps ━━`);
  console.log("cap   n   q0  tiles  1-tile  area/human  wires  offAx  cross   score    ms");
  const perCap = [];
  for (const { cap, rows } of loaded) {
    const ok = rows.filter((r) => r.locked && !r.locked.error);
    const q0 = ok.filter((r) => r.locked.quality === 0);
    const rec = {
      cap,
      n: rows.length,
      q0: q0.length,
      tiles: median(q0.map((r) => r.locked.tiles ?? 0)),
      oneTile: q0.filter((r) => r.locked.tiles === 1).length,
      area: median(q0.map((r) => r.locked.area / r.human.area)),
      wires: sum(q0.map((r) => r.locked.wires)),
      offAxis: sum(q0.map((r) => r.locked.offAxisWires)),
      crossings: sum(q0.map((r) => r.locked.crossings)),
      score: median(q0.map((r) => scoreOf(r.locked))),
      ms: median(ok.map((r) => r.locked.ms)),
    };
    perCap.push(rec);
    console.log(
      `${String(cap).padStart(3)} ${String(rec.n).padStart(4)} ${String(rec.q0).padStart(4)} ${String(rec.tiles).padStart(6)} ` +
        `${String(rec.oneTile).padStart(7)} ${rec.area.toFixed(2).padStart(10)}x ${String(rec.wires).padStart(6)} ` +
        `${String(rec.offAxis).padStart(6)} ${String(rec.crossings).padStart(6)} ${String(Math.round(rec.score)).padStart(7)} ${String(Math.round(rec.ms)).padStart(6)}`
    );
  }

  // Every (project, cap) observation, with the score normalised by that
  // project's own best so projects of different sizes can be pooled.
  const obs = [];
  const byProject = new Map();
  for (const { cap, rows } of loaded) {
    for (const r of rows) {
      if (!r.locked || r.locked.error || r.locked.quality !== 0 || r.locked.tiles === undefined) continue;
      const o = { id: r.id, parts: r.parts, frac: r.locked.lockedFrac, cap, tiles: r.locked.tiles, score: scoreOf(r.locked) };
      obs.push(o);
      const p = byProject.get(r.id) ?? { id: r.id, parts: r.parts, best: null, min: Infinity, minTiles: Infinity, maxTiles: 0 };
      if (o.score < p.min) {
        p.min = o.score;
        p.best = o;
      }
      p.minTiles = Math.min(p.minTiles, o.tiles);
      p.maxTiles = Math.max(p.maxTiles, o.tiles);
      byProject.set(r.id, p);
    }
  }
  for (const o of obs) o.rel = o.score / byProject.get(o.id).min;

  // THE hypothesis test: pooled across projects, does the board get worse as
  // stage 1 cuts it into more tiles?
  if (loaded.length < 2) {
    console.log(`\n  (one cap loaded — the normalised tables need at least two to say anything)`);
    return { arm, perCap, projects: [] };
  }
  console.log(`\n  score by tiles produced (1.00 = that project's best over all caps)`);
  const tileBuckets = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 99]];
  for (const [lo, hi] of tileBuckets) {
    const inB = obs.filter((o) => o.tiles >= lo && o.tiles <= hi);
    if (!inB.length) continue;
    const label = lo === hi ? `${lo} tile${lo > 1 ? "s" : ""}` : hi === 99 ? `${lo}+ tiles` : `${lo}-${hi} tiles`;
    const wins = inB.filter((o) => o.rel < 1.0001).length;
    console.log(`  ${label.padEnd(10)} n=${String(inB.length).padStart(4)}  median ${median(inB.map((o) => o.rel)).toFixed(3)}  best-of-project ${wins}`);
  }

  const projects = [...byProject.values()].filter((p) => p.best);
  const table = (title, buckets, keyOf) => {
    console.log(`\n  best result by ${title}`);
    for (const [lo, hi, label] of buckets) {
      const inB = projects.filter((p) => keyOf(p) >= lo && keyOf(p) <= hi);
      if (!inB.length) continue;
      const hist = new Map();
      for (const p of inB) hist.set(p.best.cap, (hist.get(p.best.cap) ?? 0) + 1);
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      // Distance from the project's OWN fewest-tiles result: 0 means the best
      // board was also its most-merged one. Immune to the size confound,
      // unlike pooling raw tile counts across projects.
      const spread = inB.filter((p) => p.maxTiles > p.minTiles);
      const atMin = spread.filter((p) => p.best.tiles === p.minTiles).length;
      console.log(
        `  ${label.padEnd(12)} n=${String(inB.length).padStart(3)}  median tiles at best ${median(inB.map((p) => p.best.tiles))}` +
          `  best at own fewest tiles ${atMin}/${spread.length}` +
          `  top caps: ${top.map(([c, n]) => `${c}(${n})`).join(" ")}`
      );
    }
  };
  table("project size", [[2, 5, "2-5 parts"], [6, 10, "6-10"], [11, 15, "11-15"], [16, 19, "16-19"], [20, 99, "20+"]], (p) => p.parts);
  return { arm, perCap, projects: projects.map((p) => ({ id: p.id, parts: p.parts, bestCap: p.best.cap, bestTiles: p.best.tiles, bestScore: p.min })) };
}

function report() {
  const out = ARMS.map(reportArm).filter(Boolean);
  if (!out.length) {
    console.log("no results yet");
    return;
  }
  const outFile = path.join(resDir, `lock-cap-study-summary${maxParts ? `-le${maxParts}` : ""}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), perms, maxParts, arms: out }, null, 1));
  console.log(`\nsummary → ${outFile}`);
}

if (args.includes("--report-only")) {
  report();
  process.exit(0);
}

// ── Run ─────────────────────────────────────────────────────
const todo = [];
for (const arm of ARMS) for (const cap of [...caps, ...(args.includes("--no-default") ? [] : ["def"])]) todo.push({ arm, cap });
console.log(`lock cap study | caps ${caps.join(" ")} | perms ${perms} | arms ${ARMS.join(",")}${maxParts ? ` | parts <= ${maxParts}` : ""}`);
console.log(`locking every connector at its human position; ${todo.length} sweeps, ${capTimeoutMin}min timeout each\n`);

const started = Date.now();
let doneN = 0;
for (const { arm, cap } of todo) {
  if (fs.existsSync(fileOf(arm, cap))) {
    console.log(`${arm} cap ${cap}: results exist, skipping`);
    doneN++;
    continue;
  }
  const eta = doneN > 0 ? `  eta ${hhmm(((Date.now() - started) / doneN) * (todo.length - doneN))}` : "";
  console.log(`\n━━ ${arm} cap ${cap}  (${doneN + 1}/${todo.length}, elapsed ${hhmm(Date.now() - started)}${eta}) ━━`);
  const r = spawnSync(process.execPath, sweepArgs(arm, cap), { stdio: "inherit", timeout: capTimeoutMin * 60000 });
  if (r.status !== 0) {
    console.error(`${arm} cap ${cap} ${r.signal === "SIGTERM" ? `TIMED OUT after ${capTimeoutMin}min` : `FAILED (exit ${r.status})`} — continuing, rerun to retry`);
    if (fs.existsSync(fileOf(arm, cap))) fs.unlinkSync(fileOf(arm, cap));
    continue;
  }
  doneN++;
  report();
}
console.log(`\nstudy finished in ${hhmm(Date.now() - started)}`);
report();
