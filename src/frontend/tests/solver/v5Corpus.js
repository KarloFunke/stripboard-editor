// v5 corpus run with per-seed fan-out (frozen protocol: seeds 6, 10 at
// >=25 parts, 12 at >=40; moves min(160k, max(60k, 3200*parts)), floor 40k at <=8 parts).
//   node tests/solver/v5Corpus.js --data <dir> --name <tag> [--ids 1,2] [--seeds 6]
//        [--moves 60000] [--workers 14] [--out <compiled dir>] [--movelog <dir>]
//        [--movesmul 2] (budget experiments) [--seedsmax 6] (cap the size-scaled seed count)
//        [--enginemoves 1] (no --moves: the engine's own default budget)
//        [--time <ms>] (wall-time budget per seed; implies no --moves)
//        [--drilled 1] (drilled cuts only)
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
const drilled = argVal("drilled") === "1";
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;
const entries = index.filter(
  (e) => (!onlyIds || onlyIds.has(e.id)) && e.unresolvedDefs === 0 && !(e.shortedDefs > 0)
);

const projSeeds = (parts) => Math.min(seedsMax, parts >= 40 ? 12 : parts >= 25 ? 10 : seedsBase);
const projMoves = (parts) => Math.round(movesMul * Math.min(160000, Math.max(parts <= 8 ? Math.min(movesBase, 40000) : movesBase, 3200 * parts)));
const jobQueue = [];
for (const e of entries) for (let s = 0; s < projSeeds(e.parts); s++) jobQueue.push({ entry: e, seed: s });
jobQueue.sort((a, b) => b.entry.parts - a.entry.parts || a.entry.id - b.entry.id || a.seed - b.seed);

const scoreOf = (r) =>
  (r.conflicts * 100 + r.incomplete * 10 + r.geo + (r.quality > 0 ? 1 : 0)) * 1e9 +
  (r.offAxis + r.crossings) * 1e4 + r.rate;

const perProject = new Map();
let running = 0;
let done = 0;
const t0 = Date.now();

const runJob = (job) =>
  new Promise((resolve) => {
    const a = [
      path.join(__dirname, "v5Solve.js"), "--data", dataDir, "--id", String(job.entry.id),
      "--seed", String(job.seed), ...(engineMoves ? [] : ["--moves", String(projMoves(job.entry.parts))]),
      ...(outDir ? ["--out", outDir] : []),
      ...(moveLogDir ? ["--movelog", moveLogDir] : []),
      ...(cutAware ? ["--cutaware", "1"] : []),
      ...(sched ? ["--sched", sched] : []),
      ...(timeMs ? ["--time", timeMs] : []),
      ...(drilled ? ["--drilled", "1"] : []),
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
    if (!perProject.has(job.entry.id)) perProject.set(job.entry.id, { entry: job.entry, seeds: [] });
    perProject.get(job.entry.id).seeds.push(r);
    if (r.error) console.log(`id ${job.entry.id} seed ${job.seed}: ERROR ${r.error}`);
    else console.log(
      `[${done}] id ${job.entry.id} (${job.entry.parts}p) seed ${job.seed}: ${r.rows}x${r.cols}=${r.area} q${r.quality}` +
      ` w${r.wires} oa${r.offAxis} cx${r.crossings} geo${r.geo} rate ${r.rate.toFixed(1)} ${(r.ms / 1000).toFixed(1)}s`
    );
  }
};

Promise.all(Array.from({ length: workers }, pump)).then(() => {
  const results = [];
  for (const { entry, seeds } of perProject.values()) {
    const ok = seeds.filter((s) => !s.error);
    if (ok.length === 0) {
      results.push({ id: entry.id, parts: entry.parts, human: { rows: entry.rows, cols: entry.cols }, error: true, seeds });
      continue;
    }
    ok.sort((a, b) => scoreOf(a) - scoreOf(b));
    const best = ok[0];
    const cpuMs = seeds.reduce((n, s) => n + (s.ms ?? 0), 0);
    results.push({ id: entry.id, parts: entry.parts, human: { rows: entry.rows, cols: entry.cols }, best, cpuMs, seeds });
  }
  results.sort((a, b) => a.id - b.id);
  fs.mkdirSync(path.join(dataDir, "results"), { recursive: true });
  const file = path.join(dataDir, "results", `v5-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, seedsBase, movesBase, wallMs: Date.now() - t0, results }, null, 1));
  console.log(`\nwrote ${file} (${((Date.now() - t0) / 60000).toFixed(1)} min wall)`);
  require("./v5Stats.js").printStats(results);
});
