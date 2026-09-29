import { Board, Component, ComponentDef, Cut, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions } from "./boardLayout";
import { AutoLayoutProgress, AutoLayoutResult, LayoutPlacement } from "./layoutTypes";
import { computeAutoLayout5 } from "./autoLayout5";
import { LEAD_DEF_ID, expandOffBoard, isLead } from "./offBoard";
import { deriveCompletion } from "./autoFinish";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { checkNetCompleteness } from "./netCompleteness";
import { holeKey } from "./keys";
import { wireMessScore } from "./layout2/tidyScore";

// ── Macro solve: clusters as parts of a smaller anneal ──
// Everything that belongs on a board edge, connectors and the pads of
// off-board parts, is kept out of the clusters. The rest is cut into leaves
// by recursive bisection of the netlist under a pin cap. Every net a leaf
// shares with the outside gets a one-hole port pad in that leaf, priced onto
// the leaf's left or right rim, so the net is a strip that reaches the edge.
// Each leaf is annealed and finished on its own. A finished leaf then becomes
// one rigid part whose pins tell the truth about its edges: its ports, and on
// every other row where the edge copper carries a net, a pin on that net (a
// private one when the net is internal), so the top level cuts it off from
// whatever it puts beside the cluster and never routes through a strip the
// cluster has cut. It may only turn by a half, so its strips stay strips.
// The top level anneals those parts together with the connectors and pads,
// and the leaves are unfolded into the result.

export interface AutoLayout5MacroOptions {
  // most pins a leaf may carry, ports included
  pinCap: number;
  // seeds (default 1) from seedBase, for the leaves and the top level alike
  seeds?: number;
  seedBase?: number;
  // budget of one leaf anneal
  moves?: number;
  timeBudgetMs?: number;
  // budget of the top-level anneal (default: the engine's own)
  topMoves?: number;
  topTimeBudgetMs?: number;
  drilledCutsOnly?: boolean;
  noWireStacking?: boolean;
  exactBest?: boolean;
  // how many times to cluster: 1 solves the clusters together with the
  // connectors, 2 clusters the clusters first, and so on. Above the first
  // level a cluster is capped by parts, since a solved cluster carries many
  // edge pins; `upperPartCap` (default 3) is that cap.
  levels?: number;
  upperPartCap?: number;
  // set by the solve on its own recursive calls
  level?: number;
  partCap?: number;
  // cap clusters by the nets they share with the outside instead of by pins
  // (pinCap then only caps their size), and leave a group loose, as free
  // parts of the top level, when its ports are not at least `minCompress`
  // times fewer than its pins
  portCap?: number;
  minCompress?: number;
  // free lines a cluster keeps to its neighbours (default 1)
  clusterGap?: number;
  // the decoder in WebAssembly (autoLayout5 wasm)
  wasm?: WebAssembly.Module;
  onInfo?: (info: MacroInfo) => void;
}

export interface MacroInfo {
  leaves: { parts: number; pins: number; ports: number; portsOffRim: number; edgePins: number; rows: number; cols: number; wires: number; cuts: number; ms: number }[];
  top: { parts: number; pins: number; ms: number; rows: number; cols: number };
  // parts left loose at the top level because clustering them bought nothing
  loose: number;
  // what the unfolded board looked like before any completion, and the
  // wires the completion then added; with truthful edge pins both stay at
  // zero
  unfolded: { conflicts: number; incomplete: number };
  patched: number;
}

export const MACRO_PORT_PREFIX = "macro-port#";
const MACRO_DEF_PREFIX = "def-macro-";
const MACRO_NET_PREFIX = "macro-net#";
// a solved cluster is an ordinary inner part at the next level up

