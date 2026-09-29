// The TypeScript side of the WebAssembly decoder (decode.c): writes the
// anneal's model into the module's memory once, then per proposal the genome
// in and the measurement out. Owns one instance per solve.

export interface WasmShape {
  w: number; h: number;
  entry: number; // 0 left, 1 right, 2 top, 3 bottom, -1 none
  body: [number, number, number, number]; // minRow, maxRow, minCol, maxCol
  reach?: [number, number, number, number];
  pins: { rowOff: number; colOff: number; net: number }[]; // net -1: none
}
export interface WasmFlex {
  na: number; nb: number; minS: number; maxS: number; canH: boolean; dc0: number;
  vd: boolean[]; // allowed vertical spans, index 0..maxS
  hasSpec: boolean; shape: number; mark: boolean; len: number; r: number; // body (partGeometry flexBody)
}
export interface WasmPart {
  kind: 0 | 1; locked: boolean; isConn: boolean; clr: number; lines: number; fat: boolean;
  idx: number; // position in rigidIdx / flexIdx
  sides: number; // connector edges bit mask (1 left, 2 right, 4 top, 8 bottom), -1: the solve's default
  lockY0: number; lockY1: number; lockX: number; lockRot: number;
  shapes?: WasmShape[]; // rigid: one per rotation index
  flex?: WasmFlex;
}
export interface WasmModel {
  parts: WasmPart[];
  nNets: number;
  netPins: { pi: number; kind: 0 | 1; end: number; pinIdx: number[] }[][];
  flexIdx: number[]; rigidIdx: number[];
  siblingGroups: number[][];
  mRow: number; mCol: number;
  lockedRowsCap: number; lockedColsCap: number; // -1: free
  sidesDef: number; clrPad: number; wBCut: number;
  // the moves: throwable connectors, per net its distinct parts (nets with
  // two or more) and that net's index, half-turn-only per rigid part,
  // both-ways per flex part, rigid parts a rotation changes
  conns: number[]; pullNets: number[][]; pullNet: number[]; halfTurn: boolean[]; canHV: boolean[]; rotK: number[];
}

// the anneal's schedule (autoLayout5.ts solveSeed)
export interface WasmAnneal {
  seedState: number; strictSeed: number; protect: number; movesN: number; timed: boolean; budgetMs: number;
  t0: number; tEnd: number; coldT: number; cool: number; rampStart: number; rampEnd: number; hardStart: number;
  reportEvery: number; lean: boolean;
}

// what one decode came to (decode.c outI/outD)
export interface WasmDecodeOut {
  status: 0 | 1 | 2; // infeasible, the reference board, a new board
  nNode: number; H: number; W: number;
  wires: number; wireLen: number; relays: number; cuts: number; bCuts: number;
  starved: number; starvedHard: number; geoBad: number; overlapBad: number; lockOver: number; spanBad: number;
  slants: number; crossings: number;
  eBase: number; hardPen: number; connEdge: number;
  yI: Int32Array; xI: Int32Array;
}

// the decoded board and the decoder's steps (decode.c v5_setExport): segments
// (row, c1, c2, net), cuts (row, col, knife, pin column) and wires (r1, c1,
// r2, c2, net, slanted, crossings) flat, in the order they arose
export interface WasmExport {
  segs: Int32Array; cuts: Int32Array; wires: Int32Array; busRows: number[]; GH: number; GW: number; trace: Float64Array;
}

export interface WasmGenome { gp: number[]; gn: number[]; rot: number[]; hv: number[]; br: number[]; grp: number[][]; gap: number[]; xgap: number[] }

export class V5WasmDecoder {
  private ex: Record<string, (...a: number[]) => number>;
  private mem: WebAssembly.Memory;
  private buf: ArrayBuffer | null = null;
  private i32!: Int32Array;
  private f64!: Float64Array;
  private addr: number[] = [];
  private nP: number; private nFlex: number; private nRigid: number; private nNP: number;
  private grpOff: number[];
  // progress of the anneal loop, called with the schedule's share
  onReport: (f: number) => void = () => {};
  // harness move log: a batch of rows, ML_W values each (decode.c mlRecord)
  onMoveLog: (rows: Float64Array, n: number) => void = () => {};

