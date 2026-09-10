import { Board, BoardPosition, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { pinKey } from "./keys";
import { getComponentBounds } from "./boardLayout";
import { spanLimits } from "./flexGeometry";
import { AutoLayoutProgress, AutoLayoutResult, LayoutPlacement } from "./layoutTypes";
import { computeAutoLayout5 } from "./autoLayout5";
import { Chooser } from "./layout2/chooser";
import { compactPlacements } from "./layout2/compaction";
import { insertWireChannels } from "./layout2/channelPass";
import { repairSlantWires } from "./layout2/slantRepairPass";
import { trimResult } from "./layout2/trimResult";
import { alignCuts } from "./layout2/alignCuts";
import { padAroundEdgeConnectors } from "./layout2/edgePadding";

// ── Bipartition solve ──
// Big boards are split into two halves along a balanced minimum cut of
// the netlist (few nets span both halves, and those are the supply nets
// a bus row serves anyway). Each half is annealed on its own under one
// common locked dimension, so the two finished halves stack (common
// width, one seam row between) or pair up (common height, one seam
// column) without any fitting, and the composed board goes through the
// same finalize as a joint solve: the router wires the seam. One variant
// (orientation and size scale) is one job; the editor runs the variants
// beside the joint seeds and the usual pick decides.

export interface AutoLayout5SplitOptions {
  // which composition to build, 0 .. SPLIT_VARIANTS - 1
  variant: number;
  // anneal budget per half seed (default: v5's size-scaled default)
  moves?: number;
  timeBudgetMs?: number;
  // seeds per half (default 3), starting at seedBase (default 0)
  seeds?: number;
  seedBase?: number;
  drilledCutsOnly?: boolean;
  noWireStacking?: boolean;
}

// size scales around the footprint estimate, each in both orientations
const SPLIT_SCALES = [0.8, 1, 1.25];
export const SPLIT_VARIANTS = SPLIT_SCALES.length * 2;
// boards below this many placeable parts gain nothing from a split
export const SPLIT_MIN_PARTS = 20;
// board area per unit of summed part footprint the joint solve reaches on
// big boards (corpus median), and the rows/cols shape aimed for
const PACK_FACTOR = 1.38;
const TARGET_ASPECT = 0.8;

export function computeAutoLayout5Split(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout5SplitOptions
): AutoLayoutResult {
  const fail = (msg: string): AutoLayoutResult => ({
    placements: [], cuts: [], wires: [], issues: [msg], quality: 1e6, starvedNetIds: [],
    unplaceIds: components.filter((c) => !c.boardExcluded).map((c) => c.id),
  });
  const placeable = components.filter((c) => !c.boardExcluded);
  const ids = placeable.map((c) => c.id);
  const n = ids.length;
  if (n < 4) return fail("too few parts to split");

  // ── partition: pin-balanced minimum cut over the nets (FM moves) ──
  const idx = new Map(ids.map((id, i) => [id, i]));
  const pinsOf = new Int32Array(n);
  const netMembers = new Map<string, Set<number>>();
  for (const a of netAssignments) {
    const i = idx.get(a.componentId);
    if (i === undefined) continue;
    pinsOf[i]++;
    if (!netMembers.has(a.netId)) netMembers.set(a.netId, new Set());
    netMembers.get(a.netId)!.add(i);
  }
  const netList = [...netMembers.values()].filter((s) => s.size >= 2).map((s) => [...s]);
  const totalPins = pinsOf.reduce((a, b) => a + b, 0);
  const minSide = Math.ceil(totalPins / 3);
  const partNets: number[][] = ids.map(() => []);
  netList.forEach((ns, k) => ns.forEach((i) => partNets[i].push(k)));
  let rng = 7;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
  const cutCount = (side: Int8Array) =>
    netList.reduce((c, ns) => c + (ns.some((i) => side[i] === 0) && ns.some((i) => side[i] === 1) ? 1 : 0), 0);
  let bestSide: Int8Array | null = null;
  let bestCut = Infinity;
  for (let restart = 0; restart < 60; restart++) {
    const side = new Int8Array(n);
    const pins = [0, 0];
    const order = [...Array(n).keys()].sort(() => rand() - 0.5);
    for (const i of order) {
      const s = pins[0] <= pins[1] ? 0 : 1;
      side[i] = s;
      pins[s] += pinsOf[i];
    }
    for (let pass = 0; pass < 50; pass++) {
      let bestGain = 0, bi = -1;
      for (let i = 0; i < n; i++) {
        const from = side[i];
        if (pins[from] - pinsOf[i] < minSide) continue;
        let gain = 0;
        for (const k of partNets[i]) {
          const ns = netList[k];
          const same = ns.filter((j) => j !== i && side[j] === from).length;
          const other = ns.length - 1 - same;
          if (same === 0 && other > 0) gain++;
          else if (other === 0 && same > 0) gain--;
        }
        if (gain > bestGain) {
          bestGain = gain;
          bi = i;
        }
      }
      if (bi < 0) break;
      pins[side[bi]] -= pinsOf[bi];
      side[bi] = 1 - side[bi];
      pins[side[bi]] += pinsOf[bi];
    }
    const c = cutCount(side);
    if (c < bestCut) {
      bestCut = c;
      bestSide = side;
    }
  }
  if (!bestSide || !bestSide.some((s) => s === 0) || !bestSide.some((s) => s === 1)) return fail("could not split the parts");

  // ── size estimate from the summed part footprints ──
  let footprint = 0;
  for (const c of placeable) {
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) footprint += (spanLimits(def).min + 1) * 3;
    else {
      const b = getComponentBounds(def, { row: 0, col: 0 }, 0);
      footprint += (b.maxRow - b.minRow + 2) * (b.maxCol - b.minCol + 2);
    }
  }
  const area = PACK_FACTOR * footprint;
  const variant = Math.max(0, Math.min(SPLIT_VARIANTS - 1, options?.variant ?? 0));
  const lockDim: "cols" | "rows" = variant % 2 === 0 ? "cols" : "rows";
  const scale = SPLIT_SCALES[Math.floor(variant / 2)];
  const size = Math.max(4, Math.round(scale * (lockDim === "cols" ? Math.sqrt(area / TARGET_ASPECT) : Math.sqrt(area * TARGET_ASPECT))));

  // ── solve the halves under the common locked dimension ──
  const seeds = options?.seeds ?? 3;
  const blank: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }));
  const halves = [0, 1].map((s) => {
    const mine = new Set(ids.filter((_, i) => bestSide![i] === s));
    const comps = blank.map((c) => (mine.has(c.id) ? c : { ...c, boardExcluded: true }));
    const asg = netAssignments.filter((a) => mine.has(a.componentId));
    const halfBoard: Board = lockDim === "cols"
      ? { ...board, rows: 8, cols: size, cuts: [], wires: [], lockedRows: false, lockedCols: true }
      : { ...board, rows: size, cols: 8, cuts: [], wires: [], lockedRows: true, lockedCols: false };
    const res = computeAutoLayout5(halfBoard, comps, componentDefs, nets, asg,
      onProgress ? (p) => onProgress({ ...p, frac: (s + p.frac) * 0.45 }) : undefined,
      {
        seeds,
        seedBase: options?.seedBase ?? 0,
        // the seam side ends up in the interior: connectors go elsewhere
        connSides: lockDim === "cols"
          ? { top: s !== 1, bottom: s !== 0, left: true, right: true }
          : { top: true, bottom: true, left: s !== 1, right: s !== 0 },
        ...(options?.moves !== undefined ? { moves: options.moves } : {}),
        ...(options?.timeBudgetMs !== undefined ? { timeBudgetMs: options.timeBudgetMs } : {}),
        ...(options?.drilledCutsOnly ? { drilledCutsOnly: true } : {}),
        ...(options?.noWireStacking ? { noWireStacking: true } : {}),
      });
    return { mine, res };
  });
  const s0 = halves[0].res.boardSize, s1 = halves[1].res.boardSize;
  if (!s0 || !s1) return fail("a half could not be laid out");

  // ── stack (common width) or pair up (common height) with one seam line ──
  let rows: number, cols: number;
  let shift: (q: BoardPosition) => BoardPosition;
  if (lockDim === "cols") {
    rows = s0.rows + 1 + s1.rows;
    cols = Math.max(size, s0.cols, s1.cols);
    shift = (q) => ({ row: q.row + s0.rows + 1, col: q.col });
  } else {
    cols = s0.cols + 1 + s1.cols;
    rows = Math.max(size, s0.rows, s1.rows);
    shift = (q) => ({ row: q.row, col: q.col + s0.cols + 1 });
  }
  const placed = new Map<string, LayoutPlacement>();
  for (const p of halves[0].res.placements) placed.set(p.componentId, p);
  for (const p of halves[1].res.placements) {
    placed.set(p.componentId, { ...p, boardPos: shift(p.boardPos), ...(p.flexibleEndPos ? { flexibleEndPos: shift(p.flexibleEndPos) } : {}) });
  }
  // the route board is padded by one line on every side, like a joint
  // solve (inside a flush connector, so it stays on the edge)
  const comps0: Component[] = blank.map((c) => {
    const p = placed.get(c.id);
    if (!p) return c;
    return { ...c, boardPos: p.boardPos, rotation: p.rotation ?? 0, ...(p.flexibleEndPos ? { flexibleEndPos: p.flexibleEndPos } : {}) };
  });
  const padded = padAroundEdgeConnectors(comps0, componentDefs, rows, cols, { top: 1, bottom: 1, left: 1, right: 1 });
  const comps = padded.comps;
  const rRows = padded.rows, rCols = padded.cols;
  const routeBoard: Board = { ...board, rows: rRows, cols: rCols, cuts: [], wires: [], lockedRows: false, lockedCols: false };
  const movedIds = new Set(comps.filter((c) => c.boardPos).map((c) => c.id));

  // ── finalize the composed board: route, harvest empty lines, buy the
  // lines the seam wiring needs, straighten ──
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 0.9 });
  const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, options?.drilledCutsOnly ?? false, true, options?.noWireStacking ?? false);
  const c0 = chooser.route(comps, rRows, rCols, movedIds);
  chooser.freezePool();
  if (c0.bad === 0) {
    const netOfPin = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));
    const full = compactPlacements(c0.virtual, componentDefs, netOfPin, c0.rows, c0.cols);
    if (full.removals > 0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds);
  }
  if (chooser.chosen!.bad === 0) insertWireChannels(chooser, componentDefs, {}, false, true);
  if (chooser.chosen!.bad === 0) repairSlantWires(chooser, routeBoard, componentDefs, netAssignments, new Set());
  const ch = chooser.chosen!;

  const unplaceIds = [
    ...components.filter((c) => c.boardExcluded).map((c) => c.id),
    ...placeable.filter((c) => !movedIds.has(c.id)).map((c) => c.id),
  ];
  const issues: string[] = [];
  for (const id of placeable.filter((c) => !movedIds.has(c.id)).map((c) => c.id)) {
    const c = components.find((x) => x.id === id);
    issues.push(`${c?.label ?? id} could not be planned`);
  }
  if (ch.plan.unresolvedConflicts > 0) issues.push(`${ch.plan.unresolvedConflicts} strip conflicts remain`);
  if (ch.mess > 0) issues.push(`${ch.mess} wire${ch.mess === 1 ? "" : "s"} could not be made straight and crossing-free`);
  const result: AutoLayoutResult = {
    placements: ch.virtual
      .filter((c) => movedIds.has(c.id) && c.boardPos)
      .map((c) => {
        const def = resolveComponentDef(c, componentDefs)!;
        return def.flexible
          ? { componentId: c.id, boardPos: c.boardPos!, flexibleEndPos: c.flexibleEndPos }
          : { componentId: c.id, boardPos: c.boardPos!, rotation: c.rotation };
      }),
    cuts: ch.plan.cuts,
    wires: ch.plan.wires,
    issues,
    quality: ch.plan.unresolvedConflicts * 100 + ch.plan.starvedNetIds.length + (placeable.length - movedIds.size) * 2,
    starvedNetIds: ch.plan.starvedNetIds,
    boardSize: { rows: ch.rows, cols: ch.cols },
    unplaceIds,
  };
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 1 });
  const final = { ...result, ...trimResult(result, routeBoard, ch.virtual, componentDefs, false) };
  return final.quality === 0 ? alignCuts(final, routeBoard, components, componentDefs) : final;
}
