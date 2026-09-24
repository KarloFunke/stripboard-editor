// v5 corpus run with per-seed fan-out (frozen protocol: seeds 6, 10 at
// >=25 parts, 12 at >=40; moves min(160k, max(60k, 3200*parts)), floor 40k at <=8 parts).
//   node tests/solver/v5Corpus.js --data <dir> --name <tag> [--ids 1,2] [--seeds 6]
//        [--moves 60000] [--workers 14] [--out <compiled dir>] [--movelog <dir>]
//        [--movesmul 2] (budget experiments) [--seedsmax 6] (cap the size-scaled seed count)
//        [--enginemoves 1] (no --moves: the engine's own default budget)
//        [--movecap <n>]   (with --enginemoves: hold that budget under a ceiling)
//        [--time <ms>] (wall-time budget per seed; implies no --moves)
//        [--drilled 1] (drilled cuts only)
//        [--nostack 1] (no wire stacking)
//        [--exact 1] (exact pick among the walk's bests, see v5Solve)
//        [--dump <dir>] (store every seed's skeleton, see v5Solve)
//        [--skipdumped 1] (resume: leave out the seeds whose skeleton is already in --dump)
//        [--skeletons <dir>] (finish only: replay the stored skeletons; a project runs the seeds it has there)
//        [--repair 1|2] (with --skeletons: the decoder's board, routed again when not clean (1) or as is (2))
//        [--hintfrom <results json>] (per project, the median decode speed of that run's seeds becomes
//                                    --hint, so a --time budget repeats that run's move counts exactly)
//        [--perproject 1] (one project at a time, its seeds in parallel: the UI's shape, so each
//                          project's wall time is what a user waits)
// Results: <dir>/results/v5-<tag>.json
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = argVal("data");
const name = argVal("name");
if (!dataDir || !name) {
  console.error("usage: node v5Corpus.js --data <dir> --name <tag> [--ids] [--seeds] [--moves] [--workers] [--out]");
  process.exit(1);
}
const seedsBase = Number(argVal("seeds") ?? 6);
const movesBase = Number(argVal("moves") ?? 60000);
const workers = Number(argVal("workers") ?? 14);
const outDir = argVal("out");
const moveLogDir = argVal("movelog");
const cutAware = argVal("cutaware") === "1";
const sched = argVal("sched");
const movesMul = Number(argVal("movesmul") ?? 1);
const seedsMax = Number(argVal("seedsmax") ?? 99);
const timeMs = argVal("time");
const engineMoves = argVal("enginemoves") === "1" || !!timeMs;
// With --enginemoves, hold the engine's own budget under a ceiling: the
// uncapped budget is 1.28M moves on a big board, which a whole-corpus run
// cannot afford. Passing the count explicitly also makes the run repeatable.
const moveCap = argVal("movecap") ? Number(argVal("movecap")) : undefined;
const cappedMoves = (e) => Math.min(moveCap, Math.max(40000, 16000 * (e.assignments - 13)));
const drilled = argVal("drilled") === "1";
const noStack = argVal("nostack") === "1";
const exactBest = argVal("exact") === "1";
const perProject = argVal("perproject") === "1";
const dumpDir = argVal("dump");
const skipDumped = argVal("skipdumped") === "1" && !!dumpDir;
const skeletonDir = argVal("skeletons");
const hintFrom = argVal("hintfrom");
const repairMode = argVal("repair");
const hintOf = new Map();
if (hintFrom) {
  for (const r of JSON.parse(fs.readFileSync(hintFrom, "utf8")).results) {
    const v = (r.seeds ?? []).map((s) => s.budget?.msPerMove).filter((x) => x > 0).sort((a, b) => a - b);
    if (v.length) hintOf.set(r.id, v[Math.floor(v.length / 2)]);
  }
}
const skeletonOf = (id, seed) => (skeletonDir ? path.join(skeletonDir, `${id}_s${seed}.json`) : undefined);
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;
const entries = index.filter(
  (e) => (!onlyIds || onlyIds.has(e.id)) && e.unresolvedDefs === 0 && !(e.shortedDefs > 0)
);

const projSeeds = (parts) => Math.min(seedsMax, Math.max(seedsBase, parts >= 40 ? 12 : parts >= 25 ? 10 : 0));
const projMoves = (parts) => Math.round(movesMul * Math.min(160000, Math.max(parts <= 8 ? Math.min(movesBase, 40000) : movesBase, 3200 * parts)));
const jobQueue = [];
for (const e of entries) for (let s = 0; s < projSeeds(e.parts); s++) if ((!skeletonDir || fs.existsSync(skeletonOf(e.id, s))) && !(skipDumped && fs.existsSync(path.join(dumpDir, `${e.id}_s${s}.json`)))) jobQueue.push({ entry: e, seed: s });
jobQueue.sort((a, b) => b.entry.parts - a.entry.parts || a.entry.id - b.entry.id || a.seed - b.seed);

