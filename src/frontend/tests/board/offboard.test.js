// An off-board part reaches the board as one solder pad per wired pin, and
// nothing but the parent's `leads` is ever stored.
const path = require("path");
const OUT = path.join(__dirname, "out");
const { expandOffBoard, collapseLeads, leadSiblings, leadId, parseLeadId, isLead } =
  require(path.join(OUT, "components/stripboard/offBoard.js"));
const { resolvePackage } = require(path.join(OUT, "components/stripboard/packageBodies.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}
const comp = (id, defId, label, extra = {}) =>
  ({ id, defId, label, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: null, rotation: 0, ...extra });

console.log("\nexpansion");
{
  const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, leads: { "2": { row: 4, col: 0 } } });
  const r1 = comp("r-1", "def-resistor", "R1", { boardPos: { row: 1, col: 1 } });
  const asg = [
    { netId: "n1", componentId: "pot-1", pinId: "1" },
    { netId: "n2", componentId: "pot-1", pinId: "2" },
    { netId: "n1", componentId: "r-1", pinId: "1" },
  ];
  const out = expandOffBoard([pot, r1], DEFAULT_COMPONENTS, asg);
  const pads = out.components.filter(isLead);
  ok(pads.length === 2, "one pad per wired pin: the unwired third lug gets none");
  ok(!out.components.some((c) => c.id === "pot-1"), "the off-board part itself is not on the board");
  ok(out.components.some((c) => c === r1), "ordinary parts pass through untouched");
  ok(pads.every((p) => p.defId === "def-connector-1" && p.package === "wire"), "a pad is a one-hole connector drawn as a soldered wire");
  const def = DEFAULT_COMPONENTS.find((d) => d.id === "def-connector-1");
  ok(def.category === "connector" && resolvePackage(def, undefined, "wire").spec.shape === "wire", "so the layout engines push it to the edge, and it draws as a wire");
  ok(pads.map((p) => p.label).join() === "RV1 VCC,RV1 OUT", "labelled with the part and its pin name");
  const placed = pads.find((p) => p.leadOf.pinId === "2");
  ok(placed.boardPos.row === 4 && pads.find((p) => p.leadOf.pinId === "1").boardPos === null, "a pad sits where the parent's leads say, or is unplaced");
  ok(out.netAssignments.some((a) => a.componentId === leadId("pot-1", "2") && a.pinId === "1" && a.netId === "n2"), "each pad carries its pin's net");
  ok(!out.netAssignments.some((a) => a.componentId === "pot-1"), "and the parent's own assignments leave the board's view");
  ok(out.netAssignments.length === 3, "no assignment is lost or duplicated");
}
{
  const plain = [comp("r-1", "def-resistor", "R1")];
  const asg = [{ netId: "n1", componentId: "r-1", pinId: "1" }];
  const out = expandOffBoard(plain, DEFAULT_COMPONENTS, asg);
  ok(out.components === plain && out.netAssignments === asg, "a project with no off-board parts is returned as is");
}
{
  // four legs, two electrical nodes: legs sharing a pin id share one pad
  const sw = comp("sw-1", "def-pushbutton", "SW1", { offBoard: true });
  const asg = [
    { netId: "n1", componentId: "sw-1", pinId: "1" }, { netId: "n1", componentId: "sw-1", pinId: "1" },
    { netId: "n2", componentId: "sw-1", pinId: "2" },
  ];
  ok(expandOffBoard([sw], DEFAULT_COMPONENTS, asg).components.length === 2, "legs that share a pin id share one pad");
}
{
  const gone = comp("pot-2", "def-potentiometer", "RV2", { offBoard: true, boardExcluded: true });
  const asg = [{ netId: "n1", componentId: "pot-2", pinId: "1" }];
  const out = expandOffBoard([gone], DEFAULT_COMPONENTS, asg);
  ok(out.components.length === 1 && !isLead(out.components[0]), "excluded wins over off-board: an excluded part gets no pads");
}

