import { Board, BoardPosition, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getRotatedPinPositions } from "./boardLayout";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { Rot, allowedDrows } from "./layout2/tileModel";
import { bodiesTooClose, bodyIntersectsRect, clearanceOf, segmentsIntersect, wireStackDepth } from "./flexGeometry";
import { alignCuts } from "./layout2/alignCuts";
import { padAroundEdgeConnectors } from "./layout2/edgePadding";
import { drillRemainingCuts } from "./autoFinish";
import { Chooser } from "./layout2/chooser";
import { compactPlacements } from "./layout2/compaction";
import { insertWireChannels } from "./layout2/channelPass";
import { repairSlantWires } from "./layout2/slantRepairPass";
import { trimResult } from "./layout2/trimResult";
import { wireMessScore } from "./layout2/tidyScore";
import { rateResult } from "./autoLayout2";
import { pinKey } from "./keys";

// ── The v5 "skeleton + exact decoder" layouter (beta) ──
//
// Simulated annealing over a purely discrete skeleton: a sequence pair over
// all parts, per-flex orientation (horizontal/vertical) and branch bits,
// per-rigid rotation, and per-net pin groups (a group aspires to one copper
// run). Every skeleton decodes exactly: row coordinates come from a
// difference-constraint solve (group equalities via weighted union-find,
// span windows, sequence-pair separations, locked pins), column coordinates
// from a longest-path compaction, and cuts/segments/link wires are read off
// the decoded grid with realizability-aware pricing. Off-axis and crossing
// wires are priced as a last resort on a geometric ramp synchronized with
// cooling. The best skeleton runs through the real completion pipeline
// (route, compact, channels, slant repair).

export interface AutoLayout5Options {
  // Seed portfolio size (default 6): independent anneals, best final board
  // wins on (validity, off-axis + crossings, rating)
  seeds?: number;
  // Anneal budget per seed (default: scaled with part count)
  moves?: number;
  // Run exactly this one seed (parallel portfolio: the editor spreads seed
  // indices over workers and compares the finished boards)
  seedIndex?: number;
  // First seed of the portfolio (default 0): seeds seedBase .. seedBase+seeds-1
  seedBase?: number;
  // Board edges a connector may count as "on the edge" (default all four);
  // a split half excludes its seam side, which ends up in the interior
  connSides?: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  // Only sever strips by drilling holes: knife cuts the drill upgrade
  // cannot absorb are priced in the skeleton and the finish
  drilledCutsOnly?: boolean;
  // No wire may run on top of another in one channel
  noWireStacking?: boolean;
  // Harness-only: log each seed's decoded best (never set by the UI)
  debugSeeds?: boolean;
  // Harness-only landscape instrumentation (never set by the UI): trace is
  // called once per 1% of the anneal with window statistics, probe once per
  // seed after the anneal with the engine closures
  trace?: (rec: LandscapeTrace) => void;
  probe?: (api: LandscapeProbe) => void;
  // Harness-only schedule overrides for annealing experiments
  schedule?: { t0?: number; t0Scale?: number; tEnd?: number; rampStart?: number; rampEndFrac?: number; hardStart?: number; coldT?: number };
}

export interface LandscapeTrace {
  seed: number; it: number; T: number; w: number;
  cur: number; best: number; curFin: number;
  acc: number; accUp: number; up: number; nulls: number; infeasible: number;
  H: number; W: number;
}
export interface LandscapeProbe {
  seed: number;
  best: { E: number; g: unknown; d: unknown };
  decode: (g: unknown) => unknown;
  mutate: (g: unknown, rng: () => number) => unknown;
  initGenome: (rng: () => number) => unknown;
  cloneG: (g: unknown) => unknown;
  price: (d: unknown, w: number) => number;
  t0: number;
  W_MESS: number;
}

const W_AREA = 0.35;
const W_WIRE = 4;       // per link wire
const W_WLEN = 0.4;     // per row of wire length
const W_CUT = 0.05;     // cuts are nearly free
const W_BCUT = 2;       // between-holes cuts stay visibly priced
const W_BCUT_DRILL = 8; // a knife cut under drilled-cuts-only, about a wire
const W_MESS = 400;     // final price per off-axis or crossing wire
const W_TALL = 2;       // rows of cells each row beyond the board width costs
const RAMP_START = 25;  // their price while the skeleton forms
const T_START = 150;    // anneal start temperature (see solveSeed)
const W_LOCKOVER = 150; // per line over a locked dimension
const ROTS: Rot[] = [0, 90, 180, 270];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RigidShape {
  w: number;
  h: number;
  dRow: number;
  dCol: number;
  pins: { pinId: string; net: number | undefined; rowOff: number; colOff: number }[];
}

interface RigidPart {
  kind: "rigid";
  comp: Component;
  def: ComponentDef;
  locked: boolean;
  isConn: boolean;
  shapes: Map<Rot, RigidShape>;
}

interface FlexPart {
  kind: "flex";
  comp: Component;
  def: ComponentDef;
  locked: boolean;
  isConn: boolean;
  pinIds: [string | undefined, string | undefined];
  na: number | undefined;
  nb: number | undefined;
  minS: number;
  maxS: number;
  vdSet: Set<number>;
  canV: boolean;
  canH: boolean;
  dc0: number;
}

type Part = RigidPart | FlexPart;

interface Genome {
  gp: number[];
  gn: number[];
  rot: number[];
  hv: number[];
  br: number[];
  grp: number[][];
  // extra blank rows kept below a part (bus-row supply) and blank columns
  // kept right of it (attachment holes beside pins): slack the compaction
  // would otherwise squeeze out
  gap: number[];
  xgap: number[];
}

interface Decoded {
  eBase: number;
  hardPen: number;
  // which margin lines the skeleton's wiring attached to: the finish must
  // keep the padding outside a flush connector on those sides
  marginUsed: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  slants: number;
  crossings: number;
  H: number;
  W: number;
  yI: Int32Array;
  xI: Int32Array;
  geo: { w: number; h: number; sh?: RigidShape; mode?: "H" | "V" }[];
  vBot: Map<number, number>;
  dbg?: Record<string, number | string[]>;
}

