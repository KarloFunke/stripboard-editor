import { pinKey } from "../keys";
import { Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions, getComponentBounds } from "../boardLayout";
import { spanLimits } from "../flexGeometry";
import {
  ClusterAnalysis, ConfigKeys, DimLimits, Flex, KeyInfo, RigidCand,
  RigidRotation, Rot, Side, Tile, TilePlan, allowedDrows,
} from "./tileModel";
import { packTile } from "./tilePacking";

const PLAN_NODE_BUDGET = 300000;

// ── Stage 1: plan one cluster strip-first ──────────────

const ROTS: Rot[] = [0, 90, 180, 270];

function rigidRotations(comp: Component, def: ComponentDef, netOf: Map<string, string>): RigidRotation[] {
  const out: RigidRotation[] = [];
  for (const rot of ROTS) {
    const pins = getRotatedPinPositions(def, { row: 0, col: 0 }, rot);
    const byRow = new Map<number, { col: number; netId: string | undefined }[]>();
    for (const p of pins) {
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row)!.push({ col: p.col, netId: netOf.get(pinKey(comp.id, p.pinId)) });
    }
    // Pins per row decide what the row can host. The assigned pins, in
    // column order, must form at most two same-net blocks: one block owns
    // the row ("F"), two blocks split it left/right with a cut between
    // them. Floating pins anywhere just get cut off and don't count.
    // Interleavings like A B A can never share the row's copper and
    // reject the rotation.
    let ok = true;
    let clean = true;
    const pinned = new Map<string, { row: number; side: Side }>();
    const pinClaims: RigidRotation["pinClaims"] = [];
    for (const [row, rowPins] of byRow) {
      const sorted = [...rowPins].sort((a, b) => a.col - b.col);
      const seq = sorted.filter((x) => x.netId);
      let blocks = 0;
      for (let i = 0; i < seq.length; i++) {
        if (i === 0 || seq[i].netId !== seq[i - 1].netId) blocks++;
      }
      if (blocks > 2) {
        ok = false;
        break;
      }
      const firstNet = seq[0]?.netId;
      for (const { col, netId } of sorted) {
        if (!netId) continue;
        pinClaims.push({ net: netId, row, col });
        const side: Side = blocks <= 1 ? "F" : netId === firstNet ? "L" : "R";
        if (!pinned.has(netId)) pinned.set(netId, { row, side });
        // Every floating neighbour forces a cut, so an assigned pin walled
        // in by other-net or floating pins on BOTH sides sits on a one-hole
        // segment nothing can ever reach (a DIP laid along a strip). Such a
        // rotation is legal but unbuildable in practice.
        const openLeft = rowPins.every((x) => x.col >= col || x.netId === netId);
        const openRight = rowPins.every((x) => x.col <= col || x.netId === netId);
        if (!openLeft && !openRight) clean = false;
      }
    }
    if (!ok) continue;
    out.push({ rot, box: getComponentBounds(def, { row: 0, col: 0 }, rot), pinned, pinClaims, clean });
  }
  // Prefer buildable orientations; fall back to the full list only when no
  // rotation is clean (grid-array parts) so the part still places somehow.
  const cleanOut = out.filter((r) => r.clean);
  return cleanOut.length > 0 ? cleanOut : out;
}

