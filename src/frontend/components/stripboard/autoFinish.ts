import {
  Board,
  BoardPosition,
  Component,
  ComponentDef,
  Cut,
  Net,
  NetAssignment,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  getComponentBounds,
  getComponentPinPositions,
  getFlexiblePinPositions,
  getRotatedBodyCells,
} from "./boardLayout";
import { computeStripSegments, StripSegment } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { bodyStyle } from "./componentGlyphs";
import {
  WIRE_OFFAXIS_FREE,
  WIRE_OFFAXIS_RATE,
  WireObstacleIndex,
  WireObstacles,
  corridorHoles,
  segmentsOverlapCollinear,
} from "./flexGeometry";

export interface AutoFinishResult {
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
}

// The raw completion derivation, also used as the layout optimizer's cost
// evaluator: what would it take to make this placement work?
export interface CompletionPlan {
  cuts: Cut[];
  wires: { from: BoardPosition; to: BoardPosition }[];
  issues: string[];
  unresolvedConflicts: number;
  // Nets left without a free hole for a needed or future wire — the layout
  // optimizer uses these to target its repair moves
  starvedNetIds: string[];
  // Pin positions of the exact strip groups that ran out of free holes:
  // repair moves should clear the air around these spots, not around every
  // pin the net has
  starvedPinPositions: BoardPosition[];
  // Total extra effective wire length (holes) the chosen wires pay for
  // being messy: long off-axis runs and crossings over components. The
  // layout evaluator prices this like real wire length.
  wireMess: number;
  // Link wires that had to share a component pin's hole (soldered into the
  // joint) because their segment had no free hole. Legal but last-resort:
  // the ladder keeps exploring alternatives while any remain.
  sharedJoints: number;
}

interface BoardPin {
  row: number;
  col: number;
  // Net id for assigned pins. Unassigned pins get a unique key so they are
  // isolated with cuts: a floating pin silently tied to a net's strip would
  // change the circuit relative to the schematic.
  netKey: string;
  netId: string | null;
}

function holeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Collect every placed, on-board pin with its net key */
function collectBoardPins(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): BoardPin[] {
  const pins: BoardPin[] = [];
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) {
    netOfPin.set(`${a.componentId}:${a.pinId}`, a.netId);
  }
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      if (pin.row < 0 || pin.row >= board.rows || pin.col < 0 || pin.col >= board.cols) continue;
      const netId = netOfPin.get(`${comp.id}:${pin.pinId}`);
      pins.push({
        row: pin.row,
        col: pin.col,
        netKey: netId ?? `nc:${comp.id}:${pin.pinId}`,
        netId: netId ?? null,
      });
    }
  }
  return pins;
}

/**
 * Holes that cannot take a jumper endpoint: component pins, body cells
 * (including everything under an IC), flexible-component body corridors,
 * and drilled-out holes. Wire endpoints do NOT block: several wires may
 * share one hole (daisy chains), they just may not run on top of each other.
 */
/**
 * Parts whose under-body holes stay reachable for wire endpoints, because
 * they stand on header sockets. Built-in modules classify via bodyStyle;
 * user-built ones are recognized by shape — two edge pin columns far apart
 * and a header-scale pin count. Flat wide parts with few pins (relays)
 * stay fully blocking.
 */
function standsOnHeaders(def: ComponentDef): boolean {
  if (bodyStyle(def) === "board") return true;
  if (def.pins.length < 10) return false;
  const cols = def.pins.map((p) => p.offsetCol);
  return new Set(cols).size >= 2 && Math.max(...cols) - Math.min(...cols) > 3;
}

function collectOccupiedHoles(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  pins: BoardPin[]
): Set<string> {
  const occupied = new Set<string>();

  for (const pin of pins) {
    occupied.add(holeKey(pin.row, pin.col));
  }

  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      // Block the corridor along the body line (handles diagonal placements;
      // for a vertical part this is exactly the holes between the pins).
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (!p1 || !p2) continue;
      for (const hole of corridorHoles(p1, p2)) {
        occupied.add(holeKey(hole.row, hole.col));
      }
    } else if (!standsOnHeaders(def)) {
      // Flat-bodied rigids (DIPs, TO-92s) sit on the board and their body
      // holes are unreachable. Module breakout boards stand on header
      // sockets: the holes under them stay solderable, so only their pins
      // block wire endpoints — locked ESP32-class modules at a board edge
      // are unroutable otherwise, and humans do solder there.
      for (const cell of getRotatedBodyCells(def, comp.boardPos, comp.rotation)) {
        occupied.add(holeKey(cell.row, cell.col));
      }
    }
  }

  for (const cut of board.cuts) {
    if (cut.kind === "hole") occupied.add(holeKey(cut.row, cut.col));
  }

  return occupied;
}

/**
 * Pick the cut position inside the gap [colA, colB-1] that leaves both sides
 * the most usable free holes. A blind mid-gap cut can strand a pin in a
 * segment whose remaining holes all sit under an IC body — such a segment
 * can never take a jumper endpoint.
 */
function bestCutPosition(
  row: number,
  colA: number,
  colB: number,
  occupied: Set<string>,
  gLo = colA,
  gHi = colB - 1
): number {
  const mid = (colA + colB - 1) / 2;
  let bestG = Math.max(gLo, Math.min(gHi, Math.floor(mid)));
  let bestScore = -Infinity;
  for (let g = gLo; g <= gHi; g++) {
    let left = 0;
    let right = 0;
    for (let c = colA + 1; c <= g; c++) if (!occupied.has(holeKey(row, c))) left++;
    for (let c = g + 1; c < colB; c++) if (!occupied.has(holeKey(row, c))) right++;
    const score = Math.min(left, right) * 1000 - Math.abs(g - mid);
    if (score > bestScore) {
      bestScore = score;
      bestG = g;
    }
  }
  return bestG;
}

