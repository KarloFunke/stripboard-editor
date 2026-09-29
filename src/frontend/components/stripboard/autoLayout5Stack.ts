import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "./boardLayout";
import { spanLimits } from "./flexGeometry";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { computeAutoLayout5, type MoveLogRec } from "./autoLayout5";
import { LEAD_DEF_ID, expandOffBoard } from "./offBoard";
import { Skeleton, finishSkeleton } from "./layout2/finish";

// ── Stacked solve: leaves under a pin cap, one above the other ──
// A big board is cut into leaves by recursive bisection of the netlist
// until no leaf carries more pins than the cap. Every net the cut severs
// gets a one-hole port pad in each leaf it touches, the same virtual pad an
// off-board part gets, so the leaf's own anneal parks that net on the rim.
// Each leaf is annealed on its own under one common locked width with its
// connectors and ports priced onto the top and bottom edges. The finished
// leaves are stacked with one blank gutter row between neighbours, the
// port pads are taken away again, and the composed placement goes through
// the ordinary finish, which wires the severed nets across the gutters
// exactly as it wires any other net.

export interface AutoLayout5StackOptions {
  // most pins a leaf may carry, ports included
  pinCap: number;
  // one leaf anneal: seeds (default 1) from seedBase, and its budget: moves
  // per leaf, or the wall time of the whole stack, shared out by pin count
  seeds?: number;
  seedBase?: number;
  moves?: number;
  // per leaf, from the leaf's own pins (see AutoLayout5Options.effort)
  effort?: number;
  timeBudgetMs?: number;
  // leaves are solved at their own width instead of one locked width
  freeWidth?: boolean;
  drilledCutsOnly?: boolean;
  noWireStacking?: boolean;
  exactBest?: boolean;
  protectTies?: boolean | number;
  wasm?: WebAssembly.Module;
  // Harness-only: every leaf anneal's proposals, with the leaf's index
  moveLog?: (rec: MoveLogRec, leaf: number) => void;
  // what the stack was made of, for the harness
  onLeaves?: (info: { leaves: { parts: number; pins: number; ports: number; rows: number; cols: number; wires: number; cuts: number; ms: number }[]; width?: number }) => void;
}

export const STACK_PORT_PREFIX = "stack-port#";

// The editor stacked a free board from this many pins on (net assignments of
// its placeable parts), every worker a stack seed under this cap: measured
// 2026-09-25 at the 60 s default, the stack won or tied every board above
// 200 pins and took a fifth of the joint's time on the largest. Not used by
// the editor since 2026-09-29: with the decoder in WebAssembly the joint
// search at the same effort came out 35-50 % cheaper on those boards
// (movelog/joint-vs-stack-2026-09-29), in one to three minutes. Kept for the
// harness (v5Corpus --stack, --stop) and for reference.
export const STACK_MIN_PINS = 200;
export const STACK_PIN_CAP = 100;

// A leaf whose board fails (its finish could not make every wire straight and
// unstacked: a width-locked leaf cannot add channels) is solved again from
// other seeds before its stack seed is lost. Measured 2026-09-27 on 1110,
// where a quarter of the leaf solves failed: 8 of 12 stack seeds lost, none
// with three tries. Leaves also keep the move mix without pull and tie, which
// made that board's port-heavy leaves fail even with the retries.
const LEAF_TRIES = 3;
const LEAF_RETRY_SEED = 1000;

// board area per unit of summed part footprint the joint solve reaches on
// big boards (corpus median), and the rows/cols shape aimed for
const PACK_FACTOR = 1.38;
const TARGET_ASPECT = 0.8;

