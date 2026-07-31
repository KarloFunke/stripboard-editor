import { holeKey, pinKey } from "../keys";
import { Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getRotatedPinPositions } from "../boardLayout";
import {
  spanLimits,
  clearanceOf,
  FootprintRect,
  bodiesTooClose,
  segmentsIntersect,
  bodyIntersectsRect,
  corridorHoles,
} from "../flexGeometry";

// ── Vacuum compaction ──────────────────────────────────
// Pins connect through their strip row, so removing a grid line that no
// part depends on never changes connectivity — only geometry and routing
// room. Greedily delete such rows and columns; the caller re-routes the
// result and keeps it only if it routes as cleanly as the loose layout.

interface Occupancy {
  rigids: { rect: FootprintRect; pins: { row: number; col: number; net?: string }[] }[];
  flexes: { idx: number; def: ComponentDef; span: { min: number; max: number } }[];
}

export function compactPlacements(
  comps: Component[],
  componentDefs: ComponentDef[],
  netOfPin: Map<string, string>,
  rows: number,
  cols: number,
  maxRemovals = Infinity, // replay a prefix of the (deterministic) removal sequence
  validate?: (comps: Component[], rows: number, cols: number) => boolean
): { comps: Component[]; rows: number; cols: number; removals: number } {
  type P = { row: number; col: number };
  const pos: (P | null)[] = comps.map((c) => (c.boardPos ? { ...c.boardPos } : null));
  const end: (P | null)[] = comps.map((c) => (c.flexibleEndPos ? { ...c.flexibleEndPos } : null));

  // Locked parts must not move: only grid lines beyond all of them are
  // removable (those removals leave locked coordinates untouched).
  let lockRow = -1;
  let lockCol = -1;
  for (const c of comps) {
    if (!c.locked || !c.boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (def && !def.flexible) {
      const b = getComponentBounds(def, c.boardPos, c.rotation);
      lockRow = Math.max(lockRow, b.maxRow);
      lockCol = Math.max(lockCol, b.maxCol);
    } else {
      for (const p of [c.boardPos, c.flexibleEndPos ?? c.boardPos]) {
        lockRow = Math.max(lockRow, p.row);
        lockCol = Math.max(lockCol, p.col);
      }
    }
  }

  const occ: Occupancy = { rigids: [], flexes: [] };
  for (let i = 0; i < comps.length; i++) {
    if (!pos[i]) continue;
    const def = resolveComponentDef(comps[i], componentDefs);
    if (!def) continue;
    if (def.flexible) {
      if (end[i]) occ.flexes.push({ idx: i, def, span: spanLimits(def) });
    } else {
      occ.rigids.push({
        rect: getComponentBounds(def, pos[i]!, comps[i].rotation),
        pins: getRotatedPinPositions(def, pos[i]!, comps[i].rotation).map((p) => ({
          row: p.row,
          col: p.col,
          net: netOfPin.get(pinKey(comps[i].id, p.pinId)),
        })),
      });
    }
  }

  const flexNet = (i: number, first: boolean) => {
    const def = resolveComponentDef(comps[i], componentDefs)!;
    const pinId = def.pins[first ? 0 : 1]?.id;
    return pinId !== undefined ? netOfPin.get(pinKey(comps[i].id, pinId)) : undefined;
  };

  const shiftPt = (p: P, line: number, isCol: boolean) => {
    if (isCol) return p.col > line ? { row: p.row, col: p.col - 1 } : p;
    return p.row > line ? { row: p.row - 1, col: p.col } : p;
  };

  // The layout may already contain pairs closer than the solver's own
  // comfort rules (abutting tiles from stage 2). A removal is only vetoed
  // if it CREATES a violation that the current layout doesn't have.
  interface Snap {
    flexPts: { p1: P; p2: P }[];
    rects: FootprintRect[];
    pins: { id: string; row: number; col: number; net?: string }[];
  }
  const snapshot = (line?: number, isCol?: boolean): Snap => {
    const sh = (p: P) => (line === undefined ? p : shiftPt(p, line, isCol!));
    return {
      flexPts: occ.flexes.map((f) => ({ p1: sh(pos[f.idx]!), p2: sh(end[f.idx]!) })),
      rects: occ.rigids.map((r) => {
        const lo = sh({ row: r.rect.minRow, col: r.rect.minCol });
        const hi = sh({ row: r.rect.maxRow, col: r.rect.maxCol });
        return { minRow: lo.row, minCol: lo.col, maxRow: hi.row, maxCol: hi.col };
      }),
      pins: [
        ...occ.rigids.flatMap((r, ri) => r.pins.map((p, pi) => ({ id: `p${ri}:${pi}`, ...sh(p), net: p.net }))),
        ...occ.flexes.flatMap((f, fi) => [
          { id: `f${fi}a`, ...sh(pos[f.idx]!), net: flexNet(f.idx, true) },
          { id: `f${fi}b`, ...sh(end[f.idx]!), net: flexNet(f.idx, false) },
        ]),
      ],
    };
  };
  // Nets still owed a connection to a part that isn't on the board keep
  // every run needy even when the placed pins form one copper run.
  const unplacedNets = new Set<string>();
  {
    const onBoard = new Set(comps.filter((_, i) => pos[i]).map((c) => c.id));
    const byId = new Map(comps.map((c) => [c.id, c]));
    for (const [pk, net] of netOfPin) {
      const cid = pk.slice(0, pk.indexOf(":"));
      if (onBoard.has(cid)) continue;
      const comp = byId.get(cid);
      if (comp && !comp.boardExcluded) unplacedNets.add(net);
    }
  }
  const violations = (s: Snap, nCols: number): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.flexPts.length; i++) {
      const a = s.flexPts[i];
      const aClr = clearanceOf(occ.flexes[i].def);
      for (let j = i + 1; j < s.flexPts.length; j++) {
        const b = s.flexPts[j];
        if (segmentsIntersect(a.p1, a.p2, b.p1, b.p2)) out.add(`ffx:${i}:${j}`);
        if (bodiesTooClose(a.p1, a.p2, b.p1, b.p2, aClr + clearanceOf(occ.flexes[j].def))) out.add(`ffc:${i}:${j}`);
      }
      s.rects.forEach((rect, ri) => {
        if (bodyIntersectsRect(a.p1, a.p2, rect, aClr)) out.add(`fr:${i}:${ri}`);
      });
    }
    const holeOwner = new Map<string, string>();
    for (const p of s.pins) holeOwner.set(holeKey(p.row, p.col), p.id);
    for (let i = 0; i < s.flexPts.length; i++) {
      const a = s.flexPts[i];
      for (const h of corridorHoles(a.p1, a.p2)) {
        const owner = holeOwner.get(holeKey(h.row, h.col));
        if (owner && owner !== `f${i}a` && owner !== `f${i}b`) out.add(`co:${i}:${owner}`);
      }
    }
    // different-net pins on one strip still need a hole between them for a cut
    const byRow = new Map<number, Snap["pins"]>();
    for (const p of s.pins) {
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row)!.push(p);
    }
    for (const [, pins] of byRow) {
      pins.sort((a, b) => a.col - b.col);
      for (let i = 1; i < pins.length; i++) {
        if (pins[i].net !== pins[i - 1].net && pins[i].col - pins[i - 1].col < 2) {
          out.add(`cg:${pins[i - 1].id}:${pins[i].id}`);
        }
      }
    }
    // ── Wire attachability ──
    // A net whose pins sit on more than one copper run needs link wires,
    // and every one of its runs must keep a free hole to take an endpoint
    // (pins, bodies and corridors all block endpoints). A removal that
    // seals a needy run's last flank saves a column but strands the net,
    // so it counts as a violation like any geometric one. A hole between
    // two needy runs can serve only one of them (greedy left-to-right is
    // exact on a row).
    const occ2 = new Set<string>();
    for (const p of s.pins) occ2.add(holeKey(p.row, p.col));
    for (const r of s.rects)
      for (let rr = r.minRow; rr <= r.maxRow; rr++)
        for (let cc = r.minCol; cc <= r.maxCol; cc++) occ2.add(holeKey(rr, cc));
    for (const f of s.flexPts)
      for (const h of corridorHoles(f.p1, f.p2)) occ2.add(holeKey(h.row, h.col));
    interface Run { net?: string; id: string; minCol: number; maxCol: number; free: number }
    const rowRuns = new Map<number, Run[]>();
    const runsPerNet = new Map<string, number>();
    for (const [row, pins] of byRow) {
      const runs: Run[] = [];
      for (const p of pins) {
        const last = runs[runs.length - 1];
        if (last && last.net !== undefined && last.net === p.net) {
          // holes between same-net pins always stay with the run
          for (let c = last.maxCol + 1; c < p.col; c++) if (!occ2.has(holeKey(row, c))) last.free++;
          last.maxCol = p.col;
        } else {
          runs.push({ net: p.net, id: p.id, minCol: p.col, maxCol: p.col, free: 0 });
        }
      }
      rowRuns.set(row, runs);
      for (const r of runs) if (r.net !== undefined) runsPerNet.set(r.net, (runsPerNet.get(r.net) ?? 0) + 1);
    }
    const needy = (net?: string) =>
      net !== undefined && ((runsPerNet.get(net) ?? 0) > 1 || unplacedNets.has(net));
    for (const [row, runs] of rowRuns) {
      const gapFree: number[] = [];
      for (let i = 0; i <= runs.length; i++) {
        const lo = i === 0 ? 0 : runs[i - 1].maxCol + 1;
        const hi = i === runs.length ? nCols - 1 : runs[i].minCol - 1;
        let n = 0;
        for (let c = lo; c <= hi; c++) if (!occ2.has(holeKey(row, c))) n++;
        gapFree.push(n);
      }
      runs.forEach((r, i) => {
        if (!needy(r.net) || r.free > 0) return;
        if (gapFree[i] > 0) gapFree[i]--;
        else if (gapFree[i + 1] > 0) gapFree[i + 1]--;
        else out.add(`flank:${r.id}`);
      });
    }
    return out;
  };
  let baseViol = violations(snapshot(), cols);

  const tryRemove = (line: number, isCol: boolean): boolean => {
    if (isCol ? line <= lockCol : line <= lockRow) return false;
    for (const r of occ.rigids) {
      if (isCol ? r.rect.minCol <= line && line <= r.rect.maxCol
                : r.rect.minRow <= line && line <= r.rect.maxRow) return false;
    }
    for (const f of occ.flexes) {
      const a = pos[f.idx]!;
      const b = end[f.idx]!;
      if (isCol ? a.col === line || b.col === line : a.row === line || b.row === line) return false;
      const na = shiftPt(a, line, isCol);
      const nb = shiftPt(b, line, isCol);
      const len = Math.hypot(na.row - nb.row, na.col - nb.col);
      if (len < f.span.min - 1e-6 || len > f.span.max + 1e-6) return false;
    }
    const post = violations(snapshot(line, isCol), isCol ? cols - 1 : cols);
    for (const v of post) if (!baseViol.has(v)) return false;
    if (validate) {
      const cand = comps.map((c, i) => {
        if (!pos[i]) return c;
        return {
          ...c,
          boardPos: shiftPt(pos[i]!, line, isCol),
          ...(end[i] ? { flexibleEndPos: shiftPt(end[i]!, line, isCol) } : {}),
        };
      });
      if (!validate(cand, isCol ? rows : rows - 1, isCol ? cols - 1 : cols)) return false;
    }
    // accept: apply the shift
    for (let i = 0; i < comps.length; i++) {
      if (pos[i]) pos[i] = shiftPt(pos[i]!, line, isCol);
      if (end[i]) end[i] = shiftPt(end[i]!, line, isCol);
    }
    occ.rigids.forEach((r) => {
      const lo = shiftPt({ row: r.rect.minRow, col: r.rect.minCol }, line, isCol);
      const hi = shiftPt({ row: r.rect.maxRow, col: r.rect.maxCol }, line, isCol);
      r.rect = { minRow: lo.row, minCol: lo.col, maxRow: hi.row, maxCol: hi.col };
      r.pins = r.pins.map((p) => ({ ...shiftPt(p, line, isCol), net: p.net }));
    });
    baseViol = post;
    return true;
  };

  let removals = 0;
  let changed = true;
  while (changed && removals < maxRemovals) {
    changed = false;
    for (let c = cols - 1; c >= 0 && removals < maxRemovals; c--) {
      if (tryRemove(c, true)) {
        cols--;
        removals++;
        changed = true;
      }
    }
    for (let r = rows - 1; r >= 0 && removals < maxRemovals; r--) {
      if (tryRemove(r, false)) {
        rows--;
        removals++;
        changed = true;
      }
    }
  }

  return {
    comps: comps.map((c, i) => {
      if (!pos[i]) return c;
      return {
        ...c,
        boardPos: pos[i]!,
        ...(end[i] ? { flexibleEndPos: end[i]! } : {}),
      };
    }),
    rows,
    cols,
    removals,
  };
}
