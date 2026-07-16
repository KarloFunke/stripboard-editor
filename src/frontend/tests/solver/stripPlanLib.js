// Stage-1 planner for the v2 layouter: plan one cluster strip-first.
//
// Nets get strip rows; 2-pin parts become short drops between their two
// nets' rows (vertical, or up to 3 columns diagonal when the span needs
// it). An IC pins its nets to its pin rows: one pin on a row means the net
// owns the whole row ("F"), two different-net pins mean left/right segments
// with the usual cut under the body, more than two rejects that rotation.
// Free nets are assigned by exact search minimizing the tile AREA (height
// alone would cram nets into few rows, making every part parallel and the
// tile maximally wide); columns pack greedily outward from the IC.
const { boardLayout, flexGeometry } = require("./helpers.js");

/** dr -> smallest column offset (0..3) that makes the span legal, per def */
function allowedDrows(def) {
  const { min, max } = flexGeometry.spanLimits(def);
  const D = new Map();
  for (let dr = 1; dr <= Math.floor(max); dr++) {
    for (let dc = 0; dc <= 3; dc++) {
      const d = Math.hypot(dr, dc);
      if (d >= min - 1e-6 && d <= max + 1e-6) {
        if (!D.has(dr)) D.set(dr, dc);
        break;
      }
    }
  }
  return D;
}

/** Split a cluster's parts into one optional multi-pin rigid, taps, flexes */
function analyzeCluster(cluster, asg, resolveDef) {
  const netOf = new Map();
  for (const a of asg) netOf.set(`${a.componentId}:${a.pinId}`, a.netId);
  let ic = null;
  const taps = [];
  const flexes = [];
  const skipped = [];
  for (const comp of cluster) {
    const def = resolveDef(comp);
    if (!def) {
      skipped.push(comp);
      continue;
    }
    if (def.flexible) {
      const a = netOf.get(`${comp.id}:${def.pins[0]?.id}`);
      const b = netOf.get(`${comp.id}:${def.pins[1]?.id}`);
      if (a && b) flexes.push({ comp, def, netA: a, netB: b });
      else skipped.push(comp);
      continue;
    }
    const assigned = def.pins.filter((p) => netOf.has(`${comp.id}:${p.id}`));
    if (assigned.length <= 1) taps.push({ comp, def });
    else if (!ic) ic = { comp, def };
    else return { error: `more than one multi-pin rigid (${comp.label})` };
  }
  return { netOf, ic, taps, flexes, skipped };
}

