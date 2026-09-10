// Wall-clock timing harness. The sweeps in sweep.js time orderings
// SEQUENTIALLY inside one process while running many projects at once, so
// their Time columns are neither what a user waits nor congestion-free.
// This tool measures what the editor delivers: one project at a time,
// orderings solved simultaneously in worker threads (the editor spreads
// them over web workers via permutationIndex), wall-clock taken from solve
// start to the last ordering's finish. Results are NOT recorded here; the
// sweep files stay authoritative and each timed pick is verified against
// them when --verify names a sweep file.
//
//   node tests/solver/timeRun.js --data <dir> --config tidyoff|single|perm3|perm5|perm10|beam|beamperm3
//                                [--ids 1,2] [--tag name] [--verify results/sweep-x.json]
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");

const CONFIGS = {
  tidyoff: { k: 1, tidy: 0 },
  single: { k: 1, tidy: Infinity },
  perm3: { k: 3, tidy: Infinity },
  perm5: { k: 5, tidy: Infinity },
  perm10: { k: 10, tidy: Infinity },
  beam: { k: 1, tidy: Infinity, beam: true },
  beamperm3: { k: 3, tidy: Infinity, beam: true },
};

if (!isMainThread) {
  const { computeAutoLayout2, DEFAULT_COMPONENTS } = require("./helpers.js");
  const { permutedInputs } = require(path.join(__dirname, "out/components/stripboard/layout2/permute.js"));
  const { rateResult } = require(path.join(__dirname, "out/components/stripboard/autoLayout2.js"));
  const { wireMessScore } = require(path.join(__dirname, "out/components/stripboard/layout2/tidyScore.js"));
  let proj = null;
  parentPort.on("message", (msg) => {
    if (msg.load) {
      const data = JSON.parse(fs.readFileSync(msg.load, "utf8"));
      const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
      proj = {
        board: { ...data.board, cuts: [], wires: [], lockedRows: false, lockedCols: false },
        comps: data.components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined })),
        defs, nets: data.nets ?? [], asg: data.netAssignments ?? [],
      };
      parentPort.postMessage({ loaded: true });
      return;
    }
    const { i, tidy, beam } = msg.solve;
    const t0 = Date.now();
    const r = computeAutoLayout2(proj.board, proj.comps, proj.defs, proj.nets, proj.asg, undefined, {
      harvest: true,
      permutationIndex: i,
      ...(tidy > 0 ? { tidyGrowth: tidy } : {}),
      ...(beam ? { beamSearch: true } : {}),
    });
    const ms = Date.now() - t0;
    // the guarded pick's inputs, computed on the permuted component order
    const pin = permutedInputs({ components: proj.comps, nets: proj.nets, netAssignments: proj.asg }, i);
    const score = rateResult(r, proj.board, pin.components, proj.defs, false);
    const cx = wireMessScore(r, pin.components, proj.defs).crossings;
    parentPort.postMessage({
      i, ms, score, cx, quality: r.quality,
      rows: r.boardSize.rows, cols: r.boardSize.cols, area: r.boardSize.rows * r.boardSize.cols,
    });
  });
  return;
}

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = argVal("data");
const cfgName = argVal("config");
const cfg = CONFIGS[cfgName];
if (!dataDir || !cfg) { console.error("usage: timeRun.js --data <dir> --config <name>"); process.exit(1); }
const tag = argVal("tag") ?? cfgName;
const verifyPath = argVal("verify");
const onlyIds = argVal("ids") ? new Set(argVal("ids").split(",").map(Number)) : null;

const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const entries = index.filter(
  (e) => (!onlyIds || onlyIds.has(e.id)) && e.unresolvedDefs === 0 && !(e.shortedDefs > 0)
);
const verify = verifyPath
  ? new Map(JSON.parse(fs.readFileSync(path.join(dataDir, verifyPath), "utf8")).results.map((r) => [r.id, r]))
  : null;

const workers = Array.from({ length: cfg.k }, () => new Worker(__filename));
const ask = (w, msg) => new Promise((res) => { w.once("message", res); w.postMessage(msg); });

(async () => {
  const rows = [];
  let mismatches = 0;
  for (let n = 0; n < entries.length; n++) {
    const e = entries[n];
    const file = path.join(dataDir, "projects", `${e.id}.json`);
    await Promise.all(workers.map((w) => ask(w, { load: file })));
    const t0 = process.hrtime.bigint();
    const done = await Promise.all(workers.map((w, i) => ask(w, { solve: { i, tidy: cfg.tidy, beam: !!cfg.beam } })));
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // the shipped guarded pick: fewest defects, then crossings, then rating, earliest ordering wins ties
    let best = done[0];
    for (const d of done) {
      if (d.quality < best.quality ||
          (d.quality === best.quality && (d.cx < best.cx || (d.cx === best.cx && (d.score < best.score || (d.score === best.score && d.i < best.i)))))) best = d;
    }
    let match = null;
    if (verify) {
      const v = verify.get(e.id)?.free;
      match = !!v && v.rows === best.rows && v.cols === best.cols && v.quality === best.quality;
      if (!match) mismatches++;
    }
    rows.push({ id: e.id, parts: e.parts, wallMs: Math.round(wallMs), orderingMs: done.map((d) => d.ms), quality: best.quality, area: best.area, match });
    if ((n + 1) % 25 === 0) console.log(`${n + 1}/${entries.length}...`);
  }
  for (const w of workers) w.terminate();
  const out = path.join(dataDir, "results", `time-${tag}.json`);
  fs.writeFileSync(out, JSON.stringify({ config: cfgName, k: cfg.k, date: new Date().toISOString(), results: rows }, null, 0));
  const s = rows.map((r) => r.wallMs).sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  console.log(`timed ${rows.length} projects -> ${out}`);
  console.log(`wall median ${Math.round(med)} ms, p90 ${s[Math.floor(0.9 * s.length)]} ms, max ${s[s.length - 1]} ms${verify ? `, pick mismatches ${mismatches}` : ""}`);
})();
