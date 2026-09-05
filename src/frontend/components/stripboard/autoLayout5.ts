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
  function decode(g: Genome): Decoded | null {
    const posP = new Int32Array(nP), posN = new Int32Array(nP);
    g.gp.forEach((p, i) => (posP[p] = i));
    g.gn.forEach((p, i) => (posN[p] = i));
    const leftOf = (i: number, j: number) => posP[i] < posP[j] && posN[i] < posN[j];
    const above = (i: number, j: number) => posP[i] < posP[j] && posN[i] > posN[j];

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

    const edges: { u: number; v: number; w: number }[] = [];
    const addE = (u: number, v: number, w: number) => edges.push({ u, v, w });
    for (let i = 0; i < nNode - 1; i++) addE(SRC, i, 0);
    for (const pi of flexIdx) {
      if (geo[pi].mode !== "V") continue;
      const p = parts[pi] as FlexPart;
      const b = vBot.get(pi)!;
      addE(pi, b, p.minS);
      addE(b, pi, -p.maxS);
    }
    const botExpr = (pi: number): [number, number] =>
      geo[pi].mode === "V" ? [vBot.get(pi)!, 0] : [pi, geo[pi].h - 1];
    for (let i = 0; i < nP; i++) {
      for (let j = 0; j < nP; j++) {
        if (i === j || !above(i, j)) continue;
        if (parts[i].locked || parts[j].locked) continue;
        const [bu, bo] = botExpr(i);
        addE(bu, j, bo + vgapOf(i, j));
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
    const dist = new Float64Array(nNode).fill(-1e18);
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
      const redges: { u: number; v: number; w: number }[] = [];
      for (const e of edges) {
        const ru = rootArr[e.u], rv = rootArr[e.v];
        const w = e.w + offArr[e.u] - offArr[e.v];
        if (ru === rv) {
          if (w > 0 && !conflict) {
            const mm = members.get(ru);
            conflict = mm && mm.length ? mm[mm.length - 1] : "hard";
          }
          continue;
        }
        redges.push({ u: ru, v: rv, w });
      }
      if (conflict) {
        if (conflict === "hard") return null;
        g.grp[conflict.net][conflict.k] = Math.max(...g.grp[conflict.net]) + 1;
        continue;
      }
      dist.fill(-1e18);
      dist[SRC] = 0;
      const pred = new Int32Array(nNode).fill(-1);
      let changed = false, lastEdge = -1;
      for (let it = 0; it < nNode + 2; it++) {
        changed = false;
        for (let ei = 0; ei < redges.length; ei++) {
          const e = redges[ei];
          if (dist[e.u] + e.w > dist[e.v] + 1e-9) {
            dist[e.v] = dist[e.u] + e.w;
            pred[e.v] = ei;
            changed = true;
            lastEdge = ei;
          }
        }
        if (!changed) break;
      }
      if (!changed) {
        for (let v = 0; v < nNode; v++) dist[v] = dist[rootArr[v]] + offArr[v];
        solved = true;
        break;
      }
      let cur = redges[lastEdge].v;
      for (let s = 0; s < nNode + 2; s++) {
        const ei = pred[cur];
        if (ei < 0) break;
        cur = redges[ei].u;
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
        cur = redges[ei].u;
        if (cur === start) break;
      }
      if (!fixed) return null;
    }
    if (!solved) return null;
    const y = dist;

    // x: SP left edges + locked pins; longest path
    const XS = nP;
    const xe: { u: number; v: number; w: number }[] = [];
    for (let i = 0; i < nP; i++) xe.push({ u: XS, v: i, w: 0 });
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
    if (options?.debugSeeds) {
      for (let i2 = 0; i2 < nP; i2++) for (let j2 = 0; j2 < nP; j2++) {
        if (i2 !== j2 && parts[i2].kind === "rigid" && parts[j2].kind === "rigid") console.log("HG", i2, j2, hgap(i2, j2));
      }
    }
    for (let i = 0; i < nP; i++) {
      for (let j = 0; j < nP; j++) {
        if (i === j || !leftOf(i, j)) continue;
        if (parts[i].locked || parts[j].locked) continue;
        const ti = y[i], bi = geo[i].mode === "V" ? y[vBot.get(i)!] : ti + geo[i].h - 1;
        const tj = y[j], bj = geo[j].mode === "V" ? y[vBot.get(j)!] : tj + geo[j].h - 1;
        const margin = vgapOf(i, j) === 2 ? 1.5 : 0.5;
        if (!(bi < tj - margin || bj < ti - margin)) xe.push({ u: i, v: j, w: geo[i].w - 1 + hgap(i, j) });
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
      xe.push({ u: XS, v: n, w: v });
      xe.push({ u: n, v: XS, w: -v });
    }
    const xd = new Float64Array(nP + 1).fill(-1e18);
    xd[XS] = 0;
    let xOK = true;
    for (let it = 0; it < nP + 3; it++) {
      let ch = false;
      for (const e of xe) {
        if (xd[e.u] + e.w > xd[e.v] + 1e-9) {
          xd[e.v] = xd[e.u] + e.w;
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
        for (const sp of sh.pins) claim(yI[pi] + sp.rowOff, xI[pi] + sp.colOff, 2, sp.net, pi);
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
    const usedHoles = new Set<number>();
    let wires = 0, wireLen = 0, slants = 0, crossings = 0, starved = 0;
    for (const [, segs] of segsOfNet) {
      if (segs.length < 2) continue;
      const linkCount = new Int32Array(segs.length);
      const inT = new Set<number>([0]);
      while (inT.size < segs.length) {
        let best: { total: number; a: number; b: number; cross: number; len: number; offAxis: boolean; col: number } | null = null;
        for (const a of inT) {
          for (let b2 = 0; b2 < segs.length; b2++) {
            if (inT.has(b2)) continue;
            const A = segs[a], B = segs[b2];
            const lo = Math.max(A.c1, B.c1), hi = Math.min(A.c2, B.c2);
            let cost: number, cross = 0, bestCol = -1;
            if (A.row === B.row) cost = 50;
            else if (lo <= hi) {
              let bestCross = Infinity;
              for (let c = lo; c <= hi; c++) {
                if (occ[at(A.row, c)] !== 0 || occ[at(B.row, c)] !== 0) continue;
                if (usedHoles.has(A.row * 4096 + c) || usedHoles.has(B.row * 4096 + c)) continue;
                let cr = 0;
                const r1 = Math.min(A.row, B.row), r2 = Math.max(A.row, B.row);
                for (let r = r1 + 1; r < r2; r++) if (occ[at(r, c)] === 1) cr++;
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
            if (!best || total < best.total) best = { total, a, b: b2, cross, len, offAxis: cost >= 50, col: bestCol };
          }
        }
        if (!best) break;
        inT.add(best.b);
        wires++;
        wireLen += best.len;
        crossings += best.cross;
        if (best.offAxis) slants++;
        if (best.col >= 0) {
          usedHoles.add(segs[best.a].row * 4096 + best.col);
          usedHoles.add(segs[best.b].row * 4096 + best.col);
        }
        linkCount[best.a]++;
        linkCount[best.b]++;
      }
      for (let s = 0; s < segs.length; s++) {
        if (linkCount[s] === 0) continue;
        let spare = 0;
        for (let c = segs[s].c1; c <= segs[s].c2 && spare === 0; c++) {
          if (occ[at(segs[s].row, c)] === 0 && !usedHoles.has(segs[s].row * 4096 + c)) spare++;
        }
        if (spare === 0) starved++;
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
    // ribbon boards read badly even at equal area (v2's chooser rule): a
    // user-locked dimension is the user's own shape choice and exempts it
    const aspectOver = lockedColsCap !== undefined || lockedRowsCap !== undefined ? 0
      : Math.max(0, Math.max(H, W) - 2 * Math.min(H, W)) * Math.min(H, W);
    // a locked dimension is a physical board already cut: charge its FULL
    // extent (narrower/shorter content saves nothing), so the anneal trades
    // the locked dimension for the free one
    const physW = lockedColsCap !== undefined ? Math.max(W, lockedColsCap) : W;
    const physH = lockedRowsCap !== undefined ? Math.max(H, lockedRowsCap) : H;
    // connectors belong on the left or right board edge (on edge 0, 1 away
    // 50%, 2 away 75%, then 100% of the full price; the small slope keeps a
    // gradient on the plateau); a locked connector is the user's placement
    let connEdge = 0;
    for (let pi = 0; pi < nP; pi++) {
      const p = parts[pi];
      if (!p.isConn || p.locked) continue;
      const d = Math.min(xI[pi], physW - (xI[pi] + geo[pi].w));
      const CONN_FULL = 30;
      connEdge += (d <= 0 ? 0 : d === 1 ? 0.5 * CONN_FULL : d === 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d;
    }
    const eBase =
      W_AREA * (physH * physW + aspectOver) + W_WIRE * wires + W_WLEN * wireLen +
      W_CUT * cuts + W_BCUT * bCuts + W_LOCKOVER * lockOver + connEdge +
      overlapBad * 500 + geoBad * 450 + ringBad * 120 + spanBad * 60 + starved * 50;
    return { eBase, slants, crossings, H, W, yI, xI, geo, vBot, dbg: { wires, wireLen, cuts, bCuts, starved, geoBad, connEdge, lockOver, spanBad } };
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
    const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, false);
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
      insertWireChannels(chooser, componentDefs, {}, false);
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
