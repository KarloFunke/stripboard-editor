import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentPinPositions } from "./boardLayout";
import { BoardPin, collectBoardPins, collectOccupiedHoles } from "./boardPins";
import { holeKey } from "./keys";

// ── Pins no layout can wire ──
// A pin is wired through a free hole on its own strip. From the pin the
// strip runs on under the part's body and past pins of the same net, and
// stops at a pin of another net (or an unconnected pin, which stays
// isolated). When it stops on both sides before a free hole turns up, no
// board can wire that pin in that orientation of the part. A part drawn with
// its pins too close together has such pins in every orientation; a locked
// part may have them only in the turn it is locked in. The holes are judged
// as the router judges them (collectOccupiedHoles).

export interface UnreachablePins {
  component: Component;
  // the fewest pins left closed off, in the best turn the part may take
  pinNames: string[];
  // locked in a turn that closes pins off, where a free turn would not
  turnHelps: boolean;
}

/** The parts with connected pins that their orientation leaves no way to wire. */
export function unreachablePins(
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): UnreachablePins[] {
  const netSize = new Map<string, number>();
  for (const a of netAssignments) netSize.set(a.netId, (netSize.get(a.netId) ?? 0) + 1);
  const out: UnreachablePins[] = [];
  for (const c of components) {
    if (c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def || def.flexible || def.pins.length < 3) continue;
    // the part alone, with room around it for a package that overhangs
    const m = Math.max(def.width, def.height) + 4;
    const board: Board = { rows: 3 * m, cols: 3 * m, cuts: [], wires: [] };
    const closedOff = (rotation: Component["rotation"]): Set<string> => {
      const placed: Component = { ...c, boardPos: { row: m, col: m }, rotation, locked: undefined };
      const pins = collectBoardPins(board, [placed], componentDefs, netAssignments);
      const occupied = collectOccupiedHoles(board, [placed], componentDefs, pins);
      const pinAt = new Map(pins.map((p) => [holeKey(p.row, p.col), p]));
      // along the strip one way: a free hole, or the pins of the net met before a pin of another net
      const walk = (p: BoardPin, step: number): { free: boolean; same: number } => {
        let same = 0;
        for (let k = p.col + step; k >= 0 && k < board.cols; k += step) {
          const q = pinAt.get(holeKey(p.row, k));
          if (q) {
            if (q.netKey !== p.netKey) return { free: false, same };
            same++;
          } else if (!occupied.has(holeKey(p.row, k))) return { free: true, same };
        }
        return { free: true, same };
      };
      const stuck = new Set<string>();
      for (const at of getComponentPinPositions(placed, def)) {
        const p = pinAt.get(holeKey(at.row, at.col));
        if (!p?.netId || netSize.get(p.netId)! < 2) continue;
        const left = walk(p, -1), right = walk(p, 1);
        // a net whose pins all share this strip needs no wire
        if (left.free || right.free || 1 + left.same + right.same >= netSize.get(p.netId)!) continue;
        stuck.add(at.pinId);
      }
      return stuck;
    };
    // a half turn keeps the strips' direction, so two turns cover every case
    const free = (def.halfTurnOnly ? [0] as const : [0, 90] as const).map(closedOff).reduce((a, b) => (b.size < a.size ? b : a));
    const locked = !!(c.locked && c.boardPos);
    const best = locked ? closedOff(c.rotation) : free;
    if (best.size === 0) continue;
    const pinNames = def.pins.filter((p) => best.has(p.id)).map((p) => p.name || p.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    out.push({ component: c, pinNames, turnHelps: locked && free.size === 0 });
  }
  return out;
}

/** The layout issue for such a part, in words a builder can act on. */
export function unreachablePinsIssue(u: UnreachablePins): string {
  const one = u.pinNames.length === 1;
  const names = one ? `pin ${u.pinNames[0]}` : `pins ${u.pinNames.slice(0, -1).join(", ")} and ${u.pinNames[u.pinNames.length - 1]}`;
  const why = `other pins or the part's own body close off ${one ? "its strip" : "their strips"} on both sides`;
  return u.turnHelps
    ? `${u.component.label}: ${names} can't be wired in the position the part is locked in: ${why}. Turn the part, or unlock it so the layouter can.`
    : `${u.component.label}: ${names} can't be wired: ${why}, and no way of turning the part frees ${one ? "it" : "them"} without closing off others. Give the pins more room with Edit Footprint, or use Mount off board.`;
}
