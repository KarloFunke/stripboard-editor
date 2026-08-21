import { holeKey, pinKey } from "../keys";
import { Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions, getComponentBounds } from "../boardLayout";
import { bodiesTooClose, clearanceOf, segmentsIntersect } from "../flexGeometry";
import {
  ClusterAnalysis, DimLimits, Flex, Rot, Tile, TilePlan,
  allowedDrows,
} from "./tileModel";

export function packTile(analysis: ClusterAnalysis, plan: TilePlan, limits: DimLimits): Tile | null {
  const { taps, flexes, flexTaps, groupOf, rigids, skipped } = analysis;
  const k = rigids.length;
  const y = plan.assignment;
  const info = (key: string) => plan.keyInfo.get(key);

  // ── Column packing (diagonals take their extra columns outward) ──
  // Margin per pair = the larger of the two parts' clearances (free columns
  // next to the body, a shared moat): the default 1 gives the classic one
  // free column between parallel bodies; a pair of 0-clearance parts may
  // sit in adjacent columns.
  interface Usage { colLo: number; colHi: number; top: number; bot: number; clr: number }
  const colUsage: Usage[] = [];
  const overlaps = (cLo: number, cHi: number, top: number, bot: number, clr = 0) =>
    colUsage.some((u) => {
      const m = Math.max(clr, u.clr);
      return cLo <= u.colHi + m && cHi >= u.colLo - m && !(top > u.bot || bot < u.top);
    });
  // The box test margins columns only — correct for vertical drops, blind
  // to bodies lying ALONG a row, whose moat faces the neighbouring rows
  // (two flat resistors in adjacent rows slipped straight through it). The
  // exact pairwise geometry is orientation-aware and also keeps end-to-end
  // stacking legal, so every flex placement passes through it too.
  const flexGeoms: { p1: { row: number; col: number }; p2: { row: number; col: number }; clr: number }[] = [];
  const flexBodyOk = (r1: number, c1: number, r2: number, c2: number, clr: number) => {
    const p1 = { row: r1, col: c1 };
    const p2 = { row: r2, col: c2 };
    return !flexGeoms.some(
      (g) =>
        segmentsIntersect(p1, p2, g.p1, g.p2) ||
        bodiesTooClose(p1, p2, g.p1, g.p2, Math.max(clr, g.clr))
    );
  };

  // Claims keep left-to-right segment order on shared rows: a hole may not
  // land left of a lower-ranked segment's holes (no cut could separate them).
  // Free keys sharing a row get their ranks when the part lying between
  // them is placed (dynInfo).
  const dynInfo = new Map<string, { rankLo: number; rankHi: number }>();
  let dynBase = 9000;
  const rankInfo = (key: string) => info(key) ?? dynInfo.get(key);
  const claims = new Map<number, { col: number; lo: number; hi: number }[]>();
  const claimOk = (row: number, col: number, key: string) => {
    const inf = rankInfo(key);
    if (!inf) return true; // unranked free key: it has its row to itself
    const list = claims.get(row);
    if (!list) return true;
    return !list.some((e) => (e.hi < inf.rankLo && e.col > col) || (e.lo > inf.rankHi && e.col < col));
  };
  const addClaim = (row: number, col: number, key: string) => {
    const inf = rankInfo(key);
    if (!inf) return;
    if (!claims.has(row)) claims.set(row, []);
    claims.get(row)!.push({ col, lo: inf.rankLo, hi: inf.rankHi });
  };

  // Parts anchoring on a rigid's side need columns beside it; rigids keep
  // that room from each other (flexes still pack into it, and compaction
  // reclaims whatever stays empty).
  const needLeft = new Array<number>(k).fill(0);
  const needRight = new Array<number>(k).fill(0);
  const countKey = (key: string | undefined) => {
    if (key === undefined) return;
    for (const e of info(key)?.entries ?? []) {
      if (e.side === "L") needLeft[e.gi] += 1;
      else if (e.side === "R") needRight[e.gi] += 1;
      else {
        needLeft[e.gi] += 0.5;
        needRight[e.gi] += 0.5;
      }
    }
  };
  for (const { a, b } of plan.flexEff.values()) {
    countKey(a);
    countKey(b);
  }
  for (const key of plan.tapKey.values()) countKey(key);

  const rigidCol: number[] = [];
  const reservations: Usage[] = [];
  // Locked members imply where the board's edges lie in tile columns:
  // nothing may pack left of column 0 or beyond a locked column cap.
  let colMin = -Infinity;
  let colMax = Infinity;
  let packRowMin = -Infinity;
  let packRowMax = Infinity;
  const noteFixedBounds = (i: number) => {
    const f = rigids[i].fixed;
    if (!f || rigidCol[i] === undefined) return;
    const aCol = f.col - rigidCol[i]; // absolute col = local col + aCol
    // Free members keep one column off the board's left edge: with locked
    // parts nothing can shift later, and a pin flush at column 0 leaves its
    // segment no free hole for a link wire. Locked members themselves are
    // frozen wherever the user put them (forced placements skip this bound).
    colMin = Math.max(colMin, -aCol + 1);
    if (limits.maxCols !== undefined) colMax = Math.min(colMax, limits.maxCols - 1 - aCol);
    const aRow = f.row - plan.offsets[i];
    packRowMin = Math.max(packRowMin, -aRow);
    if (limits.maxRows !== undefined) packRowMax = Math.min(packRowMax, limits.maxRows - 1 - aRow);
  };
  // First-fit placement: a rigid whose rows don't collide stacks above or
  // below an earlier one instead of stretching the row of rigids; claimOk
  // keeps its pins on the right side of every shared strip.
  const placeRigid = (i: number): boolean => {
    const rr = plan.rotSel[i];
    const o = plan.offsets[i];
    const top = o + rr.box.minRow - 1;
    const bot = o + rr.box.maxRow + 1;
    // two locked rigids keep their frozen relative column distance
    let forced: number | undefined;
    if (rigids[i].fixed) {
      for (let j = 0; j < i; j++) {
        if (rigids[j].fixed && rigidCol[j] !== undefined) {
          forced = rigidCol[j] + (rigids[i].fixed!.col - rigids[j].fixed!.col);
          break;
        }
      }
    }
    // Reservations are soft: when space is tight (frozen spans, locked
    // caps) a second pass places against real content only.
    const claimKeys = rr.pinClaims.map((cl) => plan.keyOfEntry.get(`${i}:${cl.net}`));
    const findAt = (useRes: boolean): { c: number; resL: number; resR: number } | null => {
      const resL = useRes ? Math.min(12, Math.ceil(needLeft[i]) * 2) : 0;
      const resR = useRes ? Math.min(12, Math.ceil(needRight[i]) * 2) : 0;
      // With a locked member the board frame is known and everything left
      // of it down to the board edge (colMin) is paid for — scan from there
      // so free members fill that space instead of stacking rightward. An
      // unanchored tile keeps its 0-based scan (normalization equalizes).
      const scanFrom = forced ?? (Number.isFinite(colMin) ? Math.ceil(colMin - rr.box.minCol) : 0);
      for (let c = scanFrom; c <= (forced ?? 200); c++) {
        // the free-member edge margin in colMin never applies to a frozen
        // position — the user chose it, even flush against the board edge
        if ((forced === undefined && c + rr.box.minCol < colMin) || c + rr.box.maxCol > colMax) {
          if (forced !== undefined) break;
          continue;
        }
        const lo = c + rr.box.minCol - 1;
        const hi = c + rr.box.maxCol + 1;
        const rLo = lo - resL;
        const rHi = hi + resR;
        // The box is already expanded by 1, which covers a neighbour's
        // default clearance of one free line; only larger clearances add
        // their excess, so defaults leave the packing untouched.
        const blocked = (u: Usage) => {
          const m = Math.max(0, u.clr - 1);
          return rLo <= u.colHi + m && rHi >= u.colLo - m && !(top - m > u.bot || bot + m < u.top);
        };
        if (colUsage.some(blocked) || (useRes && reservations.some(blocked))) continue;
        let ok = true;
        for (let ci = 0; ci < rr.pinClaims.length; ci++) {
          const cl = rr.pinClaims[ci];
          const key = claimKeys[ci];
          if (key && !claimOk(o + cl.row, c + cl.col, key)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        return { c, resL, resR };
      }
      return null;
    };
    // Unanchored tiles keep first-fit with reservations winning. In an
    // anchored tile the reserved pass tends to escape far right past the
    // fixed member while the board edge's paid-for space goes unused — so
    // both passes compete and the leftmost feasible column wins.
    let best: { c: number; resL: number; resR: number } | null = null;
    for (const useRes of forced === undefined ? [true, false] : [false]) {
      const f = findAt(useRes);
      if (f && (!best || f.c < best.c)) best = f;
      if (best && !Number.isFinite(colMin)) break;
    }
    if (!best) return false;
    const { c, resL, resR } = best;
    const lo = c + rr.box.minCol - 1;
    const hi = c + rr.box.maxCol + 1;
    rigidCol[i] = c;
    colUsage.push({ colLo: lo, colHi: hi, top, bot, clr: 0 });
    reservations.push({ colLo: lo - resL, colHi: hi + resR, top, bot, clr: 0 });
    for (let ci = 0; ci < rr.pinClaims.length; ci++) {
      const cl = rr.pinClaims[ci];
      const key = claimKeys[ci];
      if (key) addClaim(o + cl.row, c + cl.col, key);
    }
    return true;
  };
  const maxUsedCol = () => {
    let m = -Infinity;
    for (const u of colUsage) if (u.colHi > m) m = u.colHi;
    return m;
  };
  const minUsedCol0 = () => {
    let m = 0;
    for (const u of colUsage) if (u.colLo < m) m = u.colLo;
    return m;
  };
  const maxUsedCol0 = () => {
    let m = 0;
    for (const u of colUsage) if (u.colHi > m) m = u.colHi;
    return m;
  };

  const placements: { comp: Component; row1: number; col1: number; row2?: number; col2?: number }[] = [];
  const unplaced: Component[] = [...skipped];

  interface FlexPack { f: Flex; a: string; b: string; rA: number; rB: number }
  const flexData: FlexPack[] = [];
  for (const f of flexes) {
    const e = plan.flexEff.get(f.comp.id)!;
    const rA = y.get(e.a);
    const rB = y.get(e.b);
    if (rA === undefined || rB === undefined) {
      unplaced.push(f.comp);
      continue;
    }
    flexData.push({ f, a: e.a, b: e.b, rA, rB });
  }
  // Column anchors come from the rigids that actually pin a part's keys —
  // left of an "L" pin's rigid, right of an "R"/"F" pin's rigid — so they
  // stay correct when rigids stack in 2D instead of forming one row.
  const anchorsOfKey = (key: string): { start: number; dir: 1 | -1 }[] => {
    const out: { start: number; dir: 1 | -1 }[] = [];
    for (const e of info(key)?.entries ?? []) {
      const rc = rigidCol[e.gi];
      const rr = plan.rotSel[e.gi];
      if (e.side !== "L") out.push({ start: rc + rr.box.maxCol + 1, dir: 1 });
      if (e.side !== "R") out.push({ start: rc + rr.box.minCol - 1, dir: -1 });
    }
    return out;
  };
  const anchorsFor = (fd: FlexPack): { start: number; dir: 1 | -1 }[] => {
    const out = [...anchorsOfKey(fd.a), ...anchorsOfKey(fd.b)];
    if (out.length === 0) {
      const gi = groupOf.get(fd.f.comp.id) ?? 0;
      if (k > 0 && rigidCol[gi] !== undefined) {
        const rr = plan.rotSel[gi];
        out.push({ start: rigidCol[gi] + rr.box.maxCol + 1, dir: 1 });
        out.push({ start: rigidCol[gi] + rr.box.minCol - 1, dir: -1 });
      } else {
        out.push({ start: 0, dir: 1 });
      }
    }
    return out;
  };
  const rankOf = (fd: FlexPack) =>
    Math.min(info(fd.a)?.rankLo ?? Infinity, info(fd.b)?.rankLo ?? Infinity);
  const sortFlexes = (list: FlexPack[]) =>
    list.sort((x, z) =>
      // parts lying along a row first: they fix their row's segment order
      ((x.rA === x.rB ? 0 : 1) - (z.rA === z.rB ? 0 : 1)) ||
      (rankOf(x) - rankOf(z)) ||
      (Math.min(x.rA, x.rB) - Math.min(z.rA, z.rB)) ||
      (x.f.comp.label < z.f.comp.label ? -1 : 1));

  const packFlex = (fd: FlexPack, startCol: number, dir: 1 | -1, maxSteps = 24): boolean => {
    const { f, a, b, rA, rB } = fd;
    const top = Math.min(rA, rB);
    const bot = Math.max(rA, rB);
    const clr = clearanceOf(f.def);
    const dcNeeded = allowedDrows(f.def).get(Math.abs(rA - rB)) ?? 0;
    for (let j = 0; j <= maxSteps; j++) {
      const c1 = startCol + dir * j;
      const c2 = c1 + dir * dcNeeded;
      const cLo = Math.min(c1, c2);
      const cHi = Math.max(c1, c2);
      if (cLo < colMin || cHi > colMax) continue;
      if (overlaps(cLo, cHi, top, bot, clr)) continue;
      if (!flexBodyOk(rA, c1, rB, c2, clr)) continue;
      if (!claimOk(rA, c1, a) || !claimOk(rB, c2, b)) continue;
      if (rA === rB && a !== b && !rankInfo(a) && !rankInfo(b)) {
        // this part fixes the segment order of its shared row
        const [lk, rk] = c1 <= c2 ? [a, b] : [b, a];
        dynInfo.set(lk, { rankLo: dynBase, rankHi: dynBase });
        dynInfo.set(rk, { rankLo: dynBase + 2, rankHi: dynBase + 2 });
        dynBase += 4;
      }
      colUsage.push({ colLo: cLo, colHi: cHi, top, bot, clr });
      flexGeoms.push({ p1: { row: rA, col: c1 }, p2: { row: rB, col: c2 }, clr });
      addClaim(rA, c1, a);
      addClaim(rB, c2, b);
      placements.push({ comp: f.comp, row1: rA, col1: c1, row2: rB, col2: c2 });
      return true;
    }
    return false;
  };

  // Rigids first — locked ones ahead of free ones so the board-edge bounds
  // they imply constrain everything placed after them — then flexes near
  // their anchors. Flexes whose span constraint gave way in the search skip
  // straight to the fresh-row fallback.
  const placeOrder = Array.from({ length: k }, (_, i) => i)
    .sort((a, b) => (rigids[a].fixed ? 0 : 1) - (rigids[b].fixed ? 0 : 1) || a - b);
  for (const i of placeOrder) {
    if (!placeRigid(i)) return null;
    noteFixedBounds(i);
  }
  const failed: FlexPack[] = [];
  const toPack: FlexPack[] = [];
  for (const fd of flexData) {
    if (plan.violated.has(fd.f.comp.id)) failed.push(fd);
    else toPack.push(fd);
  }
  for (const fd of sortFlexes(toPack)) {
    let done = false;
    for (const { start, dir } of anchorsFor(fd)) {
      if ((done = packFlex(fd, start, dir))) break;
    }
    if (!done) failed.push(fd);
  }
  // Second chance in any other allowed region now that all rigids stand;
  // last resort: drop one end onto a fresh row of its own (the router joins
  // it to the net's segment with one wire).
  const usedRows = new Set<number>([...y.values()]);
  plan.rotSel.forEach((rr, i) => {
    for (const c of rr.pinClaims) usedRows.add(c.row + plan.offsets[i]);
  });
  const extraNetRows: { net: string; row: number }[] = [];
  const tryAltDrop = (fd: FlexPack): boolean => {
    const D = [...allowedDrows(fd.f.def).keys()].sort((p, q) => p - q);
    for (const moveB of [true, false]) {
      const keepKey = moveB ? fd.a : fd.b;
      const keepRow = moveB ? fd.rA : fd.rB;
      const movedNet = moveB ? fd.f.netB : fd.f.netA;
      for (const dr of D) {
        for (const sign of [1, -1]) {
          const r2 = keepRow + sign * dr;
          if (r2 < packRowMin || r2 > packRowMax) continue;
          if (usedRows.has(r2)) continue;
          const fd2: FlexPack = moveB
            ? { ...fd, rA: keepRow, rB: r2, b: "#drop" }
            : { ...fd, rA: r2, rB: keepRow, a: "#drop" };
          const anchors = [
            ...anchorsOfKey(keepKey),
            Number.isFinite(colMax)
              ? { start: colMax as number, dir: -1 as const }
              : { start: maxUsedCol() + 1, dir: 1 as const },
            Number.isFinite(colMin)
              ? { start: colMin as number, dir: 1 as const }
              : { start: minUsedCol0() - 1, dir: -1 as const },
          ];
          for (const { start, dir } of anchors) {
            if (packFlex(fd2, start, dir)) {
              usedRows.add(r2);
              extraNetRows.push({ net: movedNet, row: r2 });
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  for (const fd of failed) {
    let done = false;
    if (!plan.violated.has(fd.f.comp.id)) {
      // wide scan across the whole current extent
      const lo = minUsedCol0();
      const hi = maxUsedCol0();
      done = packFlex(fd, lo - 1, 1, hi - lo + 26);
    }
    if (!done && !tryAltDrop(fd)) unplaced.push(fd.f.comp);
  }

  // Taps on their key's row, in shared outer columns of a reachable region
  for (const t of taps) {
    const key = plan.tapKey.get(t.comp.id);
    if (key === undefined || !y.has(key)) {
      unplaced.push(t.comp);
      continue;
    }
    const row = y.get(key)!;
    let placed = false;
    const tryCols = (atRow: number, start: number, dir: 1 | -1) => {
      let c = start;
      for (let j = 0; j <= 40; j++, c += dir) {
        if (c < colMin || c > colMax) continue;
        // A tap is a rigid hole: neighbours' clearances (their moats) apply
        if (colUsage.some((u) =>
          c >= u.colLo - u.clr && c <= u.colHi + u.clr && atRow >= u.top - u.clr && atRow <= u.bot + u.clr
        )) continue;
        if (!claimOk(atRow, c, key)) continue;
        colUsage.push({ colLo: c, colHi: c, top: atRow, bot: atRow, clr: 0 });
        addClaim(atRow, c, key);
        placements.push({ comp: t.comp, row1: atRow, col1: c });
        return true;
      }
      return false;
    };
    const tapAnchors = [
      ...anchorsOfKey(key),
      Number.isFinite(colMax)
        ? { start: colMax as number, dir: -1 as const }
        : { start: k === 0 ? 0 : maxUsedCol() + 1, dir: 1 as const },
      Number.isFinite(colMin)
        ? { start: colMin as number, dir: 1 as const }
        : { start: minUsedCol0() - 1, dir: -1 as const },
    ];
    for (const { start, dir } of tapAnchors) {
      if ((placed = tryCols(row, start, dir))) break;
    }
    if (!placed) {
      // last resort: a fresh row of its own, joined by one wire later
      for (let d = 1; d <= 20 && !placed; d++) {
        for (const sign of [1, -1] as const) {
          const r2 = row + sign * d;
          if (usedRows.has(r2)) continue;
          if (tryCols(r2, maxUsedCol() + 1, 1)) {
            usedRows.add(r2);
            extraNetRows.push({ net: plan.altReal.get(key) ?? key, row: r2 });
            placed = true;
            break;
          }
        }
      }
    }
    if (!placed) unplaced.push(t.comp);
  }

  // Single-pin flexes: the connected pin sits on its net's row, the free
  // end parks one legal span away (the router cuts floating pins off any
  // strip they'd touch, so a shared parking row is safe)
  for (const ft of flexTaps) {
    const key = plan.tapKey.get(ft.comp.id);
    if (key === undefined || !y.has(key)) {
      unplaced.push(ft.comp);
      continue;
    }
    const row = y.get(key)!;
    const drs = [...allowedDrows(ft.def).keys()].filter((d) => d > 0).sort((p, q) => p - q);
    let done = false;
    const tryAt = (start: number, dir: 1 | -1) => {
      for (let j = 0; j <= 40; j++) {
        const c = start + dir * j;
        if (c < colMin || c > colMax) continue;
        for (const dr of drs) {
          for (const sign of [1, -1] as const) {
            const r2 = row + sign * dr;
            if (r2 < packRowMin || r2 > packRowMax) continue;
            if (usedRows.has(r2)) continue;
            const top = Math.min(row, r2);
            const bot = Math.max(row, r2);
            if (overlaps(c, c, top, bot, clearanceOf(ft.def))) continue;
            if (!flexBodyOk(row, c, r2, c, clearanceOf(ft.def))) continue;
            if (!claimOk(row, c, key)) continue;
            colUsage.push({ colLo: c, colHi: c, top, bot, clr: clearanceOf(ft.def) });
            flexGeoms.push({ p1: { row, col: c }, p2: { row: r2, col: c }, clr: clearanceOf(ft.def) });
            addClaim(row, c, key);
            placements.push(ft.firstAssigned
              ? { comp: ft.comp, row1: row, col1: c, row2: r2, col2: c }
              : { comp: ft.comp, row1: r2, col1: c, row2: row, col2: c });
            return true;
          }
        }
      }
      return false;
    };
    const ftAnchors = [
      ...anchorsOfKey(key),
      Number.isFinite(colMax)
        ? { start: colMax as number, dir: -1 as const }
        : { start: k === 0 ? 0 : maxUsedCol() + 1, dir: 1 as const },
      Number.isFinite(colMin)
        ? { start: colMin as number, dir: 1 as const }
        : { start: minUsedCol0() - 1, dir: -1 as const },
    ];
    for (const { start, dir } of ftAnchors) {
      if ((done = tryAt(start, dir))) break;
    }
    if (!done) unplaced.push(ft.comp);
  }

  // ── Normalize to content coordinates ─────────────────
  const allRows = [...y.values()];
  const allCols: number[] = [];
  plan.rotSel.forEach((rr, i) => {
    allRows.push(plan.offsets[i] + rr.box.minRow, plan.offsets[i] + rr.box.maxRow);
    allCols.push(rigidCol[i] + rr.box.minCol, rigidCol[i] + rr.box.maxCol);
  });
  for (const p of placements) {
    allRows.push(p.row1);
    allCols.push(p.col1);
    if (p.row2 !== undefined) allRows.push(p.row2);
    if (p.col2 !== undefined) allCols.push(p.col2);
  }
  if (allRows.length === 0) return null;
  const rOff = -Math.min(...allRows);
  const cOff = -Math.min(...allCols);

  const rowsOfNet = new Map<string, Set<number>>();
  for (const [key, row] of y) {
    const real = plan.altReal.get(key) ?? key;
    if (!rowsOfNet.has(real)) rowsOfNet.set(real, new Set());
    rowsOfNet.get(real)!.add(row + rOff);
  }
  for (const { net, row } of extraNetRows) {
    if (!rowsOfNet.has(net)) rowsOfNet.set(net, new Set());
    rowsOfNet.get(net)!.add(row + rOff);
  }

  // Locked members pin the tile to the board: every one of them must agree
  // on the same anchor, and the tile may not hang off the board's edge.
  let anchor: { row: number; col: number } | undefined;
  for (let i = 0; i < k; i++) {
    const f = rigids[i].fixed;
    if (!f) continue;
    const a = { row: f.row - (plan.offsets[i] + rOff), col: f.col - (rigidCol[i] + cOff) };
    if (!anchor) anchor = a;
    else if (a.row !== anchor.row || a.col !== anchor.col) return null;
  }
  if (anchor && (anchor.row < 0 || anchor.col < 0)) return null;

  return {
    ...(anchor ? { anchor } : {}),
    height: Math.max(...allRows) + rOff + 1,
    width: Math.max(...allCols) + cOff + 1,
    parts: placements.map((p) => ({
      comp: p.comp,
      row1: p.row1 + rOff,
      col1: p.col1 + cOff,
      ...(p.row2 !== undefined ? { row2: p.row2 + rOff, col2: p.col2! + cOff } : {}),
    })),
    rigidParts: rigids.map((r, i) => ({
      comp: r.comp,
      row: plan.offsets[i] + rOff,
      col: rigidCol[i] + cOff,
      rotation: plan.rotSel[i].rot,
    })),
    rowsOfNet,
    unplaced,
    dropWires: extraNetRows.length,
  };
}

/**
 * The same tile rotated 180°: functionally identical inside, but the other
 * orientation may put its nets on rows that line up with the neighbors'.
 */
export function flipTile(tile: Tile, componentDefs: ComponentDef[]): Tile | undefined {
  if (tile.anchor) return undefined; // anchored tiles must not move
  const h = tile.height;
  const w = tile.width;
  const rigidParts: Tile["rigidParts"] = [];
  for (const rp of tile.rigidParts) {
    const def = resolveComponentDef(rp.comp, componentDefs);
    if (!def) return undefined;
    const cur = getRotatedPinPositions(def, { row: rp.row, col: rp.col }, rp.rotation);
    const rot2 = ((rp.rotation + 180) % 360) as Rot;
    const base = getRotatedPinPositions(def, { row: 0, col: 0 }, rot2);
    const anchor = {
      row: h - 1 - cur[0].row - base[0].row,
      col: w - 1 - cur[0].col - base[0].col,
    };
    for (let i = 0; i < cur.length; i++) {
      if (anchor.row + base[i].row !== h - 1 - cur[i].row ||
        anchor.col + base[i].col !== w - 1 - cur[i].col) return undefined;
    }
    rigidParts.push({ comp: rp.comp, row: anchor.row, col: anchor.col, rotation: rot2 });
  }
  const rowsOfNet = new Map<string, Set<number>>();
  for (const [net, rows] of tile.rowsOfNet) {
    rowsOfNet.set(net, new Set([...rows].map((r) => h - 1 - r)));
  }
  return {
    height: h,
    width: w,
    parts: tile.parts.map((p) => ({
      comp: p.comp,
      row1: h - 1 - p.row1,
      col1: w - 1 - p.col1,
      ...(p.row2 !== undefined ? { row2: h - 1 - p.row2, col2: w - 1 - p.col2! } : {}),
    })),
    rigidParts,
    rowsOfNet,
    unplaced: tile.unplaced,
    dropWires: tile.dropWires,
  };
}