function planWithRotation(analysis, rot, nodeBudget) {
  const { netOf, ic, flexes } = analysis;
  const pinned = new Map(); // netId -> { row, side: "L" | "R" | "F" }
  let icInfo = null;
  if (ic) {
    const pins = boardLayout.getRotatedPinPositions(ic.def, { row: 0, col: 0 }, rot);
    const minCol = Math.min(...pins.map((p) => p.col));
    const maxCol = Math.max(...pins.map((p) => p.col));
    icInfo = { rot, rows: Math.max(...pins.map((p) => p.row)) + 1, width: maxCol - minCol + 1 };
    const byRow = new Map();
    for (const p of pins) {
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row).push(p);
    }
    for (const [row, rowPins] of byRow) {
      const nets = rowPins.map((p) => ({ p, netId: netOf.get(`${ic.comp.id}:${p.pinId}`) }));
      const distinct = new Set(nets.filter((x) => x.netId).map((x) => x.netId));
      if (distinct.size > 2 || (rowPins.length > 2 && distinct.size > 1)) return null;
      for (const { p, netId } of nets) {
        if (!netId) continue;
        const side = distinct.size <= 1 ? "F" : p.col === minCol ? "L" : "R";
        if (!pinned.has(netId)) pinned.set(netId, { row, side });
      }
    }
  }

  // Constraints between nets. Parts whose nets are pinned to opposite IC
  // sides get the human treatment: the second net receives an extra full
  // row ("around the chip"), joined to its pinned segment by one wire.
  const altOf = new Map();
  const altReal = new Map();
  const constraints = [];
  for (const f of flexes) {
    const pa = pinned.get(f.netA);
    const pb = pinned.get(f.netB);
    let effB = f.netB;
    if (pa && pb && pa.side !== pb.side && pa.side !== "F" && pb.side !== "F") {
      if (!altOf.has(f.netB)) {
        const alt = `${f.netB}#alt`;
        altOf.set(f.netB, alt);
        altReal.set(alt, f.netB);
      }
      effB = altOf.get(f.netB);
    }
    f.effA = f.netA;
    f.effB = effB;
    constraints.push({ a: f.netA, b: effB, D: allowedDrows(f.def), f });
  }

  const allNets = new Set();
  for (const f of flexes) {
    allNets.add(f.effA);
    allNets.add(f.effB);
  }
  for (const t of analysis.taps) {
    const pin = t.def.pins.find((p) => netOf.has(`${t.comp.id}:${p.id}`));
    if (pin) allNets.add(netOf.get(`${t.comp.id}:${pin.id}`));
  }
  for (const id of pinned.keys()) allNets.add(id);
  const freeNets = [...allNets].filter((id) => !pinned.has(id)).sort();
  freeNets.sort((x, y) => {
    const deg = (id) => constraints.filter((c) => c.a === id || c.b === id).length;
    return deg(y) - deg(x) || (x < y ? -1 : 1);
  });

  const pinnedRows = new Set([...pinned.values()].map((p) => p.row));
  const LO = -10, HI = (icInfo ? icInfo.rows : 2) + 10;
  const rowsByCloseness = [];
  for (let row = LO; row < HI; row++) rowsByCloseness.push(row);
  const mid = icInfo ? (icInfo.rows - 1) / 2 : 0;
  rowsByCloseness.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);

  const y = new Map([...pinned].map(([id, p]) => [id, p.row]));
  let best = null;
  let nodes = 0;

  const evaluate = () => {
    const rows = [...y.values()];
    const height = Math.max(...rows) - Math.min(...rows) + 1;
    let span = 0;
    // Width estimate: parts whose row spans overlap must sit in different
    // columns at ~2-column pitch, so the max number of parts crossing any
    // single row bounds the width. Optimizing area (not height) keeps the
    // tile composable.
    const crossing = new Map();
    for (const c of constraints) {
      const ra = y.get(c.a), rb = y.get(c.b);
      const drow = Math.abs(ra - rb);
      const dc = c.D.get(drow) ?? 0;
      // Diagonal drops are wider (they consume 1+dc columns) and uglier;
      // price both so the search prefers straight verticals.
      span += drow + 2 * dc;
      for (let r = Math.min(ra, rb); r <= Math.max(ra, rb); r++) {
        crossing.set(r, (crossing.get(r) ?? 0) + 1 + dc);
      }
    }
    const maxCross = Math.max(0, ...crossing.values());
    const widthEst = 2 * maxCross + (icInfo ? icInfo.width + 2 : 2);
    return { height, span, area: height * widthEst };
  };

  const search = (idx) => {
    if (nodes++ > nodeBudget) return;
    if (idx === freeNets.length) {
      const s = evaluate();
      if (!best || s.area < best.area || (s.area === best.area && (s.height < best.height || (s.height === best.height && s.span < best.span)))) {
        best = { ...s, assignment: new Map(y) };
      }
      return;
    }
    const netId = freeNets[idx];
    for (const row of rowsByCloseness) {
      if (pinnedRows.has(row)) continue;
      let taken = false;
      for (const [otherId, otherRow] of y) {
        if (!pinned.has(otherId) && otherRow === row) { taken = true; break; }
      }
      if (taken) continue;
      let ok = true;
      for (const c of constraints) {
        const other = c.a === netId ? c.b : c.b === netId ? c.a : null;
        if (other === null || !y.has(other)) continue;
        if (!c.D.has(Math.abs(row - y.get(other)))) { ok = false; break; }
      }
      if (!ok) continue;
      y.set(netId, row);
      search(idx + 1);
      y.delete(netId);
      if (best && nodes > nodeBudget / 2) return;
    }
  };
  search(0);
  return best ? { rot, pinned, altReal, icInfo, solution: best } : null;
}

/**
 * Plan one cluster. Returns null when no row assignment exists; otherwise
 * content-normalized part placements (rows/cols from 0), tile dims, and
 * the rows each real net occupies (for stage-2 alignment).
 */
