// Auto-finish (rung 1): derive cuts + jumper wires for a manual placement.
const {
  computeAutoFinish, DEFS,
  testPin, net, assign, emptyBoard,
  applyFinish, verify, assert, finish,
} = require("./helpers.js");

// ── T1: same net on one strip → nothing to do ──────────
{
  const a = testPin(2, 2), b = testPin(2, 6);
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", b, "1")];
  const board = emptyBoard(10, 10);
  const res = computeAutoFinish(board, [a, b], DEFS, nets, asg);
  assert(res.cuts.length === 0 && res.wires.length === 0 && res.issues.length === 0,
    `T1: complete strip needs nothing (cuts=${res.cuts.length}, wires=${res.wires.length})`);
}

// ── T2: two nets on one strip → exactly one cut between them ──
{
  const a = testPin(3, 1), b = testPin(3, 7);
  const nets = [net("n1"), net("n2")];
  const asg = [assign("n1", a, "1"), assign("n2", b, "1")];
  const board = emptyBoard(10, 10);
  const res = computeAutoFinish(board, [a, b], DEFS, nets, asg);
  assert(res.cuts.length === 1 && res.cuts[0].row === 3 && res.cuts[0].col >= 1 && res.cuts[0].col < 7,
    `T2: one cut between the nets (${JSON.stringify(res.cuts)})`);
  const v = verify(applyFinish(board, res), [a, b], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "T2: board complete after cuts");
}

// ── T3: same net on two strips → one jumper wire ───────
{
  const a = testPin(1, 4), b = testPin(6, 4);
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", b, "1")];
  const board = emptyBoard(10, 10);
  const res = computeAutoFinish(board, [a, b], DEFS, nets, asg);
  assert(res.wires.length === 1, `T3: one jumper derived (${res.wires.length})`);
  const v = verify(applyFinish(board, res), [a, b], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "T3: board complete after jumper");
  const w = res.wires[0];
  const onPin = (p) => (p.row === 1 && p.col === 4) || (p.row === 6 && p.col === 4);
  assert(!onPin(w.from) && !onPin(w.to), "T3: jumper endpoints on free holes, not pin holes");
}

// ── T4: existing cut respected (augment, no duplicate) ──
{
  const a = testPin(4, 1), b = testPin(4, 8);
  const nets = [net("n1"), net("n2")];
  const asg = [assign("n1", a, "1"), assign("n2", b, "1")];
  const board = { ...emptyBoard(10, 10), cuts: [{ row: 4, col: 4 }] };
  const res = computeAutoFinish(board, [a, b], DEFS, nets, asg);
  assert(res.cuts.length === 0, `T4: existing cut between the nets is enough (${res.cuts.length} added)`);
}

// ── T5: unassigned pin on a net's strip gets isolated ──
{
  const a = testPin(5, 1), b = testPin(5, 8);
  const floater = testPin(5, 4); // no assignment: must not join n1's strip
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", b, "1")];
  const board = emptyBoard(10, 10);
  const res = computeAutoFinish(board, [a, b, floater], DEFS, nets, asg);
  const done = applyFinish(board, res);
  const v = verify(done, [a, b, floater], nets, asg);
  assert(res.cuts.length >= 2, `T5: floating pin isolated with cuts (${res.cuts.length})`);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `T5: n1 rejoined around the floater (conflicts=${v.conflicts}, incomplete=${v.incomplete.length})`);
}