const scoreOf = (r) =>
  (r.conflicts * 100 + r.incomplete * 10 + r.geo + (r.quality > 0 ? 1 : 0)) * 1e9 +
  (r.offAxis + r.crossings + (r.stacked ?? 0)) * 1e4 + (r.price ?? r.rate);

const perProjectRes = new Map();
const wallOf = new Map();
let running = 0;
let done = 0;
const t0 = Date.now();

const runJob = (job) =>
  new Promise((resolve) => {
    const a = [
      path.join(__dirname, "v5Solve.js"), "--data", dataDir, "--id", String(job.entry.id),
      "--seed", String(job.seed),
      ...(skeletonDir ? [] : engineMoves
        ? (moveCap ? ["--moves", String(cappedMoves(job.entry))] : [])
        : ["--moves", String(projMoves(job.entry.parts))]),
      ...(outDir ? ["--out", outDir] : []),
      ...(moveLogDir ? ["--movelog", moveLogDir] : []),
      ...(cutAware ? ["--cutaware", "1"] : []),
      ...(sched ? ["--sched", sched] : []),
      ...(timeMs && !skeletonDir ? ["--time", timeMs] : []),
      ...(hintOf.has(job.entry.id) && !skeletonDir ? ["--hint", String(hintOf.get(job.entry.id))] : []),
      ...(dumpDir ? ["--dump", dumpDir] : []),
      ...(skeletonDir ? ["--skeleton", skeletonOf(job.entry.id, job.seed)] : []),
      ...(skeletonDir && repairMode ? ["--repair", repairMode] : []),
      ...(drilled ? ["--drilled", "1"] : []),
      ...(noStack ? ["--nostack", "1"] : []),
      ...(exactBest ? ["--exact", "1"] : []),
    ];
    const child = spawn("node", a, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(engineMoves ? 8 : 1, movesMul) * 15 * 60 * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      let r;
      try {
        r = JSON.parse(out.trim().split("\n").pop());
      } catch {
        r = { id: job.entry.id, seed: job.seed, error: "no output (timeout?)" };
      }
      resolve(r);
    });
  });

const pump = async () => {
  while (jobQueue.length) {
    const job = jobQueue.shift();
    const r = await runJob(job);
    done++;
    if (!perProjectRes.has(job.entry.id)) perProjectRes.set(job.entry.id, { entry: job.entry, seeds: [] });
    perProjectRes.get(job.entry.id).seeds.push(r);
    if (r.error) console.log(`id ${job.entry.id} seed ${job.seed}: ERROR ${r.error}`);
    else console.log(
      `[${done}] id ${job.entry.id} (${job.entry.parts}p) seed ${job.seed}: ${r.rows}x${r.cols}=${r.area} q${r.quality}` +
      ` w${r.wires} oa${r.offAxis} cx${r.crossings} geo${r.geo} rate ${r.rate.toFixed(1)} ${(r.ms / 1000).toFixed(1)}s`
    );
  }
};

const runQueue = () => Promise.all(Array.from({ length: workers }, pump));
const runAll = async () => {
  if (!perProject) return runQueue();
  const all = jobQueue.splice(0);
  const ids = [...new Set(all.map((j) => j.entry.id))];
  for (const id of ids) {
    jobQueue.push(...all.filter((j) => j.entry.id === id));
    const t = Date.now();
    await runQueue();
    wallOf.set(id, Date.now() - t);
  }
};
runAll().then(() => {
  const results = [];
  for (const { entry, seeds } of perProjectRes.values()) {
    const ok = seeds.filter((s) => !s.error);
    if (ok.length === 0) {
      results.push({ id: entry.id, parts: entry.parts, human: { rows: entry.rows, cols: entry.cols }, error: true, seeds });
      continue;
    }
    ok.sort((a, b) => scoreOf(a) - scoreOf(b));
    const best = ok[0];
    const cpuMs = seeds.reduce((n, s) => n + (s.ms ?? 0), 0);
    results.push({ id: entry.id, parts: entry.parts, human: { rows: entry.rows, cols: entry.cols }, best, cpuMs, ...(wallOf.has(entry.id) ? { wallMs: wallOf.get(entry.id) } : {}), seeds });
  }
  results.sort((a, b) => a.id - b.id);
  fs.mkdirSync(path.join(dataDir, "results"), { recursive: true });
  const file = path.join(dataDir, "results", `v5-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, seedsBase, movesBase, wallMs: Date.now() - t0, results }, null, 1));
  console.log(`\nwrote ${file} (${((Date.now() - t0) / 60000).toFixed(1)} min wall)`);
  require("./v5Stats.js").printStats(results);
});
