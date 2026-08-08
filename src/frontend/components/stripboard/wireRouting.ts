import { holeKey } from "./keys";
import { BoardPosition, Net } from "@/types";
import { StripSegment, segmentHoles, isRowRun } from "./stripSegments";
import { BoardPin } from "./boardPins";
import {
  WIRE_OFFAXIS_FREE,
  WIRE_OFFAXIS_RATE,
  WireObstacleIndex,
  segmentsOverlapCollinear,
} from "./flexGeometry";

// ── Routing cost model ─────────────────────────────────
// Every candidate multiplies the per-wire relay search; big boards can
// offer a hundred tails. Keep the free groups plus the widest tails.
const MAX_RELAY_CANDS = 32;
// A group with no free hole left can still take a link wire by sharing a
// same-net pin's hole — the wire is soldered into the pin's joint, as
// humans do on tight-pitch connectors and grid parts whose interior pins
// sit on single-hole segments. Real holes always win: a shared joint is
// priced as extra effective wire length, so layouts that avoid the
// situation keep beating ones that need it.
const PIN_SHARE_PENALTY = 4;
// Wires running on top of each other are physically fine (insulation)
// and a standard human technique for parallel runs sharing a column;
// the editor renders them in separate lanes. Price each overlapped
// wire below a slant's cost so a free column still wins, a pile-up
// stays unattractive, and overlap beats going diagonal.
const WIRE_OVERLAP_RATE = 2;
// Relay route: two vertical hops through an unclaimed pin-free strip,
// competing with the direct wire on the same cost scale. The extra solder
// joint costs a small flat tax, so a clean direct vertical still wins; a
// slanted direct wire usually loses.
const RELAY_WIRE_TAX = 1;

/** One side big enough to index every hole any segment mentions. */
function boardCols(segments: StripSegment[]): number {
  let n = 1;
  for (const s of segments) {
    n = Math.max(n, (s.endRow ?? s.row) + 1, s.endCol + 1);
  }
  return n;
}

interface WireChoice {
  from: BoardPosition;
  to: BoardPosition;
  group: number;
  cost: number;
  mess: number;
}

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

/**
 * Connect each net's disconnected strip groups with jumper wires (Prim-style
 * MST: always join the nearest pair of free holes). Wires may share endpoint
 * holes but must not run collinearly on top of another wire — unless that is
 * the only way to complete the net.
 */
export function deriveWires(
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
  // Hole -> segment index, over a flat array: built by walking every
  // segment's holes, so copper running down a column lands in the index the
  // same way a run along a row does, at no cost in keys or hashing.
  const width = boardCols(segments);
  const segIdxByHole = new Int32Array(width * width).fill(-1);
  segments.forEach((s, idx) => {
    for (const h of segmentHoles(s)) segIdxByHole[h.row * width + h.col] = idx;
  });
  const segIndexAt = (row: number, col: number) =>
    row < 0 || col < 0 || row >= width || col >= width ? -1 : segIdxByHole[row * width + col];

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
        for (const h of segmentHoles(segments[si])) {
          if (!occupied.has(holeKey(h.row, h.col))) holes.push(h);
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
    // The tail donation below reasons in columns along one row. Copper
    // running any other way never donates a tail — it stays available as a
    // whole group, which is what a bus is good for anyway.
    if (!isRowRun(seg)) return;
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
  if (relayCands.length > MAX_RELAY_CANDS) {
    const freeCands = relayCands.filter((c) => !c.cut);
    const tailCands = relayCands
      .filter((c) => c.cut)
      .sort((a, b) => b.byCol.size - a.byCol.size)
      .slice(0, Math.max(0, MAX_RELAY_CANDS - freeCands.length));
    relayCands.length = 0;
    relayCands.push(...freeCands, ...tailCands);
  }

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
    const pass: RoutePass = { wires: [], extraCuts: [], issues: [], starved: [], starvedPins: [], mess: 0, sharedJoints: 0 };
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
    const overlapPenalty = (from: BoardPosition, to: BoardPosition) => {
      let n = 0;
      for (const w of allWires) {
        if (segmentsOverlapCollinear(from, to, w.from, w.to)) n++;
      }
      return n * WIRE_OVERLAP_RATE;
    };

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

      while (remaining.size > 0) {
        const findBest = (): WireChoice | null => {
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
            let mess =
              obstacleIndex.extraLength(ha, hb) +
              (sharedPinPen.get(holeKey(ha.row, ha.col)) ?? 0) +
              (sharedPinPen.get(holeKey(hb.row, hb.col)) ?? 0);
            // Overlap pricing only for pairs still in the running: the scan
            // over routed wires is the priciest term here.
            if (best && dist + mess > best.cost + 1e-9) return null;
            mess += overlapPenalty(ha, hb);
            const cost = dist + mess;
            // Tiebreak: prefer straight vertical jumpers
            const better =
              !best ||
              cost < best.cost - 1e-9 ||
              (cost < best.cost + 1e-9 &&
                Math.abs(dc) < Math.abs(best.from.col - best.to.col));
            if (!better) return null;
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
                  (sharedPinPen.get(holeKey(rb, col)) ?? 0) +
                  overlapPenalty(from, to);
                const cost = d + mess;
                if (!best || cost < best.cost - 1e-9) best = { from, to, cost, mess };
              }
            }
          }
          return best;
        };
        const findRelayBest = (maxHops: number): RelayChoice | null => {
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
              best = { w1, w2, group: gi, relay: ci, cost, mess: w1.mess + w2.mess };
            }
          }
          return best;
        };

        // Relays exist to avoid messy wires, not to shorten clean ones:
        // when the direct choice is a clean vertical, skip the (expensive)
        // relay search entirely.
        const best = findBest();
        // A relay may only replace a messy direct wire when its two hops
        // stay comparable in length — a huge detour to save a slant is a
        // worse build than the slant (with no direct option, anything goes).
        const maxHops = best
          ? Math.hypot(best.from.row - best.to.row, best.from.col - best.to.col) * 1.5 + 4
          : Infinity;
        const relay = !best || best.mess > 0.25 ? findRelayBest(maxHops) : null;
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

  const result = routeAll(baseOrder);

  issues.push(...result.issues);
  starvedNetIds.push(...result.starved);
  starvedPinPositions.push(...result.starvedPins);
  return { wires: result.wires, extraCuts: result.extraCuts, wireMess: result.mess, sharedJoints: result.sharedJoints };
}
