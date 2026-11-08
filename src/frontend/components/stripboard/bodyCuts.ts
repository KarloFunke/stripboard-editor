import { Board, Component, ComponentDef, Cut } from "@/types";
import { getRotatedPinPositions } from "./boardLayout";
import { joinsDown, joinsRight } from "./boardPattern";

/**
 * The stretch of copper between two neighbouring pins of a rigid part: along
 * row `line`, or, on a board whose copper runs down the columns, down column
 * `line`. `from` and `to` are the pins' columns (or rows).
 */
interface PinSpan {
  down: boolean;
  line: number;
  from: number;
  to: number;
  pins: [string, string];
}

function pinSpans(comp: Component, def: ComponentDef, board?: Board): PinSpan[] {
  if (def.flexible || !comp.boardPos) return [];
  const pins = getRotatedPinPositions(def, comp.boardPos, comp.rotation);
  const spans: PinSpan[] = [];
  const along = (down: boolean) => {
    const lines = new Map<number, { pinId: string; at: number }[]>();
    for (const p of pins) {
      const line = down ? p.col : p.row;
      lines.set(line, [...(lines.get(line) ?? []), { pinId: p.pinId, at: down ? p.row : p.col }]);
    }
    for (const [line, onLine] of lines) {
      onLine.sort((a, b) => a.at - b.at);
      for (let i = 1; i < onLine.length; i++) {
        const span = { down, line, from: onLine[i - 1].at, to: onLine[i].at, pins: [onLine[i - 1].pinId, onLine[i].pinId] as [string, string] };
        if (!board?.pattern || copperBetween(board, span)) spans.push(span);
      }
    }
  };
  along(false);
  if (board?.pattern) along(true);
  return spans;
}

// On a board with a pattern, two pins only share copper the board runs
// unbroken from one to the other
function copperBetween(board: Board, s: PinSpan): boolean {
  for (let at = s.from; at < s.to; at++) {
    if (!(s.down ? joinsDown(board, at, s.line) : joinsRight(board, s.line, at))) return false;
  }
  return true;
}

function inSpan(cut: Cut, s: PinSpan): boolean {
  if (s.down) {
    return cut.col === s.line && cut.row < s.to &&
      (cut.kind === "hole" ? cut.row > s.from : cut.kind === "below" && cut.row >= s.from);
  }
  return cut.kind !== "below" && cut.row === s.line && cut.col < s.to &&
    (cut.kind === "hole" ? cut.col > s.from : cut.col >= s.from);
}

const kindOf = (cut: Cut) => cut.kind ?? "between";

export const sameCut = (a: Cut, b: Cut) =>
  a.row === b.row && a.col === b.col && kindOf(a) === kindOf(b);

/**
 * The cuts that belong to a part: those on a strip between two of its own
 * pins. Nothing else can use that stretch of copper, so they come and go and
 * move with the part. Told by position alone, so a cut the layouter made and
 * one drawn by hand count the same.
 */
export function bodyCuts(cuts: Cut[], comp: Component, def: ComponentDef, board?: Board): Cut[] {
  const spans = pinSpans(comp, def, board);
  return spans.length === 0 ? [] : cuts.filter((c) => spans.some((s) => inSpan(c, s)));
}

/**
 * The cuts a part needs under its body where it now sits: one per stretch of
 * strip that would otherwise short two of its pins. Not between pins the part
 * joins itself (same pin id), not between pins of one net, and not where a
 * cut already is.
 */
export function missingBodyCuts(
  cuts: Cut[],
  comp: Component,
  def: ComponentDef,
  netOf: (pinId: string) => string | undefined,
  drilled: boolean,
  holeTaken: (row: number, col: number) => boolean,
  board?: Board
): Cut[] {
  const added: Cut[] = [];
  for (const s of pinSpans(comp, def, board)) {
    if (s.pins[0] === s.pins[1]) continue;
    const net = netOf(s.pins[0]);
    if (net && net === netOf(s.pins[1])) continue;
    if (cuts.some((c) => inSpan(c, s))) continue;

    const mid = (s.from + s.to) / 2;
    const at = (along: number) => (s.down ? { row: along, col: s.line } : { row: s.line, col: along });
    const holes: number[] = [];
    for (let along = s.from + 1; along < s.to; along++) {
      const p = at(along);
      if (!holeTaken(p.row, p.col)) holes.push(along);
    }
    holes.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    added.push(
      drilled && holes.length > 0
        ? { ...at(holes[0]), kind: "hole" }
        : { ...at(Math.floor((s.from + s.to - 1) / 2)), kind: s.down ? "below" : "between" }
    );
  }
  return added;
}
