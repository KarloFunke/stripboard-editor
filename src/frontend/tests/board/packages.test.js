// Every package a part offers must draw, and a package that moves pins must
// keep the pin ids, or the net assignments pointing at them break.
const path = require("path");
const OUT = path.join(__dirname, "out");
const { packageOptions, defaultPackageId, resolvePackage, footprintFor, bodyPieces } =
  require(path.join(OUT, "components/stripboard/packageBodies.js"));
const { rigidPieces, rigidShape } = require(path.join(OUT, "components/stripboard/rigidBodies.js"));
const { getRotatedPinPositions, getComponentBounds } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
const { parseResistance, parseCapacitance, resistorBands } =
  require(path.join(OUT, "components/stripboard/componentValues.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}

function draw(def, resolved) {
  if (resolved.kind === "twoPin") return bodyPieces(resolved.spec, 4 * 2.54);
  return rigidPieces(resolved.spec, {
    pins: def.pins.map((p) => ({ x: p.offsetCol * 2.54, y: p.offsetRow * 2.54, id: p.id })),
    width: def.width * 2.54,
    height: def.height * 2.54,
    rotation: 0,
  });
}

console.log("\npackage registry");
let drawn = 0;
const problems = [];
for (const def of DEFAULT_COMPONENTS) {
  const options = packageOptions(def);
  if (options.length === 0) continue;

  const fallback = defaultPackageId(def);
  if (!options.some((o) => o.id === fallback)) problems.push(`${def.id}: default ${fallback} is not offered`);
  // A default may never move pins: the footprint only changes when the user
  // picks a package, so a pin-moving default would draw over space that
  // nothing reserved.
  if (options.find((o) => o.id === fallback)?.movesPins) problems.push(`${def.id}: default ${fallback} moves pins`);

  for (const option of options) {
    const resolved = resolvePackage(def, "10k", option.id);
    if (!resolved) { problems.push(`${def.id}/${option.id}: does not resolve`); continue; }
    let pieces;
    try { pieces = draw(def, resolved); }
    catch (e) { problems.push(`${def.id}/${option.id}: threw ${e.message}`); continue; }
    drawn++;
    if (pieces.length === 0) problems.push(`${def.id}/${option.id}: drew nothing`);
    // Only real coordinates, not every digit in the JSON: a hex colour like
    // #6e7175 reads as scientific notation to a naive number regex.
    const coordinates = [];
    const walk = (value, key) => {
      if (typeof value === "number") coordinates.push(value);
      else if (Array.isArray(value)) value.forEach((v) => walk(v));
      else if (value && typeof value === "object") for (const k of Object.keys(value)) walk(value[k], k);
      else if (typeof value === "string" && key === "d") {
        for (const m of value.match(/-?\d*\.?\d+(e[-+]?\d+)?/gi) || []) coordinates.push(Number(m));
      }
    };
    walk(pieces);
    if (coordinates.some((n) => !isFinite(n))) problems.push(`${def.id}/${option.id}: NaN in the geometry`);

    if (option.movesPins) {
      const footprint = footprintFor(def, option.id);
      if (!footprint) problems.push(`${def.id}/${option.id}: says it moves pins but gives no footprint`);
      else if (footprint.pins.map((p) => p.id).join() !== def.pins.map((p) => p.id).join()) {
        problems.push(`${def.id}/${option.id}: pin ids changed, net assignments would break`);
      }
    }
  }
}
ok(problems.length === 0, `${drawn} package and definition combinations draw cleanly`);
for (const p of problems) console.log(`       ${p}`);

console.log("\nvalue parsing");
const resistances = [["10k", 10000], ["10K", 10000], ["4k7", 4700], ["4.7 kΩ", 4700], ["100R", 100],
  ["150", 150], ["1Meg", 1e6], ["1m", 1e6], ["2k2", 2200], ["1000", 1000], ["0.47", 0.47]];
for (const [text, expected] of resistances) ok(parseResistance(text) === expected, `${text} is ${expected} ohms`);
ok(parseResistance("IDK") === null, "nonsense is refused");
ok(parseResistance("4k7 / 10k") === null, "two values in one field are refused");

const capacitances = [["100n", 100e-9], ["10uF", 10e-6], ["0.1 uF", 100e-9], ["4u7", 4.7e-6],
  ["100 mü", 100e-6], ["2,2 mü", 2.2e-6], [".047uf", 47e-9], ["47 uF x 16V", 47e-6], ["330pF", 330e-12]];
for (const [text, expected] of capacitances) {
  const got = parseCapacitance(text);
  ok(got !== null && Math.abs(got - expected) < expected * 1e-9, `${text} is ${expected} farads`);
}
ok(parseCapacitance("47") === null, "a bare number on a capacitor is ambiguous, so refused");

console.log("\ncolour bands");
const bands = [["10k", 4], ["4.7k", 4], ["150", 4], ["5.56k", 5], ["10", 4], ["4.7", 4]];
for (const [text, count] of bands) {
  const b = resistorBands(parseResistance(text));
  ok(b !== null && b.length === count, `${text} needs ${count} bands`);
}
ok(resistorBands(173200) === null, "a value no standard band set can express gets none");
{
  const mf = resistorBands(470, true);
  ok(mf.length === 5 && mf[4] === resistorBands(5560)[4], "metal film: 470 gets five bands, ending in the brown 1% band");
  ok(mf[2] === resistorBands(10)[1] && mf[3] === resistorBands(10)[1], "yellow violet black black: the third digit and the x1 multiplier are both black");
  ok(resistorBands(0.47, true) === null, "a value five bands cannot express (multiplier below silver) gets none");
}

// A rigid body is drawn around its already-rotated pins, so turning the part
// must turn the body with it; 2-pins-a-side parts and the trimmer used not to.
console.log("\nrotation");
function shapeAt(def, packageId, rotation) {
  const resolved = resolvePackage(def, undefined, packageId);
  const pos = { row: 10, col: 10 };
  const pins = getRotatedPinPositions(def, pos, rotation);
  const b = getComponentBounds(def, pos, rotation);
  const midRow = (b.minRow + b.maxRow) / 2, midCol = (b.minCol + b.maxCol) / 2;
  return rigidShape(resolved.spec, {
    pins: pins.map((p) => ({ x: (p.col - midCol) * 2.54, y: (p.row - midRow) * 2.54, id: p.pinId })),
    width: (b.maxCol - b.minCol + 1) * 2.54,
    height: (b.maxRow - b.minRow + 1) * 2.54,
    rotation,
  });
}
const turned = (a, b) => Math.abs(a.w - b.h) < 1e-6 && Math.abs(a.h - b.w) < 1e-6;
const byId = (id) => DEFAULT_COMPONENTS.find((d) => d.id === id);
for (const id of ["def-optocoupler", "def-pushbutton", "def-ic-dip8"]) {
  const def = byId(id) || require(path.join(OUT, "data/defaultComponents.js")).RETIRED_PARTS.find((d) => d.id === id);
  const at0 = shapeAt(def, undefined, 0), at90 = shapeAt(def, undefined, 90);
  ok(turned(at0.body, at90.body) && turned(at0.body, shapeAt(def, undefined, 270).body), `${def.name}: the body turns with the part`);
  ok(at0.body.w === shapeAt(def, undefined, 180).body.w, `${def.name}: and is the same shape upside down`);
}
const pot = byId("def-potentiometer");
const trimmer = { ...pot, ...footprintFor(pot, "trimmer") };
for (const rotation of [0, 90, 180, 270]) {
  const shape = shapeAt(trimmer, "trimmer", rotation);
  const pins = getRotatedPinPositions(trimmer, { row: 10, col: 10 }, rotation);
  const b = getComponentBounds(trimmer, { row: 10, col: 10 }, rotation);
  const wiper = pins[1];
  const wx = (wiper.col - (b.minCol + b.maxCol) / 2) * 2.54, wy = (wiper.row - (b.minRow + b.maxRow) / 2) * 2.54;
  const screw = shape.pieces.find((p) => p.t === "circle");
  ok(Math.sign(screw.cx) === Math.sign(wx) && Math.sign(screw.cy) === Math.sign(wy), `trimmer at ${rotation}: the screw sits on the wiper's side`);
  const longAxis = shape.body.w > shape.body.h ? "x" : "y";
  ok(longAxis === (wx === 0 ? "y" : "x"), `trimmer at ${rotation}: the body is longer along the wiper axis`);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
