import { holeKey } from "./keys";
import { Board, Cut } from "@/types";
import { StripSegment, segmentHoles, isRowRun } from "./stripSegments";
import { BoardPin } from "./boardPins";
import { boardTopology, hasHLink } from "./boardTopology";

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
  gLo: number,
  gHi: number
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
export function deriveCuts(
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
  // Wherever the board itself carries no copper across a gap — a factory
  // break, the flank of a rail, a missing hole — it is already severed and
  // the user never has to cut it.
  // On a plain veroboard every gap carries copper, so the sweep can only
  // add nothing — worth skipping, it runs once per completion candidate.
  const topo = boardTopology(board);
  if (!topo.plain) {
    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols - 1; col++) {
        if (!hasHLink(topo, row, col)) severedGaps.add(`${row}:${col}`);
      }
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
export function upgradeCutsToDrills(
  cuts: Cut[],
  segments: StripSegment[],
  occupied: Set<string>,
  noDrill: Set<string>,
  reserveNets: Set<string>
): Cut[] {
  // A cut always severs a run along a row, so only those are candidates for
  // the drill it upgrades to — copper running down a column would be cut
  // somewhere nobody asked for.
  const segsByRow = new Map<number, StripSegment[]>();
  for (const s of segments) {
    if (!isRowRun(s)) continue;
    if (!segsByRow.has(s.row)) segsByRow.set(s.row, []);
    segsByRow.get(s.row)!.push(s);
  }
  const freeCount = new Map<StripSegment, number>();
  const freeOf = (s: StripSegment): number => {
    let n = freeCount.get(s);
    if (n === undefined) {
      n = 0;
      for (const h of segmentHoles(s)) if (!occupied.has(holeKey(h.row, h.col))) n++;
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
