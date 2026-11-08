// Boards with their own copper: the built-in maps, how copper runs and is
// cut on them, and what fits where.
const Module = require("module");
const path = require("path");
const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
const { mapError, patternSize, buildMap, copperOf, cutFits, hasHole, mapOf, misfits, offHoles, partOnBoard, stripboardMap } = require(path.join(OUT, "components/stripboard/boardPattern.js"));
const { computeStripSegments, findSegmentIndex } = require(path.join(OUT, "components/stripboard/stripSegments.js"));
const { computeConnectivity } = require(path.join(OUT, "components/stripboard/connectivity.js"));
const { missingBodyCuts, bodyCuts } = require(path.join(OUT, "components/stripboard/bodyCuts.js"));
const { BUILTIN_BOARDS, builtinPattern } = require(path.join(OUT, "data/boards.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));
const editableCopperOf = (map) => require(path.join(OUT, "components/stripboard/boardPattern.js")).editableCopper(map);
const { getComponentPinPositions } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
const { brushCopper, brushHoles, changeArea, copyArea, edit, eraseCopper, fillStrips, mirrored, pasteArea, resized, rotated, setHole, turned } = require(path.join(OUT, "components/stripboard/boardEdits.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}
const builtin = (id) => BUILTIN_BOARDS.find((b) => b.id === id);
const boardOf = (id, extra = {}) => {
  const b = builtin(id);
  return { rows: b.rows, cols: b.cols, cuts: [], wires: [], pattern: builtinPattern(b), ...extra };
};
const segs = (board) => computeStripSegments(board, [], DEFAULT_COMPONENTS, []);
const groups = (board) => computeConnectivity(segs(board), board.wires, board);
const def = (id) => DEFAULT_COMPONENTS.find((d) => d.id === id);
const comp = (defId, boardPos, rotation = 0) =>
  ({ id: "c", defId, label: "X", schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos, rotation });

console.log("\nthe built-in boards");
{
  for (const b of BUILTIN_BOARDS) {
    const size = patternSize(b.map);
    ok(mapError(b.map) === null && size.rows === b.rows && size.cols === b.cols, `${b.id}: a valid map of ${b.rows} x ${b.cols}`);
  }
  const half = boardOf("breadboard-half");
  const s = segs(half);
  ok(half.rows === 30 && half.cols === 18, "half breadboard: standing upright, 30 rows");
  ok(s.filter((x) => x.endRow === undefined && x.endCol - x.startCol === 4).length === 60, "60 strips of five along the rows");
  ok(s.filter((x) => x.endRow === x.row + 29).length === 4, "and four rails down the whole board");
  ok(s.length === 64, "and no copper beside them");
  ok(!hasHole(half, 0, 2) && !hasHole(half, 5, 8) && !hasHole(half, 5, 9) && hasHole(half, 5, 7), "no holes beside the rails nor in the DIP gap");
  const ec = boardOf("electrocookie-quarter");
  const e = segs(ec);
  ok(e.filter((x) => x.endRow !== undefined).length === 2 && e.filter((x) => x.endRow !== undefined).every((x) => x.endRow - x.row === 14), "ElectroCookie quarter: a rail of 15 down either side");
  ok(e.filter((x) => x.endRow === undefined && x.endCol - x.startCol === 2).length === 17 * 4 + 4, "strips of three, and two of them in each end row");
  const whole = boardOf("electrocookie-whole");
  ok(findSegmentIndex(segs(whole), 18, 5) !== findSegmentIndex(segs(whole), 19, 5) && segs(whole).filter((x) => x.endRow !== undefined).length === 8, "whole: four quarters, no copper across their seams");
  const tri = segs(boardOf("tripad"));
  ok(tri.every((x) => x.endRow === undefined && x.endCol - x.startCol === 2), "TriPad: every strip three holes long");
  ok(BUILTIN_BOARDS[0].id === "tripad", "TriPad comes first");
  const small = builtin("tripad").resizable.map(4, 6);
  ok(patternSize(small).rows === 4 && small[0] === "o-o-o o-o-o", "TriPad comes in any size, columns three at a time");
}

console.log("\ncopper and cuts");
{
  const half = boardOf("breadboard-half");
  ok(groups({ ...half, wires: [{ id: "w", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } }] }).length === 63, "a wire joins two rails");
  ok(segs({ ...half, cuts: [{ row: 4, col: 0, kind: "below" }] }).length === 65, "a cut below a hole splits a rail in two");
  ok(segs({ ...half, cuts: [{ row: 4, col: 4, kind: "between" }] }).length === 65, "a cut between two holes splits a strip");
  ok(segs({ ...half, cuts: [{ row: 10, col: 0, kind: "hole" }] }).length === 66, "a drilled hole on a rail splits it and stands alone");
  ok(cutFits(half, { row: 4, col: 4, kind: "between" }) && !cutFits(half, { row: 4, col: 4, kind: "below" }), "a cut fits where copper runs, not across two strips");
  ok(!cutFits(half, { row: 4, col: 7, kind: "between" }), "nor where a strip ends");
  ok(!cutFits(half, { row: 5, col: 8, kind: "hole" }), "nor in a hole the board does not have");
  // copper that turns a corner
  const map = buildMap(3, 3, () => true, (r, c) => r === 0 && c === 0, (r, c) => r === 0 && c === 1);
  const corner = { rows: 3, cols: 3, cuts: [], wires: [], pattern: { name: "corner", map } };
  const g = groups(corner);
  const at = (r, c) => g.find((x) => x.segmentIndices.includes(findSegmentIndex(segs(corner), r, c)));
  ok(at(0, 0) === at(1, 1) && at(0, 0) !== at(2, 2), "copper turning a corner is one piece");
}

console.log("\nparts on a breadboard");
{
  const half = boardOf("breadboard-half");
  const noNet = () => undefined;
  const free = () => false;
  // Every place a part fits with its pins as asked
  const place = (rotation, want) => {
    for (let r = 0; r < half.rows; r++) {
      for (let c = 0; c < half.cols; c++) {
        const ic = comp("def-555", { row: r, col: c }, rotation);
        if (want(getComponentPinPositions(ic, def("def-555")).map((p) => p.col), ic)) return ic;
      }
    }
    return null;
  };
  const fits = (ic) => partOnBoard(half, ic, def("def-555")) && offHoles(half, [ic], DEFAULT_COMPONENTS).length === 0;
  // A DIP across the gap: one column of pins either side
  const across = place(0, (cols, ic) => fits(ic) && cols.includes(7) && cols.includes(10));
  ok(across !== null, "a DIP fits across the gap");
  ok(across && missingBodyCuts([], across, def("def-555"), noNet, true, free, half).length === 0, "and brings no cuts: every pin has a strip of its own");
  const along = place(90, (cols, ic) => fits(ic) && cols.every((c) => c >= 3 && c <= 7));
  const cuts = along ? missingBodyCuts([], along, def("def-555"), noNet, true, free, half) : [];
  ok(cuts.length === 6 && cuts.every((c) => c.kind === "between"), "a DIP along the strips cuts them between its pins");
  ok(along && bodyCuts(cuts, along, def("def-555"), half).length === 6, "and those cuts are its own");
  const overGap = place(0, (cols) => cols.includes(8));
  ok(overGap && partOnBoard(half, overGap, def("def-555")) && offHoles(half, [overGap], DEFAULT_COMPONENTS).length === 4, "a DIP over the gap may lie there, its four pins there marked as wrong");
  const offEdge = comp("def-555", { row: 0, col: 16 });
  const wire = { id: "w", from: { row: 0, col: 2 }, to: { row: 3, col: 0 } };
  const off = misfits({ ...half, wires: [wire, { id: "w2", from: { row: 0, col: 17 }, to: { row: 0, col: 18 } }], cuts: [{ row: 3, col: 0, kind: "between" }] }, [overGap, offEdge], DEFAULT_COMPONENTS);
  ok(off.parts.join() === "c" && off.parts.length === 1 && off.wires.join() === "w2" && off.cuts.length === 1, "what cannot stay: a part and a wire off the edge, a cut with no copper");
  ok(groups({ ...half, wires: [wire] }).length === 64, "a wire ending where there is no hole joins nothing");
  ok(offHoles({ ...half, wires: [wire] }, [], DEFAULT_COMPONENTS).length === 1, "and its end there is marked");
}

console.log("\nthe board editor's edits");
{
  for (const b of BUILTIN_BOARDS) {
    const four = rotated(rotated(rotated(rotated(b.map))));
    ok(four.join("\n") === b.map.join("\n"), `${b.id}: four quarter turns bring it back`);
  }
  const once = rotated(builtin("breadboard-half").map);
  const turned = { rows: 18, cols: 30, cuts: [], wires: [], pattern: { name: "t", map: once } };
  ok(patternSize(once).rows === 18 && segs(turned).filter((x) => x.endRow === x.row + 4).length === 60, "a quarter turn lays the breadboard on its side, strips down the columns");
  const strips = edit(buildMap(2, 6, () => true, () => false, () => true), (c) => fillStrips(c, { r0: 0, c0: 0, r1: 1, c1: 5 }, false, 3));
  ok(strips[0] === "o-o-o o-o-o" && strips[1].trim() === "", "strips of three across an area, and nothing down any more");
  const down = edit(buildMap(4, 1, () => true, () => false, () => false), (c) => fillStrips(c, { r0: 0, c0: 0, r1: 3, c1: 0 }, true, 0));
  ok(down.join("") === "o|o|o|o", "an unbroken strip down a column");
  const grown = resized(strips, 3, 7);
  ok(grown[0] === "o-o-o o-o-o o" && grown[4] === "o o o o o o o", "growing keeps the copper and adds bare holes");
  ok(resized(grown, 2, 6).join("\n") === strips.join("\n"), "and shrinking takes them away again");
  const holed = edit(strips, (c) => setHole(c, { row: 0, col: 1 }, false));
  ok(holed[0] === "o-.-o o-o-o", "a hole taken away leaves its copper");
  ok(edit(holed, (c) => setHole(c, { row: 0, col: 1 }, true))[0] === strips[0], "and comes back into it");
  const past = { rows: 2, cols: 6, cuts: [], wires: [], pattern: { name: "p", map: holed } };
  ok(segs(past).filter((x) => x.row === 0).length === 2 && !hasHole(past, 0, 1), "copper past a missing hole is still one strip, with no hole to use");
  const bare = buildMap(3, 3, () => true, () => false, () => false);
  const across = edit(bare, (c) => brushCopper(c, { row: 0, col: 0 }, { row: 0, col: 2 }, true));
  ok(across[0] === "o-o-o", "a brush along a row joins its holes");
  const downward = edit(bare, (c) => brushCopper(c, { row: 0, col: 1 }, { row: 2, col: 1 }, true));
  const wobble = edit(bare, (c) => brushCopper(c, { row: 0.25, col: 0 }, { row: 0.25, col: 2 }, true, "across"));
  ok(wobble[0] === "o-o-o" && wobble[1].trim() === "", "a brush going across, off the middle of the row, still only joins across it");
  ok(downward[1] === "  |  " && downward[3] === "  |  " && downward[0] === "o o o", "and one down a column joins down it");
  const between = edit(stripboardMap(3, 3), (c) => eraseCopper(c, { row: 0, col: 0.5 }, { row: 2, col: 0.5 }));
  ok(between.filter((_, i) => i % 2 === 0).every((l) => l === "o o-o"), "the eraser down between two columns cuts every strip there");
  const wobbly = edit(stripboardMap(3, 3), (c) => eraseCopper(c, { row: 0, col: 0.6 }, { row: 2, col: 0.4 }));
  ok(wobbly.filter((_, i) => i % 2 === 0).every((l) => l === "o o-o"), "off the middle a little, too");
  const rails = edit(buildMap(3, 2, () => true, () => false, () => true), (c) => eraseCopper(c, { row: 0, col: 0 }, { row: 2, col: 0 }));
  ok(rails[1] === "  |" && rails[3] === "  |", "along a rail it clears that rail only");
  const near = edit(buildMap(3, 3, () => true, () => true, () => true), (c) => eraseCopper(c, { row: 0.2, col: 0 }, { row: 0.2, col: 2 }));
  ok(near[0] === "o o o" && near[1] === "| | |", "along a row a little off its middle it clears the row, not what runs down from it");
  const corner = edit(bare, (c) => brushCopper(c, { row: 0.1, col: 0.1 }, { row: 0.9, col: 0.9 }, true));
  ok(corner.join("") === bare.join(""), "a stroke across a corner touches no copper");
  const holesGone = edit(bare, (c) => brushHoles(c, { row: 0, col: 0 }, { row: 2, col: 2 }, false));
  ok(holesGone[0] === ". o o" && holesGone[2] === "o . o" && holesGone[4] === "o o .", "the holes brush takes away every hole it passes over");
}

console.log("\ncopy and paste");
{
  // a 2 x 3 piece: a strip of three over holes joined down on the left
  const source = buildMap(2, 3, () => true, (r) => r === 0, (_, c) => c === 0);
  const piece = copyArea(source, { r0: 0, c0: 0, r1: 1, c1: 2 });
  const board = stripboardMap(4, 6);
  const pasted = edit(board, (c) => pasteArea(c, piece, { row: 1, col: 2 }));
  ok(pasted[2] === "o-o o-o-o o" && pasted[3] === "    |      " && pasted[4] === "o-o o o o o", "the piece goes down where asked, cut off from the copper around it");
  ok(pasted[0] === board[0] && pasted[6] === board[6], "and the rest of the board stays");
  const edge = edit(board, (c) => pasteArea(c, piece, { row: 3, col: 4 }));
  ok(edge[6] === "o-o-o-o o-o", "near the edge only what fits goes down");
  const inner = copyArea(stripboardMap(3, 3), { r0: 1, c0: 1, r1: 1, c1: 1 });
  ok(inner.right[0] === 0 && inner.down[0] === 0, "copper leading out of a copied area stays behind");
}

console.log("\nturning and mirroring");
{
  const mirror = (map, way) => mapOf(mirrored(copperOf(map), way));
  for (const b of BUILTIN_BOARDS) {
    ok(mirror(mirror(b.map, "across"), "across").join() === b.map.join() && mirror(mirror(b.map, "down"), "down").join() === b.map.join(), `${b.id}: mirrored twice either way, it is as it was`);
  }
  ok(mirror(builtin("breadboard-half").map, "across").join() === builtin("breadboard-half").map.join(), "the breadboard is the same mirrored left to right");
  // an L: a strip of three along the top, copper down from its left end
  const ell = buildMap(3, 3, () => true, (r) => r === 0, (r, c) => c === 0 && r < 2);
  const flipped = mirror(ell, "across");
  ok(flipped[0] === "o-o-o" && flipped[1] === "    |" && flipped[3] === "    |", "mirrored left to right, the copper down runs from the right end");
  const upside = mirror(ell, "down");
  ok(upside[4] === "o-o-o" && upside[1] === "|    " && upside[0] === "o o o", "mirrored top to bottom, the strip is at the bottom");
  ok(mapOf(turned(turned(copperOf(ell)))).join() === mirror(mirror(ell, "across"), "down").join(), "two quarter turns are both mirrors");
  // a 1 x 3 strip in a 5 x 5 board, turned about its middle
  const bar = edit(buildMap(5, 5, () => true, () => false, () => false), (c) => { c.right[2 * 5 + 1] = 1; c.right[2 * 5 + 2] = 1; });
  const board = editableCopperOf(bar);
  const placed = changeArea(board, { r0: 2, c0: 1, r1: 2, c1: 3 }, turned);
  const after = mapOf(board);
  ok(placed.r0 === 1 && placed.c0 === 2 && placed.r1 === 3 && placed.c1 === 2, "an area turned about its middle covers its new shape");
  ok(after[3] === "    |    " && after[5] === "    |    " && after[4] === "o o o o o", "and its strip now runs down");
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