export function analyzeCluster(
  cluster: Component[],
  asg: NetAssignment[],
  componentDefs: ComponentDef[]
): ClusterAnalysis {
  const netOf = new Map<string, string>();
  for (const a of asg) netOf.set(pinKey(a.componentId, a.pinId), a.netId);
  const cands: RigidCand[] = [];
  const taps: ClusterAnalysis["taps"] = [];
  const flexes: Flex[] = [];
  const flexTaps: ClusterAnalysis["flexTaps"] = [];
  const skipped: Component[] = [];
  // Locked parts the tile planner can't take as fixed members (flexes, or a
  // rotation the row model rejects) are dropped here, not skipped: they stay
  // placed and the orchestrator treats them as global obstacles.
  for (const comp of cluster) {
    const def = resolveComponentDef(comp, componentDefs);
    const isFixed = !!(comp.locked && comp.boardPos && !comp.boardExcluded);
    if (!def) {
      if (!isFixed) skipped.push(comp);
      continue;
    }
    if (def.flexible) {
      if (isFixed) continue;
      const a = netOf.get(`${comp.id}:${def.pins[0]?.id}`);
      const b = netOf.get(`${comp.id}:${def.pins[1]?.id}`);
      if (a && b) flexes.push({ comp, def, netA: a, netB: b });
      else if (a || b) flexTaps.push({ comp, def, net: (a ?? b)!, firstAssigned: !!a });
      else skipped.push(comp);
      continue;
    }
    const assigned = def.pins.filter((p) => netOf.has(pinKey(comp.id, p.id)));
    // The tap path claims exactly one hole, so only parts that ARE one hole
    // belong there. A bigger rigid with a single connected pin (a transistor
    // with dangling legs, an IC with one net wired) goes the rigid route so
    // its whole footprint occupies space; with no connected pin it stays
    // here and comes back unplaced, like any other unconnected part.
    const oneHole = def.pins.length === 1 && def.width === 1 && def.height === 1;
    if (!isFixed && (assigned.length === 0 || (assigned.length === 1 && oneHole))) {
      taps.push({ comp, def });
    } else {
      // a locked rigid joins with its rotation frozen and position pinned;
      // its block gets designed around it
      let rotations = rigidRotations(comp, def, netOf);
      if (isFixed) rotations = rotations.filter((r) => r.rot === ((comp.rotation ?? 0) as Rot));
      if (rotations.length === 0) { if (!isFixed) skipped.push(comp); }
      else {
        cands.push({
          comp, def, rotations,
          ...(isFixed ? { fixed: { row: comp.boardPos!.row, col: comp.boardPos!.col } } : {}),
        });
      }
    }
  }

  // Chain-order the rigids by shared nets so neighbors in the row plan are
  // the ones that can actually share strips.
  const netsOfComp = new Map<string, Set<string>>();
  for (const a of asg) {
    if (!netsOfComp.has(a.componentId)) netsOfComp.set(a.componentId, new Set());
    netsOfComp.get(a.componentId)!.add(a.netId);
  }
  const shared = (a: Component, b: Component) => {
    let n = 0;
    for (const x of netsOfComp.get(a.id) ?? []) if (netsOfComp.get(b.id)?.has(x)) n++;
    return n;
  };
  const rigids: RigidCand[] = [];
  if (cands.length > 0) {
    const total = cands.map((c) => cands.reduce((s, o) => s + (o === c ? 0 : shared(c.comp, o.comp)), 0));
    let seed = 0;
    for (let i = 1; i < cands.length; i++) if (total[i] > total[seed]) seed = i;
    rigids.push(cands[seed]);
    const rest = cands.filter((_, i) => i !== seed);
    while (rest.length > 0) {
      let best = 0;
      let bestW = -1;
      rest.forEach((c, i) => {
        const w = Math.max(...rigids.map((r) => shared(r.comp, c.comp)));
        if (w > bestW) {
          bestW = w;
          best = i;
        }
      });
      rigids.push(rest[best]);
      rest.splice(best, 1);
    }
  }
  const groupOf = new Map<string, number>();
  rigids.forEach((r, i) => groupOf.set(r.comp.id, i));
  for (const comp of cluster) {
    if (groupOf.has(comp.id)) continue;
    let bi = 0;
    let bs = -1;
    rigids.forEach((r, i) => {
      const s = shared(r.comp, comp);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    });
    groupOf.set(comp.id, bi);
  }
  return { netOf, rigids, groupOf, taps, flexes, flexTaps, skipped };
}