/**
 * Derive the cuts needed so that no two different nets (or floating pins)
 * share a strip segment. Cuts between adjacent pins of different nets are
 * forced. Existing cuts are respected (augment, not regenerate).
 */
function deriveCuts(
  board: Board,
  pins: BoardPin[],
  occupied: Set<string>,
  issues: string[],
  reserveNets?: Set<string>
): Cut[] {
  // gap g on a row = the copper between col g and col g+1 is severed
  const severedGaps = new Set<string>();
  for (const cut of board.cuts) {
    if (cut.kind === "hole") {
      severedGaps.add(`${cut.row}:${cut.col - 1}`);
      severedGaps.add(`${cut.row}:${cut.col}`);
    } else {
      severedGaps.add(`${cut.row}:${cut.col}`);
    }
  }

  // Group pins per row and column
  const rows = new Map<number, Map<number, Set<string>>>();
  for (const pin of pins) {
    if (!rows.has(pin.row)) rows.set(pin.row, new Map());
    const cols = rows.get(pin.row)!;
    if (!cols.has(pin.col)) cols.set(pin.col, new Set());
    cols.get(pin.col)!.add(pin.netKey);
  }

  // ── Run census ──
  // A run = a maximal stretch of same-net pins on one row; holes between
  // its pins always stay on its copper. A net whose pins sit in more than
  // one run (or that still awaits unplaced parts) needs link wires, so
  // every one of its runs must end the cut pass with a free hole. That
  // knowledge steers each cut position below instead of being discovered
  // as starvation during routing.
  interface Run { key: string; minCol: number; maxCol: number; freeInside: number }
  const runsByRow = new Map<number, Run[]>();
  const runCount = new Map<string, number>();
  for (const [row, cols] of rows) {
    const sortedCols = Array.from(cols.keys()).sort((a, b) => a - b);

    for (const col of sortedCols) {
      if (cols.get(col)!.size > 1) {
        issues.push(`Pins of different nets overlap at row ${row + 1}, col ${col + 1}`);
      }
    }

    const runs: Run[] = [];
    for (const col of sortedCols) {
      const key = cols.get(col)!.values().next().value!;
      const last = runs[runs.length - 1];
      if (last && last.key === key) {
        for (let c = last.maxCol + 1; c < col; c++) {
          if (!occupied.has(holeKey(row, c))) last.freeInside++;
        }
        last.maxCol = col;
      } else {
        runs.push({ key, minCol: col, maxCol: col, freeInside: 0 });
      }
    }
    runsByRow.set(row, runs);
    for (const r of runs) runCount.set(r.key, (runCount.get(r.key) ?? 0) + 1);
  }
  // floating pins have a unique key each, so their count stays 1
  const needy = (key: string) =>
    (runCount.get(key) ?? 0) > 1 || (reserveNets?.has(key) ?? false);

  const newCuts: Cut[] = [];
  for (const [row, runs] of runsByRow) {
    // free holes the leading run already owns on its board-edge side
    let carry = 0;
    if (runs.length > 0) {
      for (let c = 0; c < runs[0].minCol; c++) if (!occupied.has(holeKey(row, c))) carry++;
    }
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = runs[i];
      const b = runs[i + 1];
      const colA = a.maxCol;
      const colB = b.minCol;

      let sevMax = -1;
      for (let g = colA; g < colB; g++) {
        if (severedGaps.has(`${row}:${g}`)) sevMax = g;
      }
      const gapFree: number[] = [];
      for (let c = colA + 1; c < colB; c++) {
        if (!occupied.has(holeKey(row, c))) gapFree.push(c);
      }
      if (sevMax >= 0) {
        carry = gapFree.filter((c) => c > sevMax).length;
        continue;
      }

      // Allocate the gap's free holes: the left run's flanks are final
      // after this cut, so it gets the leftmost free hole when it still
      // has none; the right run keeps the rightmost when it may need one
      // and enough holes exist for both.
      const aNeeds = needy(a.key) && a.freeInside === 0 && carry === 0;
      const bNeeds = needy(b.key) && b.freeInside === 0;
      let gLo = colA;
      let gHi = colB - 1;
      if (aNeeds && gapFree.length > 0) gLo = gapFree[0];
      if (bNeeds && gapFree.length > 0 && (!aNeeds || gapFree.length >= 2)) {
        gHi = Math.max(gLo, gapFree[gapFree.length - 1] - 1);
      }
      const cutCol = bestCutPosition(row, colA, colB, occupied, gLo, gHi);
      newCuts.push({ row, col: cutCol });
      severedGaps.add(`${row}:${cutCol}`);
      carry = gapFree.filter((c) => c > cutCol).length;
    }
  }
  return newCuts;
}

/**
 * Builders usually sever a strip by drilling out a hole, not by cutting the
 * copper between holes. Upgrade each derived between-cut to a drilled hole
 * on one of the two holes flanking its gap, keeping the between-cut only
 * when neither flank can be sacrificed. A flank qualifies if it carries no
 * pin, wire endpoint, or existing drill. Holes under rigid bodies and
 * flexible-part corridors are the preferred sacrifice (drilled before the
 * part is mounted, they give up nothing usable — the classic under-IC cut,
 * just off-center); free holes come second, except the last free hole of a
 * segment whose net still awaits unplaced parts. This runs after routing,
 * so the sacrificed holes are provably surplus and the derived wires stay
 * exactly as they were.
 */
