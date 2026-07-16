// v2 strip-first layouter: end-to-end tests. v2 re-places everything and
// chooses the board size itself, so these build unplaced circuits and let
// the solver pick the canvas.
const {
  computeAutoLayout2, DEFS,
  flex, rigid, net, assign, emptyBoard,
  verify, checkGeometry, assert, finish,
} = require("./helpers.js");

function applyV2(components, res) {
  const byId = new Map(res.placements.map((p) => [p.componentId, p]));
  const unplace = new Set(res.unplaceIds ?? []);
  const board = {
    rows: res.boardSize.rows,
    cols: res.boardSize.cols,
    cuts: res.cuts,
    wires: res.wires.map((w, i) => ({ id: `w${i}`, ...w })),
  };
  const comps = components.map((c) => {
    if (unplace.has(c.id)) return { ...c, boardPos: null, flexibleEndPos: undefined };
    const p = byId.get(c.id);
    if (!p) return c;
    return {
      ...c,
      boardPos: p.boardPos,
      ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
      ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}),
    };
  });
  return { board, comps };
}

function runAndCheck(label, components, nets, asg) {
  const res = computeAutoLayout2(emptyBoard(10, 10), components, DEFS, nets, asg);
  const { board, comps } = applyV2(components, res);
  const v = verify(board, comps, nets, asg);
  const geo = checkGeometry(board, comps);
  const inBounds = comps.every((c) => {
    if (!c.boardPos) return true;
    const ok = (p) => p.row >= 0 && p.row < board.rows && p.col >= 0 && p.col < board.cols;
    return ok(c.boardPos) && (!c.flexibleEndPos || ok(c.flexibleEndPos));
  });
  assert(res.quality === 0 && v.conflicts === 0 && v.incomplete.length === 0,
    `${label}: complete (quality=${res.quality}, conflicts=${v.conflicts}, incomplete=${v.incomplete.length}, issues=${JSON.stringify(res.issues)})`);
  assert(geo.length === 0, `${label}: geometry clean (${geo.join("; ") || "ok"})`);
  assert(inBounds, `${label}: everything inside the chosen ${board.rows}x${board.cols} board`);
  // a placement must fully specify the part: an omitted flexibleEndPos means
  // "keep the stale end from the previous layout" in the store
  const fullySpecified = res.placements.every((p) => p.rotation !== undefined || p.flexibleEndPos !== undefined);
  assert(fullySpecified, `${label}: every placement carries rotation or a flexible end`);
  return res;
}

// ── V1: taps bridged by a resistor ─────────────────────
{
  const a = rigid("tp", "TP1"), b = rigid("tp", "TP2");
  const r1 = flex("def-resistor", "R1");
  const nets = [net("n1"), net("n2")];
  const asg = [assign("n1", a, "1"), assign("n2", b, "1"), assign("n1", r1, "1"), assign("n2", r1, "2")];
  runAndCheck("V1", [a, b, r1], nets, asg);
}

// ── V2: IC block with passives ─────────────────────────
{
  const u1 = rigid("dip8", "U1");
  const taps = [rigid("tp", "TP1"), rigid("tp", "TP2")];
  const parts = [flex("def-capacitor", "C1"), flex("def-capacitor", "C2"), flex("def-resistor", "R1")];
  const nets = [net("n1"), net("n2"), net("n3"), net("n4"), net("n5"), net("n6")];
  const asg = [
    assign("n1", u1, "1"), assign("n2", u1, "2"), assign("n3", u1, "3"), assign("n4", u1, "8"),
    assign("n1", taps[0], "1"), assign("n5", taps[1], "1"),
    assign("n2", parts[0], "1"), assign("n5", parts[0], "2"),
    assign("n3", parts[1], "1"), assign("n6", parts[1], "2"),
    assign("n4", parts[2], "1"), assign("n6", parts[2], "2"),
  ];
  runAndCheck("V2", [u1, ...taps, ...parts], nets, asg);
}

// ── V3: two ICs — exercises the cluster split path ─────
{
  const u1 = rigid("dip8", "U1");
  const u2 = rigid("dip8", "U2");
  const j1 = rigid("hdr4", "J1");
  const flexSpecs = [
    ["def-resistor", "n1", "n9"], ["def-resistor", "n2", "n10"],
    ["def-capacitor", "n3", "n11"], ["def-capacitor", "n4", "n12"],
    ["def-capacitor", "n5", "n13"], ["def-resistor", "n6", "n14"],
    ["def-capacitor", "n7", "n15"], ["def-resistor", "n8", "n16"],
  ];
  const nets = [];
  const asg = [];
  for (let i = 1; i <= 16; i++) nets.push(net(`n${i}`));
  for (let i = 1; i <= 8; i++) asg.push(assign(`n${i}`, u1, `${i}`));
  for (let i = 1; i <= 8; i++) asg.push(assign(`n${i + 8}`, u2, `${i}`));
  for (let i = 1; i <= 4; i++) asg.push(assign(`n${i}`, j1, `${i}`));
  const parts = flexSpecs.map(([d, a, b], i) => {
    const p = flex(d, `F${i + 1}`);
    asg.push(assign(a, p, "1"), assign(b, p, "2"));
    return p;
  });
  runAndCheck("V3", [u1, u2, j1, ...parts], nets, asg);
}

