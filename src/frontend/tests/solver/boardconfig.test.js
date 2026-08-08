// The board map: the way a custom board is described. These assert on what
// the map compiles to — which holes exist, what copper joins them — and on
// what the rest of the editor then makes of it.
const path = require("path");
const {
  computeStripSegments, computeAutoFinish, computeAutoLayout2, DEFS,
  testPin, net, assign, emptyBoard, flex, rigid,
  applyFinish, applyLayout, verify, checkGeometry, assert, finish,
} = require("./helpers.js");

const OUT = path.join(__dirname, "out");
const { BOARD_PRESETS, findPreset, presetBoard } = require(path.join(OUT, "components/stripboard/boardPresets.js"));
const { parseBoardMap, formatBoardMap } = require(path.join(OUT, "components/stripboard/boardMap.js"));
const { boardTopology, hasHole, hasHLink, hasVLink, mapSize } =
  require(path.join(OUT, "components/stripboard/boardTopology.js"));
const { cutWouldBeRedundant, hasCustomLayout } =
  require(path.join(OUT, "components/stripboard/boardTopology.js"));
const { shiftLayout } = require(path.join(OUT, "components/stripboard/boardLayoutEdit.js"));
const { segmentContains } = require(path.join(OUT, "components/stripboard/stripSegments.js"));

/** A board whose copper is the given map */
function mapBoard(src, cuts = []) {
  const s = mapSize(src);
  return { ...emptyBoard(s.rows, s.cols), cuts, layout: { map: src } };
}
// The real predicate, so a regression in it fails these tests too.
const segAt = (segs, row, col) => segs.find((s) => segmentContains(s, row, col));
const joined = (segs, a, b) => {
  const sa = segAt(segs, a[0], a[1]);
  return !!sa && sa === segAt(segs, b[0], b[1]);
};

// ── M1: the lattice ────────────────────────────────────
{
  const g = parseBoardMap("0-0-0 0-0\n0-0-0-0-0");
  assert(g.issues.length === 0, `M1: parses clean (${JSON.stringify(g.issues)})`);
  assert(g.rows === 2 && g.cols === 5, `M1: 2 x 5 (${g.rows} x ${g.cols})`);
  const t = boardTopology(mapBoard("0-0-0 0-0\n0-0-0-0-0"));
  assert(hasHLink(t, 0, 1) && !hasHLink(t, 0, 2) && hasHLink(t, 0, 3),
    "M1: the space breaks the run, the dashes join it");
  assert(!hasVLink(t, 0, 0), "M1: nothing runs down a column without a link row");
}

// ── M2: "." is a hole that is not there ────────────────
{
  const b = mapBoard(". 0-0-0 .");
  const t = boardTopology(b);
  assert(!hasHole(t, 0, 0) && hasHole(t, 0, 1) && !hasHole(t, 0, 4), "M2: dots leave no hole");
  const segs = computeStripSegments(b, [], DEFS, []);
  assert(segs.length === 1, `M2: only the run of three is copper (${segs.length})`);
  assert(joined(segs, [0, 1], [0, 3]), "M2: and it is one piece");
}

// ── M3: a link row carries copper down a column ────────
{
  const src = "P 0-0-0\n|\nP 0-0-0\n|\nP 0-0-0";
  const b = mapBoard(src);
  const segs = computeStripSegments(b, [], DEFS, []);
  assert(joined(segs, [0, 0], [2, 0]), "M3: the tagged column is one bus");
  assert(!joined(segs, [0, 0], [0, 1]), "M3: and the row run beside it is separate");
  assert(joined(segs, [0, 1], [0, 3]), "M3: which is itself joined end to end");
  const bus = segAt(segs, 0, 0);
  assert(bus.label === "P", `M3: the bus carries its tag (${bus.label})`);
  assert(bus.endRow === 2, `M3: and spans the rows it was drawn over (${bus.endRow})`);
}

// ── M4: a link reaching for a missing hole is ignored ───
// This is what lets a rail be written as a plain repeat: it stops itself.
{
  const b = mapBoard("P 0-0\n|\nP 0-0\n|\n. 0-0");
  const t = boardTopology(b);
  assert(hasVLink(t, 0, 0), "M4: the link between two real holes stands");
  assert(!hasVLink(t, 1, 0), "M4: the link into the missing hole is dropped");
}

