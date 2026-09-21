// The built-in part list: every spec expands into a part the editors can use.
const Module = require("module");
const path = require("path");
const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
const { DEFAULT_COMPONENTS, PART_SPECS, COMPONENT_GROUP_LABELS } = require(path.join(OUT, "data/defaultComponents.js"));
const { getSymbolDef } = require(path.join(OUT, "data/symbolDefs.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}

console.log("\npart specs");
const ids = DEFAULT_COMPONENTS.map((d) => d.id);
ok(new Set(ids).size === ids.length, `${ids.length} part ids, all distinct`);

const badGroup = PART_SPECS.filter((s) => !COMPONENT_GROUP_LABELS.includes(s.group)).map((s) => s.id);
ok(badGroup.length === 0, `every part is in a listed group ${badGroup.join(" ")}`);

const byId = new Map(DEFAULT_COMPONENTS.map((d) => [d.id, d]));
const badNames = PART_SPECS.filter((s) => {
  if (!s.pins) return false;
  const pinIds = new Set(byId.get(s.id).pins.map((p) => p.id));
  return s.pins.length !== pinIds.size;
}).map((s) => s.id);
ok(badNames.length === 0, `pin names match the pin count ${badNames.join(" ")}`);

// Wires attach to symbol pins by id, so a symbol pin the part does not have
// would be a dead end
const badSymbol = DEFAULT_COMPONENTS.filter((d) => {
  const sym = getSymbolDef(d.symbol);
  if (!sym) return true;
  const pinIds = new Set(d.pins.map((p) => p.id));
  return sym.pins.some((p) => !pinIds.has(p.pinId));
}).map((d) => d.id);
ok(badSymbol.length === 0, `every symbol exists and its pins are the part's ${badSymbol.join(" ")}`);

const opto = byId.get("def-optocoupler");
ok(opto.symbol === "generic-ic-4", "the optocoupler is drawn as the 4-pin IC body");

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
