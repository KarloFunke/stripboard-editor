// Shared harness for the solver test suite. The solver modules are compiled
// by tests/solver/tsconfig.json into out/ (CommonJS); the resolve hook below
// maps the "@/..." path alias onto that output.
const Module = require("module");
const path = require("path");

const OUT = path.join(__dirname, "out");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(OUT, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const { computeAutoFinish, deriveCompletion } = require(path.join(OUT, "components/stripboard/autoFinish.js"));
const { computeAutoPlace } = require(path.join(OUT, "components/stripboard/autoPlace.js"));
const { computeAutoLayout } = require(path.join(OUT, "components/stripboard/autoLayout.js"));
const { computeAutoLayout2 } = require(path.join(OUT, "components/stripboard/autoLayout2.js"));
const { computeStripSegments } = require(path.join(OUT, "components/stripboard/stripSegments.js"));
const { computeConnectivity } = require(path.join(OUT, "components/stripboard/connectivity.js"));
const { checkNetCompleteness } = require(path.join(OUT, "components/stripboard/netCompleteness.js"));
const flexGeometry = require(path.join(OUT, "components/stripboard/flexGeometry.js"));
const boardLayout = require(path.join(OUT, "components/stripboard/boardLayout.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

// ── Component definitions used across tests ────────────

const TP_DEF = {
  id: "tp", name: "TestPin", category: "generic", symbol: "x", defaultLabelPrefix: "TP",
  width: 1, height: 1, pins: [{ id: "1", name: "1", offsetRow: 0, offsetCol: 0 }],
};
const R_DEF = {
  id: "def-resistor", name: "Resistor", category: "passive", symbol: "r", defaultLabelPrefix: "R",
  width: 1, height: 5, flexible: true,
  pins: [
    { id: "1", name: "1", offsetRow: 0, offsetCol: 0 },
    { id: "2", name: "2", offsetRow: 4, offsetCol: 0 },
  ],
};
const C_DEF = {
  id: "def-capacitor", name: "Capacitor", category: "passive", symbol: "c", defaultLabelPrefix: "C",
  width: 1, height: 2, flexible: true,
  pins: [
    { id: "1", name: "1", offsetRow: 0, offsetCol: 0 },
    { id: "2", name: "2", offsetRow: 1, offsetCol: 0 },
  ],
};

function dip(pinCount) {
  const pps = pinCount / 2, pins = [], bodyCells = [];
  for (let i = 0; i < pps; i++) pins.push({ id: `${i + 1}`, name: `${i + 1}`, offsetRow: i, offsetCol: 0 });
  for (let i = 0; i < pps; i++) pins.push({ id: `${pps + i + 1}`, name: `${pps + i + 1}`, offsetRow: pps - 1 - i, offsetCol: 3 });
  for (let r = 0; r < pps; r++) { bodyCells.push({ row: r, col: 1 }); bodyCells.push({ row: r, col: 2 }); }
  return { width: 4, height: pps, pins, bodyCells };
}
const DIP8_DEF = { id: "dip8", name: "DIP8", category: "ic", symbol: "u", defaultLabelPrefix: "U", ...dip(8) };
const HDR4_DEF = {
  id: "hdr4", name: "Header", category: "connector", symbol: "j", defaultLabelPrefix: "J", width: 1, height: 4,
  pins: [0, 1, 2, 3].map((i) => ({ id: `${i + 1}`, name: `${i + 1}`, offsetRow: i, offsetCol: 0 })),
};
const CONN1_DEF = {
  id: "def-connector-1", name: "Connector (1-pin)", category: "connector",
  symbol: "c1", defaultLabelPrefix: "J", width: 1, height: 1,
  pins: [{ id: "1", name: "1", offsetRow: 0, offsetCol: 0 }],
};

const DEFS = [TP_DEF, R_DEF, C_DEF, DIP8_DEF, HDR4_DEF, CONN1_DEF];

// ── Instance factories ─────────────────────────────────

let nextId = 1;
/** A locked 1-pin anchor placed at (row, col) */
function testPin(row, col) {
  const id = `c${nextId++}`;
  return { id, defId: "tp", label: id, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: { row, col }, rotation: 0, locked: true };
}
/** An unplaced flexible part */
function flex(defId, label) {
  const id = `f${nextId++}`;
  return { id, defId, label: label ?? id, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: null, rotation: 0 };
}
/** An unplaced rigid part */
function rigid(defId, label, extra) {
  const id = `u${nextId++}`;
  return { id, defId, label: label ?? id, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: null, rotation: 0, ...(extra ?? {}) };
}
function net(id, name) { return { id, name: name ?? id, color: "#f00" }; }
function assign(netId, comp, pinId) { return { netId, componentId: comp.id, pinId }; }
function emptyBoard(rows, cols) { return { rows, cols, cuts: [], wires: [] }; }

// ── Applying and verifying results ─────────────────────

/** Apply an AutoLayoutResult with the store's replace semantics */
function applyLayout(b, components, result) {
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  return {
    board: {
      ...b,
      cuts: result.cuts,
      wires: result.wires.map((w, i) => ({ id: `w${i}`, ...w })),
    },
    components: components.map((c) => {
      const p = byId.get(c.id);
      if (!p) return c;
      return {
        ...c,
        boardPos: p.boardPos,
        ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
        ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}),
      };
    }),
  };
}

/** Apply an AutoFinishResult with the store's augment semantics */
function applyFinish(b, result) {
  return {
    ...b,
    cuts: [...b.cuts, ...result.cuts],
    wires: [...b.wires, ...result.wires.map((w, i) => ({ id: `af${i}`, ...w }))],
  };
}

/** Run the real checker: conflicts + incomplete nets */
function verify(b, components, nets, assignments, defs) {
  const d = defs ?? DEFS;
  const segments = computeStripSegments(b, components, d, assignments);
  const connectivity = computeConnectivity(segments, b.wires);
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(nets, assignments, segments, connectivity, components, d);
  return { conflicts, incomplete };
}

/**
 * Geometric invariants every layout must satisfy: span limits, flexible
 * bodies not intersecting/too close, corridors clear of pins and rigid
 * bodies, flexible bodies clear of rigid footprints, everything on-board.
 */
function checkGeometry(b, components, defs) {
  const d = defs ?? DEFS;
  const problems = [];
  const resolve = (comp) => comp.footprintOverride
    ? { ...d.find((x) => x.id === comp.defId), ...comp.footprintOverride }
    : d.find((x) => x.id === comp.defId);

  const placed = components.filter((c) => c.boardPos && !c.boardExcluded);
  const flexParts = [];
  const rigidRects = [];
  const pinHoles = new Set();
  const holeKey = (r, c) => `${r},${c}`;

  for (const comp of placed) {
    const def = resolve(comp);
    for (const pin of boardLayout.getComponentPinPositions(comp, def)) {
      if (pin.row < 0 || pin.row >= b.rows || pin.col < 0 || pin.col >= b.cols) {
        problems.push(`${comp.label}: pin off-board at (${pin.row},${pin.col})`);
      }
      pinHoles.add(holeKey(pin.row, pin.col));
    }
    if (def.flexible) {
      const [p1, p2] = boardLayout.getFlexiblePinPositions(comp, def);
      if (p1 && p2) {
        const span = Math.hypot(p1.row - p2.row, p1.col - p2.col);
        const { min, max } = flexGeometry.spanLimits(def);
        if (span < min - 1e-6 || span > max + 1e-6) {
          problems.push(`${comp.label}: span ${span.toFixed(2)} outside [${min},${max}]`);
        }
        flexParts.push({ label: comp.label, p1, p2 });
      }
    } else {
      rigidRects.push(boardLayout.getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }

  for (let i = 0; i < flexParts.length; i++) {
    for (let j = i + 1; j < flexParts.length; j++) {
      const a = flexParts[i], c = flexParts[j];
      if (flexGeometry.segmentsIntersect(a.p1, a.p2, c.p1, c.p2)) {
        problems.push(`${a.label} and ${c.label}: bodies cross`);
      }
      if (flexGeometry.bodiesTooClose(a.p1, a.p2, c.p1, c.p2)) {
        problems.push(`${a.label} and ${c.label}: bodies too close`);
      }
    }
    for (const rect of rigidRects) {
      if (flexGeometry.bodyIntersectsRect(flexParts[i].p1, flexParts[i].p2, rect)) {
        problems.push(`${flexParts[i].label}: body crosses a rigid footprint`);
      }
    }
    for (const h of flexGeometry.corridorHoles(flexParts[i].p1, flexParts[i].p2)) {
      const self1 = h.row === flexParts[i].p1.row && h.col === flexParts[i].p1.col;
      const self2 = h.row === flexParts[i].p2.row && h.col === flexParts[i].p2.col;
      if (!self1 && !self2 && pinHoles.has(holeKey(h.row, h.col))) {
        problems.push(`${flexParts[i].label}: corridor covers a pin at (${h.row},${h.col})`);
      }
    }
  }
  return problems;
}

// ── Assertion bookkeeping ──────────────────────────────

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    failures++;
  }
}
function finish(suiteName) {
  console.log(failures === 0 ? `\n${suiteName}: all passed` : `\n${suiteName}: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

module.exports = {
  computeAutoFinish, deriveCompletion, computeAutoPlace, computeAutoLayout, computeAutoLayout2,
  computeStripSegments, computeConnectivity, checkNetCompleteness,
  flexGeometry, boardLayout, DEFAULT_COMPONENTS,
  TP_DEF, R_DEF, C_DEF, DIP8_DEF, HDR4_DEF, CONN1_DEF, DEFS,
  testPin, flex, rigid, net, assign, emptyBoard,
  applyLayout, applyFinish, verify, checkGeometry,
  assert, finish,
};
