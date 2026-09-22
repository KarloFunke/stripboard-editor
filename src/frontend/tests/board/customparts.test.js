// Custom parts: a part made from a body behaves like a built-in one, and the
// helpers that copy parts between library and project keep them intact.
const Module = require("module");
const path = require("path");
const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
const { partDef } = require(path.join(OUT, "data/defaultComponents.js"));
const { getSymbolDef } = require(path.join(OUT, "data/symbolDefs.js"));
const { packageOptions } = require(path.join(OUT, "components/stripboard/packageBodies.js"));
const { withPartId, libraryPayload, footprintChanged, libraryDef } = require(path.join(OUT, "data/customParts.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}

console.log("\nparts made from a body");
const dip = partDef({ id: "custom-a", name: "PT2399 clone", group: "", footprint: { kind: "dip", pins: 8 }, pins: ["A", "B", "C", "D", "E", "F", "G", "H"] });
ok(dip.symbol === "generic-ic-8" && dip.pins.find((p) => p.id === "5").name === "E", "a DIP part gets the generic IC body and its pin names");
ok(packageOptions(dip).map((o) => o.id).join() === "dip", "and is drawn as a DIP on the board");
const reg = partDef({ id: "custom-b", name: "LDO", group: "", footprint: { kind: "to" }, symbol: "box-t1-r2-b3", pins: ["VIN", "VOUT", "GND"] });
ok(getSymbolDef(reg.symbol).pins.map((p) => p.pinId).join() === "1,2,3", "a three-leg part gets its pin box");
ok(packageOptions(reg).map((o) => o.id).join() === "to92,to220", "and the TO-92 / TO-220 choice");
const sip = partDef({ id: "custom-c", name: "Resistor network", group: "", footprint: { kind: "inline", pins: 9 }, symbol: "sip-ic-9" });
ok(sip.height === 9 && sip.width === 1 && getSymbolDef(sip.symbol).pins.length === 9, "a single-row part is one column of 9 holes");
ok(getSymbolDef(sip.symbol).pins.every((p) => p.side === "left"), "and is drawn with all its pins on one side");

console.log("\ncopies between library and project");
const grid = { id: "custom-x", name: "Relay", category: "generic", symbol: "custom-footprint-custom-x", defaultLabelPrefix: "K",
  width: 2, height: 2, pins: [{ id: "1", name: "1", offsetRow: 0, offsetCol: 0 }], library: { id: "abc", rev: 3 } };
ok(withPartId(grid, "custom-y").symbol === "custom-footprint-custom-y", "a grid part's symbol follows its id");
ok(withPartId(dip, "custom-y").symbol === "generic-ic-8", "a body part's symbol does not");
const payload = libraryPayload(grid);
ok(payload.library === undefined && payload.id === "library-part" && grid.library.rev === 3, "what the library stores carries no project id or link, and the part is untouched");
const shown = libraryDef({ id: "abc", part: payload, rev: 4, updated_at: "" });
ok(shown.id === "library-abc" && shown.library.rev === 4 && getSymbolDef(shown.symbol) !== undefined, "a library part is listed under its own id with its symbol ready");
const renamed = { ...grid, pins: [{ id: "1", name: "COIL", offsetRow: 0, offsetCol: 0 }] };
const moved = { ...grid, pins: [{ id: "1", name: "1", offsetRow: 1, offsetCol: 0 }] };
ok(!footprintChanged(grid, renamed), "renaming a pin keeps placed parts where they are");
ok(footprintChanged(grid, moved), "moving a pin does not");

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
