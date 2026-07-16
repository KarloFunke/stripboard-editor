import {
  Board,
  BoardPosition,
  Component,
  ComponentDef,
  Net,
  NetAssignment,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions, getComponentBounds } from "./boardLayout";
import { deriveCompletion, CompletionPlan } from "./autoFinish";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { checkNetCompleteness } from "./netCompleteness";
import {
  spanLimits,
  FootprintRect,
  bodiesTooClose,
  segmentsIntersect,
  bodyIntersectsRect,
  corridorHoles,
} from "./flexGeometry";
import { AutoLayoutProgress, AutoLayoutResult, LayoutPlacement } from "./autoLayout";

// ── The v2 "strip-first" layouter ──────────────────────
//
// Human stripboard layouts put same-net pins on shared copper and build in
// functional blocks. This layouter reproduces that directly:
//
//  stage 0  cluster the netlist into blocks (size-capped agglomeration over
//           a fanout-weighted component graph — high-fanout power nets
//           self-neutralize at weight 1/(k-1))
//  stage 1  plan each block strip-first: nets get strip rows, 2-pin parts
//           become short drops between their nets' rows, an IC pins its
//           nets to its pin rows; exact search over the remaining rows
//  stage 2  compose the block tiles in bands (tiles side by side share
//           strip rows; aligned same-net rows join by bare copper) and let
//           the router derive the cuts and the few remaining wires
//
// The solver chooses the board size; the caller applies it via
// AutoLayoutResult.boardSize.

const MAX_CLUSTER = 12;
const PLAN_NODE_BUDGET = 300000;
// Exhaustive band search is 3^T..4^T; beyond this many tiles use greedy shelves
const MAX_EXHAUSTIVE_TILES = 9;

// ── Stage 0: clustering ────────────────────────────────

interface ComponentGraph {
  nodes: Component[];
  adj: Map<number, number>[]; // index -> (index -> weight)
}

function buildComponentGraph(components: Component[], netAssignments: NetAssignment[]): ComponentGraph {
  const nodes = components.filter((c) => !c.boardExcluded);
  const idx = new Map(nodes.map((c, i) => [c.id, i]));
  const netMembers = new Map<string, Set<number>>();
  for (const a of netAssignments) {
    const i = idx.get(a.componentId);
    if (i === undefined) continue;
    if (!netMembers.has(a.netId)) netMembers.set(a.netId, new Set());
    netMembers.get(a.netId)!.add(i);
  }
  const adj: Map<number, number>[] = nodes.map(() => new Map());
  for (const [, members] of netMembers) {
    const ids = [...members];
    const k = ids.length;
    if (k < 2) continue;
    const w = 1 / (k - 1);
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        adj[ids[i]].set(ids[j], (adj[ids[i]].get(ids[j]) ?? 0) + w);
        adj[ids[j]].set(ids[i], (adj[ids[j]].get(ids[i]) ?? 0) + w);
      }
    }
  }
  return { nodes, adj };
}

/** Deterministic size-capped average-linkage agglomeration */
function agglomerate(adj: Map<number, number>[], n: number, maxCluster: number): number[] {
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const alive: boolean[] = Array.from({ length: n }, () => true);
  const interW = new Map<string, number>();
  const wKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  adj.forEach((m, i) => {
    for (const [j, w] of m) {
      if (i < j) interW.set(wKey(i, j), w);
    }
  });

  for (;;) {
    let best: { a: number; b: number; avg: number; size: number } | null = null;
    for (const [key, w] of interW) {
      if (w <= 0) continue;
      const [a, b] = key.split(":").map(Number);
      if (!alive[a] || !alive[b]) continue;
      const size = members[a].length + members[b].length;
      if (size > maxCluster) continue;
      const avg = w / (members[a].length * members[b].length);
      const better =
        !best ||
        avg > best.avg + 1e-12 ||
        (avg > best.avg - 1e-12 &&
          (size < best.size || (size === best.size && (a < best.a || (a === best.a && b < best.b)))));
      if (better) best = { a, b, avg, size };
    }
    if (!best) break;
    const { a, b } = best;
    members[a].push(...members[b]);
    alive[b] = false;
    for (const [key, w] of [...interW]) {
      const [x, yv] = key.split(":").map(Number);
      if (x !== b && yv !== b) continue;
      const other = x === b ? yv : x;
      interW.delete(key);
      if (other === a) continue;
      const k2 = wKey(a, other);
      interW.set(k2, (interW.get(k2) ?? 0) + w);
    }
  }

  const membership = new Array<number>(n);
  let count = 0;
  members.forEach((list, ci) => {
    if (!alive[ci]) return;
    for (const i of list) membership[i] = count;
    count++;
  });
  return membership;
}

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
}

interface RigidCand {
  comp: Component;
  def: ComponentDef;
  rotations: RigidRotation[];
  fixed?: { row: number; col: number }; // locked: this board position is frozen
}

interface ClusterAnalysis {
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
    // Pins per row decide what the row can host: one pin = the net owns the
    // rigid's stretch of it ("F"); two different-net pins = left/right
    // segments with a cut under the body; more than two = unbuildable.
    let ok = true;
    const pinned = new Map<string, { row: number; side: Side }>();
    const pinClaims: RigidRotation["pinClaims"] = [];
    for (const [row, rowPins] of byRow) {
      const distinct = new Set(rowPins.filter((x) => x.netId).map((x) => x.netId!));
      if (distinct.size > 2 || (rowPins.length > 2 && distinct.size > 1)) {
        ok = false;
        break;
      }
      const rowMin = Math.min(...rowPins.map((x) => x.col));
      for (const { col, netId } of rowPins) {
        if (!netId) continue;
        pinClaims.push({ net: netId, row, col });
        const side: Side = distinct.size <= 1 ? "F" : col === rowMin ? "L" : "R";
        if (!pinned.has(netId)) pinned.set(netId, { row, side });
      }
    }
    if (!ok) continue;
    out.push({ rot, box: getComponentBounds(def, { row: 0, col: 0 }, rot), pinned, pinClaims });
  }
  return out;
}

