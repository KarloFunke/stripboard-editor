import { BoardPosition, Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import { FootprintRect, WireObstacles, spanLimits, wireExtraLength } from "../flexGeometry";
import { Candidate, Chooser } from "./chooser";
import { DimLimits } from "./tileModel";
import { IC_MIN_PINS } from "./tidyScore";

// ── Wire channels: buy straightness with a blank line ──
// When the plan still has slanted wires or wires running over parts,
// offer boards with one inserted blank line. A blank column is a
// vertical wire channel: every strip crossing it gains a free,
// crossing-free hole, so any two of those strips connect vertically
// there. A blank row is a relay strip: horizontal travel on copper with
// two vertical hops. The chooser adopts an insertion only when it beats
// the current candidate on (bad, cost) — the line's area must pay for the
// mess it removes. Runs last so no later compaction can harvest the
// channel away; the caller skips it with locked parts (content must not
// shift).
export function insertWireChannels(
  chooser: Chooser,
  componentDefs: ComponentDef[],
  limits: DimLimits,
  icChannels: boolean
): void {
    const lineStraddled = (comps: Component[], isCol: boolean, at: number): boolean =>
      comps.some((c) => {
        if (!c.boardPos || c.boardExcluded) return false;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) return false;
        if (def.flexible) {
          // A straddled flexible part stretches by one hole (insertLine
          // shifts its far endpoint); it only blocks the line when its
          // span cannot legally absorb the growth. Dense boards tile
          // every line position with resistor spans otherwise.
          const p2 = c.flexibleEndPos ?? c.boardPos!;
          const lo = isCol ? Math.min(c.boardPos!.col, p2.col) : Math.min(c.boardPos!.row, p2.row);
          const hi = isCol ? Math.max(c.boardPos!.col, p2.col) : Math.max(c.boardPos!.row, p2.row);
          if (!(lo < at && at <= hi)) return false;
          const dr = Math.abs(c.boardPos!.row - p2.row) + (isCol ? 0 : 1);
          const dc = Math.abs(c.boardPos!.col - p2.col) + (isCol ? 1 : 0);
          return Math.hypot(dr, dc) > spanLimits(def).max + 1e-6;
        }
        const r = getComponentBounds(def, c.boardPos, c.rotation);
        return isCol ? r.minCol < at && at <= r.maxCol : r.minRow < at && at <= r.maxRow;
      });
    const insertLine = (comps: Component[], isCol: boolean, at: number): Component[] =>
      comps.map((c) => {
        if (!c.boardPos) return c;
        const shift = (p: BoardPosition): BoardPosition =>
          isCol
            ? p.col >= at ? { row: p.row, col: p.col + 1 } : p
            : p.row >= at ? { row: p.row + 1, col: p.col } : p;
        return {
          ...c,
          boardPos: shift(c.boardPos),
          ...(c.flexibleEndPos ? { flexibleEndPos: shift(c.flexibleEndPos) } : {}),
        };
      });
    for (let round = 0; round < (icChannels ? 12 : 3); round++) {
      const cur: Candidate = chooser.chosen!;
      const obstacles: WireObstacles = { rects: [], bodies: [] };
      const icRects: FootprintRect[] = [];
      for (const c of cur.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) obstacles.bodies.push({ p1: c.boardPos, p2: c.flexibleEndPos ?? c.boardPos });
        else {
          const r = getComponentBounds(def, c.boardPos, c.rotation);
          obstacles.rects.push(r);
          if (icChannels && def.pins.length >= IC_MIN_PINS) icRects.push(r);
        }
      }
      const offenders = cur.plan.wires.filter(
        (w) => w.from.col !== w.to.col || wireExtraLength(w.from, w.to, obstacles) > 0
      );
      if (offenders.length === 0) break;
      const colCands = new Set<number>();
      const rowCands = new Set<number>();
      // IC-channel treatment: a line at an IC's footprint edge widens the
      // routing gap beside its pin field (a column doubles as a crossing-
      // free channel, a row as a relay strip). Only ICs a messy wire
      // actually touches, so candidate volume tracks the mess, not the size.
      for (const r of icRects) {
        const near = offenders.some(
          (w) =>
            Math.min(w.from.col, w.to.col) <= r.maxCol + 1 &&
            Math.max(w.from.col, w.to.col) >= r.minCol - 1 &&
            Math.min(w.from.row, w.to.row) <= r.maxRow + 1 &&
            Math.max(w.from.row, w.to.row) >= r.minRow - 1
        );
        if (!near) continue;
        colCands.add(r.minCol);
        colCands.add(r.maxCol + 1);
        rowCands.add(r.minRow);
        rowCands.add(r.maxRow + 1);
      }
      for (const w of offenders) {
        const loC = Math.min(w.from.col, w.to.col);
        const hiC = Math.max(w.from.col, w.to.col);
        if (loC !== hiC) {
          // a channel column anywhere between the endpoints gives both
          // strips a shared free column; a relay row between them lets two
          // vertical hops replace the slant
          colCands.add(loC + 1);
          colCands.add(hiC);
          colCands.add((loC + hiC + 1) >> 1);
          const loR = Math.min(w.from.row, w.to.row);
          const hiR = Math.max(w.from.row, w.to.row);
          if (hiR > loR) {
            rowCands.add((loR + hiR + 1) >> 1);
          } else {
            // A pure-horizontal run spans no rows, so the midpoint rule
            // above never offers the one insertion that fixes it: a relay
            // row directly beside it.
            rowCands.add(loR);
            rowCands.add(loR + 1);
          }
        } else {
          // vertical wire over parts: a channel right beside it clears the
          // path, and a relay row at any gap inside its span lets two hops
          // detour around the crossed body (bus row over cross-part wire)
          colCands.add(loC);
          colCands.add(loC + 1);
          const loR = Math.min(w.from.row, w.to.row);
          const hiR = Math.max(w.from.row, w.to.row);
          for (let r = loR + 1; r <= hiR; r++) rowCands.add(r);
        }
      }
      if (limits.maxCols !== undefined && cur.cols + 1 > limits.maxCols) colCands.clear();
      if (limits.maxRows !== undefined && cur.rows + 1 > limits.maxRows) rowCands.clear();
      for (const at of colCands) {
        if (at < 1 || at > cur.cols - 1) continue; // edge channels are tried above
        if (lineStraddled(cur.virtual, true, at)) continue;
        chooser.route(insertLine(cur.virtual, true, at), cur.rows, cur.cols + 1, cur.movedIds);
      }
      for (const at of rowCands) {
        if (at < 1 || at > cur.rows - 1) continue;
        if (lineStraddled(cur.virtual, false, at)) continue;
        chooser.route(insertLine(cur.virtual, false, at), cur.rows + 1, cur.cols, cur.movedIds);
      }
      if (chooser.chosen === cur) break; // no insertion paid for itself
    }
    // ── Bus lanes: compound insertion for stacked horizontal runs ──
    // Several wide horizontal runs may each fail to pay for a private
    // relay row while jointly they would (each freed run funds the next
    // lane). One attempt inserts a lane beside every remaining wide run
    // at once; chooser.route() adopts only if the whole bundle pays.
    if (icChannels && chooser.chosen!.bad === 0) {
      const cur: Candidate = chooser.chosen!;
      const laneRows = [
        ...new Set(
          cur.plan.wires
            .filter((w) => w.from.row === w.to.row && Math.abs(w.from.col - w.to.col) > 3)
            .map((w) => w.from.row + 1)
        ),
      ].sort((a, b) => b - a);
      if (laneRows.length >= 2 &&
          !(limits.maxRows !== undefined && cur.rows + laneRows.length > limits.maxRows)) {
        // Descending order: an insertion never shifts the targets below it
        let comps = cur.virtual;
        let rows = cur.rows;
        for (const at of laneRows) {
          if (at < 1 || at > rows - 1 || lineStraddled(comps, false, at)) continue;
          comps = insertLine(comps, false, at);
          rows++;
        }
        if (rows > cur.rows) chooser.route(comps, rows, cur.cols, cur.movedIds);
      }
    }
}
