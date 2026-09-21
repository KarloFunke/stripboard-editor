// The cuts under a rigid part's body belong to it: a part new to the board
// brings the ones it needs, and they are told apart by position alone.
const path = require("path");
const OUT = path.join(__dirname, "out");
const { bodyCuts, missingBodyCuts } = require(path.join(OUT, "components/stripboard/bodyCuts.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}
const def = (id) => DEFAULT_COMPONENTS.find((d) => d.id === id);
const comp = (defId, extra = {}) =>
  ({ id: "c", defId, label: "X", schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: { row: 2, col: 5 }, rotation: 0, ...extra });
const free = () => false;
const noNet = () => undefined;
const show = (cuts) => cuts.map((c) => `${c.row},${c.col},${c.kind}`).sort().join(" ");

console.log("\na DIP brings a cut for every strip its two pin rows share");
{
  const ic = comp("def-555");
  const drilled = missingBodyCuts([], ic, def("def-555"), noNet, true, free);
  ok(show(drilled) === "2,6,hole 3,6,hole 4,6,hole 5,6,hole", "drilled: a hole between the rows on each of the four strips");
  const knife = missingBodyCuts([], ic, def("def-555"), noNet, false, free);
  ok(show(knife) === "2,6,between 3,6,between 4,6,between 5,6,between", "not drilled: the middle gap instead");
  const taken = missingBodyCuts([], ic, def("def-555"), noNet, true, (r, c) => r === 2 && c === 6);
  ok(taken.some((c) => c.row === 2 && c.col === 7 && c.kind === "hole"), "a hole that holds a wire end is passed over for the next one");
  const full = missingBodyCuts([], ic, def("def-555"), noNet, true, (r) => r === 2);
  ok(full.some((c) => c.row === 2 && c.kind === "between"), "and with no hole left the copper is cut between two");
}

console.log("\nwhere no cut is wanted");
{
  const ic = comp("def-555");
  const some = missingBodyCuts([{ row: 3, col: 5, kind: "between" }], ic, def("def-555"), noNet, true, free);
  ok(some.length === 3 && !some.some((c) => c.row === 3), "a strip already cut under the body is left as it is");
  const tied = missingBodyCuts([], ic, def("def-555"), (pin) => (pin === "1" || pin === "8" ? "gnd" : undefined), true, free);
  ok(tied.length === 3 && !tied.some((c) => c.row === 2), "two pins of one net keep their strip");
  ok(missingBodyCuts([], comp("def-pushbutton"), def("def-pushbutton"), noNet, true, free).length === 0, "legs the part joins itself (same pin id) keep theirs");
  ok(missingBodyCuts([], comp("def-resistor"), def("def-resistor"), noNet, true, free).length === 0, "flexible parts bring none");
  ok(missingBodyCuts([], comp("def-npn"), def("def-npn"), noNet, true, free).length === 0, "nor does a part with every pin on its own strip");
}

console.log("\nturned a quarter, the pin rows lie along the strips");
{
  const ic = comp("def-555", { rotation: 90 });
  const cuts = missingBodyCuts([], ic, def("def-555"), noNet, true, free);
  ok(cuts.length === 6 && cuts.every((c) => c.kind === "between"), "neighbouring pins have no hole between them, so each pair gets a knife cut");
}

console.log("\nwhich cuts are the part's");
{
  const ic = comp("def-555");
  const cuts = [
    { row: 2, col: 6, kind: "hole" },     // under the body
    { row: 3, col: 5, kind: "between" },  // under the body, hard against the pin
    { row: 3, col: 7, kind: "between" },
    { row: 4, col: 5, kind: "hole" },     // a pin hole, not between pins
    { row: 4, col: 8, kind: "between" },  // past the right pin row
    { row: 9, col: 6, kind: "hole" },     // another strip
  ];
  ok(show(bodyCuts(cuts, ic, def("def-555"))) === "2,6,hole 3,5,between 3,7,between", "only those on a strip between two of its pins");
  ok(bodyCuts(cuts, comp("def-resistor"), def("def-resistor")).length === 0, "a flexible part owns none");
}

process.exit(failed === 0 ? 0 : 1);
