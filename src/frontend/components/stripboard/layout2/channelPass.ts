import { Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import { FootprintRect, WireObstacles, spanLimits, wireExtraLength, wireStackDepth } from "../flexGeometry";
import { Candidate, Chooser } from "./chooser";
import { insertLine } from "./edgePadding";
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
// strict (hard zero-mess rule, strict chooser): the pass keeps inserting
// until no off-axis or crossing wire remains, adopting the best insertion
// per round whatever it costs in area. Channel columns may not be
// straddled by a flexible body (its body would cross every wire in the
// channel) and may sit on the board edge. When no single line helps, two
// lines at once are tried in pairs: a relay row beside one endpoint plus a
// channel column through the other endpoint's strip always opens a clean
// route (a one-row hop crosses nothing, and a blank column carries no
// bodies), and a second channel relieves a column whose wire stack is full.
export function insertWireChannels(
  chooser: Chooser,
  componentDefs: ComponentDef[],
  limits: DimLimits,
  icChannels: boolean,
  strict = false
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
          if (strict && isCol) return true;
          const dr = Math.abs(c.boardPos!.row - p2.row) + (isCol ? 0 : 1);
          const dc = Math.abs(c.boardPos!.col - p2.col) + (isCol ? 1 : 0);
          return Math.hypot(dr, dc) > spanLimits(def).max + 1e-6;
        }
        const r = getComponentBounds(def, c.boardPos, c.rotation);
        return isCol ? r.minCol < at && at <= r.maxCol : r.minRow < at && at <= r.maxRow;
      });
    const colOk = (cur: Candidate, at: number) =>
      (strict ? at >= 0 && at <= cur.cols : at >= 1 && at <= cur.cols - 1) &&
      !(limits.maxCols !== undefined && cur.cols + 1 > limits.maxCols) &&
      !lineStraddled(cur.virtual, true, at);
    const rowOk = (cur: Candidate, at: number) =>
      (strict ? at >= 0 && at <= cur.rows : at >= 1 && at <= cur.rows - 1) &&
      !(limits.maxRows !== undefined && cur.rows + 1 > limits.maxRows) &&
      !lineStraddled(cur.virtual, false, at);
    // An edge line keeps rim connectors on the rim (insertLine); only when
    // that board does not route is the plain shift offered instead
    const offer = (cur: Candidate, lines: { isCol: boolean; at: number }[]) => {
      const build = (pin: boolean) =>
        lines.reduce((comps, l) => insertLine(comps, componentDefs, l.isCol, l.at, pin), cur.virtual);
      const dRows = lines.filter((l) => !l.isCol).length;
      const dCols = lines.length - dRows;
      const c = chooser.route(build(true), cur.rows + dRows, cur.cols + dCols, cur.movedIds);
      if (c.bad > 0) chooser.route(build(false), cur.rows + dRows, cur.cols + dCols, cur.movedIds);
    };
    // strict: the nearest insertable line above/below a row (left/right of
    // a column), walking outward past straddling bodies
    const nearLines = (ok: (at: number) => boolean, at0: number, max: number): number[] => {
      const out: number[] = [];
      for (let at = at0; at >= 0; at--) if (ok(at)) { out.push(at); break; }
      for (let at = at0 + 1; at <= max; at++) if (ok(at)) { out.push(at); break; }
      return out;
    };
    const nearRows = (cur: Candidate, r: number) => nearLines((at) => rowOk(cur, at), r, cur.rows);
    const nearCols = (cur: Candidate, c: number) => nearLines((at) => colOk(cur, at), c, cur.cols);
    for (let round = 0; round < (strict ? 40 : icChannels ? 12 : 3); round++) {
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
        (w, i) => w.from.col !== w.to.col || wireExtraLength(w.from, w.to, obstacles) > 0 ||
          (chooser.forbidsStacking && wireStackDepth(w.from, w.to, cur.plan.wires.slice(0, i)) > 0)
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
        if (strict) {
          for (const p of [w.from, w.to]) {
            for (const r of nearRows(cur, p.row)) rowCands.add(r);
            for (const c of nearCols(cur, p.col)) colCands.add(c);
          }
          for (let c = loC + 1; c <= hiC; c++) colCands.add(c);
        }
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
      for (const at of colCands) {
        if (colOk(cur, at)) offer(cur, [{ isCol: true, at }]);
      }
      for (const at of rowCands) {
        if (rowOk(cur, at)) offer(cur, [{ isCol: false, at }]);
      }
      if (chooser.chosen !== cur) continue;
      if (!strict) break; // no insertion paid for itself
      // strict: no single line helped. Two lines at once can: a relay row
      // beside one endpoint plus a channel through the other's strip, or a
      // second channel where one column's stack capacity is exhausted. Try
      // every pair among the lines nearest the first offenders' endpoints.
      const lines: { isCol: boolean; at: number }[] = [];
      const seen = new Set<string>();
      for (const w of offenders.slice(0, 2)) {
        for (const p of [w.from, w.to]) {
          for (const at of nearRows(cur, p.row)) if (!seen.has(`r${at}`)) { seen.add(`r${at}`); lines.push({ isCol: false, at }); }
          for (const at of nearCols(cur, p.col)) if (!seen.has(`c${at}`)) { seen.add(`c${at}`); lines.push({ isCol: true, at }); }
        }
      }
      for (let i = 0; i < lines.length; i++) {
        for (let j = i; j < lines.length; j++) {
          const a = lines[i], b = lines[j];
          if (a.isCol === b.isCol && (limits[a.isCol ? "maxCols" : "maxRows"] ?? Infinity) < (a.isCol ? cur.cols : cur.rows) + 2) continue;
          // same-kind pairs: insert the higher position first so the lower
          // one's index stays valid
          const [first, second] = a.isCol === b.isCol && a.at < b.at ? [b, a] : [a, b];
          offer(cur, [first, second]);
        }
      }
      if (chooser.chosen === cur) break; // nothing opens a clean route
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
          comps = insertLine(comps, componentDefs, false, at);
          rows++;
        }
        if (rows > cur.rows) chooser.route(comps, rows, cur.cols, cur.movedIds);
      }
    }
}
