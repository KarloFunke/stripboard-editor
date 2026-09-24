// The body the layout engines clear must be the body that is drawn, and the
// clearance rules must come out the way a real board is built.
const path = require("path");
const OUT = path.join(__dirname, "out");
const { packageOptions, footprintFor, resolvePackage } = require(path.join(OUT, "components/stripboard/packageBodies.js"));
const { rigidShape } = require(path.join(OUT, "components/stripboard/rigidBodies.js"));
const { flexProfile, flexBody, rigidBody } = require(path.join(OUT, "components/stripboard/partGeometry.js"));
const { capsulesClash, capsuleClashesRect, bodyRectsClash, coveredHoles, bodiesTooClose, flatSpan, spanLimits } =
  require(path.join(OUT, "components/stripboard/flexGeometry.js"));
const { getComponentBounds, getRotatedPinPositions } = require(path.join(OUT, "components/stripboard/boardLayout.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed++;
}
const defOf = (id) => DEFAULT_COMPONENTS.find((d) => d.id === id);
const MM = 2.54;

console.log("\nrigid packages: drawing and body agree");
const problems = [];
let checked = 0;
for (const base of DEFAULT_COMPONENTS) {
  for (const option of packageOptions(base)) {
    const resolved = resolvePackage(base, undefined, option.id);
    if (resolved.kind !== "rigid") continue;
    const fp = footprintFor(base, option.id);
    const def = fp ? { ...base, ...fp } : base;
    for (const rotation of [0, 90, 180, 270]) {
      const bounds = getComponentBounds(def, { row: 0, col: 0 }, rotation);
      const midRow = (bounds.minRow + bounds.maxRow) / 2;
      const midCol = (bounds.minCol + bounds.maxCol) / 2;
      const pins = getRotatedPinPositions(def, { row: 0, col: 0 }, rotation)
        .map((p) => ({ x: (p.col - midCol) * MM, y: (p.row - midRow) * MM, id: p.pinId }));
      const shape = rigidShape(resolved.spec, {
        pins, rotation,
        width: (bounds.maxCol - bounds.minCol + 1) * MM,
        height: (bounds.maxRow - bounds.minRow + 1) * MM,
      });
      checked++;
      const tag = `${base.id}/${option.id}@${rotation}`;
      const b = shape.body;
      // Every outlined piece is plastic on the board, so it lies in the body.
      for (const piece of shape.pieces) {
        if (!piece.outline) continue;
        const box = piece.t === "circle"
          ? { x: piece.cx - piece.rad, y: piece.cy - piece.rad, w: piece.rad * 2, h: piece.rad * 2 }
          : piece;
        if (box.x < b.x - 0.01 || box.y < b.y - 0.01 || box.x + box.w > b.x + b.w + 0.01 || box.y + box.h > b.y + b.h + 0.01) {
          problems.push(`${tag}: a drawn piece leaves the body`);
        }
      }
      // A body that covers its pins must actually be over them.
      if (resolved.spec.coversPins) {
        for (const p of pins) {
          const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
          const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
          if (Math.hypot(dx, dy) > 0.2) problems.push(`${tag}: pin ${p.id} is ${Math.hypot(dx, dy).toFixed(2)} mm outside the body`);
        }
      }
      // A footprint written by the picker must reserve every hole the body is over.
      if (fp) {
        const covered = coveredHoles(rigidBody(def, { row: 0, col: 0 }, rotation, { package: option.id }));
        if (covered.minRow < bounds.minRow || covered.maxRow > bounds.maxRow || covered.minCol < bounds.minCol || covered.maxCol > bounds.maxCol) {
          problems.push(`${tag}: the body covers holes its footprint does not reserve`);
        }
      }
    }
  }
}
ok(problems.length === 0, `${checked} package, definition and rotation combinations`);
for (const p of problems) console.log(`       ${p}`);

console.log("\nrigid bodies");
{
  const npn = defOf("def-npn");
  const a = rigidBody(npn, { row: 0, col: 0 }, 0);
  ok(a.maxCol > 0.3 && a.maxCol < 0.5 && a.minCol === 0, "a TO-92 bulges under half a pitch on its round side, none on the flat");
  ok(bodyRectsClash(a, rigidBody(npn, { row: 0, col: 1 }, 0)), "two TO-92 in neighbouring columns collide");
  ok(!bodyRectsClash(a, rigidBody(npn, { row: 0, col: 2 }, 0)), "with a free column between they do not");
  const dip = defOf("def-ic-dip8");
  ok(!bodyRectsClash(rigidBody(dip, { row: 0, col: 0 }, 0), rigidBody(dip, { row: 4, col: 0 }, 0)), "two DIPs may still sit end to end");
  const pot = defOf("def-potentiometer");
  const c = coveredHoles(rigidBody(pot, { row: 5, col: 5 }, 0));
  ok(c.minRow === 3 && c.maxRow === 9 && c.minCol === 3 && c.maxCol === 5, `a standing pot lies over 7 by 3 holes (${JSON.stringify(c)})`);
  const header = defOf("def-connector-3");
  const h = rigidBody(header, { row: 0, col: 0 }, 0);
  ok(h.minCol === 0 && h.maxCol === 0 && h.minRow === 0 && h.maxRow === 2, "a pin header is exactly its cells");
}

console.log("\nflexible bodies");
{
  const R = defOf("def-resistor");
  const at = (def, part, r1, c1, r2, c2) => flexBody(flexProfile(def, part), { row: r1, col: c1 }, { row: r2, col: c2 });
  const H = { package: "r-half" };
  const half = flexProfile(R, H);
  ok(capsulesClash(at(R, H, 0, 0, 0, 4), at(R, H, 1, 0, 1, 4), half.lines), "1/2 W resistors on neighbouring strips collide");
  ok(!capsulesClash(at(R, H, 0, 0, 0, 4), at(R, H, 2, 0, 2, 4), half.lines), "one free strip between them is enough");
  ok(!capsulesClash(at(R, H, 0, 0, 0, 4), at(R, H, 0, 5, 0, 9), half.lines), "end to end in one strip is fine");
  const q = {};   // the default resistor is the 1/4 W
  ok(!capsulesClash(at(R, q, 0, 0, 0, 4), at(R, q, 1, 0, 1, 4), 0), "1/4 W resistors fit on neighbouring strips");
  ok(capsulesClash(at(R, q, 0, 0, 0, 4), at(R, q, 1, 0, 1, 4), 1), "unless the user asks for a free line");
  ok(!capsulesClash(at(R, q, 0, 0, 0, 4), at(R, q, 2, 0, 2, 4), 1), "which one free line satisfies");
  const w5 = { package: "r-5w" };
  ok(capsulesClash(at(R, w5, 0, 0, 0, 10), at(R, {}, 2, 0, 2, 4), 0), "a 5 W block reaches a resistor two strips away");
  ok(!capsulesClash(at(R, w5, 0, 0, 0, 10), at(R, {}, 3, 0, 3, 4), 0), "but not one three away");
  ok(flatSpan({ ...R, part: H }) === 4 && flatSpan(R) === 3 && flatSpan({ ...R, part: w5 }) === 10, "flat spans: 4, 3 and 10 holes apart");
  ok(spanLimits(R).min === 3 && spanLimits({ ...R, allowStanding: true }).min === 1, "standing is only allowed where the project says so");
  ok(spanLimits({ ...defOf("def-diode"), allowStanding: true }).min === 1 && spanLimits({ ...defOf("def-inductor"), allowStanding: true }).min === 4, "diodes may stand too, an inductor never does");
  const capSpan = spanLimits(defOf("def-capacitor")), ledSpan = spanLimits(defOf("def-led"));
  ok(capSpan.min === 1 && capSpan.max === 4 && ledSpan.max === 4, "a radial part stays near its legs: at most 4 holes apart");
  ok(spanLimits({ ...R, id: "custom-two-pin" }).max === 6, "a part with no package keeps the limits it always had");
  ok(spanLimits({ ...R, spanOverride: { min: 2, max: 7 } }).min === 2, "the user's own span limits still win");
  ok(spanLimits(defOf("def-diode")).min === 3 && spanLimits(defOf("def-fuse")).min === 5, "a DO-41 lies flat from 3 holes apart, a 3.6 x 10 fuse from 5");
  const F = defOf("def-fuse");
  ok(F.pins[1].offsetRow === 5, "and the fuse's default footprint is exactly that long");
  const tr5 = spanLimits({ ...F, part: { package: "fuse-tr5" } });
  ok(tr5.min === 2 && tr5.max === 2, "a radial micro fuse stands on legs two holes apart");

  const standing = at(R, {}, 0, 0, 0, 2);
  ok(standing.a.col === 0 && standing.b.col === 0, "too short to lie flat, it stands on its left lead");
  ok(at(R, {}, 0, 2, 0, 0).a.col === 0, "whichever lead was placed first");

  const C = defOf("def-cap-polarized");
  const big = at(C, { value: "1000uF" }, 5, 5, 6, 5);
  ok(capsulesClash(big, at(R, {}, 3, 7, 7, 7), 0), "a 10 mm can reaches a resistor two columns over");
  ok(!capsulesClash(big, at(R, {}, 3, 8, 7, 8), 0), "three columns over is clear");

  const dip = rigidBody(defOf("def-ic-dip8"), { row: 0, col: 0 }, 0);
  ok(capsuleClashesRect(at(R, H, 0, 4, 4, 4), dip, 0), "a 1/2 W resistor flat against a DIP collides");
  ok(!capsuleClashesRect(at(R, {}, 0, 4, 4, 4), dip, 0), "a 1/4 W one fits there");
  ok(!capsuleClashesRect(at(R, {}, 0, 5, 4, 5), dip, 0), "a column away it does not");
  ok(!capsuleClashesRect(at(R, {}, 1, 4, 1, 8), dip, 0), "end on beside the DIP is fine");

  // A flexible part with no package keeps the old rule exactly, on the grid.
  const plain = { ...R, id: "custom-two-pin" };
  const prof = flexProfile(plain);
  let same = prof.lines === 1;
  for (let row = 0; row <= 3; row++) for (let col = -2; col <= 6; col++) {
    const a1 = { row: 0, col: 0 }, a2 = { row: 0, col: 4 }, b1 = { row, col }, b2 = { row, col: col + 4 };
    const now = capsulesClash(flexBody(prof, a1, a2), flexBody(prof, b1, b2), prof.lines);
    if (row > 0 && now !== bodiesTooClose(a1, a2, b1, b2, 1)) same = false;
  }
  ok(same, "a part with no package behaves as before");
}

console.log("\noverlap hint");
{
  const { bodyClashes } = require(path.join(OUT, "components/stripboard/partGeometry.js"));
  const mk = (id, defId, row, col, extra = {}) => ({ id, defId, label: id, boardPos: { row, col }, rotation: 0, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, ...extra });
  const resolve = (c) => { const d = defOf(c.defId); return d && { ...d, part: { value: c.value, package: c.package } }; };
  const parts = [
    mk("R1", "def-resistor", 0, 0, { flexibleEndPos: { row: 0, col: 4 }, package: "r-half" }),
    mk("R2", "def-resistor", 1, 0, { flexibleEndPos: { row: 1, col: 4 }, package: "r-half" }),   // on the next strip: collides
    mk("R3", "def-resistor", 3, 0, { flexibleEndPos: { row: 3, col: 4 } }),   // a free strip away: fine
    mk("RV1", "def-potentiometer", 10, 10),                                    // shaft runs toward +col
    mk("C1", "def-capacitor", 11, 14, { flexibleEndPos: { row: 12, col: 14 } }), // under the shaft
    mk("Q1", "def-npn", 20, 2), mk("Q2", "def-npn", 20, 4),                    // a column between: fine
    mk("X", "def-resistor", 30, 0, { flexibleEndPos: { row: 30, col: 4 }, boardExcluded: true }),
  ];
  const hit = [...bodyClashes(parts, resolve)].sort().join();
  ok(hit === "C1,R1,R2,RV1", `colliding bodies and a part under a shaft are flagged, nothing else (${hit})`);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