function analyzeCluster(
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
    if (assigned.length <= 1 && !isFixed) {
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

interface Tile {
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
  interface Usage { colLo: number; colHi: number; top: number; bot: number }
  const colUsage: Usage[] = [];
  const overlaps = (cLo: number, cHi: number, top: number, bot: number) =>
    colUsage.some((u) => cLo <= u.colHi + 1 && cHi >= u.colLo - 1 && !(top > u.bot || bot < u.top));

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
    colMin = Math.max(colMin, -aCol);
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
    for (const useRes of forced === undefined ? [true, false] : [false]) {
      const resL = useRes ? Math.min(12, Math.ceil(needLeft[i]) * 2) : 0;
      const resR = useRes ? Math.min(12, Math.ceil(needRight[i]) * 2) : 0;
      const scanFrom = forced ?? Math.max(0, Number.isFinite(colMin) ? Math.ceil(colMin - rr.box.minCol) : 0);
      for (let c = scanFrom; c <= (forced ?? 200); c++) {
        if (c + rr.box.minCol < colMin || c + rr.box.maxCol > colMax) {
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
        rigidCol[i] = c;
        colUsage.push({ colLo: lo, colHi: hi, top, bot });
        reservations.push({ colLo: rLo, colHi: rHi, top, bot });
        for (const cl of rr.pinClaims) {
          const key = plan.keyOfEntry.get(`${i}:${cl.net}`);
          if (key) addClaim(o + cl.row, c + cl.col, key);
        }
        return true;
      }
    }
    return false;
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
    const dcNeeded = allowedDrows(f.def).get(Math.abs(rA - rB)) ?? 0;
    for (let j = 0; j <= maxSteps; j++) {
      const c1 = startCol + dir * j;
      const c2 = c1 + dir * dcNeeded;
      const cLo = Math.min(c1, c2);
      const cHi = Math.max(c1, c2);
      if (cLo < colMin || cHi > colMax) continue;
      if (overlaps(cLo, cHi, top, bot)) continue;
      if (!claimOk(rA, c1, a) || !claimOk(rB, c2, b)) continue;
      if (rA === rB && a !== b && !rankInfo(a) && !rankInfo(b)) {
        // this part fixes the segment order of its shared row
        const [lk, rk] = c1 <= c2 ? [a, b] : [b, a];
        dynInfo.set(lk, { rankLo: dynBase, rankHi: dynBase });
        dynInfo.set(rk, { rankLo: dynBase + 2, rankHi: dynBase + 2 });
        dynBase += 4;
      }
      colUsage.push({ colLo: cLo, colHi: cHi, top, bot });
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
        colUsage.push({ colLo: c, colHi: c, top: atRow, bot: atRow });
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
            if (overlaps(c, c, top, bot)) continue;
            if (!claimOk(row, c, key)) continue;
            colUsage.push({ colLo: c, colHi: c, top, bot });
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

const MAX_TILE_RIGIDS = 16;
const CONFIG_BEAM = 24;
const CONFIG_KEEP = 16;
const WIRE_TILE = 10; // a forced wire inside a tile costs about this much area

// Locked board dimensions (the user's physical stripboard) as hard limits
interface DimLimits {
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
function planTile(analysis: ClusterAnalysis, limits: DimLimits): Tile | null {
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
      const overhang = Math.max(0, Math.max(t.height, t.width) - 45);
      const overCap =
        (limits.maxRows ? Math.max(0, t.height - limits.maxRows) : 0) +
        (limits.maxCols ? Math.max(0, t.width - limits.maxCols) : 0);
      const score = t.height * t.width + overhang * overhang + 200 * overCap +
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
function flipTile(tile: Tile, componentDefs: ComponentDef[]): Tile | undefined {
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

// ── Stage 2: compose tiles in bands ────────────────────

interface PlacedTile {
  tile: Tile;
  band: number;
  x: number;
  dy: number;
}

interface Floorplan {
  placedTiles: PlacedTile[];
  bandHeights: number[];
  rows: number;
  cols: number;
  wiresEst: number;
  wireLen: number;
  area: number;
}

function sharedNetCount(a: Tile, b: Tile): number {
  let n = 0;
  for (const net of a.rowsOfNet.keys()) if (b.rowsOfNet.has(net)) n++;
  return n;
}

function layoutBands(tiles: Tile[], assign: number[], bandCount: number, gap: number): Floorplan | null {
  const bands: Tile[][] = Array.from({ length: bandCount }, () => []);
  tiles.forEach((t, i) => bands[assign[i]].push(t));
  if (bands.some((b) => b.length === 0)) return null;

  const placedTiles: PlacedTile[] = [];
  const bandHeights: number[] = [];
  let rows = 0;
  let cols = 0;
  let wiresEst = 0;
  const netRowKeys = new Map<string, Set<string>>();
  // net -> placed pin-row midpoints (final coordinates), for wire length
  const netPts = new Map<string, { r: number; x: number }[]>();

  for (let bi = 0; bi < bandCount; bi++) {
    const bandTiles = bands[bi];
    const bandH = Math.max(...bandTiles.map((t) => t.height));
    bandHeights.push(bandH);
    const oy = rows + (bi > 0 ? 1 : 0);
    // Seed with the band's best-connected tile; the rest attach to either
    // end of the row, so a hub of many nets ends up central, not cornered.
    const totalShared = (t: Tile) =>
      bandTiles.reduce((s, o) => s + (o === t ? 0 : sharedNetCount(t, o)), 0);
    const chain: Tile[] = [bandTiles.reduce((a, b) => {
      const sa = totalShared(a);
      const sb = totalShared(b);
      return sb > sa || (sb === sa && b.width > a.width) ? b : a;
    })];
    const rest = bandTiles.filter((t) => t !== chain[0]);
    while (rest.length > 0) {
      let pick: { t: Tile; w: number } | null = null;
      for (const t of rest) {
        const w = Math.max(...chain.map((c) => sharedNetCount(c, t)));
        if (!pick || w > pick.w || (w === pick.w && t.width > pick.t.width)) pick = { t, w };
      }
      chain.push(pick!.t);
      rest.splice(rest.indexOf(pick!.t), 1);
    }
    let xLo = 0;
    let xHi = -1;
    const bandPlaced: PlacedTile[] = [];
    const bandPts: { r: number; x: number }[] = [];
    for (const t of chain) {
      let x: number;
      if (xHi < xLo) {
        x = 0;
      } else {
        // attach to whichever end keeps this tile's nets shortest
        const costAt = (xc: number) => {
          let cost = 0;
          for (const net of t.rowsOfNet.keys()) {
            for (const p of netPts.get(net) ?? []) cost += Math.abs(xc - p.x);
          }
          return cost;
        };
        const left = xLo - gap - t.width;
        const right = xHi + gap;
        x = costAt(left + t.width / 2) < costAt(right + t.width / 2) ? left : right;
      }
      xLo = Math.min(xLo, x);
      xHi = Math.max(xHi, x + t.width - 1);
      let pick = t;
      let bestDy = 0;
      let bestScore = -1;
      for (const v of t.flipped ? [t, t.flipped] : [t]) {
        for (let dy = 0; dy + v.height <= bandH; dy++) {
          let score = 0;
          for (const [net, netRows] of v.rowsOfNet) {
            const keys = netRowKeys.get(net);
            if (!keys) continue;
            for (const row of netRows) {
              if (keys.has(`${bi}:${row + dy}`)) score++;
            }
          }
          if (score > bestScore) {
            bestScore = score;
            bestDy = dy;
            pick = v;
          }
        }
      }
      for (const [net, netRows] of pick.rowsOfNet) {
        if (!netRowKeys.has(net)) netRowKeys.set(net, new Set());
        for (const row of netRows) {
          netRowKeys.get(net)!.add(`${bi}:${row + bestDy}`);
          const pt = { r: oy + bestDy + row, x: x + pick.width / 2 };
          if (!netPts.has(net)) netPts.set(net, []);
          netPts.get(net)!.push(pt);
          bandPts.push(pt);
        }
      }
      bandPlaced.push({ tile: pick, band: bi, x, dy: bestDy });
    }
    for (const p of bandPlaced) p.x -= xLo;
    for (const p of bandPts) p.x -= xLo;
    placedTiles.push(...bandPlaced);
    cols = Math.max(cols, xHi - xLo + 1);
    rows += bandH + (bi > 0 ? 1 : 0);
  }
  for (const [, keys] of netRowKeys) wiresEst += Math.max(0, keys.size - 1);
  let wireLen = 0;
  for (const [, pts] of netPts) {
    if (pts.length < 2) continue;
    const rs = pts.map((p) => p.r);
    const xs = pts.map((p) => p.x);
    wireLen += Math.max(...rs) - Math.min(...rs) + Math.max(...xs) - Math.min(...xs);
  }
  return { placedTiles, bandHeights, rows, cols, wiresEst, wireLen, area: rows * cols };
}

function composeTiles(tiles: Tile[], gap: number, limits: DimLimits): Floorplan | null {
  if (tiles.length === 0) return null;
  // Area and inter-tile wire length trade off: a cell of wire is about as
  // ugly as a cell of board, and each extra wire costs a few cells' worth.
  // A floorplan beyond a locked dimension is close to useless.
  const overCap = (f: Floorplan) =>
    (limits.maxRows ? Math.max(0, f.rows - limits.maxRows) : 0) +
    (limits.maxCols ? Math.max(0, f.cols - limits.maxCols) : 0);
  // a locked dimension is paid for in full whether used or not, so staying
  // under it is free — only the unlocked dimension costs cells
  const effArea = (f: Floorplan) =>
    (limits.maxRows ? Math.max(limits.maxRows, f.rows) : f.rows) *
    (limits.maxCols ? Math.max(limits.maxCols, f.cols) : f.cols);
  const badness = (f: Floorplan) => effArea(f) + 4 * f.wiresEst + f.wireLen + 200 * overCap(f);
  const better = (a: Floorplan, b: Floorplan) =>
    badness(a) < badness(b) ||
    (badness(a) === badness(b) && Math.max(a.rows, a.cols) < Math.max(b.rows, b.cols));

  let best: Floorplan | null = null;
  const consider = (fp: Floorplan | null) => {
    if (fp && (!best || better(fp, best))) best = fp;
  };
  if (tiles.length <= MAX_EXHAUSTIVE_TILES) {
    // 4^9 assignments is seconds of work; big sets stick to three bands
    // (the shelves candidate below covers many-band splits anyway)
    const maxBands = Math.min(tiles.length <= 7 ? 4 : 3, tiles.length);
    for (let bandCount = 1; bandCount <= maxBands; bandCount++) {
      const assign = new Array<number>(tiles.length).fill(0);
      const rec = (i: number) => {
        if (i === tiles.length) {
          consider(layoutBands(tiles, assign, bandCount, gap));
          return;
        }
        for (let b = 0; b < bandCount; b++) {
          assign[i] = b;
          rec(i + 1);
        }
      };
      rec(0);
    }
  }
  // Greedy shelves: for many tiles the only strategy; for few an extra
  // candidate — unlimited bands can be the only shape under a locked width
  {
    const order = [...tiles].sort((a, b) => b.height - a.height || b.width - a.width);
    const totalArea = tiles.reduce((s, t) => s + t.height * t.width, 0);
    const widest = Math.max(...tiles.map((t) => t.width));
    const targetW = limits.maxCols
      ? Math.max(limits.maxCols, widest)
      : limits.maxRows
        ? Math.max(Math.ceil((totalArea / limits.maxRows) * 1.15), widest)
        : Math.max(Math.ceil(Math.sqrt(totalArea) * 1.15), widest);
    const assign = new Array<number>(tiles.length).fill(0);
    let band = 0;
    let x = 0;
    for (const t of order) {
      if (x > 0 && x + t.width > targetW) {
        band++;
        x = 0;
      }
      assign[tiles.indexOf(t)] = band;
      x += t.width + gap;
    }
    consider(layoutBands(tiles, assign, band + 1, gap));
  }
  return best;
}

// ── Vacuum compaction ──────────────────────────────────
// Pins connect through their strip row, so removing a grid line that no
// part depends on never changes connectivity — only geometry and routing
// room. Greedily delete such rows and columns; the caller re-routes the
// result and keeps it only if it routes as cleanly as the loose layout.

interface Occupancy {
  rigids: { rect: FootprintRect; pins: { row: number; col: number; net?: string }[] }[];
  flexes: { idx: number; def: ComponentDef; span: { min: number; max: number } }[];
}

function compactPlacements(
  comps: Component[],
  componentDefs: ComponentDef[],
  netOfPin: Map<string, string>,
  rows: number,
  cols: number,
  maxRemovals = Infinity, // replay a prefix of the (deterministic) removal sequence
  validate?: (comps: Component[], rows: number, cols: number) => boolean
): { comps: Component[]; rows: number; cols: number; removals: number } {
  type P = { row: number; col: number };
  const pos: (P | null)[] = comps.map((c) => (c.boardPos ? { ...c.boardPos } : null));
  const end: (P | null)[] = comps.map((c) => (c.flexibleEndPos ? { ...c.flexibleEndPos } : null));

  // Locked parts must not move: only grid lines beyond all of them are
  // removable (those removals leave locked coordinates untouched).
  let lockRow = -1;
  let lockCol = -1;
  for (const c of comps) {
    if (!c.locked || !c.boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (def && !def.flexible) {
      const b = getComponentBounds(def, c.boardPos, c.rotation);
      lockRow = Math.max(lockRow, b.maxRow);
      lockCol = Math.max(lockCol, b.maxCol);
    } else {
      for (const p of [c.boardPos, c.flexibleEndPos ?? c.boardPos]) {
        lockRow = Math.max(lockRow, p.row);
        lockCol = Math.max(lockCol, p.col);
      }
    }
  }

  const occ: Occupancy = { rigids: [], flexes: [] };
  for (let i = 0; i < comps.length; i++) {
    if (!pos[i]) continue;
    const def = resolveComponentDef(comps[i], componentDefs);
    if (!def) continue;
    if (def.flexible) {
      if (end[i]) occ.flexes.push({ idx: i, def, span: spanLimits(def) });
    } else {
      occ.rigids.push({
        rect: getComponentBounds(def, pos[i]!, comps[i].rotation),
        pins: getRotatedPinPositions(def, pos[i]!, comps[i].rotation).map((p) => ({
          row: p.row,
          col: p.col,
          net: netOfPin.get(`${comps[i].id}:${p.pinId}`),
        })),
      });
    }
  }

  const flexNet = (i: number, first: boolean) => {
    const def = resolveComponentDef(comps[i], componentDefs)!;
    const pinId = def.pins[first ? 0 : 1]?.id;
    return pinId !== undefined ? netOfPin.get(`${comps[i].id}:${pinId}`) : undefined;
  };

  const shiftPt = (p: P, line: number, isCol: boolean) => {
    if (isCol) return p.col > line ? { row: p.row, col: p.col - 1 } : p;
    return p.row > line ? { row: p.row - 1, col: p.col } : p;
  };

  // The layout may already contain pairs closer than the solver's own
  // comfort rules (abutting tiles from stage 2). A removal is only vetoed
  // if it CREATES a violation that the current layout doesn't have.
  interface Snap {
    flexPts: { p1: P; p2: P }[];
    rects: FootprintRect[];
    pins: { id: string; row: number; col: number; net?: string }[];
  }
  const snapshot = (line?: number, isCol?: boolean): Snap => {
    const sh = (p: P) => (line === undefined ? p : shiftPt(p, line, isCol!));
    return {
      flexPts: occ.flexes.map((f) => ({ p1: sh(pos[f.idx]!), p2: sh(end[f.idx]!) })),
      rects: occ.rigids.map((r) => {
        const lo = sh({ row: r.rect.minRow, col: r.rect.minCol });
        const hi = sh({ row: r.rect.maxRow, col: r.rect.maxCol });
        return { minRow: lo.row, minCol: lo.col, maxRow: hi.row, maxCol: hi.col };
      }),
      pins: [
        ...occ.rigids.flatMap((r, ri) => r.pins.map((p, pi) => ({ id: `p${ri}:${pi}`, ...sh(p), net: p.net }))),
        ...occ.flexes.flatMap((f, fi) => [
          { id: `f${fi}a`, ...sh(pos[f.idx]!), net: flexNet(f.idx, true) },
          { id: `f${fi}b`, ...sh(end[f.idx]!), net: flexNet(f.idx, false) },
        ]),
      ],
    };
  };
  const violations = (s: Snap): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.flexPts.length; i++) {
      const a = s.flexPts[i];
      for (let j = i + 1; j < s.flexPts.length; j++) {
        const b = s.flexPts[j];
        if (segmentsIntersect(a.p1, a.p2, b.p1, b.p2)) out.add(`ffx:${i}:${j}`);
        if (bodiesTooClose(a.p1, a.p2, b.p1, b.p2)) out.add(`ffc:${i}:${j}`);
      }
      s.rects.forEach((rect, ri) => {
        if (bodyIntersectsRect(a.p1, a.p2, rect)) out.add(`fr:${i}:${ri}`);
      });
    }
    const holeOwner = new Map<string, string>();
    for (const p of s.pins) holeOwner.set(`${p.row},${p.col}`, p.id);
    for (let i = 0; i < s.flexPts.length; i++) {
      const a = s.flexPts[i];
      for (const h of corridorHoles(a.p1, a.p2)) {
        const owner = holeOwner.get(`${h.row},${h.col}`);
        if (owner && owner !== `f${i}a` && owner !== `f${i}b`) out.add(`co:${i}:${owner}`);
      }
    }
    // different-net pins on one strip still need a hole between them for a cut
    const byRow = new Map<number, Snap["pins"]>();
    for (const p of s.pins) {
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row)!.push(p);
    }
    for (const [, pins] of byRow) {
      pins.sort((a, b) => a.col - b.col);
      for (let i = 1; i < pins.length; i++) {
        if (pins[i].net !== pins[i - 1].net && pins[i].col - pins[i - 1].col < 2) {
          out.add(`cg:${pins[i - 1].id}:${pins[i].id}`);
        }
      }
    }
    return out;
  };
  let baseViol = violations(snapshot());

  const tryRemove = (line: number, isCol: boolean): boolean => {
    if (isCol ? line <= lockCol : line <= lockRow) return false;
    for (const r of occ.rigids) {
      if (isCol ? r.rect.minCol <= line && line <= r.rect.maxCol
                : r.rect.minRow <= line && line <= r.rect.maxRow) return false;
    }
    for (const f of occ.flexes) {
      const a = pos[f.idx]!;
      const b = end[f.idx]!;
      if (isCol ? a.col === line || b.col === line : a.row === line || b.row === line) return false;
      const na = shiftPt(a, line, isCol);
      const nb = shiftPt(b, line, isCol);
      const len = Math.hypot(na.row - nb.row, na.col - nb.col);
      if (len < f.span.min - 1e-6 || len > f.span.max + 1e-6) return false;
    }
    const post = violations(snapshot(line, isCol));
    for (const v of post) if (!baseViol.has(v)) return false;
    if (validate) {
      const cand = comps.map((c, i) => {
        if (!pos[i]) return c;
        return {
          ...c,
          boardPos: shiftPt(pos[i]!, line, isCol),
          ...(end[i] ? { flexibleEndPos: shiftPt(end[i]!, line, isCol) } : {}),
        };
      });
      if (!validate(cand, isCol ? rows : rows - 1, isCol ? cols - 1 : cols)) return false;
    }
    // accept: apply the shift
    for (let i = 0; i < comps.length; i++) {
      if (pos[i]) pos[i] = shiftPt(pos[i]!, line, isCol);
      if (end[i]) end[i] = shiftPt(end[i]!, line, isCol);
    }
    occ.rigids.forEach((r) => {
      const lo = shiftPt({ row: r.rect.minRow, col: r.rect.minCol }, line, isCol);
      const hi = shiftPt({ row: r.rect.maxRow, col: r.rect.maxCol }, line, isCol);
      r.rect = { minRow: lo.row, minCol: lo.col, maxRow: hi.row, maxCol: hi.col };
      r.pins = r.pins.map((p) => ({ ...shiftPt(p, line, isCol), net: p.net }));
    });
    baseViol = post;
    return true;
  };

  let removals = 0;
  let changed = true;
  while (changed && removals < maxRemovals) {
    changed = false;
    for (let c = cols - 1; c >= 0 && removals < maxRemovals; c--) {
      if (tryRemove(c, true)) {
        cols--;
        removals++;
        changed = true;
      }
    }
    for (let r = rows - 1; r >= 0 && removals < maxRemovals; r--) {
      if (tryRemove(r, false)) {
        rows--;
        removals++;
        changed = true;
      }
    }
  }

  return {
    comps: comps.map((c, i) => {
      if (!pos[i]) return c;
      return {
        ...c,
        boardPos: pos[i]!,
        ...(end[i] ? { flexibleEndPos: end[i]! } : {}),
      };
    }),
    rows,
    cols,
    removals,
  };
}

// ── Orchestrator ───────────────────────────────────────

export function computeAutoLayout2(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void
): AutoLayoutResult {
  const report = (phase: AutoLayoutProgress["phase"], frac: number) =>
    onProgress?.({ phase, attempt: 1, maxAttempts: 1, frac });
  const issues: string[] = [];

  // Locked parts stay exactly where they are. Locked rigids join their
  // block as fixed members (the block is designed around them and anchors
  // the tile to the board); locked flexes stay as plain obstacles. A locked
  // part without a board position is planned like an unlocked one.
  const lockedParts = components.filter((c) => c.locked && c.boardPos && !c.boardExcluded);
  const lockedIds = new Set(lockedParts.map((c) => c.id));
  const rectOfComp = (c: Component): FootprintRect => {
    const def = resolveComponentDef(c, componentDefs);
    if (def && !def.flexible) return getComponentBounds(def, c.boardPos!, c.rotation);
    const p2 = c.flexibleEndPos ?? c.boardPos!;
    return {
      minRow: Math.min(c.boardPos!.row, p2.row),
      minCol: Math.min(c.boardPos!.col, p2.col),
      maxRow: Math.max(c.boardPos!.row, p2.row),
      maxCol: Math.max(c.boardPos!.col, p2.col),
    };
  };

  // ── Stage 0 ──────────────────────────────────────────
  report("arrange", 0);
  const graph = buildComponentGraph(components, netAssignments);
  const membership = agglomerate(graph.adj, graph.nodes.length, MAX_CLUSTER);
  const byCluster = new Map<number, Component[]>();
  graph.nodes.forEach((c, i) => {
    if (!byCluster.has(membership[i])) byCluster.set(membership[i], []);
    byCluster.get(membership[i])!.push(c);
  });
  const clusters = [...byCluster.values()].sort((a, b) => b.length - a.length);

  // ── Stage 1 ──────────────────────────────────────────
  const limits: DimLimits = {
    ...(board.lockedRows ? { maxRows: board.rows } : {}),
    ...(board.lockedCols ? { maxCols: board.cols } : {}),
  };
  // Under a locked width, plan one column narrower: the spare column at the
  // edge becomes a wire channel (routed via the +1 variant below), which a
  // tightly packed board needs for its link wires.
  const planLimits: DimLimits = {
    ...limits,
    ...(limits.maxCols !== undefined && limits.maxCols >= 12 ? { maxCols: limits.maxCols - 1 } : {}),
  };
  const tiles: Tile[] = [];
  const unplaced: Component[] = [];
  let planned = 0;
  // Chain the components by shared nets (seeded at `seed` if given) and cut
  // at the weakest link near the middle. Lets an oversized flex-heavy block
  // shed half its parts into a second tile that stacks below.
  const splitByNets = (cluster: Component[], clusterAsg: NetAssignment[], seed?: Component): [Component[], Component[]] | null => {
    if (cluster.length < 2) return null;
    const netsOf = new Map<string, Set<string>>();
    for (const a of clusterAsg) {
      if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
      netsOf.get(a.componentId)!.add(a.netId);
    }
    const shared = (a: Component, b: Component) => {
      let n = 0;
      for (const x of netsOf.get(a.id) ?? []) if (netsOf.get(b.id)?.has(x)) n++;
      return n;
    };
    const chain: Component[] = [seed ?? cluster.reduce((a, b) => {
      const sa = cluster.reduce((s, o) => s + (o === a ? 0 : shared(a, o)), 0);
      const sb = cluster.reduce((s, o) => s + (o === b ? 0 : shared(b, o)), 0);
      return sb > sa ? b : a;
    })];
    const rest = cluster.filter((c) => c !== chain[0]);
    while (rest.length > 0) {
      let best = 0;
      let bestW = -1;
      rest.forEach((c, i) => {
        const w = Math.max(...chain.map((o) => shared(o, c)));
        if (w > bestW) {
          bestW = w;
          best = i;
        }
      });
      chain.push(rest[best]);
      rest.splice(best, 1);
    }
    let cut = 1;
    let cutScore = Infinity;
    for (let i = 1; i < chain.length; i++) {
      const s = 10 * shared(chain[i - 1], chain[i]) + Math.abs(i - chain.length / 2);
      if (s < cutScore) {
        cutScore = s;
        cut = i;
      }
    }
    return [chain.slice(0, cut), chain.slice(cut)];
  };

  const planWithFallbacks = (cluster: Component[]) => {
    const ids = new Set(cluster.map((c) => c.id));
    const clusterAsg = netAssignments.filter((a) => ids.has(a.componentId));
    const analysis = analyzeCluster(cluster, clusterAsg, componentDefs);
    const k = analysis.rigids.length;
    if (k <= MAX_TILE_RIGIDS) {
      // blocks around locked members plan against the real caps — their
      // frozen span is what it is, no wire-channel reservation applies
      const tile = planTile(analysis, analysis.rigids.some((r) => r.fixed) ? limits : planLimits);
      // an anchored tile is judged by its absolute extent against the real caps
      const tooBig = tile !== null && (tile.anchor
        ? ((limits.maxCols !== undefined && tile.anchor.col + tile.width > limits.maxCols) ||
          (limits.maxRows !== undefined && tile.anchor.row + tile.height > limits.maxRows))
        : ((planLimits.maxCols !== undefined && tile.width > planLimits.maxCols) ||
          (planLimits.maxRows !== undefined && tile.height > planLimits.maxRows)));
      if (tile && !tooBig) {
        tiles.push(tile);
        unplaced.push(...tile.unplaced);
        return;
      }
      if (k <= 1) {
        if (tooBig && cluster.length >= 2) {
          // shed parts into a second tile until the block can fit
          const subs = splitByNets(cluster, clusterAsg, analysis.rigids[0]?.comp);
          if (subs && subs[0].length > 0 && subs[1].length > 0) {
            planWithFallbacks(subs[0]);
            planWithFallbacks(subs[1]);
            return;
          }
        }
        if (tile) {
          // a lone part's tile is as small as it gets — keep it and let
          // the floorplan report any overflow
          tiles.push(tile);
          unplaced.push(...tile.unplaced);
          return;
        }
        if (cluster.some((c) => lockedIds.has(c.id))) {
          // locked members stay put as plain obstacles; plan the rest
          const rest = cluster.filter((c) => !lockedIds.has(c.id));
          if (rest.length > 0) planWithFallbacks(rest);
          return;
        }
        issues.push(`block with ${cluster.map((c) => c.label).join(", ")}: no strip plan found`);
        unplaced.push(...cluster);
        return;
      }
      if (tooBig) {
        // the tile exceeds a locked dimension: split the rigid chain at its
        // weakest link and plan the halves — smaller tiles wrap into bands
        const netsOf = new Map<string, Set<string>>();
        for (const a of clusterAsg) {
          if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
          netsOf.get(a.componentId)!.add(a.netId);
        }
        const sharedPair = (x: number, z: number) => {
          let n = 0;
          for (const nid of netsOf.get(analysis.rigids[x].comp.id) ?? []) {
            if (netsOf.get(analysis.rigids[z].comp.id)?.has(nid)) n++;
          }
          return n;
        };
        let cut = 1;
        let cutScore = Infinity;
        for (let i = 1; i < k; i++) {
          const s = 10 * sharedPair(i - 1, i) + Math.abs(i - k / 2);
          if (s < cutScore) {
            cutScore = s;
            cut = i;
          }
        }
        const subs: Component[][] = [[], []];
        for (const comp of cluster) {
          subs[(analysis.groupOf.get(comp.id) ?? 0) < cut ? 0 : 1].push(comp);
        }
        if (subs[0].length > 0 && subs[1].length > 0) {
          planWithFallbacks(subs[0]);
          planWithFallbacks(subs[1]);
          return;
        }
      }
      // joint plan failed: retry one group per rigid
      const groups = new Map<number, Component[]>();
      for (const comp of cluster) {
        const gi = analysis.groupOf.get(comp.id) ?? 0;
        if (!groups.has(gi)) groups.set(gi, []);
        groups.get(gi)!.push(comp);
      }
      for (const sub of groups.values()) {
        if (sub.length === cluster.length) {
          if (sub.some((c) => lockedIds.has(c.id))) {
            const rest = sub.filter((c) => !lockedIds.has(c.id));
            if (rest.length > 0) planWithFallbacks(rest);
            return;
          }
          issues.push(`block with ${sub.map((c) => c.label).join(", ")}: no strip plan found`);
          unplaced.push(...sub);
          return;
        }
        planWithFallbacks(sub);
      }
      return;
    }
    // Too many rigids for one tile: cut the affinity chain at its weakest
    // links into runs that fit, so strongly connected rigids still share
    // strips and only the weakest nets become inter-tile wires.
    const netsOfRigid = analysis.rigids.map((r) =>
      new Set(clusterAsg.filter((a) => a.componentId === r.comp.id).map((a) => a.netId)));
    const sharedR = (a: number, b: number) => {
      let n = 0;
      for (const x of netsOfRigid[a]) if (netsOfRigid[b].has(x)) n++;
      return n;
    };
    const chunks: number[][] = [Array.from({ length: k }, (_, i) => i)];
    while (chunks.some((ch) => ch.length > MAX_TILE_RIGIDS)) {
      const idx = chunks.findIndex((ch) => ch.length > MAX_TILE_RIGIDS);
      const ch = chunks[idx];
      let best = 1;
      let bestScore = Infinity;
      for (let i = 1; i < ch.length; i++) {
        const oversize = Math.max(i, ch.length - i) > MAX_TILE_RIGIDS ? 1000 : 0;
        const score = oversize + 10 * sharedR(ch[i - 1], ch[i]) + Math.abs(i - ch.length / 2);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      chunks.splice(idx, 1, ch.slice(0, best), ch.slice(best));
    }
    const chunkOfRigid = new Map<number, number>();
    chunks.forEach((ch, ci) => ch.forEach((ri) => chunkOfRigid.set(ri, ci)));
    const subs: Component[][] = chunks.map(() => []);
    for (const comp of cluster) {
      const gi = analysis.groupOf.get(comp.id) ?? 0;
      subs[chunkOfRigid.get(gi) ?? 0].push(comp);
    }
    for (const sub of subs) {
      if (sub.length > 0) planWithFallbacks(sub);
    }
  };
  for (const cluster of clusters) {
    planWithFallbacks(cluster);
    planned++;
    report("arrange", planned / clusters.length);
  }
  // Parts that fell out of a tightly packed tile get one retry as a small
  // block of their own before they count as unplaced.
  if (unplaced.length > 0) {
    const retry = unplaced.filter((c) => !lockedIds.has(c.id));
    unplaced.length = 0;
    if (retry.length > 0) planWithFallbacks(retry);
  }

  // Locked parts the planner could not take as tile members stay put as
  // plain obstacles; anchored tiles that collide with each other (or with
  // those obstacles) are demoted the same way, biggest first.
  const obstacleRects: FootprintRect[] = [];
  {
    const inTile = new Set<string>();
    for (const t of tiles) for (const rp of t.rigidParts) if (lockedIds.has(rp.comp.id)) inTile.add(rp.comp.id);
    for (const c of lockedParts) if (!inTile.has(c.id)) obstacleRects.push(rectOfComp(c));
  }
  const tileRect = (t: Tile): FootprintRect => ({
    minRow: t.anchor!.row,
    minCol: t.anchor!.col,
    maxRow: t.anchor!.row + t.height - 1,
    maxCol: t.anchor!.col + t.width - 1,
  });
  const rectsTouch = (a: FootprintRect, b: FootprintRect) =>
    a.minCol <= b.maxCol + 1 && a.maxCol >= b.minCol - 1 &&
    a.minRow <= b.maxRow + 1 && a.maxRow >= b.minRow - 1;
  const demoteTile = (t: Tile) => {
    tiles.splice(tiles.indexOf(t), 1);
    const wasUnplaced = new Set(t.unplaced.map((c) => c.id));
    for (let i = unplaced.length - 1; i >= 0; i--) {
      if (wasUnplaced.has(unplaced[i].id)) unplaced.splice(i, 1);
    }
    const members = [...t.rigidParts.map((rp) => rp.comp), ...t.parts.map((p) => p.comp), ...t.unplaced];
    for (const c of members) if (lockedIds.has(c.id)) obstacleRects.push(rectOfComp(c));
    const rest = members.filter((c) => !lockedIds.has(c.id));
    if (rest.length > 0) planWithFallbacks(rest);
  };
  {
    const anchoredSorted = tiles.filter((t) => t.anchor)
      .sort((a, b) => b.height * b.width - a.height * a.width);
    const kept: FootprintRect[] = [];
    for (const t of anchoredSorted) {
      const r = tileRect(t);
      if ([...kept, ...obstacleRects].some((o) => rectsTouch(r, o))) demoteTile(t);
      else kept.push(r);
    }
  }
  let fixedRects: FootprintRect[] = [];
  let fixedMaxRow = -1;
  let fixedMaxCol = -1;
  let fixedContentRects: FootprintRect[] = [];
  const computeFixed = () => {
    fixedRects = [...tiles.filter((t) => t.anchor).map(tileRect), ...obstacleRects];
    fixedMaxRow = Math.max(-1, ...fixedRects.map((r) => r.maxRow));
    fixedMaxCol = Math.max(-1, ...fixedRects.map((r) => r.maxCol));
    // Part-level footprints of everything that stands still: free blocks may
    // nest into an anchored tile's unused interior, not just avoid its bbox.
    fixedContentRects = [...obstacleRects];
    for (const t of tiles) {
      if (!t.anchor) continue;
      const ar = t.anchor.row;
      const ac = t.anchor.col;
      for (const rp of t.rigidParts) {
        const def = resolveComponentDef(rp.comp, componentDefs);
        if (def) {
          fixedContentRects.push(getComponentBounds(def, { row: rp.row + ar, col: rp.col + ac }, rp.rotation));
        }
      }
      for (const p of t.parts) {
        fixedContentRects.push({
          minRow: Math.min(p.row1, p.row2 ?? p.row1) + ar,
          minCol: Math.min(p.col1, p.col2 ?? p.col1) + ac,
          maxRow: Math.max(p.row1, p.row2 ?? p.row1) + ar,
          maxCol: Math.max(p.col1, p.col2 ?? p.col1) + ac,
        });
      }
    }
    for (const t of tiles) t.flipped = flipTile(t, componentDefs);
  };
  computeFixed();

  // ── Stage 2 ──────────────────────────────────────────
  report("place", 0.1);
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) netOfPin.set(`${a.componentId}:${a.pinId}`, a.netId);

  const materialize = (gap: number) => {
    const freeTiles = tiles.filter((t) => !t.anchor);
    const anchoredTiles = tiles.filter((t) => t.anchor);
    const floorplan = freeTiles.length > 0 ? composeTiles(freeTiles, gap, planLimits) : null;
    const fpRows = Math.max(1, floorplan?.rows ?? 0);
    const fpCols = Math.max(1, floorplan?.cols ?? 0);
    // Place the free block clear of anchored tiles and locked obstacles:
    // as-is if nothing collides, else right of or below all of them.
    let ox = 0;
    let oy0 = 0;
    if (fixedContentRects.length > 0 && floorplan) {
      const collides = (dy: number, dx: number) =>
        fixedContentRects.some((r) =>
          dx <= r.maxCol + 1 && dx + fpCols - 1 >= r.minCol - 1 &&
          dy <= r.maxRow + 1 && dy + fpRows - 1 >= r.minRow - 1);
      let bestArea = Infinity;
      for (let dy = 0; dy <= fixedMaxRow + 2; dy++) {
        for (let dx = 0; dx <= fixedMaxCol + 2; dx++) {
          if (collides(dy, dx)) continue;
          const rowsC = Math.max(dy + fpRows, fixedMaxRow + 1);
          const colsC = Math.max(dx + fpCols, fixedMaxCol + 1);
          const over =
            (limits.maxRows ? Math.max(0, rowsC - limits.maxRows) : 0) +
            (limits.maxCols ? Math.max(0, colsC - limits.maxCols) : 0);
          const area =
            (limits.maxRows ? Math.max(limits.maxRows, rowsC) : rowsC) *
            (limits.maxCols ? Math.max(limits.maxCols, colsC) : colsC) + 200 * over;
          if (area < bestArea) {
            bestArea = area;
            oy0 = dy;
            ox = dx;
          }
        }
      }
      if (bestArea === Infinity) {
        oy0 = fixedMaxRow + 2;
        ox = 0;
      }
    }
    const rows = Math.max(5, floorplan ? oy0 + fpRows : (fixedRects.length > 0 ? 0 : board.rows), fixedMaxRow + 1);
    const cols = Math.max(5, floorplan ? ox + fpCols : (fixedRects.length > 0 ? 0 : board.cols), fixedMaxCol + 1);
    const moved = new Map<string, Component>();
    for (const t of anchoredTiles) {
      const ar = t.anchor!.row;
      const ac = t.anchor!.col;
      for (const rp of t.rigidParts) {
        if (lockedIds.has(rp.comp.id)) continue; // it is already exactly there
        moved.set(rp.comp.id, {
          ...rp.comp,
          boardPos: { row: rp.row + ar, col: rp.col + ac },
          rotation: rp.rotation,
          flexibleEndPos: undefined,
        });
      }
      for (const p of t.parts) {
        const pos = { row: p.row1 + ar, col: p.col1 + ac };
        const end = p.row2 !== undefined ? { row: p.row2 + ar, col: p.col2! + ac } : undefined;
        moved.set(p.comp.id, { ...p.comp, boardPos: pos, rotation: 0, flexibleEndPos: end });
      }
    }
    if (floorplan) {
      const bandY: number[] = [];
      let yCur = oy0;
      floorplan.bandHeights.forEach((h) => {
        bandY.push(yCur);
        yCur += h + 1;
      });
      for (const { tile, band, x, dy } of floorplan.placedTiles) {
        const oy = bandY[band] + dy;
        for (const rp of tile.rigidParts) {
          moved.set(rp.comp.id, {
            ...rp.comp,
            boardPos: { row: rp.row + oy, col: rp.col + x + ox },
            rotation: rp.rotation,
            flexibleEndPos: undefined,
          });
        }
        for (const p of tile.parts) {
          const pos = { row: p.row1 + oy, col: p.col1 + x + ox };
          const end = p.row2 !== undefined ? { row: p.row2 + oy, col: p.col2! + x + ox } : undefined;
          moved.set(p.comp.id, { ...p.comp, boardPos: pos, rotation: 0, flexibleEndPos: end });
        }
      }
    }
    const virtual = components.map((c) => {
      const m = moved.get(c.id);
      if (m) return m;
      if (unplaced.some((u) => u.id === c.id)) return { ...c, boardPos: null, flexibleEndPos: undefined };
      return c;
    });
    return { virtual, rows, cols, movedIds: new Set(moved.keys()) };
  };

  // ── Finish: derive cuts and the remaining wires ──────
  // Try the densest layout first. If routing starves (no free hole for a
  // link wire), find the largest prefix of the removal sequence that still
  // routes cleanly; a wider-gap floorplan is the last resort.
  interface Candidate {
    virtual: Component[];
    rows: number;
    cols: number;
    movedIds: Set<string>;
    plan: CompletionPlan;
    bad: number;
  }
  let chosen: Candidate | null = null;
  // Among clean candidates, a cell of board and a hole of wire mess (length
  // over parts / off axis) weigh the same — density must not buy ugly wires.
  // Locked dimensions are paid in full either way.
  const cost = (c: Candidate) =>
    (limits.maxRows ? Math.max(limits.maxRows, c.rows) : c.rows) *
    (limits.maxCols ? Math.max(limits.maxCols, c.cols) : c.cols) + c.plan.wireMess;
  const route = (virtual: Component[], rows: number, cols: number, movedIds: Set<string>): Candidate => {
    const tryBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
    const plan = deriveCompletion(tryBoard, virtual, componentDefs, nets, netAssignments);
    const overCap =
      (limits.maxRows ? Math.max(0, rows - limits.maxRows) : 0) +
      (limits.maxCols ? Math.max(0, cols - limits.maxCols) : 0);
    const bad = plan.unresolvedConflicts * 100 + 40 * overCap + plan.starvedNetIds.length;
    const cand: Candidate = { virtual, rows, cols, movedIds, plan, bad };
    if (!chosen || bad < chosen.bad || (bad === chosen.bad && cost(cand) < cost(chosen))) {
      chosen = cand;
    }
    return cand;
  };
  // Slide only the FREE content sideways by dc columns, locked parts staying
  // put. A uniform shift leaves free-vs-free geometry unchanged, so only the
  // new relations against locked parts need checking here; whether the result
  // routes better is judged by route() as usual. Returns null when a shifted
  // part would leave the board or violate geometry against a locked part.
  const shiftFreeSideways = (
    virtual: Component[],
    dc: number,
    cols: number
  ): Component[] | null => {
    interface Geo {
      rects: FootprintRect[];
      segs: { p1: BoardPosition; p2: BoardPosition }[];
      pins: BoardPosition[];
    }
    const geoOf = (comps: Component[]): Geo => {
      const g: Geo = { rects: [], segs: [], pins: [] };
      for (const c of comps) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const p2 = c.flexibleEndPos ?? c.boardPos;
          g.segs.push({ p1: c.boardPos, p2 });
          g.pins.push(c.boardPos, p2);
        } else {
          g.rects.push(getComponentBounds(def, c.boardPos, c.rotation));
          for (const p of getRotatedPinPositions(def, c.boardPos, c.rotation)) {
            g.pins.push({ row: p.row, col: p.col });
          }
        }
      }
      return g;
    };
    const shifted: Component[] = [];
    const free: Component[] = [];
    for (const c of virtual) {
      if (!c.boardPos || lockedIds.has(c.id)) {
        shifted.push(c);
        continue;
      }
      const s: Component = {
        ...c,
        boardPos: { row: c.boardPos.row, col: c.boardPos.col + dc },
        ...(c.flexibleEndPos
          ? { flexibleEndPos: { row: c.flexibleEndPos.row, col: c.flexibleEndPos.col + dc } }
          : {}),
      };
      shifted.push(s);
      free.push(s);
    }
    const freeGeo = geoOf(free);
    const lockGeo = geoOf(lockedParts);
    for (const r of freeGeo.rects) if (r.minCol < 0 || r.maxCol >= cols) return null;
    for (const p of freeGeo.pins) if (p.col < 0 || p.col >= cols) return null;
    const overlap = (a: FootprintRect, b: FootprintRect) =>
      a.minRow <= b.maxRow && b.minRow <= a.maxRow && a.minCol <= b.maxCol && b.minCol <= a.maxCol;
    const inRect = (p: BoardPosition, r: FootprintRect) =>
      p.row >= r.minRow && p.row <= r.maxRow && p.col >= r.minCol && p.col <= r.maxCol;
    for (const fr of freeGeo.rects) {
      if (lockGeo.rects.some((lr) => overlap(fr, lr))) return null;
      if (lockGeo.segs.some((ls) => bodyIntersectsRect(ls.p1, ls.p2, fr))) return null;
      if (lockGeo.pins.some((p) => inRect(p, fr))) return null;
    }
    for (const fs of freeGeo.segs) {
      if (lockGeo.rects.some((lr) => bodyIntersectsRect(fs.p1, fs.p2, lr))) return null;
      if (
        lockGeo.segs.some(
          (ls) =>
            segmentsIntersect(fs.p1, fs.p2, ls.p1, ls.p2) ||
            bodiesTooClose(fs.p1, fs.p2, ls.p1, ls.p2)
        )
      )
        return null;
    }
    const lockedHoles = new Set(lockGeo.pins.map((p) => `${p.row},${p.col}`));
    for (const s of lockGeo.segs)
      for (const h of corridorHoles(s.p1, s.p2)) lockedHoles.add(`${h.row},${h.col}`);
    for (const p of freeGeo.pins) if (lockedHoles.has(`${p.row},${p.col}`)) return null;
    const freeCorridor = new Set<string>();
    for (const s of freeGeo.segs)
      for (const h of corridorHoles(s.p1, s.p2)) freeCorridor.add(`${h.row},${h.col}`);
    for (const p of lockGeo.pins) if (freeCorridor.has(`${p.row},${p.col}`)) return null;
    return shifted;
  };

  // gap 2 leaves one empty column between tiles so edge parts keep body
  // clearance; compaction closes the seam wherever that stays legal.
  const runLadder = () => {
    outer: for (const gap of [2, 3]) {
      const m = materialize(gap);
      report("place", gap === 2 ? 0.3 : 0.6);
      if (m.rows * m.cols <= 300) {
        // small board: routing is cheap enough to verify every removal, so
        // compaction stops exactly where wires would starve or get messy
        const loose = route(m.virtual, m.rows, m.cols, m.movedIds);
        if (loose.bad === 0) {
          const messCap = loose.plan.wireMess + 2;
          const validate = (comps: Component[], rows: number, cols: number) => {
            const p = deriveCompletion({ ...board, rows, cols, cuts: [], wires: [] }, comps, componentDefs, nets, netAssignments);
            return p.unresolvedConflicts === 0 && p.starvedNetIds.length === 0 && p.wireMess <= messCap;
          };
          const full = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols, Infinity, validate);
          route(full.comps, full.rows, full.cols, m.movedIds);
          break outer;
        }
        // loose is unusable (often a locked dimension): the generic path below
        // gets a chance, since full compaction may pull the board under its cap
      }
      const full = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols);
      if (route(full.comps, full.rows, full.cols, m.movedIds).bad === 0) break;
      const loose = route(m.virtual, m.rows, m.cols, m.movedIds);
      if (loose.bad === 0) {
        let lo = 0;
        let hi = full.removals;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const part = compactPlacements(m.virtual, componentDefs, netOfPin, m.rows, m.cols, mid);
          if (route(part.comps, part.rows, part.cols, m.movedIds).bad === 0) lo = mid;
          else hi = mid;
        }
        break outer;
      }
    }
    // An empty column at a board edge is a wire channel: every outermost
    // strip segment gains a crossing-free vertical path — and on a tightly
    // capped board it is often the only place link wires can still attach.
    // Keep one (or both) when what it fixes or saves outweighs its cost.
    if (chosen!.bad < 100) {
      const c0: Candidate = chosen!;
      route(c0.virtual, c0.rows, c0.cols + 1, c0.movedIds);
      if (lockedParts.length === 0) {
        // shifting the content right is only possible when nothing is locked
        const shifted = c0.virtual.map((c) => {
          if (!c.boardPos) return c;
          return {
            ...c,
            boardPos: { row: c.boardPos.row, col: c.boardPos.col + 1 },
            ...(c.flexibleEndPos
              ? { flexibleEndPos: { row: c.flexibleEndPos.row, col: c.flexibleEndPos.col + 1 } }
              : {}),
          };
        });
        route(shifted, c0.rows, c0.cols + 1, c0.movedIds); // left channel only
        route(shifted, c0.rows, c0.cols + 2, c0.movedIds); // both edges
      } else if (chosen!.bad > 0) {
        // With locked parts that shift would move them off their positions.
        // But a starved segment flush against a board edge (e.g. a horizontal
        // part's cut-off pin at col 0, unwireable: pin + body corridor fill
        // the segment) can still be rescued by sliding only the free content
        // sideways within the same board.
        for (const dc of [1, -1, 2, -2]) {
          if (chosen!.bad === 0) break;
          const slid = shiftFreeSideways(c0.virtual, dc, c0.cols);
          if (slid) route(slid, c0.rows, c0.cols, c0.movedIds);
        }
      }
    }
  };
  runLadder();
  // Designing blocks around the locked parts is a bet; when it routes badly
  // (adversarial lock positions), fall back to the conservative model:
  // every locked part a plain obstacle, everything else arranged freely.
  if (chosen!.bad >= 3 && tiles.some((t) => t.anchor)) {
    for (const t of [...tiles].filter((x) => x.anchor)) demoteTile(t);
    computeFixed();
    chosen = null;
    runLadder();
  }
  report("place", 0.9);
  const { virtual, movedIds, plan } = chosen!;
  // A locked dimension stays exactly at the user's value: the physical
  // board doesn't shrink, and overflowing it is reported, not hidden.
  if (board.lockedRows && chosen!.rows > board.rows) {
    issues.push(`does not fit the locked ${board.rows} rows (needs ${chosen!.rows})`);
  }
  if (board.lockedCols && chosen!.cols > board.cols) {
    issues.push(`does not fit the locked ${board.cols} columns (needs ${chosen!.cols})`);
  }
  const rows = board.lockedRows ? Math.max(board.rows, chosen!.rows) : chosen!.rows;
  const cols = board.lockedCols ? Math.max(board.cols, chosen!.cols) : chosen!.cols;

  const placements: LayoutPlacement[] = [];
  for (const c of virtual) {
    if (!movedIds.has(c.id) || !c.boardPos) continue;
    const def = resolveComponentDef(c, componentDefs);
    placements.push(
      def?.flexible
        ? { componentId: c.id, boardPos: c.boardPos, flexibleEndPos: c.flexibleEndPos }
        : { componentId: c.id, boardPos: c.boardPos, rotation: c.rotation }
    );
  }
  const sizedBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
  issues.push(...plan.issues);
  if (plan.unresolvedConflicts > 0) {
    issues.push(`${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved`);
  }
  const stillUnplaced = virtual.filter((c) => !c.boardPos && !c.boardExcluded);
  if (stillUnplaced.length > 0) {
    issues.push(`${stillUnplaced.length} component${stillUnplaced.length > 1 ? "s" : ""} could not be placed`);
  }

  // ── Quality (same scale as v1, for messages and tooling) ──
  const finalBoard: Board = {
    ...sizedBoard,
    cuts: plan.cuts,
    wires: plan.wires.map((w, i) => ({ id: `v2-${i}`, from: w.from, to: w.to })),
  };
  const segments = computeStripSegments(finalBoard, virtual, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, finalBoard.wires);
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(nets, netAssignments, segments, connectivity, virtual, componentDefs);
  const quality = conflicts * 100 + incomplete.length + stillUnplaced.length * 2;
  report("place", 1);

  return {
    placements,
    cuts: plan.cuts,
    wires: plan.wires,
    issues,
    quality,
    starvedNetIds: plan.starvedNetIds,
    boardSize: { rows, cols },
    unplaceIds: stillUnplaced.map((c) => c.id),
  };
}