function upgradeCutsToDrills(
  cuts: Cut[],
  segments: StripSegment[],
  occupied: Set<string>,
  noDrill: Set<string>,
  reserveNets: Set<string>
): Cut[] {
  const segsByRow = new Map<number, StripSegment[]>();
  for (const s of segments) {
    if (!segsByRow.has(s.row)) segsByRow.set(s.row, []);
    segsByRow.get(s.row)!.push(s);
  }
  const freeCount = new Map<StripSegment, number>();
  const freeOf = (s: StripSegment): number => {
    let n = freeCount.get(s);
    if (n === undefined) {
      n = 0;
      for (let c = s.startCol; c <= s.endCol; c++) if (!occupied.has(holeKey(s.row, c))) n++;
      freeCount.set(s, n);
    }
    return n;
  };
  const drilled = new Set<string>();
  return cuts.map((cut) => {
    if (cut.kind === "hole") return cut;
    let best: { col: number; seg: StripSegment; free: boolean; left: number } | null = null;
    for (const col of [cut.col, cut.col + 1]) {
      const key = holeKey(cut.row, col);
      if (noDrill.has(key) || drilled.has(key)) continue;
      const seg = segsByRow.get(cut.row)?.find((s) => s.startCol <= col && col <= s.endCol);
      if (!seg) continue;
      const free = !occupied.has(key);
      const left = freeOf(seg) - (free ? 1 : 0);
      if (free && left < 1 && seg.netIds.some((n) => reserveNets.has(n))) continue;
      if (!best || (best.free && !free) || (best.free === free && left > best.left)) {
        best = { col, seg, free, left };
      }
    }
    if (!best) return cut;
    if (best.free) freeCount.set(best.seg, best.left);
    drilled.add(holeKey(cut.row, best.col));
    return { row: cut.row, col: best.col, kind: "hole" as const };
  });
}

/**
 * Connect each net's disconnected strip groups with jumper wires (Prim-style
 * MST: always join the nearest pair of free holes). Wires may share endpoint
 * holes but must not run collinearly on top of another wire — unless that is
 * the only way to complete the net.
 */