  constructor(module: WebAssembly.Module, m: WasmModel) {
    const inst = new WebAssembly.Instance(module, { env: { now: () => performance.now(), pow: Math.pow, exp: Math.exp, report: (f: number) => this.onReport(f),
      movelog: (ptr: number, n: number) => { this.view(); this.onMoveLog(new Float64Array(this.buf!, ptr, 20 * n), n); } } });
    this.ex = inst.exports as unknown as Record<string, (...a: number[]) => number>;
    this.mem = inst.exports.memory as WebAssembly.Memory;
    this.nP = m.parts.length; this.nFlex = m.flexIdx.length; this.nRigid = m.rigidIdx.length;
    this.grpOff = [];
    let off = 0;
    for (const pins of m.netPins) { this.grpOff.push(off); off += pins.length; }
    this.nNP = off;
    this.ex.v5_reset();
    const { ints, dbls } = serialize(m);
    const pi = this.ex.v5_alloc(ints.length * 4), pd = this.ex.v5_alloc(dbls.length * 8);
    this.view();
    this.i32.set(ints, pi >> 2);
    this.f64.set(dbls, pd >> 3);
    const hdr = this.ex.v5_init(pi, pd);
    this.view();
    this.addr = Array.from(this.i32.subarray(hdr >> 2, (hdr >> 2) + 30));
  }

  private view() {
    if (this.buf !== this.mem.buffer) {
      this.buf = this.mem.buffer;
      this.i32 = new Int32Array(this.buf);
      this.f64 = new Float64Array(this.buf);
    }
  }
  private at(k: number) { return this.addr[k] >> 2; }

  // copies the genome in (grp is written back by decode(), see grpBack)
  writeGenome(g: WasmGenome) {
    this.view();
    const a = this.i32;
    a.set(g.gp, this.at(0)); a.set(g.gn, this.at(1)); a.set(g.rot, this.at(2)); a.set(g.hv, this.at(3)); a.set(g.br, this.at(4));
    a.set(g.gap, this.at(5)); a.set(g.xgap, this.at(6));
    const gr = this.at(7);
    for (let n = 0; n < g.grp.length; n++) a.set(g.grp[n], gr + this.grpOff[n]);
    // no reference board to compare the decode with
    a[this.at(8)] = 0;
  }

  decode(): WasmDecodeOut {
    this.ex.v5_decode();
    this.view();
    const a = this.i32, o = this.at(13), d = this.addr[14] >> 3;
    const status = a[o] as 0 | 1 | 2, nNode = a[o + 1];
    return {
      status, nNode, H: a[o + 2], W: a[o + 3], wires: a[o + 4], wireLen: a[o + 5], relays: a[o + 6], cuts: a[o + 7], bCuts: a[o + 8],
      starved: a[o + 9], starvedHard: a[o + 10], geoBad: a[o + 11], overlapBad: a[o + 12], lockOver: a[o + 13], spanBad: a[o + 14],
      slants: a[o + 15], crossings: a[o + 16],
      eBase: this.f64[d], hardPen: this.f64[d + 1], connEdge: this.f64[d + 2],
      yI: a.slice(this.at(15), this.at(15) + nNode), xI: a.slice(this.at(16), this.at(16) + this.nP),
    };
  }

  // the decodes from here on also export their board, and with trace their steps
  setExport(on: boolean, trace = false) { this.ex.v5_setExport(on ? 1 : 0, trace ? 1 : 0); }

  // the cooling curve's shape (decode.c L_shape; 1 is the plain curve)
  setShape(p: number) { this.ex.v5_setShape(p); }

  // the move mix (decode.c mixEarly/mixLate, 13 entries each; a table of 12,
  // as the harness took before pull and tie, has none of it) and the share
  // of the walk from which the late table applies (above 1: never)
  setMix(early: number[], late: number[] = early, lateFrom = 2) {
    for (let k = 0; k < 13; k++) { this.ex.v5_setMix(0, k, early[k] ?? 0); this.ex.v5_setMix(1, k, late[k] ?? 0); }
    this.ex.v5_setMixLateFrom(lateFrom);
  }
  // the default mix with or without pull and tie (decode.c setPullTie)
  setPullTie(on: boolean) { this.ex.v5_setPullTie(on ? 1 : 0); }
  exported(): WasmExport {
    const h = this.ex.v5_exportHdr() >> 2;
    this.view();
    const a = this.i32;
    const ints = (n: number, ptr: number) => a.slice(ptr >> 2, (ptr >> 2) + n);
    return {
      segs: ints(4 * a[h], a[h + 1]), cuts: ints(4 * a[h + 2], a[h + 3]), wires: ints(7 * a[h + 4], a[h + 5]),
      busRows: Array.from(ints(a[h + 6], a[h + 7])), GH: a[h + 8], GW: a[h + 9],
      trace: this.f64.slice(a[h + 11] >> 3, (a[h + 11] >> 3) + a[h + 10]),
    };
  }

