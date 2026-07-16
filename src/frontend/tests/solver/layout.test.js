// Auto-layout (rungs 3+4): joint placement of flexibles + rigid arrangement.
const {
  computeAutoLayout, DEFS, DIP8_DEF, CONN1_DEF,
  testPin, flex, rigid, net, assign, emptyBoard,
  applyLayout, verify, checkGeometry, assert, finish,
} = require("./helpers.js");

function runAndVerify(label, board, components, nets, assignments, defs) {
  const d = defs ?? DEFS;
  const res = computeAutoLayout(board, components, d, nets, assignments);
  const { board: b2, components: c2 } = applyLayout(board, components, res);
  const v = verify(b2, c2, nets, assignments, d);
  const geo = checkGeometry(b2, c2, d);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `${label}: complete (conflicts=${v.conflicts}, incomplete=${v.incomplete.length}, issues=${JSON.stringify(res.issues)})`);
  assert(geo.length === 0, `${label}: geometry clean (${geo.join("; ") || "ok"})`);
  return { res, b2, c2, v };
}

// ── L1: resistor bridges two anchored nets ─────────────
{
  const a = testPin(2, 2), b = testPin(9, 2);
  const r1 = flex("def-resistor", "R1");
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nB", b, "1"), assign("nA", r1, "1"), assign("nB", r1, "2")];
  runAndVerify("L1", emptyBoard(14, 14), [a, b, r1], nets, asg);
}

// ── L2: cap with short span between adjacent strips ────
{
  const a = testPin(3, 3), b = testPin(5, 3);
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nB", b, "1"), assign("nA", c1, "1"), assign("nB", c1, "2")];
  runAndVerify("L2", emptyBoard(12, 12), [a, b, c1], nets, asg);
}

// ── L3: several flexibles sharing nets (chain) ─────────
{
  const a = testPin(2, 2), b = testPin(10, 10);
  const r1 = flex("def-resistor", "R1");
  const r2 = flex("def-resistor", "R2");
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("n1"), net("n2"), net("n3"), net("n4")];
  const asg = [
    assign("n1", a, "1"),
    assign("n1", r1, "1"), assign("n2", r1, "2"),
    assign("n2", r2, "1"), assign("n3", r2, "2"),
    assign("n3", c1, "1"), assign("n4", c1, "2"),
    assign("n4", b, "1"),
  ];
  runAndVerify("L3", emptyBoard(16, 16), [a, b, r1, r2, c1], nets, asg);
}

// ── L4: part with both pins on the same net ────────────
{
  const a = testPin(4, 4), b = testPin(4, 9);
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", b, "1"), assign("n1", c1, "1"), assign("n1", c1, "2")];
  runAndVerify("L4", emptyBoard(12, 14), [a, b, c1], nets, asg);
}

// ── L5: locked component never moves; placed flexibles may ──
{
  const a = testPin(2, 2), b = testPin(8, 8);
  const r1 = flex("def-resistor", "R1");
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nB", b, "1"), assign("nA", r1, "1"), assign("nB", r1, "2")];
  const board = emptyBoard(14, 14);
  const res = computeAutoLayout(board, [a, b, r1], DEFS, nets, asg);
  assert(!res.placements.some((p) => p.componentId === a.id || p.componentId === b.id),
    "L5: locked anchors were not moved");
}

// ── L6: locked but unplaced part is reported ───────────
{
  const a = testPin(2, 2);
  const r1 = { ...flex("def-resistor", "R1"), locked: true };
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nA", r1, "1"), assign("nB", r1, "2")];
  const res = computeAutoLayout(emptyBoard(10, 10), [a, r1], DEFS, nets, asg);
  assert(res.issues.some((i) => i.includes("locked but not on the board")),
    `L6: locked-unplaced reported (${JSON.stringify(res.issues)})`);
  assert(!res.placements.some((p) => p.componentId === r1.id), "L6: locked part not placed");
}

// ── L7: unwired flexible is skipped with a message ─────
{
  const a = testPin(2, 2), b = testPin(6, 2);
  const r1 = flex("def-resistor", "R1"); // no assignments at all
  const nets = [net("nA")];
  const asg = [assign("nA", a, "1"), assign("nA", b, "1")];
  const res = computeAutoLayout(emptyBoard(10, 10), [a, b, r1], DEFS, nets, asg);
  assert(res.issues.some((i) => i.includes("not fully wired")), `L7: unwired part reported`);
  assert(!res.placements.some((p) => p.componentId === r1.id), "L7: unwired part not placed");
}