// ── T6: cut placement avoids stranding a pin in a body-only segment ──
{
  // Custom rigid: pin at offset (0,2), body cells at (0,0) and (0,1)
  const BODY_DEF = {
    id: "bodypart", name: "BodyPart", category: "ic", symbol: "b", defaultLabelPrefix: "B",
    width: 3, height: 1,
    pins: [{ id: "1", name: "1", offsetRow: 0, offsetCol: 2 }],
    bodyCells: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
  };
  const a = testPin(0, 0); // net A at the row start
  const u = { id: "u1", defId: "bodypart", label: "B1", schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: { row: 0, col: 3 }, rotation: 0, locked: true };
  // B1's pin lands at (0,5) with body over (0,3),(0,4); free gap holes: (0,1),(0,2)
  const bFar = testPin(4, 5); // net B needs a jumper to B1's pin
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a, "1"), assign("nB", u, "1"), assign("nB", bFar, "1")];
  const board = emptyBoard(8, 10);
  const defs = [...DEFS, BODY_DEF];
  const res = computeAutoFinish(board, [a, u, bFar], defs, nets, asg);
  const v = verify(applyFinish(board, res), [a, u, bFar], nets, asg, defs);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `T6: cut keeps a free hole on the body side (conflicts=${v.conflicts}, incomplete=${v.incomplete.length}, issues=${JSON.stringify(res.issues)})`);
}

// ── T7: wires avoid collinear overlap when an alternative exists ──
{
  // Column 0 carries the pins; columns 1-2 are the only wire columns.
  // nA spans rows 0..9, nB rows 3..6 — naive routing overlaps in one column.
  const a1 = testPin(0, 0), a2 = testPin(9, 0);
  const b1 = testPin(3, 0), b2 = testPin(6, 0);
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a1, "1"), assign("nA", a2, "1"), assign("nB", b1, "1"), assign("nB", b2, "1")];
  const board = emptyBoard(10, 3);
  const res = computeAutoFinish(board, [a1, a2, b1, b2], DEFS, nets, asg);
  const v = verify(applyFinish(board, res), [a1, a2, b1, b2], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "T7: both nets complete");
  const { segmentsOverlapCollinear } = require("./helpers.js").flexGeometry;
  let overlaps = 0;
  for (let i = 0; i < res.wires.length; i++) {
    for (let j = i + 1; j < res.wires.length; j++) {
      if (segmentsOverlapCollinear(res.wires[i].from, res.wires[i].to, res.wires[j].from, res.wires[j].to)) overlaps++;
    }
  }
  assert(overlaps === 0, `T7: no collinear wire overlap (${overlaps})`);
}

// ── T8: reserve rule — nets with unplaced parts must keep a free hole ──
{
  // P sits against the board edge; its only free-run hole is drilled out.
  const p = testPin(0, 0);
  const q = testPin(0, 2); // different net right next door forces a cut
  const unplacedCap = { id: "f9", defId: "def-capacitor", label: "C9", schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: null, rotation: 0 };
  const nets = [net("nT"), net("nQ")];
  const asg = [
    assign("nT", p, "1"), assign("nT", unplacedCap, "1"),
    assign("nQ", q, "1"), assign("nQ", unplacedCap, "2"),
  ];
  const board = { ...emptyBoard(6, 6), cuts: [{ row: 0, col: 1, kind: "hole" }] };
  const res = computeAutoFinish(board, [p, q, unplacedCap], DEFS, nets, asg);
  assert(res.issues.some((i) => i.includes("no free hole left for further connections")),
    `T8: starved reserve reported (issues=${JSON.stringify(res.issues)})`);
}

// ── T10: scarce nets route first, so nothing is forced into an overlap ──
{
  // nA (rows 0..9) has holes in cols 1 and 2; nB (rows 3..6) only in col 1
  // because col 2 is drilled out on its rows. Routed in array order, nA
  // would grab the col-1 straight and force nB onto an overlap.
  const a1 = testPin(0, 0), a2 = testPin(9, 0);
  const b1 = testPin(3, 0), b2 = testPin(6, 0);
  const nets = [net("nA"), net("nB")];
  const asg = [assign("nA", a1, "1"), assign("nA", a2, "1"), assign("nB", b1, "1"), assign("nB", b2, "1")];
  const board = { ...emptyBoard(10, 3), cuts: [{ row: 3, col: 2, kind: "hole" }, { row: 6, col: 2, kind: "hole" }] };
  const res = computeAutoFinish(board, [a1, a2, b1, b2], DEFS, nets, asg);
  const v = verify(applyFinish(board, res), [a1, a2, b1, b2], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "T10: both nets complete");
  const { segmentsOverlapCollinear } = require("./helpers.js").flexGeometry;
  let overlaps = 0;
  for (let i = 0; i < res.wires.length; i++) {
    for (let j = i + 1; j < res.wires.length; j++) {
      if (segmentsOverlapCollinear(res.wires[i].from, res.wires[i].to, res.wires[j].from, res.wires[j].to)) overlaps++;
    }
  }
  assert(overlaps === 0, `T10: scarce net got the clean path, no overlap (${overlaps})`);
}