// ── M5: copper that bends is still one segment ─────────
{
  const b = mapBoard("0-0-0\n    |\n. . 0-0");
  const segs = computeStripSegments(b, [], DEFS, []);
  assert(segs.length === 1, `M5: the bent run is one piece of copper (${segs.length})`);
  const s = segs[0];
  assert(Array.isArray(s.holes) && s.holes.length === 5,
    `M5: it lists its holes, since its box is not solid (${s.holes?.length})`);
  assert(joined(segs, [0, 0], [1, 3]), "M5: and both ends are connected");
  assert(!segAt(segs, 1, 0), "M5: without claiming the empty corner");
}

// ── M6: snap lines sit between holes, not on them ─────
{
  const b = mapBoard("0-0:0-0\n:::::::\n0-0:0-0");
  const t = boardTopology(b);
  assert(t.rows === 2 && t.cols === 4,
    `M6: a V-cut is a groove, so it costs no row or column (${t.cols} x ${t.rows})`);
  assert(t.snapX.length === 1 && t.snapX[0] === 1.5, `M6: snap between columns 1 and 2 (${t.snapX})`);
  assert(t.snapY.length === 1 && t.snapY[0] === 0.5, `M6: snap between rows 0 and 1 (${t.snapY})`);
  assert(hasHole(t, 0, 1) && hasHole(t, 0, 2), "M6: the holes either side of it are still there");
  const segs = computeStripSegments(b, [], DEFS, []);
  assert(!joined(segs, [0, 1], [0, 2]), "M6: and no copper crosses it");
  assert(joined(segs, [0, 0], [0, 1]), "M6: while the copper beside it is untouched");
  // A ":" on a hole is a mistake worth naming, not a hole quietly dropped.
  const onHole = parseBoardMap("0-:-0");
  assert(onHole.issues.some((i) => /between two holes/.test(i.message)),
    `M6: ":" on a hole is rejected (${JSON.stringify(onHole.issues)})`);
}

// ── M6b: a link row takes its width from the board ────
// It sits between two rows; it does not have to be drawn to full length,
// and a long one must not be mistaken for the widest line on the map.
{
  const short = parseBoardMap("0-0-0-0-0\n:\n0-0-0-0-0");
  assert(short.cols === 5, `M6b: one colon marks the boundary just as well (${short.cols})`);
  assert(short.snapY.length === 1 && short.snapY[0] === 0.5, `M6b: and still records it (${short.snapY})`);
  const over = parseBoardMap("0-0-0-0-0\n:::::::::::::::::::\n0-0-0-0-0");
  assert(over.cols === 5, `M6b: nor does an over-long one widen the board (${over.cols})`);
  assert(over.rows === 2, `M6b: and it is still two rows, not three (${over.rows})`);
}

// ── M7: macros ─────────────────────────────────────────
{
  const src = [
    "define pair = 0-0",
    "define block",
    "  {pair} {pair}",
    "  repeat 2",
    "    {pair} {pair}",
    "  end",
    "end",
    "{block}",
  ].join("\n");
  const g = parseBoardMap(src);
  assert(g.issues.length === 0, `M7: parses clean (${JSON.stringify(g.issues)})`);
  assert(g.rows === 3 && g.cols === 4, `M7: define + repeat expand (${g.rows} x ${g.cols})`);
  // Indentation inside blocks must not shift the picture sideways.
  const t = boardTopology(mapBoard(src));
  for (let r = 0; r < 3; r++) {
    assert(hasHole(t, r, 0) && hasHLink(t, r, 0) && !hasHLink(t, r, 1),
      `M7: row ${r} is not shifted by its indentation`);
  }
}