// ── L8: rigid DIP gets placed and its nets completed ───
{
  const u1 = rigid("dip8", "U1");
  const anchors = [];
  const nets = [];
  const asg = [];
  // Four of the DIP's nets have off-chip anchors
  for (let i = 0; i < 4; i++) {
    const n = net(`n${i + 1}`);
    nets.push(n);
    const a = testPin(10 + (i % 2), 2 + i * 3);
    anchors.push(a);
    asg.push(assign(n.id, a, "1"), assign(n.id, u1, `${i + 1}`));
  }
  runAndVerify("L8", emptyBoard(14, 18), [u1, ...anchors], nets, asg);
}

// ── L9: stage A keeps spring nets within the resistor's span ──
{
  // Two rigid single-pin clusters joined only by a resistor (span 5-10):
  // the annealer must not crush the nets together nor share their row.
  const u1 = rigid("hdr4", "J1");
  const u2 = rigid("hdr4", "J2");
  const r1 = flex("def-resistor", "R1");
  const nets = [net("n1"), net("n2"), net("n3"), net("n4")];
  const asg = [
    assign("n1", u1, "1"), assign("n2", u1, "2"),
    assign("n3", u2, "1"), assign("n4", u2, "2"),
    assign("n1", r1, "1"), assign("n3", r1, "2"),
  ];
  runAndVerify("L9", emptyBoard(16, 16), [u1, u2, r1], nets, asg);
}

// ── L10: full small circuit — 2 rigids + 4 flexibles ───
{
  const u1 = rigid("dip8", "U1");
  const j1 = rigid("hdr4", "J1");
  const parts = [flex("def-resistor", "R1"), flex("def-resistor", "R2"), flex("def-capacitor", "C1"), flex("def-capacitor", "C2")];
  const nets = [net("n1"), net("n2"), net("n3"), net("n4"), net("n5"), net("n6")];
  const asg = [
    assign("n1", u1, "1"), assign("n2", u1, "2"), assign("n3", u1, "3"), assign("n4", u1, "8"),
    assign("n1", j1, "1"), assign("n5", j1, "2"), assign("n6", j1, "3"),
    assign("n2", parts[0], "1"), assign("n5", parts[0], "2"),
    assign("n3", parts[1], "1"), assign("n6", parts[1], "2"),
    assign("n4", parts[2], "1"), assign("n5", parts[2], "2"),
    assign("n1", parts[3], "1"), assign("n6", parts[3], "2"),
  ];
  runAndVerify("L10", emptyBoard(18, 18), [u1, j1, ...parts], nets, asg);
}

// ── L11: regenerate semantics — stale cuts/wires replaced ──
{
  const a = testPin(2, 2), b = testPin(9, 2);
  const r1 = flex("def-resistor", "R1");
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nB", b, "1"), assign("nA", r1, "1"), assign("nB", r1, "2")];
  const dirty = {
    ...emptyBoard(14, 14),
    cuts: [{ row: 0, col: 0 }, { row: 13, col: 5 }],
    wires: [{ id: "junk", from: { row: 0, col: 1 }, to: { row: 13, col: 1 } }],
  };
  const { res } = runAndVerify("L11", dirty, [a, b, r1], nets, asg);
  const keptJunkCut = res.cuts.some((c) => c.row === 0 && c.col === 0);
  assert(!keptJunkCut || res.cuts.length < 3, "L11: stale cuts not blindly carried over");
}

// ── L14: DIP is never mounted along the strips ─────────
{
  const u1 = rigid("dip8", "U1");
  const anchors = [];
  const nets = [];
  const asg = [];
  for (let i = 0; i < 8; i++) {
    const n = net(`n${i + 1}`);
    nets.push(n);
    const a = testPin(12, 2 + i * 2);
    anchors.push(a);
    asg.push(assign(n.id, a, "1"), assign(n.id, u1, `${i + 1}`));
  }
  const board = emptyBoard(14, 22);
  const res = computeAutoLayout(board, [u1, ...anchors], DEFS, nets, asg);
  const icPlacement = res.placements.find((p) => p.componentId === u1.id);
  assert(!!icPlacement, "L14: IC placed");
  if (icPlacement) {
    assert(icPlacement.rotation % 180 === 0,
      `L14: IC mounted across the strips (rotation ${icPlacement.rotation})`);
  }
}

