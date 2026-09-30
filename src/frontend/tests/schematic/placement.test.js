// A part added by a click lands on a free spot in view: never on a wire or
// another pin, so settling it joins no net. Compiled by
// tests/schematic/tsconfig.json into out/.
const Module = require("module");
const path = require("path");

const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const geo = require(path.join(OUT, "components/schematic/schematicGeometry.js"));
const { recalculateNets } = require(path.join(OUT, "components/schematic/netInference.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.log("  FAIL " + msg); }
}

let seq = 0;
const newId = () => `w${++seq}`;
const wire = (x1, y1, x2, y2) => ({ id: newId(), start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const resistor = (id, x, y) => ({ id, defId: "def-resistor", label: id, schematicPos: { x, y }, schematicRotation: 0, boardPos: null, rotation: 0 });
const DEFS = DEFAULT_COMPONENTS;
const G = 20;
const R = geo.partBox("resistor", 0, false);
const VIEW = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };

const shifted = (b, p) => ({ minX: p.x + b.minX, minY: p.y + b.minY, maxX: p.x + b.maxX, maxY: p.y + b.maxY });
const wireBox = (w) => ({
  minX: Math.min(w.start.x, w.end.x), minY: Math.min(w.start.y, w.end.y),
  maxX: Math.max(w.start.x, w.end.x), maxY: Math.max(w.start.y, w.end.y),
});
const obstaclesOf = (comps, wires) => [...comps.map((c) => shifted(R, c.schematicPos)), ...wires.map(wireBox)];

/** Pins of the part that share a net with anything after a touch-rules settle */
function joinedPins(id, wires, comps) {
  const anchors = geo.anchorPoints(comps, DEFS, []);
  const ws = geo.mergeWires(geo.normalizeWires(wires, anchors, newId, true), anchors);
  return recalculateNets(ws, [], [], comps, DEFS, []).netAssignments.filter((a) => a.componentId === id);
}

// ── 1. An empty sheet: the middle of the view ─────────────
{
  const s = geo.findFreeSpot(R, [], VIEW, G);
  assert(s.at.x === 500 && s.at.y === 400 && s.inView, `empty sheet: middle of the view (${s.at.x}, ${s.at.y})`);
}

// ── 2. Parts added one after another fill a row, then the next ──
{
  const comps = [];
  for (let i = 0; i < 9; i++) {
    const s = geo.findFreeSpot(R, obstaclesOf(comps, []), VIEW, G);
    comps.push(resistor(`R${i}`, s.at.x, s.at.y));
  }
  const row = comps.slice(0, 5);
  const xs = row.map((c) => c.schematicPos.x).sort((a, b) => a - b);
  assert(row.every((c) => c.schematicPos.y === 400), `the first five resistors share the middle row (xs ${xs.join(" ")})`);
  assert(xs.every((x, i) => i === 0 || x - xs[i - 1] >= 3 * G), "and stand at least three grid steps apart, room for their names");
  const inRow = comps.filter((c) => c.schematicPos.y === 400).length;
  const next = comps.slice(7).map((c) => `(${c.schematicPos.x}, ${c.schematicPos.y})`).join(" ");
  assert(inRow === 7 && comps[7].schematicPos.x === 500, `seven fill the middle row, then new rows start in the middle: ${next}`);
}

// ── 3. A wire through the middle of the view is avoided ──
{
  // A net running right across the view, with a resistor on it
  const wires = [wire(0, 400, 1000, 400), wire(500, 0, 500, 800)];
  const on = resistor("ON", 300, 420);
  const s = geo.findFreeSpot(R, obstaclesOf([on], wires), VIEW, G);
  const comps = [on, resistor("NEW", s.at.x, s.at.y)];
  assert(s.inView, `a free spot in view beside the wires (${s.at.x}, ${s.at.y})`);
  assert(joinedPins("NEW", wires, comps).length === 0, "its pins join no net after a touch settle");
}

// ── 4. A full view: the nearest free spot outside ────────
{
  // Horizontal wires every grid step fill the view
  const wires = [];
  for (let y = 0; y <= 800; y += G) wires.push(wire(0, y, 1000, y));
  const s = geo.findFreeSpot(R, obstaclesOf([], wires), VIEW, G);
  const comps = [resistor("NEW", s.at.x, s.at.y)];
  assert(!s.inView, `nothing in view is free: placed outside at (${s.at.x}, ${s.at.y})`);
  assert(joinedPins("NEW", wires, comps).length === 0, "and its pins join no net");
}

// ── 5. A random crowded sheet: never a contact ───────────
{
  let rnd = 7;
  const rand = (n) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % n; };
  const wires = [];
  const comps = [];
  for (let i = 0; i < 60; i++) {
    const x = rand(50) * G, y = rand(40) * G, len = (1 + rand(10)) * G;
    wires.push(rand(2) ? wire(x, y, x + len, y) : wire(x, y, x, y + len));
  }
  for (let i = 0; i < 30; i++) comps.push(resistor(`P${i}`, rand(50) * G, rand(40) * G));
  let contacts = 0;
  for (let i = 0; i < 25; i++) {
    const s = geo.findFreeSpot(R, obstaclesOf(comps, wires), VIEW, G);
    const id = `NEW${i}`;
    comps.push(resistor(id, s.at.x, s.at.y));
    if (joinedPins(id, wires, comps).length > 0) contacts++;
  }
  assert(contacts === 0, `25 resistors added to a random sheet of 60 wires and 30 parts: ${contacts} joined a net`);
}

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log("\nall passed");
