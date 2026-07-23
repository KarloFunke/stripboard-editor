// Cluster-cap study: sweep the whole corpus once per MAX_CLUSTER value and
// aggregate the results into the data a size-adaptive cap function needs.
//
//   node tests/solver/capStudy.js --data <dir> [--caps 5-25] [--locked 2] [--ids 1,2,3] [--report-only]
//
// Caps run sequentially (each sweep parallelizes internally). A cap whose
// results file already exists is skipped, so an interrupted study resumes
// by rerunning the same command; a failing cap logs and the study moves on.
// The report (also available standalone via --report-only) prints a
// cap × size-bucket matrix and the per-project best cap, and writes
// <data>/results/cap-study-summary.json.
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
  console.error("usage: node capStudy.js --data <dir> [--caps 5-25] [--locked 2] [--ids ...] [--report-only]");
  process.exit(1);
}
const lockedN = Number(argVal("locked") ?? 2);
const capsArg = argVal("caps") ?? "5-25";
const caps = capsArg.includes("-")
  ? (() => {
      const [lo, hi] = capsArg.split("-").map(Number);
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    })()
  : capsArg.split(",").map(Number);
const ids = argVal("ids");
const resDir = path.join(dataDir, "results");

const tagOf = (cap) => `capstudy-c${String(cap).padStart(2, "0")}`;
const fileOf = (cap) => path.join(resDir, `sweep-${tagOf(cap)}${lockedN ? `-locked${lockedN}` : ""}.json`);

if (!args.includes("--report-only")) {
  for (const cap of caps) {
    if (fs.existsSync(fileOf(cap))) {
      console.log(`cap ${cap}: results exist, skipping (delete ${path.basename(fileOf(cap))} to redo)`);
      continue;
    }
    console.log(`\n━━ cap ${cap} ━━`);
    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "sweep.js"),
        "--data", dataDir,
        "--tag", tagOf(cap),
        "--max-cluster", String(cap),
        ...(lockedN ? ["--locked", String(lockedN)] : []),
        ...(ids ? ["--ids", ids] : []),
      ],
      { stdio: "inherit" }
    );
    if (r.status !== 0) console.error(`cap ${cap} FAILED (exit ${r.status}) — continuing`);
    else console.log(`cap ${cap} done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
}

// ── Report ─────────────────────────────────────────────
const BUCKETS = [[2, 5], [6, 10], [11, 15], [16, 25], [26, 60]];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const runs = [];
for (const cap of caps) {
  if (!fs.existsSync(fileOf(cap))) continue;
  runs.push({ cap, results: JSON.parse(fs.readFileSync(fileOf(cap), "utf8")).results });
}
if (runs.length === 0) {
  console.error("no cap results found — nothing to report");
  process.exit(1);
}

console.log(`\n═══ cap study report (${runs.length} caps) ═══`);
console.log("free median area vs human, per size bucket:");
console.log("cap   " + BUCKETS.map(([lo, hi]) => `${lo}-${hi}`.padStart(7)).join("") + "   q0  strip%  asp>3  Lq0  Lprem");
for (const { cap, results } of runs) {
  const q0 = results.filter((r) => !r.free.error && r.free.quality === 0);
  const cells = BUCKETS.map(([lo, hi]) => {
    const b = q0.filter((r) => r.parts >= lo && r.parts <= hi);
    return b.length ? median(b.map((r) => r.free.area / r.human.area)).toFixed(2).padStart(7) : "      -";
  }).join("");
  const lok = results.filter((r) => r.locked && !r.locked.error);
  const lq0 = lok.filter((r) => r.locked.quality === 0);
  const lprem = median(lq0.map((r) => r.locked.area / r.free.area));
  console.log(
    String(cap).padEnd(6) + cells +
    String(q0.length).padStart(5) +
    String(median(q0.map((r) => r.free.stripCompletePct))).padStart(7) + "%" +
    String(q0.filter((r) => r.free.aspect > 3).length).padStart(6) +
    String(lq0.length).padStart(5) +
    (isNaN(lprem) ? "    -" : lprem.toFixed(2).padStart(7))
  );
}

// Per-project best cap: among clean runs, the cap minimizing (area, wireLen).
// This is the raw material for fitting cap = f(project size).
const byId = new Map();
for (const { cap, results } of runs) {
  for (const r of results) {
    if (r.free.error || r.free.quality !== 0) continue;
    const cur = byId.get(r.id);
    const better =
      !cur ||
      r.free.area < cur.area ||
      (r.free.area === cur.area && r.free.wireLen < cur.wireLen);
    if (better) byId.set(r.id, { cap, parts: r.parts, area: r.free.area, wireLen: r.free.wireLen });
  }
}
console.log("\nper-project best cap, median by size bucket:");
for (const [lo, hi] of BUCKETS) {
  const b = [...byId.values()].filter((v) => v.parts >= lo && v.parts <= hi);
  if (!b.length) continue;
  const caps5 = b.map((v) => v.cap);
  console.log(
    `${lo}-${hi}`.padEnd(8) + "n=" + String(b.length).padEnd(6) +
    "median best cap " + median(caps5) +
    "   (p25 " + [...caps5].sort((a, b) => a - b)[Math.floor(caps5.length * 0.25)] +
    ", p75 " + [...caps5].sort((a, b) => a - b)[Math.floor(caps5.length * 0.75)] + ")"
  );
}

fs.writeFileSync(
  path.join(resDir, "cap-study-summary.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      lockedN,
      caps: runs.map((r) => r.cap),
      bestCapPerProject: [...byId.entries()].map(([id, v]) => ({ id, ...v })),
    },
    null,
    1
  )
);
console.log(`\nsummary written to ${path.join(resDir, "cap-study-summary.json")}`);
