// Schematic connectivity contract: wires connect only at their endpoints,
// settling makes every contact an endpoint, labels join by name, and the
// load-time normalization preserves the nets of projects saved under the
// old rules. Compiled by tests/schematic/tsconfig.json into out/.
const Module = require("module");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const geo = require(path.join(OUT, "components/schematic/schematicGeometry.js"));
const { recalculateNets, diffNets, netDiffIsEmpty } = require(path.join(OUT, "components/schematic/netInference.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));
const { createFootprintSymbol, registerCustomSymbol } = require(path.join(OUT, "data/symbolDefs.js"));
const { resolveComponentDef } = require(path.join(OUT, "utils/resolveComponentDef.js"));
const { getRotatedPinPositions } = require(path.join(OUT, "components/schematic/SymbolRenderer.js"));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.log("  FAIL " + msg); }
}

let seq = 0;
const newId = () => `w${++seq}`;
const wire = (x1, y1, x2, y2) => ({ id: newId(), start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
// A resistor has pins at (0,-20) and (0,20) relative to its origin
const resistor = (id, x, y) => ({ id, defId: "def-resistor", label: id, schematicPos: { x, y }, schematicRotation: 0, boardPos: null, rotation: 0 });
const DEFS = DEFAULT_COMPONENTS;

/** Nets as a canonical list of pin-set strings, id-independent */
function groupsOf(result) {
  const byNet = new Map();
  for (const a of result.netAssignments) {
    if (!byNet.has(a.netId)) byNet.set(a.netId, []);
    byNet.get(a.netId).push(`${a.componentId}:${a.pinId}`);
  }
  return [...byNet.values()].map((g) => g.sort().join(",")).sort();
}

// touch = true: touch wiring, every contact counts. false: classic wiring,
// only wire ends connect. Default touch, as in a new project.
function settle(wires, comps, labels, touch = true) {
  const anchors = geo.anchorPoints(comps, DEFS, labels);
  const ws = geo.mergeWires(geo.normalizeWires(wires, anchors, newId, touch), anchors);
  return { wires: ws, ...recalculateNets(ws, [], [], comps, DEFS, labels) };
}
const CLASSIC = false;

// ── 1. Bodies never connect; endpoints do ──────────────
{
  const A = resistor("A", 0, 100);      // pin 1 at (0,80), pin 2 at (0,120)
  const B = resistor("B", 200, 100);    // pin 1 at (200,80)
  const C = resistor("C", 100, 300);    // pin 1 at (100,280)
  // A.1 to B.1 straight across; B.1 also has a wire down to B.2's level;
  // C's wire ends on the first wire's body at (100,80).
  const wires = [wire(0, 80, 200, 80), wire(200, 80, 200, 120), wire(100, 280, 100, 80)];
  // Raw rules: only endpoints count, so C's wire end on the body joins
  // nothing; C.1 alone is a one-pin net.
  const raw = recalculateNets(wires, [], [], [A, B, C], DEFS, []);
  assert(groupsOf(raw).join("|") === "A:1,B:1,B:2|C:1", `raw: a wire end on a body does not connect (${groupsOf(raw).join("|")})`);

  // Settling splits the first wire under C's end -> everything joined
  const s = settle(wires, [A, B, C], []);
  assert(groupsOf(s).join("|") === "A:1,B:1,B:2,C:1", `settled: the body contact became a junction (${groupsOf(s).join("|")})`);
  assert(s.wires.every((w) => w.start.x === w.end.x || w.start.y === w.end.y), "every wire is straight");
  assert(!s.wires.some((w) => s.wires.some((o) => o.id !== w.id && (geo.onWireInterior(o.start, w) || geo.onWireInterior(o.end, w)))), "no wire end sits on another wire's body");
}

// ── 2. Crossing wires stay separate ────────────────────
{
  const A = resistor("A", 0, 100), B = resistor("B", 200, 100);   // A.2 (0,120), B.2 (200,120)
  const C = resistor("C", 100, 0), D = resistor("D", 100, 240);   // C.2 (100,20), D.1 (100,220)
  const wires = [wire(0, 120, 200, 120), wire(100, 20, 100, 220)]; // cross at (100,120)
  const s = settle(wires, [A, B, C, D], []);
  assert(groupsOf(s).join("|") === "A:2,B:2|C:2,D:1", `crossing wires do not join (${groupsOf(s).join("|")})`);
}

// ── 3. A pin parked on a wire body connects after settling ──
{
  const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
  const P = resistor("P", 100, 140); // P.1 at (100,120), on the wire body
  const wires = [wire(0, 120, 200, 120)];
  const raw = recalculateNets(wires, [], [], [A, B, P], DEFS, []);
  assert(groupsOf(raw).join("|") === "A:2,B:2", "raw: pin on a wire body is not connected");
  const s = settle(wires, [A, B, P], []);
  assert(groupsOf(s).join("|") === "A:2,B:2,P:1", `settled: pin on a wire body joins (${groupsOf(s).join("|")})`);
  assert(s.wires.length === 2, "the wire was split under the pin");
}

// ── 3b. Classic wiring never joins through a body; drawn ends still attach ──
{
  const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
  const P = resistor("P", 100, 140); // P.1 at (100,120), on the wire body
  const wires = [wire(0, 120, 200, 120)];
  const classic = settle(wires, [A, B, P], [], CLASSIC);
  assert(groupsOf(classic).join("|") === "A:2,B:2", `classic: a pin on a wire body stays apart (${groupsOf(classic).join("|")})`);
  assert(classic.wires.length === 1, "classic: the wire is not split under the pin");
  const touch = settle(wires, [A, B, P], []);
  assert(groupsOf(touch).join("|") === "A:2,B:2,P:1", "touch: the same drawing connects");

  // A wire drawn to end on another wire's body makes a T under either rule set
  const T = wire(100, 120, 100, 200);
  const drawn = geo.attachWireEnds([...wires, T], new Set([T.id]), newId);
  assert(drawn.length === 3, "the wire under the drawn end was split");
  const C = resistor("C", 100, 220); // C.1 at (100,200)
  const classicT = settle(drawn, [A, B, C], [], CLASSIC);
  assert(groupsOf(classicT).join("|") === "A:2,B:2,C:1", `classic: the drawn T connects (${groupsOf(classicT).join("|")})`);
  // ...but a wire merely lying across a pin does not, under classic
  const across = settle([wire(0, 120, 200, 120)], [A, B, P], [], CLASSIC);
  assert(groupsOf(across).join("|") === "A:2,B:2", "classic: a wire across a pin end is not a connection");
}

// ── 3c. Moves follow the editor's drag rules, and never slant ──
const straight = (x) => x.start.x === x.end.x || x.start.y === x.end.y;
const shift = (dx, dy) => (p) => ({ x: p.x + dx, y: p.y + dy });
{
  // The loop from the screenshots: a box whose right side runs through the
  // two pins of a connector J (pins at (240,140) and (240,180)).
  const box = () => [
    wire(80, 60, 240, 60), wire(240, 60, 240, 160), wire(240, 160, 240, 180),
    wire(240, 180, 240, 240), wire(240, 240, 80, 240), wire(80, 240, 80, 60),
  ];
  const J = { id: "J", defId: "def-connector-2", label: "J1", schematicPos: { x: 280, y: 160 }, schematicRotation: 0, boardPos: null, rotation: 0 };
  const jp = geo.schematicPinPoints([J], DEFS).map((p) => p.key).sort().join(" ");
  assert(jp === "240,160 240,180", `connector pins sit on the loop's right side (${jp})`);

  // 1. A horizontal segment on its own may only move vertically
  const ws = box();
  const bottom = ws[4];
  assert(geo.axisLockFor(ws, new Set([bottom.id]), false) === "h", "a lone horizontal segment is locked to vertical movement");
  assert(geo.axisLockFor(ws, new Set([ws[0].id, ws[1].id]), false) === null, "a corner of two axes moves freely");
  assert(geo.axisLockFor(ws, new Set([bottom.id]), true) === null, "with a part in the selection nothing is locked");
  // Dragging it down: the two verticals lengthen, nothing else appears
  const { stat, movingPoints } = geo.movingAndStaticKeys([J], DEFS, [], new Set(), new Set());
  const down = geo.moveGeometry(ws, stat, movingPoints, new Set([bottom.id]), shift(0, 40), "n");
  assert(down.length === 6 && down.every(straight), "dragging the bottom down keeps six straight wires");
  assert(down.find((w) => w.id === bottom.id).start.y === 280, "the bottom segment moved");
  assert(down.find((w) => w.id === ws[3].id).end.y === 280 && down.find((w) => w.id === ws[5].id).start.y === 280, "both verticals lengthened to meet it");

  // 2. Dragging the connector right slides the whole right side and stretches the horizontals
  const m = geo.movingAndStaticKeys([J], DEFS, [], new Set(["J"]), new Set());
  const right = geo.moveGeometry(ws, m.stat, m.movingPoints, new Set(), shift(80, 0), "n");
  assert(right.length === 6 && right.every(straight), `six straight wires after moving the connector (${right.length})`);
  const xs = right.filter((w) => w.start.x === w.end.x).map((w) => w.start.x).sort((a, b) => a - b).join(",");
  assert(xs === "80,320,320,320", `the right side slid to x=320 (verticals at ${xs})`);
  assert(right.find((w) => w.id === ws[0].id).end.x === 320 && right.find((w) => w.id === ws[4].id).start.x === 320, "top and bottom stretched");

  // 3. Rotating the connector: pins move apart, wires stay orthogonal and attached
  const rot = geo.transformSelection([J], DEFS, [], ws, new Set(["J"]), new Set(), new Set(), "rotate", "n", J.schematicPos);
  assert(rot.schematicWires.every(straight), "rotation leaves every wire straight");
  const pins = geo.schematicPinPoints(rot.components, DEFS).map((p) => p.key);
  const ends = new Set(rot.schematicWires.flatMap((w) => [`${w.start.x},${w.start.y}`, `${w.end.x},${w.end.y}`]));
  assert(pins.every((k) => ends.has(k)), `every rotated pin still has a wire end on it (${pins.join(" ")})`);
  const settledRot = settle(rot.schematicWires, rot.components, [], CLASSIC);
  assert(groupsOf(settledRot).join("|") === "J:1,J:2", `the loop is still one net after rotating (${groupsOf(settledRot).join("|")})`);

  // 4. A far end that cannot give (a pin) gets a corner instead of sliding
  const A = resistor("A", 0, 100); // A.2 at (0,120)
  const stub = [wire(0, 120, 100, 120)];
  const L = { id: "l", kind: "label", name: "N", pos: { x: 100, y: 120 }, rotation: 0 };
  const mm = geo.movingAndStaticKeys([A], DEFS, [L], new Set(), new Set(["l"]));
  const moved = geo.moveGeometry(stub, mm.stat, mm.movingPoints, new Set(), shift(0, 60), "n");
  assert(moved.length === 2 && moved.every(straight), "moving the label down adds one corner leg");
  assert(moved.some((w) => w.start.x === 100 && w.end.x === 100), "the leg is vertical, from the wire's end down to the label");

  // 5. A selected wire torn off a pin gets a leg back to it
  const torn = geo.moveGeometry(stub, mm.stat, [], new Set([stub[0].id]), shift(0, 40), "n");
  assert(torn.every(straight) && torn.some((w) => w.start.x === 0 && w.end.x === 0 && Math.abs(w.end.y - w.start.y) === 40), "a vertical leg reconnects the pin to the moved wire");
}

// ── 4. Labels join by name and name the net ────────────
{
  const A = resistor("A", 0, 100), B = resistor("B", 400, 100);
  const labels = [
    { id: "l1", kind: "gnd", name: "GND", pos: { x: 0, y: 160 }, rotation: 0 },
    { id: "l2", kind: "gnd", name: "GND", pos: { x: 400, y: 160 }, rotation: 0 },
  ];
  const wires = [wire(0, 120, 0, 160), wire(400, 120, 400, 160)];
  const s = settle(wires, [A, B], labels);
  assert(groupsOf(s).join("|") === "A:2,B:2", `two GND flags make one net (${groupsOf(s).join("|")})`);
  assert(s.nets.length === 1 && s.nets[0].name === "GND", `the net is called GND (${s.nets.map((n) => n.name)})`);
  assert(s.nets[0].color === "#000000", "ground nets default to black");

  // Renaming the net keeps its id when the flags are renamed with it
  const renamedLabels = labels.map((l) => ({ ...l, name: "AGND" }));
  const renamedNets = s.nets.map((n) => ({ ...n, name: "AGND" }));
  const r = recalculateNets(s.wires, renamedNets, s.netAssignments, [A, B], DEFS, renamedLabels);
  assert(r.nets[0].id === s.nets[0].id && r.nets[0].name === "AGND", "rename keeps the net id");

  // A label on a pin directly, no wire, still connects
  const C = resistor("C", 800, 100);
  const l3 = { id: "l3", kind: "gnd", name: "GND", pos: { x: 800, y: 120 }, rotation: 0 };
  const s2 = settle(wires, [A, B, C], [...labels, l3]);
  assert(groupsOf(s2).join("|") === "A:2,B:2,C:2", `flag on a pin without a wire connects (${groupsOf(s2).join("|")})`);
}

// ── 4b. Pins on the same point are connected ───────────
{
  const A = resistor("A", 0, 100);   // A.2 at (0,120)
  const B = resistor("B", 0, 140);   // B.1 at (0,120)
  const s = settle([], [A, B], [], CLASSIC);
  assert(groupsOf(s).join("|") === "A:2,B:1", `touching pins form a net without a wire, under classic too (${groupsOf(s).join("|")})`);
  const lone = settle([], [A], []);
  assert(lone.nets.length === 0, "a lone pin is not a net");
}

// ── 4c. The wiring-switch preview reports every kind of change ──
{
  const label = (c, p) => `${c} pin ${p}`;
  // As previewWiringSwitch does it: settle classic, then settle touch with
  // the classic nets as the existing ones, so net ids and names carry over
  const settleBoth = (wires, comps, labels) => {
    const anchors = geo.anchorPoints(comps, DEFS, labels);
    const classicWires = geo.mergeWires(geo.normalizeWires(wires, anchors, newId, false), anchors);
    const before = recalculateNets(classicWires, [], [], comps, DEFS, labels);
    const touchWires = geo.mergeWires(geo.normalizeWires(wires, anchors, newId, true), anchors);
    return [before, recalculateNets(touchWires, before.nets, before.netAssignments, comps, DEFS, labels)];
  };

  // A pin resting on a wire's body joins that net: no net disappears, so a
  // merge-only report would have called this "no change" (the case the user hit)
  {
    const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
    const C = resistor("C", 100, 140); // C.1 at (100,120), on the wire
    const [before, after] = settleBoth([wire(0, 120, 200, 120)], [A, B, C], []);
    const d = diffNets(before, after, label);
    assert(!netDiffIsEmpty(d), "a pin joining a net is reported as a change");
    assert(d.merges.length === 0 && d.newNets.length === 0, "it is not a merge and not a new net");
    assert(d.joins.length === 1 && d.joins[0].pins.join() === "C pin 1", `the pin is named (${JSON.stringify(d.joins)})`);
  }

  // Two nets that become one
  {
    const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
    const C = resistor("C", 100, 300), D = resistor("D", 300, 300);
    // C-D's wire ends on the middle of A-B's wire
    const [before, after] = settleBoth([wire(0, 120, 200, 120), wire(100, 120, 100, 320), wire(100, 320, 300, 320)], [A, B, C, D], []);
    const d = diffNets(before, after, label);
    assert(d.merges.length === 1 && d.merges[0].joined.length === 1, `two nets merge (${JSON.stringify(d.merges)})`);
  }

  // Pins with no net at all, both on one wire that has none either
  {
    const P = resistor("P", 60, 140), Q = resistor("Q", 140, 140); // pins at (60,120) and (140,120)
    const [before, after] = settleBoth([wire(0, 120, 200, 120)], [P, Q], []);
    const d = diffNets(before, after, label);
    assert(before.nets.length === 0, "classic: the loose wire is nobody's net");
    assert(d.newNets.length === 1 && d.newNets[0].pins.sort().join() === "P pin 1,Q pin 1", `a new net forms (${JSON.stringify(d.newNets)})`);
  }

  // A flag lying on a wire's body renames the net it would touch
  {
    const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
    const flag = { id: "f", kind: "gnd", name: "GND", pos: { x: 100, y: 120 }, rotation: 0 };
    const [before, after] = settleBoth([wire(0, 120, 200, 120)], [A, B], [flag]);
    const d = diffNets(before, after, label);
    assert(before.nets[0].name !== "GND" && after.nets[0].name === "GND", "classic leaves the flag unconnected, touch takes its name");
    assert(d.renames.length === 1 && d.renames[0].to === "GND", `the rename is reported (${JSON.stringify(d.renames)})`);
  }

  // Nothing touching: no change at all
  {
    const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
    const [before, after] = settleBoth([wire(0, 120, 200, 120)], [A, B], []);
    assert(netDiffIsEmpty(diffNets(before, after, label)), "a clean drawing reports no change");
  }
}

// ── 5. Existing nets keep their order and names ────────
{
  const A = resistor("A", 0, 100), B = resistor("B", 200, 100), C = resistor("C", 0, 300), D = resistor("D", 200, 300);
  const wires = [wire(0, 120, 200, 120), wire(0, 320, 200, 320)];
  const first = recalculateNets(wires, [], [], [A, B, C, D], DEFS, []);
  const named = first.nets.map((n, i) => ({ ...n, name: i === 0 ? "SIG" : n.name }));
  // Add a third net; the first two keep position and name
  const E = resistor("E", 0, 500), F = resistor("F", 200, 500);
  const more = [...wires, wire(0, 520, 200, 520)];
  const second = recalculateNets(more, named, first.netAssignments, [A, B, C, D, E, F], DEFS, []);
  assert(second.nets[0].id === named[0].id && second.nets[0].name === "SIG" && second.nets[1].id === named[1].id, "existing nets keep order and names");
  assert(second.nets.length === 3, "new net appended");
}

// ── 6. Nudging past a foreign wire end never grabs it ──
{
  const A = resistor("A", 0, 100);            // A.2 at (0,120)
  const F1 = resistor("F1", 100, 200), F2 = resistor("F2", 100, 400);
  const own = wire(0, 120, 0, 160);           // hangs off A.2, loose end at (0,160)
  const foreign = wire(100, 220, 100, 380);
  const comps = [A, F1, F2];
  const { stat, movingPoints } = geo.movingAndStaticKeys(comps, DEFS, [], new Set(["A"]), new Set());
  // Five presses right, always re-derived from the start: A.2 passes (100,120) on the way
  const out = geo.moveGeometry([own, foreign], stat, movingPoints, new Set(), shift(100, 0), "n");
  const f = out.find((w) => w.id === foreign.id);
  assert(f.start.x === 100 && f.start.y === 220 && f.end.x === 100 && f.end.y === 380, "foreign wire untouched");
  const o = out.find((w) => w.id === own.id);
  assert(o.start.x === 100 && o.start.y === 120 && o.end.x === 100 && o.end.y === 160, "own loose wire slid along with its pin (its far end was free)");
  assert(out.every(straight), "nothing slanted");
}

// ── 6b. Dragging a segment stretches its neighbours ────
{
  const left = wire(0, 0, 0, 100), across = wire(0, 100, 200, 100), right = wire(200, 100, 200, 0);
  const wires = [left, across, right];
  const r = geo.moveGeometry(wires, new Set(), [], new Set([across.id]), shift(0, 40), "n");
  const a = r.find((w) => w.id === across.id);
  const l = r.find((w) => w.id === left.id);
  const rt = r.find((w) => w.id === right.id);
  assert(a.start.y === 140 && a.end.y === 140, "selected segment moved");
  assert(l.end.y === 140 && l.start.y === 0 && rt.start.y === 140 && rt.end.y === 0, "neighbouring segments stretched to follow, far ends stayed");
  assert(r.length === 3, "no extra legs were needed");
}

// ── 6c. Useless splits are joined back together ────────
{
  // The "many-wire-segments" project after the v3 split: a straight run
  // broken at (400,420) for no reason, plus real corners.
  const ws = [
    wire(400, 420, 340, 420), wire(340, 420, 340, 360),
    wire(400, 420, 440, 420), wire(440, 420, 540, 420), wire(540, 420, 540, 360),
  ];
  const merged = geo.mergeWires(ws, []);
  assert(merged.length === 3, `five segments collapse to three: one run, two corner legs (${merged.length})`);
  const cover = (list) => {
    const seen = new Set();
    for (const w of list) {
      const dx = Math.sign(w.end.x - w.start.x), dy = Math.sign(w.end.y - w.start.y);
      for (let x = w.start.x, y = w.start.y; ; x += dx * 20, y += dy * 20) {
        seen.add(`${x},${y}`);
        if (x === w.end.x && y === w.end.y) break;
      }
    }
    return [...seen].sort().join(" ");
  };
  assert(cover(ws) === cover(merged), "the drawn path is identical after merging");
  assert(merged.every((w) => w.start.x === w.end.x || w.start.y === w.end.y), "merged wires are straight");
}

// ── 6d. Merging never crosses a junction, pin, flag or corner ──
{
  const t = [wire(0, 100, 100, 100), wire(100, 100, 200, 100), wire(100, 100, 100, 200)];
  assert(geo.mergeWires(t, []).length === 3, "a three-way junction is never merged through");

  const A = resistor("A", 0, 100); // A.2 at (0,120)
  const straight = [wire(-100, 120, 0, 120), wire(0, 120, 100, 120)];
  const anchors = geo.anchorPoints([A], DEFS, []);
  assert(geo.mergeWires(straight, anchors).length === 2, "a pin between two segments keeps them apart");
  assert(geo.mergeWires(straight, []).length === 1, "without the pin they join");

  const flagAnchors = geo.anchorPoints([], DEFS, [{ id: "l", kind: "label", name: "N", pos: { x: 0, y: 120 }, rotation: 0 }]);
  assert(geo.mergeWires(straight, flagAnchors).length === 2, "a flag between two segments keeps them apart");

  const corner = [wire(0, 0, 100, 0), wire(100, 0, 100, 100)];
  assert(geo.mergeWires(corner, []).length === 2, "a corner stays two wires");

  const fold = [wire(0, 0, 100, 0), wire(100, 0, 50, 0)];
  assert(geo.mergeWires(fold, []).length === 2, "a wire folding back on itself is left alone");
}

// ── 7. Rotating a selection keeps wires on the pins ────
{
  const A = resistor("A", 0, 100), B = resistor("B", 200, 100);
  const wires = [wire(0, 120, 200, 120)];
  const r = geo.transformSelection([A, B], DEFS, [], wires, new Set(["A", "B"]), new Set([wires[0].id]), new Set(), "rotate", "n");
  const pins = geo.schematicPinPoints(r.components, DEFS).map((p) => p.key);
  const w = r.schematicWires[0];
  const sk = `${w.start.x},${w.start.y}`, ek = `${w.end.x},${w.end.y}`;
  assert(pins.includes(sk) && pins.includes(ek), `rotated wire still ends on pins (${sk} ${ek}; pins ${pins.join(" ")})`);
  assert(r.components.every((c) => c.schematicRotation === 90), "components rotated by 90");
  const m = geo.transformSelection([A, B], DEFS, [], wires, new Set(["A", "B"]), new Set([wires[0].id]), new Set(), "mirror", "n");
  const mp = geo.schematicPinPoints(m.components, DEFS).map((p) => p.key);
  const mw = m.schematicWires[0];
  assert(mp.includes(`${mw.start.x},${mw.start.y}`) && mp.includes(`${mw.end.x},${mw.end.y}`), "mirrored wire still ends on pins");
}

// ── 8. Loading old projects preserves their nets exactly ──
// Old rules: every wire point (start, bend, end) unions; a pin on any of them
// is in the net. New rules after "load" normalization must give the same
// pin groups for every saved project in the corpus directory.
{
  const dir = process.env.CORPUS_DIR;
  if (!dir || !fs.existsSync(dir) || !process.env.MIGRATED_DIR) {
    console.log("  skip corpus check (set CORPUS_DIR to v2 project JSON files and MIGRATED_DIR to their backend-migrated copies)");
  } else {
    class UF {
      constructor() { this.p = new Map(); }
      find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
      union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
    }
    const key = (p) => `${Math.round(p.x)},${Math.round(p.y)}`;
    function oldGroups(wires, comps, defs) {
      const uf = new UF();
      const wirePointKeys = [];
      const v2Points = (w) => {
        const a = w.start, b = w.end;
        if (a.x === b.x || a.y === b.y) return [a, b];
        const bend = w.routeDirection === "vertical-first" ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
        return [a, bend, b];
      };
      for (const w of wires) {
        const pts = v2Points(w).map(key);
        for (const k of pts) { uf.find(k); wirePointKeys.push(k); }
        for (let i = 1; i < pts.length; i++) uf.union(pts[0], pts[i]);
      }
      const wireRoots = new Set(wirePointKeys.map((k) => uf.find(k)));
      const groups = new Map();
      for (const comp of comps) {
        const def = resolveComponentDef(comp, defs);
        if (!def) continue;
        for (const pin of getRotatedPinPositions(def.symbol, comp.schematicRotation ?? 0, comp.schematicMirrored ?? false)) {
          const k = key({ x: comp.schematicPos.x + pin.x, y: comp.schematicPos.y + pin.y });
          const root = uf.find(k);
          if (!groups.has(root)) groups.set(root, new Set());
          groups.get(root).add(`${comp.id}:${pin.pinId}`);
        }
      }
      // Old rules, plus the one deliberate change: pins on one point are a net
      return [...groups.entries()].filter(([root, g]) => wireRoots.has(root) || g.size >= 2).map(([, g]) => [...g].sort().join(",")).sort();
    }
    const migratedDir = process.env.MIGRATED_DIR;
    let checked = 0, mismatches = 0, splits = 0, touchProjects = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const migratedPath = migratedDir ? path.join(migratedDir, f) : null;
      if (!migratedPath || !fs.existsSync(migratedPath)) continue;
      const migrated = JSON.parse(fs.readFileSync(migratedPath, "utf8"));
      const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
      const customDefs = (data.componentDefs ?? []).filter((d) => !defaultIds.has(d.id));
      for (const def of customDefs) {
        if (def.symbol.startsWith("custom-footprint-")) {
          registerCustomSymbol(def.id, { ...createFootprintSymbol(def.pins, def.width, def.height), symbolId: def.symbol });
        }
      }
      const defs = [...DEFAULT_COMPONENTS, ...customDefs];
      const comps = (data.components ?? []).map((c) => ({ ...c, schematicRotation: c.schematicRotation ?? 0 }));
      // A net of a single pin connects nothing (an old zero-length wire on a
      // lone pin); dropping one loses no connection.
      const real = (groups) => groups.filter((g) => g.includes(","));
      const before = real(oldGroups(data.schematicWires ?? [], comps, defs));
      // Straight from the backend migration: must be identical
      const asMigrated = groupsOf(recalculateNets(migrated.schematicWires, data.nets ?? [], data.netAssignments ?? [], comps, defs, []));
      checked++;
      const compare = (stage, afterAll) => {
        const after = real(afterAll);
        if (before.join("|") === after.join("|")) return true;
        const b = new Set(before), a = new Set(after);
        const lost = before.filter((g) => !a.has(g));
        const added = after.filter((g) => !b.has(g));
        mismatches++;
        console.log(`  MISMATCH ${f} after ${stage}: before ${before.length} nets, after ${after.length}`);
        for (const g of lost) console.log("    old only: " + g);
        for (const g of added) console.log("    new only: " + g);
        return false;
      };
      if (!compare("backend migration", asMigrated)) continue;
      // The editor's own settle under the rule set the migration chose: a
      // "touch" project must settle to the same nets (that is what the choice
      // promised), a "classic" one only merges segments
      if (migrated.wiring !== "classic" && migrated.wiring !== "touch") { mismatches++; console.log(`  MISMATCH ${f}: no wiring rule set`); continue; }
      const anchors = geo.anchorPoints(comps, defs, []);
      const settled = geo.mergeWires(geo.normalizeWires(migrated.schematicWires, anchors, newId, migrated.wiring === "touch"), anchors);
      if (migrated.wiring === "touch") touchProjects++;
      splits += settled.length - migrated.schematicWires.length;
      compare("settle", groupsOf(recalculateNets(settled, data.nets ?? [], data.netAssignments ?? [], comps, defs, [])));
    }
    assert(mismatches === 0, `nets identical after the backend v3 migration and a settle under its chosen rule set on ${checked} projects (${touchProjects} touch, ${checked - touchProjects} classic; wire count delta ${splits})`);
  }
}

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log("\nall passed");