export function computeAutoLayout5(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout5Options
): AutoLayoutResult {
  const report = (phase: AutoLayoutProgress["phase"], frac: number) =>
    onProgress?.({ phase, attempt: 1, maxAttempts: 1, frac });

  const netIdx = new Map(nets.map((n, i) => [n.id, i]));
  const netByPin = new Map(netAssignments.map((a) => [a.componentId + ":" + a.pinId, netIdx.get(a.netId)]));

  // ── model ──
  const parts: Part[] = [];
  const skipped: Component[] = [];
  for (const c of components) {
    if (c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) {
      skipped.push(c);
      continue;
    }
    const locked = !!(c.locked && c.boardPos);
    const isConn = def.category === "connector";
    if (def.flexible) {
      const p0 = def.pins[0];
      const p1 = def.pins[1];
      const na = p0 !== undefined ? netByPin.get(c.id + ":" + p0.id) : undefined;
      const nb = p1 !== undefined ? netByPin.get(c.id + ":" + p1.id) : undefined;
      const D = allowedDrows(def);
      const vd = [...D.entries()].filter(([dr, dc]) => dr >= 1 && dc === 0).map(([dr]) => dr);
      const dc0 = D.get(0);
      if (vd.length === 0 && dc0 === undefined) {
        skipped.push(c);
        continue;
      }
      parts.push({
        kind: "flex", comp: c, def, locked, isConn,
        pinIds: [p0?.id, p1?.id], na, nb,
        minS: vd.length ? Math.min(...vd) : 0,
        maxS: vd.length ? Math.max(...vd) : 0,
        vdSet: new Set(vd),
        canV: vd.length > 0, canH: dc0 !== undefined, dc0: dc0 ?? 0,
      });
    } else {
      const shapes = new Map<Rot, RigidShape>();
      for (const rot of ROTS) {
        const b0 = getComponentBounds(def, { row: 0, col: 0 }, rot);
        const pins: RigidShape["pins"] = [];
        for (const p of getRotatedPinPositions(def, { row: 0, col: 0 }, rot)) {
          pins.push({ pinId: p.pinId, net: netByPin.get(c.id + ":" + p.pinId), rowOff: p.row - b0.minRow, colOff: p.col - b0.minCol });
        }
        shapes.set(rot, { w: b0.maxCol - b0.minCol + 1, h: b0.maxRow - b0.minRow + 1, dRow: b0.minRow, dCol: b0.minCol, pins });
      }
      parts.push({ kind: "rigid", comp: c, def, locked, isConn, shapes });
    }
  }
  const nP = parts.length;
  const flexIdx = parts.map((p, i) => (p.kind === "flex" ? i : -1)).filter((i) => i >= 0);
  const rigidIdx = parts.map((p, i) => (p.kind === "rigid" ? i : -1)).filter((i) => i >= 0);

  const emptyResult = (issues: string[]): AutoLayoutResult => ({
    placements: [], cuts: [], wires: [], issues, quality: skipped.length * 2,
    starvedNetIds: [], unplaceIds: skipped.map((c) => c.id),
  });
  if (nP === 0) return emptyResult(skipped.length ? ["no placeable components"] : []);

  const netPins: { pi: number; kind: "flex" | "rigid"; end?: number; pinId?: string }[][] = nets.map(() => []);
  parts.forEach((p, pi) => {
    if (p.kind === "flex") {
      if (p.na !== undefined) netPins[p.na].push({ pi, kind: "flex", end: 0 });
      if (p.nb !== undefined) netPins[p.nb].push({ pi, kind: "flex", end: 1 });
    } else {
      for (const sp of p.shapes.get(0)!.pins) {
        if (sp.net !== undefined) netPins[sp.net].push({ pi, kind: "rigid", pinId: sp.pinId });
      }
    }
  });

  const lockedColsCap = board.lockedCols ? board.cols : undefined;
  const lockedRowsCap = board.lockedRows ? board.rows : undefined;
  const seedsN = Math.max(1, options?.seeds ?? 6);
  const movesN = options?.moves ?? Math.min(160000, Math.max(60000, 3200 * nP));
  const wBCut = options?.drilledCutsOnly ? W_BCUT_DRILL : W_BCUT;
  const anyLockedPart = parts.some((p) => p.locked);
  // free board lines a flexible body keeps to any neighbour (def setting)
  const clrOf = parts.map((p) => (p.kind === "flex" ? clearanceOf(p.def) : 0));
  const clrPad = 2 + Math.max(0, ...clrOf);
  const connSides = options?.connSides ?? { top: true, bottom: true, left: true, right: true };
  const mCol = anyLockedPart || lockedColsCap !== undefined ? 0 : 1;
  const mRow = anyLockedPart || lockedRowsCap !== undefined ? 0 : 1;

  // ── genotype ──
  const initGenome = (rng: () => number): Genome => {
    const shuffle = (a: number[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    return {
      gp: shuffle([...Array(nP).keys()]),
      gn: shuffle([...Array(nP).keys()]),
      rot: rigidIdx.map(() => 0),
      hv: flexIdx.map(() => 0),
      br: flexIdx.map(() => 0),
      grp: netPins.map((pins) => pins.map(() => 0)),
      gap: parts.map(() => 0),
      xgap: parts.map(() => 0),
    };
  };
  const cloneG = (g: Genome): Genome => ({
    gp: g.gp.slice(), gn: g.gn.slice(), rot: g.rot.slice(),
    hv: g.hv.slice(), br: g.br.slice(), grp: g.grp.map((a) => a.slice()), gap: g.gap.slice(), xgap: g.xgap.slice(),
  });
  const rotOfPart = (g: Genome, pi: number): Rot => {
    const p = parts[pi];
    if (p.locked) return (ROTS as number[]).includes(p.comp.rotation) ? (p.comp.rotation as Rot) : 0;
    return ROTS[g.rot[rigidIdx.indexOf(pi)] ?? 0];
  };
  const flexBit = (arr: number[], pi: number) => arr[flexIdx.indexOf(pi)];

  // ── decoder ──
  // constraint-graph edge buffers, sized for the largest graph a decode
  // can build (every ordered pair at most once, plus source, span and
  // locked-pin edges); reused across decodes
  const maxE = nP + flexIdx.length + 1 + 2 * flexIdx.length + Math.ceil((nP * nP) / 2) + 2 * nP + 8;
  const eU = new Int32Array(maxE), eV = new Int32Array(maxE), eW = new Float64Array(maxE);
  const rU = new Int32Array(maxE), rV = new Int32Array(maxE), rW = new Float64Array(maxE), rRank = new Int32Array(maxE);
  const ordBuf = new Int32Array(maxE), rankCnt = new Int32Array(2 * nP + 4);
  const xU = new Int32Array(maxE), xV = new Int32Array(maxE), xW = new Float64Array(maxE);
  const vBotArr = new Int32Array(nP);
  // Prim key buffers: a net has at most one segment per pin
  const maxK = Math.max(1, ...netPins.map((pins) => pins.length));
  const kTotal = new Float64Array(maxK), kA = new Int32Array(maxK), kCross = new Int32Array(maxK);
  const kLen = new Int32Array(maxK), kCol = new Int32Array(maxK), kOff = new Uint8Array(maxK);
  const linkCount = new Int32Array(maxK), inTree = new Uint8Array(maxK);
  const kRow = new Int32Array(maxK), kCA = new Int32Array(maxK), kCB = new Int32Array(maxK);
  // per-decode scratch grids, grown on demand and cleared over the used
  // prefix only (a fresh allocation per decode was a tenth of the run)
  let gridCap = 0;
  let occBuf = new Int8Array(0), ownerBuf = new Int16Array(0), pinNetBuf = new Int32Array(0);
  let usedBuf = new Uint8Array(0), bodyPreBuf = new Int32Array(0), hopBuf = new Int32Array(0);
  const ensureGrid = (n: number) => {
    if (n <= gridCap) return;
    gridCap = Math.max(n, gridCap * 2);
    occBuf = new Int8Array(gridCap);
    ownerBuf = new Int16Array(gridCap);
    pinNetBuf = new Int32Array(gridCap);
    usedBuf = new Uint8Array(gridCap);
    bodyPreBuf = new Int32Array(gridCap);
  };
  function decode(g: Genome): Decoded | null {
    const posP = new Int32Array(nP), posN = new Int32Array(nP);
    g.gp.forEach((p, i) => (posP[p] = i));
    g.gn.forEach((p, i) => (posN[p] = i));

    const geo = parts.map((p, pi) => {
      if (p.kind === "rigid") {
        const sh = p.shapes.get(rotOfPart(g, pi))!;
        return { w: sh.w, h: sh.h, sh };
      }
      const mode: "H" | "V" = flexBit(g.hv, pi) === 1 && p.canH ? "H" : "V";
      return mode === "H" ? { w: p.dc0 + 1, h: 1, mode } : { w: 1, h: 0, mode };
    });

    const vBot = new Map<number, number>();
    let nNode = nP;
    for (const pi of flexIdx) if (geo[pi].mode === "V") vBot.set(pi, nNode++);
    const SRC = nNode++;

    const pinYExpr = (pin: { pi: number; kind: string; end?: number; pinId?: string }): [number, number] => {
      const p = parts[pin.pi];
      if (pin.kind === "rigid") {
        const sh = geo[pin.pi].sh!;
        const sp = sh.pins.find((x) => x.pinId === pin.pinId)!;
        return [pin.pi, sp.rowOff];
      }
      if (geo[pin.pi].mode === "H") return [pin.pi, 0];
      const isTop = (pin.end === 0) === (flexBit(g.br, pin.pi) === 0);
      return [isTop ? pin.pi : vBot.get(pin.pi)!, 0];
    };

    // optimistic: the part's own clearance below it; real pair clearances
    // are checked EXACTLY at decoded coordinates (bodiesTooClose /
    // bodyIntersectsRect) and priced. Independent of the part below, which
    // the nearest-successor edge pruning relies on.
    const vgapOf = (i: number, _j: number) => Math.max(1, clrOf[i]);

    let nE = 0;
    const addE = (u: number, v: number, w: number) => {
      eU[nE] = u;
      eV[nE] = v;
      eW[nE] = w;
      nE++;
    };
    for (let i = 0; i < nNode - 1; i++) addE(SRC, i, 0);
    for (const pi of flexIdx) {
      if (geo[pi].mode !== "V") continue;
      const p = parts[pi] as FlexPart;
      const b = vBot.get(pi)!;
      addE(pi, b, p.minS);
      addE(b, pi, -p.maxS);
    }
    vBotArr.fill(-1);
    for (const [pi, b2] of vBot) vBotArr[pi] = b2;
    for (let i = 0; i < nP; i++) {
      if (parts[i].locked) continue;
      // the part's bottom node and its offset: a V flex ends at its bottom
      // pin node, anything else at its own node plus its height
      const bu = vBotArr[i] >= 0 ? vBotArr[i] : i;
      const w0 = (vBotArr[i] >= 0 ? 0 : geo[i].h - 1) + vgapOf(i, 0) + g.gap[i];
      const pi_ = posP[i], ni = posN[i];
      // nearest successors only: any other part below i is reached through
      // one of them with at least this edge's weight (the weight does not
      // depend on j), so the longest paths are the same with far fewer edges
      let seen = -1;
      for (let q = pi_ + 1; q < nP; q++) {
        const j = g.gp[q];
        const nj = posN[j];
        if (nj > ni || parts[j].locked) continue;
        if (nj < seen) continue;
        seen = nj;
        addE(bu, j, w0);
      }
    }
    const lockedY = new Map<number, number>();
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked) continue;
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        lockedY.set(pi, p.comp.boardPos!.row + sh.dRow);
      } else {
        const bp = p.comp.boardPos!;
        const ep = p.comp.flexibleEndPos ?? bp;
        lockedY.set(pi, Math.min(bp.row, ep.row));
        if (vBot.has(pi)) lockedY.set(vBot.get(pi)!, Math.max(bp.row, ep.row));
      }
    }
    for (const [n, v] of lockedY) {
      addE(SRC, n, v);
      addE(n, SRC, -v);
    }

    // group equalities via weighted union-find; conflicts split the pin out
    // of its group persistently (genotype write-back)
    // node rank along the first sequence (source first, a flex part's
    // bottom right after its top): the relaxation order of the y-solve
    const rankOf = new Int32Array(nNode);
    for (let pi = 0; pi < nP; pi++) rankOf[pi] = 2 * posP[pi] + 1;
    for (const [pi, b2] of vBot) rankOf[b2] = 2 * posP[pi] + 2;
    const dist = new Float64Array(nNode).fill(-1e18);
    const walkSeen = new Int32Array(nNode);
    let walkStamp = 0;
    let solved = false;
    for (let attempt = 0; attempt < 400 && !solved; attempt++) {
      const parent = new Int32Array(nNode);
      const poff = new Int32Array(nNode);
      for (let i = 0; i < nNode; i++) parent[i] = i;
      const find = (v0: number): [number, number] => {
        let v = v0, off = 0;
        while (parent[v] !== v) {
          off += poff[v];
          v = parent[v];
        }
        return [v, off];
      };
      const members = new Map<number, { net: number; k: number }[]>();
      let conflict: { net: number; k: number } | "hard" | null = null;
      for (let n = 0; n < nets.length && !conflict; n++) {
        const pins = netPins[n];
        const anchorOf = new Map<number, number>();
        for (let k = 0; k < pins.length; k++) {
          const gl = g.grp[n][k];
          if (!anchorOf.has(gl)) {
            anchorOf.set(gl, k);
            continue;
          }
          const [u, ou] = pinYExpr(pins[anchorOf.get(gl)!]);
          const [v, ov] = pinYExpr(pins[k]);
          const [ru, du] = find(u);
          const [rv, dv] = find(v);
          if (ru === rv) {
            if (du + ou !== dv + ov) g.grp[n][k] = Math.max(...g.grp[n]) + 1;
            continue;
          }
          parent[rv] = ru;
          poff[rv] = du + ou - dv - ov;
          const mu = members.get(ru) ?? [];
          const mv = members.get(rv);
          if (mv) {
            mu.push(...mv);
            members.delete(rv);
          }
          mu.push({ net: n, k });
          members.set(ru, mu);
        }
      }
      const rootArr = new Int32Array(nNode), offArr = new Int32Array(nNode);
      for (let v = 0; v < nNode; v++) {
        const [r, o] = find(v);
        rootArr[v] = r;
        offArr[v] = o;
      }
      let nR = 0;
      for (let ei = 0; ei < nE; ei++) {
        const ru = rootArr[eU[ei]], rv = rootArr[eV[ei]];
        const w = eW[ei] + offArr[eU[ei]] - offArr[eV[ei]];
        if (ru === rv) {
          if (w > 0 && !conflict) {
            const mm = members.get(ru);
            conflict = mm && mm.length ? mm[mm.length - 1] : "hard";
          }
          continue;
        }
        rU[nR] = ru;
        rV[nR] = rv;
        rW[nR] = w;
        rRank[nR] = rankOf[eU[ei]];
        nR++;
      }
      if (conflict) {
        if (conflict === "hard") return null;
        g.grp[conflict.net][conflict.k] = Math.max(...g.grp[conflict.net]) + 1;
        continue;
      }
      // relax in first-sequence order: every SP edge points down that
      // sequence, so a feasible graph settles in a few sweeps
      const ord = ordBuf, cnt = rankCnt;
      cnt.fill(0);
      for (let ei = 0; ei < nR; ei++) cnt[rRank[ei] + 1]++;
      for (let b2 = 1; b2 < cnt.length; b2++) cnt[b2] += cnt[b2 - 1];
      for (let ei = 0; ei < nR; ei++) ord[cnt[rRank[ei]]++] = ei;
      dist.fill(-1e18);
      dist[SRC] = 0;
      const pred = new Int32Array(nNode).fill(-1);
      let changed = false, lastEdge = -1, cycleAt = -1;
      for (let it = 0; it < nNode + 2; it++) {
        changed = false;
        for (let k = 0; k < nR; k++) {
          const ei = ord[k];
          const u = rU[ei], v = rV[ei];
          if (dist[u] + rW[ei] > dist[v] + 1e-9) {
            dist[v] = dist[u] + rW[ei];
            pred[v] = ei;
            changed = true;
            lastEdge = ei;
          }
        }
        if (!changed) break;
        // a positive cycle closes the predecessor walk long before the
        // round bound would prove it: stop at the first closed walk
        if (it >= 2) {
          walkStamp++;
          let cur = rV[lastEdge];
          for (let s2 = 0; s2 <= nNode; s2++) {
            if (walkSeen[cur] === walkStamp) {
              cycleAt = cur;
              break;
            }
            walkSeen[cur] = walkStamp;
            const ei = pred[cur];
            if (ei < 0) break;
            cur = rU[ei];
          }
          if (cycleAt >= 0) break;
        }
      }
      if (!changed) {
        for (let v = 0; v < nNode; v++) dist[v] = dist[rootArr[v]] + offArr[v];
        solved = true;
        break;
      }
      let cur = cycleAt >= 0 ? cycleAt : rV[lastEdge];
      for (let s = 0; s < nNode + 2; s++) {
        const ei = pred[cur];
        if (ei < 0) break;
        cur = rU[ei];
      }
      let fixed = false;
      const start = cur;
      for (let s = 0; s < nNode + 2 && !fixed; s++) {
        const mm = members.get(cur);
        if (mm && mm.length) {
          const m = mm[mm.length - 1];
          g.grp[m.net][m.k] = Math.max(...g.grp[m.net]) + 1;
          fixed = true;
          break;
        }
        const ei = pred[cur];
        if (ei < 0) break;
        cur = rU[ei];
        if (cur === start) break;
      }
      if (!fixed) return null;
    }
    if (!solved) return null;
    const y = dist;

    // x: SP left edges + locked pins; longest path
    const XS = nP;
    let nX = 0;
    const addX = (u: number, v: number, w: number) => {
      xU[nX] = u;
      xV[nX] = v;
      xW[nX] = w;
      nX++;
    };
    for (let i = 0; i < nP; i++) addX(XS, i, 0);
    const hgap = (i: number, j: number) => {
      const fi = parts[i].kind === "flex", fj = parts[j].kind === "flex";
      if (fi && fj) return 1 + Math.max(1, clrOf[i], clrOf[j]);
      if (!fi && !fj) {
        // a free col is only needed when the FACING edges both carry pins
        // (cut-apart one-hole segments starve the router)
        const shL = geo[i].sh!, shR = geo[j].sh!;
        const rPins = shL.pins.some((p2) => p2.colOff === shL.w - 1 && p2.net !== undefined);
        const lPins = shR.pins.some((p2) => p2.colOff === 0 && p2.net !== undefined);
        return rPins && lPins ? 2 : 1;
      }
      const f = fi ? i : j;
      return geo[f].mode === "V" ? 1 + Math.max(1, clrOf[f]) : 1;
    };
    // edges in first-sequence order, so the sweep below settles fast
    for (let r = 0; r < nP; r++) {
      const i = g.gp[r];
      if (parts[i].locked) continue;
      const ti = y[i], bi = vBotArr[i] >= 0 ? y[vBotArr[i]] : ti + geo[i].h - 1;
      const pi_ = posP[i], ni = posN[i];
      for (let q = pi_ + 1; q < nP; q++) {
        const j = g.gp[q];
        if (ni > posN[j] || parts[j].locked) continue;
        const tj = y[j], bj = vBotArr[j] >= 0 ? y[vBotArr[j]] : tj + geo[j].h - 1;
        const margin = vgapOf(i, j) >= 2 ? 1.5 : 0.5;
        if (!(bi < tj - margin || bj < ti - margin)) addX(i, j, geo[i].w - 1 + hgap(i, j) + g.xgap[i]);
      }
    }
    const lockedX = new Map<number, number>();
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked) continue;
      if (p.kind === "rigid") lockedX.set(pi, p.comp.boardPos!.col + geo[pi].sh!.dCol);
      else {
        const bp = p.comp.boardPos!;
        const ep = p.comp.flexibleEndPos ?? bp;
        lockedX.set(pi, Math.min(bp.col, ep.col));
      }
    }
    for (const [n, v] of lockedX) {
      addX(XS, n, v);
      addX(n, XS, -v);
    }
    const xd = new Float64Array(nP + 1).fill(-1e18);
    xd[XS] = 0;
    let xOK = true;
    for (let it = 0; it < nP + 3; it++) {
      let ch = false;
      for (let ei = 0; ei < nX; ei++) {
        const u = xU[ei], v = xV[ei];
        if (xd[u] + xW[ei] > xd[v] + 1e-9) {
          xd[v] = xd[u] + xW[ei];
          ch = true;
        }
      }
      if (!ch) {
        xOK = true;
        break;
      }
      xOK = false;
    }
    if (!xOK) return null;

    const yI = new Int32Array(nNode), xI = new Int32Array(nP);
    for (let i = 0; i < nNode - 1; i++) yI[i] = Math.round(y[i]);
    for (let i = 0; i < nP; i++) xI[i] = Math.round(xd[i]);

    // ── grid + exact measurement ──
    let H = 0, W = 0;
    for (let pi = 0; pi < nP; pi++) {
      const bot = geo[pi].mode === "V" ? yI[vBot.get(pi)!] : yI[pi] + geo[pi].h - 1;
      H = Math.max(H, bot + 1);
      W = Math.max(W, xI[pi] + geo[pi].w);
    }
    // the grid carries one blank line of margin on every free side: the
    // finish pads the route board the same way, so edge segments really do
    // have an attachment hole there and the rim rows serve as bus rows
    const GH = H + 2 * mRow, GW = W + 2 * mCol;
    ensureGrid((GH + 1) * GW);
    const occ = occBuf.fill(0, 0, GH * GW);
    const owner = ownerBuf.fill(-1, 0, GH * GW);
    const pinNetAt = pinNetBuf.fill(-1, 0, GH * GW);
    const at = (r: number, c: number) => r * GW + c;
    let overlapBad = 0;
    const claim = (r: number, c: number, v: number, net: number | undefined, pi: number) => {
      if (r < 0 || c < 0 || r >= H || c >= W) {
        overlapBad++;
        return;
      }
      const i = at(r + mRow, c + mCol);
      if (occ[i] !== 0 && owner[i] !== pi) overlapBad++;
      if (v === 2 || occ[i] === 0) {
        occ[i] = v;
        owner[i] = pi;
        if (v === 2 && net !== undefined && net >= 0) pinNetAt[i] = net;
      }
    };
    // a pin without a net still breaks the strip it sits on (the router
    // isolates floating pins), so it claims a private pseudo-net: the cuts
    // it forces get counted and the copper beyond it no longer joins nets
    let floatNet = nets.length;
    const lockedBoxes: { r1: number; r2: number; c1: number; c2: number }[] = [];
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.locked || p.kind !== "rigid") continue;
      const sh = geo[pi].sh!;
      lockedBoxes.push({ r1: yI[pi], r2: yI[pi] + sh.h - 1, c1: xI[pi], c2: xI[pi] + sh.w - 1 });
    }
    const flexCellBad = (r: number, c: number, mode: "H" | "V") => {
      for (const b of lockedBoxes) {
        const inRing = r >= b.r1 - 1 && r <= b.r2 + 1 && c >= b.c1 - 1 && c <= b.c2 + 1;
        if (!inRing) continue;
        if (mode === "V" && r >= b.r1 && r <= b.r2) return true;
        if (mode === "H" && c >= b.c1 && c <= b.c2) return true;
        if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) return true;
      }
      return false;
    };
    let ringBad = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (p.kind === "rigid") {
        const sh = geo[pi].sh!;
        for (let r = 0; r < sh.h; r++) for (let c = 0; c < sh.w; c++) claim(yI[pi] + r, xI[pi] + c, 1, undefined, pi);
        for (const sp of sh.pins) claim(yI[pi] + sp.rowOff, xI[pi] + sp.colOff, 2, sp.net ?? floatNet++, pi);
      } else if (geo[pi].mode === "H") {
        for (let c = 0; c <= p.dc0; c++) {
          if (c > 0 && c < p.dc0) claim(yI[pi], xI[pi] + c, 1, undefined, pi);
          if (flexCellBad(yI[pi], xI[pi] + c, "H")) ringBad++;
        }
        const brBit = flexBit(g.br, pi);
        claim(yI[pi], xI[pi], 2, (brBit === 0 ? p.na : p.nb) ?? floatNet++, pi);
        claim(yI[pi], xI[pi] + p.dc0, 2, (brBit === 0 ? p.nb : p.na) ?? floatNet++, pi);
      } else {
        const t = yI[pi], b = yI[vBot.get(pi)!];
        for (let r = t; r <= b; r++) {
          if (r > t && r < b) claim(r, xI[pi], 1, undefined, pi);
          if (flexCellBad(r, xI[pi], "V")) ringBad++;
        }
        const brBit = flexBit(g.br, pi);
        claim(t, xI[pi], 2, (brBit === 0 ? p.na : p.nb) ?? floatNet++, pi);
        claim(b, xI[pi], 2, (brBit === 0 ? p.nb : p.na) ?? floatNet++, pi);
      }
    }

    // runs, cuts, segments per row
    let cuts = 0, bCuts = 0;
    const segsOfNet = new Map<number, { row: number; c1: number; c2: number }[]>();
    // pin-free rows are bus rows: copper a net may claim over a span to
    // travel horizontally between two vertical hops (the router's relays)
    const busRows: number[] = [];
    const busClaims = new Map<number, { c1: number; c2: number; net: number }[]>();
    for (let r = 0; r < GH; r++) {
      const rowPins: { c: number; net: number }[] = [];
      for (let c = 0; c < GW; c++) {
        const i = at(r, c);
        if (occ[i] === 2 && pinNetAt[i] >= 0) rowPins.push({ c, net: pinNetAt[i] });
      }
      if (rowPins.length === 0) {
        busRows.push(r);
        continue;
      }
      let segStart = 0;
      let curNet = rowPins[0].net;
      let lastPinC = rowPins[0].c;
      const flush = (endC: number, net: number) => {
        if (!segsOfNet.has(net)) segsOfNet.set(net, []);
        segsOfNet.get(net)!.push({ row: r, c1: segStart, c2: endC });
      };
      for (let k = 1; k < rowPins.length; k++) {
        if (rowPins[k].net !== curNet) {
          cuts++;
          const gap = rowPins[k].c - lastPinC;
          if (gap >= 2) {
            flush(lastPinC + 1 - 1, curNet);
            segStart = lastPinC + 2;
          } else {
            bCuts++;
            flush(lastPinC, curNet);
            segStart = rowPins[k].c;
          }
          curNet = rowPins[k].net;
        }
        lastPinC = rowPins[k].c;
      }
      flush(GW - 1, curNet);
    }

    // wires: per-net MST over segments, realizability-aware
    const used = usedBuf.fill(0, 0, GH * GW);
    // body cells per column above each row, so the bodies a vertical wire
    // would cross between two rows come out of one subtraction
    const bodyPre = bodyPreBuf;
    for (let c = 0; c < GW; c++) {
      let n = 0;
      for (let r = 0; r < GH; r++) {
        bodyPre[r * GW + c] = n;
        if (occ[r * GW + c] === 1) n++;
      }
      bodyPre[GH * GW + c] = n;
    }
    let wires = 0, wireLen = 0, slants = 0, crossings = 0, starved = 0, starvedHard = 0, relays = 0;
    const hardSegs: string[] = [];
    // cleanest hop column from a segment to a bus row: free holes at both
    // ends, fewest bodies between
    const hop = (S: { row: number; c1: number; c2: number }, r: number): number => {
      const rowS = S.row * GW, rowR = r * GW;
      const preTop = (Math.min(S.row, r) + 1) * GW, preBot = Math.max(S.row, r) * GW;
      let bestC = -1, bestCross = Infinity;
      for (let c = S.c1; c <= S.c2; c++) {
        if (occ[rowS + c] !== 0 || occ[rowR + c] !== 0 || used[rowS + c] || used[rowR + c]) continue;
        const cr = bodyPre[preBot + c] - bodyPre[preTop + c];
        if (cr < bestCross) {
          bestCross = cr;
          bestC = c;
        }
        if (cr === 0) break;
      }
      return bestC < 0 ? -1 : bestC + (bestCross << 16);
    };
    for (const [net, segs] of segsOfNet) {
      if (segs.length < 2) continue;
      const k = segs.length;
      linkCount.fill(0, 0, k);
      inTree.fill(0, 0, k);
      const tree = [0];
      inTree[0] = 1;
      // Prim keys: per outside segment, its cheapest link from the tree
      // (earliest tree member on ties, so the pick matches a full scan in
      // tree order). A link only consumes holes on its two rows, so keys
      // of segments elsewhere stay exact and are not recomputed.
      // hop columns per (segment, bus row), found once and reused while
      // the two holes they end on stay free
      const nBus = busRows.length;
      if (hopBuf.length < k * nBus) hopBuf = new Int32Array(Math.max(k * nBus, hopBuf.length * 2));
      const hopCache = hopBuf.fill(-2, 0, k * nBus);
      const hopCached = (si: number, bi2: number): number => {
        const idx = si * nBus + bi2;
        let h = hopCache[idx];
        if (h >= 0) {
          const c = h & 0xffff;
          if (used[segs[si].row * GW + c] || used[busRows[bi2] * GW + c]) h = -2;
        }
        if (h === -2) {
          h = hop(segs[si], busRows[bi2]);
          hopCache[idx] = h;
        }
        return h;
      };
      const offer = (ti: number, b2: number, force: boolean) => {
        const A = segs[tree[ti]], B = segs[b2];
        const rowA = A.row * GW;
        const lo = Math.max(A.c1, B.c1), hi = Math.min(A.c2, B.c2);
        let cost: number, cross = 0, bestCol = -1;
        if (A.row === B.row) cost = 50;
        else if (lo <= hi) {
          let bestCross = Infinity;
          const rowB = B.row * GW;
          const preTop = (Math.min(A.row, B.row) + 1) * GW, preBot = Math.max(A.row, B.row) * GW;
          for (let c = lo; c <= hi; c++) {
            if (occ[rowA + c] !== 0 || occ[rowB + c] !== 0) continue;
            if (used[rowA + c] || used[rowB + c]) continue;
            const cr = bodyPre[preBot + c] - bodyPre[preTop + c];
            if (cr < bestCross) {
              bestCross = cr;
              bestCol = c;
            }
            if (cr === 0) break;
          }
          if (bestCross === Infinity) cost = 50;
          else {
            cost = 1 + bestCross * 8;
            cross = bestCross;
          }
        } else cost = 50;
        let len = Math.abs(A.row - B.row);
        let total = cost + len * 0.1;
        let relayRow = -1, cA = -1, cB = -1;
        if (cost >= 50 && busRows.length) {
          // no shared column: a bus-row relay, two vertical hops joined by
          // a claimed span of pin-free copper. A clean relay through a row
          // between the strips is the cheapest possible and ends the search
          const rLo = Math.min(A.row, B.row), rHi = Math.max(A.row, B.row);
          const sa = tree[ti];
          for (let bi2 = 0; bi2 < busRows.length; bi2++) {
            const r = busRows[bi2];
            if (r === A.row || r === B.row) continue;
            const hA = hopCached(sa, bi2);
            if (hA < 0) continue;
            const hB = hopCached(b2, bi2);
            if (hB < 0) continue;
            const ca = hA & 0xffff, cb = hB & 0xffff;
            const lo2 = Math.min(ca, cb), hi2 = Math.max(ca, cb);
            const claims = busClaims.get(r);
            let taken = false;
            if (claims) for (const cl of claims) if (cl.net !== net && cl.c1 <= hi2 && lo2 <= cl.c2) { taken = true; break; }
            if (taken) continue;
            const cr = (hA >> 16) + (hB >> 16);
            const rl = Math.abs(A.row - r) + Math.abs(B.row - r);
            const t = 3 + cr * 8 + rl * 0.1;
            if (t < total) {
              total = t;
              cross = cr;
              len = rl;
              relayRow = r;
              cA = ca;
              cB = cb;
              if (cr === 0 && r > rLo && r < rHi) break;
            }
          }
        }
        if (force || total < kTotal[b2]) {
          kTotal[b2] = total;
          kA[b2] = ti;
          kCross[b2] = cross;
          kLen[b2] = len;
          kCol[b2] = bestCol;
          kOff[b2] = relayRow < 0 && cost >= 50 ? 1 : 0;
          kRow[b2] = relayRow;
          kCA[b2] = cA;
          kCB[b2] = cB;
        }
      };
      const rekey = (b2: number) => {
        offer(0, b2, true);
        for (let ti = 1; ti < tree.length; ti++) offer(ti, b2, false);
      };
      for (let b2 = 1; b2 < k; b2++) rekey(b2);
      while (tree.length < k) {
        let bb = -1;
        for (let b2 = 0; b2 < k; b2++) {
          if (inTree[b2]) continue;
          if (bb < 0 || kTotal[b2] < kTotal[bb] || (kTotal[b2] === kTotal[bb] && kA[b2] < kA[bb])) bb = b2;
        }
        const a = tree[kA[bb]];
        inTree[bb] = 1;
        tree.push(bb);
        wireLen += kLen[bb];
        crossings += kCross[bb];
        if (kOff[bb]) slants++;
        if (kRow[bb] >= 0) {
          const r = kRow[bb];
          used[segs[a].row * GW + kCA[bb]] = 1;
          used[r * GW + kCA[bb]] = 1;
          used[r * GW + kCB[bb]] = 1;
          used[segs[bb].row * GW + kCB[bb]] = 1;
          if (!busClaims.has(r)) busClaims.set(r, []);
          busClaims.get(r)!.push({ c1: Math.min(kCA[bb], kCB[bb]), c2: Math.max(kCA[bb], kCB[bb]), net });
          wires += 2;
          relays++;
        } else {
          wires++;
          if (kCol[bb] >= 0) {
            used[segs[a].row * GW + kCol[bb]] = 1;
            used[segs[bb].row * GW + kCol[bb]] = 1;
          }
        }
        linkCount[a]++;
        linkCount[bb]++;
        // a consumed hole only ever raises a pair's cost, and only when the
        // key relied on that hole: just those keys are recomputed, the
        // rest only hear the new member's offer (claims never collide
        // inside one net, so relay keys depend on their four holes alone)
        const tn = tree.length - 1;
        for (let b2 = 0; b2 < k; b2++) {
          if (inTree[b2]) continue;
          const rb = segs[b2].row * GW, ra = segs[tree[kA[b2]]].row * GW;
          let stale = false;
          if (kRow[b2] >= 0) {
            const rr = kRow[b2] * GW;
            stale = !!(used[ra + kCA[b2]] || used[rr + kCA[b2]] || used[rr + kCB[b2]] || used[rb + kCB[b2]]);
          } else if (kCol[b2] >= 0) {
            stale = !!(used[ra + kCol[b2]] || used[rb + kCol[b2]]);
          }
          if (stale) rekey(b2);
          else offer(tn, b2, false);
        }
      }
      // a linked segment without any free hole cannot take its wire at all
      // (hard); one whose only free hole the link consumes leaves the
      // router no slack (headroom, soft)
      for (let s = 0; s < segs.length; s++) {
        if (linkCount[s] === 0) continue;
        let free = 0, spare = 0;
        for (let c = segs[s].c1; c <= segs[s].c2 && spare === 0; c++) {
          if (occ[at(segs[s].row, c)] !== 0) continue;
          free++;
          if (!used[segs[s].row * GW + c]) spare++;
        }
        if (free === 0) {
          starvedHard++;
          if (options?.debugSeeds) hardSegs.push(`${segs[s].row}:${segs[s].c1}-${segs[s].c2}/n${net}`);
        } else if (spare === 0) starved++;
      }
    }


    let spanBad = 0;
    for (const pi of flexIdx) {
      if (geo[pi].mode !== "V") continue;
      const span = yI[vBot.get(pi)!] - yI[pi];
      if (!(parts[pi] as FlexPart).vdSet.has(span)) spanBad++;
    }

    // exact clearance checks at decoded coordinates (the pair-exact rules
    // the blanket gaps approximated); bbox prefilter keeps it cheap
    let geoBad = 0;
    {
      interface PR { pi: number; kind: "rigid" | "flex"; p1?: BoardPosition; p2?: BoardPosition; minRow: number; maxRow: number; minCol: number; maxCol: number }
      const rects: PR[] = [];
      for (let pi = 0; pi < nP; pi++) {
        const g2 = geo[pi];
        if (parts[pi].kind === "rigid") {
          rects.push({ pi, kind: "rigid", minRow: yI[pi], maxRow: yI[pi] + g2.h - 1, minCol: xI[pi], maxCol: xI[pi] + g2.w - 1 });
        } else if (g2.mode === "H") {
          const dc0 = (parts[pi] as FlexPart).dc0;
          rects.push({ pi, kind: "flex", p1: { row: yI[pi], col: xI[pi] }, p2: { row: yI[pi], col: xI[pi] + dc0 },
            minRow: yI[pi], maxRow: yI[pi], minCol: xI[pi], maxCol: xI[pi] + dc0 });
        } else {
          const b = yI[vBot.get(pi)!];
          rects.push({ pi, kind: "flex", p1: { row: yI[pi], col: xI[pi] }, p2: { row: b, col: xI[pi] },
            minRow: yI[pi], maxRow: b, minCol: xI[pi], maxCol: xI[pi] });
        }
      }
      // sorted by top row, a pair is skipped as soon as B starts below A's reach
      rects.sort((p, q) => p.minRow - q.minRow);
      for (let a = 0; a < rects.length; a++) {
        const A = rects[a];
        for (let b2 = a + 1; b2 < rects.length; b2++) {
          const B = rects[b2];
          if (B.minRow > A.maxRow + clrPad) break;
          if (A.minCol > B.maxCol + clrPad || B.minCol > A.maxCol + clrPad) continue;
          if (A.kind === "flex" && B.kind === "flex") {
            if (segmentsIntersect(A.p1!, A.p2!, B.p1!, B.p2!)) geoBad++;
            else if (bodiesTooClose(A.p1!, A.p2!, B.p1!, B.p2!, Math.max(clrOf[A.pi], clrOf[B.pi]))) geoBad++;
          } else if (A.kind === "flex" || B.kind === "flex") {
            const F = A.kind === "flex" ? A : B;
            const R = A.kind === "flex" ? B : A;
            if (bodyIntersectsRect(F.p1!, F.p2!, { minRow: R.minRow, maxRow: R.maxRow, minCol: R.minCol, maxCol: R.maxCol }, clrOf[F.pi])) geoBad++;
          }
        }
      }
    }

    const lockOver =
      (lockedColsCap !== undefined ? Math.max(0, W - lockedColsCap) : 0) +
      (lockedRowsCap !== undefined ? Math.max(0, H - lockedRowsCap) : 0);
    // shape: humans build wide boards (corpus median rows/cols 0.75, the
    // solver's 1.06), so every row beyond the width is priced like a full
    // row of cells; a wide board pays only beyond the 2:1 ribbon (v2's
    // rule). A user-locked dimension is the user's own shape choice and
    // exempts the board
    const aspectOver = lockedColsCap !== undefined || lockedRowsCap !== undefined ? 0
      : W_TALL * Math.max(0, H - W) * W + Math.max(0, W - 2 * H) * H;
    // a locked dimension is a physical board already cut: charge its FULL
    // extent (narrower/shorter content saves nothing), so the anneal trades
    // the locked dimension for the free one
    const physW = lockedColsCap !== undefined ? Math.max(W, lockedColsCap) : W;
    const physH = lockedRowsCap !== undefined ? Math.max(H, lockedRowsCap) : H;
    // connectors belong on a board edge, any of the four (on edge 0, 1 away
    // 50%, 2 away 75%, then 100% of the full price; the small slope keeps a
    // gradient on the plateau); a locked connector is the user's placement
    // a margin line the wiring attached to becomes a real board line in
    // the finish (padding outside), so a connector flush on that side sits
    // one line in and is priced that way: the anneal weighs the channel
    // against the connectors it pushes off the edge
    const marginUsed = { top: false, bottom: false, left: false, right: false };
    if (mRow) for (let c = 0; c < GW; c++) { if (used[c]) marginUsed.top = true; if (used[(GH - 1) * GW + c]) marginUsed.bottom = true; }
    if (mCol) for (let r = 0; r < GH; r++) { if (used[r * GW]) marginUsed.left = true; if (used[r * GW + GW - 1]) marginUsed.right = true; }
    let connEdge = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.isConn || p.locked) continue;
      const h = geo[pi].mode === "V" ? yI[vBot.get(pi)!] - yI[pi] + 1 : geo[pi].h;
      const FAR = 50;
      const d = Math.min(
        connSides.left ? xI[pi] + (marginUsed.left ? 1 : 0) : FAR,
        connSides.right ? physW - (xI[pi] + geo[pi].w) + (marginUsed.right ? 1 : 0) : FAR,
        connSides.top ? yI[pi] + (marginUsed.top ? 1 : 0) : FAR,
        connSides.bottom ? physH - (yI[pi] + h) + (marginUsed.bottom ? 1 : 0) : FAR);
      const CONN_FULL = 30;
      connEdge += (d <= 0 ? 0 : d === 1 ? 0.5 * CONN_FULL : d === 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d;
    }
    const eBase =
      W_AREA * (physH * physW + aspectOver) + W_WIRE * wires + W_WLEN * wireLen +
      W_CUT * cuts + wBCut * bCuts + W_LOCKOVER * lockOver + connEdge +
      overlapBad * 500 + geoBad * 450 + ringBad * 120 + spanBad * 60 + starved * 20 + starvedHard * 450;
    const hardPen = overlapBad * 500 + geoBad * 450 + starvedHard * 450;
    return { eBase, hardPen, marginUsed, slants, crossings, H, W, yI, xI, geo, vBot, dbg: { wires, wireLen, relays, cuts, bCuts, starved, starvedHard, geoBad, connEdge, lockOver, spanBad, hardSegs } };
  }

  // ── mutation ──
  function mutate(g: Genome, rng: () => number, cold = false): Genome | null {
    let r = rng();
    if (cold) {
      // low-temperature mix: only the move kinds that stay on the plateau
      // (pull, sequence swaps, branch flip, label merge, gap toggles)
      const bands: [number, number, number][] = [[0.06, 0.17, 8], [0.17, 0.336, 22], [0.336, 0.502, 22], [0.502, 0.585, 12], [0.7344, 0.8008, 6], [0.8008, 0.9004, 14], [0.9004, 0.92115, 8], [0.92115, 0.9419, 8]];
      let x = rng() * 100, b = bands[0];
      for (const bb of bands) { if (x < bb[2]) { b = bb; break; } x -= bb[2]; }
      r = b[0] + rng() * (b[1] - b[0]);
    }
    const gg = cloneG(g);
    const ri = (n: number) => Math.floor(rng() * n);
    // side-switch teleport: throw a connector to the opposite extreme of
    // both sequences (the other board edge). Connectors stacked on one edge
    // set the board height; the area pricing already prefers a split, but
    // ordinary swaps cannot carry a connector across the board.
    if (r < 0.06 && nP >= 3) {
      const conns = parts.map((p, i) => (p.isConn && !p.locked ? i : -1)).filter((i) => i >= 0);
      if (!conns.length) return null;
      const a = conns[ri(conns.length)];
      const back = rng() < 0.5;
      for (const arr of [gg.gp, gg.gn]) {
        arr.splice(arr.indexOf(a), 1);
        if (back) arr.push(a);
        else arr.unshift(a);
      }
      return gg;
    }
    if (r < 0.17 && nP >= 3) {
      const cand: number[][] = [];
      for (let n = 0; n < nets.length; n++) {
        const ps = [...new Set(netPins[n].map((x) => x.pi))];
        if (ps.length >= 2) cand.push(ps);
      }
      if (!cand.length) return null;
      const ps = cand[ri(cand.length)];
      const a = ps[ri(ps.length)];
      let b = ps[ri(ps.length)];
      if (a === b) b = ps[(ps.indexOf(b) + 1) % ps.length];
      if (a === b) return null;
      const side = rng() < 0.5 ? 0 : 1;
      for (const arr of [gg.gp, gg.gn]) {
        arr.splice(arr.indexOf(a), 1);
        arr.splice(arr.indexOf(b) + side, 0, a);
      }
      return gg;
    }
    r = (r - 0.17) / 0.83;
    const swapNear = (arr: number[]) => {
      const i = ri(arr.length - 1);
      const j = Math.min(arr.length - 1, i + 1 + ri(3));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    };
    if (nP < 2) {
      if (rigidIdx.length > 0 && !parts[rigidIdx[0]].locked) {
        gg.rot[0] = (gg.rot[0] + 1 + ri(3)) % 4;
        return gg;
      }
      return null;
    }
    if (r < 0.2) swapNear(gg.gp);
    else if (r < 0.4) swapNear(gg.gn);
    else if (r < 0.5) {
      swapNear(gg.gp);
      swapNear(gg.gn);
    } else if (r < 0.58 && rigidIdx.length > 0) {
      const k = ri(rigidIdx.length);
      gg.rot[k] = (gg.rot[k] + 1 + ri(3)) % 4;
    } else if (r < 0.68 && flexIdx.length > 0) {
      const k = ri(flexIdx.length);
      const p = parts[flexIdx[k]] as FlexPart;
      if (p.canH && p.canV) gg.hv[k] = 1 - gg.hv[k];
      else return null;
    } else if (r < 0.76 && flexIdx.length > 0) {
      const k = ri(flexIdx.length);
      gg.br[k] = 1 - gg.br[k];
    } else if (r < 0.88) {
      const n = ri(nets.length);
      const pins = netPins[n];
      if (pins.length < 2) return null;
      const a = ri(pins.length);
      let b = ri(pins.length);
      if (a === b) b = (b + 1) % pins.length;
      gg.grp[n][a] = gg.grp[n][b];
    } else if (r < 0.905) {
      // open or close a blank row below a part (bus-row supply)
      const i = ri(nP);
      gg.gap[i] = gg.gap[i] > 0 ? 0 : 1 + ri(2);
    } else if (r < 0.93) {
      // open or close blank columns right of a part (attachment holes)
      const i = ri(nP);
      gg.xgap[i] = gg.xgap[i] > 0 ? 0 : 1 + ri(2);
    } else {
      const n = ri(nets.length);
      const pins = netPins[n];
      if (pins.length < 2) return null;
      const a = ri(pins.length);
      gg.grp[n][a] = 1 + Math.max(...gg.grp[n]);
    }
    return gg;
  }

  // ── SA with penalty ramp ──
  function solveSeed(seed: number, seedPos: number): { E: number; g: Genome; d: Decoded } | null {
    const rng = mulberry32((seed + 1) * 0x9e3779b9);
    const rampStart = options?.schedule?.rampStart ?? RAMP_START;
    const rampEnd = movesN * (options?.schedule?.rampEndFrac ?? 1);
    const wOf = (it: number) => Math.min(W_MESS, rampStart * Math.pow(W_MESS / rampStart, it / rampEnd));
    const hardStart = options?.schedule?.hardStart ?? 1;
    const hardOf = (it: number) => hardStart >= 1 ? 1 : Math.min(1, hardStart * Math.pow(1 / hardStart, it / rampEnd));
    let hardScale = 1;
    const price = (d: Decoded, w: number) => d.eBase + w * (d.slants + d.crossings) + (hardScale - 1) * d.hardPen;
    const priceFin = (d: Decoded) => d.eBase + W_MESS * (d.slants + d.crossings);
    let g = initGenome(rng);
    let cur = decode(g);
    if (options?.debugSeeds && cur) console.log('FP0 gp=' + g.gp.slice(0, 8).join(',') + ' eBase=' + cur.eBase.toFixed(2) + ' HxW=' + cur.H + 'x' + cur.W + ' ySum=' + cur.yI.reduce((a, b) => a + b, 0) + ' xSum=' + cur.xI.reduce((a, b) => a + b, 0) + ' grp=' + g.grp.map((a) => a.join('')).join('|') + ' xI=' + Array.from(cur.xI).join(','));
    let tries = 0;
    while (!cur && tries++ < 50) {
      g = initGenome(rng);
      cur = decode(g);
    }
    if (!cur) return null;
    if (options?.debugSeeds) console.log("FP gp=" + g.gp.join(",") + " gn=" + g.gn.join(","));

    // fixed start temperature: the landscape is plateaus between penalty
    // cliffs (400–450 per violation); above ~150 the walk is random, and the
    // calibrated start (2000–8000) wasted the first third of every run
    const t0 = options?.schedule?.t0 ?? T_START * (options?.schedule?.t0Scale ?? 1);
    const tEnd = options?.schedule?.tEnd ?? 0.15;
    const coldT = options?.schedule?.coldT ?? 0;
    const cool = Math.pow(tEnd / t0, 1 / movesN);
    let T = t0;
    let best = { E: priceFin(cur), g: cloneG(g), d: cur };
    const reportEvery = Math.max(2000, Math.floor(movesN / 20));
    const traceEvery = Math.max(1, Math.floor(movesN / 100));
    let tAcc = 0, tAccUp = 0, tUp = 0, tNull = 0, tInf = 0;
    for (let it = 0; it < movesN; it++) {
      T *= cool;
      if (it % reportEvery === 0) report("arrange", (options?.seedIndex !== undefined ? it / movesN : (seedPos + it / movesN) / seedsN));
      if (options?.trace && it % traceEvery === 0) {
        options.trace({ seed, it, T, w: wOf(it), cur: price(cur, wOf(it)), best: best.E, curFin: priceFin(cur), acc: tAcc, accUp: tAccUp, up: tUp, nulls: tNull, infeasible: tInf, H: cur.H, W: cur.W });
        tAcc = tAccUp = tUp = tNull = tInf = 0;
      }
      const g2 = mutate(g, rng, T < coldT);
      if (!g2) { tNull++; continue; }
      const e2 = decode(g2);
      if (!e2) { tInf++; continue; }
      const w = wOf(it);
      hardScale = hardOf(it);
      const dE = price(e2, w) - price(cur, w);
      if (dE > 0) tUp++;
      if (dE <= 0 || rng() < Math.exp(-dE / T)) {
        tAcc++;
        if (dE > 0) tAccUp++;
        g = g2;
        cur = e2;
        const eFin = priceFin(e2);
        if (eFin < best.E) best = { E: eFin, g: cloneG(g2), d: e2 };
      }
    }
    if (options?.probe) options.probe({ seed, best, decode, mutate, initGenome, cloneG, price: (d: Decoded) => priceFin(d), t0, W_MESS } as unknown as LandscapeProbe);
    return best;
  }

  // ── finalize through the real completion pipeline ──
  const hasLocked = parts.some((p) => p.locked);
  function finalize(bestG: Genome, d: Decoded) {
    // decoded coordinates first; the routing room around the skeleton is
    // added below (padAroundEdgeConnectors), none under locked parts or a
    // locked dimension
    const dRow = 0, dCol = 0;
    const padRows = hasLocked || lockedRowsCap !== undefined ? 0 : 1;
    const padCols = hasLocked || lockedColsCap !== undefined ? 0 : 1;
    const comps0: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0 as Rot }));
    const byId = new Map(comps0.map((c) => [c.id, c]));
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      const c = byId.get(p.comp.id)!;
      if (p.kind === "rigid") {
        const sh = d.geo[pi].sh!;
        c.boardPos = { row: d.yI[pi] - sh.dRow + dRow, col: d.xI[pi] - sh.dCol + dCol };
        c.rotation = rotOfPart(bestG, pi);
        if (p.locked) {
          c.boardPos = p.comp.boardPos;
          c.rotation = p.comp.rotation;
          c.locked = true;
        }
      } else if (d.geo[pi].mode === "H") {
        const brBit = flexBit(bestG.br, pi);
        const x1 = d.xI[pi] + dCol, x2 = d.xI[pi] + (p as FlexPart).dc0 + dCol;
        c.boardPos = { row: d.yI[pi] + dRow, col: brBit === 0 ? x1 : x2 };
        c.flexibleEndPos = { row: d.yI[pi] + dRow, col: brBit === 0 ? x2 : x1 };
      } else {
        const brBit = flexBit(bestG.br, pi);
        const t = d.yI[pi] + dRow, b = d.yI[d.vBot.get(pi)!] + dRow;
        c.boardPos = { row: brBit === 0 ? t : b, col: d.xI[pi] + dCol };
        c.flexibleEndPos = { row: brBit === 0 ? b : t, col: d.xI[pi] + dCol };
      }
    }
    const padded = padAroundEdgeConnectors(comps0, componentDefs, d.H, d.W, { top: padRows, bottom: padRows, left: padCols, right: 2 * padCols }, d.marginUsed);
    const comps = padded.comps;
    const H = lockedRowsCap !== undefined ? Math.max(padded.rows, lockedRowsCap) : padded.rows;
    const W = lockedColsCap !== undefined ? Math.max(padded.cols, lockedColsCap) : padded.cols;
    const routeBoard: Board = { ...board, rows: H, cols: W, cuts: [], wires: [] };
    const movedIds = new Set(parts.map((p) => p.comp.id));
    const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, options?.drilledCutsOnly ?? false, true, options?.noWireStacking ?? false);
    chooser.route(comps, H, W, movedIds);
    chooser.freezePool();
    const netOfPin = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));
    const c0 = chooser.chosen!;
    const anyLock = lockedColsCap !== undefined || lockedRowsCap !== undefined;
    if (c0.bad === 0 && !anyLock) {
      // under a locked dimension the board is a physical given: the harvest
      // would only drag edge-flush parts inward for no gain
      const full = compactPlacements(c0.virtual, componentDefs, netOfPin, c0.rows, c0.cols);
      if (full.removals > 0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds);
    }
    // hard zero-mess rule: buy bus rows and channel columns until every
    // wire is vertical and crosses nothing; a locked dimension cannot grow
    // and locked parts must not shift, so under those the mess may remain
    if (chooser.chosen!.bad === 0 && !hasLocked) {
      insertWireChannels(chooser, componentDefs, {
        ...(lockedRowsCap !== undefined ? { maxRows: lockedRowsCap } : {}),
        ...(lockedColsCap !== undefined ? { maxCols: lockedColsCap } : {}),
      }, false, true);
    }
    if (chooser.chosen!.bad === 0) repairSlantWires(chooser, routeBoard, componentDefs, netAssignments, new Set());
    const ch = chooser.chosen!;
    const unplaceIds = [
      ...skipped.map((c) => c.id),
      ...components.filter((c) => !c.boardExcluded && !movedIds.has(c.id) && !skipped.some((s) => s.id === c.id)).map((c) => c.id),
    ];
    const issues: string[] = [];
    for (const c of skipped) issues.push(`${c.label ?? c.id} could not be planned`);
    if (ch.plan.unresolvedConflicts > 0) issues.push(`${ch.plan.unresolvedConflicts} strip conflicts remain`);
    if (lockedColsCap !== undefined && ch.cols > lockedColsCap) issues.push(`does not fit the locked ${lockedColsCap} columns (needs ${ch.cols})`);
    if (lockedRowsCap !== undefined && ch.rows > lockedRowsCap) issues.push(`does not fit the locked ${lockedRowsCap} rows (needs ${ch.rows})`);
    const stacked = options?.noWireStacking
      ? ch.plan.wires.filter((w, i) => wireStackDepth(w.from, w.to, ch.plan.wires.slice(0, i)) > 0).length
      : 0;
    if (ch.mess - stacked > 0) issues.push(`${ch.mess - stacked} wire${ch.mess - stacked === 1 ? "" : "s"} could not be made straight and crossing-free`);
    if (stacked > 0) issues.push(`${stacked} wire${stacked === 1 ? "" : "s"} still run on top of another wire`);
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
      quality: ch.plan.unresolvedConflicts * 100 + ch.plan.starvedNetIds.length + skipped.length * 2,
      starvedNetIds: ch.plan.starvedNetIds,
      boardSize: { rows: ch.rows, cols: ch.cols },
      unplaceIds,
    };
    let final: AutoLayoutResult;
    if (anyLock) {
      // locked dimensions come back EXACTLY as locked (the physical board);
      // only the free dimension is trimmed, and nothing is shifted
      let maxR = 0, maxC = 0, minR = Infinity, minC = Infinity;
      const see = (r: number, c: number) => {
        maxR = Math.max(maxR, r);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        minC = Math.min(minC, c);
      };
      for (const c of ch.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const e = c.flexibleEndPos ?? c.boardPos;
          see(c.boardPos.row, c.boardPos.col);
          see(e.row, e.col);
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          see(b.minRow, b.minCol);
          see(b.maxRow, b.maxCol);
        }
      }
      for (const cut of ch.plan.cuts) see(cut.row, cut.col);
      for (const w of ch.plan.wires) {
        see(w.from.row, w.from.col);
        see(w.to.row, w.to.col);
      }
      if (!isFinite(minR)) { minR = 0; minC = 0; }
      // shift leading emptiness out of the FREE dimension only: the locked
      // dimension's frame is the physical board (shifting columns under a
      // locked width would drag edge-flush connectors off the rim), and
      // locked parts pin everything absolutely
      const shiftR = !hasLocked && lockedRowsCap === undefined ? minR : 0;
      const shiftC = !hasLocked && lockedColsCap === undefined ? minC : 0;
      if (shiftR > 0 || shiftC > 0) {
        const mv = (p: BoardPosition): BoardPosition => ({ row: p.row - shiftR, col: p.col - shiftC });
        result.placements = result.placements.map((pl) => ({
          ...pl, boardPos: mv(pl.boardPos),
          ...(pl.flexibleEndPos ? { flexibleEndPos: mv(pl.flexibleEndPos) } : {}),
        }));
        result.cuts = result.cuts.map((cut) => ({ ...cut, row: cut.row - shiftR, col: cut.col - shiftC }));
        result.wires = result.wires.map((w) => ({ from: mv(w.from), to: mv(w.to) }));
      }
      const rows = lockedRowsCap !== undefined ? Math.max(lockedRowsCap, maxR + 1) : maxR - shiftR + 1;
      const cols = lockedColsCap !== undefined ? Math.max(lockedColsCap, maxC + 1) : maxC - shiftC + 1;
      final = { ...result, boardSize: { rows, cols } };
    } else {
      const trimmed = trimResult(result, routeBoard, ch.virtual, componentDefs, hasLocked);
      final = { ...result, ...trimmed };
    }
    // purely visual: line the cuts up on shared columns (v2 does the same)
    if (final.quality === 0) {
      final = alignCuts(final, routeBoard, components, componentDefs);
      if (options?.drilledCutsOnly && final.boardSize) {
        // alignment may have slid a stuck knife cut next to a drillable hole
        const byPl = new Map(final.placements.map((p) => [p.componentId, p]));
        const virtual = components.map((c) => {
          const p = byPl.get(c.id);
          return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
        });
        const vBoard: Board = { ...board, rows: final.boardSize.rows, cols: final.boardSize.cols, cuts: [], wires: [] };
        final = { ...final, cuts: drillRemainingCuts(vBoard, virtual, componentDefs, netAssignments, final.cuts, final.wires) };
      }
    }
    const rate = rateResult(result, routeBoard, ch.virtual, componentDefs, options?.drilledCutsOnly ?? false);
    const offAxis = final.wires.filter((w) => w.from.col !== w.to.col).length;
    const crossings = wireMessScore(final, comps, componentDefs).crossings;
    const overCap =
      (lockedColsCap !== undefined ? Math.max(0, (final.boardSize?.cols ?? 0) - lockedColsCap) : 0) +
      (lockedRowsCap !== undefined ? Math.max(0, (final.boardSize?.rows ?? 0) - lockedRowsCap) : 0);
    const score = (final.quality + overCap * 40) * 1e9 + (offAxis + crossings) * 1e4 + rate;
    return { final, score };
  }

  // ── run the portfolio ──
  const seedBests: { E: number; g: Genome; d: Decoded }[] = [];
  const seedList = options?.seedIndex !== undefined ? [options.seedIndex] : [...Array(seedsN).keys()].map((k) => k + (options?.seedBase ?? 0));
  for (const [pos, seed] of seedList.entries()) {
    const r = solveSeed(seed, pos);
    if (r) seedBests.push(r);
    if (r && options?.debugSeeds) {
      console.log(`[v5 seed ${seed}] E ${r.E.toFixed(1)} decoded ${r.d.H}x${r.d.W}`, JSON.stringify(r.d.dbg));
    }
  }
  if (seedBests.length === 0) return emptyResult(["auto-layout found no feasible arrangement"]);
  seedBests.sort((a, b) => a.E - b.E);
  let bestFin: { final: AutoLayoutResult; score: number } | null = null;
  const finalists = seedBests.slice(0, 4);
  finalists.forEach((r, i) => {
    report("place", i / finalists.length);
    const f = finalize(r.g, r.d);
    if (!bestFin || f.score < bestFin.score) bestFin = f;
  });
  report("place", 1);
  return bestFin!.final;
}