function deriveWires(
  segments: StripSegment[],
  groups: { segmentIndices: number[] }[],
  nets: Net[],
  pins: BoardPin[],
  occupied: Set<string>,
  existingWires: { from: BoardPosition; to: BoardPosition }[],
  reserveNets: Set<string>,
  obstacleIndex: WireObstacleIndex,
  issues: string[],
  starvedNetIds: string[],
  starvedPinPositions: BoardPosition[],
  allowSharedJoints: boolean,
  skipRelays = false
): {
  wires: { from: BoardPosition; to: BoardPosition }[];
  extraCuts: { row: number; col: number }[];
  wireMess: number;
  sharedJoints: number;
} {
  const segsByRow = new Map<number, { idx: number; startCol: number; endCol: number }[]>();
  segments.forEach((s, idx) => {
    if (!segsByRow.has(s.row)) segsByRow.set(s.row, []);
    segsByRow.get(s.row)!.push({ idx, startCol: s.startCol, endCol: s.endCol });
  });
  const segIndexAt = (row: number, col: number) => {
    for (const e of segsByRow.get(row) ?? []) {
      if (col >= e.startCol && col <= e.endCol) return e.idx;
    }
    return -1;
  };

  const segToGroup = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const si of g.segmentIndices) segToGroup.set(si, gi);
  });

  // Free holes per group, computed once: `occupied` never changes during
  // routing (wire endpoints do not consume holes), so the sets are static.
  const groupFreeCache = new Map<number, BoardPosition[]>();
  const freeHolesOfGroup = (gi: number): BoardPosition[] => {
    let holes = groupFreeCache.get(gi);
    if (!holes) {
      holes = [];
      for (const si of groups[gi].segmentIndices) {
        const seg = segments[si];
        for (let c = seg.startCol; c <= seg.endCol; c++) {
          if (!occupied.has(holeKey(seg.row, c))) holes.push({ row: seg.row, col: c });
        }
      }
      groupFreeCache.set(gi, holes);
    }
    return holes;
  };

  // Groups and free-hole supply per net, computed once. Wire endpoints do
  // not consume holes (same-net wires may chain on one hole), so the only
  // cross-net coupling in routing is collinear overlap: whichever net routes
  // first takes the clean straight paths. Route the nets with the fewest
  // free holes (fewest path options) first; nets with room can detour.
  const netGroupIdxs = new Map<string, Set<number>>();
  for (const pin of pins) {
    if (!pin.netId) continue;
    const si = segIndexAt(pin.row, pin.col);
    if (si >= 0 && segToGroup.has(si)) {
      if (!netGroupIdxs.has(pin.netId)) netGroupIdxs.set(pin.netId, new Set());
      netGroupIdxs.get(pin.netId)!.add(segToGroup.get(si)!);
    }
  }
  const freeSupply = (netId: string): number => {
    let n = 0;
    for (const gi of netGroupIdxs.get(netId) ?? []) n += freeHolesOfGroup(gi).length;
    return n;
  };
  const routable = nets.filter((n) => (netGroupIdxs.get(n.id)?.size ?? 0) > 0);
  const baseOrder = [...routable].sort((a, b) => freeSupply(a.id) - freeSupply(b.id));

  // Pins per group, to report exactly where a starved group sits
  const groupPins = new Map<number, BoardPosition[]>();
  for (const pin of pins) {
    const si = segIndexAt(pin.row, pin.col);
    if (si < 0 || !segToGroup.has(si)) continue;
    const gi = segToGroup.get(si)!;
    if (!groupPins.has(gi)) groupPins.set(gi, []);
    groupPins.get(gi)!.push({ row: pin.row, col: pin.col });
  }
  const starvedGroupPins = (groupIdxs: Set<number>): BoardPosition[] => {
    const out: BoardPosition[] = [];
    for (const gi of groupIdxs) {
      if (freeHolesOfGroup(gi).length === 0) out.push(...(groupPins.get(gi) ?? []));
    }
    return out;
  };

  // Relay strips: copper a net may claim to travel horizontally with two
  // vertical hop wires — the human way to avoid a long slanted wire. Two
  // kinds: pin-free copper groups (free as they are), and the free TAIL of
  // a used segment, donated at the price of one new cut severing the tail
  // from the donor's pins. A claimed relay belongs to its net for the rest
  // of the pass (its copper is live).
  const byColOf = (holes: BoardPosition[]): Map<number, number[]> => {
    const m = new Map<number, number[]>();
    for (const h of holes) {
      if (!m.has(h.col)) m.set(h.col, []);
      m.get(h.col)!.push(h.row);
    }
    return m;
  };
  interface RelayCand {
    holes: BoardPosition[];
    holeSet: Set<string>;
    byCol: Map<number, number[]>;
    // Tail donation only: the severing cut (gap col), the donor group whose
    // free holes shrink by `holes`, and its net
    cut?: { row: number; col: number };
    donorGroup?: number;
    donorNet?: string;
    donorNeedy?: boolean;
  }
  const relayCands: RelayCand[] = [];
  groups.forEach((_, gi) => {
    if (skipRelays || groupPins.has(gi)) return;
    const holes = freeHolesOfGroup(gi);
    if (holes.length === 0) return;
    relayCands.push({ holes, holeSet: new Set(holes.map((h) => holeKey(h.row, h.col))), byCol: byColOf(holes) });
  });
  segments.forEach((seg, si) => {
    if (skipRelays) return;
    const gi = segToGroup.get(si);
    if (gi === undefined) return;
    const segPins = pins.filter((p) => p.row === seg.row && p.col >= seg.startCol && p.col <= seg.endCol);
    if (segPins.length === 0) return; // already offered as a whole group above
    const netIds = new Set(segPins.map((p) => p.netId).filter((n): n is string => n !== undefined));
    if (netIds.size !== 1) return; // floating-only or conflicted segments don't donate
    const donorNet = [...netIds][0];
    const donorNeedy = (netGroupIdxs.get(donorNet)?.size ?? 0) > 1 || reserveNets.has(donorNet);
    const free = freeHolesOfGroup(gi);
    const pinMin = Math.min(...segPins.map((p) => p.col));
    const pinMax = Math.max(...segPins.map((p) => p.col));
    for (const side of ["L", "R"] as const) {
      const tail = free.filter(
        (h) =>
          h.row === seg.row && h.col >= seg.startCol && h.col <= seg.endCol &&
          (side === "L" ? h.col < pinMin : h.col > pinMax)
      );
      // two distinct columns, or the two hops collapse onto one hole
      if (new Set(tail.map((h) => h.col)).size < 2) continue;
      relayCands.push({
        holes: tail,
        holeSet: new Set(tail.map((h) => holeKey(h.row, h.col))),
        byCol: byColOf(tail),
        cut: { row: seg.row, col: side === "L" ? pinMin - 1 : pinMax },
        donorGroup: gi,
        donorNet,
        donorNeedy,
      });
    }
  });
  // Every candidate multiplies the per-wire relay search; big boards can
  // offer a hundred tails. Keep the free groups plus the widest tails.
  const MAX_RELAY_CANDS = 32;
  if (relayCands.length > MAX_RELAY_CANDS) {
    const freeCands = relayCands.filter((c) => !c.cut);
    const tailCands = relayCands
      .filter((c) => c.cut)
      .sort((a, b) => b.byCol.size - a.byCol.size)
      .slice(0, Math.max(0, MAX_RELAY_CANDS - freeCands.length));
    relayCands.length = 0;
    relayCands.push(...freeCands, ...tailCands);
  }

  // A group with no free hole left can still take a link wire by sharing a
  // same-net pin's hole — the wire is soldered into the pin's joint, as
  // humans do on tight-pitch connectors and grid parts whose interior pins
  // sit on single-hole segments. Real holes always win: a shared joint is
  // priced as extra effective wire length, so layouts that avoid the
  // situation keep beating ones that need it.
  const PIN_SHARE_PENALTY = 4;
  const sharedPinPen = new Map<string, number>();
  const endpointCache = new Map<number, BoardPosition[]>();
  const endpointHolesOfGroup = (gi: number): BoardPosition[] => {
    let holes = endpointCache.get(gi);
    if (!holes) {
      const free = freeHolesOfGroup(gi);
      if (free.length > 0 || !allowSharedJoints) {
        holes = free;
      } else {
        holes = groupPins.get(gi) ?? [];
        for (const p of holes) sharedPinPen.set(holeKey(p.row, p.col), PIN_SHARE_PENALTY);
      }
      endpointCache.set(gi, holes);
    }
    return holes;
  };

  interface RoutePass {
    wires: { from: BoardPosition; to: BoardPosition }[];
    extraCuts: { row: number; col: number }[]; // cuts severing donated relay tails
    issues: string[];
    starved: string[];
    starvedPins: BoardPosition[];
    overlapped: string[]; // nets that had to fall back to overlapping wires
    mess: number; // total extra effective length of the chosen wires
    sharedJoints: number; // wires soldered into a pin's hole (no free hole left)
  }

  // Cheapest a pair at this offset can possibly cost: bare distance plus,
  // for slanted pairs, the unavoidable off-axis penalty.
  const slantLowerBound = (dr: number, dc: number): number => {
    const dist = Math.hypot(dr, dc);
    return dc !== 0 ? dist + WIRE_OFFAXIS_RATE * Math.max(0, dist - WIRE_OFFAXIS_FREE) : dist;
  };

  const routeAll = (order: Net[]): RoutePass => {
    const pass: RoutePass = { wires: [], extraCuts: [], issues: [], starved: [], starvedPins: [], overlapped: [], mess: 0, sharedJoints: 0 };
    const allWires = [...existingWires];
    const relayOwner = new Map<number, string>();
    // Holes given away with a claimed tail: they belong to the claimant's
    // net now, so the donor's own routing must not touch them.
    const donated = new Set<string>();
    const passFree = (gi: number): BoardPosition[] => {
      const holes = freeHolesOfGroup(gi);
      return donated.size === 0 ? holes : holes.filter((h) => !donated.has(holeKey(h.row, h.col)));
    };
    const passEndpoints = (gi: number): BoardPosition[] => {
      const holes = endpointHolesOfGroup(gi);
      return donated.size === 0 ? holes : holes.filter((h) => !donated.has(holeKey(h.row, h.col)));
    };
    // Endpoint columns per group, rebuilt only when a donation shrinks the
    // pass's endpoint sets — the relay search asks for them per wire.
    const bColsCache = new Map<number, Map<number, number[]>>();
    const bColsOf = (gi: number): Map<number, number[]> => {
      let m = bColsCache.get(gi);
      if (!m) {
        m = byColOf(passEndpoints(gi));
        bColsCache.set(gi, m);
      }
      return m;
    };
    // A tail cannot be severed once a routed wire already ends inside it
    const wireEnds = new Set<string>();
    for (const w of existingWires) {
      wireEnds.add(holeKey(w.from.row, w.from.col));
      wireEnds.add(holeKey(w.to.row, w.to.col));
    }
    const overlapsAWire = (from: BoardPosition, to: BoardPosition) =>
      allWires.some((w) => segmentsOverlapCollinear(from, to, w.from, w.to));

    for (const net of order) {
      const groupIdxs = netGroupIdxs.get(net.id)!;
      const [first, ...rest] = Array.from(groupIdxs);
      // Connected-side holes bucketed by row with sorted columns, so the
      // nearest-pair search below can walk rows outward from a candidate
      // hole and stop once the row distance alone can no longer win —
      // a flat all-pairs scan dominates the whole solve on large boards.
      const connectedRows = new Map<number, number[]>();
      let connMinRow = Infinity;
      let connMaxRow = -Infinity;
      const connectedCols = new Map<number, number[]>();
      const addConnected = (h: BoardPosition) => {
        let cols = connectedRows.get(h.row);
        if (!cols) {
          cols = [];
          connectedRows.set(h.row, cols);
        }
        let lo = 0, hi = cols.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cols[mid] < h.col) lo = mid + 1;
          else hi = mid;
        }
        cols.splice(lo, 0, h.col);
        if (h.row < connMinRow) connMinRow = h.row;
        if (h.row > connMaxRow) connMaxRow = h.row;
        if (!connectedCols.has(h.col)) connectedCols.set(h.col, []);
        connectedCols.get(h.col)!.push(h.row);
      };
      const remaining = new Set(rest);
      // Single-group nets need no wire: don't build the search structure
      if (remaining.size > 0) {
        for (const h of passEndpoints(first)) addConnected(h);
      }
      let usedOverlap = false;

      interface WireChoice {
        from: BoardPosition;
        to: BoardPosition;
        group: number;
        cost: number;
        mess: number;
      }
      while (remaining.size > 0) {
        const findBest = (allowOverlap: boolean): WireChoice | null => {
          let best: WireChoice | null = null;
          const consider = (ha: BoardPosition, hb: BoardPosition, gi: number): WireChoice | null => {
            const dc = ha.col - hb.col;
            const dist = Math.hypot(ha.row - hb.row, dc);
            // Tidiness (off-axis length, component crossings) is priced as
            // extra length; the bare distance is a lower bound, so most
            // pairs skip the obstacle tests entirely.
            if (best && dist >= best.cost + 1e-9) return null;
            // A slanted pair's off-axis penalty is known before any obstacle
            // test — a hard floor on its cost, so most slants prune here.
            if (best && slantLowerBound(ha.row - hb.row, dc) > best.cost + 1e-9) return null;
            const mess =
              obstacleIndex.extraLength(ha, hb) +
              (sharedPinPen.get(holeKey(ha.row, ha.col)) ?? 0) +
              (sharedPinPen.get(holeKey(hb.row, hb.col)) ?? 0);
            const cost = dist + mess;
            // Tiebreak: prefer straight vertical jumpers
            const better =
              !best ||
              cost < best.cost - 1e-9 ||
              (cost < best.cost + 1e-9 &&
                Math.abs(dc) < Math.abs(best.from.col - best.to.col));
            if (!better) return null;
            if (!allowOverlap && overlapsAWire(ha, hb)) return null;
            return { from: ha, to: hb, group: gi, cost, mess };
          };
          for (const gi of remaining) {
            for (const hb of passEndpoints(gi)) {
              const maxDr = Math.max(hb.row - connMinRow, connMaxRow - hb.row);
              for (let dr = 0; dr <= maxDr; dr++) {
                if (best && dr > best.cost + 1e-9) break;
                for (const row of dr === 0 ? [hb.row] : [hb.row - dr, hb.row + dr]) {
                  const cols = connectedRows.get(row);
                  if (!cols) continue;
                  let lo = 0, hi = cols.length;
                  while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cols[mid] < hb.col) lo = mid + 1;
                    else hi = mid;
                  }
                  // Expand outward in both column directions; stop once even
                  // the pair's cost floor can no longer beat (or tie) the best.
                  for (let k = lo; k < cols.length; k++) {
                    if (best && slantLowerBound(dr, cols[k] - hb.col) > best.cost + 1e-9) break;
                    best = consider({ row, col: cols[k] }, hb, gi) ?? best;
                  }
                  for (let k = lo - 1; k >= 0; k--) {
                    if (best && slantLowerBound(dr, hb.col - cols[k]) > best.cost + 1e-9) break;
                    best = consider({ row, col: cols[k] }, hb, gi) ?? best;
                  }
                }
              }
            }
          }
          return best;
        };

        // Relay route: two vertical hops through an unclaimed pin-free
        // strip, competing with the direct wire on the same cost scale.
        // The extra solder joint costs a small flat tax, so a clean direct
        // vertical still wins; a slanted direct wire usually loses.
        const RELAY_WIRE_TAX = 1;
        interface Hop {
          from: BoardPosition;
          to: BoardPosition;
          cost: number;
          mess: number;
        }
        interface RelayChoice {
          w1: Hop;
          w2: Hop;
          group: number;
          relay: number;
          cost: number;
          mess: number;
        }
        const vertHop = (colsA: Map<number, number[]>, colsB: Map<number, number[]>): Hop | null => {
          let best: Hop | null = null;
          for (const [col, rowsA] of colsA) {
            const rowsB = colsB.get(col);
            if (!rowsB) continue;
            for (const ra of rowsA) {
              for (const rb of rowsB) {
                const d = Math.abs(ra - rb);
                if (best && d >= best.cost + 1e-9) continue;
                const from = { row: ra, col };
                const to = { row: rb, col };
                const mess =
                  obstacleIndex.extraLength(from, to) +
                  (sharedPinPen.get(holeKey(ra, col)) ?? 0) +
                  (sharedPinPen.get(holeKey(rb, col)) ?? 0);
                const cost = d + mess;
                if (!best || cost < best.cost - 1e-9) best = { from, to, cost, mess };
              }
            }
          }
          return best;
        };
        const findRelayBest = (allowOverlap: boolean, maxHops: number): RelayChoice | null => {
          let best: RelayChoice | null = null;
          for (const gi of remaining) {
            const bCols = bColsOf(gi);
            if (bCols.size === 0) continue;
            for (let ci = 0; ci < relayCands.length; ci++) {
              const cand = relayCands[ci];
              const owner = relayOwner.get(ci);
              if (owner !== undefined && owner !== net.id) continue;
              // A net gains nothing from severing its own copper
              if (cand.donorNet === net.id) continue;
              if (owner === undefined && cand.cut) {
                // A routed wire already ending in the tail pins it down,
                // and a needy donor must keep a free hole of its own
                let blocked = false;
                for (const k of cand.holeSet) {
                  if (wireEnds.has(k) || donated.has(k)) {
                    blocked = true;
                    break;
                  }
                }
                if (blocked) continue;
                if (cand.donorNeedy &&
                    !passFree(cand.donorGroup!).some((h) => !cand.holeSet.has(holeKey(h.row, h.col)))) {
                  continue;
                }
              }
              const w1 = vertHop(connectedCols, cand.byCol);
              if (!w1) continue;
              const w2 = vertHop(cand.byCol, bCols);
              if (!w2) continue;
              // The tail's severing cut prices in like an extra half-wire
              if (w1.cost + w2.cost > maxHops) continue;
              const cost = w1.cost + w2.cost + RELAY_WIRE_TAX + (cand.cut && owner === undefined ? 0.5 : 0);
              if (best && cost >= best.cost - 1e-9) continue;
              if (!allowOverlap && (overlapsAWire(w1.from, w1.to) || overlapsAWire(w2.from, w2.to))) continue;
              best = { w1, w2, group: gi, relay: ci, cost, mess: w1.mess + w2.mess };
            }
          }
          return best;
        };

        // Relays exist to avoid messy wires, not to shorten clean ones:
        // when the direct choice is a clean vertical, skip the (expensive)
        // relay search entirely.
        let best = findBest(false);
        // A relay may only replace a messy direct wire when its two hops
        // stay comparable in length — a huge detour to save a slant is a
        // worse build than the slant (with no direct option, anything goes).
        const maxHops = best
          ? Math.hypot(best.from.row - best.to.row, best.from.col - best.to.col) * 1.5 + 4
          : Infinity;
        let relay = !best || best.mess > 0.25 ? findRelayBest(false, maxHops) : null;
        if (!best && !relay) {
          best = findBest(true);
          relay = findRelayBest(true, Infinity);
          if (best || relay) usedOverlap = true;
        }
        if (!best && !relay) {
          pass.issues.push(`Net "${net.name}": no free hole to attach a link wire`);
          pass.starved.push(net.id);
          pass.starvedPins.push(...starvedGroupPins(groupIdxs));
          break;
        }
        if (relay && (!best || relay.cost < best.cost - 1e-9)) {
          const cand = relayCands[relay.relay];
          if (relayOwner.get(relay.relay) === undefined && cand.cut) {
            pass.extraCuts.push(cand.cut);
            for (const k of cand.holeSet) donated.add(k);
            bColsCache.clear();
          }
          for (const w of [relay.w1, relay.w2]) {
            pass.wires.push({ from: w.from, to: w.to });
            allWires.push({ from: w.from, to: w.to });
            wireEnds.add(holeKey(w.from.row, w.from.col));
            wireEnds.add(holeKey(w.to.row, w.to.col));
            if (sharedPinPen.has(holeKey(w.from.row, w.from.col)) ||
                sharedPinPen.has(holeKey(w.to.row, w.to.col))) pass.sharedJoints++;
          }
          pass.mess += relay.mess;
          relayOwner.set(relay.relay, net.id);
          remaining.delete(relay.group);
          // The claimed relay and the new group both join the connected
          // copper: further wires of this net may chain anywhere on them
          for (const h of cand.holes) addConnected(h);
          for (const h of passEndpoints(relay.group)) addConnected(h);
          continue;
        }

        pass.wires.push({ from: best!.from, to: best!.to });
        allWires.push({ from: best!.from, to: best!.to });
        wireEnds.add(holeKey(best!.from.row, best!.from.col));
        wireEnds.add(holeKey(best!.to.row, best!.to.col));
        pass.mess += best!.mess;
        if (sharedPinPen.has(holeKey(best!.from.row, best!.from.col)) ||
            sharedPinPen.has(holeKey(best!.to.row, best!.to.col))) pass.sharedJoints++;
        remaining.delete(best!.group);
        // Endpoints stay available: further wires of this net may chain there
        for (const h of passEndpoints(best!.group)) addConnected(h);
      }
      if (usedOverlap) pass.overlapped.push(net.id);

      // Nets that still await unplaced components must keep a free hole, or
      // the future part/wire will have nowhere to attach (e.g. a pin boxed in
      // between the board edge and its own forced cut).
      if (reserveNets.has(net.id)) {
        const hasFree = Array.from(groupIdxs).some((gi) => passFree(gi).length > 0);
        if (!hasFree) {
          pass.issues.push(`Net "${net.name}": no free hole left for further connections`);
          pass.starved.push(net.id);
          pass.starvedPins.push(...starvedGroupPins(groupIdxs));
        }
      }
    }
    return pass;
  };

  let result = routeAll(baseOrder);
  // A net forced into an overlap got there because earlier nets took the
  // clean paths — one retry with the overlapped nets routed first often
  // clears it. Keep the retry only if it is strictly better.
  if (result.overlapped.length > 0) {
    const promoted = new Set(result.overlapped);
    const retryOrder = [
      ...baseOrder.filter((n) => promoted.has(n.id)),
      ...baseOrder.filter((n) => !promoted.has(n.id)),
    ];
    const retry = routeAll(retryOrder);
    if (
      retry.starved.length <= result.starved.length &&
      retry.overlapped.length < result.overlapped.length
    ) {
      result = retry;
    }
  }

  issues.push(...result.issues);
  starvedNetIds.push(...result.starved);
  starvedPinPositions.push(...result.starvedPins);
  return { wires: result.wires, extraCuts: result.extraCuts, wireMess: result.mess, sharedJoints: result.sharedJoints };
}