function buildKeys(rotSel: RigidRotation[], offsets: number[]): ConfigKeys {
  const entriesByNet = new Map<string, { gi: number; row: number; side: Side }[]>();
  const rowsWithPins = rotSel.map(() => new Set<number>());
  const pinRows = new Set<number>();
  let minR = Infinity;
  let maxR = -Infinity;
  rotSel.forEach((rr, gi) => {
    for (const c of rr.pinClaims) {
      rowsWithPins[gi].add(c.row + offsets[gi]);
      pinRows.add(c.row + offsets[gi]);
    }
    for (const [net, p] of rr.pinned) {
      if (!entriesByNet.has(net)) entriesByNet.set(net, []);
      entriesByNet.get(net)!.push({ gi, row: p.row + offsets[gi], side: p.side });
    }
    minR = Math.min(minR, offsets[gi] + rr.box.minRow);
    maxR = Math.max(maxR, offsets[gi] + rr.box.maxRow);
  });
  const clearBetween = (a: number, b: number, row: number) => {
    for (let g = a + 1; g < b; g++) if (rowsWithPins[g].has(row)) return false;
    return true;
  };
  const keyInfo = new Map<string, KeyInfo>();
  const keyOfEntry = new Map<string, string>();
  const altReal = new Map<string, string>();
  let wiresPinned = 0;
  for (const [net, entries] of entriesByNet) {
    entries.sort((a, b) => a.gi - b.gi);
    const runs: (typeof entries)[] = [];
    for (const e of entries) {
      const run = runs[runs.length - 1];
      const prev = run?.[run.length - 1];
      if (prev !== undefined && e.row === prev.row && prev.side !== "L" && e.side !== "R" &&
        clearBetween(prev.gi, e.gi, e.row)) {
        run.push(e);
      } else {
        runs.push([e]);
      }
    }
    wiresPinned += runs.length - 1;
    runs.forEach((run, idx) => {
      const key = idx === 0 ? net : `${net}@${idx}`;
      if (idx > 0) altReal.set(key, net);
      const regions = new Set<number>();
      let rankLo = Infinity;
      let rankHi = -Infinity;
      for (const e of run) {
        if (e.side !== "R") regions.add(e.gi);
        if (e.side !== "L") regions.add(e.gi + 1);
        rankLo = Math.min(rankLo, e.side === "R" ? 2 * e.gi + 1 : 2 * e.gi);
        rankHi = Math.max(rankHi, e.side === "L" ? 2 * e.gi : 2 * e.gi + 1);
        keyOfEntry.set(`${e.gi}:${net}`, key);
      }
      for (let j = 1; j < run.length; j++) {
        for (let r = run[j - 1].gi + 1; r <= run[j].gi; r++) regions.add(r);
      }
      keyInfo.set(key, {
        row: run[0].row, regions, rankLo, rankHi,
        entries: run.map((e) => ({ gi: e.gi, side: e.side })),
      });
      minR = Math.min(minR, run[0].row);
      maxR = Math.max(maxR, run[0].row);
    });
  }
  return {
    keyInfo, keyOfEntry, altReal, wiresPinned, pinRows,
    minR: Number.isFinite(minR) ? minR : 0,
    maxR: Number.isFinite(maxR) ? maxR : 1,
  };
}

