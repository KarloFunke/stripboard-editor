// Layout quality metrics shared by the comparison and composition CLIs.
const {
  computeStripSegments, computeConnectivity, checkNetCompleteness,
  flexGeometry, boardLayout,
} = require("./helpers.js");

// ── Metrics ────────────────────────────────────────────

function resolveDef(comp, defs) {
  const def = defs.find((d) => d.id === comp.defId);
  if (!def) return undefined;
  return comp.footprintOverride ? { ...def, ...comp.footprintOverride } : def;
}

function metrics(board, components, defs, nets, assignments) {
  const placed = components.filter((c) => c.boardPos && !c.boardExcluded);
  const unplaced = components.filter((c) => !c.boardPos && !c.boardExcluded);

  const segments = computeStripSegments(board, components, defs, assignments);
  const connectivity = computeConnectivity(segments, board.wires);
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(nets, assignments, segments, connectivity, components, defs);

  // Strip-completeness: nets whose placed pins all sit on one copper group
  // WITHOUT any wires — the "same-net pins on the same strip" skill.
  const bareConnectivity = computeConnectivity(segments, []);
  const segToGroup = new Map();
  bareConnectivity.forEach((g, gi) => {
    for (const si of g.segmentIndices) segToGroup.set(si, gi);
  });
  const segIndexAt = (row, col) =>
    segments.findIndex((s) => s.row === row && col >= s.startCol && col <= s.endCol);
  const pinsOfNet = new Map();
  const centers = new Map();
  for (const comp of placed) {
    const def = resolveDef(comp, defs);
    if (!def) continue;
    const pins = boardLayout.getComponentPinPositions(comp, def);
    let cr = 0, cc = 0;
    for (const p of pins) { cr += p.row; cc += p.col; }
    centers.set(comp.id, { row: cr / pins.length, col: cc / pins.length });
    for (const p of pins) {
      const a = assignments.find((x) => x.componentId === comp.id && x.pinId === p.pinId);
      if (!a) continue;
      if (!pinsOfNet.has(a.netId)) pinsOfNet.set(a.netId, []);
      pinsOfNet.get(a.netId).push({ row: p.row, col: p.col, compId: comp.id });
    }
  }
  let multiPinNets = 0;
  let stripComplete = 0;
  for (const [, pins] of pinsOfNet) {
    if (pins.length < 2) continue;
    multiPinNets++;
    const groups = new Set(pins.map((p) => segToGroup.get(segIndexAt(p.row, p.col))));
    if (groups.size === 1 && !groups.has(undefined)) stripComplete++;
  }

  // Wire stats, incl. off-axis length and crossings over components
  const obstacles = { rects: [], bodies: [] };
  for (const comp of placed) {
    const def = resolveDef(comp, defs);
    if (!def) continue;
    if (def.flexible) {
      const [p1, p2] = boardLayout.getFlexiblePinPositions(comp, def);
      if (p1 && p2) obstacles.bodies.push({ p1, p2 });
    } else {
      obstacles.rects.push(boardLayout.getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }
  let wireLen = 0, offAxisWires = 0, crossings = 0;
  for (const w of board.wires) {
    const dr = Math.abs(w.from.row - w.to.row);
    const dc = Math.abs(w.from.col - w.to.col);
    wireLen += Math.hypot(dr, dc);
    if (dr > 0 && dc > 0) offAxisWires++;
    for (const rect of obstacles.rects) {
      if (flexGeometry.segmentIntersectsRect(w.from, w.to, rect)) crossings++;
    }
    for (const b of obstacles.bodies) {
      if (flexGeometry.segmentsIntersect(w.from, w.to, b.p1, b.p2)) crossings++;
    }
  }

  // Cohesion: mean center distance between component pairs sharing a small
  // net (large nets like GND connect everything and would swamp the signal)
  let cohesionSum = 0, cohesionPairs = 0;
  for (const [, pins] of pinsOfNet) {
    const compIds = [...new Set(pins.map((p) => p.compId))];
    if (compIds.length < 2 || compIds.length > 4) continue;
    for (let i = 0; i < compIds.length; i++) {
      for (let j = i + 1; j < compIds.length; j++) {
        const a = centers.get(compIds[i]), b = centers.get(compIds[j]);
        cohesionSum += Math.hypot(a.row - b.row, a.col - b.col);
        cohesionPairs++;
      }
    }
  }

  // Bounding box of everything placed
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  const touch = (r, c) => {
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  };
  for (const [, pins] of pinsOfNet) for (const p of pins) touch(p.row, p.col);
  for (const w of board.wires) { touch(w.from.row, w.from.col); touch(w.to.row, w.to.col); }

  return {
    placed: placed.length,
    unplaced: unplaced.length,
    conflicts,
    incomplete: incomplete.length,
    cuts: board.cuts.length,
    wires: board.wires.length,
    wireLen: Math.round(wireLen * 10) / 10,
    offAxisWires,
    crossings,
    stripCompleteNets: `${stripComplete}/${multiPinNets}`,
    stripCompletePct: multiPinNets ? Math.round((100 * stripComplete) / multiPinNets) : 0,
    cohesion: cohesionPairs ? Math.round((cohesionSum / cohesionPairs) * 10) / 10 : 0,
    bboxArea: minR === Infinity ? 0 : (maxR - minR + 1) * (maxC - minC + 1),
  };
}


module.exports = { metrics, resolveDef };