// ── V5: locked board dimensions ────────────────────────
{
  const build = () => {
    const u1 = rigid("dip8", "U1");
    const u2 = rigid("dip8", "U2");
    const j1 = rigid("hdr4", "J1");
    const flexSpecs = [
      ["def-resistor", "n1", "n9"], ["def-resistor", "n2", "n10"],
      ["def-capacitor", "n3", "n11"], ["def-capacitor", "n4", "n12"],
      ["def-capacitor", "n5", "n13"], ["def-resistor", "n6", "n14"],
      ["def-capacitor", "n7", "n15"], ["def-resistor", "n8", "n16"],
    ];
    const nets = [];
    const asg = [];
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
  };

  // free run needs more than 14 columns; a locked width must be honored
  const free = build();
  const freeRes = computeAutoLayout2(emptyBoard(10, 10), free.components, DEFS, free.nets, free.asg);
  assert(freeRes.boardSize.cols > 14, `V5: free run is wide (${freeRes.boardSize.cols} cols)`);

  const capped = build();
  const cappedRes = computeAutoLayout2(
    { ...emptyBoard(30, 16), lockedCols: true },
    capped.components, DEFS, capped.nets, capped.asg
  );
  const { board, comps } = applyV2(capped.components, cappedRes);
  const v = verify(board, comps, capped.nets, capped.asg);
  const inBounds = comps.every((c) => {
    if (!c.boardPos) return true;
    const ok = (p) => p.row >= 0 && p.row < board.rows && p.col >= 0 && p.col < board.cols;
    return ok(c.boardPos) && (!c.flexibleEndPos || ok(c.flexibleEndPos));
  });
  assert(cappedRes.boardSize.cols === 16,
    `V5: locked width kept exactly (${cappedRes.boardSize.cols} cols, issues=${JSON.stringify(cappedRes.issues)})`);
  assert(cappedRes.quality === 0 && v.conflicts === 0 && v.incomplete.length === 0 && inBounds,
    `V5: capped run still complete (quality=${cappedRes.quality}, conflicts=${v.conflicts}, incomplete=${v.incomplete.length})`);

  // an impossible cap is reported, not silently overflowed
  const tight = build();
  const tightRes = computeAutoLayout2(
    { ...emptyBoard(30, 3), lockedCols: true },
    tight.components, DEFS, tight.nets, tight.asg
  );
  assert(tightRes.issues.some((i) => i.includes("does not fit")),
    `V5: impossible cap reported (issues=${JSON.stringify(tightRes.issues)})`);
}

// ── V6: locked components stay put ─────────────────────
{
  const u1 = rigid("dip8", "U1");
  const taps = [rigid("tp", "TP1"), rigid("tp", "TP2")];
  const parts = [flex("def-capacitor", "C1"), flex("def-capacitor", "C2"), flex("def-resistor", "R1")];
  const nets = [net("n1"), net("n2"), net("n3"), net("n4"), net("n5"), net("n6")];
  const asg = [
    assign("n1", u1, "1"), assign("n2", u1, "2"), assign("n3", u1, "3"), assign("n4", u1, "8"),
    assign("n1", taps[0], "1"), assign("n5", taps[1], "1"),
    assign("n2", parts[0], "1"), assign("n5", parts[0], "2"),
    assign("n3", parts[1], "1"), assign("n6", parts[1], "2"),
    assign("n4", parts[2], "1"), assign("n6", parts[2], "2"),
  ];
  // TP1 is locked far out in a corner the layout would never choose
  const lockedTap = { ...taps[0], boardPos: { row: 18, col: 24 }, locked: true };
  const components = [u1, lockedTap, taps[1], ...parts];
  const res = computeAutoLayout2(emptyBoard(20, 26), components, DEFS, nets, asg);

  assert(!res.placements.some((p) => p.componentId === lockedTap.id),
    "V6: locked part is not among the placements");
  assert(!(res.unplaceIds ?? []).includes(lockedTap.id),
    "V6: locked part is not unplaced");
  assert(res.boardSize.rows >= 19 && res.boardSize.cols >= 25,
    `V6: board still covers the locked part (${res.boardSize.rows}x${res.boardSize.cols})`);
  const { board, comps } = applyV2(components, res);
  const v = verify(board, comps, nets, asg);
  const geo = checkGeometry(board, comps);
  const still = comps.find((c) => c.id === lockedTap.id);
  assert(still.boardPos.row === 18 && still.boardPos.col === 24, "V6: locked part did not move");
  assert(res.quality === 0 && v.conflicts === 0 && v.incomplete.length === 0,
    `V6: complete around the locked part (quality=${res.quality}, conflicts=${v.conflicts}, incomplete=${v.incomplete.length}, issues=${JSON.stringify(res.issues)})`);
  assert(geo.length === 0, `V6: geometry clean (${geo.join("; ") || "ok"})`);
}

// ── V4: determinism ────────────────────────────────────
{
  const a = rigid("tp", "TP1"), b = rigid("tp", "TP2");
  const r1 = flex("def-resistor", "R1");
  const c1 = flex("def-capacitor", "C1");
  const nets = [net("n1"), net("n2"), net("n3")];
  const asg = [
    assign("n1", a, "1"), assign("n3", b, "1"),
    assign("n1", r1, "1"), assign("n2", r1, "2"),
    assign("n2", c1, "1"), assign("n3", c1, "2"),
  ];
  const r1st = computeAutoLayout2(emptyBoard(10, 10), [a, b, r1, c1], DEFS, nets, asg);
  const r2nd = computeAutoLayout2(emptyBoard(10, 10), [a, b, r1, c1], DEFS, nets, asg);
  assert(JSON.stringify(r1st) === JSON.stringify(r2nd), "V4: identical inputs produce identical layouts");
}

finish("v2");
