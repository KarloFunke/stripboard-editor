import { Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions, getComponentBounds } from "../boardLayout";
import { spanLimits, clearanceOf, FootprintRect } from "../flexGeometry";

const PLAN_NODE_BUDGET = 300000;

// ── Stage 1: plan one cluster strip-first ──────────────

type Rot = 0 | 90 | 180 | 270;
type Side = "L" | "R" | "F";

interface Flex {
  comp: Component;
  def: ComponentDef;
  netA: string;
  netB: string;
}

interface RigidRotation {
  rot: Rot;
  box: FootprintRect; // local bounds (pins + body) at this rotation
  pinned: Map<string, { row: number; side: Side }>; // net -> first local pin row
  pinClaims: { net: string; row: number; col: number }[]; // every assigned pin hole
  clean: boolean; // every assigned pin can reach open board along its row
}

interface RigidCand {
  comp: Component;
  def: ComponentDef;
  rotations: RigidRotation[];
  fixed?: { row: number; col: number }; // locked: this board position is frozen
}

export interface ClusterAnalysis {
  netOf: Map<string, string>;
  rigids: RigidCand[]; // multi-pin rigids, chain-ordered by shared nets
  groupOf: Map<string, number>; // comp id -> index of the rigid it belongs with
  taps: { comp: Component; def: ComponentDef }[];
  flexes: Flex[];
  // flexes with exactly one connected pin: that pin sits on its net's row,
  // the other end just parks on a free row nearby
  flexTaps: { comp: Component; def: ComponentDef; net: string; firstAssigned: boolean }[];
  skipped: Component[];
  // locked parts the tile planner can't take as fixed members (flexes, or a
  // rotation the row model rejects): they stay placed as global obstacles
  fixedOut: Component[];
}

const ROTS: Rot[] = [0, 90, 180, 270];