// ── L15: connectors are placed on the board's outside ──
{
  const j1 = rigid("def-connector-1", "tone");
  const a1 = testPin(7, 7), a2 = testPin(8, 7);
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a1, "1"), assign("nB", a2, "1"), assign("nA", j1, "1")];
  const board = emptyBoard(15, 15);
  const res = computeAutoLayout(board, [j1, a1, a2], DEFS, nets, asg);
  const p = res.placements.find((x) => x.componentId === j1.id);
  assert(!!p, "L15: connector placed");
  if (p) {
    const edgeDist = Math.min(p.boardPos.row, p.boardPos.col, 14 - p.boardPos.row, 14 - p.boardPos.col);
    assert(edgeDist === 0, `L15: connector on the edge (edge distance ${edgeDist}, at ${JSON.stringify(p.boardPos)})`);
  }
}

// ── L16: pin guard — never swallow the last free hole of a pin's run ──
// P's run has exactly one free hole (2,1); net T also has a far pin Q, so a
// jumper MUST end on (2,1). The cap's cheapest spot for pin 1 is exactly
// there (adjacent to T copper) — the guard has to push it elsewhere.
{
  const jA = testPin(2, 0), P = testPin(2, 2), jB = testPin(2, 3);
  const Q = testPin(6, 6), S = testPin(5, 5);
  const cap = flex("def-capacitor", "C1");
  const components = [jA, P, jB, Q, S, cap];
  const nets = [net("nX"), net("nT"), net("nY"), net("nZ")];
  const asg = [
    assign("nX", jA, "1"),
    assign("nT", P, "1"), assign("nT", Q, "1"), assign("nT", cap, "1"),
    assign("nY", jB, "1"),
    assign("nZ", S, "1"), assign("nZ", cap, "2"),
  ];
  const board = emptyBoard(8, 8);
  const res = computeAutoLayout(board, components, DEFS, nets, asg);
  const p = res.placements.find((x) => x.componentId === cap.id);
  assert(!!p, "L16: cap placed");
  const covers21 = res.placements.some((x) =>
    (x.boardPos.row === 2 && x.boardPos.col === 1) ||
    (x.flexibleEndPos && x.flexibleEndPos.row === 2 && x.flexibleEndPos.col === 1));
  assert(!covers21, "L16: last free hole of P's run kept free of part pins");
  const wireAt21 = res.wires.some((w) =>
    (w.from.row === 2 && w.from.col === 1) || (w.to.row === 2 && w.to.col === 1));
  assert(wireAt21, "L16: jumper for net T attaches at the guarded hole");
  const { board: b2, components: c2 } = applyLayout(board, components, res);
  const v = verify(b2, c2, nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `L16: board complete (conflicts=${v.conflicts}, incomplete=${v.incomplete.length})`);
}

// ── L18: scoped run — everything outside onlyIds stays put ──
{
  const a = testPin(2, 2), b = testPin(9, 9);
  const r1 = { ...flex("def-resistor", "R1"), boardPos: { row: 2, col: 4 }, flexibleEndPos: { row: 7, col: 4 } };
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("n1"), net("n2"), net("n3")];
  const asg = [
    assign("n1", a, "1"), assign("n3", b, "1"),
    assign("n1", r1, "1"), assign("n2", r1, "2"),
    assign("n2", c1, "1"), assign("n3", c1, "2"),
  ];
  const board = emptyBoard(14, 14);
  const res = computeAutoLayout(board, [a, b, r1, c1], DEFS, nets, asg, undefined, { onlyIds: [c1.id] });
  assert(!res.placements.some((p) => p.componentId === r1.id || p.componentId === a.id || p.componentId === b.id),
    "L18: out-of-scope parts untouched");
  assert(res.placements.some((p) => p.componentId === c1.id), "L18: in-scope part placed");
  assert(!res.issues.some((i) => i.includes("locked but not on the board")),
    `L18: no spurious lock warnings (${JSON.stringify(res.issues)})`);
  const { board: b2, components: c2 } = applyLayout(board, [a, b, r1, c1], res);
  const v = verify(b2, c2, nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `L18: board complete (conflicts=${v.conflicts}, incomplete=${v.incomplete.length})`);
}

// ── L17: determinism — same input, same output ─────────
{
  const a = testPin(2, 2), b = testPin(9, 9);
  const r1 = flex("def-resistor", "R1");
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("n1"), net("n2"), net("n3")];
  const asg = [
    assign("n1", a, "1"), assign("n3", b, "1"),
    assign("n1", r1, "1"), assign("n2", r1, "2"),
    assign("n2", c1, "1"), assign("n3", c1, "2"),
  ];
  const board = emptyBoard(14, 14);
  const res1 = computeAutoLayout(board, [a, b, r1, c1], DEFS, nets, asg);
  const res2 = computeAutoLayout(board, [a, b, r1, c1], DEFS, nets, asg);
  assert(JSON.stringify(res1) === JSON.stringify(res2), "L17: identical inputs produce identical layouts");
}

finish("layout");
