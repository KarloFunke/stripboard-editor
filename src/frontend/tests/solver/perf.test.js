// Performance reference: a mid-size board with 2 ICs, a locked header and
// 10 flexibles. Asserts correctness and reports wall-clock so perf
// regressions are visible in the test output.
const {
  computeAutoLayout, DEFS,
  flex, rigid, net, assign, emptyBoard,
  applyLayout, verify, checkGeometry, assert, finish,
} = require("./helpers.js");

const u1 = rigid("dip8", "U1");
const u2 = rigid("dip8", "U2");
const j1 = { ...rigid("hdr4", "J1"), boardPos: { row: 0, col: 0 }, locked: true };

const flexSpecs = [
  ["def-resistor", "n1", "n9"],
  ["def-resistor", "n2", "n10"],
  ["def-resistor", "n3", "n11"],
  ["def-capacitor", "n4", "n12"],
  ["def-capacitor", "n5", "n13"],
  ["def-capacitor", "n6", "n14"],
  ["def-resistor", "n7", "n15"],
  ["def-capacitor", "n8", "n16"],
  ["def-resistor", "n9", "n16"],
  ["def-capacitor", "n10", "n15"],
];

const nets = [];
const asg = [];
for (let i = 1; i <= 16; i++) nets.push(net(`n${i}`));
// U1 pins 1-8 on n1..n8, U2 pins 1-8 on n9..n16
for (let i = 1; i <= 8; i++) asg.push(assign(`n${i}`, u1, `${i}`));
for (let i = 1; i <= 8; i++) asg.push(assign(`n${i + 8}`, u2, `${i}`));
// Locked header taps n1..n4
for (let i = 1; i <= 4; i++) asg.push(assign(`n${i}`, j1, `${i}`));

const flexParts = flexSpecs.map(([defId, a, b], i) => {
  const p = flex(defId, `F${i + 1}`);
  asg.push(assign(a, p, "1"), assign(b, p, "2"));
  return p;
});

const components = [u1, u2, j1, ...flexParts];
const board = emptyBoard(24, 24);

const t0 = Date.now();
const res = computeAutoLayout(board, components, DEFS, nets, asg);
const elapsed = Date.now() - t0;

const { board: b2, components: c2 } = applyLayout(board, components, res);
const v = verify(b2, c2, nets, asg);
const geo = checkGeometry(b2, c2);
const unplaced = c2.filter((c) => !c.boardPos && !c.boardExcluded).length;

console.log(`time=${elapsed}ms placements=${res.placements.length} cuts=${res.cuts.length} wires=${res.wires.length} conflicts=${v.conflicts} incomplete=${v.incomplete.length} issues=${JSON.stringify(res.issues)}`);
assert(v.conflicts === 0 && v.incomplete.length === 0 && unplaced === 0, "perf: board fully complete");
assert(geo.length === 0, `perf: geometry clean (${geo.join("; ") || "ok"})`);
const j1After = c2.find((c) => c.id === j1.id);
assert(j1After.boardPos.row === 0 && j1After.boardPos.col === 0, "perf: locked header did not move");

finish("perf");