export function computeAutoLayout5Macro(
  board: Board,
  rawComponents: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  rawAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout5MacroOptions
): AutoLayoutResult {
  const { components, netAssignments } = expandOffBoard(rawComponents, componentDefs, rawAssignments);
  const fail = (msg: string): AutoLayoutResult => ({
    placements: [], cuts: [], wires: [], issues: [msg], quality: 1e6, starvedNetIds: [],
    unplaceIds: components.filter((c) => !c.boardExcluded).map((c) => c.id),
  });
  const pinCap = Math.max(8, options?.pinCap ?? 120);
  const level = options?.level ?? 1;
  const levels = Math.max(1, options?.levels ?? 1);
  const defPrefix = `${MACRO_DEF_PREFIX}L${level}-`;
  const portPrefix = `${MACRO_PORT_PREFIX}L${level}-`;
  const netPrefix = `${MACRO_NET_PREFIX}L${level}-`;
  const placeable = components.filter((c) => !c.boardExcluded);
  const isEdgePart = (c: Component) => isLead(c) || resolveComponentDef(c, componentDefs)?.category === "connector";
  const edgeParts = placeable.filter(isEdgePart);
  const inner = placeable.filter((c) => !isEdgePart(c));
  const ids = inner.map((c) => c.id);
  const n = ids.length;
  if (n < 4) return fail("too few parts to cluster");

  const idx = new Map(ids.map((id, i) => [id, i]));
  const pinsOf = new Int32Array(n);
  // members of every net, inner parts by index; outside pins count as one
  // outside member, which is enough to know a net leaves the cluster
  const netMembers = new Map<string, { inside: Set<number>; outside: boolean }>();
  for (const a of netAssignments) {
    if (!netMembers.has(a.netId)) netMembers.set(a.netId, { inside: new Set(), outside: false });
    const m = netMembers.get(a.netId)!;
    const i = idx.get(a.componentId);
    if (i === undefined) { if (edgeParts.some((c) => c.id === a.componentId)) m.outside = true; continue; }
    pinsOf[i]++;
    m.inside.add(i);
  }
  const netList = [...netMembers.values()].filter((m) => m.inside.size >= 2).map((m) => [...m.inside]);
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
  // the nets a group shares with anything outside it, ports to be
  const cutNets = (group: number[]): string[] => {
    const inGroup = new Set(group);
    const out: string[] = [];
    for (const [netId, m] of netMembers) {
      const inside = [...m.inside].some((i) => inGroup.has(i));
      const outside = m.outside || [...m.inside].some((i) => !inGroup.has(i));
      if (inside && outside) out.push(netId);
    }
    return out;
  };
  const pinsWithPorts = (group: number[]) => group.reduce((s, i) => s + pinsOf[i], 0) + cutNets(group).length;
  const small = (g: number[]) =>
    options?.partCap ? g.length <= options.partCap
    : options?.portCap ? cutNets(g).length <= options.portCap && pinsWithPorts(g) <= pinCap
    : pinsWithPorts(g) <= pinCap;
  const leaves: number[][] = [];
  const looseParts = new Set<string>();
  const todo: number[][] = [[...Array(n).keys()]];
  while (todo.length) {
    const g = todo.pop()!;
    if (small(g) || g.length < 4) {
      // a group whose ports come close to its pins hides nothing from the
      // top level; its parts are better off placed there as themselves
      const pins = g.reduce((s, i) => s + pinsOf[i], 0), ports = cutNets(g).length;
      if (options?.portCap !== undefined && (g.length < 2 || ports * (options?.minCompress ?? 2) > pins)) { for (const i of g) looseParts.add(ids[i]); continue; }
      leaves.push(g);
      continue;
    }
    const halves = bisect(g);
    if (!halves) { leaves.push(g); continue; }
    todo.push(halves[0], halves[1]);
  }
  if (leaves.length === 0) return fail("nothing worth clustering");

  // ── every leaf on its own, ports on its left and right rim ──
  const blank: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }));
  const seeds = options?.seeds ?? 1;
  const leafOpts = {
    seeds,
    seedBase: options?.seedBase ?? 0,
    ...(options?.moves !== undefined ? { moves: options.moves } : {}),
    ...(options?.timeBudgetMs !== undefined ? { timeBudgetMs: options.timeBudgetMs } : {}),
    ...(options?.drilledCutsOnly ? { drilledCutsOnly: true } : {}),
    ...(options?.noWireStacking ? { noWireStacking: true } : {}),
    ...(options?.exactBest ? { exactBest: true } : {}),
    ...(options?.wasm ? { wasm: options.wasm } : {}),
  };
  interface Leaf {
    def: ComponentDef;
    comp: Component;
    rows: number; cols: number;
    placements: LayoutPlacement[];
    cuts: Cut[];
    wires: { from: { row: number; col: number }; to: { row: number; col: number } }[];
    portAsg: NetAssignment[];
  }
  const info: MacroInfo = { leaves: [], top: { parts: 0, pins: 0, ms: 0, rows: 0, cols: 0 }, loose: looseParts.size, unfolded: { conflicts: 0, incomplete: 0 }, patched: 0 };
  const solvedLeaves: Leaf[] = [];
  const privateNets = new Map<string, Net>();
  for (const [li, group] of leaves.entries()) {
    const mine = new Set(group.map((i) => ids[i]));
    const ports: Component[] = [];
    const portAsg: NetAssignment[] = [];
    const cut = cutNets(group);
    const cutSet = new Set(cut);
    for (const netId of cut) {
      const id = `${portPrefix}${li}#${netId}`;
      ports.push({
        id, defId: LEAD_DEF_ID, label: `port ${netId}`,
        schematicPos: { x: 0, y: 0 }, schematicRotation: 0,
        boardPos: null, rotation: 0, package: "wire",
      } as Component);
      portAsg.push({ netId, componentId: id, pinId: "1" });
    }
    const comps = [...blank.map((c) => (mine.has(c.id) ? c : { ...c, boardExcluded: true })), ...ports];
    const asg = [...netAssignments.filter((a) => mine.has(a.componentId)), ...portAsg];
    const leafBoard: Board = { ...board, rows: 8, cols: 8, cuts: [], wires: [], lockedRows: false, lockedCols: false };
    const t0 = Date.now();
    const res = computeAutoLayout5(leafBoard, comps, componentDefs, nets, asg,
      onProgress ? (p) => onProgress({ ...p, frac: ((li + p.frac) / leaves.length) * 0.6 }) : undefined,
      {
        ...leafOpts,
        // ports are the leaf's interface: on its left or right rim, where a
        // strip reaching them reaches the edge of the cluster
        connSidesOf: (id) => (id.startsWith(portPrefix) ? { top: false, bottom: false, left: true, right: true } : undefined),
      });
    if (!res.boardSize || res.quality > 0) return fail(`cluster ${li + 1} of ${leaves.length} could not be laid out`);
    const { rows, cols } = res.boardSize;

    // the leaf as the board sees it, for its strips
    const byPl = new Map(res.placements.map((p) => [p.componentId, p]));
    const virtual = comps.map((c) => {
      const p = byPl.get(c.id);
      return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
    });
    const leafFinal: Board = { ...board, rows, cols, cuts: res.cuts, wires: [], lockedRows: false, lockedCols: false };
    // a strip carries a net through its pins or through the wires that land
    // on it (a relay strip has no pins at all), so the net at an edge hole is
    // its connected group's, not its own segment's
    const segments = computeStripSegments(leafFinal, virtual, componentDefs, asg);
    const groups = computeConnectivity(segments, res.wires.map((w, i) => ({ id: `w${i}`, ...w })));
    const netOfSeg = new Map<number, string>();
    for (const g of groups) if (g.netIds.length) for (const si of g.segmentIndices) netOfSeg.set(si, g.netIds[0]);
    const netAt = (r: number, c: number): string | undefined => {
      const si = segments.findIndex((sg) => sg.row === r && sg.startCol <= c && c <= sg.endCol);
      return si < 0 ? undefined : netOfSeg.get(si);
    };

    // the macro's pins: the ports, where they landed
    const pins: ComponentDef["pins"] = [];
    const macroAsg: NetAssignment[] = [];
    let portsOffRim = 0;
    const portHole = new Set<string>();
    for (const a of portAsg) {
      const p = byPl.get(a.componentId);
      if (!p) return fail(`a port of cluster ${li + 1} was not placed`);
      if (p.boardPos.col !== 0 && p.boardPos.col !== cols - 1) portsOffRim++;
      pins.push({ id: a.componentId, name: a.netId, offsetRow: p.boardPos.row, offsetCol: p.boardPos.col });
      portHole.add(holeKey(p.boardPos.row, p.boardPos.col));
      macroAsg.push({ netId: a.netId, componentId: `${defPrefix}${li}`, pinId: a.componentId });
    }
    // every other edge hole that is not free copper running straight
    // through: a pin on its net, private when the net stays inside, and a
    // private pin of its own on a dead stretch the leaf has cut off, so the
    // top level neither joins it to a neighbour nor routes through it
    const rowCut = new Set(res.cuts.map((k) => k.row));
    let edgePins = 0;
    for (let r = 0; r < rows; r++) {
      for (const edge of [0, cols - 1]) {
        if (portHole.has(holeKey(r, edge))) continue;
        const net = netAt(r, edge);
        const netId = net ? (cutSet.has(net) ? net : `${netPrefix}${li}#${net}`) : rowCut.has(r) ? `${netPrefix}${li}#dead#${r}#${edge}` : undefined;
        if (!netId) continue;
        if (netId.startsWith(netPrefix) && !privateNets.has(netId)) privateNets.set(netId, { id: netId, name: netId, color: "#888888" } as Net);
        const pinId = `edge#${r}#${edge}`;
        pins.push({ id: pinId, name: "", offsetRow: r, offsetCol: edge });
        portHole.add(holeKey(r, edge));
        macroAsg.push({ netId, componentId: `${defPrefix}${li}`, pinId });
        edgePins++;
      }
    }
    const bodyCells: NonNullable<ComponentDef["bodyCells"]> = [];
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) if (!portHole.has(holeKey(r, k))) bodyCells.push({ row: r, col: k });
    const def: ComponentDef = {
      id: `${defPrefix}${li}`, name: `Cluster ${level}.${li + 1}`, category: "generic", symbol: "", defaultLabelPrefix: "M",
      width: cols, height: rows, pins, bodyCells, clearance: options?.clusterGap ?? 1, halfTurnOnly: true,
    };
    const comp = {
      id: def.id, defId: def.id, label: def.name, schematicPos: { x: 0, y: 0 }, schematicRotation: 0, boardPos: null, rotation: 0,
    } as Component;
    solvedLeaves.push({ def, comp, rows, cols, placements: res.placements.filter((p) => !p.componentId.startsWith(portPrefix)), cuts: res.cuts, wires: res.wires, portAsg: macroAsg });
    info.leaves.push({ parts: group.length, pins: pinsWithPorts(group), ports: ports.length, portsOffRim, edgePins, rows, cols, wires: res.wires.length, cuts: res.cuts.length, ms: Date.now() - t0 });
  }

  // ── the top level: clusters, connectors and pads ──
  const topDefs = [...componentDefs, ...solvedLeaves.map((l) => l.def)];
  const atTop = new Set([...edgeParts.map((e) => e.id), ...looseParts]);
  const topComps: Component[] = [
    ...blank.map((c) => (atTop.has(c.id) ? c : { ...c, boardExcluded: true })),
    ...solvedLeaves.map((l) => l.comp),
  ];
  const topAsg: NetAssignment[] = [
    ...netAssignments.filter((a) => atTop.has(a.componentId)),
    ...solvedLeaves.flatMap((l) => l.portAsg),
  ];
  const topNets: Net[] = [...nets, ...privateNets.values()];
  const t1 = Date.now();
  const topProgress = onProgress ? (p: AutoLayoutProgress) => onProgress({ ...p, frac: 0.6 + p.frac * 0.35 }) : undefined;
  // more levels to go: the clusters are the parts of the next clustering
  const top = level < levels
    ? computeAutoLayout5Macro({ ...board, cuts: [], wires: [] }, topComps, topDefs, topNets, topAsg, topProgress,
        { ...options, pinCap, level: level + 1, partCap: options?.upperPartCap ?? 3, onInfo: undefined })
    : computeAutoLayout5({ ...board, cuts: [], wires: [] }, topComps, topDefs, topNets, topAsg, topProgress,
        {
          seeds,
          seedBase: options?.seedBase ?? 0,
          ...(options?.topMoves !== undefined ? { moves: options.topMoves } : {}),
          ...(options?.topTimeBudgetMs !== undefined ? { timeBudgetMs: options.topTimeBudgetMs } : {}),
          ...(options?.drilledCutsOnly ? { drilledCutsOnly: true } : {}),
          ...(options?.noWireStacking ? { noWireStacking: true } : {}),
          ...(options?.exactBest ? { exactBest: true } : {}),
          ...(options?.wasm ? { wasm: options.wasm } : {}),
        });
  if (!top.boardSize || top.quality > 0) return fail("the clusters could not be laid out together");
  info.top = { parts: topComps.filter((c) => !c.boardExcluded).length, pins: topAsg.length, ms: Date.now() - t1, rows: top.boardSize.rows, cols: top.boardSize.cols };

  // ── unfold the clusters into the result ──
  const placements: LayoutPlacement[] = [];
  const cuts: Cut[] = [];
  const wires: AutoLayoutResult["wires"] = [];
  const footprints: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const l of solvedLeaves) {
    const at = top.placements.find((p) => p.componentId === l.comp.id);
    if (!at) return fail(`${l.def.name} was not placed`);
    const flip = (at.rotation ?? 0) === 180;
    const R0 = at.boardPos.row, C0 = at.boardPos.col;
    const H = l.rows, W = l.cols;
    const map = (q: { row: number; col: number }) => (flip ? { row: R0 + H - 1 - q.row, col: C0 + W - 1 - q.col } : { row: R0 + q.row, col: C0 + q.col });
    footprints.push({ r0: R0, r1: R0 + H - 1, c0: C0, c1: C0 + W - 1 });
    for (const p of l.placements) {
      const comp = components.find((c) => c.id === p.componentId);
      const def = comp ? resolveComponentDef(comp, componentDefs) : undefined;
      if (!def || def.flexible) {
        placements.push({ componentId: p.componentId, boardPos: map(p.boardPos), ...(p.flexibleEndPos ? { flexibleEndPos: map(p.flexibleEndPos) } : {}) });
        continue;
      }
      // under a half turn the part's pins mirror; its new origin is whatever
      // puts its first pin, at the turned rotation, on that mirrored hole
      const rot0 = (p.rotation ?? 0) as 0 | 90 | 180 | 270;
      const rot1 = (flip ? (rot0 + 180) % 360 : rot0) as 0 | 90 | 180 | 270;
      let origin = map(p.boardPos);
      if (flip) {
        const was = getRotatedPinPositions(def, p.boardPos, rot0)[0];
        const now = getRotatedPinPositions(def, { row: 0, col: 0 }, rot1)[0];
        if (was && now) { const t = map(was); origin = { row: t.row - now.row, col: t.col - now.col }; }
      }
      placements.push({ componentId: p.componentId, boardPos: origin, rotation: rot1 as LayoutPlacement["rotation"] });
    }
    const mapCut = (k: Cut): Cut => {
      if (k.kind === "hole") return { ...k, ...map(k) };
      // a knife cut between c and c+1 mirrors to between W-2-c and W-1-c
      return flip ? { ...k, row: R0 + H - 1 - k.row, col: C0 + W - 2 - k.col } : { ...k, row: R0 + k.row, col: C0 + k.col };
    };
    for (const k of l.cuts) cuts.push(mapCut(k));
    for (const w of l.wires) wires.push({ from: map(w.from), to: map(w.to) });
  }
  const inside = (k: Cut) => footprints.some((f) => k.row >= f.r0 && k.row <= f.r1 && (k.kind === "hole" ? k.col >= f.c0 && k.col <= f.c1 : k.col >= f.c0 && k.col + 1 <= f.c1));
  const mine = new Set(solvedLeaves.map((l) => l.comp.id));
  for (const p of top.placements) if (!mine.has(p.componentId)) placements.push(p);
  for (const k of top.cuts) if (!inside(k)) cuts.push(k);
  for (const w of top.wires) wires.push(w);
  const rows = top.boardSize.rows, cols = top.boardSize.cols;
  const finalBoard: Board = { ...board, rows, cols, cuts: [], wires: [], lockedRows: false, lockedCols: false };

  // ── what the top level could not know: strips sealed inside a cluster ──
  const byPl = new Map(placements.map((p) => [p.componentId, p]));
  const virtual = blank.map((c) => {
    const p = byPl.get(c.id);
    return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : { ...c, boardExcluded: true };
  });
  const inBounds = (k: Cut) => k.row >= 0 && k.row < rows && k.col >= 0 && k.col < cols && (k.kind === "hole" || k.col + 1 < cols);
  let allCuts = cuts.filter(inBounds);
  let allWires = wires;
  const check = () => {
    const segs = computeStripSegments({ ...finalBoard, cuts: allCuts }, virtual, componentDefs, netAssignments);
    const conn = computeConnectivity(segs, allWires.map((w, i) => ({ id: `w${i}`, ...w })));
    return { conflicts: conn.filter((g) => g.hasConflict).length, incomplete: checkNetCompleteness(nets, netAssignments, segs, conn, virtual, componentDefs).length };
  };
  let v = check();
  info.unfolded = { ...v };
  if (v.incomplete > 0 || v.conflicts > 0) {
    const plan = deriveCompletion({ ...finalBoard, cuts: allCuts, wires: allWires.map((w, i) => ({ id: `w${i}`, ...w })) }, virtual, componentDefs, nets, netAssignments, {
      allowSharedJoints: false,
      ...(options?.drilledCutsOnly ? { drilledCutsOnly: true } : {}),
      strictWires: true,
      ...(options?.noWireStacking ? { noWireStacking: true } : {}),
    });
    // the completion keeps what the board has and returns only what it adds
    info.patched = plan.wires.length;
    allCuts = [...allCuts, ...plan.cuts];
    allWires = [...allWires, ...plan.wires];
    v = check();
  }
  const issues: string[] = [];
  if (v.conflicts > 0) issues.push(`${v.conflicts} strip conflicts remain`);
  if (v.incomplete > 0) issues.push(`${v.incomplete} nets incomplete`);
  const result: AutoLayoutResult = {
    placements, cuts: allCuts, wires: allWires, issues,
    quality: v.conflicts * 100 + v.incomplete,
    starvedNetIds: [],
    boardSize: { rows, cols },
    unplaceIds: components.filter((c) => c.boardExcluded).map((c) => c.id),
  };
  const mess = wireMessScore(result, virtual, componentDefs);
  if (mess.crossings > 0) issues.push(`${mess.crossings} wires cross a part`);
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 1 });
  options?.onInfo?.(info);
  return result;
}