function planConfig(
  analysis: ClusterAnalysis,
  rotSel: RigidRotation[],
  offsets: number[],
  ck: ConfigKeys,
  budget: number,
  allowShare: boolean,
  limits: DimLimits
): TilePlan | null {
  const { netOf, taps, flexes, flexTaps, groupOf, rigids } = analysis;
  const k = rigids.length;
  const allRegions = new Set<number>(Array.from({ length: k + 1 }, (_, i) => i));
  const regionsOfKey = (key: string) => ck.keyInfo.get(key)?.regions ?? allRegions;
  const keyFor = (net: string, gi: number): string => {
    const direct = ck.keyOfEntry.get(`${gi}:${net}`);
    if (direct) return direct;
    let best: string | null = null;
    let bd = Infinity;
    for (const [key, inf] of ck.keyInfo) {
      if (key !== net && ck.altReal.get(key) !== net) continue;
      for (const r of inf.regions) {
        const d = Math.min(Math.abs(r - gi), Math.abs(r - gi - 1));
        if (d < bd) {
          bd = d;
          best = key;
        }
      }
    }
    return best ?? net;
  };

  // A part whose two segments share no reachable column range — or whose
  // two pinned rows are an illegal span apart — gets an extra full row for
  // one end ("around the chip"), joined by one wire later.
  const altReal = new Map(ck.altReal);
  const altOf = new Map<string, string>();
  const flexEff = new Map<string, { a: string; b: string }>();
  interface Constraint { a: string; b: string; D: Map<number, number>; compId: string }
  const constraints: Constraint[] = [];
  let altWires = 0;
  for (const f of flexes) {
    const gi = groupOf.get(f.comp.id) ?? 0;
    const a = keyFor(f.netA, gi);
    let b = keyFor(f.netB, gi);
    if (ck.keyInfo.has(a) && ck.keyInfo.has(b)) {
      const ra = regionsOfKey(a);
      const disjoint = ![...regionsOfKey(b)].some((r) => ra.has(r));
      const dr = Math.abs(ck.keyInfo.get(a)!.row - ck.keyInfo.get(b)!.row);
      if (disjoint || !allowedDrows(f.def).has(dr)) {
        if (!altOf.has(b)) {
          const alt = `${b}#alt`;
          altOf.set(b, alt);
          altReal.set(alt, ck.altReal.get(b) ?? b);
          altWires++;
        }
        b = altOf.get(b)!;
      }
    }
    flexEff.set(f.comp.id, { a, b });
    constraints.push({ a, b, D: allowedDrows(f.def), compId: f.comp.id });
  }

  const tapKey = new Map<string, string>();
  const allKeys = new Set<string>();
  for (const { a, b } of flexEff.values()) {
    allKeys.add(a);
    allKeys.add(b);
  }
  for (const t of taps) {
    const pin = t.def.pins.find((p) => netOf.has(pinKey(t.comp.id, p.id)));
    if (!pin) continue;
    const key = keyFor(netOf.get(pinKey(t.comp.id, pin.id))!, groupOf.get(t.comp.id) ?? 0);
    tapKey.set(t.comp.id, key);
    allKeys.add(key);
  }
  for (const ft of flexTaps) {
    const key = keyFor(ft.net, groupOf.get(ft.comp.id) ?? 0);
    tapKey.set(ft.comp.id, key);
    allKeys.add(key);
  }
  for (const key of ck.keyInfo.keys()) allKeys.add(key);
  const freeKeys = [...allKeys].filter((x) => !ck.keyInfo.has(x)).sort();
  const degreeOf = (id: string) => constraints.filter((c) => c.a === id || c.b === id).length;
  freeKeys.sort((x, yv) => degreeOf(yv) - degreeOf(x) || (x < yv ? -1 : 1));

  const pinnedRows = new Set<number>(ck.pinRows);
  for (const inf of ck.keyInfo.values()) pinnedRows.add(inf.row);
  // A locked member fixes where the board's top edge lies in tile rows —
  // nothing may be planned above it (or below a locked row cap).
  let rowMin = -Infinity;
  rotSel.forEach((rr, gi) => {
    const f = rigids[gi].fixed;
    if (f) rowMin = Math.max(rowMin, offsets[gi] - f.row);
  });
  const rowMax = limits.maxRows !== undefined && rowMin > -Infinity ? rowMin + limits.maxRows - 1 : Infinity;
  const LO = ck.minR - 10;
  const HI = ck.maxR + 10;
  const rowOrder: number[] = [];
  for (let row = LO; row <= HI; row++) {
    if (row >= rowMin && row <= rowMax) rowOrder.push(row);
  }
  const mid = (ck.minR + ck.maxR) / 2;
  rowOrder.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);

  const totalRigidW = rotSel.reduce((s, rr) => s + (rr.box.maxCol - rr.box.minCol + 1), 0) + Math.max(0, k - 1);
  let fixWidthLo = Infinity;
  let fixWidthHi = -Infinity;
  rotSel.forEach((rr, gi) => {
    const f = rigids[gi].fixed;
    if (!f) return;
    fixWidthLo = Math.min(fixWidthLo, f.col + rr.box.minCol);
    fixWidthHi = Math.max(fixWidthHi, f.col + rr.box.maxCol);
  });
  const widthFloor = fixWidthHi >= fixWidthLo ? fixWidthHi - fixWidthLo + 1 : 0;
  const y = new Map<string, number>([...ck.keyInfo].map(([key, inf]) => [key, inf.row]));
  let best: { assignment: Map<string, number>; area: number; height: number; span: number } | null = null;
  let nodes = 0;

  const evaluate = () => {
    const rows = [...y.values(), ck.minR, ck.maxR];
    const height = Math.max(...rows) - Math.min(...rows) + 1;
    let span = 0;
    // Parts with overlapping row spans need ~2 columns each (plus extra for
    // diagonals), so the max crossing count per row bounds the tile width.
    // Optimizing area — not height — keeps tiles composable.
    const crossing = new Map<number, number>();
    for (const c of constraints) {
      const ra = y.get(c.a)!;
      const rb = y.get(c.b)!;
      const drow = Math.abs(ra - rb);
      const dc = c.D.get(drow) ?? 0;
      span += drow + 2 * dc;
      // a part along one row eats dc+1 columns of that row alone; a
      // vertical/diagonal part eats ~2(1+dc) columns of every row it spans
      const w = drow === 0 ? (dc + 2) / 2 : 1 + dc;
      for (let r = Math.min(ra, rb); r <= Math.max(ra, rb); r++) {
        crossing.set(r, (crossing.get(r) ?? 0) + w);
      }
    }
    const maxCross = Math.max(0, ...crossing.values());
    const widthEst = Math.max(2 * maxCross + totalRigidW + 2, widthFloor);
    const capPenalty =
      (limits.maxCols ? Math.max(0, widthEst - limits.maxCols) : 0) +
      (limits.maxRows ? Math.max(0, height - limits.maxRows) : 0);
    return { height, span, area: height * widthEst + 200 * capPenalty };
  };

  // A violated span constraint is not fatal: the part gets a fresh row and
  // one wire during packing. The search minimizes violations first.
  let bestViol = Infinity;
  const search = (idx: number, viol: number) => {
    if (nodes++ > budget) return;
    if (viol > bestViol) return;
    if (idx === freeKeys.length) {
      const s = evaluate();
      if (viol < bestViol || !best || s.area < best.area ||
        (s.area === best.area && (s.height < best.height || (s.height === best.height && s.span < best.span)))) {
        best = { ...s, assignment: new Map(y) };
        bestViol = viol;
      }
      return;
    }
    const key = freeKeys[idx];
    for (const row of rowOrder) {
      if (pinnedRows.has(row)) continue;
      // Two free keys may share a row if a part lies along it between them
      // (the router cuts the strip under the body); more than two won't pack.
      let taken = false;
      const sharers: string[] = [];
      for (const [otherId, otherRow] of y) {
        if (!ck.keyInfo.has(otherId) && otherRow === row) sharers.push(otherId);
      }
      if (!allowShare && sharers.length > 0) taken = true;
      else if (sharers.length >= 2) taken = true;
      else if (sharers.length === 1) {
        const other = sharers[0];
        taken = !constraints.some((c) =>
          ((c.a === key && c.b === other) || (c.b === key && c.a === other)) && c.D.has(0));
      }
      if (taken) continue;
      let addViol = 0;
      for (const c of constraints) {
        const other = c.a === key ? c.b : c.b === key ? c.a : null;
        if (other === null || !y.has(other)) continue;
        if (!c.D.has(Math.abs(row - y.get(other)!))) addViol++;
      }
      if (viol + addViol > bestViol) continue;
      y.set(key, row);
      search(idx + 1, viol + addViol);
      y.delete(key);
      if (best && bestViol === 0 && nodes > budget / 2) return;
    }
  };
  search(0, 0);
  if (!best) return null;
  const chosen = best as { assignment: Map<string, number>; area: number; height: number; span: number };
  const violated = new Set<string>();
  for (const c of constraints) {
    const ra = chosen.assignment.get(c.a);
    const rb = chosen.assignment.get(c.b);
    if (ra !== undefined && rb !== undefined && !c.D.has(Math.abs(ra - rb))) violated.add(c.compId);
  }
  return {
    rotSel, offsets,
    keyInfo: ck.keyInfo, keyOfEntry: ck.keyOfEntry, altReal, flexEff, tapKey, violated,
    wires: ck.wiresPinned + altWires + violated.size,
    ...chosen,
  };
}