function planCluster(cluster, asg, resolveDef, opts = {}) {
  const analysis = analyzeCluster(cluster, asg, resolveDef);
  if (analysis.error) return { error: analysis.error };
  const { netOf, ic, taps, flexes } = analysis;

  let plan = null;
  for (const rot of ic ? [0, 90, 180, 270] : [0]) {
    const p = planWithRotation(analysis, rot, opts.nodeBudget ?? 300000);
    if (p && (!plan ||
      p.solution.area < plan.solution.area ||
      (p.solution.area === plan.solution.area && p.altReal.size < plan.altReal.size))) {
      plan = p;
    }
  }
  if (!plan) return { error: "no feasible row assignment" };
  const { pinned, altReal, icInfo } = plan;
  const y = plan.solution.assignment;
  const sideOf = (key) => pinned.get(key)?.side ?? "F";

  // ── Column packing (diagonals take the extra columns outward) ──
  const placements = [];
  const colUsage = [];
  const overlaps = (cLo, cHi, top, bot) =>
    colUsage.some((u) => cLo <= u.colHi + 1 && cHi >= u.colLo - 1 && !(top > u.bot || bot < u.top));
  const LC = 0;
  const icRight = ic ? LC + icInfo.width - 1 : 0;
  if (ic) colUsage.push({ colLo: LC - 1, colHi: icRight + 1, top: -1, bot: icInfo.rows });

  const unpacked = [];
  const packOrder = [...flexes].sort((a, b) =>
    (Math.min(y.get(a.effA), y.get(a.effB)) - Math.min(y.get(b.effA), y.get(b.effB))) ||
    (a.comp.label < b.comp.label ? -1 : 1));
  for (const f of packOrder) {
    const rA = y.get(f.effA), rB = y.get(f.effB);
    const top = Math.min(rA, rB), bot = Math.max(rA, rB);
    const dcNeeded = allowedDrows(f.def).get(Math.abs(rA - rB)) ?? 0;
    const sides = new Set([sideOf(f.effA), sideOf(f.effB)]);
    const canLeft = !sides.has("R");
    const canRight = !sides.has("L");
    const options = [];
    if (ic) {
      if (canLeft) for (let k = 1; k <= 24; k++) options.push({ c1: LC - k, dir: -1 });
      if (canRight) for (let k = 1; k <= 24; k++) options.push({ c1: icRight + k, dir: 1 });
      options.sort((a, b) => Math.abs(a.c1 - (a.dir < 0 ? LC : icRight)) - Math.abs(b.c1 - (b.dir < 0 ? LC : icRight)) || a.c1 - b.c1);
    } else {
      for (let k = 0; k <= 24; k++) options.push({ c1: k, dir: 1 });
    }
    let placed = false;
    for (const { c1, dir } of options) {
      const c2 = c1 + dir * dcNeeded;
      const cLo = Math.min(c1, c2), cHi = Math.max(c1, c2);
      if (overlaps(cLo, cHi, top, bot)) continue;
      colUsage.push({ colLo: cLo, colHi: cHi, top, bot });
      placements.push({ comp: f.comp, def: f.def, row1: rA, col1: c1, row2: rB, col2: c2 });
      placed = true;
      break;
    }
    if (!placed) unpacked.push(f);
  }

  // Taps on their net's row, in shared outer columns (fixed bases, so
  // several taps on different rows stack into the same column)
  const tapBaseLeft = Math.min(LC, ...colUsage.map((u) => u.colLo)) - 1;
  const tapBaseRight = Math.max(icRight, ...colUsage.map((u) => u.colHi)) + 1;
  for (const t of taps) {
    const pin = t.def.pins.find((p) => netOf.has(`${t.comp.id}:${p.id}`));
    if (!pin) continue;
    const netId = netOf.get(`${t.comp.id}:${pin.id}`);
    if (!y.has(netId)) continue;
    const row = y.get(netId);
    const side = sideOf(netId);
    let c = side === "R" ? tapBaseRight : tapBaseLeft;
    while (colUsage.some((u) => c >= u.colLo && c <= u.colHi && row >= u.top && row <= u.bot)) {
      c += side === "R" ? 1 : -1;
    }
    colUsage.push({ colLo: c, colHi: c, top: row, bot: row });
    placements.push({ comp: t.comp, def: t.def, row1: row, col1: c });
  }

  // ── Normalize to content coordinates (0-based) ───────
  const allRows = [...y.values()];
  const allCols = colUsage.flatMap((u) => [u.colLo, u.colHi]);
  if (ic) { allRows.push(0, icInfo.rows - 1); allCols.push(LC, icRight); }
  const rOff = -Math.min(...allRows);
  const cOff = -Math.min(...allCols);

  const parts = placements.map((p) => ({
    comp: p.comp,
    def: p.def,
    row1: p.row1 + rOff,
    col1: p.col1 + cOff,
    ...(p.row2 !== undefined ? { row2: p.row2 + rOff, col2: p.col2 + cOff } : {}),
  }));
  const icPart = ic ? { comp: ic.comp, def: ic.def, row: 0 + rOff, col: LC + cOff, rotation: plan.rot } : null;

  const rowsOfNet = new Map();
  for (const [key, row] of y) {
    const real = altReal.get(key) ?? key;
    if (!rowsOfNet.has(real)) rowsOfNet.set(real, new Set());
    rowsOfNet.get(real).add(row + rOff);
  }

  return {
    rot: plan.rot,
    height: Math.max(...allRows) + rOff + 1,
    width: Math.max(...allCols) + cOff + 1,
    span: plan.solution.span,
    altRows: altReal.size,
    parts,
    icPart,
    rowsOfNet,
    pinned,
    y,
    rOff,
    cOff,
    unpacked,
    skipped: analysis.skipped,
  };
}

module.exports = { planCluster, analyzeCluster, allowedDrows };
