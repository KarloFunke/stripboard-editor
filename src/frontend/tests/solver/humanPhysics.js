// Audits the corpus's HUMAN layouts against the solver's own physical rules
// (span limits, clearance halos, corridor and footprint overlaps) and splits
// the solver-vs-human area comparison by violation status. Produces the
// PHYSICS and VS_HUMAN figures cited in app/paper/data.ts.
//
//   node tests/solver/humanPhysics.js --data ../../auto-layouter-data \
//     [--sweep results/sweep-busrows2-locked2.json]
const path = require("path");
const fs = require("fs");
const { flexGeometry, boardLayout, DEFAULT_COMPONENTS } = require("./helpers.js");

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
}
const DATA = path.resolve(argOf("--data", path.join(__dirname, "../../auto-layouter-data")));
const SWEEP = argOf("--sweep", "results/sweep-busrows2-locked2.json");

const sweep = JSON.parse(fs.readFileSync(path.join(DATA, SWEEP), "utf8"));
const rows = sweep.results.filter(
  (r) => r.human && r.human.conflicts === 0 && r.human.incomplete === 0 && r.free && r.free.quality === 0
);
console.log(`subset: ${rows.length} projects`);

function auditProject(id) {
  const p = JSON.parse(fs.readFileSync(path.join(DATA, "projects", `${id}.json`), "utf8"));
  const defs = [...DEFAULT_COMPONENTS, ...(p.componentDefs || [])];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const resolve = (comp) =>
    comp.footprintOverride ? { ...byId.get(comp.defId), ...comp.footprintOverride } : byId.get(comp.defId);

  const placed = p.components.filter((c) => c.boardPos && !c.boardExcluded);
  const kinds = new Set();
  const flexParts = [];
  const rigids = [];

  for (const comp of placed) {
    const def = resolve(comp);
    if (!def) { kinds.add("unresolvedDef"); continue; }
    if (def.flexible) {
      const [p1, p2] = boardLayout.getFlexiblePinPositions(comp, def);
      if (p1 && p2) {
        const span = Math.hypot(p1.row - p2.row, p1.col - p2.col);
        const { min, max } = flexGeometry.spanLimits(def);
        if (span < min - 1e-6) kinds.add("spanShort");
        else if (span > max + 1e-6) kinds.add("spanLong");
        flexParts.push({ def, p1, p2 });
      }
    } else {
      rigids.push({ comp, def });
    }
  }

  for (let i = 0; i < flexParts.length; i++) {
    const a = flexParts[i];
    for (let j = i + 1; j < flexParts.length; j++) {
      const b = flexParts[j];
      if (flexGeometry.segmentsIntersect(a.p1, a.p2, b.p1, b.p2)) kinds.add("flexCross");
      else {
        const pairClr = Math.max(flexGeometry.clearanceOf(a.def), flexGeometry.clearanceOf(b.def));
        if (flexGeometry.bodiesTooClose(a.p1, a.p2, b.p1, b.p2, pairClr)) kinds.add("flexTooClose");
      }
    }
  }

  for (const f of flexParts) {
    for (const r of rigids) {
      const rect = boardLayout.getComponentBounds(r.def, r.comp.boardPos, r.comp.rotation);
      if (flexGeometry.bodyIntersectsRect(f.p1, f.p2, rect, flexGeometry.clearanceOf(f.def))) kinds.add("flexOnRigid");
    }
  }

  const pinHoles = new Set();
  for (const comp of placed) {
    const def = resolve(comp);
    if (!def) continue;
    for (const pin of boardLayout.getComponentPinPositions(comp, def)) pinHoles.add(`${pin.row},${pin.col}`);
  }
  for (const f of flexParts) {
    for (const h of flexGeometry.corridorHoles(f.p1, f.p2)) {
      const self = (h.row === f.p1.row && h.col === f.p1.col) || (h.row === f.p2.row && h.col === f.p2.col);
      if (!self && pinHoles.has(`${h.row},${h.col}`)) { kinds.add("corridorPin"); break; }
    }
  }

  const occ = new Map();
  for (const r of rigids) {
    const cells = [
      ...boardLayout.getComponentPinPositions(r.comp, r.def),
      ...boardLayout.getRotatedBodyCells(r.def, r.comp.boardPos, r.comp.rotation),
    ];
    for (const c of cells) {
      const k = `${c.row},${c.col}`;
      if (occ.has(k) && occ.get(k) !== r.comp.id) kinds.add("rigidOverlap");
      occ.set(k, r.comp.id);
    }
  }

  return [...kinds];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[lo + 1] !== undefined ? (s[lo + 1] - s[lo]) * (i - lo) : 0);
}

const perKind = {};
const all = [];
for (const r of rows) {
  const kinds = auditProject(r.id);
  for (const k of kinds) perKind[k] = (perKind[k] || 0) + 1;
  all.push({ id: r.id, kinds, parts: r.parts, ratio: r.free.area / r.human.area, humanSmaller: r.human.area < r.free.area });
}

const ratios = all.map((x) => x.ratio);
console.log(`\nVS_HUMAN (solver vs human area): smaller ${ratios.filter((x) => x < 1).length}  equal ${ratios.filter((x) => x === 1).length}  larger ${ratios.filter((x) => x > 1).length}`);
console.log(`area ratio quartiles: q1 ${quantile(ratios, 0.25).toFixed(2)}  median ${median(ratios).toFixed(2)}  q3 ${quantile(ratios, 0.75).toFixed(2)}`);

const viol = all.filter((x) => x.kinds.length);
const clean = all.filter((x) => !x.kinds.length);
console.log(`\nPHYSICS: violating ${viol.length}/${all.length}`);
console.log("by kind (projects):", perKind);
for (const [name, g] of [["violating", viol], ["clean", clean]]) {
  const smaller = g.filter((x) => x.humanSmaller).length;
  console.log(`${name}: n=${g.length}  human-smaller ${smaller}  median ratio ${median(g.map((x) => x.ratio)).toFixed(2)}`);
}
const hs = all.filter((x) => x.humanSmaller);
console.log(`human-smaller: ${hs.length}, violating ${hs.filter((x) => x.kinds.length).length}, worst clean ratio ${Math.max(...hs.filter((x) => !x.kinds.length).map((x) => x.ratio)).toFixed(2)}`);

console.log("\nband | violating: n, med ratio, human-smaller | clean: n, med ratio, human-smaller");
for (const [lo, hi] of [[2, 5], [6, 10], [11, 15], [16, 25], [26, 60]]) {
  const inBand = all.filter((x) => x.parts >= lo && x.parts <= hi);
  const fmt = (xs) =>
    xs.length
      ? `n=${String(xs.length).padStart(3)}  ${median(xs.map((x) => x.ratio)).toFixed(2)}  ${xs.filter((x) => x.humanSmaller).length}`
      : "n=  0   -   -";
  console.log(`${lo}-${hi}`.padEnd(6) + "| " + fmt(inBand.filter((x) => x.kinds.length)) + "   | " + fmt(inBand.filter((x) => !x.kinds.length)));
}