// ── M7b: blocks stand side by side ─────────────────────
{
  const src = [
    "define col",
    "  0-0",
    "  0-0",
    "end",
    "{col}:{col}",
  ].join("\n");
  const g = parseBoardMap(src);
  assert(g.issues.length === 0, `M7b: parses clean (${JSON.stringify(g.issues)})`);
  assert(g.rows === 2 && g.cols === 4, `M7b: two 2-wide blocks across a V-cut (${g.cols} x ${g.rows})`);
  const t = boardTopology(mapBoard(src));
  assert(hasHLink(t, 0, 0) && !hasHLink(t, 0, 1) && hasHLink(t, 0, 2),
    "M7b: each block keeps its own copper, the separator joins nothing");
  assert(t.snapX.length === 1 && t.snapX[0] === 1.5, `M7b: and it reads as a snap on the boundary (${t.snapX})`);

  // Ragged blocks must be padded, or everything to their right slides.
  const raggedSrc = ["define b", "  0-0-0", "  0", "end", "{b}:{b}"].join("\n");
  const ragged = parseBoardMap(raggedSrc);
  assert(ragged.cols === 6, `M7b: a short row inside a block is padded, not collapsed (${ragged.cols})`);
  const rt = boardTopology({ ...emptyBoard(2, 6), layout: { map: raggedSrc } });
  assert(hasHole(rt, 1, 3) && !hasHole(rt, 1, 4),
    "M7b: the second block still starts in the right column on the short row");

  // A one-line block repeats down the height of the tall ones beside it.
  const bcast = parseBoardMap(["define tall", "  0-0", "  0-0", "end", "define pad = .", "{tall} {pad} {tall}"].join("\n"));
  assert(bcast.rows === 2 && bcast.cols === 5, `M7b: a one-line block repeats down (${bcast.cols} x ${bcast.rows})`);

  // Two tall blocks of different heights cannot line up.
  const bad = parseBoardMap(["define a", "  0", "  0", "end", "define b", "  0", "  0", "  0", "end", "{a} {b}"].join("\n"));
  assert(bad.issues.some((i) => /same height/.test(i.message)),
    `M7b: mismatched heights are reported (${JSON.stringify(bad.issues)})`);
}

// ── M8: errors point at the line they came from ────────
{
  const a = parseBoardMap("0-0\n{nope}");
  assert(a.issues.some((i) => i.line === 2 && /unknown name/.test(i.message)),
    `M8: unknown name reported on its line (${JSON.stringify(a.issues)})`);
  const b = parseBoardMap("define x\n0-0");
  assert(b.issues.some((i) => /never closed/.test(i.message)), "M8: unclosed block reported");
  const c = parseBoardMap("o?o");
  assert(c.issues.some((i) => /not a link/.test(i.message)), "M8: a stray character is rejected");
  const d = parseBoardMap("define loop = {loop}\n{loop}");
  assert(d.issues.length > 0, "M8: a define that uses itself does not hang");
}

// ── M9: a map survives a round trip ────────────────────
{
  for (const preset of BOARD_PRESETS) {
    const once = parseBoardMap(preset.map);
    const twice = parseBoardMap(formatBoardMap(once));
    assert(twice.issues.length === 0 && twice.rows === once.rows && twice.cols === once.cols,
      `M9: ${preset.id}: re-reads at the same size (${twice.rows}x${twice.cols} vs ${once.rows}x${once.cols})`);
    const same = ["hole", "hLink", "vLink"].every((k) =>
      once[k].length === twice[k].length && once[k].every((v, i) => v === twice[k][i]));
    assert(same, `M9: ${preset.id}: the same copper comes back`);
  }
}

