// The wire router (route.c) behind wireRouting.ts deriveWires: inputs
// flattened into the module's arena, outputs read back into the shapes
// deriveWires returns. Installed once per worker or page (setRouteWasm).
import type { BoardPosition, Cut, Net } from "@/types";
import type { StripSegment } from "../stripSegments";
import type { BoardPin } from "../boardPins";
import type { WireObstacleIndex } from "../flexGeometry";

export interface RoutedWires {
  wires: { from: BoardPosition; to: BoardPosition }[];
  extraCuts: Cut[];
  wireMess: number;
  sharedJoints: number;
  issues: string[];
  starvedNetIds: string[];
  starvedPinPositions: BoardPosition[];
}

interface RouteExports {
  memory: WebAssembly.Memory;
  r_reset(): void;
  r_alloc(bytes: number): number;
  r_route(inI: number, inD: number): number;
}

export class RouteWasm {
  private ex: RouteExports;

  constructor(module: WebAssembly.Module) {
    this.ex = new WebAssembly.Instance(module, {}).exports as unknown as RouteExports;
  }

  /** deriveWires in C. */
  route(
    segments: StripSegment[],
    groups: { segmentIndices: number[] }[],
    nets: Net[],
    pins: BoardPin[],
    occupied: Set<string>,
    existingWires: { from: BoardPosition; to: BoardPosition }[],
    reserveNets: Set<string>,
    obstacleIndex: WireObstacleIndex,
    allowSharedJoints: boolean,
    skipRelays: boolean,
    drillTailRelays: boolean,
    noWireStacking: boolean
  ): RoutedWires {
    // net ids: the routed nets first, in their order, then the pins' others
    // (an empty id would read as no net, and each net is routed once)
    const netIdx = new Map<string, number>();
    for (const n of nets) {
      if (n.id === "" || netIdx.has(n.id)) throw new Error(`wire router: net id "${n.id}" is empty or repeated`);
      netIdx.set(n.id, netIdx.size);
    }
    const nRoute = netIdx.size;
    for (const p of pins) {
      if (p.netId === "") throw new Error("wire router: a pin has an empty net id");
      if (p.netId !== null && !netIdx.has(p.netId)) netIdx.set(p.netId, netIdx.size);
    }
    let maxR = -1, maxC = -1, minAll = 0;
    const see = (r: number, c: number) => {
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
      if (r < minAll) minAll = r;
      if (c < minAll) minAll = c;
    };
    for (const s of segments) { see(s.row, s.startCol); see(s.row, s.endCol); }
    for (const p of pins) see(p.row, p.col);
    for (const w of existingWires) { see(w.from.row, w.from.col); see(w.to.row, w.to.col); }
    if (minAll < 0) throw new Error("wire router: a hole off the board");
    const occ: number[] = [];
    for (const k of occupied) {
      const i = k.indexOf(",");
      occ.push(Number(k.slice(0, i)), Number(k.slice(i + 1)));
    }
    let nGroupIdx = 0;
    for (const g of groups) nGroupIdx += g.segmentIndices.length;
    const { rects, bodies } = obstacleIndex.obstacles;
    const nSeg = segments.length, nPins = pins.length, nExist = existingWires.length;
    const nI = 13 + 3 * nSeg + groups.length + 1 + nGroupIdx + 3 * nPins + occ.length + 4 * nExist + netIdx.size;
    const nD = 4 * rects.length + 10 * bodies.length;

    const ex = this.ex;
    ex.r_reset();
    const pI = ex.r_alloc(4 * nI), pD = ex.r_alloc(8 * Math.max(1, nD));
    const I = new Int32Array(ex.memory.buffer, pI, nI);
    const D = new Float64Array(ex.memory.buffer, pD, Math.max(1, nD));
    I.set([maxR + 1, maxC + 1, nSeg, groups.length, nGroupIdx, nPins, occ.length / 2, nExist, netIdx.size, nRoute,
      rects.length, bodies.length,
      (obstacleIndex.strict ? 1 : 0) | (allowSharedJoints ? 2 : 0) | (skipRelays ? 4 : 0) | (drillTailRelays ? 8 : 0) | (noWireStacking ? 16 : 0)]);
    let o = 13;
    for (const s of segments) I[o++] = s.row;
    for (const s of segments) I[o++] = s.startCol;
    for (const s of segments) I[o++] = s.endCol;
    let at = 0;
    for (const g of groups) { I[o++] = at; at += g.segmentIndices.length; }
    I[o++] = at;
    for (const g of groups) for (const si of g.segmentIndices) I[o++] = si;
    for (const p of pins) I[o++] = p.row;
    for (const p of pins) I[o++] = p.col;
    for (const p of pins) I[o++] = p.netId === null ? -1 : netIdx.get(p.netId)!;
    for (const v of occ) I[o++] = v;
    for (const w of existingWires) { I[o++] = w.from.row; I[o++] = w.from.col; I[o++] = w.to.row; I[o++] = w.to.col; }
    for (const id of netIdx.keys()) I[o++] = reserveNets.has(id) ? 1 : 0;
    let d = 0;
    for (const r of rects) { D[d++] = r.minRow; D[d++] = r.minCol; D[d++] = r.maxRow; D[d++] = r.maxCol; }
    for (const b of bodies) {
      D[d++] = b.p1.row; D[d++] = b.p1.col; D[d++] = b.p2.row; D[d++] = b.p2.col;
      const core = b.core;
      D[d++] = core ? 1 : 0;
      D[d++] = core ? core.a.row : 0; D[d++] = core ? core.a.col : 0;
      D[d++] = core ? core.b.row : 0; D[d++] = core ? core.b.col : 0;
      D[d++] = core ? core.r : 0;
    }

    const hdrPtr = ex.r_route(pI, pD);
    // the arena may have grown: views only after the call
    const buf = ex.memory.buffer;
    const h = new Int32Array(buf, hdrPtr, 9);
    const nW = h[0], nCut = h[2], nEv = h[5];
    const W = new Int32Array(buf, h[1], 4 * nW);
    const K = new Int32Array(buf, h[3], 3 * nCut);
    const E = new Int32Array(buf, h[6], 4 * nEv);
    const wires: { from: BoardPosition; to: BoardPosition }[] = [];
    for (let i = 0; i < nW; i++) wires.push({ from: { row: W[4 * i], col: W[4 * i + 1] }, to: { row: W[4 * i + 2], col: W[4 * i + 3] } });
    const extraCuts: Cut[] = [];
    for (let i = 0; i < nCut; i++) {
      extraCuts.push(K[3 * i + 2] === 1 ? { row: K[3 * i], col: K[3 * i + 1], kind: "hole" as const } : { row: K[3 * i], col: K[3 * i + 1] });
    }
    const issues: string[] = [], starvedNetIds: string[] = [], starvedPinPositions: BoardPosition[] = [];
    let nEvPins = 0;
    for (let i = 0; i < nEv; i++) nEvPins = Math.max(nEvPins, E[4 * i + 2] + E[4 * i + 3]);
    const P = new Int32Array(buf, h[7], 2 * nEvPins);
    for (let i = 0; i < nEv; i++) {
      const net = nets[E[4 * i + 1]];
      issues.push(E[4 * i] === 0
        ? `Net "${net.name}": no free hole to attach a link wire`
        : `Net "${net.name}": no free hole left for further connections`);
      starvedNetIds.push(net.id);
      for (let k = E[4 * i + 2]; k < E[4 * i + 2] + E[4 * i + 3]; k++) starvedPinPositions.push({ row: P[2 * k], col: P[2 * k + 1] });
    }
    return { wires, extraCuts, wireMess: new Float64Array(buf, h[8], 1)[0], sharedJoints: h[4], issues, starvedNetIds, starvedPinPositions };
  }
}

let active: RouteWasm | null = null;

/** The router every deriveWires call uses from now on. */
export function setRouteWasm(module: WebAssembly.Module): void {
  active = new RouteWasm(module);
}

export function activeRouteWasm(): RouteWasm | null {
  return active;
}
