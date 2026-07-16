// Density stress: the same circuit must complete on shrinking boards.
// This is the canary for search/repair regressions — historically the
// tight boards fail first when pruning hides the fixing move.
const {
  computeAutoLayout, DEFS,
  flex, rigid, net, assign, emptyBoard,
  applyLayout, verify, checkGeometry, assert, finish,
} = require("./helpers.js");

function buildCircuit() {
  const u1 = rigid("dip8", "U1");
  const j1 = rigid("hdr4", "J1");
  const flexParts = [
    { part: flex("def-resistor", "R1"), a: "n1", b: "n5" },
    { part: flex("def-resistor", "R2"), a: "n2", b: "n6" },
    { part: flex("def-capacitor", "C1"), a: "n3", b: "n7" },
    { part: flex("def-capacitor", "C2"), a: "n4", b: "n8" },
    { part: flex("def-capacitor", "C3"), a: "n5", b: "n8" },
    { part: flex("def-resistor", "R3"), a: "n6", b: "n7" },
  ];
  const nets = [];
  const asg = [];
  for (let i = 1; i <= 8; i++) {
    nets.push(net(`n${i}`));
    asg.push(assign(`n${i}`, u1, `${i}`));
  }
  for (let i = 1; i <= 4; i++) asg.push(assign(`n${i}`, j1, `${i}`));
  for (const f of flexParts) {
    asg.push(assign(f.a, f.part, "1"), assign(f.b, f.part, "2"));
  }
  return { components: [u1, j1, ...flexParts.map((f) => f.part)], nets, asg };
}

// ── Two-DIP circuit at the frontier: needs the retry seed ──
// 12x10 with two DIP8s is unsolvable for the default anneal seed (one net
// starves) but solves fully with the retry seed — this mirrors the editor's
// two-wave strategy and is the regression test for multi-seed + repair.
function buildTwoDip() {
  const u1 = rigid("dip8", "U1");
  const u2 = rigid("dip8", "U2");
  const j1 = rigid("hdr4", "J1");
  const flexSpecs = [
    ["def-resistor", "n1", "n9"], ["def-resistor", "n2", "n10"],
    ["def-capacitor", "n3", "n11"], ["def-capacitor", "n4", "n12"],
    ["def-capacitor", "n5", "n13"], ["def-resistor", "n6", "n14"],
    ["def-capacitor", "n7", "n15"], ["def-resistor", "n8", "n16"],
  ];
  const nets = []; const asg = [];
  for (let i = 1; i <= 16; i++) nets.push(net(`n${i}`));
  for (let i = 1; i <= 8; i++) asg.push(assign(`n${i}`, u1, `${i}`));
  for (let i = 1; i <= 8; i++) asg.push(assign(`n${i + 8}`, u2, `${i}`));
  for (let i = 1; i <= 4; i++) asg.push(assign(`n${i}`, j1, `${i}`));
  const parts = flexSpecs.map(([d, a, b], i) => {
    const p = flex(d, `F${i + 1}`);
    asg.push(assign(a, p, "1"), assign(b, p, "2"));
    return p;
  });
  return { components: [u1, u2, j1, ...parts], nets, asg };
}
{
  const RETRY_SEED = 0xbeef;
  const { components, nets, asg } = buildTwoDip();
  const board = emptyBoard(12, 10);
  let res = computeAutoLayout(board, components, DEFS, nets, asg);
  if (res.quality > 0) {
    res = computeAutoLayout(board, components, DEFS, nets, asg, undefined, { seed: RETRY_SEED });
  }
  const { board: b2, components: c2 } = applyLayout(board, components, res);
  const v = verify(b2, c2, nets, asg);
  const geo = checkGeometry(b2, c2);
  console.log(`12x10 two-DIP (with retry seed): incomplete=${v.incomplete.length} conflicts=${v.conflicts} quality=${res.quality}`);
  assert(res.quality === 0 && v.conflicts === 0 && v.incomplete.length === 0,
    "tight 12x10 two-DIP: solved within two seeds");
  assert(geo.length === 0, `tight 12x10 two-DIP: geometry clean (${geo.join("; ") || "ok"})`);
}

for (const [rows, cols] of [[14, 14], [12, 16], [16, 12], [13, 13]]) {
  const { components, nets, asg } = buildCircuit();
  const board = emptyBoard(rows, cols);
  const res = computeAutoLayout(board, components, DEFS, nets, asg);
  const { board: b2, components: c2 } = applyLayout(board, components, res);
  const v = verify(b2, c2, nets, asg);
  const geo = checkGeometry(b2, c2);
  const unplaced = c2.filter((c) => !c.boardPos && !c.boardExcluded).length;
  console.log(`${rows}x${cols}: incomplete=${v.incomplete.length} conflicts=${v.conflicts} unplaced=${unplaced} issues=${JSON.stringify(res.issues)}`);
  assert(v.conflicts === 0 && v.incomplete.length === 0 && unplaced === 0,
    `tight ${rows}x${cols}: fully complete`);
  assert(geo.length === 0, `tight ${rows}x${cols}: geometry clean (${geo.join("; ") || "ok"})`);
}

finish("tight");