const CONFIG_BEAM = 24;
const CONFIG_KEEP = 16;
const WIRE_TILE = 10; // a forced wire inside a tile costs about this much area

/**
 * Plan one cluster as a single tile: every rigid gets a rotation and a
 * vertical offset (searched jointly so nets shared between rigids land on
 * the same strip row), then the free nets and column packing follow.
 * Rigids join the configuration one at a time (chain order) under a beam,
 * so the search stays bounded for any rigid count.
 */
export function planTile(analysis: ClusterAnalysis, limits: DimLimits): Tile | null {
  const { rigids } = analysis;
  const k = rigids.length;
  // Blocks around locked members are rare and their frozen span makes the
  // width estimate uninformative — explore considerably more of them.
  const hasFixed = rigids.some((r) => r.fixed);
  const beamWidth = hasFixed ? CONFIG_BEAM * 2 : CONFIG_BEAM;
  const keepCount = hasFixed ? CONFIG_KEEP * 3 : CONFIG_KEEP;

  interface Cfg { rotSel: RigidRotation[]; offsets: number[]; cheap: number; ck: ConfigKeys }
  const scored = (rotSel: RigidRotation[], offsets: number[]): Cfg => {
    const ck = buildKeys(rotSel, offsets);
    // Estimated area, not height: rigids with disjoint rows stack instead
    // of widening the tile, so flat and tall configurations compete fairly.
    const rowWidth = new Map<number, number>();
    rotSel.forEach((rr, gi) => {
      const w = rr.box.maxCol - rr.box.minCol + 3;
      for (let r = offsets[gi] + rr.box.minRow; r <= offsets[gi] + rr.box.maxRow; r++) {
        rowWidth.set(r, (rowWidth.get(r) ?? 0) + w);
      }
    });
    // locked members fix part of the width outright
    let fixLo = Infinity;
    let fixHi = -Infinity;
    rotSel.forEach((rr, gi) => {
      const f = rigids[gi].fixed;
      if (!f) return;
      fixLo = Math.min(fixLo, f.col + rr.box.minCol);
      fixHi = Math.max(fixHi, f.col + rr.box.maxCol);
    });
    const widthEst = Math.max(1, fixHi - fixLo + 1, ...rowWidth.values());
    const overCap =
      (limits.maxRows ? Math.max(0, (ck.maxR - ck.minR + 1) - limits.maxRows) : 0) +
      (limits.maxCols ? Math.max(0, widthEst - limits.maxCols) : 0);
    // a copper join lost to misalignment costs a wire — worth ~30 cells
    return {
      rotSel, offsets, ck,
      cheap: (ck.maxR - ck.minR + 1) * widthEst + 30 * ck.wiresPinned + 200 * overCap,
    };
  };
  // The offset between two locked rigids is dictated by their frozen board
  // positions; the first locked one anchors the whole tile later.
  const priorFixed = (i: number) => {
    for (let j = 0; j < i; j++) if (rigids[j].fixed) return j;
    return -1;
  };
  let beam: Cfg[] = [scored([], [])];
  for (let i = 0; i < k; i++) {
    const next: Cfg[] = [];
    const fj = rigids[i].fixed ? priorFixed(i) : -1;
    for (const p of beam) {
      for (const rr of rigids[i].rotations) {
        if (fj >= 0) {
          const o = p.offsets[fj] + (rigids[i].fixed!.row - rigids[fj].fixed!.row);
          next.push(scored([...p.rotSel, rr], [...p.offsets, o]));
        } else if (i === 0) {
          next.push(scored([rr], [0]));
        } else {
          const hi = rr.box.maxRow - rr.box.minRow + 1;
          for (let o = p.ck.minR - hi - 2; o <= p.ck.maxR + 2; o++) {
            next.push(scored([...p.rotSel, rr], [...p.offsets, o]));
          }
        }
      }
    }
    next.sort((a, b) => a.cheap - b.cheap);
    beam = next.slice(0, beamWidth);
  }

  // Pack every surviving plan — with and without row sharing — and judge
  // by the real tile, not the estimate
  const budget = Math.max(20000, Math.floor(PLAN_NODE_BUDGET / CONFIG_KEEP));
  let best: { tile: Tile; score: number } | null = null;
  for (const cfg of beam.slice(0, keepCount)) {
    const ck = cfg.ck;
    for (const allowShare of [true, false]) {
      const p = planConfig(analysis, cfg.rotSel, cfg.offsets, ck, budget, allowShare, limits);
      if (!p) continue;
      const t = packTile(analysis, p, limits);
      if (!t) continue;
      // extreme aspect makes boards impractical even at equal area, and a
      // tile beyond a locked board dimension can never fit
      // An anchored tile is judged by its BOARD footprint from the origin:
      // the space between the board edge and the anchor is paid for either
      // way, so a narrow tile pushed right of its locked member must not
      // beat a wider one that fills that space.
      const effH = t.anchor ? t.anchor.row + t.height : t.height;
      const effW = t.anchor ? t.anchor.col + t.width : t.width;
      const overhang = Math.max(0, Math.max(effH, effW) - 45);
      const overCap =
        (limits.maxRows ? Math.max(0, effH - limits.maxRows) : 0) +
        (limits.maxCols ? Math.max(0, effW - limits.maxCols) : 0);
      const score = effH * effW + overhang * overhang + 200 * overCap +
        WIRE_TILE * (p.wires + t.dropWires + 5 * t.unplaced.length);
      if (!best || score < best.score) best = { tile: t, score };
    }
  }
  return best?.tile ?? null;
}