export function computeAutoLayout5Stack(
  board: Board,
  rawComponents: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  rawAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout5StackOptions
): AutoLayoutResult {
  // off-board parts become their solder pads here, once, so the leaves and
  // the composed finish see the same parts
  const { components, netAssignments } = expandOffBoard(rawComponents, componentDefs, rawAssignments);
  const fail = (msg: string): AutoLayoutResult => ({
    placements: [], cuts: [], wires: [], issues: [msg], quality: 1e6, starvedNetIds: [],
    unplaceIds: components.filter((c) => !c.boardExcluded).map((c) => c.id),
  });
  const pinCap = Math.max(8, options?.pinCap ?? 120);
  const placeable = components.filter((c) => !c.boardExcluded);
  const ids = placeable.map((c) => c.id);
  const n = ids.length;
  if (n < 4) return fail("too few parts to stack");

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
  const partNets: number[][] = ids.map(() => []);
  netList.forEach((ns, k) => ns.forEach((i) => partNets[i].push(k)));

  // ── pin-balanced minimum cut of one group (FM-style moves, restarts) ──
  let rng = 7;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
  const bisect = (group: number[]): [number[], number[]] | null => {
    const inGroup = new Set(group);
    const side = new Map<number, number>();
    const totalPins = group.reduce((s, i) => s + pinsOf[i], 0);
    const minSide = Math.ceil(totalPins / 3);
    const cutCount = () =>
      netList.reduce((c, ns) => {
        const mine = ns.filter((i) => inGroup.has(i));
        return c + (mine.some((i) => side.get(i) === 0) && mine.some((i) => side.get(i) === 1) ? 1 : 0);
      }, 0);
    let best: Map<number, number> | null = null;
    let bestCut = Infinity;
    for (let restart = 0; restart < 60; restart++) {
      const pins = [0, 0];
      const order = [...group].sort(() => rand() - 0.5);
      for (const i of order) {
        const s = pins[0] <= pins[1] ? 0 : 1;
        side.set(i, s);
        pins[s] += pinsOf[i];
      }
      for (let pass = 0; pass < 50; pass++) {
        let bestGain = 0, bi = -1;
        for (const i of group) {
          const from = side.get(i)!;
          if (pins[from] - pinsOf[i] < minSide) continue;
          let gain = 0;
          for (const k of partNets[i]) {
            const ns = netList[k].filter((j) => inGroup.has(j));
            const same = ns.filter((j) => j !== i && side.get(j) === from).length;
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
        const from = side.get(bi)!;
        pins[from] -= pinsOf[bi];
        side.set(bi, 1 - from);
        pins[1 - from] += pinsOf[bi];
      }
      const c = cutCount();
      if (c < bestCut) {
        bestCut = c;
        best = new Map(side);
      }
    }
    if (!best) return null;
    const a = group.filter((i) => best!.get(i) === 0), b = group.filter((i) => best!.get(i) === 1);
    return a.length && b.length ? [a, b] : null;
  };
  // ports count as pins of the leaf they land in
  const pinsWithPorts = (group: number[]) => {
    const inGroup = new Set(group);
    let pins = group.reduce((s, i) => s + pinsOf[i], 0);
    for (const ns of netList) if (ns.some((i) => inGroup.has(i)) && ns.some((i) => !inGroup.has(i))) pins++;
    return pins;
  };
  const leaves: number[][] = [];
  const todo: number[][] = [[...Array(n).keys()]];
  while (todo.length) {
    const g = todo.pop()!;
    if (pinsWithPorts(g) <= pinCap || g.length < 4) { leaves.push(g); continue; }
    const halves = bisect(g);
    if (!halves) { leaves.push(g); continue; }
    todo.push(halves[0], halves[1]);
  }
  if (leaves.length < 2) return fail("nothing to stack: one leaf fits the pin cap");

  // ── the common width, from the summed part footprints ──
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
  const width = Math.max(4, Math.round(Math.sqrt((PACK_FACTOR * footprint) / TARGET_ASPECT)));

  // ── every leaf on its own, ports on the severed nets ──
  const blank: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }));
  const seeds = options?.seeds ?? 1;
  const pinsAll = leaves.reduce((s, g) => s + pinsWithPorts(g), 0);
  const leafInfo: { parts: number; pins: number; ports: number; rows: number; cols: number; wires: number; cuts: number; ms: number }[] = [];
  const solved: { mine: Set<string>; res: AutoLayoutResult }[] = [];
  for (const [li, group] of leaves.entries()) {
    const inGroup = new Set(group);
    const mine = new Set(group.map((i) => ids[i]));
    const ports: Component[] = [];
    const portAsg: NetAssignment[] = [];
    for (const [netId, members] of netMembers) {
      const inside = [...members].some((i) => inGroup.has(i)), outside = [...members].some((i) => !inGroup.has(i));
      if (!inside || !outside) continue;
      const id = `${STACK_PORT_PREFIX}${li}#${netId}`;
      ports.push({
        id, defId: LEAD_DEF_ID, label: `port ${netId}`,
        schematicPos: { x: 0, y: 0 }, schematicRotation: 0,
        boardPos: null, rotation: 0, package: "wire",
      } as Component);
      portAsg.push({ netId, componentId: id, pinId: "1" });
    }
    const comps = [...blank.map((c) => (mine.has(c.id) ? c : { ...c, boardExcluded: true })), ...ports];
    const asg = [...netAssignments.filter((a) => mine.has(a.componentId)), ...portAsg];
    const leafBoard: Board = options?.freeWidth
      ? { ...board, rows: 8, cols: 8, cuts: [], wires: [], lockedRows: false, lockedCols: false }
      : { ...board, rows: 8, cols: width, cuts: [], wires: [], lockedRows: false, lockedCols: true };
    const t0 = Date.now();
    const solveLeaf = (attempt: number) => computeAutoLayout5(leafBoard, comps, componentDefs, nets, asg,
      onProgress ? (p) => onProgress({ ...p, frac: ((li + p.frac) / leaves.length) * 0.9 }) : undefined,
      {
        seeds,
        seedBase: (options?.seedBase ?? 0) + attempt * LEAF_RETRY_SEED,
        pullTie: false,
        // a leaf meets its neighbours above and below, so that is where its
        // ports go: the first leaf has one below, the last one above, the
        // rest both; its real connectors belong on the edges that stay the
        // rim of the finished stack: left and right, plus the top of the
        // first leaf and the bottom of the last
        connSidesOf: (id) => id.startsWith(STACK_PORT_PREFIX)
          ? { top: li > 0, bottom: li < leaves.length - 1, left: false, right: false }
          : { top: li === 0, bottom: li === leaves.length - 1, left: true, right: true },
        ...(options?.moves !== undefined ? { moves: options.moves } : {}),
        ...(options?.effort !== undefined ? { effort: options.effort } : {}),
        ...(options?.timeBudgetMs !== undefined ? { timeBudgetMs: (options.timeBudgetMs * pinsWithPorts(group)) / pinsAll } : {}),
        ...(options?.drilledCutsOnly ? { drilledCutsOnly: true } : {}),
        ...(options?.noWireStacking ? { noWireStacking: true } : {}),
        ...(options?.exactBest ? { exactBest: true } : {}),
        ...(options?.protectTies !== undefined ? { protectTies: options.protectTies } : {}),
        ...(options?.wasm ? { wasm: options.wasm } : {}),
        ...(options?.moveLog ? { moveLog: (r: MoveLogRec) => options.moveLog!(r, li) } : {}),
      });
    let res = solveLeaf(0);
    for (let attempt = 1; attempt < LEAF_TRIES && (!res.boardSize || res.quality > 0); attempt++) res = solveLeaf(attempt);
    if (!res.boardSize || res.quality > 0) return fail(`leaf ${li + 1} of ${leaves.length} could not be laid out: ${res.issues.join("; ")}`);
    leafInfo.push({ parts: group.length, pins: pinsWithPorts(group), ports: ports.length, rows: res.boardSize.rows, cols: res.boardSize.cols, wires: res.wires.length, cuts: res.cuts.length, ms: Date.now() - t0 });
    solved.push({ mine, res });
  }
  options?.onLeaves?.({ leaves: leafInfo, ...(options?.freeWidth ? {} : { width }) });

  // ── stack, one gutter row between neighbours, ports taken away ──
  const cols = Math.max(...solved.map((s) => s.res.boardSize!.cols));
  let row0 = 0;
  const placed: Skeleton["placed"] = [];
  for (const s of solved) {
    const shift = (q: { row: number; col: number }) => ({ row: q.row + row0, col: q.col });
    for (const p of s.res.placements) {
      if (p.componentId.startsWith(STACK_PORT_PREFIX)) continue;
      placed.push({
        id: p.componentId, boardPos: shift(p.boardPos), rotation: p.rotation ?? 0,
        ...(p.flexibleEndPos ? { flexibleEndPos: shift(p.flexibleEndPos) } : {}),
      });
    }
    row0 += s.res.boardSize!.rows + 1;
  }
  const rows = row0 - 1;
  const skeleton: Skeleton = {
    rows, cols, placed, skippedIds: [],
    metrics: { eBase: 0, mess: 0, wires: 0, wireLen: 0, cuts: 0, bCuts: 0 },
  };
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 0.9 });
  const finished = finishSkeleton(board, blank, componentDefs, nets, netAssignments, skeleton, {
    drilledCutsOnly: options?.drilledCutsOnly ?? false,
    noWireStacking: options?.noWireStacking ?? false,
  });
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 1 });
  return finished.final;
}
