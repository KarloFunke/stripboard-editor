import { Component, ComponentDef, Cut, BoardPosition } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import { FootprintRect } from "../flexGeometry";
import { rigidGeometry } from "../partGeometry";
import { resolvePackage } from "../packageBodies";
import { leadSiblings } from "../offBoard";
import { AutoLayoutResult } from "../layoutTypes";
import { Rot } from "./tileModel";
import { avoidableBetweenCuts } from "./tidyScore";

// ── The price of a board ──
// One objective for the whole layouter. The anneal scores every skeleton
// with it, the finish keeps a change only when it lowers it, and among
// finished boards the cheapest wins. Area, wires, wire length and cuts; a
// board taller than wide or longer than a 2:1 ribbon; connectors away from
// an edge, pointing into the board or facing the parts; a shaft held over
// the board instead of its edge; the pads of one off-board part apart.

export const W_AREA = 0.35;
export const W_WIRE = 4;       // per link wire
export const W_WLEN = 0.4;     // per row of wire length
export const W_CUT = 0.05;     // cuts are nearly free
export const W_BCUT = 2;       // between-holes cuts stay visibly priced
export const W_BCUT_DRILL = 24; // a knife cut under drilled-cuts-only: worth several wires, so a rotation that avoids one pays
export const W_TALL = 2;       // rows of cells each row beyond the board width costs
export const W_LOCKOVER = 150; // per line over a locked dimension
export const W_SIBLING = 0.5;  // per hole the pads of one off-board part sit further apart than they must
const CONN_FULL = 30;

export type Side = "left" | "right" | "top" | "bottom";
export const ENTRY_SIDE: Record<Rot, Side> = { 0: "right", 90: "bottom", 180: "left", 270: "top" };
export interface ConnSides { top: boolean; bottom: boolean; left: boolean; right: boolean }
export const ALL_SIDES: ConnSides = { top: true, bottom: true, left: true, right: true };

// an unlocked connector: its cells and, for a side-entry package, the edge
// its wires come in from
export interface PricedConn { x: number; y: number; w: number; h: number; entry?: Side }
// room a package holds over the board, in hole-centre terms
export interface PricedShaft { r0: number; r1: number; c0: number; c1: number }
// the pads of one off-board part: their spread and how many they are
export interface PricedGroup { r0: number; r1: number; c0: number; c1: number; n: number }

export interface BoardTerms {
  H: number;
  W: number;
  lockedRowsCap?: number;
  lockedColsCap?: number;
  wires: number;
  wireLen: number;
  cuts: number;
  bCuts: number;
  conns: PricedConn[];
  shafts: PricedShaft[];
  groups: PricedGroup[];
}

export interface PriceBreakdown {
  price: number;
  physH: number;
  physW: number;
  lockOver: number;
  aspectOver: number;
  connEdge: number;
  shaftIn: number;
  sibling: number;
}