  // the lab (explainer): its random state, a starting genome, one move
  rngSet(state: number) { this.ex.v5_rngSet(state >>> 0); }
  rngGet(): number { return this.ex.v5_rngGet() >>> 0; }
  rand(): number { return this.ex.v5_rand(); }
  labInit(): WasmGenome {
    this.ex.v5_labInit();
    return this.genomeAt(0);
  }
  labMutate(g: WasmGenome): WasmGenome | null {
    this.view();
    const a = this.i32;
    a.set(g.gp, this.at(18)); a.set(g.gn, this.at(19)); a.set(g.rot, this.at(20)); a.set(g.hv, this.at(21)); a.set(g.br, this.at(22));
    a.set(g.gap, this.at(23)); a.set(g.xgap, this.at(24));
    for (let n = 0; n < g.grp.length; n++) a.set(g.grp[n], this.at(25) + this.grpOff[n]);
    return this.ex.v5_labMutate() ? this.genomeAt(0) : null;
  }
  // a genome from the proposal buffers (base 0) or the current ones (base 18)
  private genomeAt(base: number): WasmGenome {
    this.view();
    const a = this.i32;
    const arr = (k: number, n: number) => Array.from(a.subarray(this.at(base + k), this.at(base + k) + n));
    const grpAll = arr(7, this.nNP);
    return {
      gp: arr(0, this.nP), gn: arr(1, this.nP), rot: arr(2, this.nRigid), hv: arr(3, this.nFlex), br: arr(4, this.nFlex),
      grp: this.grpOff.map((o, n) => grpAll.slice(o, n + 1 < this.grpOff.length ? this.grpOff[n + 1] : this.nNP)),
      gap: arr(5, this.nP), xgap: arr(6, this.nP),
    };
  }

  setMoveLog(on: boolean) { this.ex.v5_setMoveLog(on ? 1 : 0); }
  annealStart(a: WasmAnneal) {
    this.ex.v5_annealStart(a.seedState, a.strictSeed, a.protect, a.movesN, a.timed ? 1 : 0, a.budgetMs,
      a.t0, a.tEnd, a.coldT, a.cool, a.rampStart, a.rampEnd, a.hardStart, a.reportEvery, a.lean ? 1 : 0);
  }
  // runs the walk to its next event: 1 (the start or a new best, see cur()),
  // 0 done, -1 no starting genome decodes
  annealStep(): number { return this.ex.v5_annealStep(); }
  // the loop's current genome and board, and where the walk is
  cur(): { g: WasmGenome; o: WasmDecodeOut; it: number; frac: number; E: number } {
    this.view();
    const a = this.i32, f = this.f64;
    const g = this.genomeAt(18);
    const c = this.at(26), d = this.addr[27] >> 3, nNode = a[this.at(8) + 1];
    const o: WasmDecodeOut = {
      status: 2, nNode, H: a[c + 2], W: a[c + 3], wires: a[c + 4], wireLen: a[c + 5], relays: a[c + 6], cuts: a[c + 7], bCuts: a[c + 8],
      starved: a[c + 9], starvedHard: a[c + 10], geoBad: a[c + 11], overlapBad: a[c + 12], lockOver: a[c + 13], spanBad: a[c + 14],
      slants: a[c + 15], crossings: a[c + 16],
      eBase: f[d], hardPen: f[d + 1], connEdge: f[d + 2],
      yI: a.slice(this.at(9), this.at(9) + nNode), xI: a.slice(this.at(10), this.at(10) + this.nP),
    };
    const li = this.at(28), ld = this.addr[29] >> 3;
    return { g, o, it: a[li], frac: f[ld], E: f[ld + 1] };
  }

  // the decoder's strip-group write-back into the genome; true if any changed
  grpBack(grp: number[][]): boolean {
    this.view();
    const a = this.i32, gr = this.at(7);
    let changed = false;
    for (let n = 0; n < grp.length; n++) {
      const row = grp[n], base = gr + this.grpOff[n];
      for (let k = 0; k < row.length; k++) if (row[k] !== a[base + k]) { row[k] = a[base + k]; changed = true; }
    }
    return changed;
  }
}

