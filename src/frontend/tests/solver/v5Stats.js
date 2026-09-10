// Corpus summary and paired comparison for v5 result files.
//   node tests/solver/v5Stats.js <results A.json> [<results B.json>]
const fs = require("fs");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const isValid = (b) => b && b.quality === 0 && b.conflicts === 0 && b.incomplete === 0 && b.geo === 0;
const isClean = (b) => isValid(b) && b.offAxis + b.crossings === 0;
const asp = (r, c) => Math.max(r, c) / Math.min(r, c);

function printStats(results) {
  const ok = results.filter((r) => !r.error);
  const valid = ok.filter((r) => isValid(r.best));
  const clean = ok.filter((r) => isClean(r.best));
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  console.log(`projects ${results.length}  solved ${ok.length}  valid ${valid.length}  presentation-clean ${clean.length}`);
  console.log(`not clean: ${ok.filter((r) => !isClean(r.best)).map((r) => `${r.id}(oa${r.best.offAxis}/cx${r.best.crossings}${isValid(r.best) ? "" : "/INVALID"})`).join(" ")}`);
  console.log(`medArea/human ${median(valid.map((r) => r.best.area / (r.human.rows * r.human.cols))).toFixed(2)}x`);
  console.log(`wires ${sum(valid, (r) => r.best.wires)}  cuts ${sum(valid, (r) => r.best.cuts)}  oa/cx ${sum(ok, (r) => r.best.offAxis)}/${sum(ok, (r) => r.best.crossings)}`);
  console.log(`medAsp ${median(valid.map((r) => asp(r.best.rows, r.best.cols))).toFixed(2)} (human ${median(valid.map((r) => asp(r.human.rows, r.human.cols))).toFixed(2)})  a>3 ${valid.filter((r) => asp(r.best.rows, r.best.cols) > 3).length} (human ${valid.filter((r) => asp(r.human.rows, r.human.cols) > 3).length})`);
  const tall = valid.filter((r) => r.best.rows > r.best.cols).length;
  const hTall = valid.filter((r) => r.human.rows > r.human.cols).length;
  console.log(`orientation rows>cols: solver ${tall}/${valid.length}  human ${hTall}/${valid.length};  median rows/cols solver ${median(valid.map((r) => r.best.rows / r.best.cols)).toFixed(2)} human ${median(valid.map((r) => r.human.rows / r.human.cols)).toFixed(2)}`);
  console.log(`median CPU (all seeds) ${(median(ok.map((r) => r.cpuMs)) / 1000).toFixed(1)}s  median rate ${median(valid.map((r) => r.best.rate)).toFixed(1)}`);
}

function compare(A, B) {
  const byId = new Map(B.map((r) => [r.id, r]));
  const pairs = A.filter((a) => !a.error && byId.has(a.id) && !byId.get(a.id).error).map((a) => [a, byId.get(a.id)]);
  const cnt = (f) => {
    let b = 0, s = 0, w = 0;
    for (const [a, bb] of pairs) {
      const d = f(bb) - f(a);
      if (d < 0) b++; else if (d === 0) s++; else w++;
    }
    return `better/same/worse ${b}/${s}/${w}`;
  };
  console.log(`\npaired B vs A (${pairs.length}): area ${cnt((r) => r.best.area)}  wires ${cnt((r) => r.best.wires)}  mess ${cnt((r) => r.best.offAxis + r.best.crossings)}`);
  console.log(`median area B/A ${median(pairs.map(([a, b]) => b.best.area / a.best.area)).toFixed(3)}`);
  const changed = pairs.filter(([a, b]) => a.best.rows !== b.best.rows || a.best.cols !== b.best.cols || a.best.offAxis + a.best.crossings !== b.best.offAxis + b.best.crossings);
  console.log(`changed boards ${changed.length}:`);
  for (const [a, b] of changed) {
    console.log(`  id ${a.id} (${a.parts}p): ${a.best.rows}x${a.best.cols} oa${a.best.offAxis}/cx${a.best.crossings} -> ${b.best.rows}x${b.best.cols} oa${b.best.offAxis}/cx${b.best.crossings}  human ${a.human.rows}x${a.human.cols}`);
  }
}

if (require.main === module) {
  const A = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).results;
  console.log(`== ${process.argv[2]}`);
  printStats(A);
  if (process.argv[3]) {
    const B = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).results;
    console.log(`\n== ${process.argv[3]}`);
    printStats(B);
    compare(A, B);
  }
}
module.exports = { printStats, compare };
