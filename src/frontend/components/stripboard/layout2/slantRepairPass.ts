import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { holeKey } from "../keys";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import { corridorHoles } from "../flexGeometry";
import { computeStripSegments } from "../stripSegments";
import { Candidate, Chooser } from "./chooser";

// ── Slant repairs on the final candidate ──
// First the free move: let deriveCompletion slide its own cuts to open
// shared columns (repairSlants). Then tap slides: a one-hole part can
// move along its row for free — cuts and wires are re-derived from the
// pin positions, so any spot that routes is legal — and the chooser only
// adopts a move that routes strictly better.
export function repairSlantWires(
  chooser: Chooser,
  board: Board,
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  lockedIds: Set<string>
): void {
    chooser.route(chooser.chosen!.virtual, chooser.chosen!.rows, chooser.chosen!.cols, chooser.chosen!.movedIds, true);
    const afterEntryRepair: Candidate = chooser.chosen!;
    
    for (let round = 0; round < 3; round++) {
      const cur: Candidate = chooser.chosen!;
      // chooser.route() swaps `chooser.chosen` on adoption; an opaque check keeps TS from
      // narrowing the comparison away
      const stillCur = () => (chooser.chosen as Candidate) === cur;
      const offenders = cur.plan.wires.filter((w) => w.from.col !== w.to.col);
      if (offenders.length === 0) break;
      const segBoard: Board = { ...board, rows: cur.rows, cols: cur.cols, cuts: cur.plan.cuts, wires: [] };
      const segments = computeStripSegments(segBoard, cur.virtual, componentDefs, netAssignments);
      const segAt = (r: number, c: number) =>
        segments.find((s) => s.row === r && c >= s.startCol && c <= s.endCol);
      // Physical blockers only (pins, bodies, corridors): everything else
      // — cuts, wire endpoints — is re-derived per candidate anyway
      const phys = new Set<string>();
      const tapAt = new Map<string, Component>();
      for (const c of cur.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const p2 = c.flexibleEndPos ?? c.boardPos;
          for (const h of corridorHoles(c.boardPos, p2)) phys.add(holeKey(h.row, h.col));
          phys.add(holeKey(c.boardPos.row, c.boardPos.col));
          phys.add(holeKey(p2.row, p2.col));
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          for (let r = b.minRow; r <= b.maxRow; r++) {
            for (let cc = b.minCol; cc <= b.maxCol; cc++) phys.add(holeKey(r, cc));
          }
          if (def.pins.length === 1 && def.width === 1 && def.height === 1 && !lockedIds.has(c.id)) {
            tapAt.set(holeKey(c.boardPos.row, c.boardPos.col), c);
          }
        }
      }
      let attempts = 0;
      for (const w of offenders) {
        if (!stillCur() || attempts >= 8) break;
        const sA = segAt(w.from.row, w.from.col);
        const sB = segAt(w.to.row, w.to.col);
        if (!sA || !sB) continue;
        const lo = Math.max(sA.startCol, sB.startCol);
        const hi = Math.min(sA.endCol, sB.endCol);
        if (hi < lo) {
          // Disjoint spans: pins between the spans keep the copper from
          // reaching a shared column. Clear the approach: pick a target
          // column free on the far row, move every tap between it and this
          // segment out of the way, and let the re-derived cuts plus the
          // cut-slide repair extend the copper to it.
          for (const [seg, other] of [
            [sA, sB],
            [sB, sA],
          ] as const) {
            if (!stillCur() || attempts >= 8) break;
            const left = other.endCol < seg.startCol;
            const cands: number[] = [];
            for (let c2 = other.startCol; c2 <= other.endCol; c2++) {
              if (!phys.has(holeKey(other.row, c2))) cands.push(c2);
            }
            if (left) cands.reverse(); // nearest to this segment first
            for (const c2 of cands.slice(0, 3)) {
              if (!stillCur() || attempts >= 8) break;
              const zone: [number, number] = left ? [c2, seg.startCol - 1] : [seg.endCol + 1, c2];
              const movers: Component[] = [];
              let clear = true;
              for (let z = zone[0]; z <= zone[1]; z++) {
                const k = holeKey(seg.row, z);
                const tap = tapAt.get(k);
                if (tap) movers.push(tap);
                else if (phys.has(k)) {
                  clear = false;
                  break;
                }
              }
              if (!clear || movers.length === 0) continue;
              // park the movers beyond the target, away from this segment
              const spots: number[] = [];
              if (left) {
                for (let z = c2 - 1; z >= 0 && spots.length < movers.length; z--) {
                  if (!phys.has(holeKey(seg.row, z))) spots.push(z);
                }
              } else {
                for (let z = c2 + 1; z < cur.cols && spots.length < movers.length; z++) {
                  if (!phys.has(holeKey(seg.row, z))) spots.push(z);
                }
              }
              if (spots.length < movers.length) continue;
              attempts++;
              const byTap = new Map(movers.map((tap, i) => [tap.id, spots[i]]));
              const moved = cur.virtual.map((c) =>
                byTap.has(c.id) ? { ...c, boardPos: { row: seg.row, col: byTap.get(c.id)! } } : c
              );
              chooser.route(moved, cur.rows, cur.cols, cur.movedIds, true);
            }
          }
          continue;
        }
        for (let col = lo; col <= hi && stillCur(); col++) {
          for (const [seg, other] of [
            [sA, sB],
            [sB, sA],
          ] as const) {
            const tap = tapAt.get(holeKey(seg.row, col));
            if (!tap) continue;
            if (phys.has(holeKey(other.row, col))) continue;
            // any free hole on the tap's row works; ones outside the shared
            // window first, since they cannot re-block it
            const targets: number[] = [];
            for (let t = 0; t < cur.cols; t++) {
              if (t === col || phys.has(holeKey(seg.row, t))) continue;
              targets.push(t);
            }
            targets.sort(
              (a, b) =>
                Number(a >= lo && a <= hi) - Number(b >= lo && b <= hi) ||
                Math.abs(a - col) - Math.abs(b - col)
            );
            for (const t of targets) {
              if (attempts >= 8) break;
              attempts++;
              // no repair here: freeing the column enables a direct
              // vertical on its own, and nesting the cut-slide search into
              // every candidate would multiply full re-routes
              const moved = cur.virtual.map((c) =>
                c.id === tap.id ? { ...c, boardPos: { row: seg.row, col: t } } : c
              );
              chooser.route(moved, cur.rows, cur.cols, cur.movedIds);
              if (!stillCur()) break;
            }
          }
        }
      }
      if (stillCur()) break; // nothing adopted this round
    }
    // tap slides route without the cut-slide search; one repair pass on
    // whatever they produced picks up the compound cases
    if (chooser.chosen !== afterEntryRepair) {
      chooser.route(chooser.chosen!.virtual, chooser.chosen!.rows, chooser.chosen!.cols, chooser.chosen!.movedIds, true);
    }
}
