import { holeKey } from "./keys";
import { BoardPosition, Cut, Net } from "@/types";
import { StripSegment } from "./stripSegments";
import { BoardPin } from "./boardPins";
import {
  WIRE_OFFAXIS_FREE,
  WIRE_OFFAXIS_RATE,
  WireObstacleIndex,
  wireStackDepth,
  wireStackPenalty,
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
// the editor renders them in separate lanes. Depth-priced and capped in
// flexGeometry (wireStackPenalty): the second wire in a channel still
// beats a slant, the third only beats a real detour, a fourth is barred
// unless nothing else completes the net.
// Relay route: two vertical hops through an unclaimed pin-free strip,
// competing with the direct wire on the same cost scale. The extra solder
// joint costs a small flat tax, so a clean direct vertical still wins; a
// slanted direct wire usually loses.
const RELAY_WIRE_TAX = 1;

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
  skipRelays = false,
  // Drilled-cuts-only mode: a donated tail is severed by DRILLING OUT the
  // tail hole next to the donor's pins rather than cutting the copper
  // beside it. The relay runs on the rest of the tail, which stays intact,
  // so the mode keeps its strongest off-axis repair.
  drillTailRelays = false
): {
  wires: { from: BoardPosition; to: BoardPosition }[];
  extraCuts: Cut[];
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
    cut?: Cut;
    donorGroup?: number;
    donorNet?: string;
    donorNeedy?: boolean;
  }
  const pinHoles = new Set(pins.map((p) => holeKey(p.row, p.col)));
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
      // The severing cut: normally the copper gap beside the donor's outer
      // pin; in drilled mode the tail hole on that side, sacrificed so the
      // break is a drill. The sacrificed hole leaves the usable tail.
      const drillCol = side === "L" ? pinMin - 1 : pinMax + 1;
      if (drillTailRelays &&
          (drillCol < seg.startCol || drillCol > seg.endCol ||
            // a floating (netless) pin can sit on a donor segment, and its
            // hole must survive
            pinHoles.has(holeKey(seg.row, drillCol)))) {
        continue;
      }
      const beyond = drillTailRelays ? drillCol : side === "L" ? pinMin : pinMax;
      const tail = free.filter(
        (h) =>
          h.row === seg.row && h.col >= seg.startCol && h.col <= seg.endCol &&
          (side === "L" ? h.col < beyond : h.col > beyond)
      );
      // two distinct columns, or the two hops collapse onto one hole
      if (new Set(tail.map((h) => h.col)).size < 2) continue;
      // The sacrificed hole counts as consumed (nothing may route to it or
      // keep it as a spare) but is not offered as a hop endpoint.
      const holeSet = new Set(tail.map((h) => holeKey(h.row, h.col)));
      if (drillTailRelays) holeSet.add(holeKey(seg.row, drillCol));
      relayCands.push({
        holes: tail,
        holeSet,
        byCol: byColOf(tail),
        cut: drillTailRelays
          ? { row: seg.row, col: drillCol, kind: "hole" as const }
          : { row: seg.row, col: side === "L" ? pinMin - 1 : pinMax },
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
    extraCuts: Cut[]; // cuts severing donated relay tails
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
    // Rescue mode (per wire, see below): allow over-cap stacks at the
    // rescue rate when nothing under the cap can complete the net.
    let allowDeepStacks = false;
    const overlapPenalty = (from: BoardPosition, to: BoardPosition) =>
      wireStackPenalty(wireStackDepth(from, to, allWires), allowDeepStacks);

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
            if (!isFinite(mess)) return null; // over the stack cap
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
                if (!isFinite(mess)) continue; // over the stack cap
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
        // A relay may only replace a messy direct wire when its two hops
        // stay comparable in length — a huge detour to save a slant is a
        // worse build than the slant (with no direct option, anything goes).
        const search = (): { best: WireChoice | null; relay: RelayChoice | null } => {
          const best = findBest();
          const maxHops = best
            ? Math.hypot(best.from.row - best.to.row, best.from.col - best.to.col) * 1.5 + 4
            : Infinity;
          const relay = !best || best.mess > 0.25 ? findRelayBest(maxHops) : null;
          return { best, relay };
        };
        let { best, relay } = search();
        if (!best && !relay) {
          // Everything under the stack cap is taken: an over-cap stack at
          // the rescue rate still beats starving the net.
          allowDeepStacks = true;
          ({ best, relay } = search());
          allowDeepStacks = false;
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