/**
 * Derive the cuts and link wires that complete the given placement: cuts so
 * no segment carries two nets (floating pins get isolated too), then jumper
 * wires so every net forms one connected group. Existing cuts and wires are
 * kept and only augmented. The result is verified with the existing checker.
 */
export function deriveCompletion(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  // Pin-joint sharing is a locked-layout rescue: free layouts never need it
  // (placement avoids the situation), and offering it there lets the
  // optimizer settle for joint-y variants that compact worse.
  // repairSlants re-places derived cuts to straighten slanted wires — a
  // full re-route per candidate, so callers enable it once on the final
  // plan, not on every evaluator call.
  // evalNets turns this into a cheap ranking evaluator for the placement
  // annealer: only the given nets are routed (the caller prices the rest
  // from a cached baseline), relays are skipped (they never fix
  // starvation, only tidiness), and the cosmetic drill upgrade plus the
  // final verification recompute are dropped.
  opts?: { allowSharedJoints?: boolean; repairSlants?: boolean; evalNets?: Set<string> }
): CompletionPlan {
  const cutIssues: string[] = [];
  const pins = collectBoardPins(board, components, componentDefs, netAssignments);
  const occupied = collectOccupiedHoles(board, components, componentDefs, pins);

  // Nets with assignments on still-unplaced components need reserve holes
  const reserveNets = new Set<string>();
  for (const a of netAssignments) {
    const comp = components.find((c) => c.id === a.componentId);
    if (comp && !comp.boardPos && !comp.boardExcluded) reserveNets.add(a.netId);
  }

  const cuts = deriveCuts(board, pins, occupied, cutIssues, reserveNets);

  // Component geometry the wires should preferably not run over
  const obstacles: WireObstacles = { rects: [], bodies: [] };
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (p1 && p2) obstacles.bodies.push({ p1, p2 });
    } else {
      obstacles.rects.push(getComponentBounds(def, comp.boardPos, comp.rotation));
    }
  }
  // Shared across every routeWith attempt: obstacles don't depend on cuts,
  // so the pair memo keeps paying through repair re-routes and retries.
  const obstacleIndex = new WireObstacleIndex(obstacles);

  interface RouteAttempt {
    cuts: Cut[];
    segments: StripSegment[];
    wires: { from: BoardPosition; to: BoardPosition }[];
    extraCuts: { row: number; col: number }[];
    wireMess: number;
    sharedJoints: number;
    wireIssues: string[];
    starvedNetIds: string[];
    starvedPinPositions: BoardPosition[];
  }
  const routeWith = (cutsTry: Cut[]): RouteAttempt => {
    const boardWithCuts: Board = { ...board, cuts: [...board.cuts, ...cutsTry] };
    const segments = computeStripSegments(boardWithCuts, components, componentDefs, netAssignments);
    const connectivity = computeConnectivity(segments, board.wires);
    const wireIssues: string[] = [];
    const starvedNetIds: string[] = [];
    const starvedPinPositions: BoardPosition[] = [];
    const routeNets = opts?.evalNets ? nets.filter((n) => opts.evalNets!.has(n.id)) : nets;
    const { wires, extraCuts, wireMess, sharedJoints } = deriveWires(
      segments, connectivity, routeNets, pins, occupied, board.wires, reserveNets, obstacleIndex, wireIssues, starvedNetIds, starvedPinPositions,
      opts?.allowSharedJoints ?? false,
      opts?.evalNets !== undefined
    );
    return { cuts: cutsTry, segments, wires, extraCuts, wireMess, sharedJoints, wireIssues, starvedNetIds, starvedPinPositions };
  };

  let attempt = routeWith(cuts);

  // ── Slant repair: slide a derived cut to open a shared column ──
  // A cut placed for hole balance can sever the only column two fragments
  // share, forcing the router into a slanted wire two steps later — the
  // move a human fixes by nudging the cut. For each slanted wire, try the
  // legal alternative positions of the derived cuts on its two rows (legal
  // = still between the same neighboring pins) and keep a re-route that
  // has strictly fewer slants without starving anything.
  if (opts?.repairSlants) {
    const slantsOf = (a: RouteAttempt) => a.wires.filter((w) => w.from.col !== w.to.col);
    const pinsByRow = new Map<number, number[]>();
    for (const p of pins) {
      if (!pinsByRow.has(p.row)) pinsByRow.set(p.row, []);
      pinsByRow.get(p.row)!.push(p.col);
    }
    for (const cols of pinsByRow.values()) cols.sort((a, b) => a - b);
    const legalRange = (cut: Cut): [number, number] => {
      const cols = pinsByRow.get(cut.row) ?? [];
      let lo = 0;
      let hi = board.cols - 2;
      for (const c of cols) {
        if (c <= cut.col && c > lo) lo = c;
        if (c > cut.col && c - 1 < hi) hi = c - 1;
      }
      return [lo, hi];
    };
    // Every candidate is a full re-route: keep the search on a budget —
    // nearest slide positions first, a few per cut, a hard total cap.
    let budget = 24;
    outer: while (budget > 0) {
      const bad = slantsOf(attempt);
      if (bad.length === 0) break;
      for (const w of bad) {
        for (const cut of attempt.cuts) {
          if (cut.row !== w.from.row && cut.row !== w.to.row) continue;
          const [gLo, gHi] = legalRange(cut);
          const gs: number[] = [];
          for (let g = gLo; g <= gHi; g++) if (g !== cut.col) gs.push(g);
          gs.sort((a, b) => Math.abs(a - cut.col) - Math.abs(b - cut.col));
          for (const g of gs.slice(0, 5)) {
            if (budget-- <= 0) break outer;
            const cutsTry = attempt.cuts.map((c) => (c === cut ? { ...c, col: g } : c));
            const t = routeWith(cutsTry);
            if (
              t.starvedNetIds.length <= attempt.starvedNetIds.length &&
              t.sharedJoints <= attempt.sharedJoints &&
              slantsOf(t).length < bad.length
            ) {
              attempt = t;
              continue outer;
            }
          }
        }
      }
      break; // no slide improved anything
    }
  }

  const { segments, wires, extraCuts, wireMess, sharedJoints, wireIssues, starvedNetIds, starvedPinPositions } = attempt;

  if (opts?.evalNets) {
    // Evaluator mode: wires never merge different-net copper, so the
    // pre-wire connectivity already carries the conflict count.
    const conflicts = computeConnectivity(segments, board.wires).filter((g) => g.hasConflict).length;
    return {
      cuts: [...attempt.cuts, ...extraCuts],
      wires,
      issues: [...cutIssues, ...wireIssues],
      unresolvedConflicts: conflicts,
      starvedNetIds,
      starvedPinPositions,
      wireMess,
      sharedJoints,
    };
  }

  const noDrill = new Set<string>();
  for (const p of pins) noDrill.add(holeKey(p.row, p.col));
  for (const c of board.cuts) if (c.kind === "hole") noDrill.add(holeKey(c.row, c.col));
  for (const w of [...board.wires, ...wires]) {
    noDrill.add(holeKey(w.from.row, w.from.col));
    noDrill.add(holeKey(w.to.row, w.to.col));
  }
  // Tail-severing cuts stay between-cuts: a drilled flank hole inside the
  // donated tail could sever the relay copper between its two hop wires.
  const finalCuts = [...upgradeCutsToDrills(attempt.cuts, segments, occupied, noDrill, reserveNets), ...extraCuts];

  const finalBoard: Board = {
    ...board,
    cuts: [...board.cuts, ...finalCuts],
    wires: [...board.wires, ...wires.map((w, i) => ({ id: `af-${i}`, ...w }))],
  };
  const finalSegments = computeStripSegments(finalBoard, components, componentDefs, netAssignments);
  const finalConnectivity = computeConnectivity(finalSegments, finalBoard.wires);
  const unresolvedConflicts = finalConnectivity.filter((g) => g.hasConflict).length;

  return {
    cuts: finalCuts,
    wires,
    issues: [...cutIssues, ...wireIssues],
    unresolvedConflicts,
    starvedNetIds,
    starvedPinPositions,
    wireMess,
    sharedJoints,
  };
}

/**
 * User-facing wrapper around deriveCompletion: nothing is placed for
 * unplaced components; leftovers are reported as readable issues.
 */
export function computeAutoFinish(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[]
): AutoFinishResult {
  const plan = deriveCompletion(board, components, componentDefs, nets, netAssignments, { repairSlants: true });
  const issues = [...plan.issues];

  if (plan.unresolvedConflicts > 0) {
    issues.push(
      `${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved by adding cuts and wires`
    );
  }

  const unplaced = components.filter((c) => !c.boardPos && !c.boardExcluded).length;
  if (unplaced > 0) {
    issues.push(`${unplaced} component${unplaced > 1 ? "s" : ""} not placed yet`);
  }

  return { cuts: plan.cuts, wires: plan.wires, issues };
}
