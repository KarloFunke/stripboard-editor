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
  WireObstacles,
  corridorHoles,
  segmentsOverlapCollinear,
  wireExtraLength,
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
  obstacles: WireObstacles,
  issues: string[],
  starvedNetIds: string[],
  starvedPinPositions: BoardPosition[],
  allowSharedJoints: boolean
): { wires: { from: BoardPosition; to: BoardPosition }[]; wireMess: number; sharedJoints: number } {
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
    issues: string[];
    starved: string[];
    starvedPins: BoardPosition[];
    overlapped: string[]; // nets that had to fall back to overlapping wires
    mess: number; // total extra effective length of the chosen wires
    sharedJoints: number; // wires soldered into a pin's hole (no free hole left)
  }

  const routeAll = (order: Net[]): RoutePass => {
    const pass: RoutePass = { wires: [], issues: [], starved: [], starvedPins: [], overlapped: [], mess: 0, sharedJoints: 0 };
    const allWires = [...existingWires];
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
      };
      const remaining = new Set(rest);
      // Single-group nets need no wire: don't build the search structure
      if (remaining.size > 0) {
        for (const h of endpointHolesOfGroup(first)) addConnected(h);
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
            const mess =
              wireExtraLength(ha, hb, obstacles) +
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
            for (const hb of endpointHolesOfGroup(gi)) {
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
                  // Expand outward in both column directions; stop once the
                  // bare distance can no longer beat (or tie) the best.
                  for (let k = lo; k < cols.length; k++) {
                    if (best && Math.hypot(dr, cols[k] - hb.col) > best.cost + 1e-9) break;
                    best = consider({ row, col: cols[k] }, hb, gi) ?? best;
                  }
                  for (let k = lo - 1; k >= 0; k--) {
                    if (best && Math.hypot(dr, hb.col - cols[k]) > best.cost + 1e-9) break;
                    best = consider({ row, col: cols[k] }, hb, gi) ?? best;
                  }
                }
              }
            }
          }
          return best;
        };

        let best = findBest(false);
        if (!best) {
          best = findBest(true);
          if (best) usedOverlap = true;
        }
        if (!best) {
          pass.issues.push(`Net "${net.name}": no free hole to attach a link wire`);
          pass.starved.push(net.id);
          pass.starvedPins.push(...starvedGroupPins(groupIdxs));
          break;
        }

        pass.wires.push({ from: best.from, to: best.to });
        allWires.push({ from: best.from, to: best.to });
        pass.mess += best.mess;
        if (sharedPinPen.has(holeKey(best.from.row, best.from.col)) ||
            sharedPinPen.has(holeKey(best.to.row, best.to.col))) pass.sharedJoints++;
        remaining.delete(best.group);
        // Endpoints stay available: further wires of this net may chain there
        for (const h of endpointHolesOfGroup(best.group)) addConnected(h);
      }
      if (usedOverlap) pass.overlapped.push(net.id);

      // Nets that still await unplaced components must keep a free hole, or
      // the future part/wire will have nowhere to attach (e.g. a pin boxed in
      // between the board edge and its own forced cut).
      if (reserveNets.has(net.id)) {
        const hasFree = Array.from(groupIdxs).some((gi) => freeHolesOfGroup(gi).length > 0);
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
  return { wires: result.wires, wireMess: result.mess, sharedJoints: result.sharedJoints };
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
  opts?: { allowSharedJoints?: boolean }
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

  const boardWithCuts: Board = { ...board, cuts: [...board.cuts, ...cuts] };
  const segments = computeStripSegments(boardWithCuts, components, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, board.wires);
  const wireIssues: string[] = [];
  const starvedNetIds: string[] = [];
  const starvedPinPositions: BoardPosition[] = [];
  const { wires, wireMess, sharedJoints } = deriveWires(
    segments, connectivity, nets, pins, occupied, board.wires, reserveNets, obstacles, wireIssues, starvedNetIds, starvedPinPositions,
    opts?.allowSharedJoints ?? false
  );

  const finalBoard: Board = {
    ...boardWithCuts,
    wires: [...board.wires, ...wires.map((w, i) => ({ id: `af-${i}`, ...w }))],
  };
  const finalSegments = computeStripSegments(finalBoard, components, componentDefs, netAssignments);
  const finalConnectivity = computeConnectivity(finalSegments, finalBoard.wires);
  const unresolvedConflicts = finalConnectivity.filter((g) => g.hasConflict).length;

  return {
    cuts,
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
  const plan = deriveCompletion(board, components, componentDefs, nets, netAssignments);
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
