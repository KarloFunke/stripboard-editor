// Writes the schematic pin positions of every built-in component to the
// backend, so a data migration can reason about connectivity without a
// browser. Run after changing symbolDefs.ts or defaultComponents.ts:
//   npm run gen:symbol-pins
// (Parametric symbols, generic-ic-N and connector-N, and custom footprint
// symbols are generated in Python from the same formulas.)
const M = require("module");
const path = require("path");
const fs = require("fs");

const OUT = path.resolve(__dirname, "../tests/schematic/out");
const origResolve = M._resolveFilename;
M._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));
const { getSymbolDef } = require(path.join(OUT, "data/symbolDefs.js"));

const defs = {};
const symbols = {};
for (const def of DEFAULT_COMPONENTS) {
  defs[def.id] = def.symbol;
  if (symbols[def.symbol]) continue;
  const sym = getSymbolDef(def.symbol);
  if (!sym) throw new Error(`no symbol for ${def.id}: ${def.symbol}`);
  symbols[def.symbol] = sym.pins.map((p) => [p.pinId, p.stubEnd.x, p.stubEnd.y]);
}
const target = path.resolve(__dirname, "../../backend/projects/migrations_data/symbol_pins.json");
fs.writeFileSync(target, JSON.stringify({ generatedBy: "frontend/scripts/exportSymbolPins.js", defs, symbols }, null, 1) + "\n");
console.log(`wrote ${Object.keys(defs).length} defs, ${Object.keys(symbols).length} symbols to ${path.relative(process.cwd(), target)}`);