console.log("\nfolding pad positions back");
{
  const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, leads: { "1": { row: 0, col: 0 }, "3": { row: 9, col: 9 } } });
  const r1 = comp("r-1", "def-resistor", "R1");
  const moved = new Map([
    [leadId("pot-1", "1"), { row: 2, col: 0 }],   // moved
    [leadId("pot-1", "2"), { row: 3, col: 0 }],   // newly placed
    [leadId("pot-1", "3"), null],                 // taken off the board
    ["r-1", { row: 5, col: 5 }],                  // not a pad: ignored here
  ]);
  const [p, r] = collapseLeads([pot, r1], moved);
  ok(JSON.stringify(p.leads) === JSON.stringify({ "1": { row: 2, col: 0 }, "2": { row: 3, col: 0 } }), "moved, placed and removed pads all land in the parent's leads");
  ok(r === r1 && p.boardPos === null, "real components and the parent's own position are left alone");
  ok(collapseLeads([pot], new Map([[leadId("pot-1", "1"), null], [leadId("pot-1", "3"), null]]))[0].leads === undefined, "no pads left means no leads stored");
  const id = "0b6f7a2e-1c1d-4f6a-9a55-2f0d7c3e9b10";
  ok(parseLeadId(id) === null && parseLeadId(leadId(id, "OUT")).pinId === "OUT", "a real uuid is never mistaken for a pad");
}
{
  const a = comp("a", "def-potentiometer", "RV1", { offBoard: true });
  const b = comp("b", "def-switch", "S1", { offBoard: true });
  const asg = ["1", "2", "3"].map((pinId) => ({ netId: "n" + pinId, componentId: "a", pinId }))
    .concat([{ netId: "n1", componentId: "b", pinId: "1" }]);
  const groups = leadSiblings(expandOffBoard([a, b], DEFAULT_COMPONENTS, asg).components);
  ok(groups.length === 1 && groups[0].length === 3, "siblings are grouped per part; a lone pad forms no group");
}

console.log("\ngrouped connector");
{
  const { editBoardView, offBoardWiring, GROUP_PIN } = require(path.join(OUT, "components/stripboard/offBoard.js"));
  const { rigidBody } = require(path.join(OUT, "components/stripboard/partGeometry.js"));
  const asg = ["1", "3", "2"].map((pinId) => ({ netId: "n" + pinId, componentId: "pot-1", pinId }));
  const nets = [{ id: "n1", name: "9V" }, { id: "n2", name: "WIPER" }, { id: "n3", name: "GND" }];
  for (const [pkg, drawn, width] of [["wire-row", "wire", 1], ["header", "header", 1], ["jst-xh", "jst-xh", 1], ["term-508", "term-508", 3]]) {
    const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, offBoardPackage: pkg, boardPos: { row: 2, col: 5 }, rotation: 90 });
    const out = expandOffBoard([pot], DEFAULT_COMPONENTS, asg);
    const [g] = out.components;
    ok(out.components.length === 1 && g.defId === "def-connector-3" && g.package === drawn && g.leadOf.pinId === GROUP_PIN,
      `${pkg}: one three-pin connector drawn as ${drawn}`);
    ok(g.footprintOverride.pins.map((p) => p.name).join() === "VCC,OUT,GND" && g.footprintOverride.width === width,
      `${pkg}: it carries the part's pin names, in the part's pin order`);
    ok(g.boardPos.row === 2 && g.rotation === 90, `${pkg}: it sits where the part's own board position says`);
    ok(out.netAssignments.map((a) => `${a.pinId}:${a.netId}`).join() === "1:n1,2:n2,3:n3", `${pkg}: connector pins follow the pins, not the order they were wired in`);
  }
  const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, offBoardPackage: "jst-xh" });
  const gid = leadId("pot-1", GROUP_PIN);
  const placed = editBoardView([pot], DEFAULT_COMPONENTS, asg, (view) => view.map((c) => (c.id === gid ? { ...c, boardPos: { row: 4, col: 0 }, rotation: 180, locked: true } : c)));
  ok(placed[0].boardPos.row === 4 && placed[0].rotation === 180 && placed[0].locked === true && placed[0].leads === undefined,
    "placing, turning and locking the connector lands on the part's own fields");
  const list = offBoardWiring(placed, DEFAULT_COMPONENTS, nets, asg)[0].wires;
  ok(list.map((w) => `${w.pin}@${w.pad.row},${w.pad.col}`).join(" ") === "VCC@6,0 OUT@5,0 GND@4,0", `the wiring list names each pin's own hole, turned with the connector (${list.map((w) => `${w.pin}@${w.pad.row},${w.pad.col}`).join(" ")})`);
  const one = expandOffBoard([comp("s-1", "def-switch", "S1", { offBoard: true, offBoardPackage: "jst-xh" })], DEFAULT_COMPONENTS, [{ netId: "n1", componentId: "s-1", pinId: "1" }]).components[0];
  ok(one.defId === "def-connector-1" && one.package === "jst-xh" && resolvePackage(DEFAULT_COMPONENTS.find((d) => d.id === "def-connector-1"), undefined, "jst-xh").spec.shape === "shroud",
    "a part with one wired pin may take any connector too");
}