export function priceBreakdown(t: BoardTerms, wBCut: number, sides: ConnSides = ALL_SIDES): PriceBreakdown {
  const { H, W, lockedRowsCap, lockedColsCap } = t;
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
  for (const c of t.conns) {
    const FAR = 50;
    const dl = sides.left ? c.x : FAR;
    const dr = sides.right ? physW - (c.x + c.w) : FAR;
    const dt = sides.top ? c.y : FAR;
    const db = sides.bottom ? physH - (c.y + c.h) : FAR;
    const d = Math.min(dl, dr, dt, db);
    // a multi-pin connector should run along its nearest edge, not point
    // into the board, or its external wires come in across the parts. The
    // orientation is priced at any distance, so that a step inward is no
    // way out of it: only a rotation is
    const along = ((dl === d || dr === d) && c.h >= c.w) || ((dt === d || db === d) && c.w >= c.h);
    // a screw terminal that opens toward the parts is as hard to wire as one
    // in the middle of the board, so looking the wrong way costs the same
    const facesOut = !c.entry || { left: dl, right: dr, top: dt, bottom: db }[c.entry] === d;
    connEdge += (d <= 0 ? 0 : d === 1 ? 0.5 * CONN_FULL : d === 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d + (along ? 0 : 0.75 * CONN_FULL) + (facesOut ? 0 : CONN_FULL);
  }
  // a shaft goes through the panel, so it belongs out over the board's
  // edge: whatever share of it lies over the board instead is priced like
  // a connector kept off the edge
  let shaftIn = 0;
  for (const s of t.shafts) {
    const inside =
      Math.max(0, Math.min(s.r1, physH - 0.5) - Math.max(s.r0, -0.5)) * Math.max(0, Math.min(s.c1, physW - 0.5) - Math.max(s.c0, -0.5));
    shaftIn += 30 * (inside / ((s.r1 - s.r0) * (s.c1 - s.c0)));
  }
  // the pads of one off-board part are wired as a bundle, so they are worth
  // keeping together; a small price, well under what an edge place is worth
  let sibling = 0;
  for (const g of t.groups) sibling += W_SIBLING * Math.max(0, g.r1 - g.r0 + (g.c1 - g.c0) - (g.n - 1));
  const price =
    W_AREA * (physH * physW + aspectOver) + W_WIRE * t.wires + W_WLEN * t.wireLen +
    W_CUT * t.cuts + wBCut * t.bCuts + W_LOCKOVER * lockOver + connEdge + shaftIn + sibling;
  return { price, physH, physW, lockOver, aspectOver, connEdge, shaftIn, sibling };
}

// ── Pricing a routed board of components ──
// The finish and the portfolio pick see components with board positions,
// not the anneal's model, so the same terms are read off the parts: a
// connector's cells and entry face, a package's reach, the pads of one
// off-board part. Per-package geometry is cached by definition and turn.

interface PartGeom { conn: boolean; entry?: Side; reach?: FootprintRect }

export class BoardPricer {
  private geom = new Map<string, PartGeom>();
  private groups: string[][];
  private wBCut: number;

  constructor(
    private componentDefs: ComponentDef[],
    components: Component[],
    private limits: { maxRows?: number; maxCols?: number },
    private drilledCutsOnly: boolean
  ) {
    this.groups = leadSiblings(components);
    this.wBCut = drilledCutsOnly ? W_BCUT_DRILL : W_BCUT;
  }

  private geomOf(c: Component, def: ComponentDef): PartGeom {
    const key = `${def.id}|${def.part?.value ?? ""}|${def.part?.package ?? ""}|${c.rotation ?? 0}`;
    let g = this.geom.get(key);
    if (!g) {
      g = { conn: def.category === "connector" };
      if (!def.flexible) {
        const pkg = resolvePackage(def, def.part?.value, def.part?.package);
        if (pkg?.kind === "rigid" && pkg.spec.sideEntry) g.entry = ENTRY_SIDE[c.rotation ?? 0];
        const reach = rigidGeometry(def, { row: 0, col: 0 }, c.rotation).reach;
        if (reach) g.reach = reach;
      }
      this.geom.set(key, g);
    }
    return g;
  }

  terms(virtual: Component[], rows: number, cols: number, cuts: Cut[], wires: { from: BoardPosition; to: BoardPosition }[]): BoardTerms {
    const conns: PricedConn[] = [];
    const shafts: PricedShaft[] = [];
    const posOf = new Map<string, BoardPosition>();
    for (const c of virtual) {
      if (!c.boardPos || c.boardExcluded) continue;
      const def = resolveComponentDef(c, this.componentDefs);
      if (!def) continue;
      posOf.set(c.id, c.boardPos);
      if (c.locked) continue;
      const g = this.geomOf(c, def);
      if (g.conn) {
        if (def.flexible) {
          const e = c.flexibleEndPos ?? c.boardPos;
          const y = Math.min(c.boardPos.row, e.row), x = Math.min(c.boardPos.col, e.col);
          conns.push({ x, y, w: Math.abs(c.boardPos.col - e.col) + 1, h: Math.abs(c.boardPos.row - e.row) + 1 });
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          conns.push({ x: b.minCol, y: b.minRow, w: b.maxCol - b.minCol + 1, h: b.maxRow - b.minRow + 1, entry: g.entry });
        }
      }
      if (g.reach) {
        shafts.push({
          r0: c.boardPos.row + g.reach.minRow - 0.5, r1: c.boardPos.row + g.reach.maxRow + 0.5,
          c0: c.boardPos.col + g.reach.minCol - 0.5, c1: c.boardPos.col + g.reach.maxCol + 0.5,
        });
      }
    }
    const groups: PricedGroup[] = [];
    for (const ids of this.groups) {
      let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity, n = 0;
      for (const id of ids) {
        const p = posOf.get(id);
        if (!p) continue;
        n++;
        r0 = Math.min(r0, p.row); r1 = Math.max(r1, p.row);
        c0 = Math.min(c0, p.col); c1 = Math.max(c1, p.col);
      }
      if (n > 1) groups.push({ r0, r1, c0, c1, n });
    }
    let knife = 0;
    for (const k of cuts) if (k.kind !== "hole") knife++;
    const bCuts = this.drilledCutsOnly ? avoidableBetweenCuts(cuts, virtual, this.componentDefs) : knife;
    let wireLen = 0;
    for (const w of wires) wireLen += Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
    return {
      H: rows, W: cols, lockedRowsCap: this.limits.maxRows, lockedColsCap: this.limits.maxCols,
      wires: wires.length, wireLen, cuts: cuts.length, bCuts, conns, shafts, groups,
    };
  }

  price(virtual: Component[], rows: number, cols: number, cuts: Cut[], wires: { from: BoardPosition; to: BoardPosition }[]): number {
    return priceBreakdown(this.terms(virtual, rows, cols, cuts, wires), this.wBCut).price;
  }
}

/** The price of a finished layout, for the pick among workers and the harness. */
export function priceResult(
  result: AutoLayoutResult,
  board: { rows: number; cols: number; lockedRows?: boolean; lockedCols?: boolean },
  components: Component[],
  componentDefs: ComponentDef[],
  drilledCutsOnly = false
): number {
  if (!result.boardSize) return Infinity;
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  const virtual = components.map((c) => {
    const p = byId.get(c.id);
    return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
  });
  const pricer = new BoardPricer(componentDefs, components, {
    ...(board.lockedRows ? { maxRows: board.rows } : {}),
    ...(board.lockedCols ? { maxCols: board.cols } : {}),
  }, drilledCutsOnly);
  return pricer.price(virtual, result.boardSize.rows, result.boardSize.cols, result.cuts, result.wires);
}