function serialize(m: WasmModel): { ints: Int32Array; dbls: Float64Array } {
  const I: number[] = [], D: number[] = [];
  const P = m.parts, nP = P.length;
  let nShapes = 0, nShapePins = 0, nVd = 0, totalPins = 0;
  for (const p of P) {
    if (p.shapes) { nShapes += p.shapes.length; for (const s of p.shapes) nShapePins += s.pins.length; totalPins += p.shapes[0].pins.length; }
    if (p.flex) { nVd += p.flex.vd.length; totalPins += 2; }
  }
  const nNP = m.netPins.reduce((n, l) => n + l.length, 0);
  const maxK = Math.max(1, ...m.netPins.map((l) => l.length));
  const nSibPi = m.siblingGroups.reduce((n, g) => n + g.length, 0);
  I.push(nP, m.nNets, m.flexIdx.length, m.rigidIdx.length, m.mRow, m.mCol, m.lockedRowsCap, m.lockedColsCap, m.sidesDef, nNP, m.clrPad,
    m.nNets + totalPins, maxK, m.siblingGroups.length, nShapes, nShapePins, nVd, nSibPi);
  D.push(m.wBCut);
  const col = (f: (p: WasmPart) => number) => { for (const p of P) I.push(f(p)); };
  const b = (x: boolean | undefined) => (x ? 1 : 0);
  col((p) => p.kind); col((p) => b(p.locked)); col((p) => b(p.isConn)); col((p) => p.clr); col((p) => p.lines); col((p) => b(p.fat));
  col((p) => p.idx); col((p) => p.sides); col((p) => p.lockY0); col((p) => p.lockY1); col((p) => p.lockX); col((p) => p.lockRot);
  let sb = 0;
  col((p) => { if (!p.shapes) return -1; const s = sb; sb += p.shapes.length; return s; });
  col((p) => p.flex?.na ?? -1); col((p) => p.flex?.nb ?? -1); col((p) => p.flex?.minS ?? 0); col((p) => p.flex?.maxS ?? 0);
  col((p) => b(p.flex?.canH)); col((p) => p.flex?.dc0 ?? 0);
  let vo = 0;
  col((p) => { if (!p.flex) return 0; const o = vo; vo += p.flex.vd.length; return o; });
  col((p) => b(p.flex?.hasSpec)); col((p) => p.flex?.shape ?? 0); col((p) => b(p.flex?.mark));
  for (const p of P) D.push(p.flex?.len ?? 0);
  for (const p of P) D.push(p.flex?.r ?? 0);
  for (const p of P) if (p.flex) for (const v of p.flex.vd) I.push(b(v));
  const shapes = P.flatMap((p) => p.shapes ?? []);
  for (const s of shapes) I.push(s.w);
  for (const s of shapes) I.push(s.h);
  for (const s of shapes) I.push(s.entry);
  let ps = 0;
  for (const s of shapes) { I.push(ps); ps += s.pins.length; }
  for (const s of shapes) I.push(s.pins.length);
  for (const s of shapes) I.push(b(!!s.reach));
  for (const s of shapes) D.push(...s.body);
  for (const s of shapes) D.push(...(s.reach ?? [0, 0, 0, 0]));
  for (const s of shapes) for (const q of s.pins) I.push(q.rowOff);
  for (const s of shapes) for (const q of s.pins) I.push(q.colOff);
  for (const s of shapes) for (const q of s.pins) I.push(q.net);
  let np = 0;
  for (const l of m.netPins) { I.push(np); np += l.length; }
  I.push(np);
  const all = m.netPins.flat();
  for (const q of all) I.push(q.pi);
  for (const q of all) I.push(q.kind);
  for (const q of all) I.push(q.end);
  for (const q of all) I.push(q.pinIdx[0], q.pinIdx[1], q.pinIdx[2], q.pinIdx[3]);
  I.push(...m.flexIdx, ...m.rigidIdx);
  let so = 0;
  for (const g of m.siblingGroups) { I.push(so); so += g.length; }
  I.push(so);
  for (const g of m.siblingGroups) I.push(...g);
  I.push(m.conns.length, ...m.conns);
  I.push(m.pullNets.length);
  let po = 0;
  for (const l of m.pullNets) { I.push(po); po += l.length; }
  I.push(po);
  for (const l of m.pullNets) I.push(...l);
  I.push(...m.pullNet);
  for (const h of m.halfTurn) I.push(b(h));
  for (const c of m.canHV) I.push(b(c));
  I.push(m.rotK.length, ...m.rotK);
  return { ints: Int32Array.from(I), dbls: Float64Array.from(D) };
}