// ── M10: the ElectroCookie board, against the real grid ──
// The reference layout, transcribed: "0" holes, "Q" rails, "v" the V-cuts
// — which are grooves on a boundary, so they take no row or column.
{
  const Q = "Q 0-0-0 0-0-0 0-0-0 0-0-0 Q";
  const REFERENCE = {
    edge: ". . 0-0 0-0-0 0-0-0 0-0 . .",
    inner: ". 0-0-0 0-0-0 0-0-0 0-0-0 .",
    main: Q,
  };
  const preset = findPreset("electrocookie-snappable");
  const { rows, cols } = presetBoard(preset);
  assert(rows === 38 && cols === 28, `M10: 28 columns x 38 rows (${cols} x ${rows})`);

  // Each size is the fraction of the whole board its name claims, exactly:
  // nothing is spent on the V-cuts now.
  const q = presetBoard(findPreset("electrocookie-quarter"));
  const h = presetBoard(findPreset("electrocookie-half"));
  assert(q.cols === 14 && q.rows === 19, `M10: a quarter is 14 x 19 (${q.cols} x ${q.rows})`);
  assert(h.cols === 28 && h.rows === 19, `M10: a half is 28 x 19 (${h.cols} x ${h.rows})`);
  assert(q.cols * q.rows * 4 === cols * rows, "M10: four quarters make the whole board");
  assert(h.cols * h.rows * 2 === cols * rows, "M10: and so do two halves");
  assert(q.cols * q.rows * 2 === h.cols * h.rows, "M10: a half is two quarters");

  const b = mapBoard(preset.map);
  const t = boardTopology(b);
  assert(t.snapX.length === 1 && t.snapX[0] === 13.5,
    `M10: the vertical V-cut runs between columns 13 and 14 (${t.snapX})`);
  assert(t.snapY.length === 1 && t.snapY[0] === 18.5,
    `M10: the horizontal one between rows 18 and 19 (${t.snapY})`);

  // Compare row by row, in the reference's alphabet.
  const asReference = (line) => line.replace(/[PN]/g, "Q").replace(/:/g, "v");
  const holeRows = formatBoardMap(t).split("\n").filter((l) => l !== "" && !/^[\s|:]*$/.test(l));
  const quarterRows = [REFERENCE.edge, REFERENCE.inner, ...Array(15).fill(REFERENCE.main), REFERENCE.inner, REFERENCE.edge];
  const expected = quarterRows.map((r) => `${r}v${r}`);
  const wholeBoard = [...expected, ...expected];
  let mismatch = -1;
  for (let i = 0; i < wholeBoard.length; i++) {
    if (asReference(holeRows[i] ?? "") !== wholeBoard[i]) { mismatch = i; break; }
  }
  assert(holeRows.length === wholeBoard.length && mismatch < 0,
    mismatch < 0
      ? `M10: every one of the ${wholeBoard.length} rows matches the reference layout`
      : `M10: row ${mismatch} differs\n   want ${wholeBoard[mismatch]}\n   got  ${asReference(holeRows[mismatch] ?? "")}`);

  const segs = computeStripSegments(b, [], DEFS, []);
  assert(joined(segs, [2, 1], [2, 3]) && !joined(segs, [2, 3], [2, 4]),
    "M10: the strips run in threes");
  assert(joined(segs, [2, 0], [16, 0]), "M10: the rail is one bus down its quarter");
  assert(!joined(segs, [16, 0], [19, 0]), "M10: and does not cross the horizontal V-cut");
  assert(!joined(segs, [2, 13], [2, 14]), "M10: nothing crosses the vertical V-cut");
  assert(segAt(segs, 2, 0).label === "N" || segAt(segs, 2, 0).label === "P",
    "M10: the rails carry a polarity label");
}

// ── M11: every preset is coherent ──────────────────────
{
  for (const preset of BOARD_PRESETS) {
    const b = mapBoard(preset.map);
    const t = boardTopology(b);
    const segs = computeStripSegments(b, [], DEFS, []);
    let orphans = 0, doubled = 0;
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        if (!hasHole(t, r, c)) continue;
        const hits = segs.filter((s) => segmentContains(s, r, c));
        if (hits.length === 0) orphans++;
        if (hits.length > 1) doubled++;
      }
    }
    assert(orphans === 0 && doubled === 0,
      `M11: ${preset.id}: every hole on exactly one segment (${orphans} orphan, ${doubled} doubled)`);
  }
  assert(!hasCustomLayout({ ...emptyBoard(10, 10) }), "M11: a board with no layout is plain");
  assert(hasCustomLayout(mapBoard(findPreset("electrocookie-quarter").map)),
    "M11: a mapped board is not");
}

// ── M12: the router honours the picture ────────────────
{
  // Same net either side of a gap in the copper: it needs a jumper, and
  // there is nothing there to cut.
  const a = testPin(0, 1), z = testPin(0, 4);
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", z, "1")];
  const b = mapBoard("0-0-0 0-0-0\n0-0-0 0-0-0");
  const res = computeAutoFinish(b, [a, z], DEFS, nets, asg);
  assert(res.wires.length === 1, `M12: one jumper bridges the gap (${res.wires.length})`);
  assert(res.cuts.length === 0, `M12: and no cut is asked for (${JSON.stringify(res.cuts)})`);
  const v = verify(applyFinish(b, res), [a, z], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "M12: complete after the jumper");
  assert(cutWouldBeRedundant(b, 0, 2), "M12: the gap reports nothing to cut");
  assert(!cutWouldBeRedundant(b, 0, 0), "M12: real copper still does");
}

