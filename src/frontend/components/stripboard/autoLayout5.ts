import { Board, BoardPosition, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getRotatedPinPositions } from "./boardLayout";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { Rot, allowedDrows } from "./layout2/tileModel";
import { bodiesTooClose, bodyIntersectsRect, segmentsIntersect } from "./flexGeometry";
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
  // Harness-only: log each seed's decoded best (never set by the UI)
  debugSeeds?: boolean;
}

const W_AREA = 0.35;
const W_WIRE = 4;       // per link wire
const W_WLEN = 0.4;     // per row of wire length
const W_CUT = 0.05;     // cuts are nearly free
const W_BCUT = 2;       // between-holes cuts stay visibly priced
const W_MESS = 400;     // final price per off-axis or crossing wire
const W_TALL = 2;       // rows of cells each row beyond the board width costs
const RAMP_START = 25;  // their price while the skeleton forms
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
}

interface Decoded {
  eBase: number;
  slants: number;
  crossings: number;
  H: number;
  W: number;
  yI: Int32Array;
  xI: Int32Array;
  geo: { w: number; h: number; sh?: RigidShape; mode?: "H" | "V" }[];
  vBot: Map<number, number>;
  dbg?: Record<string, number>;
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
    };
  };
  const cloneG = (g: Genome): Genome => ({
    gp: g.gp.slice(), gn: g.gn.slice(), rot: g.rot.slice(),
    hv: g.hv.slice(), br: g.br.slice(), grp: g.grp.map((a) => a.slice()),
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

    // optimistic: pure non-overlap; real clearances are checked EXACTLY at
    // decoded coordinates (bodiesTooClose/bodyIntersectsRect) and priced
    const vgapOf = (_i: number, _j: number) => 1;

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
      const w0 = (vBotArr[i] >= 0 ? 0 : geo[i].h - 1) + vgapOf(i, 0);
      const pi_ = posP[i], ni = posN[i];
      for (let j = 0; j < nP; j++) {
        if (i === j || !(pi_ < posP[j] && ni > posN[j])) continue;
        if (parts[j].locked) continue;
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
      if (fi && fj) return 2;
      if (!fi && !fj) {
        // a free col is only needed when the FACING edges both carry pins
        // (cut-apart one-hole segments starve the router)
        const shL = geo[i].sh!, shR = geo[j].sh!;
        const rPins = shL.pins.some((p2) => p2.colOff === shL.w - 1 && p2.net !== undefined);
        const lPins = shR.pins.some((p2) => p2.colOff === 0 && p2.net !== undefined);
        return rPins && lPins ? 2 : 1;
      }
      const f = fi ? i : j;
      return geo[f].mode === "V" ? 2 : 1;
    };
    // edges in first-sequence order, so the sweep below settles fast
    for (let r = 0; r < nP; r++) {
      const i = g.gp[r];
      if (parts[i].locked) continue;
      const ti = y[i], bi = vBotArr[i] >= 0 ? y[vBotArr[i]] : ti + geo[i].h - 1;
      const pi_ = posP[i], ni = posN[i];
      for (let j = 0; j < nP; j++) {
        if (i === j || !(pi_ < posP[j] && ni < posN[j])) continue;
        if (parts[j].locked) continue;
        const tj = y[j], bj = vBotArr[j] >= 0 ? y[vBotArr[j]] : tj + geo[j].h - 1;
        const margin = vgapOf(i, j) === 2 ? 1.5 : 0.5;
        if (!(bi < tj - margin || bj < ti - margin)) addX(i, j, geo[i].w - 1 + hgap(i, j));
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
    const occ = new Int8Array(H * W);
    const owner = new Int16Array(H * W).fill(-1);
    const pinNetAt = new Int32Array(H * W).fill(-1);
    const at = (r: number, c: number) => r * W + c;
    let overlapBad = 0;
    const claim = (r: number, c: number, v: number, net: number | undefined, pi: number) => {
      if (r < 0 || c < 0 || r >= H || c >= W) {
        overlapBad++;
        return;
      }
      const i = at(r, c);
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
        claim(yI[pi], xI[pi], 2, brBit === 0 ? p.na : p.nb, pi);
        claim(yI[pi], xI[pi] + p.dc0, 2, brBit === 0 ? p.nb : p.na, pi);
      } else {
        const t = yI[pi], b = yI[vBot.get(pi)!];
        for (let r = t; r <= b; r++) {
          if (r > t && r < b) claim(r, xI[pi], 1, undefined, pi);
          if (flexCellBad(r, xI[pi], "V")) ringBad++;
        }
        const brBit = flexBit(g.br, pi);
        claim(t, xI[pi], 2, brBit === 0 ? p.na : p.nb, pi);
        claim(b, xI[pi], 2, brBit === 0 ? p.nb : p.na, pi);
      }
    }

    // runs, cuts, segments per row
    let cuts = 0, bCuts = 0;
    const segsOfNet = new Map<number, { row: number; c1: number; c2: number }[]>();
    for (let r = 0; r < H; r++) {
      const rowPins: { c: number; net: number }[] = [];
      for (let c = 0; c < W; c++) {
        const i = at(r, c);
        if (occ[i] === 2 && pinNetAt[i] >= 0) rowPins.push({ c, net: pinNetAt[i] });
      }
      if (rowPins.length === 0) continue;
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
      flush(W - 1, curNet);
    }

    // wires: per-net MST over segments, realizability-aware
    const used = new Uint8Array(H * W);
    // body cells per column above each row, so the bodies a vertical wire
    // would cross between two rows come out of one subtraction
    const bodyPre = new Int32Array((H + 1) * W);
    for (let c = 0; c < W; c++) {
      let n = 0;
      for (let r = 0; r < H; r++) {
        bodyPre[r * W + c] = n;
        if (occ[r * W + c] === 1) n++;
      }
      bodyPre[H * W + c] = n;
    }
    let wires = 0, wireLen = 0, slants = 0, crossings = 0, starved = 0, starvedHard = 0;
    for (const [, segs] of segsOfNet) {
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
      const offer = (ti: number, b2: number, force: boolean) => {
        const A = segs[tree[ti]], B = segs[b2];
        const rowA = A.row * W;
        const lo = Math.max(A.c1, B.c1), hi = Math.min(A.c2, B.c2);
        let cost: number, cross = 0, bestCol = -1;
        if (A.row === B.row) cost = 50;
        else if (lo <= hi) {
          let bestCross = Infinity;
          const rowB = B.row * W;
          const preTop = (Math.min(A.row, B.row) + 1) * W, preBot = Math.max(A.row, B.row) * W;
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
        const len = Math.abs(A.row - B.row);
        const total = cost + len * 0.1;
        if (force || total < kTotal[b2]) {
          kTotal[b2] = total;
          kA[b2] = ti;
          kCross[b2] = cross;
          kLen[b2] = len;
          kCol[b2] = bestCol;
          kOff[b2] = cost >= 50 ? 1 : 0;
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
        wires++;
        wireLen += kLen[bb];
        crossings += kCross[bb];
        if (kOff[bb]) slants++;
        let rowA = -1, rowB = -1;
        if (kCol[bb] >= 0) {
          rowA = segs[a].row;
          rowB = segs[bb].row;
          used[rowA * W + kCol[bb]] = 1;
          used[rowB * W + kCol[bb]] = 1;
        }
        linkCount[a]++;
        linkCount[bb]++;
        // a consumed hole only ever raises a pair's cost, and only when it
        // was that pair's own column on one of its rows: just those keys
        // are recomputed, the rest only hear the new member's offer
        const tn = tree.length - 1;
        const col = kCol[bb];
        for (let b2 = 0; b2 < k; b2++) {
          if (inTree[b2]) continue;
          const rb = segs[b2].row, ra = segs[tree[kA[b2]]].row;
          if (rowA >= 0 && kCol[b2] === col && (rb === rowA || rb === rowB || ra === rowA || ra === rowB)) rekey(b2);
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
          if (!used[segs[s].row * W + c]) spare++;
        }
        if (free === 0) starvedHard++;
        else if (spare === 0) starved++;
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
      for (let a = 0; a < rects.length; a++) {
        for (let b2 = a + 1; b2 < rects.length; b2++) {
          const A = rects[a], B = rects[b2];
          if (A.minRow > B.maxRow + 2 || B.minRow > A.maxRow + 2 || A.minCol > B.maxCol + 2 || B.minCol > A.maxCol + 2) continue;
          if (A.kind === "flex" && B.kind === "flex") {
            if (segmentsIntersect(A.p1!, A.p2!, B.p1!, B.p2!)) geoBad++;
            else if (bodiesTooClose(A.p1!, A.p2!, B.p1!, B.p2!)) geoBad++;
          } else if (A.kind === "flex" || B.kind === "flex") {
            const F = A.kind === "flex" ? A : B;
            const R = A.kind === "flex" ? B : A;
            if (bodyIntersectsRect(F.p1!, F.p2!, { minRow: R.minRow, maxRow: R.maxRow, minCol: R.minCol, maxCol: R.maxCol })) geoBad++;
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
    let connEdge = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.isConn || p.locked) continue;
      const h = geo[pi].mode === "V" ? yI[vBot.get(pi)!] - yI[pi] + 1 : geo[pi].h;
      const d = Math.min(xI[pi], physW - (xI[pi] + geo[pi].w), yI[pi], physH - (yI[pi] + h));
      const CONN_FULL = 30;
      connEdge += (d <= 0 ? 0 : d === 1 ? 0.5 * CONN_FULL : d === 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d;
    }
    const eBase =
      W_AREA * (physH * physW + aspectOver) + W_WIRE * wires + W_WLEN * wireLen +
      W_CUT * cuts + W_BCUT * bCuts + W_LOCKOVER * lockOver + connEdge +
      overlapBad * 500 + geoBad * 450 + ringBad * 120 + spanBad * 60 + starved * 20 + starvedHard * 450;
    return { eBase, slants, crossings, H, W, yI, xI, geo, vBot, dbg: { wires, wireLen, cuts, bCuts, starved, starvedHard, geoBad, connEdge, lockOver, spanBad } };
  }

  // ── mutation ──
  function mutate(g: Genome, rng: () => number): Genome | null {
    let r = rng();
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
    } else if (r < 0.9) {
      const n = ri(nets.length);
      const pins = netPins[n];
      if (pins.length < 2) return null;
      const a = ri(pins.length);
      let b = ri(pins.length);
      if (a === b) b = (b + 1) % pins.length;
      gg.grp[n][a] = gg.grp[n][b];
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
  function solveSeed(seed: number): { E: number; g: Genome; d: Decoded } | null {
    const rng = mulberry32((seed + 1) * 0x9e3779b9);
    const wOf = (it: number) => Math.min(W_MESS, RAMP_START * Math.pow(W_MESS / RAMP_START, it / movesN));
    const price = (d: Decoded, w: number) => d.eBase + w * (d.slants + d.crossings);
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

    const ups: number[] = [];
    for (let i = 0; i < 100; i++) {
      const g2 = mutate(g, rng);
      if (!g2) continue;
      const e2 = decode(g2);
      if (e2 && price(e2, RAMP_START) > price(cur, RAMP_START)) ups.push(price(e2, RAMP_START) - price(cur, RAMP_START));
    }
    ups.sort((a, b) => a - b);
    const typUp = ups.length ? ups[Math.floor(ups.length * 0.7)] : 5;
    const t0 = Math.max(0.5, typUp) / Math.log(1 / 0.8);
    const cool = Math.pow(0.15 / t0, 1 / movesN);
    let T = t0;
    let best = { E: price(cur, W_MESS), g: cloneG(g), d: cur };
    const reportEvery = Math.max(2000, Math.floor(movesN / 20));
    for (let it = 0; it < movesN; it++) {
      T *= cool;
      if (it % reportEvery === 0) report("arrange", (options?.seedIndex !== undefined ? it / movesN : (seed + it / movesN) / seedsN));
      const g2 = mutate(g, rng);
      if (!g2) continue;
      const e2 = decode(g2);
      if (!e2) continue;
      const w = wOf(it);
      const dE = price(e2, w) - price(cur, w);
      if (dE <= 0 || rng() < Math.exp(-dE / T)) {
        g = g2;
        cur = e2;
        const eFin = price(e2, W_MESS);
        if (eFin < best.E) best = { E: eFin, g: cloneG(g2), d: e2 };
      }
    }
    return best;
  }

  // ── finalize through the real completion pipeline ──
  const hasLocked = parts.some((p) => p.locked);
  function finalize(bestG: Genome, d: Decoded) {
    const dRow = hasLocked || lockedRowsCap !== undefined ? 0 : 1;
    const dCol = hasLocked || lockedColsCap !== undefined ? 0 : 1;
    const comps: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0 as Rot }));
    const byId = new Map(comps.map((c) => [c.id, c]));
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
    const H = lockedRowsCap !== undefined ? Math.max(d.H, lockedRowsCap) : d.H + 1 + dRow;
    const W = lockedColsCap !== undefined ? Math.max(d.W, lockedColsCap) : d.W + 2 + dCol;
    const routeBoard: Board = { ...board, rows: H, cols: W, cuts: [], wires: [] };
    const movedIds = new Set(parts.map((p) => p.comp.id));
    const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, false, true);
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
    const rate = rateResult(result, routeBoard, ch.virtual, componentDefs, false);
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
  const seedList = options?.seedIndex !== undefined ? [options.seedIndex] : [...Array(seedsN).keys()];
  for (const seed of seedList) {
    const r = solveSeed(seed);
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