function rigidRotations(comp: Component, def: ComponentDef, netOf: Map<string, string>): RigidRotation[] {
  const out: RigidRotation[] = [];
  for (const rot of ROTS) {
    const pins = getRotatedPinPositions(def, { row: 0, col: 0 }, rot);
    const byRow = new Map<number, { col: number; netId: string | undefined }[]>();
    for (const p of pins) {
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row)!.push({ col: p.col, netId: netOf.get(`${comp.id}:${p.pinId}`) });
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
  for (const a of asg) netOf.set(`${a.componentId}:${a.pinId}`, a.netId);
  const cands: RigidCand[] = [];
  const taps: ClusterAnalysis["taps"] = [];
  const flexes: Flex[] = [];
  const flexTaps: ClusterAnalysis["flexTaps"] = [];
  const skipped: Component[] = [];
  const fixedOut: Component[] = [];
  for (const comp of cluster) {
    const def = resolveComponentDef(comp, componentDefs);
    const isFixed = !!(comp.locked && comp.boardPos && !comp.boardExcluded);
    if (!def) {
      (isFixed ? fixedOut : skipped).push(comp);
      continue;
    }
    if (def.flexible) {
      if (isFixed) {
        fixedOut.push(comp);
        continue;
      }
      const a = netOf.get(`${comp.id}:${def.pins[0]?.id}`);
      const b = netOf.get(`${comp.id}:${def.pins[1]?.id}`);
      if (a && b) flexes.push({ comp, def, netA: a, netB: b });
      else if (a || b) flexTaps.push({ comp, def, net: (a ?? b)!, firstAssigned: !!a });
      else skipped.push(comp);
      continue;
    }
    const assigned = def.pins.filter((p) => netOf.has(`${comp.id}:${p.id}`));
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
      if (rotations.length === 0) (isFixed ? fixedOut : skipped).push(comp);
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
  return { netOf, rigids, groupOf, taps, flexes, flexTaps, skipped, fixedOut };
}

/** dr -> smallest column offset that makes the span legal */
function allowedDrows(def: ComponentDef): Map<number, number> {
  const { min, max } = spanLimits(def);
  const D = new Map<number, number>();
  // dr = 0 lays the part along one row; when its nets differ the router
  // severs the copper between the pins (an inner-cluster cut)
  const dc0 = Math.max(1, Math.ceil(min - 1e-6));
  if (dc0 <= max + 1e-6) D.set(0, dc0);
  for (let dr = 1; dr <= Math.floor(max); dr++) {
    for (let dc = 0; dc <= 3; dc++) {
      const d = Math.hypot(dr, dc);
      if (d >= min - 1e-6 && d <= max + 1e-6) {
        D.set(dr, dc);
        break;
      }
    }
  }
  return D;
}

interface TilePart {
  comp: Component;
  row1: number;
  col1: number;
  row2?: number;
  col2?: number;
}

export interface Tile {
  height: number;
  width: number;
  parts: TilePart[];
  rigidParts: { comp: Component; row: number; col: number; rotation: Rot }[];
  rowsOfNet: Map<string, Set<number>>;
  unplaced: Component[];
  dropWires: number; // parts that needed a fresh row of their own (one wire each)
  anchor?: { row: number; col: number }; // board position of local (0,0): tile holds locked parts
  flipped?: Tile; // the same block rotated 180° — often aligns better with neighbors
}

// A net pinned by several rigids splits into one key per copper-joinable run
// (same row, compatible sides, nothing pinned in between): keys are what get
// strip rows. `regions` are the column intervals a key's segment can reach
// (region i = the gap left of rigid i; region k = right of the last rigid),
// and [rankLo, rankHi] is the key's segment interval along its row — claims
// of keys with disjoint intervals must keep left-to-right order or no cut
// can separate them.
interface KeyInfo {
  row: number;
  regions: Set<number>;
  rankLo: number;
  rankHi: number;
  entries: { gi: number; side: Side }[]; // which rigids pin this key, and how
}

interface ConfigKeys {
  keyInfo: Map<string, KeyInfo>;
  keyOfEntry: Map<string, string>; // `${rigidIdx}:${netId}` -> key
  altReal: Map<string, string>;
  wiresPinned: number; // joins the copper can't make: one wire each
  pinRows: Set<number>;
  minR: number;
  maxR: number;
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

interface TilePlan {
  rotSel: RigidRotation[];
  offsets: number[];
  keyInfo: Map<string, KeyInfo>;
  keyOfEntry: Map<string, string>;
  altReal: Map<string, string>; // any non-base key -> its real net
  flexEff: Map<string, { a: string; b: string }>;
  tapKey: Map<string, string>;
  assignment: Map<string, number>;
  violated: Set<string>; // flex comp ids whose span constraint had to give
  wires: number;
  area: number;
  height: number;
  span: number;
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
    const pin = t.def.pins.find((p) => netOf.has(`${t.comp.id}:${p.id}`));
    if (!pin) continue;
    const key = keyFor(netOf.get(`${t.comp.id}:${pin.id}`)!, groupOf.get(t.comp.id) ?? 0);
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

function packTile(analysis: ClusterAnalysis, plan: TilePlan, limits: DimLimits): Tile | null {
  const { taps, flexes, flexTaps, groupOf, rigids, skipped } = analysis;
  const k = rigids.length;
  const y = plan.assignment;
  const info = (key: string) => plan.keyInfo.get(key);
  const allRegions = new Set<number>(Array.from({ length: k + 1 }, (_, i) => i));
  const regionsOfKey = (key: string) => info(key)?.regions ?? allRegions;

  // ── Column packing (diagonals take their extra columns outward) ──
  // Margin per pair = both parts' clearance halos, rounded up to the grid:
  // two default halos (0.5 + 0.5) give the classic one free column between
  // parallel bodies; a pair of 0-halo parts may sit in adjacent columns.
  interface Usage { colLo: number; colHi: number; top: number; bot: number; clr: number }
  const colUsage: Usage[] = [];
  const overlaps = (cLo: number, cHi: number, top: number, bot: number, clr = 0) =>
    colUsage.some((u) => {
      const m = Math.ceil(clr + u.clr - 1e-6);
      return cLo <= u.colHi + m && cHi >= u.colLo - m && !(top > u.bot || bot < u.top);
    });

  // Claims keep left-to-right segment order on shared rows: a hole may not
  // land left of a lower-ranked segment's holes (no cut could separate them).
  // Free keys sharing a row get their ranks when the part lying between
  // them is placed (dynInfo).
  const dynInfo = new Map<string, { rankLo: number; rankHi: number }>();
  let dynBase = 9000;
  const rankInfo = (key: string) => info(key) ?? dynInfo.get(key);
  const claims = new Map<number, { col: number; lo: number; hi: number }[]>();
  const claimOk = (row: number, col: number, key: string) => {
    const inf = rankInfo(key);
    if (!inf) return true; // unranked free key: it has its row to itself
    const list = claims.get(row);
    if (!list) return true;
    return !list.some((e) => (e.hi < inf.rankLo && e.col > col) || (e.lo > inf.rankHi && e.col < col));
  };
  const addClaim = (row: number, col: number, key: string) => {
    const inf = rankInfo(key);
    if (!inf) return;
    if (!claims.has(row)) claims.set(row, []);
    claims.get(row)!.push({ col, lo: inf.rankLo, hi: inf.rankHi });
  };

  // Parts anchoring on a rigid's side need columns beside it; rigids keep
  // that room from each other (flexes still pack into it, and compaction
  // reclaims whatever stays empty).
  const needLeft = new Array<number>(k).fill(0);
  const needRight = new Array<number>(k).fill(0);
  const countKey = (key: string | undefined) => {
    if (key === undefined) return;
    for (const e of info(key)?.entries ?? []) {
      if (e.side === "L") needLeft[e.gi] += 1;
      else if (e.side === "R") needRight[e.gi] += 1;
      else {
        needLeft[e.gi] += 0.5;
        needRight[e.gi] += 0.5;
      }
    }
  };
  for (const { a, b } of plan.flexEff.values()) {
    countKey(a);
    countKey(b);
  }
  for (const key of plan.tapKey.values()) countKey(key);

  const rigidCol: number[] = [];
  const reservations: Usage[] = [];
  // Locked members imply where the board's edges lie in tile columns:
  // nothing may pack left of column 0 or beyond a locked column cap.
  let colMin = -Infinity;
  let colMax = Infinity;
  let packRowMin = -Infinity;
  let packRowMax = Infinity;
  const noteFixedBounds = (i: number) => {
    const f = rigids[i].fixed;
    if (!f || rigidCol[i] === undefined) return;
    const aCol = f.col - rigidCol[i]; // absolute col = local col + aCol
    // Free members keep one column off the board's left edge: with locked
    // parts nothing can shift later, and a pin flush at column 0 leaves its
    // segment no free hole for a link wire. Locked members themselves are
    // frozen wherever the user put them (forced placements skip this bound).
    colMin = Math.max(colMin, -aCol + 1);
    if (limits.maxCols !== undefined) colMax = Math.min(colMax, limits.maxCols - 1 - aCol);
    const aRow = f.row - plan.offsets[i];
    packRowMin = Math.max(packRowMin, -aRow);
    if (limits.maxRows !== undefined) packRowMax = Math.min(packRowMax, limits.maxRows - 1 - aRow);
  };
  // First-fit placement: a rigid whose rows don't collide stacks above or
  // below an earlier one instead of stretching the row of rigids; claimOk
  // keeps its pins on the right side of every shared strip.
  const placeRigid = (i: number): boolean => {
    const rr = plan.rotSel[i];
    const o = plan.offsets[i];
    const top = o + rr.box.minRow - 1;
    const bot = o + rr.box.maxRow + 1;
    // two locked rigids keep their frozen relative column distance
    let forced: number | undefined;
    if (rigids[i].fixed) {
      for (let j = 0; j < i; j++) {
        if (rigids[j].fixed && rigidCol[j] !== undefined) {
          forced = rigidCol[j] + (rigids[i].fixed!.col - rigids[j].fixed!.col);
          break;
        }
      }
    }
    // Reservations are soft: when space is tight (frozen spans, locked
    // caps) a second pass places against real content only.
    const findAt = (useRes: boolean): { c: number; resL: number; resR: number } | null => {
      const resL = useRes ? Math.min(12, Math.ceil(needLeft[i]) * 2) : 0;
      const resR = useRes ? Math.min(12, Math.ceil(needRight[i]) * 2) : 0;
      // With a locked member the board frame is known and everything left
      // of it down to the board edge (colMin) is paid for — scan from there
      // so free members fill that space instead of stacking rightward. An
      // unanchored tile keeps its 0-based scan (normalization equalizes).
      const scanFrom = forced ?? (Number.isFinite(colMin) ? Math.ceil(colMin - rr.box.minCol) : 0);
      for (let c = scanFrom; c <= (forced ?? 200); c++) {
        // the free-member edge margin in colMin never applies to a frozen
        // position — the user chose it, even flush against the board edge
        if ((forced === undefined && c + rr.box.minCol < colMin) || c + rr.box.maxCol > colMax) {
          if (forced !== undefined) break;
          continue;
        }
        const lo = c + rr.box.minCol - 1;
        const hi = c + rr.box.maxCol + 1;
        const rLo = lo - resL;
        const rHi = hi + resR;
        const blocked = (u: Usage) => rLo <= u.colHi && rHi >= u.colLo && !(top > u.bot || bot < u.top);
        if (colUsage.some(blocked) || (useRes && reservations.some(blocked))) continue;
        let ok = true;
        for (const cl of rr.pinClaims) {
          const key = plan.keyOfEntry.get(`${i}:${cl.net}`);
          if (key && !claimOk(o + cl.row, c + cl.col, key)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        return { c, resL, resR };
      }
      return null;
    };
    // Unanchored tiles keep first-fit with reservations winning. In an
    // anchored tile the reserved pass tends to escape far right past the
    // fixed member while the board edge's paid-for space goes unused — so
    // both passes compete and the leftmost feasible column wins.
    let best: { c: number; resL: number; resR: number } | null = null;
    for (const useRes of forced === undefined ? [true, false] : [false]) {
      const f = findAt(useRes);
      if (f && (!best || f.c < best.c)) best = f;
      if (best && !Number.isFinite(colMin)) break;
    }
    if (!best) return false;
    const { c, resL, resR } = best;
    const lo = c + rr.box.minCol - 1;
    const hi = c + rr.box.maxCol + 1;
    rigidCol[i] = c;
    colUsage.push({ colLo: lo, colHi: hi, top, bot, clr: 0 });
    reservations.push({ colLo: lo - resL, colHi: hi + resR, top, bot, clr: 0 });
    for (const cl of rr.pinClaims) {
      const key = plan.keyOfEntry.get(`${i}:${cl.net}`);
      if (key) addClaim(o + cl.row, c + cl.col, key);
    }
    return true;
  };
  const rigidRight = (i: number) => rigidCol[i] + plan.rotSel[i].box.maxCol;
  const maxUsedCol = () => Math.max(...colUsage.map((u) => u.colHi));

  const placements: { comp: Component; row1: number; col1: number; row2?: number; col2?: number }[] = [];
  const unplaced: Component[] = [...skipped];

  interface FlexPack { f: Flex; a: string; b: string; rA: number; rB: number }
  const flexData: FlexPack[] = [];
  for (const f of flexes) {
    const e = plan.flexEff.get(f.comp.id)!;
    const rA = y.get(e.a);
    const rB = y.get(e.b);
    if (rA === undefined || rB === undefined) {
      unplaced.push(f.comp);
      continue;
    }
    flexData.push({ f, a: e.a, b: e.b, rA, rB });
  }
  // Column anchors come from the rigids that actually pin a part's keys —
  // left of an "L" pin's rigid, right of an "R"/"F" pin's rigid — so they
  // stay correct when rigids stack in 2D instead of forming one row.
  const anchorsOfKey = (key: string): { start: number; dir: 1 | -1 }[] => {
    const out: { start: number; dir: 1 | -1 }[] = [];
    for (const e of info(key)?.entries ?? []) {
      const rc = rigidCol[e.gi];
      const rr = plan.rotSel[e.gi];
      if (e.side !== "L") out.push({ start: rc + rr.box.maxCol + 1, dir: 1 });
      if (e.side !== "R") out.push({ start: rc + rr.box.minCol - 1, dir: -1 });
    }
    return out;
  };
  const anchorsFor = (fd: FlexPack): { start: number; dir: 1 | -1 }[] => {
    const out = [...anchorsOfKey(fd.a), ...anchorsOfKey(fd.b)];
    if (out.length === 0) {
      const gi = groupOf.get(fd.f.comp.id) ?? 0;
      if (k > 0 && rigidCol[gi] !== undefined) {
        const rr = plan.rotSel[gi];
        out.push({ start: rigidCol[gi] + rr.box.maxCol + 1, dir: 1 });
        out.push({ start: rigidCol[gi] + rr.box.minCol - 1, dir: -1 });
      } else {
        out.push({ start: 0, dir: 1 });
      }
    }
    return out;
  };
  const rankOf = (fd: FlexPack) =>
    Math.min(info(fd.a)?.rankLo ?? Infinity, info(fd.b)?.rankLo ?? Infinity);
  const sortFlexes = (list: FlexPack[]) =>
    list.sort((x, z) =>
      // parts lying along a row first: they fix their row's segment order
      ((x.rA === x.rB ? 0 : 1) - (z.rA === z.rB ? 0 : 1)) ||
      (rankOf(x) - rankOf(z)) ||
      (Math.min(x.rA, x.rB) - Math.min(z.rA, z.rB)) ||
      (x.f.comp.label < z.f.comp.label ? -1 : 1));

  const packFlex = (fd: FlexPack, startCol: number, dir: 1 | -1, maxSteps = 24): boolean => {
    const { f, a, b, rA, rB } = fd;
    const top = Math.min(rA, rB);
    const bot = Math.max(rA, rB);
    const clr = clearanceOf(f.def);
    const dcNeeded = allowedDrows(f.def).get(Math.abs(rA - rB)) ?? 0;
    for (let j = 0; j <= maxSteps; j++) {
      const c1 = startCol + dir * j;
      const c2 = c1 + dir * dcNeeded;
      const cLo = Math.min(c1, c2);
      const cHi = Math.max(c1, c2);
      if (cLo < colMin || cHi > colMax) continue;
      if (overlaps(cLo, cHi, top, bot, clr)) continue;
      if (!claimOk(rA, c1, a) || !claimOk(rB, c2, b)) continue;
      if (rA === rB && a !== b && !rankInfo(a) && !rankInfo(b)) {
        // this part fixes the segment order of its shared row
        const [lk, rk] = c1 <= c2 ? [a, b] : [b, a];
        dynInfo.set(lk, { rankLo: dynBase, rankHi: dynBase });
        dynInfo.set(rk, { rankLo: dynBase + 2, rankHi: dynBase + 2 });
        dynBase += 4;
      }
      colUsage.push({ colLo: cLo, colHi: cHi, top, bot, clr });
      addClaim(rA, c1, a);
      addClaim(rB, c2, b);
      placements.push({ comp: f.comp, row1: rA, col1: c1, row2: rB, col2: c2 });
      return true;
    }
    return false;
  };

  // Rigids first — locked ones ahead of free ones so the board-edge bounds
  // they imply constrain everything placed after them — then flexes near
  // their anchors. Flexes whose span constraint gave way in the search skip
  // straight to the fresh-row fallback.
  const placeOrder = Array.from({ length: k }, (_, i) => i)
    .sort((a, b) => (rigids[a].fixed ? 0 : 1) - (rigids[b].fixed ? 0 : 1) || a - b);
  for (const i of placeOrder) {
    if (!placeRigid(i)) return null;
    noteFixedBounds(i);
  }
  const failed: FlexPack[] = [];
  const toPack: FlexPack[] = [];
  for (const fd of flexData) {
    if (plan.violated.has(fd.f.comp.id)) failed.push(fd);
    else toPack.push(fd);
  }
  for (const fd of sortFlexes(toPack)) {
    let done = false;
    for (const { start, dir } of anchorsFor(fd)) {
      if ((done = packFlex(fd, start, dir))) break;
    }
    if (!done) failed.push(fd);
  }
  // Second chance in any other allowed region now that all rigids stand;
  // last resort: drop one end onto a fresh row of its own (the router joins
  // it to the net's segment with one wire).
  const usedRows = new Set<number>([...y.values()]);
  plan.rotSel.forEach((rr, i) => {
    for (const c of rr.pinClaims) usedRows.add(c.row + plan.offsets[i]);
  });
  const extraNetRows: { net: string; row: number }[] = [];
  const tryAltDrop = (fd: FlexPack): boolean => {
    const D = [...allowedDrows(fd.f.def).keys()].sort((p, q) => p - q);
    for (const moveB of [true, false]) {
      const keepKey = moveB ? fd.a : fd.b;
      const keepRow = moveB ? fd.rA : fd.rB;
      const movedNet = moveB ? fd.f.netB : fd.f.netA;
      for (const dr of D) {
        for (const sign of [1, -1]) {
          const r2 = keepRow + sign * dr;
          if (r2 < packRowMin || r2 > packRowMax) continue;
          if (usedRows.has(r2)) continue;
          const fd2: FlexPack = moveB
            ? { ...fd, rA: keepRow, rB: r2, b: "#drop" }
            : { ...fd, rA: r2, rB: keepRow, a: "#drop" };
          const anchors = [
            ...anchorsOfKey(keepKey),
            Number.isFinite(colMax)
              ? { start: colMax as number, dir: -1 as const }
              : { start: maxUsedCol() + 1, dir: 1 as const },
            Number.isFinite(colMin)
              ? { start: colMin as number, dir: 1 as const }
              : { start: Math.min(0, ...colUsage.map((u) => u.colLo)) - 1, dir: -1 as const },
          ];
          for (const { start, dir } of anchors) {
            if (packFlex(fd2, start, dir)) {
              usedRows.add(r2);
              extraNetRows.push({ net: movedNet, row: r2 });
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  for (const fd of failed) {
    let done = false;
    if (!plan.violated.has(fd.f.comp.id)) {
      // wide scan across the whole current extent
      const lo = Math.min(0, ...colUsage.map((u) => u.colLo));
      const hi = Math.max(0, ...colUsage.map((u) => u.colHi));
      done = packFlex(fd, lo - 1, 1, hi - lo + 26);
    }
    if (!done && !tryAltDrop(fd)) unplaced.push(fd.f.comp);
  }

  // Taps on their key's row, in shared outer columns of a reachable region
  for (const t of taps) {
    const key = plan.tapKey.get(t.comp.id);
    if (key === undefined || !y.has(key)) {
      unplaced.push(t.comp);
      continue;
    }
    const row = y.get(key)!;
    let placed = false;
    const tryCols = (atRow: number, start: number, dir: 1 | -1) => {
      let c = start;
      for (let j = 0; j <= 40; j++, c += dir) {
        if (c < colMin || c > colMax) continue;
        if (colUsage.some((u) => c >= u.colLo && c <= u.colHi && atRow >= u.top && atRow <= u.bot)) continue;
        if (!claimOk(atRow, c, key)) continue;
        colUsage.push({ colLo: c, colHi: c, top: atRow, bot: atRow, clr: 0 });
        addClaim(atRow, c, key);
        placements.push({ comp: t.comp, row1: atRow, col1: c });
        return true;
      }
      return false;
    };
    const tapAnchors = [
      ...anchorsOfKey(key),
      Number.isFinite(colMax)
        ? { start: colMax as number, dir: -1 as const }
        : { start: k === 0 ? 0 : maxUsedCol() + 1, dir: 1 as const },
      Number.isFinite(colMin)
        ? { start: colMin as number, dir: 1 as const }
        : { start: Math.min(0, ...colUsage.map((u) => u.colLo)) - 1, dir: -1 as const },
    ];
    for (const { start, dir } of tapAnchors) {
      if ((placed = tryCols(row, start, dir))) break;
    }
    if (!placed) {
      // last resort: a fresh row of its own, joined by one wire later
      for (let d = 1; d <= 20 && !placed; d++) {
        for (const sign of [1, -1] as const) {
          const r2 = row + sign * d;
          if (usedRows.has(r2)) continue;
          if (tryCols(r2, maxUsedCol() + 1, 1)) {
            usedRows.add(r2);
            extraNetRows.push({ net: plan.altReal.get(key) ?? key, row: r2 });
            placed = true;
            break;
          }
        }
      }
    }
    if (!placed) unplaced.push(t.comp);
  }

  // Single-pin flexes: the connected pin sits on its net's row, the free
  // end parks one legal span away (the router cuts floating pins off any
  // strip they'd touch, so a shared parking row is safe)
  for (const ft of flexTaps) {
    const key = plan.tapKey.get(ft.comp.id);
    if (key === undefined || !y.has(key)) {
      unplaced.push(ft.comp);
      continue;
    }
    const row = y.get(key)!;
    const drs = [...allowedDrows(ft.def).keys()].filter((d) => d > 0).sort((p, q) => p - q);
    let done = false;
    const tryAt = (start: number, dir: 1 | -1) => {
      for (let j = 0; j <= 40; j++) {
        const c = start + dir * j;
        if (c < colMin || c > colMax) continue;
        for (const dr of drs) {
          for (const sign of [1, -1] as const) {
            const r2 = row + sign * dr;
            if (r2 < packRowMin || r2 > packRowMax) continue;
            if (usedRows.has(r2)) continue;
            const top = Math.min(row, r2);
            const bot = Math.max(row, r2);
            if (overlaps(c, c, top, bot, clearanceOf(ft.def))) continue;
            if (!claimOk(row, c, key)) continue;
            colUsage.push({ colLo: c, colHi: c, top, bot, clr: clearanceOf(ft.def) });
            addClaim(row, c, key);
            placements.push(ft.firstAssigned
              ? { comp: ft.comp, row1: row, col1: c, row2: r2, col2: c }
              : { comp: ft.comp, row1: r2, col1: c, row2: row, col2: c });
            return true;
          }
        }
      }
      return false;
    };
    const ftAnchors = [
      ...anchorsOfKey(key),
      Number.isFinite(colMax)
        ? { start: colMax as number, dir: -1 as const }
        : { start: k === 0 ? 0 : maxUsedCol() + 1, dir: 1 as const },
      Number.isFinite(colMin)
        ? { start: colMin as number, dir: 1 as const }
        : { start: Math.min(0, ...colUsage.map((u) => u.colLo)) - 1, dir: -1 as const },
    ];
    for (const { start, dir } of ftAnchors) {
      if ((done = tryAt(start, dir))) break;
    }
    if (!done) unplaced.push(ft.comp);
  }

  // ── Normalize to content coordinates ─────────────────
  const allRows = [...y.values()];
  const allCols: number[] = [];
  plan.rotSel.forEach((rr, i) => {
    allRows.push(plan.offsets[i] + rr.box.minRow, plan.offsets[i] + rr.box.maxRow);
    allCols.push(rigidCol[i] + rr.box.minCol, rigidCol[i] + rr.box.maxCol);
  });
  for (const p of placements) {
    allRows.push(p.row1);
    allCols.push(p.col1);
    if (p.row2 !== undefined) allRows.push(p.row2);
    if (p.col2 !== undefined) allCols.push(p.col2);
  }
  if (allRows.length === 0) return null;
  const rOff = -Math.min(...allRows);
  const cOff = -Math.min(...allCols);

  const rowsOfNet = new Map<string, Set<number>>();
  for (const [key, row] of y) {
    const real = plan.altReal.get(key) ?? key;
    if (!rowsOfNet.has(real)) rowsOfNet.set(real, new Set());
    rowsOfNet.get(real)!.add(row + rOff);
  }
  for (const { net, row } of extraNetRows) {
    if (!rowsOfNet.has(net)) rowsOfNet.set(net, new Set());
    rowsOfNet.get(net)!.add(row + rOff);
  }

  // Locked members pin the tile to the board: every one of them must agree
  // on the same anchor, and the tile may not hang off the board's edge.
  let anchor: { row: number; col: number } | undefined;
  for (let i = 0; i < k; i++) {
    const f = rigids[i].fixed;
    if (!f) continue;
    const a = { row: f.row - (plan.offsets[i] + rOff), col: f.col - (rigidCol[i] + cOff) };
    if (!anchor) anchor = a;
    else if (a.row !== anchor.row || a.col !== anchor.col) return null;
  }
  if (anchor && (anchor.row < 0 || anchor.col < 0)) return null;

  return {
    ...(anchor ? { anchor } : {}),
    height: Math.max(...allRows) + rOff + 1,
    width: Math.max(...allCols) + cOff + 1,
    parts: placements.map((p) => ({
      comp: p.comp,
      row1: p.row1 + rOff,
      col1: p.col1 + cOff,
      ...(p.row2 !== undefined ? { row2: p.row2 + rOff, col2: p.col2! + cOff } : {}),
    })),
    rigidParts: rigids.map((r, i) => ({
      comp: r.comp,
      row: plan.offsets[i] + rOff,
      col: rigidCol[i] + cOff,
      rotation: plan.rotSel[i].rot,
    })),
    rowsOfNet,
    unplaced,
    dropWires: extraNetRows.length,
  };
}

export const MAX_TILE_RIGIDS = 16;
const CONFIG_BEAM = 24;
const CONFIG_KEEP = 16;
const WIRE_TILE = 10; // a forced wire inside a tile costs about this much area

// Locked board dimensions (the user's physical stripboard) as hard limits
export interface DimLimits {
  maxRows?: number;
  maxCols?: number;
}

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

  interface Cfg { rotSel: RigidRotation[]; offsets: number[]; cheap: number; minR: number; maxR: number }
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
      rotSel, offsets,
      cheap: (ck.maxR - ck.minR + 1) * widthEst + 30 * ck.wiresPinned + 200 * overCap,
      minR: ck.minR,
      maxR: ck.maxR,
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
          for (let o = p.minR - hi - 2; o <= p.maxR + 2; o++) {
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
    const ck = buildKeys(cfg.rotSel, cfg.offsets);
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

/**
 * The same tile rotated 180°: functionally identical inside, but the other
 * orientation may put its nets on rows that line up with the neighbors'.
 */
export function flipTile(tile: Tile, componentDefs: ComponentDef[]): Tile | undefined {
  if (tile.anchor) return undefined; // anchored tiles must not move
  const h = tile.height;
  const w = tile.width;
  const rigidParts: Tile["rigidParts"] = [];
  for (const rp of tile.rigidParts) {
    const def = resolveComponentDef(rp.comp, componentDefs);
    if (!def) return undefined;
    const cur = getRotatedPinPositions(def, { row: rp.row, col: rp.col }, rp.rotation);
    const rot2 = ((rp.rotation + 180) % 360) as Rot;
    const base = getRotatedPinPositions(def, { row: 0, col: 0 }, rot2);
    const anchor = {
      row: h - 1 - cur[0].row - base[0].row,
      col: w - 1 - cur[0].col - base[0].col,
    };
    for (let i = 0; i < cur.length; i++) {
      if (anchor.row + base[i].row !== h - 1 - cur[i].row ||
        anchor.col + base[i].col !== w - 1 - cur[i].col) return undefined;
    }
    rigidParts.push({ comp: rp.comp, row: anchor.row, col: anchor.col, rotation: rot2 });
  }
  const rowsOfNet = new Map<string, Set<number>>();
  for (const [net, rows] of tile.rowsOfNet) {
    rowsOfNet.set(net, new Set([...rows].map((r) => h - 1 - r)));
  }
  return {
    height: h,
    width: w,
    parts: tile.parts.map((p) => ({
      comp: p.comp,
      row1: h - 1 - p.row1,
      col1: w - 1 - p.col1,
      ...(p.row2 !== undefined ? { row2: h - 1 - p.row2, col2: w - 1 - p.col2! } : {}),
    })),
    rigidParts,
    rowsOfNet,
    unplaced: tile.unplaced,
    dropWires: tile.dropWires,
  };
}