// ── T11: wire tidiness formula ─────────────────────────
{
  const { wireExtraLength, segmentIntersectsRect } = require("./helpers.js").flexGeometry;
  const none = { rects: [], bodies: [] };
  assert(wireExtraLength({ row: 0, col: 0 }, { row: 8, col: 0 }, none) === 0,
    "T11: vertical wire pays nothing");
  const diag = wireExtraLength({ row: 0, col: 0 }, { row: 1, col: 1 }, none);
  assert(diag > 0 && diag < 1, `T11: one-hole diagonal hop is near-free (${diag.toFixed(2)})`);
  const horiz = wireExtraLength({ row: 0, col: 0 }, { row: 0, col: 8 }, none);
  assert(horiz > 10, `T11: horizontal travel pays double beyond the free hole (${horiz.toFixed(2)})`);
  const longOff = wireExtraLength({ row: 0, col: 0 }, { row: 1, col: 10 }, none);
  assert(longOff > 15, `T11: long slanted wire pays heavily (${longOff.toFixed(2)})`);
  const rect = { minRow: 2, minCol: 2, maxRow: 5, maxCol: 5 };
  assert(segmentIntersectsRect({ row: 0, col: 3 }, { row: 7, col: 3 }, rect),
    "T11: vertical wire through a footprint detected");
  assert(!segmentIntersectsRect({ row: 0, col: 6 }, { row: 7, col: 6 }, rect),
    "T11: wire beside a footprint not flagged");
  const { WIRE_CROSS_EXTRA } = require("./helpers.js").flexGeometry;
  const crossing = wireExtraLength({ row: 0, col: 3 }, { row: 7, col: 3 }, { rects: [rect], bodies: [] });
  assert(crossing === WIRE_CROSS_EXTRA, `T11: crossing a component costs WIRE_CROSS_EXTRA effective holes (${crossing})`);
}

// ── T12: wires detour around components when a clean path exists ──
{
  // Net X must jumper from row 0 to a row-9 segment (cols 2..5) that sits
  // directly below a DIP (rect rows 3-6, cols 1-4). Endpoints at cols 2 and
  // 4 cross the DIP, col 5 does not — all are distance 9, and the crossing
  // pair is found first, so only the crossing penalty forces the detour.
  const u1 = { ...testPin(0, 0), id: "u1", defId: "dip8", label: "U1", boardPos: { row: 3, col: 1 } };
  const p1 = testPin(0, 3), p2 = testPin(9, 3);
  const nets = [net("nX")];
  const asg = [assign("nX", p1, "1"), assign("nX", p2, "1")];
  const board = { ...emptyBoard(10, 10), cuts: [{ row: 9, col: 1 }, { row: 9, col: 5 }] };
  const res = computeAutoFinish(board, [u1, p1, p2], DEFS, nets, asg);
  const v = verify(applyFinish(board, res), [u1, p1, p2], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "T12: net complete");
  const { segmentIntersectsRect } = require("./helpers.js").flexGeometry;
  const dipRect = { minRow: 3, minCol: 1, maxRow: 6, maxCol: 4 };
  const crossings = res.wires.filter((w) => segmentIntersectsRect(w.from, w.to, dipRect)).length;
  assert(crossings === 0, `T12: jumper detours around the DIP (${crossings} crossing)`);
}

// ── T9: nothing pending → no reserve demands ───────────
{
  const a = testPin(2, 0), b = testPin(2, 5);
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", b, "1")];
  const board = emptyBoard(4, 6);
  const res = computeAutoFinish(board, [a, b], DEFS, nets, asg);
  assert(res.issues.length === 0, `T9: no reserve demand once nothing is pending (${JSON.stringify(res.issues)})`);
}

finish("autofinish");