console.log("\nwiring list");
{
  const { offBoardWiring } = require(path.join(OUT, "components/stripboard/offBoard.js"));
  const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, value: "10k", leads: { "2": { row: 4, col: 0 } } });
  const asg = [{ netId: "n2", componentId: "pot-1", pinId: "2" }, { netId: "n1", componentId: "pot-1", pinId: "1" }];
  const list = offBoardWiring([pot, comp("r-1", "def-resistor", "R1")], DEFAULT_COMPONENTS, [{ id: "n1", name: "9V" }, { id: "n2", name: "OUT" }], asg);
  ok(list.length === 1 && list[0].label === "RV1" && list[0].value === "10k", "one entry per off-board part, none for ordinary ones");
  ok(list[0].wires.map((w) => `${w.pin}:${w.net}`).join() === "VCC:9V,OUT:OUT", "wired pins in the part's own pin order, the unwired lug left out");
  ok(list[0].wires[0].pad === null && list[0].wires[1].pad.row === 4, "with the pad's place, or none while it is unplaced");
}

console.log("\nboard edits reach the pads");
{
  const { editBoardView } = require(path.join(OUT, "components/stripboard/offBoard.js"));
  const pot = comp("pot-1", "def-potentiometer", "RV1", { offBoard: true, leads: { "1": { row: 0, col: 0 } } });
  const r1 = comp("r-1", "def-resistor", "R1", { boardPos: { row: 5, col: 5 } });
  const asg = ["1", "2"].map((pinId) => ({ netId: "n" + pinId, componentId: "pot-1", pinId }));
  const all = [pot, r1];
  const edit = (fn) => editBoardView(all, DEFAULT_COMPONENTS, asg, (view) => view.map(fn));
  const placed = edit((c) => (c.id === leadId("pot-1", "2") ? { ...c, boardPos: { row: 3, col: 0 } } : c));
  ok(placed[0].leads["2"].row === 3 && placed[0].leads["1"].row === 0 && placed[0].boardPos === null, "placing a pad writes the parent's leads and nothing else");
  ok(placed[1] === r1 && placed.length === 2, "other parts come back as the same objects, and no pad leaks into the stored list");
  const moved = edit((c) => (c.boardPos ? { ...c, boardPos: { row: c.boardPos.row + 1, col: c.boardPos.col } } : c));
  ok(moved[0].leads["1"].row === 1 && moved[1].boardPos.row === 6, "a move shifts pads and real parts alike");
  const off = edit((c) => (c.id === leadId("pot-1", "1") ? { ...c, boardPos: null } : c));
  ok(off[0].leads === undefined, "taking the last pad off the board clears the leads");
  const locked = edit((c) => (c.id === leadId("pot-1", "1") ? { ...c, locked: true } : c));
  ok(locked[0].locked === true, "locking one pad locks the part");
  const unlocked = editBoardView(locked, DEFAULT_COMPONENTS, asg, (view) => view.map((c) => (c.id === leadId("pot-1", "2") ? { ...c, locked: false } : c)));
  ok(!unlocked[0].locked, "and unlocking any one pad unlocks it");
  ok(edit((c) => c)[0] === pot, "an edit that changes nothing leaves the parent untouched");
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