// ── M13: a bus is never drilled to serve a row cut ─────
{
  const a = testPin(0, 1), z = testPin(0, 3);
  const nets = [net("n1"), net("n2")];
  const asg = [assign("n1", a, "1"), assign("n2", z, "1")];
  const b = mapBoard("P 0-0-0-0\n|\nP 0-0-0-0\n|\nP 0-0-0-0");
  const res = computeAutoFinish(b, [a, z], DEFS, nets, asg);
  assert(!res.cuts.some((c) => c.kind === "hole" && c.col === 0),
    `M13: the bus column is never drilled (${JSON.stringify(res.cuts)})`);
  const v = verify(applyFinish(b, res), [a, z], nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0, "M13: the two nets end up separated");
}

// ── M13b: a shorted bus is reported, not silently left ──
// Two nets on one bus cannot be cut apart — a bus only breaks by drilling,
// which auto-finish will not do on its own. It has to say so.
{
  const a = testPin(0, 0), z = testPin(3, 0);
  const nets = [net("n1"), net("n2")];
  const asg = [assign("n1", a, "1"), assign("n2", z, "1")];
  const b = mapBoard("P 0-0-0\n|\nP 0-0-0\n|\nP 0-0-0\n|\nP 0-0-0");
  const res = computeAutoFinish(b, [a, z], DEFS, nets, asg);
  assert(res.cuts.length === 0, `M13b: it does not cut at random trying (${JSON.stringify(res.cuts)})`);
  assert(res.issues.length > 0, "M13b: and it reports the conflict it could not resolve");
  const v = verify(applyFinish(b, res), [a, z], nets, asg);
  assert(v.conflicts === 1, `M13b: the short is still there to be seen (${v.conflicts})`);

  // Drilling the bus is the fix, and it works.
  const drilled = { ...b, cuts: [{ row: 2, col: 0, kind: "hole" }] };
  assert(verify(drilled, [a, z], nets, asg).conflicts === 0,
    "M13b: drilling a hole out of the bus between them clears it");
}

// ── M14: drilling a hole splits a bus ──────────────────
{
  const src = "P 0-0\n|\nP 0-0\n|\nP 0-0\n|\nP 0-0";
  const b = mapBoard(src, [{ row: 1, col: 0, kind: "hole" }]);
  const segs = computeStripSegments(b, [], DEFS, []);
  assert(joined(segs, [0, 0], [0, 0]) && !joined(segs, [0, 0], [2, 0]),
    "M14: the drill separates the bus above from the bus below");
  assert(joined(segs, [2, 0], [3, 0]), "M14: below the drill it is still one piece");
  assert(!segAt(segs, 1, 0), "M14: the drilled hole carries no copper");
}

// ── M15: inserting and deleting lines moves the copper ──
{
  const b = mapBoard("P 0-0\n|\nP 0-0\n|\nP 0-0");
  const after = shiftLayout(b, "col", 0, 1);
  const t = boardTopology({ ...emptyBoard(3, 4), layout: after });
  assert(t.cols === 4, `M15: a column insert widens the map (${t.cols})`);
  assert(hasVLink(t, 0, 1), "M15: and carries the bus across with it");
  assert(!hasVLink(t, 0, 0), "M15: the fresh column has no copper of its own");

  const del = shiftLayout(b, "col", 0, -1);
  const t2 = boardTopology({ ...emptyBoard(3, 2), layout: del });
  assert(t2.cols === 2 && !hasVLink(t2, 0, 0), "M15: deleting the bus column removes the bus");

  // A snap sits on a boundary, so it travels with the columns either side.
  const snapped = mapBoard("0-0:0-0\n0-0:0-0");
  const wider = boardTopology({ ...emptyBoard(2, 5), layout: shiftLayout(snapped, "col", 0, 1) });
  assert(wider.snapX.length === 1 && wider.snapX[0] === 2.5,
    `M15: an insert before the V-cut pushes it along (${wider.snapX})`);
  const closed = boardTopology({ ...emptyBoard(2, 3), layout: shiftLayout(snapped, "col", 1, -1) });
  assert(closed.snapX.length === 0,
    `M15: deleting a hole beside it closes the boundary up (${closed.snapX})`);
}

// ── M16: the two segment paths agree ───────────────────
// A plain veroboard takes the per-row scan; a board drawn as a map walks
// the link graph. Given the same copper they have to find the same
// segments, or the fast path is a lie.
{
  const rows = 5, cols = 8;
  const row = Array.from({ length: cols }, () => "0").join("-");
  const map = Array.from({ length: rows }, () => row).join("\n") + "\n";
  const cuts = [{ row: 1, col: 3 }, { row: 2, col: 5, kind: "hole" }, { row: 4, col: 0 }];
  const a = testPin(0, 2), z = testPin(3, 6);
  const nets = [net("n1")];
  const asg = [assign("n1", a, "1"), assign("n1", z, "1")];

  const fast = computeStripSegments({ ...emptyBoard(rows, cols), cuts }, [a, z], DEFS, asg);
  const general = computeStripSegments({ ...emptyBoard(rows, cols), cuts, layout: { map } }, [a, z], DEFS, asg);
  const norm = (segs) => JSON.stringify(
    segs.map((s) => [s.row, s.startCol, s.endCol, s.endRow ?? s.row, [...s.netIds].sort()])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
  );
  assert(fast.length === general.length && norm(fast) === norm(general),
    `M16: same copper, same segments (${fast.length} vs ${general.length})\n   ${norm(fast)}\n   ${norm(general)}`);
}

// ── M17: auto-layout solves onto a mapped board ────────
{
  const parts = [
    rigid("dip8", "U1"),
    flex("def-resistor", "R1"), flex("def-resistor", "R2"), flex("def-resistor", "R3"),
    flex("def-capacitor", "C1"), flex("def-capacitor", "C2"),
  ];
  const [u1, r1, r2, r3, c1, c2] = parts;
  const nets = ["vcc", "gnd", "a", "b", "c"].map((n) => net(n));
  const asg = [
    assign("vcc", u1, "8"), assign("gnd", u1, "4"),
    assign("a", u1, "1"), assign("b", u1, "2"), assign("c", u1, "3"),
    assign("vcc", r1, "1"), assign("a", r1, "2"),
    assign("a", r2, "1"), assign("b", r2, "2"),
    assign("b", r3, "1"), assign("gnd", r3, "2"),
    assign("vcc", c1, "1"), assign("gnd", c1, "2"),
    assign("c", c2, "1"), assign("gnd", c2, "2"),
  ];
  const preset = findPreset("electrocookie-quarter");
  const base = mapBoard(preset.map);
  const b = { ...base, lockedRows: true, lockedCols: true };
  const res = computeAutoLayout2(b, parts, DEFS, nets, asg);
  const applied = applyLayout({ ...b, ...(res.boardSize ?? {}) }, parts, res);
  const t = boardTopology(b);

  assert(res.boardSize.rows === t.rows && res.boardSize.cols === t.cols,
    `M17: the board is not resized (${res.boardSize.rows}x${res.boardSize.cols} vs ${t.rows}x${t.cols})`);
  assert(res.quality === 0,
    `M17: solved cleanly (quality=${res.quality}, issues=${JSON.stringify(res.issues)})`);
  const v = verify(applied.board, applied.components, nets, asg);
  assert(v.conflicts === 0 && v.incomplete.length === 0,
    `M17: complete and conflict-free (conflicts=${v.conflicts}, incomplete=${v.incomplete.length})`);
  assert(checkGeometry(applied.board, applied.components).length === 0, "M17: geometry clean");

  // Nothing may be placed where the board has no hole, and no cut asked for
  // where there is no copper.
  const offBoard = [];
  for (const c of applied.components) {
    if (!c.boardPos) continue;
    for (const p of require("./helpers.js").boardLayout.getComponentPinPositions(c, DEFS.find((d) => d.id === c.defId))) {
      if (!hasHole(t, p.row, p.col)) offBoard.push(`${c.label}@${p.row},${p.col}`);
    }
  }
  assert(offBoard.length === 0, `M17: no pin sits where the board has no hole (${offBoard.join(" ")})`);
  const wasted = res.cuts.filter((c) => c.kind !== "hole" && cutWouldBeRedundant(b, c.row, c.col));
  assert(wasted.length === 0, `M17: no cut on copper that is not there (${JSON.stringify(wasted)})`);
}

finish("boardconfig");
